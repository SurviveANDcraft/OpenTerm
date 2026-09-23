//! Per-terminal AI-harness usage accounting.
//!
//! Answers "what did *this* terminal cost me?" by joining three things the
//! harness CLIs already write to disk:
//!
//!   1. which agent processes ran under a pane's shell (process tree),
//!   2. which harness session each of those processes owned (session registry),
//!   3. what that session spent (transcript / message store).
//!
//! Attribution confidence differs per harness and is reported to the UI rather
//! than papered over:
//!
//!   * **Claude Code** writes `~/.claude/sessions/<pid>.json` mapping a live PID
//!     to its session id. A pane's shell PID → descendants → that file is an
//!     *exact* link, so those numbers are attributed with certainty.
//!   * **OpenCode / Codex** publish no PID→session registry. We instead record
//!     the window during which one of their processes was alive under a pane and
//!     claim sessions whose activity falls inside it (cwd used as a tiebreak).
//!     Those links are flagged `inferred` — correct in the common case, but two
//!     panes running the same harness at once can't be told apart with certainty.
//!
//! Links are persisted, so a pane keeps its history after the agent exits and
//! across app restarts — the live process is only how a link is *discovered*.

use std::cmp::Reverse;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

// ===================================================================
//  Time helpers
// ===================================================================

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Days since the Unix epoch for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parses the fixed `YYYY-MM-DDTHH:MM:SS[.fff]Z` shape every harness writes.
/// Returns epoch milliseconds. Anything else yields `None` rather than a guess.
fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut ms = (days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec) * 1000;
    // Optional fractional seconds.
    if b.len() > 20 && b[19] == b'.' {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if !frac.is_empty() {
            let scaled = format!("{:0<3}", &frac[..frac.len().min(3)]);
            ms += scaled.parse::<i64>().unwrap_or(0);
        }
    }
    Some(ms)
}

/// `YYYY-MM-DD` bucket key for the day breakdown, in UTC.
fn day_key(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Inverse of days_from_civil.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .map(PathBuf::from)
}

// ===================================================================
//  Pricing
// ===================================================================

/// Rates in US dollars per million tokens. Cache rates are expressed as
/// multipliers on the input rate, matching how the providers actually bill:
/// a 5-minute cache write costs 1.25x input, a 1-hour write 2x, a read 0.1x.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    #[serde(default = "one_point_two_five")]
    pub cache_write_5m_mult: f64,
    #[serde(default = "two")]
    pub cache_write_1h_mult: f64,
    #[serde(default = "one_tenth")]
    pub cache_read_mult: f64,
}

fn one_point_two_five() -> f64 {
    1.25
}
fn two() -> f64 {
    2.0
}
fn one_tenth() -> f64 {
    0.1
}

impl ModelPrice {
    fn new(input: f64, output: f64) -> Self {
        Self {
            input,
            output,
            cache_write_5m_mult: 1.25,
            cache_write_1h_mult: 2.0,
            cache_read_mult: 0.1,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PricingFile {
    /// Bumped when the seeded defaults change so we can add newly-known models
    /// to an existing file without clobbering the user's own edits.
    pub version: u32,
    pub models: HashMap<String, ModelPrice>,
}

/// Anthropic list prices (USD per million tokens). These are the rates the
/// Claude Code transcripts are billed at; Claude Code records raw token counts
/// and no cost, so cost is computed here.
///
/// Non-Anthropic models are deliberately **not** seeded with invented numbers.
/// Their tokens are still counted exactly and the UI reports them as unpriced
/// until the user adds a rate to `pricing.json`.
fn seed_prices() -> HashMap<String, ModelPrice> {
    let mut m = HashMap::new();
    let mut add = |k: &str, i: f64, o: f64| {
        m.insert(k.to_string(), ModelPrice::new(i, o));
    };
    add("claude-fable-5", 10.0, 50.0);
    add("claude-mythos-5", 10.0, 50.0);
    add("claude-mythos-preview", 10.0, 50.0);
    add("claude-opus-5", 5.0, 25.0);
    add("claude-opus-4-8", 5.0, 25.0);
    add("claude-opus-4-7", 5.0, 25.0);
    add("claude-opus-4-6", 5.0, 25.0);
    add("claude-opus-4-5", 5.0, 25.0);
    add("claude-opus-4-1", 15.0, 75.0);
    add("claude-opus-4-0", 15.0, 75.0);
    add("claude-sonnet-5", 3.0, 15.0);
    add("claude-sonnet-4-6", 3.0, 15.0);
    add("claude-sonnet-4-5", 3.0, 15.0);
    add("claude-sonnet-4-0", 3.0, 15.0);
    add("claude-haiku-4-5", 1.0, 5.0);
    add("claude-3-5-haiku", 0.8, 4.0);
    add("claude-3-haiku", 0.25, 1.25);
    // Claude Code records the alias, not the resolved id, when a session was
    // started with one; without these the rows land in "unpriced".
    add("opus", 5.0, 25.0);
    add("sonnet", 3.0, 15.0);
    add("haiku", 1.0, 5.0);

    // Codex. `price_for` falls back to the longest matching prefix, so
    // "gpt-5" covers point releases and dated snapshots at the family rate —
    // an estimate for any model released after this table. Edit pricing.json
    // to correct a rate; hand-edited entries are never overwritten.
    add("gpt-5", 1.25, 10.0);
    add("gpt-5-mini", 0.25, 2.0);
    add("gpt-5-nano", 0.05, 0.4);
    add("gpt-4.1", 2.0, 8.0);
    add("gpt-4.1-mini", 0.4, 1.6);
    add("gpt-4o", 2.5, 10.0);
    add("gpt-4o-mini", 0.15, 0.6);
    add("o3", 2.0, 8.0);
    add("o4-mini", 1.1, 4.4);

    // Gemini CLI.
    add("gemini-2.5-pro", 1.25, 10.0);
    add("gemini-2.5-flash", 0.3, 2.5);
    add("gemini-2.5-flash-lite", 0.1, 0.4);
    add("gemini-2.0-flash", 0.1, 0.4);
    add("gemini-3", 2.0, 12.0);
    m
}

const PRICING_VERSION: u32 = 1;

fn pricing_path() -> Option<PathBuf> {
    DATA_DIR.get().map(|d| d.join("pricing.json"))
}

fn load_pricing() -> HashMap<String, ModelPrice> {
    let seeded = seed_prices();
    let Some(path) = pricing_path() else {
        return seeded;
    };
    let existing: Option<PricingFile> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    match existing {
        Some(mut f) if f.version >= PRICING_VERSION => {
            // Fill in models the user's file predates, but never overwrite a
            // rate they have edited themselves.
            for (k, v) in seeded {
                f.models.entry(k).or_insert(v);
            }
            f.models
        }
        _ => {
            let file = PricingFile {
                version: PRICING_VERSION,
                models: seeded,
            };
            if let Ok(json) = serde_json::to_string_pretty(&file) {
                let _ = fs::write(&path, json);
            }
            file.models
        }
    }
}

/// Resolves a transcript's model string against the price table. Exact match
/// first, then longest-prefix, so dated snapshots (`claude-haiku-4-5-20251001`)
/// resolve to their base entry without needing their own row.
fn price_for<'a>(
    table: &'a HashMap<String, ModelPrice>,
    model: &str,
    speed: Option<&str>,
) -> Option<&'a ModelPrice> {
    // Fast mode is a distinct, higher rate on the models that offer it.
    if speed == Some("fast") {
        if let Some(p) = table.get(&format!("{model}-fast")) {
            return Some(p);
        }
    }
    if let Some(p) = table.get(model) {
        return Some(p);
    }
    table
        .iter()
        .filter(|(k, _)| model.starts_with(k.as_str()))
        .max_by_key(|(k, _)| k.len())
        .map(|(_, v)| v)
}

// ===================================================================
//  Process tree (Windows)
// ===================================================================

#[derive(Clone, Debug)]
struct ProcInfo {
    pid: u32,
    ppid: u32,
    name: String,
}

#[cfg(windows)]
fn snapshot_processes() -> Vec<ProcInfo> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                out.push(ProcInfo {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase(),
                });
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

#[cfg(not(windows))]
fn snapshot_processes() -> Vec<ProcInfo> {
    Vec::new()
}

/// Every descendant of `root`, breadth-first. Guards against the PID-reuse
/// cycles a naive walk can hit by tracking what it has already visited.
fn descendants(procs: &[ProcInfo], root: u32) -> Vec<&ProcInfo> {
    let mut children: HashMap<u32, Vec<&ProcInfo>> = HashMap::new();
    for p in procs {
        children.entry(p.ppid).or_default().push(p);
    }
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if seen.insert(child.pid) {
                out.push(*child);
                queue.push(child.pid);
            }
        }
    }
    out
}

/// Maps an executable name to the harness it belongs to. Deliberately narrow —
/// a generic `node.exe` could be anything, so it is not claimed.
fn harness_for_exe(name: &str) -> Option<&'static str> {
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    match stem {
        "claude" => Some("claude-code"),
        "opencode" | "opencode-cli" => Some("opencode"),
        "codex" => Some("codex"),
        "gemini" => Some("gemini"),
        "cursor-agent" => Some("cursor-agent"),
        _ => None,
    }
}

/// The one agent running anywhere under `root` (a terminal window's process),
/// or None when there's none or more than one kind: with several tabs we can't
/// tell which is focused, so the caller falls back to plain Ctrl+V.
pub fn sole_harness_under(root: u32) -> Option<&'static str> {
    let procs = snapshot_processes();
    let mut found: Option<&'static str> = None;
    for p in descendants(&procs, root) {
        if let Some(h) = harness_for_exe(&p.name) {
            match found {
                Some(prev) if prev != h => return None,
                _ => found = Some(h),
            }
        }
    }
    found
}

pub fn harness_label(id: &str) -> &'static str {
    match id {
        "claude-code" => "Claude Code",
        "opencode" => "OpenCode",
        "codex" => "Codex",
        "gemini" => "Gemini CLI",
        "cursor-agent" => "Cursor Agent",
        _ => "Unknown",
    }
}

// ===================================================================
//  Pane registry + persisted links
// ===================================================================

/// A harness session claimed by a pane.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionLink {
    pub harness: String,
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
    /// `true` when the link came from a PID→session registry (exact),
    /// `false` when it was matched by process-alive window (inferred).
    #[serde(default)]
    pub exact: bool,
}

/// A harness process observed alive under a pane but whose session id we can't
/// read directly. The alive window is what later lets us claim sessions.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProcWindow {
    pub harness: String,
    pub pid: u32,
    pub start: i64,
    pub end: i64,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PaneLinks {
    #[serde(default)]
    pub links: Vec<SessionLink>,
    #[serde(default)]
    pub windows: Vec<ProcWindow>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct LinkFile {
    #[serde(default)]
    panes: HashMap<String, PaneLinks>,
}

struct Registry {
    /// pane id → shell PID for the currently live PTYs.
    ptys: HashMap<String, u32>,
    /// pane id → cwd the shell was spawned in (a matching hint, not gospel —
    /// the user is free to `cd` afterwards).
    cwds: HashMap<String, String>,
    links: LinkFile,
    dirty: bool,
}

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(|| {
        Mutex::new(Registry {
            ptys: HashMap::new(),
            cwds: HashMap::new(),
            links: LinkFile::default(),
            dirty: false,
        })
    })
}

/// App data directory, set once at startup before any pricing or link file is
/// touched. Everything that persists hangs off this.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

fn links_path() -> Option<PathBuf> {
    DATA_DIR.get().map(|d| d.join("usage-links.json"))
}

fn load_links() {
    let Some(path) = links_path() else { return };
    if let Ok(s) = fs::read_to_string(&path) {
        if let Ok(f) = serde_json::from_str::<LinkFile>(&s) {
            registry().lock().unwrap().links = f;
        }
    }
}

fn save_links_if_dirty() {
    let Some(path) = links_path() else { return };
    let json = {
        let mut reg = registry().lock().unwrap();
        if !reg.dirty {
            return;
        }
        reg.dirty = false;
        serde_json::to_string(&reg.links).ok()
    };
    if let Some(json) = json {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

pub fn register_pty(pane_id: String, pid: u32, cwd: Option<String>) {
    let mut reg = registry().lock().unwrap();
    reg.ptys.insert(pane_id.clone(), pid);
    if let Some(c) = cwd {
        reg.cwds.insert(pane_id, c);
    }
}

pub fn unregister_pty(pane_id: &str) {
    let mut reg = registry().lock().unwrap();
    reg.ptys.remove(pane_id);
    // Links and windows intentionally survive: the pane's spend history should
    // outlive the process that produced it.
}

/// Drops a pane's accumulated history. Called when the pane itself is closed
/// for good, so stats don't accrue against a recycled id.
pub fn forget_pane(pane_id: &str) {
    let mut reg = registry().lock().unwrap();
    reg.ptys.remove(pane_id);
    reg.cwds.remove(pane_id);
    if reg.links.panes.remove(pane_id).is_some() {
        reg.dirty = true;
    }
}

// ===================================================================
//  Harness session registries (PID → session id)
// ===================================================================

/// Claude Code publishes `~/.claude/sessions/<pid>.json` for every running
/// instance. This is what makes Claude Code attribution exact.
#[derive(Debug, Deserialize)]
struct ClaudeSessionFile {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(default)]
    cwd: Option<String>,
}

fn claude_session_for_pid(pid: u32) -> Option<(String, Option<String>)> {
    let path = home_dir()?
        .join(".claude")
        .join("sessions")
        .join(format!("{pid}.json"));
    let s = fs::read_to_string(path).ok()?;
    let f: ClaudeSessionFile = serde_json::from_str(&s).ok()?;
    Some((f.session_id, f.cwd))
}

// ===================================================================
//  Poller
// ===================================================================

/// pane id → the harness currently running in that pane, refreshed by the
/// poller from the live process tree. This is what drives the per-pane usage
/// pill: reading the process tree works no matter how the agent was launched
/// (typed, recalled from history, pasted, accepted from a shell prediction, or
/// started by a wrapper script), whereas the typed-command sniffing it used to
/// rely on only ever saw a freshly hand-typed line.
fn live_harnesses() -> &'static Mutex<HashMap<String, String>> {
    static LIVE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Snapshot of which harness is live in each pane. Cheap: it just clones the
/// map the poller already maintains, so calling it often costs no extra process
/// enumeration.
#[tauri::command(async)]
pub fn live_pane_harnesses() -> HashMap<String, String> {
    live_harnesses().lock().unwrap().clone()
}

/// Watches every live PTY for agent processes and records what it finds.
/// Runs on its own thread; the cost is one process snapshot every few seconds.
fn poll_once() {
    let procs = snapshot_processes();
    if procs.is_empty() {
        return;
    }
    let now = now_ms();

    let ptys: Vec<(String, u32)> = {
        let reg = registry().lock().unwrap();
        reg.ptys.iter().map(|(k, v)| (k.clone(), *v)).collect()
    };

    let mut live: HashMap<String, String> = HashMap::new();

    for (pane_id, shell_pid) in ptys {
        let kids = descendants(&procs, shell_pid);
        let mut agents: Vec<(&'static str, u32)> = kids
            .iter()
            .filter_map(|p| harness_for_exe(&p.name).map(|h| (h, p.pid)))
            .collect();
        // An npm/bun install of Claude Code runs as `node.exe`, which
        // harness_for_exe deliberately won't claim on name alone. The per-PID
        // session file it publishes identifies it exactly, so use that as the
        // tiebreaker rather than widening the name match.
        if agents.is_empty() {
            for p in &kids {
                let stem = p.name.strip_suffix(".exe").unwrap_or(&p.name);
                if matches!(stem, "node" | "bun" | "deno")
                    && claude_session_for_pid(p.pid).is_some()
                {
                    agents.push(("claude-code", p.pid));
                    break;
                }
            }
        }
        // Recorded before the early-out below so a pane with no agent running
        // drops out of the map rather than keeping a stale harness.
        if let Some((harness, _)) = agents.first() {
            live.insert(pane_id.clone(), (*harness).to_string());
        }
        if agents.is_empty() {
            continue;
        }

        let mut reg = registry().lock().unwrap();
        let pane_cwd = reg.cwds.get(&pane_id).cloned();
        let entry = reg.links.panes.entry(pane_id).or_default();

        for (harness, pid) in agents {
            // Exact path: the harness tells us which session this PID owns.
            if harness == "claude-code" {
                if let Some((sid, cwd)) = claude_session_for_pid(pid) {
                    upsert_link(entry, harness, &sid, cwd.or_else(|| pane_cwd.clone()), now, true);
                    continue;
                }
            }
            // Inferred path: remember that this harness was alive here, and
            // for how long, so sessions can be matched by overlap later.
            match entry
                .windows
                .iter_mut()
                .find(|w| w.pid == pid && w.harness == harness)
            {
                Some(w) => w.end = now,
                None => entry.windows.push(ProcWindow {
                    harness: harness.to_string(),
                    pid,
                    start: now,
                    end: now,
                    cwd: pane_cwd.clone(),
                }),
            }
        }
        reg.dirty = true;
    }

    *live_harnesses().lock().unwrap() = live;

    save_links_if_dirty();
}

fn upsert_link(
    entry: &mut PaneLinks,
    harness: &str,
    session_id: &str,
    cwd: Option<String>,
    now: i64,
    exact: bool,
) {
    match entry
        .links
        .iter_mut()
        .find(|l| l.harness == harness && l.session_id == session_id)
    {
        Some(l) => {
            l.last_seen = now;
            l.exact |= exact;
            if l.cwd.is_none() {
                l.cwd = cwd;
            }
        }
        None => entry.links.push(SessionLink {
            harness: harness.to_string(),
            session_id: session_id.to_string(),
            cwd,
            first_seen: now,
            last_seen: now,
            exact,
        }),
    }
}

pub fn start_poller(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = DATA_DIR.set(dir);
    }
    load_links();
    thread::spawn(|| loop {
        poll_once();
        thread::sleep(Duration::from_secs(3));
    });
}

// ===================================================================
//  Aggregates
// ===================================================================

#[derive(Clone, Debug, Default, Serialize)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub reasoning: u64,
    pub total: u64,
}

impl Tokens {
    fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_write += o.cache_write;
        self.cache_read += o.cache_read;
        self.reasoning += o.reasoning;
        self.total += o.total;
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ModelUsage {
    pub model: String,
    pub harness: String,
    pub tokens: Tokens,
    pub cost_usd: f64,
    /// False when no rate is known for this model — tokens are still exact.
    pub priced: bool,
    pub messages: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SessionUsage {
    pub harness: String,
    pub session_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub models: Vec<String>,
    pub tokens: Tokens,
    pub cost_usd: f64,
    pub priced: bool,
    pub messages: u64,
    pub tool_calls: u64,
    pub web_searches: u64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub exact: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct DayUsage {
    pub day: String,
    pub cost_usd: f64,
    pub tokens: Tokens,
    pub messages: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ToolUsage {
    pub name: String,
    pub calls: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct LiveAgent {
    pub harness: String,
    pub pid: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct PaneUsage {
    pub pane_id: String,
    pub cost_usd: f64,
    /// True when every model seen had a known rate, so the total is complete.
    pub cost_complete: bool,
    pub tokens: Tokens,
    pub messages: u64,
    pub tool_calls: u64,
    pub web_searches: u64,
    pub session_count: u64,
    pub first_activity: Option<i64>,
    pub last_activity: Option<i64>,
    /// Summed wall-clock span of the attributed sessions, in ms.
    pub active_ms: i64,
    pub by_harness: Vec<ModelUsage>,
    pub by_model: Vec<ModelUsage>,
    pub by_day: Vec<DayUsage>,
    pub top_tools: Vec<ToolUsage>,
    pub sessions: Vec<SessionUsage>,
    pub unpriced_models: Vec<String>,
    pub live: Vec<LiveAgent>,
    pub generated_at: i64,
}

// ===================================================================
//  Adapter: Claude Code
// ===================================================================

/// Builds `session id → transcript path` by scanning the project folders.
/// Scanning beats reconstructing the folder's path-mangling scheme, which is an
/// implementation detail we'd rather not depend on.
fn claude_transcript_index() -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    let Some(root) = home_dir().map(|h| h.join(".claude").join("projects")) else {
        return map;
    };
    let Ok(dirs) = fs::read_dir(root) else {
        return map;
    };
    for dir in dirs.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else {
            continue;
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                map.insert(stem.to_string(), p);
            }
        }
    }
    map
}

struct ParsedSession {
    usage: SessionUsage,
    per_model: HashMap<String, ModelUsage>,
    per_day: HashMap<String, DayUsage>,
    tools: HashMap<String, u64>,
}

fn parse_claude_session(
    path: &Path,
    session_id: &str,
    prices: &HashMap<String, ModelPrice>,
    unpriced: &mut HashSet<String>,
) -> Option<ParsedSession> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut out = SessionUsage {
        harness: "claude-code".into(),
        session_id: session_id.to_string(),
        priced: true,
        ..Default::default()
    };
    let mut per_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut per_day: HashMap<String, DayUsage> = HashMap::new();
    let mut tools: HashMap<String, u64> = HashMap::new();
    let mut models_seen: Vec<String> = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");

        if ty == "ai-title" {
            if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                out.title = Some(t.to_string());
            }
            continue;
        }
        if ty != "assistant" {
            // Non-assistant records still carry the cwd/branch metadata and
            // bound the session's wall-clock span.
            if out.cwd.is_none() {
                if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                    out.cwd = Some(c.to_string());
                }
            }
            if out.git_branch.is_none() {
                if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
                    if !b.is_empty() {
                        out.git_branch = Some(b.to_string());
                    }
                }
            }
            if let Some(ms) = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms) {
                out.started_at = Some(out.started_at.map_or(ms, |s: i64| s.min(ms)));
                out.ended_at = Some(out.ended_at.map_or(ms, |e: i64| e.max(ms)));
            }
            continue;
        }

        let Some(msg) = v.get("message") else { continue };
        let model = msg
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        // Claude Code writes synthetic assistant turns (e.g. local errors) that
        // never hit the API — counting them would inflate the message count.
        if model == "<synthetic>" {
            continue;
        }

        let ts = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms);
        if let Some(ms) = ts {
            out.started_at = Some(out.started_at.map_or(ms, |s: i64| s.min(ms)));
            out.ended_at = Some(out.ended_at.map_or(ms, |e: i64| e.max(ms)));
        }
        if out.cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                out.cwd = Some(c.to_string());
            }
        }

        // ---- tokens ----
        let u = msg.get("usage");
        let g = |k: &str| -> u64 {
            u.and_then(|u| u.get(k)).and_then(Value::as_u64).unwrap_or(0)
        };
        let input = g("input_tokens");
        let output = g("output_tokens");
        let cache_read = g("cache_read_input_tokens");
        let cache_write_total = g("cache_creation_input_tokens");
        // The 5m/1h split matters: they bill at 1.25x and 2x input respectively.
        let (w5, w1h) = match u.and_then(|u| u.get("cache_creation")) {
            Some(c) => (
                c.get("ephemeral_5m_input_tokens").and_then(Value::as_u64).unwrap_or(0),
                c.get("ephemeral_1h_input_tokens").and_then(Value::as_u64).unwrap_or(0),
            ),
            None => (cache_write_total, 0),
        };

        let tok = Tokens {
            input,
            output,
            cache_write: cache_write_total.max(w5 + w1h),
            cache_read,
            reasoning: 0,
            total: input + output + cache_write_total.max(w5 + w1h) + cache_read,
        };

        // ---- cost ----
        let speed = u.and_then(|u| u.get("speed")).and_then(Value::as_str);
        let (cost, priced) = match price_for(prices, &model, speed) {
            Some(p) => {
                let per = |t: u64, rate: f64| (t as f64) * rate / 1_000_000.0;
                let c = per(input, p.input)
                    + per(output, p.output)
                    + per(w5, p.input * p.cache_write_5m_mult)
                    + per(w1h, p.input * p.cache_write_1h_mult)
                    + per(cache_read, p.input * p.cache_read_mult);
                (c, true)
            }
            None => {
                unpriced.insert(model.clone());
                (0.0, false)
            }
        };

        // ---- tool calls + server tools ----
        if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
            for b in blocks {
                if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                    out.tool_calls += 1;
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("(unnamed)");
                    *tools.entry(name.to_string()).or_insert(0) += 1;
                }
            }
        }
        if let Some(st) = u.and_then(|u| u.get("server_tool_use")) {
            out.web_searches += st.get("web_search_requests").and_then(Value::as_u64).unwrap_or(0);
            out.web_searches += st.get("web_fetch_requests").and_then(Value::as_u64).unwrap_or(0);
        }

        // ---- roll up ----
        out.messages += 1;
        out.cost_usd += cost;
        out.priced &= priced;
        out.tokens.add(&tok);
        if !models_seen.contains(&model) {
            models_seen.push(model.clone());
        }

        let m = per_model.entry(model.clone()).or_insert_with(|| ModelUsage {
            model: model.clone(),
            harness: "claude-code".into(),
            priced: true,
            ..Default::default()
        });
        m.tokens.add(&tok);
        m.cost_usd += cost;
        m.messages += 1;
        m.priced &= priced;

        if let Some(ms) = ts {
            let key = day_key(ms);
            let d = per_day.entry(key.clone()).or_insert_with(|| DayUsage {
                day: key,
                ..Default::default()
            });
            d.cost_usd += cost;
            d.messages += 1;
            d.tokens.add(&tok);
        }
    }

    out.models = models_seen;
    Some(ParsedSession {
        usage: out,
        per_model,
        per_day,
        tools,
    })
}

// ===================================================================
//  Adapter: OpenCode
// ===================================================================

/// Where OpenCode keeps its data. Recent versions moved the per-message JSON
/// files into a single SQLite database (`opencode.db`); the `storage/` tree is
/// left behind, frozen at the last pre-migration message. Both are read, the
/// database first, so old and new installs both report.
fn opencode_root() -> Option<PathBuf> {
    Some(home_dir()?.join(".local").join("share").join("opencode"))
}

fn opencode_db_path() -> Option<PathBuf> {
    let p = opencode_root()?.join("opencode.db");
    p.exists().then_some(p)
}

/// Read-only connection to the live database. `mode=ro` first so WAL commits
/// from a running OpenCode are visible; `immutable=1` is the fallback for when
/// the sidecar `-shm`/`-wal` files cannot be opened (no writer, read-only dir),
/// where the WAL tail is invisible but the checkpointed history still reads.
fn open_opencode_db() -> Option<rusqlite::Connection> {
    use rusqlite::{Connection, OpenFlags};
    let path = opencode_db_path()?;
    let uri = path.to_string_lossy().replace('\\', "/");
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
    Connection::open_with_flags(format!("file:{uri}?mode=ro"), flags)
        .or_else(|_| Connection::open_with_flags(format!("file:{uri}?immutable=1"), flags))
        .ok()
}

thread_local! {
    /// Opening a half-gigabyte database once per session would dominate a
    /// folder scan, and a cached read connection still sees later commits
    /// (each statement runs in its own read transaction), so nothing goes
    /// stale in exchange.
    static OPENCODE_DB: Option<rusqlite::Connection> = open_opencode_db();
}

fn with_opencode_db<T>(f: impl FnOnce(&rusqlite::Connection) -> T) -> Option<T> {
    OPENCODE_DB.with(|c| c.as_ref().map(f))
}

struct OcSession {
    id: String,
    directory: Option<String>,
    created: i64,
    updated: i64,
}

/// Every session in the database, newest first. Empty when there is no
/// database (pre-migration install) or it cannot be opened.
fn opencode_db_sessions() -> Vec<OcSession> {
    with_opencode_db(|c| {
        let Ok(mut stmt) = c.prepare(
            "select id, directory, time_created, time_updated \
             from session order by time_updated desc",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok(OcSession {
                id: r.get(0)?,
                directory: r.get::<_, Option<String>>(1)?,
                created: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                updated: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            })
        });
        match rows {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => Vec::new(),
        }
    })
    .unwrap_or_default()
}

/// Folds one assistant message. The database `data` column holds the same JSON
/// shape the old per-message files did, so both paths share this.
fn fold_opencode_message(
    v: &Value,
    out: &mut SessionUsage,
    per_model: &mut HashMap<String, ModelUsage>,
    per_day: &mut HashMap<String, DayUsage>,
    models_seen: &mut Vec<String>,
    unpriced: &mut HashSet<String>,
    prices: &HashMap<String, ModelPrice>,
) {
    if v.get("role").and_then(Value::as_str) != Some("assistant") {
        return;
    }

    let model = v
        .get("modelID")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let provider = v.get("providerID").and_then(Value::as_str).unwrap_or("");
    let label = if provider.is_empty() {
        model.clone()
    } else {
        format!("{provider}/{model}")
    };

    let t = v.get("tokens");
    let g = |k: &str| -> u64 { t.and_then(|t| t.get(k)).and_then(Value::as_u64).unwrap_or(0) };
    let cache = t.and_then(|t| t.get("cache"));
    let cg = |k: &str| -> u64 {
        cache
            .and_then(|c| c.get(k))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    let mut tok = Tokens {
        input: g("input"),
        output: g("output"),
        reasoning: g("reasoning"),
        cache_write: cg("write"),
        cache_read: cg("read"),
        total: g("total"),
    };
    // Newer records drop the pre-summed `total`.
    if tok.total == 0 {
        tok.total = tok.input + tok.output + tok.reasoning + tok.cache_write + tok.cache_read;
    }

    // OpenCode computes cost itself; trust it and fall back to our table
    // only when the field is missing.
    let (cost, priced) = match v.get("cost").and_then(Value::as_f64) {
        Some(c) => (c, true),
        None => match price_for(prices, &model, None) {
            Some(p) => (
                (tok.input as f64 * p.input + tok.output as f64 * p.output) / 1_000_000.0,
                true,
            ),
            None => {
                unpriced.insert(label.clone());
                (0.0, false)
            }
        },
    };

    if out.cwd.is_none() {
        if let Some(c) = v
            .get("path")
            .and_then(|p| p.get("cwd"))
            .and_then(Value::as_str)
        {
            out.cwd = Some(c.to_string());
        }
    }
    let ts = v
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(Value::as_i64);
    if let Some(ms) = ts {
        out.started_at = Some(out.started_at.map_or(ms, |s: i64| s.min(ms)));
        out.ended_at = Some(out.ended_at.map_or(ms, |e: i64| e.max(ms)));
    }

    out.messages += 1;
    out.cost_usd += cost;
    out.priced &= priced;
    out.tokens.add(&tok);
    if !models_seen.contains(&label) {
        models_seen.push(label.clone());
    }

    let m = per_model.entry(label.clone()).or_insert_with(|| ModelUsage {
        model: label.clone(),
        harness: "opencode".into(),
        priced: true,
        ..Default::default()
    });
    m.tokens.add(&tok);
    m.cost_usd += cost;
    m.messages += 1;
    m.priced &= priced;

    if let Some(ms) = ts {
        let key = day_key(ms);
        let d = per_day.entry(key.clone()).or_insert_with(|| DayUsage {
            day: key,
            ..Default::default()
        });
        d.cost_usd += cost;
        d.messages += 1;
        d.tokens.add(&tok);
    }
}

fn empty_opencode_session(session_id: &str) -> SessionUsage {
    SessionUsage {
        harness: "opencode".into(),
        session_id: session_id.to_string(),
        priced: true,
        ..Default::default()
    }
}

/// Usage for one session, read from the database.
fn parse_opencode_db_session(
    session_id: &str,
    unpriced: &mut HashSet<String>,
    prices: &HashMap<String, ModelPrice>,
) -> Option<ParsedSession> {
    let mut out = empty_opencode_session(session_id);
    let mut per_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut per_day: HashMap<String, DayUsage> = HashMap::new();
    let mut models_seen: Vec<String> = Vec::new();

    with_opencode_db(|c| {
        let Ok(mut stmt) =
            c.prepare("select data from message where session_id = ?1 order by time_created")
        else {
            return;
        };
        let Ok(rows) = stmt.query_map([session_id], |r| r.get::<_, String>(0)) else {
            return;
        };
        for data in rows.flatten() {
            let Ok(v) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            fold_opencode_message(
                &v,
                &mut out,
                &mut per_model,
                &mut per_day,
                &mut models_seen,
                unpriced,
                prices,
            );
        }
    })?;
    if out.messages == 0 {
        return None;
    }

    // The session row carries the directory and title even when the messages
    // do not — an aborted turn can be written without a `path`.
    with_opencode_db(|c| {
        let row = c.query_row(
            "select directory, title from session where id = ?1",
            [session_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            },
        );
        if let Ok((directory, title)) = row {
            if out.cwd.is_none() {
                out.cwd = directory;
            }
            out.title = title;
        }
    });

    out.models = models_seen;
    Some(ParsedSession {
        usage: out,
        per_model,
        per_day,
        tools: HashMap::new(),
    })
}

/// Usage for one session from the pre-migration store: one JSON file per
/// message under `storage/message/<session id>/`.
fn parse_opencode_files_session(
    session_id: &str,
    unpriced: &mut HashSet<String>,
    prices: &HashMap<String, ModelPrice>,
) -> Option<ParsedSession> {
    let dir = opencode_root()?
        .join("storage")
        .join("message")
        .join(session_id);
    let files = fs::read_dir(&dir).ok()?;

    let mut out = empty_opencode_session(session_id);
    let mut per_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut per_day: HashMap<String, DayUsage> = HashMap::new();
    let mut models_seen: Vec<String> = Vec::new();

    for f in files.flatten() {
        let Ok(s) = fs::read_to_string(f.path()) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&s) else {
            continue;
        };
        fold_opencode_message(
            &v,
            &mut out,
            &mut per_model,
            &mut per_day,
            &mut models_seen,
            unpriced,
            prices,
        );
    }

    if out.messages == 0 {
        return None;
    }
    out.models = models_seen;
    Some(ParsedSession {
        usage: out,
        per_model,
        per_day,
        tools: HashMap::new(),
    })
}

fn parse_opencode_session(
    session_id: &str,
    unpriced: &mut HashSet<String>,
    prices: &HashMap<String, ModelPrice>,
) -> Option<ParsedSession> {
    parse_opencode_db_session(session_id, unpriced, prices)
        .or_else(|| parse_opencode_files_session(session_id, unpriced, prices))
}

/// Session id → last-activity timestamp, for every session either store knows
/// about. Used both to enumerate sessions and to match them against the window
/// a pane's OpenCode process was alive.
fn opencode_session_activity() -> Vec<(String, i64)> {
    let mut out: Vec<(String, i64)> = opencode_db_sessions()
        .into_iter()
        .map(|s| (s.id, s.updated.max(s.created)))
        .collect();

    // Pre-migration sessions live on as message folders; their mtime is the
    // only activity stamp available without reading every file inside.
    if let Some(dir) = opencode_root().map(|r| r.join("storage").join("message")) {
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let Some(name) = e.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if out.iter().any(|(id, _)| *id == name) {
                continue;
            }
            out.push((name, mtime_ms(&e.path())));
        }
    }
    out
}

// ===================================================================
//  Adapter: Codex
// ===================================================================

/// One rollout file per Codex session, under `~/.codex/sessions/YYYY/MM/DD/`.
/// Returns `session id → (path, started_at)`.
fn codex_session_index() -> HashMap<String, (PathBuf, i64)> {
    let mut map = HashMap::new();
    let Some(root) = home_dir().map(|h| h.join(".codex").join("sessions")) else {
        return map;
    };
    // year / month / day nesting.
    for lvl1 in fs::read_dir(&root).into_iter().flatten().flatten() {
        for lvl2 in fs::read_dir(lvl1.path()).into_iter().flatten().flatten() {
            for lvl3 in fs::read_dir(lvl2.path()).into_iter().flatten().flatten() {
                for f in fs::read_dir(lvl3.path()).into_iter().flatten().flatten() {
                    let p = f.path();
                    if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    // rollout-2026-07-10T21-35-57-<uuid>
                    let Some(rest) = stem.strip_prefix("rollout-") else {
                        continue;
                    };
                    // The uuid is the last 5 dash-separated groups.
                    let parts: Vec<&str> = rest.split('-').collect();
                    if parts.len() < 5 {
                        continue;
                    }
                    let sid = parts[parts.len() - 5..].join("-");
                    let mtime = f
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    map.insert(sid, (p, mtime));
                }
            }
        }
    }
    map
}

/// Codex reports **cumulative** totals on every `token_count` event, so the
/// final event is the session total — summing them would multiply the real
/// figure by the number of turns.
fn parse_codex_session(
    path: &Path,
    session_id: &str,
    prices: &HashMap<String, ModelPrice>,
    unpriced: &mut HashSet<String>,
) -> Option<ParsedSession> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut out = SessionUsage {
        harness: "codex".into(),
        session_id: session_id.to_string(),
        priced: true,
        ..Default::default()
    };
    let mut model = String::from("unknown");
    let mut last_totals: Option<(u64, u64, u64, u64, u64)> = None; // in, cached, out, reasoning, total
    let mut turns: u64 = 0;
    let mut tools: HashMap<String, u64> = HashMap::new();
    let mut last_ts: Option<i64> = None;

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
        let ts = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms);
        if let Some(ms) = ts {
            out.started_at = Some(out.started_at.map_or(ms, |s: i64| s.min(ms)));
            out.ended_at = Some(out.ended_at.map_or(ms, |e: i64| e.max(ms)));
            last_ts = Some(ms);
        }
        let payload = v.get("payload");

        match ty {
            "session_meta" => {
                if let Some(c) = payload.and_then(|p| p.get("cwd")).and_then(Value::as_str) {
                    out.cwd = Some(c.to_string());
                }
            }
            "turn_context" => {
                if let Some(m) = payload.and_then(|p| p.get("model")).and_then(Value::as_str) {
                    model = m.to_string();
                }
                if out.cwd.is_none() {
                    if let Some(c) = payload.and_then(|p| p.get("cwd")).and_then(Value::as_str) {
                        out.cwd = Some(c.to_string());
                    }
                }
                turns += 1;
            }
            "event_msg" => {
                let pty = payload.and_then(|p| p.get("type")).and_then(Value::as_str);
                if pty == Some("token_count") {
                    if let Some(info) = payload.and_then(|p| p.get("info")) {
                        if let Some(t) = info.get("total_token_usage") {
                            let g = |k: &str| t.get(k).and_then(Value::as_u64).unwrap_or(0);
                            last_totals = Some((
                                g("input_tokens"),
                                g("cached_input_tokens"),
                                g("output_tokens"),
                                g("reasoning_output_tokens"),
                                g("total_tokens"),
                            ));
                        }
                    }
                }
            }
            "response_item"
                if payload.and_then(|p| p.get("type")).and_then(Value::as_str)
                    == Some("function_call")
                => {
                    out.tool_calls += 1;
                    let name = payload
                        .and_then(|p| p.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("(unnamed)");
                    *tools.entry(name.to_string()).or_insert(0) += 1;
                }
            _ => {}
        }
    }

    let (input_total, cached, output, reasoning, total) = last_totals?;
    // `input_tokens` here is inclusive of the cached portion; split them so the
    // cache read is visible and isn't billed at the full input rate.
    let fresh_input = input_total.saturating_sub(cached);
    let tok = Tokens {
        input: fresh_input,
        output,
        cache_write: 0,
        cache_read: cached,
        reasoning,
        total: if total > 0 { total } else { input_total + output },
    };

    let (cost, priced) = match price_for(prices, &model, None) {
        Some(p) => {
            let per = |t: u64, rate: f64| (t as f64) * rate / 1_000_000.0;
            (
                per(fresh_input, p.input)
                    + per(output, p.output)
                    + per(cached, p.input * p.cache_read_mult),
                true,
            )
        }
        None => {
            unpriced.insert(model.clone());
            (0.0, false)
        }
    };

    out.messages = turns.max(1);
    out.cost_usd = cost;
    out.priced = priced;
    out.tokens = tok.clone();
    out.models = vec![model.clone()];

    let mut per_model = HashMap::new();
    per_model.insert(
        model.clone(),
        ModelUsage {
            model: model.clone(),
            harness: "codex".into(),
            tokens: tok.clone(),
            cost_usd: cost,
            priced,
            messages: out.messages,
        },
    );

    let mut per_day = HashMap::new();
    if let Some(ms) = last_ts.or(out.started_at) {
        let key = day_key(ms);
        per_day.insert(
            key.clone(),
            DayUsage {
                day: key,
                cost_usd: cost,
                tokens: tok,
                messages: out.messages,
            },
        );
    }

    Some(ParsedSession {
        usage: out,
        per_model,
        per_day,
        tools,
    })
}

// ===================================================================
//  Window matching for harnesses without a PID registry
// ===================================================================

/// Claims OpenCode / Codex sessions for a pane by overlapping their activity
/// with the windows during which one of their processes was alive under it.
fn resolve_inferred_links(pane: &PaneLinks) -> Vec<SessionLink> {
    // A little slack on both ends: the process is alive slightly before its
    // first message and after its last.
    const SLACK_MS: i64 = 60_000;
    let mut out = Vec::new();

    for w in &pane.windows {
        let (lo, hi) = (w.start - SLACK_MS, w.end + SLACK_MS);

        if w.harness == "codex" {
            for (sid, (_, mtime)) in codex_session_index() {
                if mtime >= lo && mtime <= hi {
                    out.push(SessionLink {
                        harness: "codex".into(),
                        session_id: sid,
                        cwd: w.cwd.clone(),
                        first_seen: w.start,
                        last_seen: w.end,
                        exact: false,
                    });
                }
            }
        } else if w.harness == "opencode" {
            for (sid, activity) in opencode_session_activity() {
                if activity >= lo && activity <= hi {
                    out.push(SessionLink {
                        harness: "opencode".into(),
                        session_id: sid,
                        cwd: w.cwd.clone(),
                        first_seen: w.start,
                        last_seen: w.end,
                        exact: false,
                    });
                }
            }
        }
    }
    out
}

// ===================================================================
//  Aggregation + command
// ===================================================================

/// Folds a batch of already-parsed sessions (from any harness) into one
/// report. Shared by the pane view (sessions linked to a live pid) and the
/// whole-folder view (sessions matched by recorded cwd instead).
fn aggregate_sessions(parsed_list: Vec<ParsedSession>) -> PaneUsage {
    let mut out = PaneUsage {
        cost_complete: true,
        generated_at: now_ms(),
        ..Default::default()
    };
    let mut per_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut per_harness: HashMap<String, ModelUsage> = HashMap::new();
    let mut per_day: HashMap<String, DayUsage> = HashMap::new();
    let mut tools: HashMap<String, u64> = HashMap::new();

    for parsed in parsed_list {
        out.cost_usd += parsed.usage.cost_usd;
        out.cost_complete &= parsed.usage.priced;
        out.tokens.add(&parsed.usage.tokens);
        out.messages += parsed.usage.messages;
        out.tool_calls += parsed.usage.tool_calls;
        out.web_searches += parsed.usage.web_searches;
        out.session_count += 1;
        if let Some(s) = parsed.usage.started_at {
            out.first_activity = Some(out.first_activity.map_or(s, |x: i64| x.min(s)));
        }
        if let Some(e) = parsed.usage.ended_at {
            out.last_activity = Some(out.last_activity.map_or(e, |x: i64| x.max(e)));
        }
        if let (Some(s), Some(e)) = (parsed.usage.started_at, parsed.usage.ended_at) {
            out.active_ms += (e - s).max(0);
        }

        for (k, v) in parsed.per_model {
            let m = per_model.entry(k.clone()).or_insert_with(|| ModelUsage {
                model: k,
                harness: v.harness.clone(),
                priced: true,
                ..Default::default()
            });
            m.tokens.add(&v.tokens);
            m.cost_usd += v.cost_usd;
            m.messages += v.messages;
            m.priced &= v.priced;
        }
        {
            let harness = parsed.usage.harness.clone();
            let h = per_harness.entry(harness.clone()).or_insert_with(|| ModelUsage {
                model: harness_label(&harness).to_string(),
                harness: harness.clone(),
                priced: true,
                ..Default::default()
            });
            h.tokens.add(&parsed.usage.tokens);
            h.cost_usd += parsed.usage.cost_usd;
            h.messages += parsed.usage.messages;
            h.priced &= parsed.usage.priced;
        }
        for (k, v) in parsed.per_day {
            let d = per_day.entry(k.clone()).or_insert_with(|| DayUsage {
                day: k,
                ..Default::default()
            });
            d.cost_usd += v.cost_usd;
            d.messages += v.messages;
            d.tokens.add(&v.tokens);
        }
        for (k, v) in parsed.tools {
            *tools.entry(k).or_insert(0) += v;
        }

        out.sessions.push(parsed.usage);
    }

    // Most recent session first — that's what the user just ran.
    out.sessions.sort_by(|a, b| {
        b.ended_at
            .unwrap_or(0)
            .cmp(&a.ended_at.unwrap_or(0))
    });

    let mut by_model: Vec<ModelUsage> = per_model.into_values().collect();
    by_model.sort_by_key(|m| Reverse(m.tokens.total));
    out.by_model = by_model;

    let mut by_harness: Vec<ModelUsage> = per_harness.into_values().collect();
    by_harness.sort_by_key(|m| Reverse(m.tokens.total));
    out.by_harness = by_harness;

    let mut by_day: Vec<DayUsage> = per_day.into_values().collect();
    by_day.sort_by(|a, b| a.day.cmp(&b.day));
    out.by_day = by_day;

    let mut top: Vec<ToolUsage> = tools
        .into_iter()
        .map(|(name, calls)| ToolUsage { name, calls })
        .collect();
    top.sort_by_key(|t| Reverse(t.calls));
    top.truncate(12);
    out.top_tools = top;

    out
}

fn build_pane_usage(pane_id: &str) -> PaneUsage {
    let prices = load_pricing();
    let mut unpriced: HashSet<String> = HashSet::new();

    let (pane_links, live_pid) = {
        let reg = registry().lock().unwrap();
        (
            reg.links.panes.get(pane_id).cloned().unwrap_or_default(),
            reg.ptys.get(pane_id).copied(),
        )
    };

    // Exact links first, then anything the alive-window matcher can claim, with
    // exact links winning on conflict.
    let mut all: Vec<SessionLink> = pane_links.links.clone();
    for l in resolve_inferred_links(&pane_links) {
        if !all
            .iter()
            .any(|e| e.harness == l.harness && e.session_id == l.session_id)
        {
            all.push(l);
        }
    }

    let claude_index = claude_transcript_index();
    let codex_index = codex_session_index();

    let mut parsed_list: Vec<ParsedSession> = Vec::new();
    for link in &all {
        let parsed = match link.harness.as_str() {
            "claude-code" => claude_index
                .get(&link.session_id)
                .and_then(|p| parse_claude_session(p, &link.session_id, &prices, &mut unpriced)),
            "opencode" => parse_opencode_session(&link.session_id, &mut unpriced, &prices),
            "codex" => codex_index
                .get(&link.session_id)
                .and_then(|(p, _)| parse_codex_session(p, &link.session_id, &prices, &mut unpriced)),
            _ => None,
        };
        let Some(mut parsed) = parsed else { continue };
        parsed.usage.exact = link.exact;
        if parsed.usage.cwd.is_none() {
            parsed.usage.cwd = link.cwd.clone();
        }
        parsed_list.push(parsed);
    }

    let mut out = aggregate_sessions(parsed_list);
    out.pane_id = pane_id.to_string();

    let mut un: Vec<String> = unpriced.into_iter().collect();
    un.sort();
    out.unpriced_models = un;

    // Which agents are running in this pane right now.
    if let Some(pid) = live_pid {
        let procs = snapshot_processes();
        out.live = descendants(&procs, pid)
            .into_iter()
            .filter_map(|p| {
                harness_for_exe(&p.name).map(|h| LiveAgent {
                    harness: h.to_string(),
                    pid: p.pid,
                })
            })
            .collect();
    }

    out
}

/// Lists every OpenCode session id, from the database and from any
/// pre-migration message folders left beside it.
fn opencode_session_ids() -> Vec<String> {
    opencode_session_activity()
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

/// Path comparison for cwd matching: separators and case vary (Windows is
/// case-insensitive), a trailing slash doesn't change the folder.
fn normalize_cwd(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Cheap pre-filter for the folder view: does this transcript mention the
/// target cwd anywhere? Fully parsing a session costs a `serde_json` parse per
/// record, and over every transcript on the machine that is hundreds of
/// megabytes of JSON, while the folder view throws away every session whose
/// cwd doesn't match. A raw substring scan is orders of magnitude cheaper and
/// strictly wider than the cwd test that follows, so nothing that would have
/// been kept is dropped here.
fn mentions_cwd(path: &Path, target: &str) -> bool {
    const KEY_STR: &str = "\"cwd\":\"";
    const KEY: &[u8] = KEY_STR.as_bytes();
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    let mut line: Vec<u8> = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return false,
            Ok(_) => {}
        }
        // `str::find` is a Two-Way search; scanning 7-byte windows by hand over
        // hundreds of megabytes is several times slower. Records are valid
        // UTF-8 in practice, so the byte fallback is only a safety net.
        let text = std::str::from_utf8(&line);
        let mut from = 0;
        while let Some(i) = match text {
            Ok(t) if t.is_char_boundary(from) => t[from..].find(KEY_STR),
            _ => find_bytes(&line[from..], KEY),
        } {
            let start = from + i + KEY.len();
            let mut val = String::new();
            let mut j = start;
            while j < line.len() {
                match line[j] {
                    // JSON escape: Windows paths arrive as `C:\\Users\\...`.
                    b'\\' => {
                        if j + 1 < line.len() {
                            val.push(line[j + 1] as char);
                        }
                        j += 2;
                    }
                    b'"' => break,
                    c => {
                        val.push(c as char);
                        j += 1;
                    }
                }
            }
            if normalize_cwd(&val) == target {
                return true;
            }
            from = start;
        }
    }
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Usage for every session — from any pane, any window, ever — recorded
/// against a given working directory. Unlike [`build_pane_usage`], this
/// isn't limited to sessions this app watched live; it scans every local
/// harness transcript on the machine and keeps the ones whose cwd matches.
fn build_folder_usage(cwd: &str) -> PaneUsage {
    let prices = load_pricing();
    let mut unpriced: HashSet<String> = HashSet::new();
    let target = normalize_cwd(cwd);

    let mut parsed_list: Vec<ParsedSession> = Vec::new();

    for (session_id, path) in claude_transcript_index() {
        if !mentions_cwd(&path, &target) {
            continue;
        }
        let Some(parsed) = parse_claude_session(&path, &session_id, &prices, &mut unpriced) else {
            continue;
        };
        if parsed.usage.cwd.as_deref().map(normalize_cwd).as_deref() == Some(target.as_str()) {
            parsed_list.push(parsed);
        }
    }
    for (session_id, (path, _)) in codex_session_index() {
        if !mentions_cwd(&path, &target) {
            continue;
        }
        let Some(parsed) = parse_codex_session(&path, &session_id, &prices, &mut unpriced) else {
            continue;
        };
        if parsed.usage.cwd.as_deref().map(normalize_cwd).as_deref() == Some(target.as_str()) {
            parsed_list.push(parsed);
        }
    }
    let oc_dirs: HashMap<String, Option<String>> = opencode_db_sessions()
        .into_iter()
        .map(|s| (s.id, s.directory))
        .collect();
    for session_id in opencode_session_ids() {
        if let Some(dir) = oc_dirs.get(&session_id) {
            if dir.as_deref().map(normalize_cwd).as_deref() != Some(target.as_str()) {
                continue;
            }
        }
        let Some(parsed) = parse_opencode_session(&session_id, &mut unpriced, &prices) else {
            continue;
        };
        if parsed.usage.cwd.as_deref().map(normalize_cwd).as_deref() == Some(target.as_str()) {
            parsed_list.push(parsed);
        }
    }

    for p in &mut parsed_list {
        p.usage.exact = true;
    }

    let mut out = aggregate_sessions(parsed_list);
    out.pane_id = String::new();

    let mut un: Vec<String> = unpriced.into_iter().collect();
    un.sort();
    out.unpriced_models = un;

    out
}

#[tauri::command(async)]
pub fn folder_usage(cwd: String) -> Result<PaneUsage, String> {
    poll_once();
    Ok(build_folder_usage(&cwd))
}

#[tauri::command(async)]
pub fn pane_usage(pane_id: String) -> Result<PaneUsage, String> {
    // Fold in anything happening right now so a session that started seconds
    // ago is already attributed when the panel opens.
    poll_once();
    Ok(build_pane_usage(&pane_id))
}

// ===================================================================
//  Resuming a pane's own conversation
// ===================================================================

/// A stored conversation, seen from the "could this pane reopen it?" angle.
/// `created` is what makes the match tight: a session is *born* when its agent
/// process starts, so it lands inside that process's alive window — whereas
/// `updated` alone also matches every unrelated session merely touched while
/// the pane happened to be running something.
#[derive(Clone, Debug)]
struct ResumeCandidate {
    session_id: String,
    created: i64,
    updated: i64,
    cwd: Option<String>,
}

fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Codex rollouts open with a `session_meta` line carrying the session id, the
/// start timestamp and the cwd. The filename also encodes a timestamp, but in
/// *local* time — the header is unambiguous, so we read that instead.
fn codex_resume_candidates() -> Vec<ResumeCandidate> {
    let mut out = Vec::new();
    for (sid, (path, mtime)) in codex_session_index() {
        let Ok(file) = fs::File::open(&path) else { continue };
        let mut first = String::new();
        if BufReader::new(file).read_line(&mut first).is_err() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&first) else {
            continue;
        };
        let payload = v.get("payload").unwrap_or(&v);
        let created = payload
            .get("timestamp")
            .or_else(|| v.get("timestamp"))
            .and_then(|t| t.as_str())
            .and_then(parse_iso_ms)
            .unwrap_or(mtime);
        out.push(ResumeCandidate {
            session_id: sid,
            created,
            updated: mtime,
            cwd: payload
                .get("cwd")
                .and_then(|c| c.as_str())
                .map(str::to_string),
        });
    }
    out
}

/// Resume candidates come from the database `session` table, which records a
/// directory and both timestamps per session. Pre-migration installs are read
/// from `storage/session/<project-hash>/<id>.json`, which held the same fields.
fn opencode_resume_candidates() -> Vec<ResumeCandidate> {
    let mut out: Vec<ResumeCandidate> = opencode_db_sessions()
        .into_iter()
        .map(|s| ResumeCandidate {
            session_id: s.id,
            created: s.created,
            updated: s.updated.max(s.created),
            cwd: s.directory,
        })
        .collect();

    let Some(root) = opencode_root().map(|r| r.join("storage").join("session")) else {
        return out;
    };
    for proj in fs::read_dir(&root).into_iter().flatten().flatten() {
        for f in fs::read_dir(proj.path()).into_iter().flatten().flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(s) = fs::read_to_string(&path) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&s) else {
                continue;
            };
            let Some(sid) = v.get("id").and_then(|i| i.as_str()) else {
                continue;
            };
            if out.iter().any(|c| c.session_id == sid) {
                continue;
            }
            let time = v.get("time");
            let created = time
                .and_then(|t| t.get("created"))
                .and_then(|t| t.as_i64())
                .unwrap_or(0);
            out.push(ResumeCandidate {
                session_id: sid.to_string(),
                created,
                updated: time
                    .and_then(|t| t.get("updated"))
                    .and_then(|t| t.as_i64())
                    .unwrap_or_else(|| mtime_ms(&path)),
                cwd: v
                    .get("directory")
                    .and_then(|d| d.as_str())
                    .map(str::to_string),
            });
        }
    }
    out
}

/// Picks the conversation a pane should reopen for a harness with no PID→session
/// registry. Sessions *started* while one of the pane's agent processes was
/// alive are preferred; a session merely active during that window is the weaker
/// fallback. Within each tier, a cwd matching the pane's wins, then recency.
fn infer_resume_session(pane: &PaneLinks, harness: &str) -> Option<SessionLink> {
    let candidates = match harness {
        "codex" => codex_resume_candidates(),
        "opencode" => opencode_resume_candidates(),
        _ => return None,
    };
    pick_resume(pane, harness, &candidates)
}

fn pick_resume(pane: &PaneLinks, harness: &str, candidates: &[ResumeCandidate]) -> Option<SessionLink> {
    const SLACK_MS: i64 = 60_000;

    let mut best: Option<(u8, bool, i64, &ResumeCandidate, &ProcWindow)> = None;
    for w in pane.windows.iter().filter(|w| w.harness == harness) {
        let (lo, hi) = (w.start - SLACK_MS, w.end + SLACK_MS);
        let want = w.cwd.as_deref().map(normalize_cwd);
        for c in candidates {
            let born_here = c.created >= lo && c.created <= hi;
            let active_here = c.updated >= lo && c.updated <= hi;
            if !born_here && !active_here {
                continue;
            }
            let tier = if born_here { 1 } else { 0 };
            let cwd_match = match (&want, &c.cwd) {
                (Some(a), Some(b)) => normalize_cwd(b) == *a,
                _ => false,
            };
            let key = (tier, cwd_match, c.updated);
            if best.is_none_or(|(t, m, u, _, _)| (t, m, u) < key) {
                best = Some((tier, cwd_match, c.updated, c, w));
            }
        }
    }

    best.map(|(_, _, _, c, w)| SessionLink {
        harness: harness.to_string(),
        session_id: c.session_id.clone(),
        cwd: c.cwd.clone().or_else(|| w.cwd.clone()),
        first_seen: c.created,
        last_seen: c.updated,
        exact: false,
    })
}

/// The concrete agent conversation a pane was last attached to, so restarting
/// the app can resume *that* session instead of whatever `--continue` picks.
#[derive(Clone, Debug, Serialize)]
pub struct PaneSession {
    pub harness: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub exact: bool,
    #[serde(rename = "lastSeen")]
    pub last_seen: i64,
    pub cwd: Option<String>,
}

/// Most recently active session this pane owned for `harness`. An exact link
/// (Claude Code, via its PID registry) is used when there is one; otherwise the
/// session is inferred from the pane's process windows and the harness's own
/// session files.
#[tauri::command(async)]
pub fn pane_last_session(pane_id: String, harness: String) -> Result<Option<PaneSession>, String> {
    let pane = {
        let reg = registry().lock().unwrap();
        reg.links.panes.get(&pane_id).cloned()
    };
    let Some(pane) = pane else { return Ok(None) };

    let exact = pane
        .links
        .iter()
        .filter(|l| l.harness == harness && l.exact)
        .max_by_key(|l| l.last_seen)
        .cloned();

    Ok(exact
        .or_else(|| infer_resume_session(&pane, &harness))
        .map(|l| PaneSession {
            harness: l.harness,
            session_id: l.session_id,
            exact: l.exact,
            last_seen: l.last_seen,
            cwd: l.cwd,
        }))
}

#[tauri::command]
pub fn usage_pricing_path() -> Result<String, String> {
    pricing_path()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "no data directory".to_string())
}

#[tauri::command(async)]
pub fn forget_pane_usage(pane_id: String) -> Result<(), String> {
    forget_pane(&pane_id);
    save_links_if_dirty();
    Ok(())
}

// ===================================================================
//  Rate-limit indicator (Claude Code / Codex)
// ===================================================================
//
// Unlike the cost/token accounting above, "how much of my rate limit is
// left" is an *account* fact, and neither harness keeps a dependable copy
// of it on disk:
//
//   * Codex used to write a `rate_limits` snapshot into its session rollout
//     log after every turn, and this module used to read the newest one.
//     From 0.152 the TUI keeps its threads in SQLite and pulls the numbers
//     from the account endpoint instead, so no fresh rollout is written at
//     all — scraping the newest file on disk reported whatever plan the
//     account was on weeks ago (a "30-day window" left over from an older
//     snapshot) instead of today's 5-hour/weekly split. We now call the same
//     backend the CLI calls, with the token Codex itself keeps refreshed.
//   * Claude Code doesn't persist this anywhere locally; the only source is
//     the same undocumented OAuth endpoint the CLI itself polls for its
//     `/usage` display. That endpoint rate-limits aggressively, so results
//     are cached and never re-fetched inside `CLAUDE_USAGE_CACHE_MS`.

#[derive(Clone, Debug, Default, Serialize)]
pub struct UsageWindow {
    pub used_percent: f64,
    /// Epoch ms.
    pub resets_at: Option<i64>,
    pub window_minutes: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct UsageLimit {
    pub harness: String,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub available: bool,
    pub error: Option<String>,
    pub fetched_at: i64,
}

// ---- Codex ----

#[derive(Deserialize)]
struct CodexAuthFile {
    tokens: Option<CodexTokens>,
}

#[derive(Deserialize)]
struct CodexTokens {
    access_token: String,
    account_id: Option<String>,
}

/// `exp` (seconds) out of a JWT's payload, without verifying anything — the
/// token is the CLI's to validate; all we want is to avoid firing a request
/// we already know will 401.
fn jwt_expiry_ms(token: &str) -> Option<i64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    v.get("exp").and_then(Value::as_i64).map(|s| s * 1000)
}

/// Reads the ChatGPT token Codex keeps refreshed in `~/.codex/auth.json`.
/// Like the Claude side, an expired token is reported rather than refreshed:
/// re-implementing OAuth rotation and writing back to the CLI's own
/// credentials file isn't worth risking the user's login over a percentage.
fn read_codex_auth() -> Result<(String, Option<String>), String> {
    let path = home_dir()
        .ok_or_else(|| "no home directory".to_string())?
        .join(".codex")
        .join("auth.json");
    let s = fs::read_to_string(&path).map_err(|_| "not signed in to Codex".to_string())?;
    let auth: CodexAuthFile = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    let tokens = auth
        .tokens
        .ok_or_else(|| "no Codex ChatGPT session — run `codex login`".to_string())?;
    if let Some(exp) = jwt_expiry_ms(&tokens.access_token) {
        if exp <= now_ms() {
            return Err("Codex session expired — open Codex to refresh it".into());
        }
    }
    Ok((tokens.access_token, tokens.account_id))
}

/// Backend window shape: `{used_percent, limit_window_seconds, reset_at}`,
/// where `reset_at` is Unix *seconds* (everything else in this module is ms).
fn codex_account_window(v: &Value) -> Option<UsageWindow> {
    Some(UsageWindow {
        used_percent: v.get("used_percent").and_then(Value::as_f64)?,
        resets_at: v.get("reset_at").and_then(Value::as_i64).map(|s| s * 1000),
        window_minutes: v
            .get("limit_window_seconds")
            .and_then(Value::as_i64)
            .map(|s| s / 60),
    })
}

/// Short enough that the pill (30s poll) tracks a turn's spend within a
/// minute, long enough that several Codex panes share one request.
const CODEX_USAGE_CACHE_MS: i64 = 45_000;

fn codex_usage_cache() -> &'static Mutex<Option<UsageLimit>> {
    static CACHE: OnceLock<Mutex<Option<UsageLimit>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn codex_usage_error(msg: String, now: i64) -> UsageLimit {
    UsageLimit {
        harness: "codex".into(),
        error: Some(msg),
        fetched_at: now,
        ..Default::default()
    }
}

#[tauri::command]
pub async fn codex_usage_limit() -> Result<UsageLimit, String> {
    let now = now_ms();
    let cached = codex_usage_cache().lock().unwrap().clone();
    if let Some(c) = &cached {
        if now - c.fetched_at < CODEX_USAGE_CACHE_MS {
            return Ok(c.clone());
        }
    }

    let (token, account_id) = match read_codex_auth() {
        Ok(v) => v,
        Err(e) => return Ok(cached.unwrap_or_else(|| codex_usage_error(e, now))),
    };

    let client = match reqwest::Client::builder().timeout(Duration::from_secs(10)).build() {
        Ok(c) => c,
        Err(e) => return Err(e.to_string()),
    };

    let mut req = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(&token)
        .header("User-Agent", "codex_cli_rs/0.152.1")
        .header("Accept", "application/json");
    // Workspace accounts scope their limits per account; personal ones ignore it.
    if let Some(id) = account_id.filter(|s| !s.is_empty()) {
        req = req.header("ChatGPT-Account-Id", id);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(cached.unwrap_or_else(|| codex_usage_error(format!("request failed: {e}"), now)))
        }
    };

    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = if status.as_u16() == 401 {
            "Codex session rejected — open Codex to refresh it".to_string()
        } else {
            format!("Codex usage API returned {}", status.as_u16())
        };
        return Ok(cached.unwrap_or_else(|| codex_usage_error(msg, now)));
    }

    let Some(rl) = v.get("rate_limit").filter(|r| !r.is_null()) else {
        return Ok(cached.unwrap_or_else(|| codex_usage_error("no rate-limit data for this account".into(), now)));
    };

    let out = UsageLimit {
        harness: "codex".into(),
        primary: rl.get("primary_window").and_then(codex_account_window),
        secondary: rl.get("secondary_window").and_then(codex_account_window),
        available: true,
        error: None,
        fetched_at: now,
    };
    *codex_usage_cache().lock().unwrap() = Some(out.clone());
    Ok(out)
}

// ---- Claude Code ----

#[derive(Deserialize)]
struct ClaudeCredsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<ClaudeOauth>,
}

#[derive(Deserialize)]
struct ClaudeOauth {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
}

/// Reads the access token Claude Code itself keeps refreshed while it's
/// running. Refreshing an expired token here would mean re-implementing its
/// OAuth rotation and writing back to its credentials file — not worth the
/// risk of corrupting the user's login over a usage number, so an expired
/// token is just reported as such.
fn read_claude_access_token() -> Result<String, String> {
    let path = home_dir()
        .ok_or_else(|| "no home directory".to_string())?
        .join(".claude")
        .join(".credentials.json");
    let s = fs::read_to_string(&path).map_err(|_| "not signed in to Claude Code".to_string())?;
    let creds: ClaudeCredsFile = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    let oauth = creds
        .claude_ai_oauth
        .ok_or_else(|| "no Claude Code OAuth session".to_string())?;
    if let Some(exp) = oauth.expires_at {
        if exp <= now_ms() {
            return Err("Claude Code session expired — open Claude Code to refresh it".into());
        }
    }
    Ok(oauth.access_token)
}

fn claude_usage_window(v: &Value) -> Option<UsageWindow> {
    Some(UsageWindow {
        used_percent: v.get("utilization").and_then(Value::as_f64)?,
        resets_at: v.get("resets_at").and_then(Value::as_str).and_then(parse_iso_ms),
        window_minutes: None,
    })
}

const CLAUDE_USAGE_CACHE_MS: i64 = 180_000;

fn claude_usage_cache() -> &'static Mutex<Option<UsageLimit>> {
    static CACHE: OnceLock<Mutex<Option<UsageLimit>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn claude_usage_limit() -> Result<UsageLimit, String> {
    let now = now_ms();
    if let Some(cached) = claude_usage_cache().lock().unwrap().clone() {
        if now - cached.fetched_at < CLAUDE_USAGE_CACHE_MS {
            return Ok(cached);
        }
    }

    let token = match read_claude_access_token() {
        Ok(t) => t,
        Err(e) => {
            if let Some(cached) = claude_usage_cache().lock().unwrap().clone() {
                return Ok(cached);
            }
            return Ok(UsageLimit {
                harness: "claude-code".into(),
                error: Some(e),
                fetched_at: now,
                ..Default::default()
            });
        }
    };

    let client = match reqwest::Client::builder().timeout(Duration::from_secs(10)).build() {
        Ok(c) => c,
        Err(e) => return Err(e.to_string()),
    };

    let sent = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.1.220")
        .send()
        .await;

    let resp = match sent {
        Ok(r) => r,
        Err(e) => {
            if let Some(cached) = claude_usage_cache().lock().unwrap().clone() {
                return Ok(cached);
            }
            return Ok(UsageLimit {
                harness: "claude-code".into(),
                error: Some(format!("request failed: {e}")),
                fetched_at: now,
                ..Default::default()
            });
        }
    };

    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        if let Some(cached) = claude_usage_cache().lock().unwrap().clone() {
            return Ok(cached);
        }
        return Ok(UsageLimit {
            harness: "claude-code".into(),
            error: Some(format!("Anthropic usage API returned {}", status.as_u16())),
            fetched_at: now,
            ..Default::default()
        });
    }

    let out = UsageLimit {
        harness: "claude-code".into(),
        primary: v.get("five_hour").and_then(claude_usage_window),
        secondary: v.get("seven_day").and_then(claude_usage_window),
        available: true,
        error: None,
        fetched_at: now,
    };
    *claude_usage_cache().lock().unwrap() = Some(out.clone());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, created: i64, updated: i64, cwd: &str) -> ResumeCandidate {
        ResumeCandidate {
            session_id: id.into(),
            created,
            updated,
            cwd: Some(cwd.into()),
        }
    }

    fn pane_with_window(harness: &str, start: i64, end: i64, cwd: &str) -> PaneLinks {
        PaneLinks {
            links: vec![],
            windows: vec![ProcWindow {
                harness: harness.into(),
                pid: 1,
                start,
                end,
                cwd: Some(cwd.into()),
            }],
        }
    }

    #[test]
    fn resume_prefers_session_born_in_the_panes_window() {
        let pane = pane_with_window("opencode", 10_000_000, 10_600_000, "C:/work/app");
        let candidates = vec![
            // Started long ago but touched during the window — weaker match, and
            // more recently updated, so it must not win on recency alone.
            cand("ses_old", 1_000_000, 10_500_000, "C:/work/app"),
            // Born right after the pane's process started: this is the one.
            cand("ses_mine", 10_010_000, 10_400_000, "C:/work/app"),
        ];
        let got = pick_resume(&pane, "opencode", &candidates).expect("a match");
        assert_eq!(got.session_id, "ses_mine");
        assert!(!got.exact);
    }

    #[test]
    fn resume_prefers_the_panes_own_directory() {
        let pane = pane_with_window("opencode", 10_000_000, 10_600_000, "C:\\work\\app");
        let candidates = vec![
            // Another pane's session, born in the same window, updated later.
            cand("ses_other", 10_020_000, 10_500_000, "C:/work/other"),
            // Same folder as this pane — separators and case differ on purpose.
            cand("ses_mine", 10_010_000, 10_300_000, "c:/WORK/app/"),
        ];
        let got = pick_resume(&pane, "opencode", &candidates).expect("a match");
        assert_eq!(got.session_id, "ses_mine");
    }

    #[test]
    fn resume_ignores_sessions_outside_every_window() {
        let pane = pane_with_window("codex", 10_000_000, 10_600_000, "C:/work/app");
        let candidates = vec![cand("far-away", 500_000, 900_000, "C:/work/app")];
        assert!(pick_resume(&pane, "codex", &candidates).is_none());
        // A window for a different harness must not claim these either.
        assert!(pick_resume(&pane, "opencode", &[cand("x", 10_010_000, 10_020_000, "C:/work/app")])
            .is_none());
    }

    #[test]
    fn iso_parsing_round_trips() {
        // 2026-07-27T12:03:02.836Z
        let ms = parse_iso_ms("2026-07-27T12:03:02.836Z").expect("parses");
        assert_eq!(day_key(ms), "2026-07-27");
        // Fractionless form must parse too — Codex writes both shapes.
        let ms2 = parse_iso_ms("2026-07-27T12:03:02Z").expect("parses");
        assert_eq!(ms - ms2, 836);
        assert!(parse_iso_ms("not a date").is_none());
    }

    #[test]
    fn day_key_handles_epoch_and_leap_years() {
        assert_eq!(day_key(0), "1970-01-01");
        assert_eq!(day_key(parse_iso_ms("2024-02-29T00:00:00Z").unwrap()), "2024-02-29");
        assert_eq!(day_key(parse_iso_ms("2026-12-31T23:59:59Z").unwrap()), "2026-12-31");
    }

    #[test]
    fn price_lookup_prefers_exact_then_longest_prefix() {
        let t = seed_prices();
        assert_eq!(price_for(&t, "claude-opus-5", None).unwrap().input, 5.0);
        // Dated snapshot resolves to its base entry.
        assert_eq!(
            price_for(&t, "claude-haiku-4-5-20251001", None).unwrap().input,
            1.0
        );
        // A point release inherits its family rate — an estimate, but a far
        // better one than the $0 an unpriced model reports.
        assert_eq!(price_for(&t, "gpt-5.5", None).unwrap().input, 1.25);
        assert_eq!(price_for(&t, "gpt-5-mini-2026-01-01", None).unwrap().input, 0.25);
        // A model from no known family must stay unpriced rather than
        // silently matching something unrelated.
        assert!(price_for(&t, "mistral-large", None).is_none());
    }

    /// Parses a real transcript and prints the totals so they can be diffed
    /// against an independent reference implementation.
    /// `OPENTERM_TEST_SESSION=<session-id> cargo test -- --nocapture`
    #[test]
    fn parse_real_claude_transcript() {
        let Ok(sid) = std::env::var("OPENTERM_TEST_SESSION") else {
            eprintln!("skipped: set OPENTERM_TEST_SESSION to a session id");
            return;
        };
        let index = claude_transcript_index();
        let path = index.get(&sid).expect("session transcript exists");
        let prices = seed_prices();
        let mut unpriced = HashSet::new();
        let p = parse_claude_session(path, &sid, &prices, &mut unpriced).expect("parses");
        let t = &p.usage.tokens;
        println!("RUST IMPLEMENTATION:");
        println!(" messages   : {}", p.usage.messages);
        println!(" tool_calls : {}", p.usage.tool_calls);
        println!(" input      : {}", t.input);
        println!(" output     : {}", t.output);
        println!(" cache_write: {}", t.cache_write);
        println!(" cache_read : {}", t.cache_read);
        println!(" total tok  : {}", t.total);
        println!(" COST USD   : {:.6}", p.usage.cost_usd);
        for (m, mu) in &p.per_model {
            println!("    {m} {:.6}", mu.cost_usd);
        }
        assert!(p.usage.messages > 0);
    }

    /// The account endpoint names its fields differently from the rollout
    /// snapshot this used to read (`reset_at` in seconds, a window given in
    /// seconds rather than minutes), so pin the mapping.
    #[test]
    fn codex_account_window_maps_backend_shape() {
        let v: Value = serde_json::from_str(
            r#"{"used_percent":77,"limit_window_seconds":18000,"reset_at":1788439273}"#,
        )
        .unwrap();
        let w = codex_account_window(&v).expect("parses");
        assert_eq!(w.used_percent, 77.0);
        assert_eq!(w.window_minutes, Some(300));
        assert_eq!(w.resets_at, Some(1_788_439_273_000));
    }

    /// A JWT payload is base64url *without* padding; a decoder that demands it
    /// would report every live token as expired.
    #[test]
    fn jwt_expiry_reads_unpadded_payload() {
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"exp":1789155682}"#);
        assert_eq!(
            jwt_expiry_ms(&format!("head.{payload}.sig")),
            Some(1_789_155_682_000)
        );
        assert_eq!(jwt_expiry_ms("not-a-jwt"), None);
    }

    /// Codex reports cumulative totals per `token_count` event, so this guards
    /// the specific mistake of summing them into a multiplied figure.
    /// `OPENTERM_TEST_CODEX=<session-id> cargo test --bin openterm -- --nocapture`
    #[test]
    fn parse_real_codex_rollout() {
        let Ok(sid) = std::env::var("OPENTERM_TEST_CODEX") else {
            eprintln!("skipped: set OPENTERM_TEST_CODEX to a codex session id");
            return;
        };
        let index = codex_session_index();
        let (path, _) = index.get(&sid).expect("codex rollout exists");
        let prices = seed_prices();
        let mut unpriced = HashSet::new();
        let p = parse_codex_session(path, &sid, &prices, &mut unpriced).expect("parses");
        let t = &p.usage.tokens;
        println!("RUST CODEX:");
        println!(" model      : {}", p.usage.models.join(","));
        println!(" turns      : {}", p.usage.messages);
        println!(" tool_calls : {}", p.usage.tool_calls);
        println!(" fresh input: {}", t.input);
        println!(" cached in  : {}", t.cache_read);
        println!(" output     : {}", t.output);
        println!(" reasoning  : {}", t.reasoning);
        println!(" total tok  : {}", t.total);
        println!(" priced     : {}", p.usage.priced);
        println!(" unpriced   : {unpriced:?}");
        assert!(t.total > 0);
    }
}

