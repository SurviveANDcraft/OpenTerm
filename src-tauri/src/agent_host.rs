//! Headless agent processes for Threads mode.
//!
//! Threads talk to the agent CLIs through their own machine protocols instead
//! of a terminal: Claude Code in `-p` stream-json mode (its approvals come back
//! to us as `can_use_tool` control requests on stdout), Codex as `codex
//! app-server` (JSON-RPC over stdio). This module is deliberately protocol
//! blind: it starts a process, forwards every stdout line to the webview as an
//! `agent-host` event, writes lines the webview sends to stdin, and keeps a
//! journal per thread so history survives restarts.
//!
//! Journal format (`app_data/threads/<id>.jsonl`, one JSON object per line):
//! - `{"t":ms,"o":<raw stdout message>}` agent output (streaming deltas are
//!   skipped, the final messages carry the full text)
//! - `{"t":ms,"x":code}` the process ended
//! - `{"t":ms,"u":{...}}` records the webview appends (prompts, decisions)
//!
//! The same records replay through the same parser as live output, so a
//! thread reopened after a restart renders exactly like it did live.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Hosted {
    child: Child,
    stdin: Option<ChildStdin>,
    generation: u64,
}

fn hosts() -> &'static Mutex<HashMap<String, Hosted>> {
    static H: OnceLock<Mutex<HashMap<String, Hosted>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(HashMap::new()))
}

static GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
struct HostEvent<'a> {
    id: &'a str,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn valid_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err("Invalid thread id".into())
    }
}

fn threads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("threads");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn journal_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    Ok(threads_dir(app)?.join(format!("{id}.jsonl")))
}

// ------------------------------------------------------------ locating CLIs

/// How to start a CLI without a shell: the program and any leading arguments
/// (an npm install without a native binary runs `node <entry>.js`).
struct Cli {
    program: PathBuf,
    prefix: Vec<String>,
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default()
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    path_dirs().into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// The npm global folder that holds a `<name>.cmd` shim, if any.
fn npm_shim_dir(name: &str) -> Option<PathBuf> {
    path_dirs().into_iter().find(|d| d.join(format!("{name}.cmd")).is_file())
}

fn node_near(shim_dir: &Path) -> Option<PathBuf> {
    find_on_path("node.exe").or_else(|| Some(shim_dir.join("node.exe")).filter(|p| p.is_file()))
}

fn locate(name: &str) -> Option<Cli> {
    if !cfg!(windows) {
        return find_on_path(name).map(|program| Cli { program, prefix: vec![] });
    }
    let exe = format!("{name}.exe");
    let native = find_on_path(&exe).or_else(|| home().map(|h| h.join(".local").join("bin").join(&exe)).filter(|p| p.is_file()));
    if let Some(program) = native {
        return Some(Cli { program, prefix: vec![] });
    }
    let shim = npm_shim_dir(name)?;
    let modules = shim.join("node_modules");
    match name {
        "claude" => {
            let pkg = modules.join("@anthropic-ai").join("claude-code");
            let bin = pkg.join("bin").join("claude.exe");
            if bin.is_file() {
                return Some(Cli { program: bin, prefix: vec![] });
            }
            let js = pkg.join("cli.js");
            js.is_file().then_some(())?;
            Some(Cli { program: node_near(&shim)?, prefix: vec![js.to_string_lossy().into_owned()] })
        }
        "codex" => {
            // The JS launcher sets up PATH for Codex's helper binaries, so it
            // is preferred over the vendored codex.exe it would start.
            let js = modules.join("@openai").join("codex").join("bin").join("codex.js");
            js.is_file().then_some(())?;
            Some(Cli { program: node_near(&shim)?, prefix: vec![js.to_string_lossy().into_owned()] })
        }
        _ => None,
    }
}

/// Whether a CLI can be started headless, and where it was found.
#[tauri::command]
pub fn agent_host_locate(cli: String) -> Option<String> {
    locate(&cli).map(|c| c.program.to_string_lossy().into_owned())
}

// ------------------------------------------------------------ processes

fn should_journal(line: &str, skip: &[String]) -> bool {
    let t = line.trim_start();
    if !t.starts_with('{') {
        return false;
    }
    let head: String = t.chars().take(240).collect();
    if skip.iter().any(|s| head.contains(s.as_str())) {
        return false;
    }
    serde_json::from_str::<serde::de::IgnoredAny>(t).is_ok()
}

/// Starts `cli` (`claude` or `codex`) for a thread. Replaces a process the
/// thread already had. Returns the process id.
#[tauri::command]
pub fn agent_host_spawn(
    app: AppHandle,
    id: String,
    cli: String,
    args: Vec<String>,
    cwd: String,
    journal_skip: Vec<String>,
) -> Result<u32, String> {
    valid_id(&id)?;
    if cli != "claude" && cli != "codex" {
        return Err(format!("Unknown agent CLI: {cli}"));
    }
    let dir = Path::new(&cwd);
    if !dir.is_dir() {
        return Err(format!("The folder {cwd} doesn't exist anymore."));
    }
    let found = locate(&cli).ok_or_else(|| match cli.as_str() {
        "claude" => "Claude Code isn't installed. Install it from claude.com/claude-code and sign in once in a terminal.".to_string(),
        _ => "Codex isn't installed. Install it with `npm i -g @openai/codex` and sign in once in a terminal.".to_string(),
    })?;
    agent_host_kill(id.clone());

    let mut cmd = Command::new(&found.program);
    cmd.args(&found.prefix)
        .args(&args)
        .current_dir(dir)
        .env("OPENTERM_THREAD_ID", &id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start {cli}: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take();
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    hosts().lock().unwrap().insert(id.clone(), Hosted { child, stdin, generation });

    let journal = journal_path(&app, &id)?;
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || pump_stdout(app, id, generation, stdout, journal, journal_skip));
    }
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf);
                        let line = line.trim_end();
                        if !line.is_empty() {
                            let _ = app.emit("agent-host", HostEvent { id: &id, kind: "err", line: Some(line), code: None });
                        }
                    }
                }
            }
        });
    }
    Ok(pid)
}

fn pump_stdout(app: AppHandle, id: String, generation: u64, stdout: impl Read, journal: PathBuf, skip: Vec<String>) {
    let mut file = OpenOptions::new().create(true).append(true).open(&journal).ok();
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end();
                if line.is_empty() {
                    continue;
                }
                if let Some(f) = file.as_mut() {
                    if should_journal(line, &skip) {
                        let _ = writeln!(f, "{{\"t\":{},\"o\":{}}}", now_ms(), line.trim_start());
                    }
                }
                let _ = app.emit("agent-host", HostEvent { id: &id, kind: "out", line: Some(line), code: None });
            }
        }
    }
    // Reap the process, unless a newer one has taken this thread's slot.
    let code = {
        let mut map = hosts().lock().unwrap();
        match map.get_mut(&id) {
            Some(h) if h.generation == generation => {
                let code = h.child.wait().ok().and_then(|s| s.code());
                map.remove(&id);
                Some(code)
            }
            _ => None,
        }
    };
    if let Some(code) = code {
        if let Some(f) = file.as_mut() {
            let _ = writeln!(f, "{{\"t\":{},\"x\":{}}}", now_ms(), code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()));
        }
        let _ = app.emit("agent-host", HostEvent { id: &id, kind: "exit", line: None, code });
    }
}

/// Writes one line (a JSON message) to the thread's process.
#[tauri::command]
pub fn agent_host_write(id: String, line: String) -> Result<(), String> {
    let mut map = hosts().lock().unwrap();
    let h = map.get_mut(&id).ok_or("The agent isn't running.")?;
    let stdin = h.stdin.as_mut().ok_or("The agent isn't accepting input.")?;
    let mut data = line.replace('\n', " ").into_bytes();
    data.push(b'\n');
    stdin.write_all(&data).and_then(|_| stdin.flush()).map_err(|e| format!("Couldn't reach the agent: {e}"))
}

/// Ends the thread's process and everything it started (shell commands,
/// sub-agents). No-op when it isn't running.
#[tauri::command]
pub fn agent_host_kill(id: String) {
    let hosted = hosts().lock().unwrap().remove(&id);
    if let Some(mut h) = hosted {
        drop(h.stdin.take());
        kill_tree(&mut h.child);
    }
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut tk = Command::new("taskkill");
        tk.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = tk.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Thread ids with a live process (a reloaded webview re-attaches to them).
#[tauri::command]
pub fn agent_host_running() -> Vec<String> {
    hosts().lock().unwrap().keys().cloned().collect()
}

/// Called on app exit: no agent outlives the window.
pub fn kill_all() {
    let all: Vec<Hosted> = hosts().lock().unwrap().drain().map(|(_, h)| h).collect();
    for mut h in all {
        drop(h.stdin.take());
        kill_tree(&mut h.child);
    }
}

// ------------------------------------------------------------ persistence

#[tauri::command]
pub fn thread_journal_read(app: AppHandle, id: String) -> Result<String, String> {
    let path = journal_path(&app, &id)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Appends a webview record (`{"u":...}` is wrapped here) to the journal.
#[tauri::command]
pub fn thread_journal_append(app: AppHandle, id: String, record: String) -> Result<(), String> {
    serde_json::from_str::<serde::de::IgnoredAny>(&record).map_err(|_| "Invalid record")?;
    let path = journal_path(&app, &id)?;
    let mut f = OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    writeln!(f, "{{\"t\":{},\"u\":{}}}", now_ms(), record.replace('\n', " ")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn thread_journal_delete(app: AppHandle, id: String) -> Result<(), String> {
    agent_host_kill(id.clone());
    let path = journal_path(&app, &id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn threads_index_load(app: AppHandle) -> Result<String, String> {
    let path = threads_dir(&app)?.join("index.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn threads_index_save(app: AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde::de::IgnoredAny>(&json).map_err(|_| "Invalid index")?;
    let dir = threads_dir(&app)?;
    let tmp = dir.join("index.json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("index.json")).map_err(|e| e.to_string())
}

/// The current git branch of a folder, read straight from `.git/HEAD` (no
/// process). None outside a repository or on a detached HEAD.
#[tauri::command]
pub fn thread_git_branch(cwd: String) -> Option<String> {
    let mut dir = Some(Path::new(&cwd));
    while let Some(d) = dir {
        let git = d.join(".git");
        let head = if git.is_dir() {
            git.join("HEAD")
        } else if git.is_file() {
            // A worktree: ".git" is a file pointing at the real git dir.
            let text = fs::read_to_string(&git).ok()?;
            let target = text.trim().strip_prefix("gitdir:")?.trim().to_string();
            let p = PathBuf::from(&target);
            let p = if p.is_absolute() { p } else { d.join(p) };
            p.join("HEAD")
        } else {
            dir = d.parent();
            continue;
        };
        let text = fs::read_to_string(head).ok()?;
        return text.trim().strip_prefix("ref: refs/heads/").map(str::to_string);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_filter_skips_deltas_and_non_json() {
        let skip = vec!["\"type\":\"stream_event\"".to_string()];
        assert!(!should_journal(r#"{"type":"stream_event","event":{}}"#, &skip));
        assert!(should_journal(r#"{"type":"assistant","message":{}}"#, &skip));
        assert!(!should_journal("not json", &skip));
        assert!(!should_journal(r#"{"type":"assistant""#, &skip));
    }

    #[test]
    fn ids_are_validated() {
        assert!(valid_id("th_abc-123").is_ok());
        assert!(valid_id("../x").is_err());
        assert!(valid_id("").is_err());
    }
}
