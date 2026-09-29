//! GitHub issues for a session's repo, through the user's own `gh` CLI.
//!
//! `gh` owns authentication (its token lives in the OS keychain after a one-off
//! `gh auth login`), so OpenTerm never sees or stores a credential. Every
//! command runs with the session's folder as its working directory, which is
//! how `gh` picks the repo — the same one `origin` points at.
//!
//! Each Tauri command maps to exactly one `gh` subcommand; the webview never
//! gets to pass arbitrary arguments through.

use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const ISSUE_LIST_FIELDS: &str =
    "number,title,state,stateReason,labels,assignees,author,comments,createdAt,updatedAt,url";
const ISSUE_VIEW_FIELDS: &str =
    "number,title,body,state,stateReason,labels,assignees,author,comments,createdAt,updatedAt,url";

fn gh_cmd(cwd: &str) -> Command {
    let mut cmd = Command::new("gh");
    cmd.current_dir(cwd)
        // Never block on an interactive prompt or print an update nag — there
        // is no terminal on the other end.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Runs `gh <args>` in `cwd`, feeding `input` on stdin when given, and returns
/// stdout. A failure carries `gh`'s own stderr, which is already human-readable.
fn gh(cwd: &str, args: &[&str], input: Option<&str>) -> Result<String, String> {
    if !Path::new(cwd).exists() {
        return Err(format!("Folder not found: {cwd}"));
    }
    let mut cmd = gh_cmd(cwd);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "gh-missing".to_string()
        } else {
            e.to_string()
        }
    })?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn parse(json: &str) -> Result<Value, String> {
    serde_json::from_str(json).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    /// "ok" | "missing" (gh not installed) | "auth" (not logged in) |
    /// "no-repo" (folder isn't a GitHub repo gh can resolve) | "error".
    pub state: String,
    pub repo: Option<String>,
    pub url: Option<String>,
    pub login: Option<String>,
    pub message: Option<String>,
}

fn status_sync(cwd: &str) -> GhStatus {
    let fail = |state: &str, message: Option<String>| GhStatus {
        state: state.into(),
        repo: None,
        url: None,
        login: None,
        message,
    };
    // `auth status` first: it is the one that tells "not logged in" apart from
    // "this folder has no GitHub remote", which need different fixes.
    if let Err(e) = gh(cwd, &["auth", "status", "--hostname", "github.com"], None) {
        return if e == "gh-missing" {
            fail("missing", None)
        } else if e.contains("not logged") || e.contains("gh auth login") || e.contains("no oauth token") {
            fail("auth", None)
        } else if e.starts_with("Folder not found") {
            fail("no-repo", Some(e))
        } else {
            // Offline, proxy trouble, GitHub down: signing in again wouldn't help.
            fail("error", Some(e))
        };
    }
    let repo = match gh(cwd, &["repo", "view", "--json", "nameWithOwner,url"], None).and_then(|s| parse(&s)) {
        Ok(v) => v,
        Err(e) => return fail("no-repo", Some(e)),
    };
    let login = gh(cwd, &["api", "user", "--jq", ".login"], None).ok();
    GhStatus {
        state: "ok".into(),
        repo: repo["nameWithOwner"].as_str().map(String::from),
        url: repo["url"].as_str().map(String::from),
        login,
        message: None,
    }
}

#[tauri::command]
pub async fn gh_status(cwd: String) -> Result<GhStatus, String> {
    blocking(move || Ok(status_sync(&cwd))).await
}

/// `state` is "open" | "closed" | "all"; `mine` narrows to issues assigned to
/// the logged-in user.
#[tauri::command]
pub async fn gh_issue_list(cwd: String, state: String, mine: bool) -> Result<Value, String> {
    blocking(move || {
        let mut args = vec!["issue", "list", "--limit", "100", "--state", &state, "--json", ISSUE_LIST_FIELDS];
        if mine {
            args.extend(["--assignee", "@me"]);
        }
        parse(&gh(&cwd, &args, None)?)
    })
    .await
}

#[tauri::command]
pub async fn gh_issue_view(cwd: String, number: u64) -> Result<Value, String> {
    blocking(move || {
        let n = number.to_string();
        parse(&gh(&cwd, &["issue", "view", &n, "--json", ISSUE_VIEW_FIELDS], None)?)
    })
    .await
}

/// `action` is "close" | "close-not-planned" | "reopen".
#[tauri::command]
pub async fn gh_issue_set_state(cwd: String, number: u64, action: String) -> Result<(), String> {
    blocking(move || {
        let n = number.to_string();
        let args: Vec<&str> = match action.as_str() {
            "close" => vec!["issue", "close", &n, "--reason", "completed"],
            "close-not-planned" => vec!["issue", "close", &n, "--reason", "not planned"],
            "reopen" => vec!["issue", "reopen", &n],
            other => return Err(format!("Unknown issue action: {other}")),
        };
        gh(&cwd, &args, None).map(|_| ())
    })
    .await
}

/// The body goes over stdin rather than argv so long or multi-line comments
/// are never mangled by argument quoting.
#[tauri::command]
pub async fn gh_issue_comment(cwd: String, number: u64, body: String) -> Result<(), String> {
    blocking(move || {
        let n = number.to_string();
        gh(&cwd, &["issue", "comment", &n, "--body-file", "-"], Some(&body)).map(|_| ())
    })
    .await
}

/// Returns the new issue's URL.
#[tauri::command]
pub async fn gh_issue_create(cwd: String, title: String, body: String) -> Result<String, String> {
    blocking(move || gh(&cwd, &["issue", "create", "--title", &title, "--body-file", "-"], Some(&body))).await
}

#[tauri::command]
pub async fn gh_issue_assign_me(cwd: String, number: u64, assign: bool) -> Result<(), String> {
    blocking(move || {
        let n = number.to_string();
        let flag = if assign { "--add-assignee" } else { "--remove-assignee" };
        gh(&cwd, &["issue", "edit", &n, flag, "@me"], None).map(|_| ())
    })
    .await
}
