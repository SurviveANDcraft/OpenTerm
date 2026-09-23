//! Agent-CLI ("harness") update checks.
//!
//! The app launches other people's CLIs — Claude Code, Codex, Gemini CLI and
//! friends — and those ship new versions far more often than OpenTerm does.
//! This module answers two questions for each of them: which version is
//! installed locally, and which is the newest published one. When they differ
//! the frontend raises an inbox item with a one-click update.
//!
//! The catalog lives here, not in the frontend, on purpose: `update_harness`
//! runs a shell command, so the set of commands that can ever run must be a
//! fixed table the webview can only pick from by id — never a string it hands
//! us.

use serde::Serialize;
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where a harness publishes its releases, so we can ask for the latest.
#[derive(Clone, Copy, PartialEq)]
enum Registry {
    Npm,
    PyPi,
}

struct HarnessDef {
    /// Matches the binary name `detectAgentCommand` reports in the frontend,
    /// which is how a pane is known to be running this harness.
    id: &'static str,
    label: &'static str,
    /// Argument that makes the CLI print its version.
    version_arg: &'static str,
    registry: Registry,
    package: &'static str,
    /// Update commands, tried in order until one succeeds — the first is the
    /// CLI's own self-updater (which knows how it was installed), the last is
    /// the package-manager fallback.
    update: &'static [&'static str],
}

const HARNESSES: &[HarnessDef] = &[
    HarnessDef {
        id: "claude",
        label: "Claude Code",
        version_arg: "--version",
        registry: Registry::Npm,
        package: "@anthropic-ai/claude-code",
        update: &["claude update", "npm install -g @anthropic-ai/claude-code@latest"],
    },
    HarnessDef {
        id: "codex",
        label: "Codex CLI",
        version_arg: "--version",
        registry: Registry::Npm,
        package: "@openai/codex",
        update: &["npm install -g @openai/codex@latest"],
    },
    HarnessDef {
        id: "gemini",
        label: "Gemini CLI",
        version_arg: "--version",
        registry: Registry::Npm,
        package: "@google/gemini-cli",
        update: &["npm install -g @google/gemini-cli@latest"],
    },
    HarnessDef {
        id: "opencode",
        label: "OpenCode",
        version_arg: "--version",
        registry: Registry::Npm,
        package: "opencode-ai",
        update: &["opencode upgrade", "npm install -g opencode-ai@latest"],
    },
    HarnessDef {
        id: "amp",
        label: "Amp",
        version_arg: "--version",
        registry: Registry::Npm,
        package: "@sourcegraph/amp",
        update: &["npm install -g @sourcegraph/amp@latest"],
    },
    HarnessDef {
        id: "aider",
        label: "Aider",
        version_arg: "--version",
        registry: Registry::PyPi,
        package: "aider-chat",
        update: &["aider --upgrade", "python -m pip install --upgrade aider-chat"],
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub id: String,
    pub label: String,
    pub current: String,
    pub latest: String,
    pub outdated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessUpdateResult {
    pub id: String,
    pub success: bool,
    /// The command line that ran last (the one that succeeded, or the final
    /// fallback that failed) — shown to the user when something goes wrong.
    pub command: String,
    /// Trailing output of that command, trimmed to something displayable.
    pub output: String,
    /// Version reported by the CLI after the update, when it could be read.
    pub version: Option<String>,
}

/// Runs a command line through the platform shell, so `.cmd`/`.ps1` shims like
/// `npm` and `claude` resolve the same way they would if the user typed them.
fn shell_cmd(line: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", line]);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.args(["-c", line]);
        c
    }
}

/// Runs `line` and returns `(success, combined output)`. Gives up after
/// `timeout` — a CLI that decides to prompt for input would otherwise hang the
/// whole check. The waiting thread is abandoned on timeout rather than joined;
/// it ends on its own when the process finally exits.
fn run(line: &str, timeout: Duration) -> Option<(bool, String)> {
    let (tx, rx) = std::sync::mpsc::channel();
    let owned = line.to_string();
    std::thread::spawn(move || {
        let out = shell_cmd(&owned).output();
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(timeout).ok()?.ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), text))
}

/// First semver-shaped token in a CLI's `--version` output. These print all
/// sorts of banner text around the number ("codex-cli 0.5.1", "1.2.3 (Claude
/// Code)"), so a scan beats any fixed parse.
fn parse_version(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    // A version starts a token, optionally behind a lone "v" ("v1.2.3"). Without
    // that second case the leading digit of "v3.4.5" looks mid-token and the scan
    // resumes at "4.5" — a wrong version, not a rejected one.
    let starts_token = |i: usize| -> bool {
        if i == 0 {
            return true;
        }
        let prev = chars[i - 1];
        if !prev.is_ascii_alphanumeric() {
            return true;
        }
        matches!(prev, 'v' | 'V') && (i < 2 || !chars[i - 2].is_ascii_alphanumeric())
    };
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() && starts_token(i) {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '.' | '-' | '+'))
            {
                i += 1;
            }
            let tok: String = chars[start..i].iter().collect();
            let tok = tok.trim_end_matches(['.', '-', '+']);
            // Needs at least major.minor.patch, all starting with a digit, so a
            // date or a lone "2" in a banner isn't mistaken for a version.
            let parts: Vec<&str> = tok.split('.').collect();
            if parts.len() >= 3
                && parts[..3]
                    .iter()
                    .all(|p| p.chars().next().is_some_and(|c| c.is_ascii_digit()))
            {
                return Some(tok.to_string());
            }
            continue;
        }
        i += 1;
    }
    None
}

/// Numeric core of a version, for comparison. Pre-release suffixes are ignored:
/// nobody should be nagged to "update" from 2.0.0 to 2.0.0-beta.1.
fn version_key(v: &str) -> Vec<u64> {
    v.split(['-', '+'])
        .next()
        .unwrap_or(v)
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (version_key(latest), version_key(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

async fn latest_version(reg: Registry, package: &str) -> Option<String> {
    let url = match reg {
        Registry::Npm => format!("https://registry.npmjs.org/{package}/latest"),
        Registry::PyPi => format!("https://pypi.org/pypi/{package}/json"),
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let resp = client
        .get(url)
        .header("accept", "application/json")
        .header("user-agent", "OpenTerm")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    let raw = match reg {
        Registry::Npm => v["version"].as_str(),
        Registry::PyPi => v["info"]["version"].as_str(),
    }?;
    Some(raw.trim().to_string())
}

fn local_version(def: &HarnessDef) -> Option<String> {
    let (ok, text) = run(&format!("{} {}", def.id, def.version_arg), Duration::from_secs(20))?;
    // Some CLIs print their version and exit non-zero; the number is what
    // matters, so the exit status only decides when nothing parses.
    let parsed = parse_version(&text);
    if parsed.is_none() && !ok {
        return None;
    }
    parsed
}

/// Version + latest for every harness that is actually installed. Uninstalled
/// ones are simply absent from the result — there is nothing to update.
/// All harnesses are probed concurrently, so the whole sweep costs about as
/// much as the slowest one.
#[tauri::command]
pub async fn check_harness_updates() -> Vec<HarnessStatus> {
    let tasks: Vec<_> = HARNESSES
        .iter()
        .map(|def| {
            tauri::async_runtime::spawn(async move {
                let local = tauri::async_runtime::spawn_blocking(move || local_version(def))
                    .await
                    .ok()
                    .flatten()?;
                let latest = latest_version(def.registry, def.package).await?;
                Some(HarnessStatus {
                    id: def.id.to_string(),
                    label: def.label.to_string(),
                    outdated: is_newer(&latest, &local),
                    current: local,
                    latest,
                })
            })
        })
        .collect();

    let mut out = Vec::new();
    for t in tasks {
        if let Ok(Some(status)) = t.await {
            out.push(status);
        }
    }
    out
}

/// Runs the update for one harness, picked by id from the fixed table above.
/// Tries each candidate command in turn (self-updater first, package manager
/// second) and stops at the first that exits cleanly.
#[tauri::command]
pub async fn update_harness(id: String) -> Result<HarnessUpdateResult, String> {
    let def = HARNESSES
        .iter()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("unknown harness: {id}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut last = HarnessUpdateResult {
            id: def.id.to_string(),
            success: false,
            command: String::new(),
            output: "no update command produced any output".to_string(),
            version: None,
        };
        for line in def.update {
            // Generous: a cold `npm install -g` on a slow link is minutes.
            let Some((ok, text)) = run(line, Duration::from_secs(600)) else {
                last.command = (*line).to_string();
                last.output = "update timed out".to_string();
                continue;
            };
            last.command = (*line).to_string();
            last.output = tail(&text);
            if ok {
                last.success = true;
                last.version = local_version(def);
                break;
            }
        }
        last
    })
    .await
    .map_err(|e| e.to_string())
}

/// Tail of a command's output. Generous, because the frontend picks one line
/// out of this: npm's error block spends several long lines on file paths
/// before the one that names the problem, and a tighter cap would cut it off.
fn tail(text: &str) -> String {
    const MAX: usize = 2000;
    let t = text.trim();
    let n = t.chars().count();
    if n <= MAX {
        return t.to_string();
    }
    format!("…{}", t.chars().skip(n - MAX).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions_out_of_banner_text() {
        // Real `--version` output from the CLIs in the catalog.
        assert_eq!(parse_version("2.1.228 (Claude Code)").as_deref(), Some("2.1.228"));
        assert_eq!(parse_version("codex-cli 0.153.4").as_deref(), Some("0.153.4"));
        assert_eq!(parse_version("1.18.27").as_deref(), Some("1.18.27"));
        assert_eq!(parse_version("v3.4.5-beta.2").as_deref(), Some("3.4.5-beta.2"));
        // Not a version: no major.minor.patch to be found.
        assert_eq!(parse_version("'gemini' is not recognized"), None);
        assert_eq!(parse_version("built 2024"), None);
    }

    #[test]
    fn compares_only_the_numeric_core() {
        assert!(is_newer("2.1.263", "2.1.228"));
        assert!(is_newer("1.19.0", "1.18.29"));
        assert!(!is_newer("2.1.228", "2.1.228"));
        assert!(!is_newer("2.1.100", "2.1.228"));
        // A pre-release of the version you already run is not an update.
        assert!(!is_newer("2.0.0-beta.1", "2.0.0"));
        // Shorter version strings compare as if zero-padded.
        assert!(is_newer("2.1", "2.0.9"));
    }
}
