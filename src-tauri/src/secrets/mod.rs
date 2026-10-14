//! API keys, kept out of the app's JSON files.
//!
//! Keys live in the OS keystore. The frontend only ever learns whether a key
//! is saved and where; the Rust side looks a key up itself each time it calls
//! a provider, so a saved key never travels to the webview (Gemini Live gets a
//! short-lived token instead, see `commands::gemini_live_token`). No caching either: a lookup is
//! cheap, and the dictation agent is a second process that has to see a key
//! the moment Settings saves it.
//!
//! Storage is a chain of backends tried in order, from `platform::backends`.
//! On Windows that's Credential Manager, then a DPAPI-encrypted file for
//! machines where policy turns Credential Manager off. Both are encrypted with
//! the user's Windows login. Another OS adds its own `platform` module (macOS
//! Keychain, Linux Secret Service) and nothing outside this module changes.
//!
//! Versions up to 1.2 kept keys in plain text in state.json. `absorb` moves
//! them over and the plaintext is only dropped once the key reads back from a
//! backend. If no backend can take it, the key stays where it was and keeps
//! working (`Storage::Plaintext`), so an update can never lose a key.

pub mod commands;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as platform;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Secret {
    OpenRouter,
    Gemini,
}

impl Secret {
    pub const ALL: [Secret; 2] = [Secret::OpenRouter, Secret::Gemini];

    /// Stable id: part of every keystore entry name, and the frontend's name.
    pub fn id(self) -> &'static str {
        match self {
            Secret::OpenRouter => "openrouter",
            Secret::Gemini => "gemini",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Secret::OpenRouter => "OpenRouter API key",
            Secret::Gemini => "Gemini API key",
        }
    }

    /// The `settings` field older versions kept this key in, in plain text.
    pub fn legacy_field(self) -> &'static str {
        match self {
            Secret::OpenRouter => "openrouterApiKey",
            Secret::Gemini => "geminiApiKey",
        }
    }
}

/// Where a saved key lives. Shown in Settings, so it says something true.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Storage {
    CredentialManager,
    EncryptedFile,
    /// Still in state.json from an older version, because no backend would
    /// take it. Retried on every launch.
    Plaintext,
}

/// What Settings shows for a saved key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KeyInfo {
    pub storage: Storage,
    /// A few characters to recognise the key by, see `hint`.
    pub hint: String,
}

/// Enough of a key to match it against the provider's own key list, far too
/// little to use: the provider's prefix, three characters and the last four,
/// like `sk-or-v1-0e6…1c96`. OpenRouter lists keys the same way and AI Studio
/// shows the last four.
pub fn hint(key: &str) -> String {
    let prefix = ["sk-or-v1-", "sk-or-", "AIza"]
        .into_iter()
        .find(|p| key.starts_with(p))
        .unwrap_or("");
    let rest: Vec<char> = key[prefix.len()..].chars().collect();
    if rest.len() < 12 {
        return format!("{prefix}…");
    }
    let head: String = rest[..3].iter().collect();
    let tail: String = rest[rest.len() - 4..].iter().collect();
    format!("{prefix}{head}…{tail}")
}

/// One place keys can be kept. Implementations must be safe to call from both
/// the main app and the dictation agent at the same time.
pub trait Backend: Sync {
    fn storage(&self) -> Storage;
    fn get(&self, vault: &Vault, secret: Secret) -> Result<Option<String>, String>;
    fn set(&self, vault: &Vault, secret: Secret, value: &str) -> Result<(), String>;
    /// Removing a key that isn't there is not an error.
    fn delete(&self, vault: &Vault, secret: Secret) -> Result<(), String>;
}

/// Longer than any real key; keeps well inside Credential Manager's 2560-byte
/// blob limit.
const MAX_KEY_LEN: usize = 1024;

/// Keys absorbed from state.json that no backend would take. `save_state`
/// writes them back so they stay put until a later launch can move them.
fn unmigrated() -> &'static Mutex<HashMap<Secret, String>> {
    static PENDING: OnceLock<Mutex<HashMap<Secret, String>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The keystore for one app identity. The identifier namespaces every entry,
/// so a dev build (`com.openterm.app.dev`) never reads or overwrites the keys
/// of the installed app.
#[derive(Clone, Debug)]
pub struct Vault {
    service: String,
    dir: PathBuf,
}

impl Vault {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        Ok(Vault {
            service: app.config().identifier.clone(),
            dir: app.path().app_data_dir().map_err(|e| e.to_string())?,
        })
    }

    #[cfg(test)]
    pub fn for_test(service: String, dir: PathBuf) -> Self {
        Vault { service, dir }
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    /// app_data_dir: state.json, its backups and the encrypted-file fallback.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join("state.json")
    }

    /// The first backend holding this key, and the key.
    fn stored(&self, secret: Secret) -> Option<(String, Storage)> {
        platform::backends().iter().find_map(|b| match b.get(self, secret) {
            Ok(Some(v)) if !v.is_empty() => Some((v, b.storage())),
            Ok(_) => None,
            Err(e) => {
                eprintln!("[secrets] reading {} from {:?} failed: {e}", secret.id(), b.storage());
                None
            }
        })
    }

    /// A key not yet moved out of state.json. Read from disk rather than from
    /// `unmigrated()` so the dictation agent, a separate process, sees it too.
    fn plaintext(&self, secret: Secret) -> Option<String> {
        let json = fs::read_to_string(self.state_path()).ok()?;
        let v: Value = serde_json::from_str(&json).ok()?;
        let key = v["settings"][secret.legacy_field()].as_str()?.trim();
        (!key.is_empty()).then(|| key.to_string())
    }

    pub fn get(&self, secret: Secret) -> Option<String> {
        self.stored(secret).map(|(v, _)| v).or_else(|| self.plaintext(secret))
    }

    /// The key, or the error a feature shows when there is none.
    pub fn require(&self, secret: Secret) -> Result<String, String> {
        self.get(secret).ok_or_else(|| format!("Add your {} in Settings → AI.", secret.label()))
    }

    pub fn status(&self, secret: Secret) -> Option<KeyInfo> {
        let (key, storage) = self
            .stored(secret)
            .or_else(|| self.plaintext(secret).map(|k| (k, Storage::Plaintext)))?;
        Some(KeyInfo { storage, hint: hint(&key) })
    }

    /// Saves to the first backend that takes the key and reads it back intact,
    /// then removes any copy from the others so there's exactly one.
    pub fn set(&self, secret: Secret, value: &str) -> Result<Storage, String> {
        let value = value.trim();
        if value.is_empty() {
            return Err("The key is empty.".into());
        }
        if value.len() > MAX_KEY_LEN || value.chars().any(char::is_control) {
            return Err("That doesn't look like an API key.".into());
        }
        let backends = platform::backends();
        let mut last_err = String::from("no secure storage is available on this system");
        for (i, b) in backends.iter().enumerate() {
            let verified = b
                .set(self, secret, value)
                .and_then(|()| b.get(self, secret))
                .and_then(|got| match got.as_deref() == Some(value) {
                    true => Ok(()),
                    false => Err("the saved key didn't read back intact".into()),
                });
            match verified {
                Ok(()) => {
                    for (j, other) in backends.iter().enumerate() {
                        if j != i {
                            let _ = other.delete(self, secret);
                        }
                    }
                    unmigrated().lock().unwrap().remove(&secret);
                    return Ok(b.storage());
                }
                Err(e) => {
                    eprintln!("[secrets] saving {} to {:?} failed: {e}", secret.id(), b.storage());
                    let _ = b.delete(self, secret);
                    last_err = e;
                }
            }
        }
        Err(format!("Couldn't save the key securely: {last_err}"))
    }

    /// Removes the key from every backend. A plaintext copy an older version
    /// left in state.json goes with the frontend's next save, which no longer
    /// writes it back (see `restore_unmigrated`).
    pub fn clear(&self, secret: Secret) -> Result<(), String> {
        unmigrated().lock().unwrap().remove(&secret);
        let errors: Vec<String> = platform::backends()
            .iter()
            .filter_map(|b| b.delete(self, secret).err())
            .collect();
        match errors.is_empty() {
            true => Ok(()),
            false => Err(format!("Couldn't remove the key: {}", errors.join("; "))),
        }
    }
}

// ------------------------------------------------------------ state.json

/// Takes every key field out of a state document and moves each non-empty one
/// into the keystore. A key found in plain text is the newest one the user
/// entered (only an older version, after a downgrade, writes one), so it
/// replaces whatever the keystore held. Returns true when the document had
/// any key field at all.
///
/// Keys no backend would take are remembered in `unmigrated()`; put them back
/// with `restore_unmigrated` before anything is written to disk.
pub fn absorb(vault: &Vault, state: &mut Value) -> bool {
    let Some(settings) = state.get_mut("settings").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut found = false;
    for secret in Secret::ALL {
        let Some(field) = settings.remove(secret.legacy_field()) else { continue };
        found = true;
        let key = field.as_str().map(str::trim).unwrap_or("");
        if key.is_empty() {
            continue;
        }
        if vault.stored(secret).is_some_and(|(v, _)| v == key) {
            continue;
        }
        if let Err(e) = vault.set(secret, key) {
            eprintln!("[secrets] {} stays in state.json for now: {e}", secret.id());
            unmigrated().lock().unwrap().insert(secret, key.to_string());
        }
    }
    found
}

/// Writes keys that couldn't be moved back into a state document, exactly as
/// an older version would have stored them. Returns true when it added any.
pub fn restore_unmigrated(state: &mut Value) -> bool {
    let pending = unmigrated().lock().unwrap();
    if pending.is_empty() {
        return false;
    }
    let Some(settings) = state.get_mut("settings").and_then(Value::as_object_mut) else {
        return false;
    };
    for (secret, key) in pending.iter() {
        settings.insert(secret.legacy_field().into(), Value::String(key.clone()));
    }
    true
}

pub fn has_unmigrated() -> bool {
    !unmigrated().lock().unwrap().is_empty()
}

// ------------------------------------------------------------ old copies

/// Marks that every old copy of state.json has been cleaned. Its absence makes
/// the next load scan the backups again.
const SCRUBBED_MARKER: &str = "keys-scrubbed";

/// Whether the backup copies need a scrub: on the first launch of a version
/// with the keystore, and whenever a load found plaintext keys.
pub fn needs_scrub(vault: &Vault, found_plaintext: bool) -> bool {
    found_plaintext || !vault.dir.join(SCRUBBED_MARKER).exists()
}

/// Takes plaintext keys out of every backup of state.json and out of the
/// dictation agent's config, keeping each backup's timestamp (the backup list
/// sorts and labels by it). Only call this once every key is safely in a
/// backend: until then the backups are a copy worth keeping.
///
/// Must not run alongside a save, which rotates the backup ring; `load_state`
/// calls it before the frontend can save anything.
pub fn scrub_old_copies(vault: &Vault) {
    if has_unmigrated() {
        let _ = fs::remove_file(vault.dir.join(SCRUBBED_MARKER));
        return;
    }
    let mut clean = true;
    let backups = fs::read_dir(vault.dir.join("backups"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .is_some_and(|n| n.starts_with("state-") && n.ends_with(".json"))
        });
    for path in backups {
        if let Err(e) = scrub_file(&path, |v| {
            let Some(settings) = v.get_mut("settings").and_then(Value::as_object_mut) else {
                return false;
            };
            let mut removed = false;
            for secret in Secret::ALL {
                removed |= settings.remove(secret.legacy_field()).is_some();
            }
            removed
        }) {
            eprintln!("[secrets] couldn't clean {}: {e}", path.display());
            clean = false;
        }
    }
    let dictation = vault.dir.join("dictation").join("config.json");
    if let Err(e) = scrub_file(&dictation, |v| v.as_object_mut().and_then(|o| o.remove("apiKey")).is_some()) {
        eprintln!("[secrets] couldn't clean {}: {e}", dictation.display());
        clean = false;
    }
    if clean {
        let _ = fs::write(vault.dir.join(SCRUBBED_MARKER), "1");
    }
}

/// Rewrites one JSON file when `strip` removes something from it. Files that
/// can't hold a key (no `ApiKey"`/`apiKey"` in the text) are only read, never
/// parsed. Unparseable files are left alone: there is no key in them that
/// anything could read.
fn scrub_file(path: &Path, strip: impl Fn(&mut Value) -> bool) -> Result<(), String> {
    let Ok(text) = fs::read_to_string(path) else { return Ok(()) };
    if !text.contains("ApiKey\"") && !text.contains("apiKey\"") {
        return Ok(());
    }
    let Ok(mut v) = serde_json::from_str::<Value>(&text) else { return Ok(()) };
    if strip(&mut v) {
        rewrite_keeping_mtime(path, &v, true)?;
    }
    Ok(())
}

/// Writes through a temp file and a rename, so the file is never half-written.
/// With `keep_mtime` the modification time is put back afterwards.
fn rewrite_keeping_mtime(path: &Path, v: &Value, keep_mtime: bool) -> Result<(), String> {
    let mtime = fs::metadata(path).and_then(|m| m.modified()).ok();
    let json = serde_json::to_string(v).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.scrub");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let (true, Some(t)) = (keep_mtime, mtime) {
        let _ = fs::OpenOptions::new().write(true).open(path).and_then(|f| f.set_modified(t));
    }
    Ok(())
}

/// Serializes the tests that touch the process-wide `unmigrated()` map.
#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_unmigrated_puts_keys_back_where_old_versions_read_them() {
        let _serial = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unmigrated().lock().unwrap().insert(Secret::Gemini, "AIza-test".into());
        let mut state = serde_json::json!({ "settings": { "theme": "dark" } });
        assert!(restore_unmigrated(&mut state));
        assert_eq!(state["settings"]["geminiApiKey"], "AIza-test");
        assert_eq!(state["settings"]["theme"], "dark");
        unmigrated().lock().unwrap().clear();
        assert!(!restore_unmigrated(&mut state.clone()));
    }

    #[test]
    fn hints_show_the_prefix_and_a_few_characters_only() {
        assert_eq!(hint("sk-or-v1-0e6-example-not-a-real-key-000000000001c96"), "sk-or-v1-0e6…1c96");
        assert_eq!(hint("AIzaSyD-example-not-a-real-key-yz12"), "AIzaSyD…yz12");
        assert_eq!(hint("custom-key-1234567890"), "cus…7890");
        assert_eq!(hint("sk-or-v1-short"), "sk-or-v1-…");
    }

    #[test]
    fn scrub_file_strips_keys_and_keeps_the_timestamp() {
        let dir = std::env::temp_dir().join(format!("td-secrets-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state-last-1.json");
        fs::write(&path, r#"{"sessions":[],"settings":{"openrouterApiKey":"sk-or-x","geminiApiKey":"","theme":"dark"}}"#)
            .unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(old).unwrap();

        scrub_file(&path, |v| {
            let s = v["settings"].as_object_mut().unwrap();
            s.remove("openrouterApiKey").is_some() | s.remove("geminiApiKey").is_some()
        })
        .unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-or-x") && !text.contains("ApiKey"));
        assert!(text.contains("\"theme\":\"dark\""));
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old);
        let _ = fs::remove_dir_all(&dir);
    }
}
