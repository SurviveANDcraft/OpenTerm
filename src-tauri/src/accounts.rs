//! Several subscriptions per agent CLI, one click to move between them.
//!
//! Each CLI keeps exactly one login in its own folder (`~/.claude`, `~/.codex`,
//! `~/.gemini`). OpenTerm keeps a sealed copy of every login it has seen and
//! switches by writing the chosen one back into place. Only the login moves:
//! conversations, settings, hooks and MCP servers live beside it in the same
//! folder and are shared by every account, so nothing is lost on a switch.
//!
//! The alternative (a separate config folder per account, picked with
//! CLAUDE_CONFIG_DIR / CODEX_HOME) splits history and settings per account,
//! which is exactly what a quick "I ran out, use the other one" must not do.
//!
//! Copies are DPAPI-encrypted to this Windows user in
//! `app_data_dir/accounts/<provider>/<hash>.dpapi`. Tokens rotate, so the live
//! login is copied again every time the list is read and right before a switch.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use windows::core::HSTRING;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Gemini,
}

impl Provider {
    const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Gemini];

    fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Gemini => "gemini",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
            Provider::Gemini => "Gemini CLI",
        }
    }

    /// The CLI's own config folder, honouring the same overrides the CLI does.
    fn dir(self) -> Option<PathBuf> {
        let home = || std::env::var_os("USERPROFILE").map(PathBuf::from);
        match self {
            Provider::Claude => std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| home().map(|h| h.join(".claude"))),
            Provider::Codex => std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| home().map(|h| h.join(".codex"))),
            Provider::Gemini => home().map(|h| h.join(".gemini")),
        }
    }
}

/// Claude keeps the account profile outside the credentials file: in
/// `~/.claude.json`, or inside the config folder when that's overridden.
fn claude_json() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => Some(PathBuf::from(dir).join(".claude.json")),
        None => std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join(".claude.json")),
    }
}

const GEMINI_FILES: [&str; 3] = ["oauth_creds.json", "google_accounts.json", "google_account_id"];

/// How long Claude's credentials file must sit untouched before it's copied.
/// A sign-in writes the tokens first and the account profile a moment later;
/// copying in between would file the new tokens under the previous account.
const CLAUDE_SETTLE: Duration = Duration::from_secs(8);

// ------------------------------------------------------------------ reading

/// The login a CLI is using right now.
struct Live {
    /// Stable per account (and per organization / workspace within it).
    id: String,
    email: String,
    plan: String,
    org: String,
    /// Everything needed to put this login back later.
    payload: Value,
    /// False while the CLI is still writing the login out.
    settled: bool,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The claims of a JWT, unverified: only used to label an account the CLI
/// already trusts.
fn jwt_claims(token: &str) -> Option<Value> {
    let body = token.split('.').nth(1)?.trim_end_matches('=');
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn title_case(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn claude_plan(oauth: &Value) -> String {
    let kind = text(oauth, "subscriptionType");
    let tier = text(oauth, "rateLimitTier");
    let mult = ["20x", "5x"].into_iter().find(|m| tier.contains(m));
    match (kind.as_str(), mult) {
        ("", _) => String::new(),
        (k, Some(m)) => format!("{} {m}", title_case(k)),
        (k, None) => title_case(k),
    }
}

fn read_live(provider: Provider) -> Option<Live> {
    let dir = provider.dir()?;
    match provider {
        Provider::Claude => {
            let creds_path = dir.join(".credentials.json");
            let oauth = read_json(&creds_path)?.get("claudeAiOauth")?.clone();
            oauth.get("refreshToken")?.as_str()?;
            let account = read_json(&claude_json()?)?.get("oauthAccount")?.clone();
            let uuid = account.get("accountUuid")?.as_str()?.to_string();
            let settled = fs::metadata(&creds_path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| m.elapsed().ok())
                .is_none_or(|age| age >= CLAUDE_SETTLE);
            let mut id = format!("{uuid}:{}", text(&account, "organizationUuid"));
            let mut account = account;
            // A running Claude Code that renews its token writes it back to the
            // credentials file, even after OpenTerm moved the profile to another
            // account. Trust who the provider says owns the token over the profile.
            if let Some(owner) = verified_owner(oauth.get("accessToken").and_then(Value::as_str).unwrap_or("")) {
                if owner != id {
                    // Unknown owner: it can't be labelled, so it isn't saved at all.
                    let saved = store_root()
                        .map(|r| file_for(&r.join(Provider::Claude.id()), &owner))
                        .and_then(|f| load(&f))?;
                    account = saved.payload.get("account")?.clone();
                    id = owner;
                }
            }
            Some(Live {
                id,
                email: text(&account, "emailAddress"),
                plan: claude_plan(&oauth),
                org: text(&account, "organizationName"),
                payload: json!({ "oauth": oauth, "account": account }),
                settled,
            })
        }
        Provider::Codex => {
            let raw = fs::read_to_string(dir.join("auth.json")).ok()?;
            let v: Value = serde_json::from_str(&raw).ok()?;
            let tokens = v.get("tokens").filter(|t| t.is_object());
            let (id, email, plan) = match tokens {
                Some(tokens) => {
                    let claims = jwt_claims(tokens.get("id_token")?.as_str()?)?;
                    let auth = claims.get("https://api.openai.com/auth").cloned().unwrap_or(Value::Null);
                    let email = text(&claims, "email");
                    let mut account = text(tokens, "account_id");
                    if account.is_empty() {
                        account = text(&auth, "chatgpt_account_id");
                    }
                    if account.is_empty() && email.is_empty() {
                        return None;
                    }
                    (format!("{account}:{email}"), email, title_case(&text(&auth, "chatgpt_plan_type")))
                }
                None => {
                    let key = v.get("OPENAI_API_KEY")?.as_str()?;
                    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                    (format!("key:{tail}:{}", key.len()), format!("API key ending {tail}"), "API".to_string())
                }
            };
            Some(Live { id, email, plan, org: String::new(), payload: Value::String(raw), settled: true })
        }
        Provider::Gemini => {
            let mut files = Map::new();
            for name in GEMINI_FILES {
                if let Ok(s) = fs::read_to_string(dir.join(name)) {
                    files.insert(name.to_string(), Value::String(s));
                }
            }
            let creds: Value = serde_json::from_str(files.get("oauth_creds.json")?.as_str()?).ok()?;
            creds.get("refresh_token")?.as_str()?;
            let mut email = creds
                .get("id_token")
                .and_then(Value::as_str)
                .and_then(jwt_claims)
                .map(|c| text(&c, "email"))
                .unwrap_or_default();
            if email.is_empty() {
                email = read_json(&dir.join("google_accounts.json")).map(|a| text(&a, "active")).unwrap_or_default();
            }
            if email.is_empty() {
                return None;
            }
            Some(Live {
                id: email.to_lowercase(),
                email,
                plan: String::new(),
                org: String::new(),
                payload: json!({ "files": files }),
                settled: true,
            })
        }
    }
}

// ------------------------------------------------------------------ verifying

type Owners = Mutex<std::collections::HashMap<u64, String>>;

/// Which account each Claude access token belongs to, as `<account>:<org>`,
/// keyed by a hash of the token. Filled by `verify_claude` before every command.
fn owners() -> &'static Owners {
    static OWNERS: std::sync::OnceLock<Owners> = std::sync::OnceLock::new();
    OWNERS.get_or_init(Default::default)
}

fn verified_owner(token: &str) -> Option<String> {
    owners().lock().unwrap_or_else(|e| e.into_inner()).get(&hash(token)).cloned()
}

/// Asks Anthropic who owns the access token in Claude's credentials file,
/// once per token. Offline or expired: nothing is learned and the profile in
/// `.claude.json` is trusted, as before.
async fn verify_claude() {
    let Some(token) = Provider::Claude
        .dir()
        .and_then(|d| read_json(&d.join(".credentials.json")))
        .and_then(|c| c.get("claudeAiOauth")?.get("accessToken")?.as_str().map(String::from))
    else {
        return;
    };
    if verified_owner(&token).is_some() {
        return;
    }
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(6)).build() else { return };
    let sent = client
        .get("https://api.anthropic.com/api/oauth/profile")
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await;
    let Ok(resp) = sent else { return };
    if !resp.status().is_success() {
        return;
    }
    let Ok(v) = resp.json::<Value>().await else { return };
    let account = v.get("account").map(|a| text(a, "uuid")).unwrap_or_default();
    if account.is_empty() {
        return;
    }
    let org = v.get("organization").map(|o| text(o, "uuid")).unwrap_or_default();
    owners().lock().unwrap_or_else(|e| e.into_inner()).insert(hash(&token), format!("{account}:{org}"));
}

// ------------------------------------------------------------------ writing

/// Replaces a file in one step where Windows allows it, so a CLI reading at
/// the same moment sees the old login or the new one, never half of each.
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".openterm-tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, data).map_err(|e| format!("{}: {e}", path.display()))?;
    if fs::rename(&tmp, path).is_err() {
        // Something holds the file open without letting it be replaced.
        let direct = fs::write(path, data).map_err(|e| format!("{}: {e}", path.display()));
        let _ = fs::remove_file(&tmp);
        return direct;
    }
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let out = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_atomic(path, out.as_bytes())
}

/// Puts a saved login back where its CLI reads it.
fn apply(provider: Provider, payload: &Value) -> Result<(), String> {
    let dir = provider.dir().ok_or("no home folder")?;
    let broken = || format!("The saved {} login is incomplete. Remove it and sign in again.", provider.name());
    match provider {
        Provider::Claude => {
            let oauth = payload.get("oauth").ok_or_else(broken)?;
            let account = payload.get("account").ok_or_else(broken)?;
            // Read both before writing either: a config that won't parse must
            // stop the switch while the old login is still fully in place.
            let cfg_path = claude_json().ok_or("no home folder")?;
            let mut cfg = match fs::read_to_string(&cfg_path) {
                Ok(s) => serde_json::from_str::<Value>(&s)
                    .map_err(|_| format!("Couldn't read {}. Nothing was changed.", cfg_path.display()))?,
                Err(_) => json!({}),
            };
            let creds_path = dir.join(".credentials.json");
            // Other entries in here (MCP server logins) belong to the machine, not the account.
            let mut creds = read_json(&creds_path).filter(Value::is_object).unwrap_or_else(|| json!({}));
            creds["claudeAiOauth"] = oauth.clone();
            let cfg_obj = cfg.as_object_mut().ok_or_else(|| format!("Couldn't read {}.", cfg_path.display()))?;
            cfg_obj.insert("oauthAccount".into(), account.clone());
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            write_json(&creds_path, &creds)?;
            write_json(&cfg_path, &cfg)
        }
        Provider::Codex => {
            let raw = payload.as_str().ok_or_else(broken)?;
            write_atomic(&dir.join("auth.json"), raw.as_bytes())
        }
        Provider::Gemini => {
            let files = payload.get("files").and_then(Value::as_object).ok_or_else(broken)?;
            for name in GEMINI_FILES {
                match files.get(name).and_then(Value::as_str) {
                    Some(s) => write_atomic(&dir.join(name), s.as_bytes())?,
                    None => {
                        let _ = fs::remove_file(dir.join(name));
                    }
                }
            }
            Ok(())
        }
    }
}

// ------------------------------------------------------------------ the sealed copies

unsafe fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
    unsafe { LocalFree(Some(HLOCAL(blob.pbData as *mut _))) };
    out
}

const ENTROPY: &[u8] = b"OpenTerm:accounts";

fn seal(plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut plain = plain.to_vec();
    let mut entropy = ENTROPY.to_vec();
    let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_mut_ptr() };
    let extra = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            &HSTRING::from("OpenTerm account"),
            Some(&extra),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    }
    .map_err(|e| e.message())?;
    Ok(unsafe { take_blob(out) })
}

fn unseal(sealed: &[u8]) -> Result<Vec<u8>, String> {
    let mut data = sealed.to_vec();
    let mut entropy = ENTROPY.to_vec();
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_mut_ptr() };
    let extra = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptUnprotectData(&input, None, Some(&extra), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
        .map_err(|e| e.message())?;
    Ok(unsafe { take_blob(out) })
}

#[derive(Serialize, Deserialize)]
struct Saved {
    id: String,
    email: String,
    #[serde(default)]
    plan: String,
    #[serde(default)]
    org: String,
    added_at: u64,
    payload: Value,
}

fn store_dir(app: &AppHandle, provider: Provider) -> Result<PathBuf, String> {
    let root = match STORE_ROOT.get() {
        Some(r) => r.clone(),
        None => {
            let r = app.path().app_data_dir().map_err(|e| e.to_string())?.join("accounts");
            STORE_ROOT.get_or_init(|| r).clone()
        }
    };
    Ok(root.join(provider.id()))
}

fn hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    h
}

/// Account ids hold emails and UUIDs; the file name is just a stable hash of one.
fn file_for(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{:016x}.dpapi", hash(id)))
}

static STORE_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn store_root() -> Option<&'static PathBuf> {
    STORE_ROOT.get()
}

fn load(path: &Path) -> Option<Saved> {
    serde_json::from_slice(&unseal(&fs::read(path).ok()?).ok()?).ok()
}

fn load_all(dir: &Path) -> Vec<Saved> {
    let mut all: Vec<Saved> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "dpapi"))
        .filter_map(|e| load(&e.path()))
        .collect();
    all.sort_by(|a, b| a.added_at.cmp(&b.added_at).then_with(|| a.email.cmp(&b.email)));
    all
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Copies the live login into the store when it's new or its tokens moved on.
fn capture(dir: &Path, live: &Live) -> Result<(), String> {
    let path = file_for(dir, &live.id);
    let old = load(&path);
    if old.as_ref().is_some_and(|o| {
        o.payload == live.payload && o.email == live.email && o.plan == live.plan && o.org == live.org
    }) {
        return Ok(());
    }
    let saved = Saved {
        id: live.id.clone(),
        email: live.email.clone(),
        plan: live.plan.clone(),
        org: live.org.clone(),
        added_at: old.map(|o| o.added_at).unwrap_or_else(now_ms),
        payload: live.payload.clone(),
    };
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let sealed = seal(&serde_json::to_vec(&saved).map_err(|e| e.to_string())?)?;
    write_atomic(&path, &sealed)
}

/// Captures the live login, refusing while the CLI is mid sign-in: whatever
/// replaces the live login next must not be the only copy of it.
fn capture_live(app: &AppHandle, provider: Provider) -> Result<(), String> {
    let Some(live) = read_live(provider) else { return Ok(()) };
    if !live.settled {
        return Err(format!("{} is still finishing a sign-in. Try again in a few seconds.", provider.name()));
    }
    capture(&store_dir(app, provider)?, &live)
}

// ------------------------------------------------------------------ commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    id: String,
    email: String,
    plan: String,
    org: String,
    active: bool,
    added_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccounts {
    provider: Provider,
    /// The CLI has a config folder on this machine.
    installed: bool,
    accounts: Vec<AccountInfo>,
}

/// One switch or list at a time: a list that lands in the middle of a switch
/// would read one account's tokens beside another's profile.
fn guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn list(app: &AppHandle) -> Result<Vec<ProviderAccounts>, String> {
    Provider::ALL
        .into_iter()
        .map(|provider| {
            let dir = store_dir(app, provider)?;
            let live = read_live(provider);
            if let Some(l) = live.as_ref().filter(|l| l.settled) {
                capture(&dir, l)?;
            }
            let live_id = live.map(|l| l.id);
            let accounts = load_all(&dir)
                .into_iter()
                .map(|s| AccountInfo {
                    active: live_id.as_deref() == Some(s.id.as_str()),
                    id: s.id,
                    email: s.email,
                    plan: s.plan,
                    org: s.org,
                    added_at: s.added_at,
                })
                .collect();
            Ok(ProviderAccounts { provider, installed: provider.dir().is_some_and(|d| d.is_dir()), accounts })
        })
        .collect()
}

/// Every saved account per CLI, after saving whichever login is live now.
/// That side effect is the whole "add account" story: sign in with the CLI and
/// the new account shows up here.
#[tauri::command]
pub async fn accounts_list(app: AppHandle) -> Result<Vec<ProviderAccounts>, String> {
    blocking(app, |app| list(&app)).await
}

/// Checks the live Claude token's owner, then runs `f` on a blocking thread
/// under the lock (file I/O and DPAPI don't belong on the async runtime).
async fn blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let _ = store_dir(&app, Provider::Claude);
    verify_claude().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = guard();
        f(app)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn accounts_switch(app: AppHandle, provider: Provider, id: String) -> Result<Vec<ProviderAccounts>, String> {
    blocking(app, move |app| switch(&app, provider, &id)).await
}

fn switch(app: &AppHandle, provider: Provider, id: &str) -> Result<Vec<ProviderAccounts>, String> {
    capture_live(app, provider)?;
    let target = load(&file_for(&store_dir(app, provider)?, id))
        .ok_or("That account is no longer saved. Sign in to it again.")?;
    apply(provider, &target.payload)?;
    crate::usage::forget_usage_limits();
    list(app)
}

/// Forgets a saved account. The CLI's live login is never touched, so the
/// account in use can't be removed here (it would just be saved again).
#[tauri::command]
pub async fn accounts_remove(app: AppHandle, provider: Provider, id: String) -> Result<Vec<ProviderAccounts>, String> {
    blocking(app, move |app| remove(&app, provider, &id)).await
}

fn remove(app: &AppHandle, provider: Provider, id: &str) -> Result<Vec<ProviderAccounts>, String> {
    if read_live(provider).is_some_and(|l| l.id == id) {
        return Err("Switch to another account first.".into());
    }
    match fs::remove_file(file_for(&store_dir(app, provider)?, id)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    list(app)
}

/// Gets a CLI ready for another sign-in and returns the command that starts
/// one. The current login is saved first, so signing in over it loses nothing.
#[tauri::command]
pub async fn accounts_begin_login(app: AppHandle, provider: Provider) -> Result<String, String> {
    blocking(app, move |app| begin_login(&app, provider)).await
}

fn begin_login(app: &AppHandle, provider: Provider) -> Result<String, String> {
    capture_live(app, provider)?;
    Ok(match provider {
        Provider::Claude => "claude auth login",
        Provider::Codex => "codex login",
        Provider::Gemini => {
            // Gemini has no login command: it asks only when no login is saved.
            if let Some(dir) = provider.dir() {
                for name in GEMINI_FILES {
                    let _ = fs::remove_file(dir.join(name));
                }
            }
            "gemini"
        }
    }
    .to_string())
}
