//! Timers: the time-critical half. The frontend owns the timers themselves
//! (goal, pause, history); this thread only knows when each one ends, and it
//! fires on time even while the window is minimised, when the webview's own
//! timers are throttled to a crawl. It plays the last-15-seconds ticking and
//! the alarm, and emits `timer-fired` / `timer-ring-ended`.
//!
//! Sounds are synthesized by scripts/gen-timer-sounds.mjs. The alarm loops one
//! bar, swelling in over its first seconds, and stops by itself after 45 s.
//! As it starts, every other app's audio (music, a video) dips for a few
//! seconds so the alarm reads clearly, then comes back where it was.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::Interface;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

const TICK: &[u8] = include_bytes!("../sounds/timer-tick.wav");
const TOCK: &[u8] = include_bytes!("../sounds/timer-tock.wav");
const RING: &[u8] = include_bytes!("../sounds/timer-ring.wav");

/// The ticking covers this many final seconds.
const TICK_SECONDS: i64 = 15;
/// The alarm gives up after this long; the timer stays "done" in the UI.
const RING_FOR: Duration = Duration::from_secs(45);
const RING_SWELL: Duration = Duration::from_secs(6);
const RING_FADE: Duration = Duration::from_millis(700);
/// Close the audio device after this much silence.
const IDLE_CLOSE: Duration = Duration::from_secs(20);

#[derive(Clone)]
struct Scheduled {
    ends_at_ms: f64,
    tick: bool,
    ring: bool,
    duck: bool,
    /// Seconds-left values already ticked, so a wake-up never ticks twice.
    ticked: i64,
}

enum Cmd {
    Schedule { id: String, ends_at_ms: f64, tick: bool, ring: bool, duck: bool },
    Cancel { id: String },
    StopRing,
    Preview { what: String, duck: bool },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Fired {
    id: String,
    /// Whether the alarm is sounding for it.
    ringing: bool,
}

static TX: OnceLock<Mutex<Sender<Cmd>>> = OnceLock::new();

fn send(cmd: Cmd, app: &AppHandle) {
    let tx = TX.get_or_init(|| {
        let (tx, rx) = channel::<Cmd>();
        let app = app.clone();
        std::thread::Builder::new()
            .name("timers".into())
            .spawn(move || run(app, rx))
            .expect("spawn timers thread");
        Mutex::new(tx)
    });
    let _ = tx.lock().unwrap().send(cmd);
}

/// Arm (or re-arm) a timer to end at `ends_at_ms` (epoch ms).
#[tauri::command]
pub fn timer_schedule(app: AppHandle, id: String, ends_at_ms: f64, tick: bool, ring: bool, duck: Option<bool>) {
    send(Cmd::Schedule { id, ends_at_ms, tick, ring, duck: duck.unwrap_or(true) }, &app);
}

/// Disarm a timer (paused, cancelled or changed).
#[tauri::command]
pub fn timer_cancel(app: AppHandle, id: String) {
    send(Cmd::Cancel { id }, &app);
}

/// Silence the alarm, with a short fade.
#[tauri::command]
pub fn timer_stop_ring(app: AppHandle) {
    send(Cmd::StopRing, &app);
}

/// Play a sample from Settings: "tick" (a few seconds of ticking) or "ring"
/// (a few bars of the alarm).
#[tauri::command]
pub fn timer_preview(app: AppHandle, what: String, duck: Option<bool>) {
    send(Cmd::Preview { what, duck: duck.unwrap_or(true) }, &app);
}

struct Audio {
    _stream: OutputStream,
    handle: OutputStreamHandle,
}

struct Ring {
    sink: Sink,
    started: Instant,
    /// Ends after this long (the full alarm, or a short preview).
    limit: Duration,
    fading: Option<Instant>,
    swell: bool,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn run(app: AppHandle, rx: std::sync::mpsc::Receiver<Cmd>) {
    let mut timers: HashMap<String, Scheduled> = HashMap::new();
    let mut audio: Option<Audio> = None;
    let mut ring: Option<Ring> = None;
    let mut last_sound = Instant::now();
    let mut tock = false;
    // A preview's ticks, as instants.
    let mut preview_ticks: Vec<Instant> = Vec::new();

    loop {
        // Sleep until the next tick, end, preview tick or ring step.
        let now = now_ms();
        let mut wait_ms = 60_000.0f64;
        for t in timers.values() {
            let left = t.ends_at_ms - now;
            if left <= 0.0 {
                wait_ms = 0.0;
                continue;
            }
            wait_ms = wait_ms.min(left);
            if t.tick {
                let tick_start = left - (TICK_SECONDS as f64 * 1000.0);
                if tick_start > 0.0 {
                    wait_ms = wait_ms.min(tick_start);
                } else {
                    // Next whole second before the end.
                    wait_ms = wait_ms.min(left % 1000.0);
                }
            }
        }
        if let Some(p) = preview_ticks.first() {
            wait_ms = wait_ms.min(p.saturating_duration_since(Instant::now()).as_secs_f64() * 1000.0);
        }
        if ring.is_some() {
            wait_ms = wait_ms.min(40.0);
        } else if audio.is_some() {
            wait_ms = wait_ms.min(IDLE_CLOSE.as_secs_f64() * 1000.0);
        }

        match rx.recv_timeout(Duration::from_micros((wait_ms.max(0.0) * 1000.0) as u64)) {
            Ok(cmd) => {
                let mut cmds = vec![cmd];
                cmds.extend(rx.try_iter());
                for cmd in cmds {
                    match cmd {
                        Cmd::Schedule { id, ends_at_ms, tick, ring, duck } => {
                            // Seconds already in the past count as ticked.
                            let left = ((ends_at_ms - now_ms()) / 1000.0).ceil() as i64;
                            timers.insert(id, Scheduled { ends_at_ms, tick, ring, duck, ticked: left + 1 });
                        }
                        Cmd::Cancel { id } => {
                            timers.remove(&id);
                        }
                        Cmd::StopRing => {
                            if let Some(r) = ring.as_mut() {
                                if r.fading.is_none() {
                                    r.fading = Some(Instant::now());
                                }
                            }
                        }
                        Cmd::Preview { what, duck } => {
                            if what == "ring" {
                                ring = start_ring(&mut audio, Duration::from_millis(4800), false);
                                if duck {
                                    duck_others();
                                }
                            } else {
                                let t0 = Instant::now();
                                preview_ticks = (0..5).map(|i| t0 + Duration::from_millis(i * 1000)).collect();
                            }
                            last_sound = Instant::now();
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }

        // Ticks and ends.
        let now = now_ms();
        let mut fired: Vec<(String, bool, bool)> = Vec::new();
        let mut want_tick = false;
        for (id, t) in timers.iter_mut() {
            let left_ms = t.ends_at_ms - now;
            if left_ms <= 5.0 {
                fired.push((id.clone(), t.ring, t.duck));
                continue;
            }
            if t.tick {
                let left_s = (left_ms / 1000.0).ceil() as i64;
                // Within the window and on (or just past) a second boundary.
                if left_s <= TICK_SECONDS && left_s < t.ticked && (left_s as f64 * 1000.0 - left_ms) < 120.0 {
                    t.ticked = left_s;
                    want_tick = true;
                }
            }
        }
        if !preview_ticks.is_empty() && preview_ticks[0] <= Instant::now() {
            preview_ticks.remove(0);
            want_tick = true;
        }
        if want_tick {
            play_tick(&mut audio, tock);
            tock = !tock;
            last_sound = Instant::now();
        }
        for (id, wants_ring, duck) in fired {
            timers.remove(&id);
            let ringing = wants_ring;
            if ringing {
                ring = start_ring(&mut audio, RING_FOR, true);
                last_sound = Instant::now();
                if duck {
                    duck_others();
                }
            }
            let _ = app.emit("timer-fired", Fired { id, ringing });
        }

        // The alarm: swell in, cap, fade out.
        if let Some(r) = ring.as_mut() {
            let age = r.started.elapsed();
            if r.fading.is_none() && age >= r.limit {
                r.fading = Some(Instant::now());
            }
            let base = if r.swell {
                let x = (age.as_secs_f32() / RING_SWELL.as_secs_f32()).min(1.0);
                0.5 + 0.5 * (x * std::f32::consts::FRAC_PI_2).sin()
            } else {
                1.0
            };
            let fade = r.fading.map_or(1.0, |f| 1.0 - (f.elapsed().as_secs_f32() / RING_FADE.as_secs_f32()).min(1.0));
            r.sink.set_volume(0.55 * base * fade * fade);
            if fade <= 0.0 {
                let natural = r.swell;
                ring.take().map(|r| r.sink.stop());
                if natural {
                    let _ = app.emit("timer-ring-ended", ());
                }
                last_sound = Instant::now();
            }
        }

        if ring.is_none() && preview_ticks.is_empty() && audio.is_some() && last_sound.elapsed() > IDLE_CLOSE {
            audio = None;
        }
    }
}

fn open_audio(audio: &mut Option<Audio>) -> Option<&OutputStreamHandle> {
    if audio.is_none() {
        let (stream, handle) = OutputStream::try_default().ok()?;
        *audio = Some(Audio { _stream: stream, handle });
    }
    audio.as_ref().map(|a| &a.handle)
}

fn play_tick(audio: &mut Option<Audio>, tock: bool) {
    let Some(handle) = open_audio(audio) else { return };
    let bytes = if tock { TOCK } else { TICK };
    if let Ok(src) = Decoder::new(Cursor::new(bytes)) {
        let _ = handle.play_raw(src.amplify(0.42).convert_samples());
    }
}

fn start_ring(audio: &mut Option<Audio>, limit: Duration, swell: bool) -> Option<Ring> {
    let handle = open_audio(audio)?;
    let sink = Sink::try_new(handle).ok()?;
    let src = Decoder::new(Cursor::new(RING)).ok()?;
    sink.set_volume(if swell { 0.27 } else { 0.55 });
    sink.append(src.repeat_infinite());
    Some(Ring { sink, started: Instant::now(), limit, fading: None, swell })
}

// ------------------------------------------------------------------ ducking

/// How far other apps dip, as a share of their own volume (about -9 dB):
/// clearly under the alarm, still there.
const DUCK_DEPTH: f32 = 0.35;
const DUCK_DOWN: Duration = Duration::from_millis(450);
const DUCK_HOLD: Duration = Duration::from_millis(2300);
const DUCK_UP: Duration = Duration::from_millis(1400);

/// One dip at a time: a second one would read the already-lowered volumes
/// as the ones to come back to.
static DUCKING: AtomicBool = AtomicBool::new(false);

/// Dips every other app that is playing right now on the default output, then
/// eases each back to exactly the volume it had.
fn duck_others() {
    if DUCKING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let targets = playing_sessions();
        if !targets.is_empty() {
            ramp(&targets, 1.0, DUCK_DEPTH, DUCK_DOWN);
            std::thread::sleep(DUCK_HOLD);
            ramp(&targets, DUCK_DEPTH, 1.0, DUCK_UP);
        }
        DUCKING.store(false, Ordering::SeqCst);
    });
}

/// Active audio sessions of other processes, with their current volume.
fn playing_sessions() -> Vec<(ISimpleAudioVolume, f32)> {
    let me = std::process::id();
    let mut out = Vec::new();
    unsafe {
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
        let Ok(device) = en.GetDefaultAudioEndpoint(eRender, eMultimedia) else { return out };
        let Ok(mgr) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { return out };
        let Ok(list) = mgr.GetSessionEnumerator() else { return out };
        for i in 0..list.GetCount().unwrap_or(0) {
            let Ok(ctl) = list.GetSession(i) else { continue };
            if ctl.GetState().ok() != Some(AudioSessionStateActive) {
                continue;
            }
            let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            // 0 is Windows' own system sounds.
            let pid = ctl2.GetProcessId().unwrap_or(0);
            if pid == 0 || pid == me {
                continue;
            }
            let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() else { continue };
            let Ok(level) = vol.GetMasterVolume() else { continue };
            if level > 0.001 {
                out.push((vol, level));
            }
        }
    }
    out
}

/// Moves every session from `from` to `to` (shares of its own volume) on a
/// smootherstep curve, so neither end of the dip has a corner you can hear.
fn ramp(targets: &[(ISimpleAudioVolume, f32)], from: f32, to: f32, over: Duration) {
    let start = Instant::now();
    loop {
        let x = (start.elapsed().as_secs_f32() / over.as_secs_f32()).min(1.0);
        let e = x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
        let share = from + (to - from) * e;
        for (vol, level) in targets {
            unsafe {
                let _ = vol.SetMasterVolume((level * share).clamp(0.0, 1.0), std::ptr::null());
            }
        }
        if x >= 1.0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(16));
    }
}
