#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Tauri commands receive their parameters flat, one per argument, so the
// wider ones sit above clippy's threshold by construction.
#![allow(clippy::too_many_arguments)]

use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    sync::{
        atomic::{AtomicIsize, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewWindow, WindowEvent};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, GetMonitorInfoW, MonitorFromWindow, ScreenToClient, MONITORINFO,
    MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, EnumChildWindows, FlashWindowEx, GetAncestor, GetClassNameW,
    GetForegroundWindow, GetMessageW,
    GetParent, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, SetParent, SetWindowLongPtrW,
    SetWindowPos, SetWindowsHookExW, ShowWindow, TranslateMessage, WindowFromPoint, FLASHWINFO,
    FLASHW_TIMERNOFG, FLASHW_TRAY, GA_ROOT, GWL_STYLE, HHOOK, HWND_TOP, MSG, MSLLHOOKSTRUCT,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNORMAL,
    WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WS_CAPTION, WS_CHILD,
    WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
};
// ScreenToClient is imported from Graphics::Gdi above.

mod browser;
mod dictation;
mod git;
mod harness;
mod shell_integration;
mod usage;

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct PtyManager(Mutex<HashMap<String, PtyHandle>>);

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    shell: String,
    cwd: Option<String>,
    args: Option<Vec<String>>,
    fallback_cwd: Option<String>,
) -> Result<bool, String> {
    {
        // Already running (e.g. a re-render or dev-mode reload re-requested it) —
        // keep the existing one and tell the caller nothing new was spawned, so it
        // doesn't retype a resume command into a session that's already live.
        let map = manager.0.lock().unwrap();
        if map.contains_key(&id) {
            return Ok(false);
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = if shell.trim().is_empty() {
        "powershell.exe".to_string()
    } else {
        shell
    };
    let mut cmd = CommandBuilder::new(&shell);
    let shell_stem = std::path::Path::new(&shell)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if let Some(a) = args {
        cmd.args(a);
    } else if shell_stem == "powershell" || shell_stem == "pwsh" {
        // Report the working directory (OSC 9;9) at every prompt so the pane
        // can be reopened where it was. Wraps — rather than replaces — whatever
        // prompt the profile set up (oh-my-posh etc.); the original runs first so
        // it still sees the previous command's `$?`. No double quotes: they'd
        // need escaping through the Windows command line.
        cmd.args([
            "-NoExit",
            "-Command",
            "$global:__openTermPrompt = $function:prompt; function global:prompt { $out = & $global:__openTermPrompt; $loc = $executionContext.SessionState.Path.CurrentLocation; if ($loc.Provider.Name -eq 'FileSystem') { Write-Host -NoNewline ([char]27 + ']9;9;' + $loc.ProviderPath + [char]7) }; $out }",
        ]);
    }
    if shell_stem == "cmd" {
        let prompt = std::env::var("PROMPT").unwrap_or_else(|_| "$P$G".to_string());
        if !prompt.contains("]9;9;") {
            cmd.env("PROMPT", format!("$E]9;9;$P$E\\{prompt}"));
        }
    }
    cmd.env("TERM", "xterm-256color");
    let dir = [cwd, fallback_cwd]
        .into_iter()
        .flatten()
        .find(|c| !c.trim().is_empty() && std::path::Path::new(c).is_dir())
        .or_else(|| std::env::var("USERPROFILE").ok());
    if let Some(d) = dir.clone() {
        cmd.cwd(d);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Publish the shell's PID so usage accounting can walk its process tree and
    // spot which AI agent CLIs get launched inside this pane.
    if let Some(pid) = child.process_id() {
        usage::register_pty(id.clone(), pid, dir);
    }

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    manager.0.lock().unwrap().insert(
        id.clone(),
        PtyHandle {
            master: pair.master,
            writer,
            child,
        },
    );

    let reader_app = app.clone();
    let reader_id = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = reader_app.emit(
                        "pty-output",
                        PtyOutput {
                            id: reader_id.clone(),
                            data,
                        },
                    );
                }
            }
        }
        if let Some(m) = reader_app.try_state::<PtyManager>() {
            m.0.lock().unwrap().remove(&reader_id);
        }
        // Stop polling this shell's process tree; its recorded usage links stay
        // so the pane keeps the spend history the exited agent produced.
        usage::unregister_pty(&reader_id);
        let _ = reader_app.emit("pty-exit", PtyExit { id: reader_id });
    });

    Ok(true)
}

#[tauri::command]
fn write_pty(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut map = manager.0.lock().unwrap();
    if let Some(h) = map.get_mut(&id) {
        h.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether a CLI can be launched by a newly-created terminal. This mirrors
/// Windows' executable lookup without starting the program. Standard agent
/// install directories are checked separately because an app that was already
/// open does not inherit user PATH changes made by an installer.
#[tauri::command]
fn command_exists(command: String) -> bool {
    let command = command.trim();
    if command.is_empty()
        || !command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return false;
    }

    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();

    let exists_in = |dir: &std::path::Path| {
        if dir.join(command).is_file() {
            return true;
        }
        extensions
            .iter()
            .any(|ext| dir.join(format!("{command}{ext}")).is_file())
    };

    if std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| exists_in(&dir)))
        .unwrap_or(false)
    {
        return true;
    }

    let default_dir = if command.eq_ignore_ascii_case("grok") {
        std::env::var_os("USERPROFILE")
            .map(|home| std::path::PathBuf::from(home).join(".grok").join("bin"))
    } else if command.eq_ignore_ascii_case("cursor-agent") {
        std::env::var_os("LOCALAPPDATA")
            .map(|local| std::path::PathBuf::from(local).join("cursor-agent"))
    } else {
        None
    };

    default_dir.map(|dir| exists_in(&dir)).unwrap_or(false)
}

#[tauri::command]
fn resize_pty(manager: State<'_, PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = manager.0.lock().unwrap();
    if let Some(h) = map.get(&id) {
        h.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn kill_pty(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let handle = manager.0.lock().unwrap().remove(&id);
    if let Some(mut h) = handle {
        let _ = h.child.kill();
    }
    usage::unregister_pty(&id);
    Ok(())
}

/// The monitor's usable work area in physical screen pixels — unlike the
/// monitor's full size, this already excludes the taskbar (whatever its
/// height/position/auto-hide state), so it's the correct bound for a
/// maximized window rather than a guessed pixel margin.
fn work_area(hwnd: HWND) -> Option<RECT> {
    unsafe {
        let hmonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        GetMonitorInfoW(hmonitor, &mut info)
            .as_bool()
            .then_some(info.rcWork)
    }
}

/// Clamps the window into its monitor's work area if it currently overflows
/// it (e.g. an oversized default window on a small display). No-ops once
/// already inside, so this is safe to call from a Resized handler without
/// looping.
///
/// Skips genuinely maximized windows: Windows intentionally reports a
/// maximized window's outer bounds a few pixels past the monitor edges (to
/// tuck the invisible resize border off-screen via DWM), so this would
/// otherwise misread a correctly-maximized window as overflowing and
/// silently un-maximize it to a slightly-too-small restored size.
fn clamp_to_work_area(window: &WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(hwnd) = window.hwnd() else { return };
    let Some(work) = work_area(hwnd) else { return };
    let (Ok(cur_size), Ok(cur_pos)) = (window.outer_size(), window.outer_position()) else {
        return;
    };

    let work_w = (work.right - work.left) as u32;
    let work_h = (work.bottom - work.top) as u32;
    let target_w = cur_size.width.min(work_w);
    let target_h = cur_size.height.min(work_h);
    let target_x = cur_pos.x.max(work.left).min(work.right - target_w as i32);
    let target_y = cur_pos.y.max(work.top).min(work.bottom - target_h as i32);

    if cur_size.width != target_w || cur_size.height != target_h {
        let _ = window.set_size(PhysicalSize::new(target_w, target_h));
    }
    if cur_pos.x != target_x || cur_pos.y != target_y {
        let _ = window.set_position(PhysicalPosition::new(target_x, target_y));
    }
}

fn state_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

/// Rotating "last N saves" ring kept in app_data_dir/backups. Any single bad
/// action (or bad write) can be stepped back through these.
const BACKUP_RING_SIZE: usize = 30;
/// Minimum wall-clock gap between two ring *rotations*. Saves that land inside
/// the window overwrite slot 1 instead of pushing a new entry, so 30 slots hold
/// 30 distinct moments rather than 30 fragments of one busy minute.
const RING_MIN_INTERVAL_SECS: u64 = 45;
/// Safety copy written just before a user-driven restore, so a restore that
/// turns out to be wrong is itself undoable.
const PRE_RESTORE_NAME: &str = "state-pre-restore.json";
/// One snapshot per day, newest 7 kept — survives even a week of the ring
/// being overwritten while the user is away.
const DAILY_KEEP: usize = 7;

/// Days-since-epoch → YYYY-MM-DD (UTC), Howard Hinnant's civil-from-days.
/// Avoids pulling in a date crate just to name daily snapshot files.
fn utc_date_string() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Reads a file only if it exists AND parses as JSON — a truncated/corrupt
/// candidate must never be handed back as if it were good state.
fn read_valid_json(path: &std::path::Path) -> Option<String> {
    let s = fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&s).ok()?;
    Some(s)
}

/// The session names inside a state file, in order. Used both to decide when a
/// save deserves its own ring slot and to describe a backup in the UI without
/// shipping whole files to the frontend. A missing/corrupt file yields None, so
/// it never compares equal to a real state.
fn session_names_of(path: &std::path::Path) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    Some(
        v["sessions"]
            .as_array()?
            .iter()
            .map(|s| s["name"].as_str().unwrap_or("Untitled").to_string())
            .collect(),
    )
}

/// Counts pane leaves in a persisted pane tree (`{type:"split",children:[…]}`
/// nesting around `{type:"leaf"}`), so a backup row can say how much was open.
fn count_leaves(node: &serde_json::Value) -> usize {
    match node["children"].as_array() {
        Some(children) => children.iter().map(count_leaves).sum(),
        None => usize::from(node["type"] == "leaf"),
    }
}

/// Maintains both backup layers after a successful save. Best-effort: any
/// failure here must never fail the save itself.
/// Returns true when this save also produced today's daily snapshot (first
/// save of the day), so the UI can surface one subtle notice per day.
fn write_backups(path: &std::path::Path) -> bool {
    let Some(dir) = path.parent() else { return false };
    let dir = dir.join("backups");
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }

    // Rotate the ring only when this save is its own "moment": the first save
    // of the run, one far enough after the previous rotation, or one that
    // changed the session line-up (added/removed/renamed) — those are exactly
    // the states a user would want to step back to. Everything else overwrites
    // slot 1 so a burst of saves can't flush the ring.
    let slot1 = dir.join("state-last-1.json");
    let rotate = {
        static LAST_ROTATE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
        let cell = LAST_ROTATE.get_or_init(|| Mutex::new(None));
        let mut last = cell.lock().unwrap();
        let structural = session_names_of(&slot1) != session_names_of(path);
        let due = match *last {
            None => true,
            Some(t) => t.elapsed().as_secs() >= RING_MIN_INTERVAL_SECS,
        };
        let rotate = !slot1.exists() || due || structural;
        if rotate {
            *last = Some(Instant::now());
        }
        rotate
    };
    if rotate {
        for i in (1..BACKUP_RING_SIZE).rev() {
            let _ = fs::rename(
                dir.join(format!("state-last-{i}.json")),
                dir.join(format!("state-last-{}.json", i + 1)),
            );
        }
    }
    let _ = fs::copy(path, &slot1);

    // Daily snapshot: first save of a (UTC) day writes today's file.
    let today = utc_date_string();
    let todays = dir.join(format!("state-daily-{today}.json"));
    if todays.exists() {
        return false;
    }
    if fs::copy(path, &todays).is_err() {
        return false;
    }
    // Retention: keep only the newest DAILY_KEEP daily snapshots.
    let mut dailies: Vec<(String, std::path::PathBuf)> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let date = name.strip_prefix("state-daily-")?.strip_suffix(".json")?.to_string();
            Some((date, e.path()))
        })
        .collect();
    dailies.sort();
    for (_, p) in dailies.iter().rev().skip(DAILY_KEEP) {
        let _ = fs::remove_file(p);
    }
    true
}

/// Writes `json` to `path` through a temp file + rename, so a reader never sees
/// a half-written state. OneDrive/AV/indexers briefly hold the destination now
/// and then; the swap is retried instead of failing the whole write (this runs
/// async off the UI thread, so the short backoff is harmless).
async fn write_state_atomic(path: &std::path::Path, json: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    let mut last_err = None;
    for delay_ms in [0u64, 100, 250, 500] {
        if delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        match fs::rename(&tmp, path) {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    if let Some(e) = last_err {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

#[derive(Serialize)]
struct SaveResult {
    /// True when this save also produced today's daily snapshot — drives the
    /// once-per-day "daily backup saved" inbox notice.
    #[serde(rename = "dailyBackupCreated")]
    daily_backup_created: bool,
}

#[tauri::command]
async fn save_state(app: AppHandle, json: String) -> Result<SaveResult, String> {
    // Never overwrite the live file with something we couldn't read back.
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("refusing to save invalid state JSON: {e}"))?;

    let path = state_path(&app)?;
    write_state_atomic(&path, &json).await?;

    let daily = write_backups(&path);
    Ok(SaveResult { daily_backup_created: daily })
}

#[derive(Serialize)]
struct LoadedState {
    json: Option<String>,
    /// True when the primary state.json was missing or corrupt and a backup
    /// was used instead — drives the "restored from backup" notice.
    #[serde(rename = "recoveredFromBackup")]
    recovered_from_backup: bool,
}

#[tauri::command]
fn load_state(app: AppHandle) -> LoadedState {
    let path = match state_path(&app) {
        Ok(p) => p,
        Err(_) => return LoadedState { json: None, recovered_from_backup: false },
    };
    if let Some(s) = read_valid_json(&path) {
        return LoadedState { json: Some(s), recovered_from_backup: false };
    }

    // Primary is gone or unreadable: walk backups newest-first (ring, then
    // daily snapshots) and restore the first one that parses cleanly.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = path.parent().map(|p| p.join("backups")) {
        for i in (1..=BACKUP_RING_SIZE).rev() {
            candidates.push(dir.join(format!("state-last-{i}.json")));
        }
        if let Ok(entries) = fs::read_dir(&dir) {
            let mut dailies: Vec<(String, std::path::PathBuf)> = entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let date = name.strip_prefix("state-daily-")?.strip_suffix(".json")?.to_string();
                    Some((date, e.path()))
                })
                .collect();
            dailies.sort();
            candidates.extend(dailies.into_iter().rev().map(|(_, p)| p));
        }
    }
    for c in candidates {
        if let Some(s) = read_valid_json(&c) {
            return LoadedState { json: Some(s), recovered_from_backup: true };
        }
    }
    LoadedState { json: None, recovered_from_backup: false }
}

#[tauri::command]
fn state_file_path(app: AppHandle) -> Result<String, String> {
    Ok(state_path(&app)?.to_string_lossy().to_string())
}

// ------------------------------------------------------------ backup timeline

/// One row of the backup browser. Everything here is derived at list time from
/// the file itself, so there's no index to go stale — and the frontend can
/// search names and timestamps without ever loading a whole state file.
#[derive(Serialize, Clone)]
struct BackupInfo {
    filename: String,
    /// "ring" (rotating per-action), "daily", or "pre-restore".
    kind: String,
    /// Milliseconds since the epoch, from the file's modification time.
    #[serde(rename = "createdAt")]
    created_at: u64,
    #[serde(rename = "sizeBytes")]
    size_bytes: u64,
    #[serde(rename = "sessionNames")]
    session_names: Vec<String>,
    #[serde(rename = "paneCount")]
    pane_count: usize,
    /// 1 = newest ring slot. None for daily/pre-restore files.
    #[serde(rename = "ringSlot")]
    ring_slot: Option<u32>,
    /// False when the file no longer parses — shown, but not restorable.
    valid: bool,
}

fn backups_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = state_path(app)?
        .parent()
        .ok_or_else(|| "no app data dir".to_string())?
        .join("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn describe_backup(path: &std::path::Path) -> Option<BackupInfo> {
    let filename = path.file_name()?.to_string_lossy().to_string();
    let meta = fs::metadata(path).ok()?;
    let created_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let ring_slot = filename
        .strip_prefix("state-last-")
        .and_then(|s| s.strip_suffix(".json"))
        .and_then(|s| s.parse::<u32>().ok());
    let kind = if ring_slot.is_some() {
        "ring"
    } else if filename.starts_with("state-daily-") {
        "daily"
    } else {
        "pre-restore"
    };

    let parsed: Option<serde_json::Value> = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let (session_names, pane_count) = match parsed.as_ref().and_then(|v| v["sessions"].as_array()) {
        Some(sessions) => (
            sessions
                .iter()
                .map(|s| s["name"].as_str().unwrap_or("Untitled").to_string())
                .collect(),
            sessions.iter().map(|s| count_leaves(&s["tree"])).sum(),
        ),
        None => (Vec::new(), 0),
    };

    Some(BackupInfo {
        filename,
        kind: kind.to_string(),
        created_at,
        size_bytes: meta.len(),
        session_names,
        pane_count,
        ring_slot,
        valid: parsed.is_some(),
    })
}

/// Every backup on disk, newest first. Ring slots that share a timestamp keep
/// their slot order (slot 1 is the most recent of the two).
#[tauri::command]
fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = backups_dir(&app)?;
    let mut out: Vec<BackupInfo> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .map(|n| {
                        let n = n.to_string_lossy();
                        n.starts_with("state-") && n.ends_with(".json")
                    })
                    .unwrap_or(false)
        })
        .filter_map(|p| describe_backup(&p))
        .collect();
    out.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.ring_slot.unwrap_or(u32::MAX).cmp(&b.ring_slot.unwrap_or(u32::MAX)))
    });
    Ok(out)
}

/// Replaces state.json with a backup, after stashing the current state in
/// `state-pre-restore.json` so the restore itself can be undone. The caller is
/// expected to reload the frontend afterwards — this only touches disk.
#[tauri::command]
async fn restore_backup(app: AppHandle, filename: String) -> Result<(), String> {
    // Never let a name walk out of the backups directory.
    if filename.contains(['/', '\\', ':']) || !filename.starts_with("state-") || !filename.ends_with(".json") {
        return Err(format!("not a backup file: {filename}"));
    }
    let dir = backups_dir(&app)?;
    let src = dir.join(&filename);
    let json = read_valid_json(&src)
        .ok_or_else(|| format!("{filename} is missing or no longer readable"))?;

    let path = state_path(&app)?;
    // Best-effort safety copy: a restore over an unreadable current state is
    // still worth doing, there's just nothing meaningful to stash.
    if read_valid_json(&path).is_some() {
        let _ = fs::copy(&path, dir.join(PRE_RESTORE_NAME));
    }
    write_state_atomic(&path, &json).await
}

/// Picks the backup that best matches a plain-language description of what the
/// user lost ("the OpenTerm session"). Only the metadata rows from
/// `list_backups` are sent — timestamps and session names, never file contents.
#[tauri::command]
async fn find_in_backups(api_key: String, query: String, candidates: String) -> Result<String, String> {
    const FIND_SYSTEM: &str = "You help a user find the right backup of their terminal-workspace app. You get a description of what they lost and a JSON array of backups, each with a filename, an ISO timestamp and the session names it contains. Pick the NEWEST backup that plausibly contains what they describe — newest matters, because older ones lose more recent work. Match loosely on session names (case-insensitive, partial words, typos), and use the timestamps when the user refers to time (\"this morning\", \"before lunch\"). Reply with ONLY a JSON object: {\"bestBackup\": string|null, \"confidence\": \"high\"|\"medium\"|\"low\", \"reason\": string, \"runnersUp\": string[]}. \"bestBackup\" is a filename copied exactly from the candidates, or null if none is plausible. \"reason\" is one short sentence naming what matched. \"runnersUp\" holds at most 3 other candidate filenames worth a look, newest first. Never invent a filename. No markdown, no code fences.";

    let user = format!("What the user is looking for:\n{query}\n\nCandidates (newest first):\n{candidates}");
    openrouter_chat(&api_key, FIND_SYSTEM, &user, 400, 30).await
}

/// Refines a delegated task's prompt via OpenRouter before it's handed to an
/// agent CLI. Runs here (not the webview) so there's no CORS/origin exposure
/// and the API key never has to fight browser fetch rules. When delegation
/// moves behind a subscription, this command becomes the backend call.
#[tauri::command]
async fn enhance_prompt(api_key: String, prompt: String) -> Result<String, String> {
    const ENHANCE_SYSTEM: &str = "You prepare tasks for hand-off to an autonomous AI coding agent working in a terminal. Rewrite the user's task so the agent understands exactly what was wanted: Clarify vague wording and state the goal plainly. Add any helpful context you can infer from the task itself. Keep it medium length: short enough to paste into a CLI, complete enough to act on. If anything important is genuinely ambiguous or missing, add a short final section titled \"Questions for the user:\" listing what the agent should ask before proceeding. Do not invent requirements. Output only the rewritten task text.";

    openrouter_chat(&api_key, ENHANCE_SYSTEM, &prompt, 1200, 45).await
}

/// Turns a raw terminal notification (a prompt line, an error line — whatever
/// the program happened to print) into a short name and one-line description,
/// returned as a JSON object. Same model and plumbing as `enhance_prompt`;
/// separate command so the two prompts can drift apart independently.
#[tauri::command]
async fn name_notification(api_key: String, context: String) -> Result<String, String> {
    const NAME_SYSTEM: &str = "You turn raw terminal output into a readable desktop notification. You are given the notification type and the terminal text that triggered it, which may contain box-drawing characters, menu UI, prompt glyphs or a stack trace. Reply with ONLY a JSON object: {\"title\": string, \"summary\": string}. \"title\" is a specific name for what happened, at most 6 words, no trailing punctuation (e.g. \"Claude wants to run git push\", \"Vite build failed: missing import\"). \"summary\" is one plain sentence, at most 140 characters, saying what happened and what the user is being asked to do, if anything. Use only information present in the output — never invent a program name, file or error. Strip decorative characters. If the output is too garbled to interpret, title it \"Terminal needs attention\" and describe what little is legible. No markdown, no code fences.";

    // Small budget on purpose: the reply is two short strings, and a cap keeps
    // a model that starts rambling from stalling the notification.
    openrouter_chat(&api_key, NAME_SYSTEM, &context, 300, 20).await
}

/// Shared OpenRouter chat-completion call: one system prompt, one user message,
/// content string back. Errors carry the HTTP status and OpenRouter's own
/// message so a bad key or a rate limit is distinguishable in the UI.
async fn openrouter_chat(
    api_key: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
    timeout_secs: u64,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "model": "deepseek/deepseek-v4-flash",
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });

    let resp = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("bad response: {e}"))?;
    if !status.is_success() {
        let detail = v["error"]["message"].as_str().unwrap_or("");
        return Err(format!("OpenRouter {} {}", status.as_u16(), detail));
    }
    let text = v["choices"][0]["message"]["content"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "OpenRouter returned an empty response".to_string())?;
    Ok(text.to_string())
}

#[derive(Clone, Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Clone, Serialize)]
struct DirListing {
    path: String,
    entries: Vec<FileEntry>,
}

#[tauri::command]
fn list_dir(path: Option<String>) -> Result<DirListing, String> {
    let dir = match path {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => std::env::var("USERPROFILE")
            .map(std::path::PathBuf::from)
            .map_err(|e| e.to_string())?,
    };
    let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut entries: Vec<FileEntry> = rd
        .flatten()
        .map(|entry| {
            let p = entry.path();
            let is_dir = p.is_dir();
            FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: p.to_string_lossy().to_string(),
                is_dir,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(DirListing {
        path: dir.to_string_lossy().to_string(),
        entries,
    })
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 3_000_000 {
        return Err("File is too large to preview (>3MB).".to_string());
    }
    fs::read_to_string(&path)
        .map_err(|_| "Can't preview this file (not text, or unsupported encoding).".to_string())
}

/// Reads a whole file as base64, for previewing formats the frontend has to
/// parse itself (Office documents). Media (images/video/PDF) goes through the
/// asset protocol instead, so it streams rather than landing in memory.
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 64_000_000 {
        return Err("File is too large to preview (>64MB).".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let tmp_path = format!("{path}.tmp");
    fs::write(&tmp_path, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens Explorer with the given file or folder pre-selected, for the sidebar
/// file browser's "Open in Explorer" context-menu action.
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if std::path::Path::new(&to).exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Sends a file or folder to the Recycle Bin (rather than a permanent delete)
/// so a mistaken click from the sidebar's context menu stays recoverable.
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Soft two-note chime played when a pane needs the user's attention (a
/// confirmation/permission prompt was detected). Played directly on the audio
/// device from the Rust side — rather than an `<audio>` element in the webview
/// — so it still sounds when the window is minimized or unfocused.
static ATTENTION_SOUND: &[u8] = include_bytes!("../sounds/attention.wav");

/// Plays the attention chime. If `path` names a readable, decodable audio
/// file, that's played instead of the built-in chime — this is how a user's
/// custom sound (picked in Settings) takes over. Any failure to read/decode
/// the custom file silently falls back to the built-in chime, so a moved or
/// deleted custom file never leaves the user without a notification sound.
#[tauri::command]
fn play_attention_sound(path: Option<String>) {
    thread::spawn(move || {
        let Ok((_stream, handle)) = rodio::OutputStream::try_default() else {
            return;
        };
        let Ok(sink) = rodio::Sink::try_new(&handle) else {
            return;
        };

        let custom_bytes = path.and_then(|p| fs::read(p).ok());
        sink.set_volume(0.4);
        match custom_bytes.and_then(|bytes| rodio::Decoder::new(std::io::Cursor::new(bytes)).ok()) {
            Some(source) => sink.append(source),
            None => {
                let Ok(fallback) = rodio::Decoder::new(std::io::Cursor::new(ATTENTION_SOUND)) else {
                    return;
                };
                sink.append(fallback);
            }
        }
        sink.sleep_until_end();
    });
}

/// Flash the taskbar button for the main window. Used alongside the chime so
/// a pane waiting on input is obvious even when OpenTerm is minimized or
/// behind other windows. `FLASHW_TIMERNOFG` keeps it flashing until the user
/// actually switches to the window, then Windows stops it automatically.
#[tauri::command]
fn flash_taskbar_icon() {
    let raw = APP_HWND.load(Ordering::Relaxed);
    if raw == 0 {
        return;
    }
    let hwnd = HWND(raw as *mut _);
    let info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd,
        dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG,
        uCount: u32::MAX,
        dwTimeout: 0,
    };
    unsafe {
        let _ = FlashWindowEx(&info);
    }
}

// ===================================================================
//  External terminal drag-in & window embedding (Windows only)
// ===================================================================
//
// Windows offers no cross-process notification when the user drags another
// app's window. To let a terminal opened outside OpenTerm be dragged onto a
// pane, we install a global low-level mouse hook that watches for a *foreign
// terminal window* being grabbed and dragged over our window, and stream the
// gesture to the frontend as events. On drop, the frontend calls
// `embed_external_window`, which reparents the HWND into our window.

/// Our main window's HWND, published for the hook thread. 0 until set.
pub static APP_HWND: AtomicIsize = AtomicIsize::new(0);

/// The main window's *own* WebView2 host child (wry hosts each webview in a
/// `WRY_WEBVIEW` child window). Captured at startup, before any browser pane
/// exists, so we never confuse it with a pane's webview later. 0 until set.
pub static MAIN_WEBVIEW_HWND: AtomicIsize = AtomicIsize::new(0);

/// First (and, at startup, only) `WRY_WEBVIEW` child of our window.
fn find_main_webview(parent: HWND) -> Option<HWND> {
    unsafe extern "system" fn cb(child: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut isize);
        let mut cls = [0u16; 32];
        let n = unsafe { GetClassNameW(child, &mut cls) };
        if String::from_utf16_lossy(&cls[..n.max(0) as usize]) == "WRY_WEBVIEW" {
            *out = child.0 as isize;
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut found: isize = 0;
    unsafe {
        let _ = EnumChildWindows(Some(parent), Some(cb), LPARAM(&mut found as *mut isize as isize));
    }
    (found != 0).then(|| hwnd(found))
}

/// Hands keyboard focus back to the main webview.
///
/// When you alt-tab away and come back, Windows restores activation to our
/// top-level window but not necessarily to the WebView2 child that actually
/// receives keystrokes — especially once embedded external terminals or
/// browser-pane webviews (all children of the same window) have held focus.
/// The DOM then sees no key events at all, so neither typing nor the app's
/// keybinds (nor the Enter-to-refocus fallback) can work until you click.
/// Forcing focus onto the webview on every activation removes that dead state.
/// Must run on the main thread: `SetFocus` only works within the thread that
/// owns the window's message queue.
pub fn focus_main_webview() {
    let raw = MAIN_WEBVIEW_HWND.load(Ordering::Relaxed);
    let app = APP_HWND.load(Ordering::Relaxed);
    if raw == 0 || app == 0 {
        return;
    }
    let target = hwnd(raw);
    unsafe {
        if !IsWindow(Some(target)).as_bool() {
            return;
        }
        // Only ever act on genuinely *dead* focus. `GetFocus` is per-thread,
        // so anything non-null already belongs to one of our windows — the
        // main webview, an embedded external terminal, or a browser pane's
        // webview — and all of those take keys fine on their own. Forcing
        // focus onto the webview host in that state is actively harmful: it
        // pulls focus off WebView2's inner render widget, which is what
        // actually receives keystrokes, and typing dies everywhere. The only
        // state worth correcting is focus on nothing, or parked on the bare
        // window frame.
        let cur = GetFocus();
        if !cur.0.is_null() && cur.0 as isize != app {
            return;
        }
        let _ = SetFocus(Some(target));
    }
}

/// Forces real OS keyboard focus onto the main webview, even when a live child
/// (a browser pane's separate WebView2, or an embedded external window)
/// currently holds it.
///
/// Alt-dragging context out of a browser pane and dropping it on a terminal
/// only ever touches our own DOM — the source pane is a genuinely separate
/// child webview that keeps real OS focus throughout the gesture. Without
/// this, the terminal shows the pasted context but the next keystroke still
/// goes to the browser pane until the user clicks the terminal by hand.
/// Unlike `focus_main_webview`'s activation-watcher guard, this is called
/// from an explicit user action (a completed drop) so it steals focus
/// unconditionally rather than only when focus is dead.
#[tauri::command]
fn focus_main_window() {
    let raw = MAIN_WEBVIEW_HWND.load(Ordering::Relaxed);
    if raw == 0 {
        return;
    }
    let target = hwnd(raw);
    unsafe {
        if IsWindow(Some(target)).as_bool() {
            let _ = SetFocus(Some(target));
        }
    }
}

/// Watches for our window becoming the foreground window.
///
/// `WindowEvent::Focused(true)` is not dependable here: it can be missed
/// entirely (activation that lands on a child HWND — an embedded terminal or a
/// browser pane — never reaches the top-level webview's focus tracking), and
/// when it does fire it can arrive *during* `WM_ACTIVATE`, before Windows has
/// finished handing focus around, so a `SetFocus` at that instant gets undone
/// moments later. Polling the foreground window sidesteps both: we act on the
/// transition into our process, and again shortly after it settles.
fn install_activation_watcher() {
    thread::spawn(|| {
        let mut was_active = false;
        loop {
            thread::sleep(Duration::from_millis(120));
            let app = APP_HWND.load(Ordering::Relaxed);
            if app == 0 {
                continue;
            }
            let fg = unsafe { GetForegroundWindow() };
            let root = if fg.0.is_null() {
                0
            } else {
                unsafe { GetAncestor(fg, GA_ROOT) }.0 as isize
            };
            let active = root == app;
            if active && !was_active {
                on_activated();
            }
            was_active = active;
        }
    });
}

/// Runs on every fresh activation: restore keyboard focus to the webview (twice
/// — once now, once after activation settles) and tell the frontend to put DOM
/// focus back on the selected pane.
fn on_activated() {
    let Some(app) = app_handle().get().cloned() else {
        return;
    };
    let _ = app.run_on_main_thread(focus_main_webview);
    let _ = app.emit("window-focused", ());
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(90));
        let _ = app.run_on_main_thread(focus_main_webview);
        let _ = app.emit("window-focused", ());
    });
}

/// HWND helper shared with the browser-pane module (GDI capture).
pub fn hwnd(v: isize) -> HWND {
    HWND(v as *mut std::ffi::c_void)
}

fn app_handle() -> &'static OnceLock<AppHandle> {
    static H: OnceLock<AppHandle> = OnceLock::new();
    &H
}

/// State machine for the in-progress external-window drag, owned by the hook.
enum DragPhase {
    Idle,
    /// Left button went down on a foreign terminal window; not yet moved.
    Candidate { hwnd: isize, start_rect: RECT },
    /// The candidate window is being dragged.
    Dragging {
        hwnd: isize,
        over_app: bool,
        last_emit: Instant,
    },
}

fn drag_phase() -> &'static Mutex<DragPhase> {
    static P: OnceLock<Mutex<DragPhase>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(DragPhase::Idle))
}

struct Embedded {
    hwnd: isize,
    orig_parent: isize,
    orig_style: isize,
    orig_rect: RECT,
    /// Where the window must sit (client-area coords) and whether it should show.
    /// A background thread continuously re-asserts this so the docked window
    /// can't be dragged out of its pane or float over its neighbours.
    tx: i32,
    ty: i32,
    tw: i32,
    th: i32,
    visible: bool,
}

fn embedded() -> &'static Mutex<HashMap<String, Embedded>> {
    static E: OnceLock<Mutex<HashMap<String, Embedded>>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
struct ExtDragMove {
    x: i32,
    y: i32,
    title: String,
}

#[derive(Clone, Serialize)]
struct ExtDragDrop {
    x: i32,
    y: i32,
    title: String,
    hwnd: String,
}

/// Window classes / process images we treat as terminals worth docking.
const TERMINAL_CLASSES: &[&str] = &[
    "ConsoleWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "mintty",
    "Alacritty",
];
const TERMINAL_EXES: &[&str] = &[
    "windowsterminal.exe",
    "wt.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "conhost.exe",
    "wezterm-gui.exe",
    "alacritty.exe",
    "mintty.exe",
    "hyper.exe",
    "kitty.exe",
    "terminus.exe",
];

fn win_rect(h: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(h, &mut r).ok().map(|_| r) }
}

fn point_in(r: &RECT, p: POINT) -> bool {
    p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom
}

fn window_class(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn window_title(h: HWND) -> String {
    let n = unsafe { GetWindowTextLengthW(h) };
    if n <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; n as usize + 1];
    let got = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..got.max(0) as usize])
}

fn process_image_name(h: HWND) -> Option<String> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        path.rsplit(['\\', '/']).next().map(|s| s.to_lowercase())
    }
}

fn is_terminal_window(h: HWND) -> bool {
    let cls = window_class(h);
    if TERMINAL_CLASSES.iter().any(|c| cls.eq_ignore_ascii_case(c)) {
        return true;
    }
    match process_image_name(h) {
        Some(name) => TERMINAL_EXES.contains(&name.as_str()),
        None => false,
    }
}

/// Is the cursor over our (non-minimized) window?
fn cursor_over_app(p: POINT) -> bool {
    let app = APP_HWND.load(Ordering::Relaxed);
    if app == 0 {
        return false;
    }
    let h = hwnd(app);
    if unsafe { IsIconic(h) }.as_bool() {
        return false;
    }
    win_rect(h).map(|r| point_in(&r, p)).unwrap_or(false)
}

fn emit(event: &str, payload: impl Serialize + Clone) {
    if let Some(app) = app_handle().get() {
        let _ = app.emit(event, payload);
    }
}

/// Cursor position converted to our window's client area (physical px).
fn client_point(p: POINT) -> POINT {
    let app = APP_HWND.load(Ordering::Relaxed);
    let mut pt = p;
    if app != 0 {
        unsafe {
            let _ = ScreenToClient(hwnd(app), &mut pt);
        }
    }
    pt
}

fn handle_mouse(msg: u32, pt: POINT) {
    let mut phase = drag_phase().lock().unwrap();
    match msg {
        WM_LBUTTONDOWN => {
            let root = unsafe { GetAncestor(WindowFromPoint(pt), GA_ROOT) };
            let root_v = root.0 as isize;
            let app = APP_HWND.load(Ordering::Relaxed);
            *phase = if root_v == 0 || root_v == app || !is_terminal_window(root) {
                DragPhase::Idle
            } else {
                match win_rect(root) {
                    Some(r) => DragPhase::Candidate {
                        hwnd: root_v,
                        start_rect: r,
                    },
                    None => DragPhase::Idle,
                }
            };
        }
        WM_MOUSEMOVE => {
            // Promote Candidate → Dragging once the window actually moves.
            if let DragPhase::Candidate { hwnd: h, start_rect } = &*phase {
                let hv = *h;
                let sr = *start_rect;
                if !unsafe { IsWindow(Some(hwnd(hv))) }.as_bool() {
                    *phase = DragPhase::Idle;
                } else if let Some(cur) = win_rect(hwnd(hv)) {
                    if (cur.left - sr.left).abs() > 2 || (cur.top - sr.top).abs() > 2 {
                        *phase = DragPhase::Dragging {
                            hwnd: hv,
                            over_app: false,
                            last_emit: Instant::now() - Duration::from_millis(100),
                        };
                    }
                }
            }
            if let DragPhase::Dragging {
                hwnd: h,
                over_app,
                last_emit,
            } = &mut *phase
            {
                let hv = *h;
                if !unsafe { IsWindow(Some(hwnd(hv))) }.as_bool() {
                    emit("ext-drag-cancel", ());
                    *phase = DragPhase::Idle;
                    return;
                }
                let over = cursor_over_app(pt);
                if over {
                    *over_app = true;
                    // Throttle to ~80/s so the overlay tracks smoothly without flooding.
                    if last_emit.elapsed() >= Duration::from_millis(12) {
                        *last_emit = Instant::now();
                        let cp = client_point(pt);
                        emit(
                            "ext-drag-move",
                            ExtDragMove {
                                x: cp.x,
                                y: cp.y,
                                title: window_title(hwnd(hv)),
                            },
                        );
                    }
                } else if *over_app {
                    *over_app = false;
                    emit("ext-drag-leave", ());
                }
            }
        }
        WM_LBUTTONUP => {
            if let DragPhase::Dragging { hwnd: h, .. } = &*phase {
                let hv = *h;
                if cursor_over_app(pt) && unsafe { IsWindow(Some(hwnd(hv))) }.as_bool() {
                    let cp = client_point(pt);
                    emit(
                        "ext-drag-drop",
                        ExtDragDrop {
                            x: cp.x,
                            y: cp.y,
                            title: window_title(hwnd(hv)),
                            hwnd: hv.to_string(),
                        },
                    );
                } else {
                    emit("ext-drag-cancel", ());
                }
            }
            *phase = DragPhase::Idle;
        }
        _ => {}
    }
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        handle_mouse(wparam.0 as u32, ms.pt);
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Install the low-level mouse hook on a dedicated thread with its own message
/// pump (WH_MOUSE_LL delivers callbacks on the installing thread's loop).
fn install_mouse_hook() {
    thread::spawn(|| unsafe {
        let hook: HHOOK = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) {
            Ok(h) => h,
            Err(_) => return,
        };
        let _ = hook; // kept alive for the life of the process
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

#[tauri::command]
fn embed_external_window(
    id: String,
    hwnd: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    let target = hwnd.parse::<isize>().map_err(|e| e.to_string())?;
    let app = APP_HWND.load(Ordering::Relaxed);
    if target == 0 || app == 0 {
        return Err("no window".into());
    }
    let th = self::hwnd(target);
    let ah = self::hwnd(app);
    unsafe {
        if !IsWindow(Some(th)).as_bool() {
            return Err("window is gone".into());
        }
        let prev = GetWindowLongPtrW(th, GWL_STYLE);
        let cur = prev as u32;
        let strip = WS_CAPTION.0
            | WS_THICKFRAME.0
            | WS_MINIMIZEBOX.0
            | WS_MAXIMIZEBOX.0
            | WS_SYSMENU.0
            | WS_POPUP.0;
        let new_style = (cur & !strip) | WS_CHILD.0 | WS_VISIBLE.0;

        let orig_parent = GetParent(th).map(|p| p.0 as isize).unwrap_or(0);
        let orig_rect = win_rect(th).unwrap_or_default();

        embedded().lock().unwrap().insert(
            id,
            Embedded {
                hwnd: target,
                orig_parent,
                orig_style: prev,
                orig_rect,
                tx: x,
                ty: y,
                tw: w,
                th: h,
                visible: true,
            },
        );

        SetWindowLongPtrW(th, GWL_STYLE, new_style as isize);
        let _ = SetParent(th, Some(ah));
        let _ = SetWindowPos(
            th,
            Some(HWND_TOP),
            x,
            y,
            w,
            h,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
    Ok(())
}

#[tauri::command]
fn position_embedded_window(
    id: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    visible: bool,
) -> Result<(), String> {
    let mut map = embedded().lock().unwrap();
    let Some(e) = map.get_mut(&id) else {
        return Ok(());
    };
    // Record the new target; the enforcement thread keeps re-applying it.
    e.tx = x;
    e.ty = y;
    e.tw = w;
    e.th = h;
    e.visible = visible;
    let th = self::hwnd(e.hwnd);
    unsafe {
        if !IsWindow(Some(th)).as_bool() {
            return Ok(());
        }
        if visible {
            let _ = SetWindowPos(
                th,
                Some(HWND_TOP),
                x,
                y,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOZORDER,
            );
        } else {
            let _ = ShowWindow(th, SW_HIDE);
        }
    }
    Ok(())
}

/// Continuously pin every visible docked window to its pane rect. This is what
/// makes an embedded terminal feel *integrated*: if the user grabs it (Windows
/// Terminal draws its own draggable tab bar), it snaps straight back into place
/// instead of floating free over the other panes.
fn install_position_enforcer() {
    thread::spawn(|| loop {
        thread::sleep(Duration::from_millis(40));
        let map = embedded().lock().unwrap();
        for e in map.values() {
            let th = self::hwnd(e.hwnd);
            unsafe {
                if !IsWindow(Some(th)).as_bool() {
                    continue;
                }
                if e.visible {
                    // Only correct real drift so we don't fight the compositor
                    // every tick when the window is already where it belongs.
                    if let Some(r) = win_rect(th) {
                        // r is screen coords; derive current client-relative pos.
                        let mut origin = POINT { x: 0, y: 0 };
                        let app = self::hwnd(APP_HWND.load(Ordering::Relaxed));
                        let _ = ClientToScreen(app, &mut origin);
                        let cur_x = r.left - origin.x;
                        let cur_y = r.top - origin.y;
                        let cur_w = r.right - r.left;
                        let cur_h = r.bottom - r.top;
                        if (cur_x - e.tx).abs() > 1
                            || (cur_y - e.ty).abs() > 1
                            || (cur_w - e.tw).abs() > 1
                            || (cur_h - e.th).abs() > 1
                        {
                            let _ = SetWindowPos(
                                th,
                                Some(HWND_TOP),
                                e.tx,
                                e.ty,
                                e.tw,
                                e.th,
                                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOZORDER,
                            );
                        }
                    }
                }
            }
        }
    });
}

/// Restore an embedded window to a free-floating top-level window.
fn restore_embedded(e: &Embedded) {
    let th = self::hwnd(e.hwnd);
    unsafe {
        if !IsWindow(Some(th)).as_bool() {
            return;
        }
        let _ = SetParent(th, None);
        SetWindowLongPtrW(th, GWL_STYLE, e.orig_style);
        let r = e.orig_rect;
        let _ = SetWindowPos(
            th,
            Some(HWND_TOP),
            r.left,
            r.top,
            (r.right - r.left).max(200),
            (r.bottom - r.top).max(120),
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        let _ = ShowWindow(th, SW_SHOWNORMAL);
        let _ = e.orig_parent; // (parent restore intentionally NULL: pop to desktop)
    }
}

#[tauri::command]
fn release_embedded_window(id: String) -> Result<(), String> {
    if let Some(e) = embedded().lock().unwrap().remove(&id) {
        restore_embedded(&e);
    }
    Ok(())
}

/// Pop every embedded window back out — used at shutdown so the user's terminals
/// aren't destroyed along with our window (child windows die with their parent).
fn release_all_embedded() {
    let mut map = embedded().lock().unwrap();
    for (_, e) in map.iter() {
        restore_embedded(e);
    }
    map.clear();
}

/// Brings the main window to the front — used when a second `OpenTerm` launch is
/// folded into this instance, since the user typed it expecting a window.
fn raise_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Built once and shared by both entry points, so the frontend assets are
/// embedded in the binary only one time.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

fn main() {
    // The dictation agent is this same exe in a different role: a tray
    // utility with no main window and its own single-instance mutex. It must
    // branch off before the main app's builder and its single-instance plugin.
    if std::env::args().any(|a| a == dictation::AGENT_ARG) {
        dictation::run_agent(context());
        return;
    }

    tauri::Builder::default()
        // Must be the first plugin: it decides whether this process lives at all.
        // A second launch (someone typed `OpenTerm` in another folder) hands its
        // argv + working directory to the instance already running and exits, so
        // one window owns every session instead of piling up copies of the app.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if dictation::host::note_launch_args(&argv) {
                let _ = app.emit("open-dictation-settings", ());
                raise_main_window(app);
                return;
            }
            if let Some(folder) = shell_integration::folder_from_launch(&argv, &cwd) {
                let _ = app.emit("open-folder", folder);
            }
            raise_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Beacon channel for embedded browser panes: their injected monitor
        // scripts POST captured console/network entries here. See browser.rs.
        .register_uri_scheme_protocol("tdlog", |ctx, request| {
            browser::handle_tdlog(ctx, request)
        })
        .manage(PtyManager::default())
        .setup(|app| {
            let _ = app_handle().set(app.handle().clone());

            // Explorer launches us with the folder it was showing as our working
            // directory, so this is where the address-bar hand-off is decoded.
            // Parked until the frontend boots and calls `take_launch_folder`.
            let argv: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            shell_integration::set_pending(shell_integration::folder_from_launch(&argv, &cwd));
            dictation::host::note_launch_args(&argv);

            if let Some(window) = app.get_webview_window("main") {
                // Publish our HWND for the mouse-hook thread, then start it: it
                // watches for a foreign terminal window dragged over us.
                if let Ok(h) = window.hwnd() {
                    APP_HWND.store(h.0 as isize, Ordering::Relaxed);
                    if let Some(wv) = find_main_webview(h) {
                        MAIN_WEBVIEW_HWND.store(wv.0 as isize, Ordering::Relaxed);
                    }
                }
                install_mouse_hook();
                install_position_enforcer();
                install_activation_watcher();
                usage::start_poller(app.handle());
                dictation::host::start_focus_listener(app.handle().clone());

                // Keep the window inside the monitor's real work area so its
                // bottom edge doesn't slip behind the taskbar.
                clamp_to_work_area(&window);
                let _ = window.center();

                // Re-clamp on every resize: covers a later native maximize
                // that fills the whole monitor instead of just the work area.
                let clamp_window = window.clone();
                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::Resized(_) => clamp_to_work_area(&clamp_window),
                        // Coming back from another app: put keyboard focus back
                        // on the webview so typing and keybinds work instantly
                        // (see `focus_main_webview`), and tell the frontend to
                        // re-focus the selected pane's terminal.
                        WindowEvent::Focused(true) => on_activated(),
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            command_exists,
            resize_pty,
            kill_pty,
            save_state,
            load_state,
            state_file_path,
            list_backups,
            restore_backup,
            find_in_backups,
            enhance_prompt,
            name_notification,
            list_dir,
            read_text_file,
            read_file_base64,
            write_text_file,
            reveal_in_explorer,
            rename_path,
            delete_path,
            play_attention_sound,
            flash_taskbar_icon,
            focus_main_window,
            embed_external_window,
            position_embedded_window,
            release_embedded_window,
            browser::create_browser_pane,
            browser::focus_browser_pane,
            browser::position_browser_pane,
            browser::navigate_browser_pane,
            browser::browser_history,
            browser::destroy_browser_pane,
            browser::capture_browser_pane,
            shell_integration::take_launch_folder,
            shell_integration::release_single_instance_lock,
            shell_integration::register_shell_integration,
            shell_integration::unregister_shell_integration,
            shell_integration::shell_integration_status,
            usage::pane_usage,
            usage::folder_usage,
            usage::usage_pricing_path,
            usage::forget_pane_usage,
            usage::pane_last_session,
            usage::claude_usage_limit,
            usage::codex_usage_limit,
            usage::live_pane_harnesses,
            git::check_github_status,
            git::git_map,
            harness::check_harness_updates,
            harness::update_harness,
            dictation::host::dictation_sync,
            dictation::host::dictation_quit_agent,
            dictation::host::dictation_ensure_agent,
            dictation::host::dictation_read_store,
            dictation::host::dictation_command,
            dictation::host::dictation_list_devices,
            dictation::host::dictation_meter_start,
            dictation::host::dictation_meter_stop,
            dictation::host::dictation_play_sound,
            dictation::host::dictation_open_mic_privacy,
            dictation::host::dictation_wallpaper,
            dictation::host::dictation_take_open_settings,
            dictation::host::dictation_set_focused_agent
        ])
        .build(context())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Pop any docked external windows back to the desktop *first* —
                // otherwise they'd be destroyed as children of our closing window.
                release_all_embedded();
                dictation::host::dictation_meter_stop();
                dictation::host::on_main_exit();
                // Same for embedded browser webviews (they're children too).
                browser::destroy_all();
                if let Some(m) = app.try_state::<PtyManager>() {
                    let mut map = m.0.lock().unwrap();
                    for (_, h) in map.iter_mut() {
                        let _ = h.child.kill();
                    }
                    map.clear();
                }
            }
        });
}

#[cfg(test)]
mod backup_tests {
    use super::*;

    fn state_with(sessions: &[(&str, usize)]) -> String {
        let arr: Vec<serde_json::Value> = sessions
            .iter()
            .map(|(name, panes)| {
                let mut tree = serde_json::json!({ "type": "leaf", "id": "a" });
                for i in 1..*panes {
                    tree = serde_json::json!({
                        "type": "split", "dir": "row",
                        "children": [tree, { "type": "leaf", "id": i.to_string() }]
                    });
                }
                serde_json::json!({ "name": name, "tree": tree })
            })
            .collect();
        serde_json::json!({ "sessions": arr }).to_string()
    }

    #[test]
    fn counts_leaves_through_nested_splits() {
        let v: serde_json::Value =
            serde_json::from_str(&state_with(&[("s", 3)])).unwrap();
        assert_eq!(count_leaves(&v["sessions"][0]["tree"]), 3);
    }

    #[test]
    fn ring_coalesces_bursts_but_keeps_structural_changes() {
        let dir = std::env::temp_dir().join(format!("td-backup-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let state = dir.join("state.json");
        let slot = |i: usize| dir.join("backups").join(format!("state-last-{i}.json"));

        // First save of the run always takes a slot.
        fs::write(&state, state_with(&[("alpha", 1)])).unwrap();
        write_backups(&state);
        assert!(slot(1).exists());
        assert!(!slot(2).exists());

        // A same-shape save moments later coalesces into slot 1.
        fs::write(&state, state_with(&[("alpha", 2)])).unwrap();
        write_backups(&state);
        assert!(!slot(2).exists(), "burst save must not rotate the ring");
        assert_eq!(count_leaves(
            &serde_json::from_str::<serde_json::Value>(&fs::read_to_string(slot(1)).unwrap())
                .unwrap()["sessions"][0]["tree"]
        ), 2, "slot 1 must hold the newest state");

        // A changed session line-up is its own moment, even inside the window.
        fs::write(&state, state_with(&[("alpha", 2), ("beta", 1)])).unwrap();
        write_backups(&state);
        assert!(slot(2).exists(), "session added must rotate the ring");
        assert_eq!(
            session_names_of(&slot(1)).unwrap(),
            vec!["alpha".to_string(), "beta".to_string()]
        );
        assert_eq!(session_names_of(&slot(2)).unwrap(), vec!["alpha".to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }
}
