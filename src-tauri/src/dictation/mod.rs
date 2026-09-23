//! Dictation: push-to-talk for the whole computer.
//!
//! Runs as a separate background process, the same exe started with
//! `--dictation-agent`: no main window, just two hidden overlay windows and a
//! tray icon. It survives the main app closing, and a mic driver bug can't
//! take the terminals down with it.
//!
//! State shared with the main app lives on disk in `app_data_dir/dictation/`:
//! `config.json` (written by Settings), `history.json` / `unsent.json` /
//! `audio/` (written here), and `commands.json` plus a named event for the
//! few actions Settings sends over.
//!
//! State machine: Idle → Arming → Recording → Busy (transcribe, polish,
//! deliver) → Idle, with cancel possible from Arming and Recording.

pub mod audio;
mod encode;
pub mod host;
mod hotkey;
mod overlay;
mod paste;
pub mod sound;
pub mod store;
mod transcribe;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, RunEvent, Wry};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, OpenMutexW, ReleaseMutex, SetEvent, WaitForMultipleObjects,
    WaitForSingleObject, EVENT_MODIFY_STATE, INFINITE, SYNCHRONIZATION_SYNCHRONIZE,
};

use audio::{Capture, CaptureError, Recording};
use hotkey::Event;
use overlay::ClickAction;
use store::{HistoryItem, Store, UnsentItem};

pub const AGENT_ARG: &str = "--dictation-agent";
/// Asks a (new or running) main app to open Settings on the Dictation tab.
pub const SETTINGS_ARG: &str = "--dictation-settings";

const INSTANCE_MUTEX: PCWSTR = w!("Local\\OpenTermDictationAgent");
const QUIT_EVENT: PCWSTR = w!("Local\\OpenTermDictationQuit");
const COMMAND_EVENT: PCWSTR = w!("Local\\OpenTermDictationCommand");
/// Agent -> main app: "focus the pane named in `focus_pane`".
pub const FOCUS_EVENT: PCWSTR = w!("Local\\OpenTermDictationFocus");
const COMMAND_LOCK: PCWSTR = w!("Local\\OpenTermDictationCommandLock");

/// Long enough to let native Ctrl+Win+<key> shortcuts through untouched.
const ARM_DELAY: Duration = Duration::from_millis(120);
const MIN_HOLD: Duration = Duration::from_millis(300);
/// Cancelled recordings shorter than this aren't worth keeping.
const MIN_UNSENT_MS: u64 = 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DictationSettings {
    pub enabled: bool,
    pub shortcut: String,
    pub mode: String,
    pub style: String,
    pub position: String,
    pub start_sound: bool,
    pub mic_device_id: Option<String>,
    pub language: Option<String>,
    pub transcribe_style: String,
    pub ai_polish: bool,
    pub vocabulary: Vec<String>,
    pub max_seconds: u32,
    pub availability: String,
    /// Deliver to the window (and OpenTerm pane) that was focused when the key
    /// went down, bringing it back to the front if the user has moved on.
    /// Off means the old "paste wherever you are now" behaviour.
    pub lock_target: bool,
}

impl Default for DictationSettings {
    fn default() -> Self {
        DictationSettings {
            // Matches DEFAULT_DICTATION in src/types.ts — off until the user
            // opts in. This default applies when config.json is missing, so it
            // must not arm the keyboard hook on a fresh install.
            enabled: false,
            shortcut: "Ctrl+Win".into(),
            mode: "hold".into(),
            style: "pill".into(),
            position: "bottom-center".into(),
            start_sound: true,
            mic_device_id: None,
            language: None,
            transcribe_style: "clean".into(),
            ai_polish: false,
            vocabulary: Vec::new(),
            max_seconds: 300,
            availability: "always".into(),
            lock_target: true,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub settings: DictationSettings,
    pub api_key: String,
    /// Theme tokens for the overlay (--bg-raised, --text, --accent, ...).
    pub theme: HashMap<String, String>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Transcribe { id: String },
    DeleteHistory { id: String },
    DeleteUnsent { id: String },
    ClearHistory,
    /// "Show on screen": carries the unsaved style and position from Settings.
    Preview { style: String, position: String },
    /// Settings is recording a new shortcut: stand the hook down meanwhile.
    Suspend { on: bool },
}

pub enum Msg {
    Hook(Event, Instant),
    CaptureFailed(CaptureError),
    JobDone(Outcome),
    OverlayClick(ClickAction),
    /// The command event fired: re-check config.json and commands.json.
    Events,
    TogglePause,
}

pub enum Outcome {
    Delivered(&'static str),
    NothingHeard,
    /// Short reason; the recording went to Unsent.
    Unsent(String),
    Failed(String),
}

pub fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("dictation"))
}

// ---------------------------------------------------------------- named objects

pub fn agent_running() -> bool {
    match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, INSTANCE_MUTEX) } {
        Ok(h) => {
            unsafe {
                let _ = CloseHandle(h);
            }
            true
        }
        Err(_) => false,
    }
}

pub fn signal(name: PCWSTR) {
    unsafe {
        if let Ok(h) = OpenEventW(EVENT_MODIFY_STATE, false, name) {
            let _ = SetEvent(h);
            let _ = CloseHandle(h);
        }
    }
}

/// Runs `f` while holding the cross-process lock on `commands.json`.
fn with_command_lock<T>(f: impl FnOnce() -> T) -> T {
    unsafe {
        let lock = CreateMutexW(None, false, COMMAND_LOCK).ok();
        if let Some(h) = lock {
            let _ = WaitForSingleObject(h, 2000);
        }
        let out = f();
        if let Some(h) = lock {
            let _ = ReleaseMutex(h);
            let _ = CloseHandle(h);
        }
        out
    }
}

fn take_commands(dir: &std::path::Path) -> Vec<Command> {
    let path = dir.join("commands.json");
    with_command_lock(|| {
        let cmds = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Command>>(&s).ok())
            .unwrap_or_default();
        let _ = std::fs::remove_file(&path);
        cmds
    })
}

pub fn open_mic_privacy() {
    let _ = std::process::Command::new("explorer.exe").arg("ms-settings:privacy-microphone").spawn();
}

fn spawn_main_app(args: &[&str]) {
    if let Ok(exe) = std::env::current_exe() {
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(args);
        // The main app treats its working directory as "folder to open"
        // unless it's the install dir.
        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }
        let _ = cmd.spawn();
    }
}

// ---------------------------------------------------------------- agent process

pub fn run_agent(mut context: tauri::Context<Wry>) {
    let instance = unsafe { CreateMutexW(None, true, INSTANCE_MUTEX) };
    let Ok(_instance) = instance else { return };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return;
    }
    // tauri.conf.json declares the main window; the agent has none.
    context.config_mut().app.windows.clear();

    let (tx, rx) = mpsc::channel::<Msg>();
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            overlay::overlay_attach,
            overlay::overlay_finished,
            overlay::overlay_click
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let dir = data_dir(&handle).ok_or("no app data dir")?;
            let webview_dir = handle.path().app_local_data_dir()?.join("dictation-webview");
            overlay::create(&handle, webview_dir, tx.clone())?;
            let (tray, pause_item) = build_tray(&handle, tx.clone())?;
            hotkey::install(tx.clone());
            watch_events(handle.clone(), tx.clone());
            let agent = Agent::new(dir, tx, tray, pause_item);
            thread::spawn(move || agent.run(rx));
            Ok(())
        })
        .build(context)
        .expect("error while building the dictation agent");
    app.run(|_, event| {
        // Overlays are never closed, but a tray utility must not exit just
        // because it has no visible window. Explicit exits carry a code.
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
            api.prevent_exit();
        }
    });
}

fn build_tray(app: &AppHandle, tx: Sender<Msg>) -> tauri::Result<(TrayIcon<Wry>, MenuItem<Wry>)> {
    let open = MenuItem::with_id(app, "open", "Open OpenTerm", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause dictation", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Dictation settings…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit dictation", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &settings, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id("dictation")
        .tooltip("Dictation ready")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "open" => spawn_main_app(&[]),
            "settings" => spawn_main_app(&[SETTINGS_ARG]),
            "pause" => {
                let _ = tx.send(Msg::TogglePause);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    Ok((builder.build(app)?, pause))
}

/// Waits on the quit and command events. The quit event is how the main app
/// stops us before an update replaces the exe.
fn watch_events(app: AppHandle, tx: Sender<Msg>) {
    thread::spawn(move || unsafe {
        let (Ok(quit), Ok(cmd)) = (
            CreateEventW(None, false, false, QUIT_EVENT),
            CreateEventW(None, false, false, COMMAND_EVENT),
        ) else {
            return;
        };
        loop {
            let r = WaitForMultipleObjects(&[quit, cmd], false, INFINITE);
            if r == WAIT_OBJECT_0 {
                app.exit(0);
                return;
            } else if r.0 == WAIT_OBJECT_0.0 + 1 {
                let _ = tx.send(Msg::Events);
            } else {
                return;
            }
        }
    });
}

enum Phase {
    Idle,
    Arming { pressed: Instant, capture: Capture, released: bool },
    Recording { pressed: Instant, capture: Capture },
    Busy,
}

struct Agent {
    dir: PathBuf,
    store: Store,
    tx: Sender<Msg>,
    tray: TrayIcon<Wry>,
    pause_item: MenuItem<Wry>,
    cfg: Config,
    cfg_mtime: Option<SystemTime>,
    chord: Option<hotkey::Chord>,
    paused: bool,
    suspended_until: Option<Instant>,
    hints_shown: u32,
    phase: Phase,
    /// Where the in-flight recording was aimed; see `paste::Origin`.
    origin: Option<paste::Origin>,
}

impl Agent {
    fn new(dir: PathBuf, tx: Sender<Msg>, tray: TrayIcon<Wry>, pause_item: MenuItem<Wry>) -> Self {
        let store = Store::new(dir.clone());
        let hints_shown = store.stats().hints_shown;
        Agent {
            dir,
            store,
            tx,
            tray,
            pause_item,
            cfg: Config::default(),
            cfg_mtime: None,
            origin: None,
            chord: None,
            paused: false,
            suspended_until: None,
            hints_shown,
            phase: Phase::Idle,
        }
    }

    fn run(mut self, rx: Receiver<Msg>) {
        self.reload_config(true);
        // Commands dropped before we were running (the event had no listener).
        self.handle(Msg::Events);
        loop {
            let msg = match self.deadline() {
                Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                    Ok(m) => Some(m),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                },
                None => match rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => return,
                },
            };
            match msg {
                Some(m) => self.handle(m),
                None => self.on_deadline(),
            }
        }
    }

    fn s(&self) -> &DictationSettings {
        &self.cfg.settings
    }

    fn deadline(&self) -> Option<Instant> {
        let phase = match &self.phase {
            Phase::Arming { pressed, .. } => Some(*pressed + self.arm_delay()),
            Phase::Recording { pressed, .. } => Some(*pressed + Duration::from_secs(self.s().max_seconds.clamp(60, 900) as u64)),
            _ => None,
        };
        match (phase, self.suspended_until) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn arm_delay(&self) -> Duration {
        if self.chord.is_some_and(|c| c.modifier_only()) {
            ARM_DELAY
        } else {
            Duration::ZERO
        }
    }

    fn on_deadline(&mut self) {
        if self.suspended_until.is_some_and(|t| Instant::now() >= t) {
            self.suspended_until = None;
            self.apply_hook_state();
        }
        match &self.phase {
            Phase::Arming { pressed, .. } if pressed.elapsed() >= self.arm_delay() => self.enter_recording(),
            Phase::Recording { pressed, .. }
                if pressed.elapsed() >= Duration::from_secs(self.s().max_seconds.clamp(60, 900) as u64) =>
            {
                // At the limit: stop and transcribe. Nothing is lost.
                self.finish(None);
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------ config

    fn reload_config(&mut self, force: bool) {
        let path = self.dir.join("config.json");
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if !force && mtime == self.cfg_mtime {
            return;
        }
        self.cfg_mtime = mtime;
        self.cfg = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        self.chord = hotkey::parse_chord(&self.cfg.settings.shortcut);
        hotkey::set_chord(self.chord);
        overlay::set_theme(&self.cfg.theme);
        self.apply_hook_state();
    }

    fn apply_hook_state(&self) {
        let on = self.s().enabled && !self.paused && self.suspended_until.is_none();
        hotkey::set_enabled(on);
        let tip = if self.paused {
            "Dictation paused".to_string()
        } else {
            format!("Dictation ready · {}", self.s().shortcut)
        };
        let _ = self.tray.set_tooltip(Some(tip));
        let _ = self.pause_item.set_text(if self.paused { "Resume dictation" } else { "Pause dictation" });
    }

    // ------------------------------------------------------------ messages

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Hook(ev, at) => self.on_hook(ev, at),
            Msg::CaptureFailed(err) => {
                if matches!(self.phase, Phase::Arming { .. } | Phase::Recording { .. }) {
                    self.phase = Phase::Idle;
                    hotkey::set_active(false);
                    self.capture_error(err);
                }
            }
            Msg::JobDone(outcome) => {
                if matches!(self.phase, Phase::Busy) {
                    self.phase = Phase::Idle;
                }
                let (style, pos) = (self.s().style.clone(), self.s().position.clone());
                match outcome {
                    Outcome::Delivered(label) => overlay::done(&style, &pos, label),
                    Outcome::NothingHeard => overlay::notice(&pos, "Didn't catch that", "info", ClickAction::None),
                    Outcome::Unsent(reason) => {
                        // A rate limit is the one failure the user can simply
                        // outwait, so say that instead of "saved to Unsent".
                        let text = if reason == transcribe::RATE_LIMITED {
                            format!("{reason} · retry from Unsent later")
                        } else {
                            format!("{reason} · saved to Unsent")
                        };
                        overlay::notice(&pos, &text, "error", ClickAction::OpenSettings)
                    }
                    Outcome::Failed(reason) => overlay::notice(&pos, &reason, "error", ClickAction::OpenSettings),
                }
            }
            Msg::OverlayClick(action) => match action {
                ClickAction::MicSettings => open_mic_privacy(),
                ClickAction::OpenSettings => spawn_main_app(&[SETTINGS_ARG]),
                ClickAction::None => {}
            },
            Msg::Events => {
                self.reload_config(false);
                for cmd in take_commands(&self.dir) {
                    self.command(cmd);
                }
            }
            Msg::TogglePause => {
                self.paused = !self.paused;
                if self.paused {
                    self.discard();
                }
                self.apply_hook_state();
            }
        }
    }

    fn command(&mut self, cmd: Command) {
        match cmd {
            Command::Transcribe { id } => {
                let (cfg, store) = (self.cfg.clone(), Store::new(self.dir.clone()));
                thread::spawn(move || retry_unsent(&cfg, &store, &id));
            }
            Command::DeleteHistory { id } => self.store.delete_history(&id),
            Command::DeleteUnsent { id } => self.store.delete_unsent(&id),
            Command::ClearHistory => self.store.clear_history(),
            Command::Preview { style, position } => {
                if matches!(self.phase, Phase::Idle) {
                    overlay::preview(&style, &position);
                }
            }
            Command::Suspend { on } => {
                // Self-expiring, so a Settings window that goes away mid-record
                // can't leave dictation switched off.
                self.suspended_until = on.then(|| Instant::now() + Duration::from_secs(30));
                if on {
                    self.discard();
                }
                self.apply_hook_state();
            }
        }
    }

    fn on_hook(&mut self, ev: Event, at: Instant) {
        let hold = self.s().mode != "toggle";
        match (ev, &mut self.phase) {
            (Event::ChordDown, Phase::Idle) => self.start(at),
            (Event::ChordDown, Phase::Recording { .. }) if !hold => self.finish(None),
            (Event::ChordUp, Phase::Arming { released, .. }) => {
                if hold {
                    // A tap, released before the pill ever showed.
                    self.discard();
                    let pos = self.s().position.clone();
                    overlay::notice(&pos, "Didn't catch that", "info", ClickAction::None);
                } else {
                    *released = true;
                }
            }
            (Event::ChordUp, Phase::Recording { pressed, .. }) if hold => {
                let held = at.saturating_duration_since(*pressed);
                self.finish(Some(held));
            }
            // Ctrl+Win+D and friends: a native shortcut, not dictation.
            (Event::OtherKey, Phase::Arming { .. }) | (Event::Escape, Phase::Arming { .. }) => self.discard(),
            (Event::Escape, Phase::Recording { .. }) => self.cancel(),
            _ => {}
        }
    }

    // ------------------------------------------------------------ recording

    fn start(&mut self, pressed: Instant) {
        self.reload_config(false);
        if !self.s().enabled || self.paused {
            return;
        }
        if self.cfg.api_key.trim().is_empty() {
            let pos = self.s().position.clone();
            overlay::notice(&pos, "Add your OpenRouter key to dictate", "error", ClickAction::OpenSettings);
            return;
        }
        // Aim the recording now, at the window the user is looking at: the
        // transcript can take a second or two, and by then they may have moved
        // to another pane, project or app.
        let (agent, pane) = self.store.focused_pane();
        self.origin = Some(paste::capture_origin(agent, pane));
        hotkey::set_active(true);
        if self.s().start_sound {
            sound::prepare();
        }
        let tx = self.tx.clone();
        // Pre-size for up to 5 minutes (about 9.6 MB); longer recordings grow it.
        let keep = self.s().max_seconds.clamp(60, 300) as usize;
        let capture = Capture::start(
            self.s().mic_device_id.clone(),
            keep,
            Box::new(|lv| overlay::send_levels(lv)),
            Box::new(move |e| {
                let _ = tx.send(Msg::CaptureFailed(e));
            }),
        );
        self.phase = Phase::Arming { pressed, capture, released: false };
        // The overlay shows on key-down; only the start sound waits for the
        // arm delay, so Ctrl+Win+D and friends stay silent.
        let pill = self.s().style != "glow";
        overlay::begin(&self.s().style, &self.s().position, pill && self.hints_shown < 3, self.s().max_seconds.clamp(60, 900));
        if self.arm_delay().is_zero() {
            self.enter_recording();
        }
    }

    fn enter_recording(&mut self) {
        let Phase::Arming { pressed, capture, .. } = std::mem::replace(&mut self.phase, Phase::Idle) else {
            return;
        };
        if self.s().style != "glow" && self.hints_shown < 3 {
            self.hints_shown += 1;
            self.store.bump_hint();
        }
        if self.s().start_sound {
            sound::play(sound::Cue::Start);
        }
        self.phase = Phase::Recording { pressed, capture };
    }

    /// Drops an arming/recording capture without a trace.
    fn discard(&mut self) {
        self.origin = None;
        if let Phase::Arming { capture, .. } | Phase::Recording { capture, .. } =
            std::mem::replace(&mut self.phase, Phase::Idle)
        {
            hotkey::set_active(false);
            overlay::abort();
            drop(capture);
        }
    }

    fn cancel(&mut self) {
        self.origin = None;
        let Phase::Recording { capture, .. } = std::mem::replace(&mut self.phase, Phase::Idle) else {
            return;
        };
        hotkey::set_active(false);
        overlay::cancel();
        if self.s().start_sound {
            sound::play(sound::Cue::Cancel);
        }
        let Ok(rec) = capture.stop() else { return };
        if rec.duration_ms() > MIN_UNSENT_MS {
            let store = Store::new(self.dir.clone());
            thread::spawn(move || save_unsent(&store, &rec, "Cancelled", None, true));
        }
    }

    fn finish(&mut self, held: Option<Duration>) {
        let origin = self.origin.take();
        let Phase::Recording { capture, .. } = std::mem::replace(&mut self.phase, Phase::Idle) else {
            return;
        };
        hotkey::set_active(false);
        let rec = match capture.stop() {
            Ok(r) => r,
            Err(e) => return self.capture_error(e),
        };
        let too_short = held.is_some_and(|h| h < MIN_HOLD) || rec.duration_ms() < MIN_HOLD.as_millis() as u64;
        // Accidental taps and silent recordings cost nothing: no API call.
        if too_short || rec.peak_rms < audio::SILENCE_RMS {
            let pos = self.s().position.clone();
            overlay::notice(&pos, "Didn't catch that", "info", ClickAction::None);
            return;
        }
        if self.s().start_sound {
            sound::play(sound::Cue::Stop);
        }
        overlay::thinking(false);
        self.phase = Phase::Busy;
        let (cfg, store, tx) = (self.cfg.clone(), Store::new(self.dir.clone()), self.tx.clone());
        thread::spawn(move || {
            let outcome = deliver(&cfg, &store, rec, origin);
            let _ = tx.send(Msg::JobDone(outcome));
        });
    }

    fn capture_error(&self, err: CaptureError) {
        let pos = self.s().position.clone();
        match err {
            CaptureError::Blocked => overlay::notice(&pos, "Microphone is blocked", "error", ClickAction::MicSettings),
            CaptureError::NoDevice => overlay::notice(&pos, "No microphone found", "error", ClickAction::MicSettings),
            CaptureError::Failed(_) => {
                overlay::notice(&pos, "Couldn't open the microphone", "error", ClickAction::OpenSettings)
            }
        }
    }
}

// ---------------------------------------------------------------- pipeline

fn save_unsent(store: &Store, rec: &Recording, reason: &str, detail: Option<String>, cancelled: bool) {
    let Ok(flac) = encode::flac(&rec.samples) else { return };
    let item = UnsentItem {
        id: store::new_id(),
        created_at: store::now_ms(),
        duration_ms: rec.duration_ms(),
        reason: reason.to_string(),
        detail,
        cancelled,
        app: None,
        audio: None,
        updated_at: 0,
    };
    store.add_unsent(item, &flac);
}

async fn transcribe_and_polish(cfg: &Config, flac: &[u8]) -> Result<(String, transcribe::Transcript), transcribe::Failure> {
    let s = &cfg.settings;
    // Each retry says so on the pill: a silent 15-second wait reads as a hang.
    let on_retry =
        |n: u32, of: u32, reason: &str| overlay::status(&format!("{reason} · retrying {n}/{of}"));
    let t = transcribe::transcribe(
        &cfg.api_key,
        flac,
        s.language.as_deref(),
        &s.transcribe_style,
        &s.vocabulary,
        &on_retry,
    )
    .await?;
    overlay::clear_status();
    let mut text = t.text.clone();
    if s.ai_polish && !text.is_empty() {
        overlay::thinking(true);
        if let Some(p) = transcribe::polish(&cfg.api_key, &text, &s.vocabulary).await {
            text = p.trim().to_string();
        }
    }
    Ok((text, t))
}

/// True when focus is already exactly where the recording was aimed. A pane
/// only counts when the recording was aimed at OpenTerm; panes shuffling in
/// the background are irrelevant to any other app.
fn aimed_here(store: &Store, origin: &paste::Origin) -> bool {
    paste::is_foreground(origin.hwnd) && (!origin.openterm || store.focused_pane().1 == origin.pane)
}

/// Puts focus back where the recording was aimed: the window first, then —
/// for OpenTerm — the pane, which only the main app can switch, so it is
/// asked over the focus event and then waited on. Returns false if the
/// destination can't be reached (it was closed, or Windows refused the
/// foreground change), in which case the caller types nothing.
fn restore_aim(store: &Store, origin: &paste::Origin) -> bool {
    if aimed_here(store, origin) {
        return true;
    }
    if !paste::focus_window(origin.hwnd) {
        return false;
    }
    if origin.openterm {
        if let Some(pane) = origin.pane.as_deref() {
            if store.focused_pane().1.as_deref() != Some(pane) {
                store.write_focus_request(pane);
                signal(FOCUS_EVENT);
                // The app republishes the focused pane once it switches, so
                // that file is the acknowledgement we wait on.
                for _ in 0..60 {
                    if store.focused_pane().1.as_deref() == Some(pane) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
    aimed_here(store, origin)
}

/// Picks the window the transcript goes to. With target locking on, that is
/// the window (and pane) captured at key-down, brought back to the front if
/// the user has moved on since. `false` means the destination is unreachable
/// and nothing should be typed.
fn resolve_target(cfg: &Config, store: &Store, origin: Option<paste::Origin>) -> (paste::Target, bool) {
    let Some(origin) = origin.filter(|_| cfg.settings.lock_target) else {
        return (paste::inspect_foreground(store.focused_agent()), true);
    };
    let reachable = restore_aim(store, &origin);
    (paste::inspect_origin(&origin), reachable)
}

fn deliver(cfg: &Config, store: &Store, rec: Recording, origin: Option<paste::Origin>) -> Outcome {
    let flac = match encode::flac(&rec.samples) {
        Ok(f) => f,
        Err(_) => return Outcome::Failed("Couldn't encode the audio".into()),
    };
    let (text, t) = match tauri::async_runtime::block_on(transcribe_and_polish(cfg, &flac)) {
        Ok(ok) => ok,
        Err(f) => {
            save_unsent(store, &rec, &f.reason, Some(f.detail), false);
            return Outcome::Unsent(f.reason);
        }
    };
    if text.is_empty() {
        return Outcome::NothingHeard;
    }

    let (target, reachable) = resolve_target(cfg, store, origin);
    let prepared = paste::prepare_text(&text, target.terminal);
    let copied = paste::set_clipboard(&prepared).is_ok();
    let label = if !copied {
        None
    } else if !reachable {
        Some("Copied · where you dictated is gone")
    } else if target.pasteable && paste::wait_keys_up(Duration::from_secs(3)) {
        paste::paste(target.agent);
        Some("Pasted")
    } else {
        Some("Copied · Ctrl+V to paste")
    };

    let item = HistoryItem {
        id: store::new_id(),
        text: text.clone(),
        created_at: store::now_ms(),
        duration_ms: rec.duration_ms(),
        language: cfg.settings.language.clone(),
        app: target.app,
        cost: t.cost,
        audio: None,
        audio_expired: false,
    };
    let seconds = t.seconds.unwrap_or(rec.duration_ms() as f64 / 1000.0);
    store.add_history(item, Some(&flac), seconds);
    match label {
        Some(l) => Outcome::Delivered(l),
        None => Outcome::Failed("Clipboard is busy · saved to History".into()),
    }
}

/// Settings' "Transcribe" on an Unsent row: same pipeline, but the result is
/// only copied (the user is in Settings, not in a text field).
fn retry_unsent(cfg: &Config, store: &Store, id: &str) {
    let Some(item) = store.unsent().into_iter().find(|u| u.id == id) else { return };
    let Some(flac) = item.audio.as_ref().and_then(|a| std::fs::read(store.audio_dir().join(a)).ok()) else {
        store.set_unsent_reason(id, "Audio is missing", "The recording's audio file is gone.");
        return;
    };
    match tauri::async_runtime::block_on(transcribe_and_polish(cfg, &flac)) {
        Ok((text, _)) if text.is_empty() => {
            store.set_unsent_reason(id, "Nothing was heard", "The transcription came back empty.")
        }
        Ok((text, t)) => {
            let _ = paste::set_clipboard(&paste::prepare_text(&text, false));
            let history = HistoryItem {
                id: store::new_id(),
                text,
                created_at: store::now_ms(),
                duration_ms: item.duration_ms,
                language: cfg.settings.language.clone(),
                app: item.app.clone(),
                cost: t.cost,
                audio: None,
                audio_expired: false,
            };
            store.promote_unsent(id, history, t.seconds.unwrap_or(item.duration_ms as f64 / 1000.0));
        }
        Err(f) => store.set_unsent_reason(id, &f.reason, &f.detail),
    }
}
