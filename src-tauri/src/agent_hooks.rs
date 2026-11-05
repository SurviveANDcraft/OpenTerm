//! Exact agent status from the agents' own lifecycle hooks.
//!
//! Claude Code and Codex both run a command at fixed points in their loop: a
//! prompt was submitted, a permission dialog opened, a sub-agent started, the
//! turn ended. We register this same executable as that command
//! (`openterm.exe --agent-hook <agent>`). It runs as a tiny forwarder that never
//! opens a window: it reads the hook's JSON from stdin and hands it, tagged with
//! the pane it came from, to a listener on 127.0.0.1 inside the running app.
//!
//! How events find their pane: every PTY is spawned with `OPENTERM_PANE_ID`, plus
//! the listener's port and a per-run token, in its environment. The agent
//! inherits them and so does every hook it runs. A hook that fires anywhere else
//! (a plain Windows Terminal, OpenTerm closed) finds no such variables and exits
//! 0 without doing anything, so the agent never notices it.
//!
//! The hooks only observe: the forwarder prints nothing, so it never approves,
//! blocks or changes anything the agent does.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

/// Argument that turns this executable into the hook forwarder.
pub const HOOK_ARG: &str = "--agent-hook";

const ENV_PANE: &str = "OPENTERM_PANE_ID";
const ENV_PORT: &str = "OPENTERM_HOOK_PORT";
const ENV_TOKEN: &str = "OPENTERM_HOOK_TOKEN";

/// First line of every forwarded message, so a stray connection to the port
/// (some other local tool scanning it) is dropped instead of parsed.
const MAGIC: &str = "OTHOOK1";

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hook payloads carry tool inputs, which can be a whole file being written.
const MAX_PAYLOAD: u64 = 4 * 1024 * 1024;

/// Recent events kept per pane, so a reloaded frontend can rebuild its state.
const REPLAY_PER_PANE: usize = 96;

// ------------------------------------------------------------------ forwarder

/// Entry point for `openterm.exe --agent-hook <agent>`. Always exits 0 with no
/// output: a hook that fails or prints would show up inside the agent's UI.
pub fn run_forwarder() {
    let agent = std::env::args()
        .skip_while(|a| a != HOOK_ARG)
        .nth(1)
        .unwrap_or_default();
    let (Ok(pane), Ok(port), Ok(token)) = (
        std::env::var(ENV_PANE),
        std::env::var(ENV_PORT),
        std::env::var(ENV_TOKEN),
    ) else {
        return;
    };
    let Ok(port) = port.parse::<u16>() else { return };

    let mut body = Vec::new();
    let _ = std::io::stdin().take(MAX_PAYLOAD).read_to_end(&mut body);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let header = format!("{MAGIC}\t{token}\t{pane}\t{agent}\n");
    if stream.write_all(header.as_bytes()).is_ok() && stream.write_all(&body).is_ok() {
        let _ = stream.flush();
        // Wait for the app to acknowledge, so an event is never cut off by this
        // process exiting — but never for long.
        let _ = stream.shutdown(Shutdown::Write);
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let mut ack = [0u8; 1];
        let _ = stream.read(&mut ack);
    }
}

// ------------------------------------------------------------------- listener

struct Listener {
    port: u16,
    token: String,
}

static LISTENER: OnceLock<Listener> = OnceLock::new();

fn replay() -> &'static Mutex<HashMap<String, VecDeque<HookEvent>>> {
    static R: OnceLock<Mutex<HashMap<String, VecDeque<HookEvent>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// One hook firing, trimmed to what the frontend's state machine needs.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    seq: u64,
    at: u64,
    pane_id: String,
    agent: String,
    /// Normalized event name: lowercase, no separators ("pretooluse").
    event: String,
    session_id: String,
    /// Set when the hook fired inside a sub-agent (Claude) or names the
    /// sub-agent a SubagentStart/Stop is about.
    agent_id: Option<String>,
    agent_type: Option<String>,
    tool_name: Option<String>,
    tool_use_id: Option<String>,
    /// What the tool is about to do, in one line: the command, the file, the
    /// question. Shown in the inbox instead of a screen scrape.
    detail: Option<String>,
    notification_type: Option<String>,
    message: Option<String>,
    error_type: Option<String>,
    /// SessionStart `source` / SessionEnd `reason`.
    source: Option<String>,
    /// Claude's Stop lists the session's background work; these are the
    /// sub-agents still running in it, the authoritative count at turn end.
    running_agents: Option<Vec<String>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A token nobody else on the machine can guess, without pulling in a crate:
/// `RandomState` is seeded from the OS RNG per instance.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i ^ now_ms());
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// Binds the listener and starts accepting. Safe to call once at startup; if
/// the bind fails, panes simply get no hook env and the screen-based detection
/// keeps doing the job alone.
pub fn start(app: AppHandle) {
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else { return };
    let Ok(addr) = listener.local_addr() else { return };
    let _ = LISTENER.set(Listener {
        port: addr.port(),
        token: random_token(),
    });
    thread::spawn(move || {
        let seq = std::sync::Arc::new(Mutex::new(0u64));
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let (app, seq) = (app.clone(), seq.clone());
            thread::spawn(move || handle_conn(stream, app, seq));
        }
    });
}

fn handle_conn(mut stream: TcpStream, app: AppHandle, seq: std::sync::Arc<Mutex<u64>>) {
    let Some(l) = LISTENER.get() else { return };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let Ok(read_half) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let mut header = String::new();
    if reader.by_ref().take(1024).read_line(&mut header).is_err() {
        return;
    }
    let parts: Vec<&str> = header.trim_end().split('\t').collect();
    if parts.len() != 4 || parts[0] != MAGIC || parts[1] != l.token {
        return;
    }
    let (pane, agent) = (parts[2].to_string(), parts[3].to_string());
    let mut body = Vec::new();
    let _ = reader.take(MAX_PAYLOAD).read_to_end(&mut body);
    let _ = stream.write_all(b"k");

    let Ok(payload) = serde_json::from_slice::<Value>(&body) else { return };
    let Some(mut ev) = to_event(&pane, &agent, &payload) else { return };

    // Numbered under one lock and emitted inside it, so the frontend sees
    // events in the order they were accepted even though each connection has
    // its own thread.
    let mut n = seq.lock().unwrap();
    *n += 1;
    ev.seq = *n;
    {
        let mut r = replay().lock().unwrap();
        let q = r.entry(pane).or_default();
        q.push_back(ev.clone());
        while q.len() > REPLAY_PER_PANE {
            q.pop_front();
        }
    }
    let _ = app.emit("agent-hook", ev);
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn clip(s: &str, max: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        let cut: String = one_line.chars().take(max - 1).collect();
        format!("{cut}…")
    }
}

/// One line saying what a tool call is about to do.
fn tool_detail(tool: &str, input: &Value) -> Option<String> {
    let pick = |keys: &[&str]| keys.iter().find_map(|k| str_field(input, k));
    let lower = tool.to_ascii_lowercase();
    let text = if lower == "askuserquestion" {
        input
            .get("questions")
            .and_then(|q| q.as_array())
            .and_then(|a| a.first())
            .and_then(|q| str_field(q, "question"))
    } else if lower == "request_user_input" {
        input
            .get("questions")
            .and_then(|q| q.as_array())
            .and_then(|a| a.first())
            .and_then(|q| str_field(q, "question").or_else(|| str_field(q, "header")))
            .or_else(|| pick(&["question", "prompt"]))
    } else if lower == "exitplanmode" {
        Some("Review the plan".to_string())
    } else {
        pick(&[
            "command",
            "cmd",
            "file_path",
            "path",
            "url",
            "pattern",
            "description",
            "prompt",
        ])
    };
    text.map(|t| clip(&t, 240))
}

fn to_event(pane: &str, agent: &str, p: &Value) -> Option<HookEvent> {
    let raw = str_field(p, "hook_event_name")?;
    let event: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    let tool_name = str_field(p, "tool_name");
    let detail = match (&tool_name, p.get("tool_input")) {
        (Some(t), Some(input)) => tool_detail(t, input),
        _ => None,
    };
    let agent_id = str_field(p, "agent_id").filter(|a| a != "main");
    Some(HookEvent {
        seq: 0,
        at: now_ms(),
        pane_id: pane.to_string(),
        agent: agent.to_string(),
        event,
        session_id: str_field(p, "session_id").unwrap_or_default(),
        agent_id,
        agent_type: str_field(p, "agent_type"),
        tool_name,
        tool_use_id: str_field(p, "tool_use_id").or_else(|| str_field(p, "call_id")),
        detail,
        notification_type: str_field(p, "notification_type"),
        message: str_field(p, "message")
            .or_else(|| str_field(p, "error_message"))
            .or_else(|| str_field(p, "error"))
            .map(|m| clip(&m, 400)),
        error_type: str_field(p, "error_type"),
        source: str_field(p, "source").or_else(|| str_field(p, "reason")),
        running_agents: p.get("background_tasks").and_then(|t| t.as_array()).map(|tasks| {
            tasks
                .iter()
                .filter(|t| {
                    str_field(t, "type").as_deref() == Some("subagent")
                        && str_field(t, "status").as_deref() == Some("running")
                })
                .filter_map(|t| str_field(t, "id"))
                .collect()
        }),
    })
}

/// Environment every PTY is spawned with. Empty when the listener isn't up,
/// which leaves the hooks inert for that pane.
pub fn pty_env(pane_id: &str) -> Vec<(&'static str, String)> {
    match LISTENER.get() {
        Some(l) => vec![
            (ENV_PANE, pane_id.to_string()),
            (ENV_PORT, l.port.to_string()),
            (ENV_TOKEN, l.token.clone()),
        ],
        None => Vec::new(),
    }
}

pub fn forget_pane(pane_id: &str) {
    replay().lock().unwrap().remove(pane_id);
}

/// Every buffered event, oldest first — replayed by a frontend that (re)loaded
/// while agents were already running.
#[tauri::command]
pub fn agent_hook_events() -> Vec<HookEvent> {
    let r = replay().lock().unwrap();
    let mut all: Vec<HookEvent> = r.values().flatten().cloned().collect();
    all.sort_by_key(|e| e.seq);
    all
}

// ------------------------------------------------------------------ installer

/// Hook events registered with each agent. Kept to what the status model uses:
/// every extra event is one more process spawn inside the agent's loop.
const CLAUDE_EVENTS: &[(&str, Option<&str>, bool)] = &[
    // (event, matcher, async)
    ("SessionStart", None, false),
    ("SessionEnd", None, false),
    ("UserPromptSubmit", None, false),
    // Only the tools that put a question in front of the user.
    ("PreToolUse", Some("AskUserQuestion|ExitPlanMode"), false),
    ("PermissionRequest", None, false),
    // After every tool: async, so it never slows the agent down. It only ever
    // clears the one permission it names, so arriving late is harmless.
    ("PostToolUse", None, true),
    ("PostToolUseFailure", None, true),
    ("Notification", None, false),
    ("Stop", None, false),
    ("StopFailure", None, false),
    ("SubagentStart", None, false),
    ("SubagentStop", None, false),
];

const CODEX_EVENTS: &[(&str, Option<&str>, bool)] = &[
    ("SessionStart", None, false),
    ("SessionEnd", None, false),
    ("UserPromptSubmit", None, false),
    ("PreToolUse", Some("request_user_input"), false),
    ("PermissionRequest", None, false),
    // Codex accepts `async` but doesn't run async PostToolUse hooks (0.156).
    ("PostToolUse", None, false),
    ("Stop", None, false),
    ("Interrupt", None, false),
    ("SubagentStart", None, false),
    ("SubagentStop", None, false),
];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookStatus {
    /// "installed", "removed", "absent" (agent not set up on this machine) or
    /// an error message.
    claude: String,
    codex: String,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".claude")))
}

fn codex_dir() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".codex")))
}

/// The executable hooks point at. A release build always claims the hooks for
/// itself; a dev build only fills them in when nothing usable is there, so
/// running `tauri dev` doesn't keep repointing (and re-trusting) them. Either
/// binary forwards identically, so whichever one is registered serves both.
fn hook_exe(existing: Option<&str>) -> Option<String> {
    let me = std::env::current_exe().ok()?;
    let me = me.to_string_lossy().replace('\\', "/");
    if cfg!(debug_assertions) {
        if let Some(cur) = existing {
            if Path::new(cur).is_file() {
                return Some(cur.to_string());
            }
        }
    }
    Some(me)
}

/// The command line each agent's hook shell needs to run us. Claude Code runs
/// hooks through Git Bash on Windows, Codex through PowerShell — where a quoted
/// path on its own is a string, not a command, hence the call operator.
fn hook_command(exe: &str, agent: &str) -> String {
    match agent {
        "codex" => format!("& \"{exe}\" {HOOK_ARG} {agent}"),
        _ => format!("\"{exe}\" {HOOK_ARG} {agent}"),
    }
}

fn is_ours(hook: &Value) -> bool {
    hook.get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| c.contains(HOOK_ARG))
}

/// The exe an existing registration points at, if any.
fn existing_exe(hooks: &Map<String, Value>) -> Option<String> {
    hooks.values().flat_map(|groups| groups.as_array().into_iter().flatten()).find_map(|g| {
        g.get("hooks")?.as_array()?.iter().find(|h| is_ours(h)).and_then(|h| {
            let c = h.get("command")?.as_str()?;
            let c = c.trim_start_matches('&').trim_start().strip_prefix('"')?;
            Some(c[..c.find('"')?].to_string())
        })
    })
}

/// Strips our entries from a `hooks` object, dropping groups and events that
/// end up empty — the user's own hooks are left exactly as they were.
fn strip_ours(hooks: &mut Map<String, Value>) {
    for groups in hooks.values_mut() {
        let Some(arr) = groups.as_array_mut() else { continue };
        for g in arr.iter_mut() {
            if let Some(hs) = g.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                hs.retain(|h| !is_ours(h));
            }
        }
        arr.retain(|g| {
            g.get("hooks")
                .and_then(|h| h.as_array())
                .is_none_or(|h| !h.is_empty())
        });
    }
    hooks.retain(|_, groups| groups.as_array().is_none_or(|a| !a.is_empty()));
}

fn add_ours(hooks: &mut Map<String, Value>, events: &[(&str, Option<&str>, bool)], command: &str) {
    for (event, matcher, is_async) in events {
        // Codex clamps these two to 3s and prints a warning in its UI otherwise.
        let timeout = if matches!(*event, "SessionEnd" | "Interrupt") { 3 } else { 10 };
        let mut handler = json!({ "type": "command", "command": command, "timeout": timeout });
        if *is_async {
            handler["async"] = json!(true);
        }
        let mut group = json!({ "hooks": [handler] });
        if let Some(m) = matcher {
            group["matcher"] = json!(m);
        }
        let slot = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        if let Some(arr) = slot.as_array_mut() {
            arr.push(group);
        }
    }
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("openterm-tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Rewrites the `hooks` object inside a JSON settings file, preserving
/// everything else (key order included). Writes nothing when unchanged, and
/// refuses to touch a file it can't parse rather than risk clobbering it.
fn sync_json_hooks(
    path: &Path,
    enable: bool,
    agent: &str,
    events: &[(&str, Option<&str>, bool)],
) -> Result<bool, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !enable {
                return Ok(false);
            }
            "{}".to_string()
        }
        Err(e) => return Err(e.to_string()),
    };
    let trimmed = text.trim_start_matches('\u{feff}');
    let mut root: Value = if trimmed.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(trimmed).map_err(|e| format!("{} isn't valid JSON ({e})", path.display()))?
    };
    let Some(obj) = root.as_object_mut() else {
        return Err(format!("{} isn't a JSON object", path.display()));
    };
    let before = obj.get("hooks").cloned();
    let mut hooks = match obj.get("hooks") {
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err(format!("{}: \"hooks\" isn't an object", path.display())),
        None => Map::new(),
    };
    let exe = existing_exe(&hooks);
    strip_ours(&mut hooks);
    if enable {
        let exe = hook_exe(exe.as_deref()).ok_or("can't locate the OpenTerm executable")?;
        add_ours(&mut hooks, events, &hook_command(&exe, agent));
    }
    let after = if hooks.is_empty() { None } else { Some(Value::Object(hooks)) };
    if before == after {
        return Ok(false);
    }
    match after {
        Some(h) => {
            obj.insert("hooks".into(), h);
        }
        None => {
            obj.remove("hooks");
        }
    }
    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    write_atomic(path, &(out + "\n"))?;
    Ok(true)
}

/// Installs or removes our hooks for both agents. Agents that aren't set up on
/// this machine (no config dir) are left alone.
#[tauri::command]
pub async fn agent_hooks_sync(enabled: bool) -> AgentHookStatus {
    tauri::async_runtime::spawn_blocking(move || sync_blocking(enabled))
        .await
        .unwrap_or_default()
}

fn sync_blocking(enabled: bool) -> AgentHookStatus {
    let verb = if enabled { "installed" } else { "removed" };
    let claude = match claude_dir() {
        Some(d) if d.is_dir() => match sync_json_hooks(&d.join("settings.json"), enabled, "claude", CLAUDE_EVENTS) {
            Ok(_) => verb.to_string(),
            Err(e) => e,
        },
        _ => "absent".to_string(),
    };
    let codex = match codex_dir() {
        Some(d) if d.is_dir() => {
            let path = d.join("hooks.json");
            // Asking Codex costs a second of a background process, so only when
            // the hooks just changed or no trust for them is on record yet.
            let on_record = std::fs::read_to_string(d.join("config.toml"))
                .is_ok_and(|t| t.contains("hooks.json:session_start:"));
            match sync_json_hooks(&path, enabled, "codex", CODEX_EVENTS) {
                Ok(changed) if enabled && (changed || !on_record) => match trust_codex_hooks() {
                    Ok(()) => verb.to_string(),
                    Err(e) => format!("installed, but couldn't trust them: {e}"),
                },
                Ok(_) => verb.to_string(),
                Err(e) => e,
            }
        }
        _ => "absent".to_string(),
    };
    AgentHookStatus { claude, codex }
}

/// Codex skips user hooks until they've been reviewed in `/hooks`, recording
/// the approval as a hash of the hook. Asking Codex itself — `hooks/list` for
/// the current hashes, `config/value/write` to record them — is exactly what
/// that review does, so it stays correct if Codex changes how it hashes.
/// Only our own entries are trusted; the user's are never touched.
fn trust_codex_hooks() -> Result<(), String> {
    let mut child = Command::new("cmd")
        .args(["/D", "/C", "codex", "app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("couldn't start codex: {e}"))?;
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v.get("id").is_some() && tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut call = |id: u64, method: &str, params: Value| -> Result<Value, String> {
            let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
            writeln!(stdin, "{msg}").map_err(|e| e.to_string())?;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                let v = rx.recv_timeout(left).map_err(|_| format!("codex didn't answer {method}"))?;
                if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
                    if let Some(err) = v.get("error") {
                        return Err(format!("{method}: {err}"));
                    }
                    if method == "initialize" {
                        // The handshake's second half: a notification, no reply.
                        let done = json!({ "jsonrpc": "2.0", "method": "initialized" });
                        writeln!(stdin, "{done}").map_err(|e| e.to_string())?;
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        };
        call(1, "initialize", json!({ "clientInfo": { "name": "openterm", "version": env!("CARGO_PKG_VERSION") } }))?;
        let list = call(2, "hooks/list", json!({}))?;
        let mut id = 10;
        for entry in list.get("data").and_then(|d| d.as_array()).into_iter().flatten() {
            for h in entry.get("hooks").and_then(|h| h.as_array()).into_iter().flatten() {
                let ours = h.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.contains(HOOK_ARG));
                let trusted = h.get("trustStatus").and_then(|s| s.as_str()) == Some("trusted");
                let (Some(key), Some(hash)) = (
                    h.get("key").and_then(|k| k.as_str()),
                    h.get("currentHash").and_then(|k| k.as_str()),
                ) else {
                    continue;
                };
                if !ours || trusted {
                    continue;
                }
                id += 1;
                // keyPath segments are dot-separated; the key (a file path plus
                // `:event:i:j`) goes in as one quoted segment.
                let key_path = format!("hooks.state.{}.trusted_hash", serde_json::to_string(key).unwrap());
                call(id, "config/value/write", json!({ "keyPath": key_path, "value": hash, "mergeStrategy": "upsert" }))?;
            }
        }
        Ok(())
    })();
    // Our end of stdin is closed by now, which ends the server on its own; the
    // kill only covers one that hangs.
    let give_up = Instant::now() + Duration::from_secs(3);
    while Instant::now() < give_up {
        if let Ok(Some(_)) = child.try_wait() {
            return result;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ot-hooks-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("settings.json");
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn install_keeps_user_hooks_and_key_order_and_is_idempotent() {
        let user = r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]},"theme":"dark"}"#;
        let p = tmp("install", user);
        assert!(sync_json_hooks(&p, true, "claude", CLAUDE_EVENTS).unwrap());
        let once = std::fs::read_to_string(&p).unwrap();
        // Second run: nothing to change, nothing written.
        assert!(!sync_json_hooks(&p, true, "claude", CLAUDE_EVENTS).unwrap());
        assert_eq!(once, std::fs::read_to_string(&p).unwrap());

        let v: Value = serde_json::from_str(&once).unwrap();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "hooks", "theme"]);
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop[0]["hooks"][0]["command"], "say done");
        assert!(stop[1]["hooks"][0]["command"].as_str().unwrap().contains("--agent-hook claude"));
        assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], "AskUserQuestion|ExitPlanMode");
        assert_eq!(v["hooks"]["PostToolUse"][0]["hooks"][0]["async"], true);

        // Removing restores the user's file exactly (modulo formatting).
        assert!(sync_json_hooks(&p, false, "claude", CLAUDE_EVENTS).unwrap());
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(back, serde_json::from_str::<Value>(user).unwrap());
    }

    #[test]
    fn refuses_unparseable_settings() {
        let p = tmp("bad", "{ // comment\n \"a\": 1 }");
        assert!(sync_json_hooks(&p, true, "claude", CLAUDE_EVENTS).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{ // comment\n \"a\": 1 }");
    }

    #[test]
    fn codex_command_uses_call_operator() {
        assert!(hook_command("C:/x/openterm.exe", "codex").starts_with("& \"C:/x/openterm.exe\""));
        let mut m = Map::new();
        add_ours(&mut m, CODEX_EVENTS, &hook_command("C:/x/openterm.exe", "codex"));
        assert_eq!(existing_exe(&m).as_deref(), Some("C:/x/openterm.exe"));
        assert_eq!(m["SessionEnd"][0]["hooks"][0]["timeout"], 3);
    }

    #[test]
    fn events_carry_what_the_ui_needs() {
        let perm = json!({"hook_event_name":"PermissionRequest","session_id":"s","tool_name":"Bash",
            "tool_input":{"command":"npm   test\n --watch"},"tool_use_id":"t1","agent_id":"main"});
        let e = to_event("p", "claude", &perm).unwrap();
        assert_eq!(e.event, "permissionrequest");
        assert_eq!(e.detail.as_deref(), Some("npm test --watch"));
        assert_eq!(e.agent_id, None);
        let q = json!({"hook_event_name":"PreToolUse","session_id":"s","tool_name":"AskUserQuestion",
            "tool_input":{"questions":[{"question":"Which DB?","options":[]}]}});
        assert_eq!(to_event("p", "claude", &q).unwrap().detail.as_deref(), Some("Which DB?"));
        let stop = json!({"hook_event_name":"Stop","session_id":"s","background_tasks":[
            {"id":"a1","type":"subagent","status":"running"},{"id":"b","type":"shell","status":"running"},
            {"id":"a2","type":"subagent","status":"completed"}]});
        assert_eq!(to_event("p", "claude", &stop).unwrap().running_agents, Some(vec!["a1".to_string()]));
    }
}
