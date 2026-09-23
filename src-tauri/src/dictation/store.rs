//! History, Unsent and their audio, in `app_data_dir/dictation/`. Only the
//! agent writes these; Settings reads them. Kept deliberately small: 15
//! transcriptions, 5 unsent recordings and a 60 MB audio budget.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const HISTORY_MAX: usize = 15;
pub const UNSENT_MAX: usize = 5;
pub const AUDIO_BUDGET: u64 = 60 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryItem {
    pub id: String,
    pub text: String,
    pub created_at: u64,
    pub duration_ms: u64,
    pub language: Option<String>,
    pub app: Option<String>,
    pub cost: Option<f64>,
    /// File name under `audio/`; None once it expired or was never kept.
    pub audio: Option<String>,
    pub audio_expired: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UnsentItem {
    pub id: String,
    pub created_at: u64,
    pub duration_ms: u64,
    /// "Cancelled" or a short failure reason.
    pub reason: String,
    pub detail: Option<String>,
    pub cancelled: bool,
    pub app: Option<String>,
    pub audio: Option<String>,
    /// Last retry outcome time, so Settings can tell a repeat failure apart.
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    /// "YYYY-MM" the totals belong to; a new month starts from zero.
    pub month: String,
    pub seconds: f64,
    pub cost: f64,
    /// How many dictations showed the "Esc to cancel" hint (it stops at 3).
    pub hints_shown: u32,
}

static LOCK: Mutex<()> = Mutex::new(());

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{:x}{:05x}", now_ms(), nanos & 0xFFFFF)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub const FOCUSED_AGENT_FILE: &str = "focused_agent";
/// Pane the dictation process wants the main app to focus, so a locked
/// transcript can go back to the pane it was dictated into.
pub const FOCUS_REQUEST_FILE: &str = "focus_pane";

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Store { dir }
    }

    /// The agent CLI in OpenTerm's focused pane, as last published by the app.
    pub fn focused_agent(&self) -> Option<&'static str> {
        self.focused_pane().0
    }

    /// Agent CLI and pane id of OpenTerm's focused pane. The file holds
    /// "<agent>\t<pane id>"; older builds wrote the agent alone, which still
    /// parses (with no pane).
    pub fn focused_pane(&self) -> (Option<&'static str>, Option<String>) {
        let Ok(raw) = std::fs::read_to_string(self.dir.join(FOCUSED_AGENT_FILE)) else {
            return (None, None);
        };
        let (agent, pane) = raw.split_once('\t').unwrap_or((raw.as_str(), ""));
        let pane = pane.trim();
        (super::paste::parse_agent(agent), (!pane.is_empty()).then(|| pane.to_string()))
    }

    /// Asks the main app (which watches for this) to focus a pane. Paired
    /// with `signal(FOCUS_EVENT)` by the caller.
    pub fn write_focus_request(&self, pane: &str) {
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = std::fs::write(self.dir.join(FOCUS_REQUEST_FILE), pane);
    }

    pub fn audio_dir(&self) -> PathBuf {
        self.dir.join("audio")
    }

    pub fn history(&self) -> Vec<HistoryItem> {
        read_json(&self.dir.join("history.json"))
    }

    pub fn unsent(&self) -> Vec<UnsentItem> {
        read_json(&self.dir.join("unsent.json"))
    }

    pub fn stats(&self) -> Stats {
        let mut s: Stats = read_json(&self.dir.join("stats.json"));
        let month = current_month();
        if s.month != month {
            s.month = month;
            s.seconds = 0.0;
            s.cost = 0.0;
        }
        s
    }

    fn save(&self, history: &[HistoryItem], unsent: &[UnsentItem]) {
        let _ = write_json_atomic(&self.dir.join("history.json"), &history);
        let _ = write_json_atomic(&self.dir.join("unsent.json"), &unsent);
    }

    fn write_audio(&self, id: &str, flac: &[u8]) -> Option<String> {
        let name = format!("{id}.flac");
        fs::create_dir_all(self.audio_dir()).ok()?;
        fs::write(self.audio_dir().join(&name), flac).ok()?;
        Some(name)
    }

    fn remove_audio(&self, name: &Option<String>) {
        if let Some(n) = name {
            let _ = fs::remove_file(self.audio_dir().join(n));
        }
    }

    /// Applies the caps and the audio budget, deleting whatever fell out.
    fn commit(&self, mut history: Vec<HistoryItem>, mut unsent: Vec<UnsentItem>) {
        let audio_dir = self.audio_dir();
        let doomed = prune(&mut history, &mut unsent, |name| {
            fs::metadata(audio_dir.join(name)).map(|m| m.len()).unwrap_or(0)
        });
        for name in doomed {
            let _ = fs::remove_file(audio_dir.join(name));
        }
        self.save(&history, &unsent);
    }

    pub fn add_history(&self, mut item: HistoryItem, flac: Option<&[u8]>, seconds: f64) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        item.audio = flac.and_then(|f| self.write_audio(&item.id, f));
        let mut history = self.history();
        history.insert(0, item.clone());
        self.commit(history, self.unsent());
        let mut stats = self.stats();
        stats.seconds += seconds;
        stats.cost += item.cost.unwrap_or(0.0);
        let _ = write_json_atomic(&self.dir.join("stats.json"), &stats);
    }

    pub fn add_unsent(&self, mut item: UnsentItem, flac: &[u8]) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        item.audio = self.write_audio(&item.id, flac);
        let mut unsent = self.unsent();
        unsent.insert(0, item);
        self.commit(self.history(), unsent);
    }

    /// Moves an unsent recording into History after a successful retry. The
    /// audio file is reused as-is.
    pub fn promote_unsent(&self, id: &str, mut item: HistoryItem, seconds: f64) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut unsent = self.unsent();
        let Some(pos) = unsent.iter().position(|u| u.id == id) else { return };
        let old = unsent.remove(pos);
        item.audio = old.audio;
        let mut history = self.history();
        history.insert(0, item.clone());
        self.commit(history, unsent);
        let mut stats = self.stats();
        stats.seconds += seconds;
        stats.cost += item.cost.unwrap_or(0.0);
        let _ = write_json_atomic(&self.dir.join("stats.json"), &stats);
    }

    pub fn set_unsent_reason(&self, id: &str, reason: &str, detail: &str) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut unsent = self.unsent();
        if let Some(u) = unsent.iter_mut().find(|u| u.id == id) {
            u.reason = reason.to_string();
            u.detail = Some(detail.to_string());
            u.cancelled = false;
            u.updated_at = now_ms();
        }
        self.save(&self.history(), &unsent);
    }

    pub fn delete_history(&self, id: &str) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut history = self.history();
        if let Some(pos) = history.iter().position(|h| h.id == id) {
            self.remove_audio(&history.remove(pos).audio);
        }
        self.save(&history, &self.unsent());
    }

    pub fn delete_unsent(&self, id: &str) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut unsent = self.unsent();
        if let Some(pos) = unsent.iter().position(|u| u.id == id) {
            self.remove_audio(&unsent.remove(pos).audio);
        }
        self.save(&self.history(), &unsent);
    }

    /// Wipes History text and audio. Unsent recordings aren't history.
    pub fn clear_history(&self) {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for h in self.history() {
            self.remove_audio(&h.audio);
        }
        self.save(&[], &self.unsent());
    }

    pub fn bump_hint(&self) -> bool {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut stats = self.stats();
        if stats.hints_shown >= 3 {
            return false;
        }
        stats.hints_shown += 1;
        let _ = write_json_atomic(&self.dir.join("stats.json"), &stats);
        true
    }
}

fn current_month() -> String {
    crate::utc_date_string().chars().take(7).collect()
}

/// Enforces the caps (newest first in both lists), then the audio budget by
/// expiring the oldest audio. History keeps its text; an unsent item without
/// audio is worthless, so it goes entirely. Returns audio files to delete.
pub fn prune(
    history: &mut Vec<HistoryItem>,
    unsent: &mut Vec<UnsentItem>,
    size_of: impl Fn(&str) -> u64,
) -> Vec<String> {
    let mut doomed = Vec::new();
    if history.len() > HISTORY_MAX {
        doomed.extend(history.drain(HISTORY_MAX..).filter_map(|h| h.audio));
    }
    if unsent.len() > UNSENT_MAX {
        doomed.extend(unsent.drain(UNSENT_MAX..).filter_map(|u| u.audio));
    }

    // (created_at, is_history, id, size)
    let mut clips: Vec<(u64, bool, String, u64)> = history
        .iter()
        .filter_map(|h| h.audio.as_ref().map(|a| (h.created_at, true, h.id.clone(), size_of(a))))
        .chain(unsent.iter().filter_map(|u| u.audio.as_ref().map(|a| (u.created_at, false, u.id.clone(), size_of(a)))))
        .collect();
    let mut total: u64 = clips.iter().map(|c| c.3).sum();
    clips.sort_by_key(|c| c.0);
    for (_, is_history, id, size) in clips {
        if total <= AUDIO_BUDGET {
            break;
        }
        total -= size;
        if is_history {
            if let Some(h) = history.iter_mut().find(|h| h.id == id) {
                doomed.extend(h.audio.take());
                h.audio_expired = true;
            }
        } else if let Some(pos) = unsent.iter().position(|u| u.id == id) {
            doomed.extend(unsent.remove(pos).audio);
        }
    }
    doomed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(id: &str, at: u64) -> HistoryItem {
        HistoryItem { id: id.into(), created_at: at, audio: Some(format!("{id}.flac")), ..Default::default() }
    }
    fn u(id: &str, at: u64) -> UnsentItem {
        UnsentItem { id: id.into(), created_at: at, audio: Some(format!("{id}.flac")), ..Default::default() }
    }

    #[test]
    fn focused_pane_parses_both_formats() {
        let dir = std::env::temp_dir().join(format!("openterm-focus-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::new(dir.clone());
        // Nothing published yet.
        assert_eq!(store.focused_pane(), (None, None));
        let write = |s: &str| std::fs::write(dir.join(FOCUSED_AGENT_FILE), s).unwrap();
        // Current format.
        write("claude-code\tp-3");
        assert_eq!(store.focused_pane(), (Some("claude-code"), Some("p-3".to_string())));
        write("opencode\tp-9");
        assert_eq!(store.focused_pane(), (Some("opencode"), Some("p-9".to_string())));
        // A pane with no agent still identifies the pane.
        write("\tp-4");
        assert_eq!(store.focused_pane(), (None, Some("p-4".to_string())));
        // Older builds wrote the agent alone.
        write("codex");
        assert_eq!(store.focused_pane(), (Some("codex"), None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_drop_the_oldest_entries_and_their_audio() {
        let mut history: Vec<_> = (0..17).rev().map(|i| h(&format!("h{i}"), i)).collect();
        let mut unsent: Vec<_> = (0..6).rev().map(|i| u(&format!("u{i}"), i)).collect();
        let doomed = prune(&mut history, &mut unsent, |_| 1);
        assert_eq!(history.len(), HISTORY_MAX);
        assert_eq!(unsent.len(), UNSENT_MAX);
        assert_eq!(history.last().unwrap().id, "h2");
        assert_eq!(doomed, vec!["h1.flac", "h0.flac", "u0.flac"]);
    }

    #[test]
    fn budget_expires_oldest_audio_but_keeps_text() {
        let mut history = vec![h("new", 30), h("old", 10)];
        let mut unsent = vec![u("mid", 20)];
        let mb = 1024 * 1024;
        let doomed = prune(&mut history, &mut unsent, |_| 25 * mb);
        assert_eq!(doomed, vec!["old.flac"]);
        assert!(history[1].audio.is_none() && history[1].audio_expired);
        assert_eq!(unsent.len(), 1);

        let doomed = prune(&mut history, &mut unsent, |_| 40 * mb);
        assert_eq!(doomed, vec!["mid.flac"]);
        assert!(unsent.is_empty());
        assert!(history[0].audio.is_some());
    }
}
