//! The main app's side of dictation: writes `config.json`, keeps the agent
//! running (or stops it), manages the autostart entry, and serves the
//! Settings tab (store snapshot, devices, level meter, commands).

use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use super::audio::{self, Capture, CaptureError};
use super::store::{write_json_atomic, Store, FOCUS_REQUEST_FILE};
use super::{
    agent_running, data_dir, signal, sound, with_command_lock, Config, AGENT_ARG, COMMAND_EVENT, FOCUS_EVENT,
    QUIT_EVENT, SETTINGS_ARG,
};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "OpenTermDictation";

static ENABLED: AtomicBool = AtomicBool::new(false);
static ALWAYS: AtomicBool = AtomicBool::new(false);
static OPEN_SETTINGS: AtomicBool = AtomicBool::new(false);
static METER: Mutex<Option<Capture>> = Mutex::new(None);

/// Remembers a `--dictation-settings` launch until the frontend asks.
pub fn note_launch_args(argv: &[String]) -> bool {
    let wants = argv.iter().any(|a| a == SETTINGS_ARG);
    if wants {
        OPEN_SETTINGS.store(true, Ordering::Relaxed);
    }
    wants
}

#[tauri::command]
pub fn dictation_take_open_settings() -> bool {
    OPEN_SETTINGS.swap(false, Ordering::Relaxed)
}

/// Records the focused pane as "<agent>\t<pane id>" — agent being
/// "claude-code", "codex", "opencode" or "" — so the dictation process can
/// pick the paste keys that CLI accepts and can tell whether the user has
/// moved to another pane while a transcript was in flight.
#[tauri::command]
pub fn dictation_set_focused_agent(app: AppHandle, agent: String) {
    let Some(dir) = data_dir(&app) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(super::store::FOCUSED_AGENT_FILE), agent);
}

/// Watches for the dictation process asking us to focus a pane, which it does
/// when a locked transcript belongs to a pane other than the focused one. The
/// frontend does the actual switch and then republishes the focused pane,
/// which is how the dictation process knows it can type.
pub fn start_focus_listener(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        let Ok(event) = CreateEventW(None, false, false, FOCUS_EVENT) else { return };
        loop {
            if WaitForSingleObject(event, INFINITE) != WAIT_OBJECT_0 {
                break;
            }
            let Some(dir) = data_dir(&app) else { continue };
            let Ok(pane) = std::fs::read_to_string(dir.join(FOCUS_REQUEST_FILE)) else { continue };
            let pane = pane.trim();
            if !pane.is_empty() {
                let _ = app.emit("dictation-focus-pane", pane);
            }
        }
        let _ = CloseHandle(event);
    });
}

fn spawn_agent() {
    if agent_running() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg(AGENT_ARG).creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    let _ = cmd.spawn();
}

fn set_autostart(on: bool) {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((key, _)) = hkcu.create_subkey(RUN_KEY) else { return };
    if on {
        if let Ok(exe) = std::env::current_exe() {
            let _ = key.set_value(RUN_VALUE, &format!("\"{}\" {AGENT_ARG}", exe.display()));
        }
    } else {
        let _ = key.delete_value(RUN_VALUE);
    }
}

/// Called on boot and on every Settings save. Writes the agent's config,
/// syncs the autostart entry and starts or stops the agent.
#[tauri::command]
pub fn dictation_sync(app: AppHandle, config: Config) -> Result<(), String> {
    let dir = data_dir(&app).ok_or("no app data dir")?;
    let path = dir.join("config.json");
    // Unchanged content keeps its mtime, so the agent doesn't reload for nothing.
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    if std::fs::read_to_string(&path).ok().as_deref() != Some(json.as_str()) {
        write_json_atomic(&path, &config)?;
    }
    let enabled = config.settings.enabled;
    let always = config.settings.availability != "whileOpen";
    ENABLED.store(enabled, Ordering::Relaxed);
    ALWAYS.store(always, Ordering::Relaxed);
    // A dev build's exe lives in target/ and needs the dev server; never
    // register that to start with Windows.
    if !cfg!(debug_assertions) {
        set_autostart(enabled && always);
    }
    if enabled {
        spawn_agent();
        signal(COMMAND_EVENT);
    } else {
        signal(QUIT_EVENT);
    }
    Ok(())
}

/// Stops the agent and waits for it to exit, so the updater can replace the exe.
#[tauri::command]
pub async fn dictation_quit_agent() {
    let _ = tauri::async_runtime::spawn_blocking(|| {
        signal(QUIT_EVENT);
        let start = Instant::now();
        while agent_running() && start.elapsed() < Duration::from_secs(4) {
            std::thread::sleep(Duration::from_millis(50));
        }
    })
    .await;
}

/// Brings the agent back after an aborted update.
#[tauri::command]
pub fn dictation_ensure_agent() {
    if ENABLED.load(Ordering::Relaxed) {
        spawn_agent();
    }
}

/// On main app exit: in "only while OpenTerm is open" mode the agent goes too.
/// Dev builds always stop it, or it would keep the exe locked for the next build.
pub fn on_main_exit() {
    if !ENABLED.load(Ordering::Relaxed) || !ALWAYS.load(Ordering::Relaxed) || cfg!(debug_assertions) {
        signal(QUIT_EVENT);
    }
}

#[tauri::command]
pub fn dictation_read_store(app: AppHandle) -> Result<serde_json::Value, String> {
    let dir = data_dir(&app).ok_or("no app data dir")?;
    let store = Store::new(dir);
    Ok(serde_json::json!({
        "history": store.history(),
        "unsent": store.unsent(),
        "stats": store.stats(),
        "audioDir": store.audio_dir(),
        "agentRunning": agent_running(),
    }))
}

/// Queues an action for the agent (Transcribe, Delete, Clear, Preview...).
#[tauri::command]
pub fn dictation_command(app: AppHandle, command: serde_json::Value) -> Result<(), String> {
    let dir = data_dir(&app).ok_or("no app data dir")?;
    if !ENABLED.load(Ordering::Relaxed) {
        // No agent to hand this to (and so no second writer): tidy-ups still
        // work while dictation is off.
        let store = Store::new(dir);
        let id = command["id"].as_str().unwrap_or("");
        return match command["type"].as_str() {
            Some("deleteHistory") => {
                store.delete_history(id);
                Ok(())
            },
            Some("deleteUnsent") => {
                store.delete_unsent(id);
                Ok(())
            },
            Some("clearHistory") => {
                store.clear_history();
                Ok(())
            },
            _ => Err("Dictation is turned off".into()),
        };
    }
    let path = dir.join("commands.json");
    with_command_lock(|| {
        let mut list: Vec<serde_json::Value> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        list.push(command);
        write_json_atomic(&path, &list)
    })?;
    // A fresh agent reads the queue on start, so the event may go unheard.
    spawn_agent();
    signal(COMMAND_EVENT);
    Ok(())
}

#[tauri::command]
pub async fn dictation_list_devices() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(audio::device_names).await.unwrap_or_default()
}

/// Live level meter for Settings, on the exact capture path dictation uses.
#[tauri::command]
pub fn dictation_meter_start(device: Option<String>, channel: Channel<InvokeResponseBody>) {
    let errors = channel.clone();
    let capture = Capture::start(
        device,
        0,
        Box::new(move |lv| {
            let _ = channel.send(InvokeResponseBody::Raw(lv.to_vec()));
        }),
        Box::new(move |e| {
            let error = match e {
                CaptureError::Blocked => "blocked",
                CaptureError::NoDevice => "noDevice",
                CaptureError::Failed(_) => "failed",
            };
            let _ = errors.send(InvokeResponseBody::Json(serde_json::json!({ "error": error }).to_string()));
        }),
    );
    // Replacing the old capture drops it, which releases its device.
    *METER.lock().unwrap_or_else(|e| e.into_inner()) = Some(capture);
}

#[tauri::command]
pub fn dictation_meter_stop() {
    METER.lock().unwrap_or_else(|e| e.into_inner()).take();
}

#[tauri::command]
pub fn dictation_open_mic_privacy() {
    super::open_mic_privacy();
}

#[tauri::command]
pub fn dictation_play_sound() {
    sound::play(sound::Cue::Start);
}

/// Path of the current desktop wallpaper, for the Settings simulator.
#[tauri::command]
pub fn dictation_wallpaper() -> Option<String> {
    let mut buf = [0u16; 520];
    unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .ok()?;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let path = String::from_utf16_lossy(&buf[..len]);
    (!path.is_empty() && std::path::Path::new(&path).is_file()).then_some(path)
}
