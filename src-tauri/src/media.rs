//! Now playing: whatever is playing on the PC, read and driven through Windows'
//! own media controls (SMTC, the same layer behind the volume-key flyout).
//!
//! Browsers hand the Media Session of their tab (YouTube Music, SoundCloud…)
//! to SMTC, and Spotify registers there directly, so one API covers them all
//! without scraping anything — and it doesn't care where the audio goes
//! (speakers, wired, Bluetooth). SMTC has no volume, so that comes from the
//! app's own audio session on the default output device (the per-app slider in
//! the Windows volume mixer), with the system volume as the fallback.
//!
//! Everything lives on one thread that owns the WinRT and COM objects: the
//! frontend's commands are queued to it, and it emits `media-state` whenever a
//! snapshot changes (plus `media-level`, the app's live output peak, while the
//! frontend asks for the meter).

use std::collections::HashMap;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{Interface, BOOL, PWSTR};
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Media::MediaPlaybackAutoRepeatMode;
use windows::Storage::Streams::DataReader;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
    MMDeviceEnumerator,
};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationLegacyIAccessiblePattern,
    IUIAutomationSelectionItemPattern, TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_LegacyIAccessiblePatternId,
    UIA_SelectionItemPatternId, UIA_TabItemControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// One media source as the frontend sees it.
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    /// The app's AppUserModelID — stable for as long as the app runs.
    id: String,
    /// Display name ("Spotify", "Chrome", …).
    app: String,
    /// Icon family: "spotify" | "chrome" | "edge" | "firefox" | "browser" | "other".
    kind: String,
    title: String,
    artist: String,
    album: String,
    /// "playing" | "paused" | "stopped" | "changing" | "closed".
    status: String,
    /// Position extrapolated to `MediaState::at_ms`; the frontend keeps it
    /// moving between snapshots.
    position_ms: f64,
    duration_ms: f64,
    rate: f64,
    can_play_pause: bool,
    can_next: bool,
    can_prev: bool,
    can_seek: bool,
    shuffle: Option<bool>,
    /// "none" | "track" | "list" — None when the app doesn't say.
    repeat: Option<String>,
    can_shuffle: bool,
    can_repeat: bool,
    /// Cover art as a data URL.
    art: Option<String>,
    /// The app's own volume (0–1), or None when it has no audio session.
    volume: Option<f32>,
    muted: Option<bool>,
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    sources: Vec<MediaSource>,
    /// Windows' own pick of the source the media keys drive.
    current: Option<String>,
    system_volume: Option<f32>,
    system_muted: Option<bool>,
    /// Wall clock (epoch ms) the positions above were measured at.
    at_ms: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediaLevel {
    id: String,
    level: f32,
}

enum Msg {
    Watch { on: bool, meter: Option<String> },
    Control { id: String, action: String, value: Option<f64> },
    /// An SMTC event fired; re-read on the next turn.
    Dirty,
}

static TX: OnceLock<Mutex<Sender<Msg>>> = OnceLock::new();

fn send(msg: Msg, app: &AppHandle) {
    let tx = TX.get_or_init(|| {
        let (tx, rx) = channel::<Msg>();
        let app = app.clone();
        let tx2 = tx.clone();
        std::thread::Builder::new()
            .name("media".into())
            .spawn(move || run(app, rx, tx2))
            .expect("spawn media thread");
        Mutex::new(tx)
    });
    let _ = tx.lock().unwrap().send(msg);
}

/// Start or stop following media. `meter` names the source whose output level
/// should stream as `media-level` (None turns the meter off).
#[tauri::command]
pub fn media_watch(app: AppHandle, on: bool, meter: Option<String>) {
    send(Msg::Watch { on, meter }, &app);
}

/// Drive a source: toggle | next | prev | seek (ms) | shuffle (0/1) |
/// repeat (0 none, 1 track, 2 list) | volume (0–1) | mute (0/1). An empty id
/// with volume/mute targets the system volume.
#[tauri::command]
pub fn media_control(app: AppHandle, id: String, action: String, value: Option<f64>) {
    send(Msg::Control { id, action, value }, &app);
}

// ------------------------------------------------------------------ thread

/// Per-source bits that outlive a snapshot.
#[derive(Default)]
struct Cache {
    /// title|artist|album the art below belongs to.
    art_key: String,
    art: Option<String>,
    /// When this track was first seen. Browsers publish the title first and
    /// the cover a moment later — in between the "artwork" is the browser's
    /// own icon or still the previous song's cover — so the art is re-read
    /// through the track's first seconds and the latest real one wins.
    art_since: Option<Instant>,
}

/// How long into a track its art keeps being re-read.
const ART_SETTLE: Duration = Duration::from_secs(12);

struct AppAudio {
    volumes: Vec<ISimpleAudioVolume>,
    meters: Vec<IAudioMeterInformation>,
}

struct Audio {
    endpoint: Option<IAudioEndpointVolume>,
    by_exe: HashMap<String, AppAudio>,
    read_at: Option<Instant>,
}

fn run(app: AppHandle, rx: std::sync::mpsc::Receiver<Msg>, tx: Sender<Msg>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut manager: Option<Manager> = None;
    let mut manager_tried: Option<Instant> = None;
    let mut watching = false;
    let mut meter: Option<String> = None;
    let mut last: Option<MediaState> = None;
    let mut caches: HashMap<String, Cache> = HashMap::new();
    let mut hooked: Vec<(Session, i64, i64, i64)> = Vec::new();
    let mut audio = Audio { endpoint: None, by_exe: HashMap::new(), read_at: None };
    // Right after a command the app takes a moment to publish its new state;
    // look again a few times quickly so the UI catches it without waiting.
    let mut burst: Vec<Instant> = Vec::new();
    // The frontend shows a command's effect before the app confirms it, so
    // resend the state once things settle even if nothing changed — that's
    // what undoes the optimistic update when the app ignored the command.
    let mut force_at: Option<Instant> = None;
    let mut next_snapshot = Instant::now();

    loop {
        let now = Instant::now();
        let wait = if !watching {
            Duration::from_secs(3600)
        } else if !burst.is_empty() || force_at.is_some() {
            Duration::from_millis(30)
        } else if meter.is_some() {
            Duration::from_millis(50)
        } else {
            next_snapshot.saturating_duration_since(now).max(Duration::from_millis(20))
        };
        let mut dirty = false;
        match rx.recv_timeout(wait) {
            Ok(msg) => {
                let mut pending = vec![msg];
                pending.extend(rx.try_iter());
                for m in pending {
                    match m {
                        Msg::Watch { on, meter: mt } => {
                            if on && !watching {
                                last = None; // re-announce to a reloaded frontend
                            }
                            watching = on;
                            meter = if on { mt } else { None };
                            dirty = true;
                        }
                        Msg::Control { id, action, value } => {
                            if let Some(m) = &manager {
                                control(m, &mut audio, &id, &action, value);
                            }
                            let t = Instant::now();
                            burst = [60u64, 250, 600, 1200]
                                .iter()
                                .map(|ms| t + Duration::from_millis(*ms))
                                .collect();
                            force_at = Some(t + Duration::from_millis(1500));
                            dirty = true;
                        }
                        Msg::Dirty => dirty = true,
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if !watching {
            continue;
        }

        if manager.is_none() && manager_tried.map_or(true, |t| t.elapsed() > Duration::from_secs(10)) {
            manager_tried = Some(Instant::now());
            manager = open_manager(&tx);
            dirty = true;
        }

        let now = Instant::now();
        if let Some(i) = burst.iter().position(|t| *t <= now) {
            burst.drain(..=i);
            dirty = true;
        }
        let forced = force_at.is_some_and(|t| t <= now);
        if forced {
            force_at = None;
            last = None;
        }
        let due = now >= next_snapshot;
        if dirty || due || forced {
            next_snapshot = now + Duration::from_millis(700);
            if let Some(m) = &manager {
                let state = snapshot(m, &mut caches, &mut audio, &mut hooked, &tx);
                if last.as_ref().map_or(true, |l| !same(l, &state)) {
                    let _ = app.emit("media-state", &state);
                    last = Some(state);
                }
            } else if last.is_none() {
                let empty = MediaState {
                    sources: vec![],
                    current: None,
                    system_volume: None,
                    system_muted: None,
                    at_ms: epoch_ms(),
                };
                let _ = app.emit("media-state", &empty);
                last = Some(empty);
            }
        }

        if let (Some(id), Some(state)) = (&meter, &last) {
            if let Some(src) = state.sources.iter().find(|s| &s.id == id) {
                let level = if src.status == "playing" {
                    audio
                        .by_exe
                        .get(&exe_for(id))
                        .map(|a| {
                            a.meters
                                .iter()
                                .filter_map(|m| unsafe { m.GetPeakValue().ok() })
                                .fold(0.0f32, f32::max)
                        })
                        .unwrap_or(-1.0)
                } else {
                    0.0
                };
                let _ = app.emit("media-level", MediaLevel { id: id.clone(), level });
            }
        }
    }
}

/// Two snapshots are the same if nothing but the clock moved: positions are
/// extrapolated, so compare where each says playback *started*.
fn same(a: &MediaState, b: &MediaState) -> bool {
    if a.sources.len() != b.sources.len()
        || a.current != b.current
        || a.system_volume != b.system_volume
        || a.system_muted != b.system_muted
    {
        return false;
    }
    a.sources.iter().zip(&b.sources).all(|(x, y)| {
        let mut x2 = x.clone();
        x2.position_ms = y.position_ms;
        if x2 != *y {
            return false;
        }
        if x.status != "playing" {
            return (x.position_ms - y.position_ms).abs() < 1.0;
        }
        let start_x = a.at_ms - x.position_ms / x.rate.max(0.01);
        let start_y = b.at_ms - y.position_ms / y.rate.max(0.01);
        (start_x - start_y).abs() < 1500.0
    })
}

fn open_manager(tx: &Sender<Msg>) -> Option<Manager> {
    let m = Manager::RequestAsync().ok()?.get().ok()?;
    let t1 = tx.clone();
    let _ = m.SessionsChanged(&TypedEventHandler::new(move |_, _| {
        let _ = t1.send(Msg::Dirty);
        Ok(())
    }));
    let t2 = tx.clone();
    let _ = m.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
        let _ = t2.send(Msg::Dirty);
        Ok(())
    }));
    Some(m)
}

fn hook(s: &Session, tx: &Sender<Msg>) -> (i64, i64, i64) {
    let a = tx.clone();
    let b = tx.clone();
    let c = tx.clone();
    let t1 = s
        .MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = a.send(Msg::Dirty);
            Ok(())
        }))
        .unwrap_or(0);
    let t2 = s
        .PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
            let _ = b.send(Msg::Dirty);
            Ok(())
        }))
        .unwrap_or(0);
    let t3 = s
        .TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = c.send(Msg::Dirty);
            Ok(())
        }))
        .unwrap_or(0);
    (t1, t2, t3)
}

fn sessions(m: &Manager) -> Vec<Session> {
    let Ok(list) = m.GetSessions() else { return vec![] };
    let n = list.Size().unwrap_or(0);
    (0..n).filter_map(|i| list.GetAt(i).ok()).collect()
}

fn session_id(s: &Session) -> String {
    s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default()
}

fn snapshot(
    m: &Manager,
    caches: &mut HashMap<String, Cache>,
    audio: &mut Audio,
    hooked: &mut Vec<(Session, i64, i64, i64)>,
    tx: &Sender<Msg>,
) -> MediaState {
    let list = sessions(m);

    // Keep exactly one set of event hooks per live session.
    let ids: Vec<String> = list.iter().map(session_id).collect();
    hooked.retain(|(s, a, b, c)| {
        let keep = ids.contains(&session_id(s));
        if !keep {
            let _ = s.RemoveMediaPropertiesChanged(*a);
            let _ = s.RemovePlaybackInfoChanged(*b);
            let _ = s.RemoveTimelinePropertiesChanged(*c);
        }
        keep
    });
    for s in &list {
        let id = session_id(s);
        if !hooked.iter().any(|(h, ..)| session_id(h) == id) {
            let (a, b, c) = hook(s, tx);
            hooked.push((s.clone(), a, b, c));
        }
    }
    caches.retain(|k, _| ids.contains(k));

    if audio.read_at.map_or(true, |t| t.elapsed() > Duration::from_secs(3)) {
        read_audio(audio);
    }

    let now_ms = epoch_ms();
    let mut sources = Vec::new();
    for s in &list {
        if let Some(src) = read_source(s, caches, audio, now_ms) {
            sources.push(src);
        }
    }
    let current = m.GetCurrentSession().ok().map(|s| session_id(&s));
    let (system_volume, system_muted) = match &audio.endpoint {
        Some(e) => unsafe {
            (
                e.GetMasterVolumeLevelScalar().ok(),
                e.GetMute().ok().map(|b| b.as_bool()),
            )
        },
        None => (None, None),
    };
    MediaState { sources, current, system_volume, system_muted, at_ms: now_ms }
}

fn read_source(s: &Session, caches: &mut HashMap<String, Cache>, audio: &Audio, now_ms: f64) -> Option<MediaSource> {
    let id = session_id(s);
    let props = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
    let mut artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    if artist.is_empty() {
        artist = props.AlbumArtist().map(|h| h.to_string()).unwrap_or_default();
    }
    let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();

    let info = s.GetPlaybackInfo().ok()?;
    let status = match info.PlaybackStatus().unwrap_or(Status::Closed) {
        Status::Playing => "playing",
        Status::Paused => "paused",
        Status::Stopped => "stopped",
        Status::Changing => "changing",
        Status::Opened => "paused",
        _ => "closed",
    };
    let rate = info.PlaybackRate().and_then(|r| r.Value()).unwrap_or(1.0);
    let rate = if rate > 0.0 { rate } else { 1.0 };
    let controls = info.Controls().ok();
    let flag = |f: &dyn Fn(&windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackControls) -> windows::core::Result<bool>| {
        controls.as_ref().and_then(|c| f(c).ok()).unwrap_or(false)
    };
    let can_play_pause = flag(&|c| Ok(c.IsPlayPauseToggleEnabled()? || c.IsPlayEnabled()? || c.IsPauseEnabled()?));
    let can_next = flag(&|c| c.IsNextEnabled());
    let can_prev = flag(&|c| c.IsPreviousEnabled());
    let can_seek = flag(&|c| c.IsPlaybackPositionEnabled());
    let can_shuffle = flag(&|c| c.IsShuffleEnabled());
    let can_repeat = flag(&|c| c.IsRepeatEnabled());
    let shuffle = info.IsShuffleActive().and_then(|r| r.Value()).ok();
    let repeat = info.AutoRepeatMode().and_then(|r| r.Value()).ok().map(|m| {
        match m {
            MediaPlaybackAutoRepeatMode::Track => "track",
            MediaPlaybackAutoRepeatMode::List => "list",
            _ => "none",
        }
        .to_string()
    });

    // Timeline: SMTC reports where playback was at LastUpdatedTime; carry it
    // forward to now so every snapshot is self-consistent.
    let (mut position_ms, mut duration_ms) = (0.0, 0.0);
    if let Ok(t) = s.GetTimelineProperties() {
        let start = t.StartTime().map(|d| d.Duration).unwrap_or(0);
        let end = t.EndTime().map(|d| d.Duration).unwrap_or(0);
        let pos = t.Position().map(|d| d.Duration).unwrap_or(0);
        duration_ms = ((end - start).max(0)) as f64 / 10_000.0;
        position_ms = ((pos - start).max(0)) as f64 / 10_000.0;
        if status == "playing" {
            if let Ok(u) = t.LastUpdatedTime() {
                // DateTime counts 100 ns ticks since 1601-01-01.
                let updated = u.UniversalTime as f64 / 10_000.0 - 11_644_473_600_000.0;
                let elapsed = now_ms - updated;
                if updated > 0.0 && (0.0..6.0 * 3_600_000.0).contains(&elapsed) {
                    position_ms += elapsed * rate;
                }
            }
        }
        if duration_ms > 0.0 {
            position_ms = position_ms.min(duration_ms);
        }
    }

    let cache = caches.entry(id.clone()).or_default();
    let key = format!("{title}\u{1}{artist}\u{1}{album}");
    if cache.art_key != key {
        cache.art_key = key;
        cache.art = None;
        cache.art_since = Some(Instant::now());
    }
    // Still nothing real past that: keep looking for a while longer.
    let age = cache.art_since.map(|t| t.elapsed());
    if age.is_some_and(|a| a < ART_SETTLE || (cache.art.is_none() && a < ART_SETTLE * 10)) {
        if let Some(art) = read_art(&props) {
            cache.art = Some(art);
        }
    }

    let exe = exe_for(&id);
    let (volume, muted) = match audio.by_exe.get(&exe).and_then(|a| a.volumes.first()) {
        Some(v) => unsafe { (v.GetMasterVolume().ok(), v.GetMute().ok().map(|b| b.as_bool())) },
        None => (None, None),
    };
    let (app, kind) = app_name(&id);

    Some(MediaSource {
        id,
        app,
        kind,
        title,
        artist,
        album,
        status: status.to_string(),
        position_ms,
        duration_ms,
        rate,
        can_play_pause,
        can_next,
        can_prev,
        can_seek: can_seek && duration_ms > 0.0,
        shuffle,
        repeat,
        can_shuffle,
        can_repeat,
        art: cache.art.clone(),
        volume,
        muted,
    })
}

fn read_art(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    let r = props.Thumbnail().ok()?;
    let stream = r.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > 8 * 1024 * 1024 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    if is_app_icon(&buf) {
        return None;
    }
    let ct = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
    let mime = if ct.starts_with("image/") {
        ct
    } else if buf.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png".into()
    } else if buf.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg".into()
    } else if buf.len() > 12 && &buf[8..12] == b"WEBP" {
        "image/webp".into()
    } else {
        "image/jpeg".into()
    };
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

/// True for an app's own icon standing in for cover art (Chrome hands Windows
/// its logo until the page's artwork has loaded). Icons are drawn on a
/// transparent square; a cover never has see-through corners.
fn is_app_icon(buf: &[u8]) -> bool {
    if !buf.starts_with(&[0x89, b'P', b'N', b'G']) {
        return false;
    }
    let Ok(img) = image::load_from_memory_with_format(buf, image::ImageFormat::Png) else { return false };
    let img = img.to_rgba8();
    let (w, h) = img.dimensions();
    if w < 4 || h < 4 {
        return true;
    }
    let inset = (w.min(h) / 32).max(1);
    [(inset, inset), (w - 1 - inset, inset), (inset, h - 1 - inset), (w - 1 - inset, h - 1 - inset)]
        .iter()
        .all(|&(x, y)| img.get_pixel(x, y)[3] < 24)
}

/// Friendly name and icon family for an AppUserModelID.
fn app_name(id: &str) -> (String, String) {
    let l = id.to_ascii_lowercase();
    let (name, kind) = if l.contains("spotify") {
        ("Spotify", "spotify")
    } else if l.contains("msedge") || l.contains("edge") {
        ("Edge", "edge")
    } else if l.contains("chrome") {
        ("Chrome", "chrome")
    } else if l.contains("firefox") || l == "308046b0af4a39cb" {
        ("Firefox", "firefox")
    } else if l.contains("brave") {
        ("Brave", "browser")
    } else if l.contains("opera") {
        ("Opera", "browser")
    } else if l.contains("vivaldi") {
        ("Vivaldi", "browser")
    } else if l.contains("arc") && l.contains("browser") {
        ("Arc", "browser")
    } else {
        let tail = id.rsplit(['!', '\\', '/']).next().unwrap_or(id);
        let tail = tail.strip_suffix(".exe").unwrap_or(tail);
        let tail = tail.rsplit('.').next().unwrap_or(tail);
        return (tail.to_string(), "other".into());
    };
    (name.into(), kind.into())
}

/// The process image the source's audio comes from, lowercased. Chrome and
/// Edge play from a utility child process, but it carries the same image name.
fn exe_for(id: &str) -> String {
    let l = id.to_ascii_lowercase();
    if l.contains("spotify") {
        return "spotify.exe".into();
    }
    if l.contains("msedge") {
        return "msedge.exe".into();
    }
    if l.contains("chrome") {
        return "chrome.exe".into();
    }
    if l.contains("firefox") || l == "308046b0af4a39cb" {
        return "firefox.exe".into();
    }
    let tail = l.rsplit(['!', '\\', '/']).next().unwrap_or(&l).to_string();
    if tail.ends_with(".exe") {
        tail
    } else {
        format!("{}.exe", tail.rsplit('.').next().unwrap_or(&tail))
    }
}

fn read_audio(audio: &mut Audio) {
    audio.read_at = Some(Instant::now());
    audio.by_exe.clear();
    audio.endpoint = None;
    unsafe {
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return };
        let Ok(device) = en.GetDefaultAudioEndpoint(eRender, eMultimedia) else { return };
        audio.endpoint = device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok();
        let Ok(mgr) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { return };
        let Ok(list) = mgr.GetSessionEnumerator() else { return };
        let n = list.GetCount().unwrap_or(0);
        for i in 0..n {
            let Ok(ctl) = list.GetSession(i) else { continue };
            let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            let Ok(pid) = ctl2.GetProcessId() else { continue };
            let Some(exe) = process_exe(pid) else { continue };
            let entry = audio.by_exe.entry(exe).or_insert_with(|| AppAudio { volumes: vec![], meters: vec![] });
            if let Ok(v) = ctl.cast::<ISimpleAudioVolume>() {
                entry.volumes.push(v);
            }
            if let Ok(m) = ctl.cast::<IAudioMeterInformation>() {
                entry.meters.push(m);
            }
        }
    }
}

fn process_exe(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        Some(path.rsplit('\\').next().unwrap_or(&path).to_ascii_lowercase())
    }
}

fn control(m: &Manager, audio: &mut Audio, id: &str, action: &str, value: Option<f64>) {
    if matches!(action, "volume" | "mute") {
        if audio.read_at.map_or(true, |t| t.elapsed() > Duration::from_millis(500)) {
            read_audio(audio);
        }
        let v = value.unwrap_or(0.0);
        let app = if id.is_empty() { None } else { audio.by_exe.get(&exe_for(id)) };
        unsafe {
            match (app, action) {
                (Some(a), "volume") => a.volumes.iter().for_each(|x| {
                    let _ = x.SetMasterVolume(v.clamp(0.0, 1.0) as f32, std::ptr::null());
                }),
                (Some(a), _) => a.volumes.iter().for_each(|x| {
                    let _ = x.SetMute(v != 0.0, std::ptr::null());
                }),
                (None, "volume") => {
                    if let Some(e) = &audio.endpoint {
                        let _ = e.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0) as f32, std::ptr::null());
                    }
                }
                (None, _) => {
                    if let Some(e) = &audio.endpoint {
                        let _ = e.SetMute(v != 0.0, std::ptr::null());
                    }
                }
            }
        }
        return;
    }

    let Some(s) = sessions(m).into_iter().find(|s| session_id(s) == id) else { return };
    let op = match action {
        "toggle" => s.TryTogglePlayPauseAsync(),
        "play" => s.TryPlayAsync(),
        "pause" => s.TryPauseAsync(),
        "next" => s.TrySkipNextAsync(),
        "prev" => s.TrySkipPreviousAsync(),
        "seek" => {
            let start = s
                .GetTimelineProperties()
                .and_then(|t| t.StartTime())
                .map(|d| d.Duration)
                .unwrap_or(0);
            s.TryChangePlaybackPositionAsync(start + (value.unwrap_or(0.0).max(0.0) * 10_000.0) as i64)
        }
        "shuffle" => s.TryChangeShuffleActiveAsync(value.unwrap_or(0.0) != 0.0),
        "repeat" => s.TryChangeAutoRepeatModeAsync(match value.unwrap_or(0.0) as i32 {
            1 => MediaPlaybackAutoRepeatMode::Track,
            2 => MediaPlaybackAutoRepeatMode::List,
            _ => MediaPlaybackAutoRepeatMode::None,
        }),
        _ => return,
    };
    if let Ok(op) = op {
        let _ = op.get();
    }
}

fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// ------------------------------------------------------------------ go to source

/// Brings the app a source plays in to the front. For a browser it also
/// selects the tab the sound comes from: Chrome and Edge name a sounding tab
/// "… - Audio playing" for screen readers, which UI Automation can see, and
/// the track title usually appears in the tab's name too.
#[tauri::command]
pub fn media_focus_source(id: String, title: String) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        focus_source(&id, &title);
    });
}

fn focus_source(id: &str, title: &str) {
    let windows = app_windows(&exe_for(id));
    let Some(&first) = windows.first() else { return };
    let (_, kind) = app_name(id);
    let browser = matches!(kind.as_str(), "chrome" | "edge" | "firefox" | "browser");
    let target = if browser { select_sounding_tab(&windows, title).unwrap_or(first) } else { first };
    unsafe {
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        let _ = SetForegroundWindow(target);
    }
}

/// The app's visible top-level windows, frontmost first.
fn app_windows(exe: &str) -> Vec<HWND> {
    struct Search<'a> {
        exe: &'a str,
        found: Vec<HWND>,
    }
    unsafe extern "system" fn each(h: HWND, lp: LPARAM) -> BOOL {
        let search = &mut *(lp.0 as *mut Search);
        if IsWindowVisible(h).as_bool()
            && GetWindowTextLengthW(h) > 0
            && GetWindow(h, GW_OWNER).map_or(true, |o| o.0.is_null())
        {
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if process_exe(pid).as_deref() == Some(search.exe) {
                search.found.push(h);
            }
        }
        BOOL(1)
    }
    let mut search = Search { exe, found: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut search as *mut Search as isize));
    }
    search.found
}

/// Selects the browser tab that is playing, and returns its window.
fn select_sounding_tab(windows: &[HWND], title: &str) -> Option<HWND> {
    unsafe {
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let cond = uia
            .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0))
            .ok()?;
        let title = title.to_lowercase();
        let mut best: Option<(i32, IUIAutomationElement, HWND)> = None;
        for &w in windows {
            let Ok(root) = uia.ElementFromHandle(w) else { continue };
            let Ok(tabs) = root.FindAll(TreeScope_Descendants, &cond) else { continue };
            for i in 0..tabs.Length().unwrap_or(0) {
                let Ok(tab) = tabs.GetElement(i) else { continue };
                let name = tab.CurrentName().map(|b| b.to_string().to_lowercase()).unwrap_or_default();
                let mut score = 0;
                if name.contains("audio playing") || name.contains("playing audio") {
                    score += 4;
                }
                if !title.is_empty() && name.contains(&title) {
                    score += 2;
                }
                if score > best.as_ref().map_or(0, |b| b.0) {
                    best = Some((score, tab, w));
                }
            }
        }
        let (_, tab, w) = best?;
        if let Ok(item) = tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            let _ = item.Select();
        } else if let Ok(legacy) = tab.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            let _ = legacy.DoDefaultAction();
        }
        Some(w)
    }
}
