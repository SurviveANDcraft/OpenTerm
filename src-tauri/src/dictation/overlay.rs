//! The two overlay windows: `overlay-pill` (small) and `overlay-glow` (a whole
//! monitor). Both are created hidden when the agent starts, because showing
//! an existing window takes a frame while creating a WebView takes 300 ms+.
//!
//! They must never take focus: the paste lands in whatever is focused. So
//! they're non-activating and click-through, and are only ever shown with
//! `SW_SHOWNOACTIVATE`, never through `show()`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE,
    SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

use super::Msg;

pub const PILL: &str = "overlay-pill";
pub const GLOW: &str = "overlay-glow";

/// Logical size of the pill window. Larger than the capsule itself: room for
/// wider messages, the hint line and the shadow.
const PILL_W: f64 = 440.0;
const PILL_H: f64 = 136.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClickAction {
    None,
    MicSettings,
    OpenSettings,
}

struct Shared {
    channels: HashMap<String, Channel<InvokeResponseBody>>,
    theme: Option<String>,
    /// Which window receives level frames right now.
    levels_to: Option<&'static str>,
    click: ClickAction,
}

fn shared() -> &'static Mutex<Shared> {
    static S: OnceLock<Mutex<Shared>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(Shared { channels: HashMap::new(), theme: None, levels_to: None, click: ClickAction::None })
    })
}

/// Bumped on every show, per window; a late "finished" from an older
/// animation must not hide a newer one.
static SEQ_PILL: AtomicU64 = AtomicU64::new(0);
static SEQ_GLOW: AtomicU64 = AtomicU64::new(0);

fn seq_of(label: &str) -> &'static AtomicU64 {
    if label == GLOW {
        &SEQ_GLOW
    } else {
        &SEQ_PILL
    }
}

fn bump(label: &str) -> u64 {
    seq_of(label).fetch_add(1, Ordering::Relaxed) + 1
}

fn app() -> &'static OnceLock<AppHandle> {
    static A: OnceLock<AppHandle> = OnceLock::new();
    &A
}

fn tx() -> &'static OnceLock<std::sync::mpsc::Sender<Msg>> {
    static T: OnceLock<std::sync::mpsc::Sender<Msg>> = OnceLock::new();
    &T
}

pub fn create(handle: &AppHandle, data_dir: std::path::PathBuf, sender: std::sync::mpsc::Sender<Msg>) -> tauri::Result<()> {
    let _ = app().set(handle.clone());
    let _ = tx().set(sender);
    for (label, w, h) in [(PILL, PILL_W, PILL_H), (GLOW, 1280.0, 720.0)] {
        let win = WebviewWindowBuilder::new(handle, label, WebviewUrl::App("overlay.html".into()))
            .title("OpenTerm Dictation")
            .inner_size(w, h)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .focusable(false)
            // Its own WebView2 profile: the agent never shares a browser
            // process with the main app, so neither can take the other down.
            .data_directory(data_dir.clone())
            // Chromium stops rendering a hidden/occluded window and takes a
            // beat to notice it's visible again; that lag landed on the pill's
            // first frames. The agent's own profile makes these args safe.
            .additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
            )
            .build()?;
        let _ = win.set_ignore_cursor_events(true);
        harden(&win);
    }
    // The pill window is never hidden again: it stays shown, empty and
    // click-through, so a chord paints the pill on the very next frame.
    place_and_show(PILL, pill_placement("bottom-center"));
    Ok(())
}

/// Tool window (no Alt+Tab entry) and non-activating.
fn harden(win: &WebviewWindow) {
    if let Ok(h) = win.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
        }
    }
}

fn window(label: &str) -> Option<WebviewWindow> {
    app().get()?.get_webview_window(label)
}

fn send_json(label: &str, value: &serde_json::Value) {
    let g = shared().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ch) = g.channels.get(label) {
        let _ = ch.send(InvokeResponseBody::Json(value.to_string()));
    }
}

pub fn send_levels(levels: &[u8]) {
    let g = shared().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ch) = g.levels_to.and_then(|l| g.channels.get(l)) {
        let _ = ch.send(InvokeResponseBody::Raw(levels.to_vec()));
    }
}

pub fn set_theme(vars: &HashMap<String, String>) {
    let msg = serde_json::json!({ "t": "theme", "vars": vars });
    let labels: Vec<String> = {
        let mut g = shared().lock().unwrap_or_else(|e| e.into_inner());
        g.theme = Some(msg.to_string());
        g.channels.keys().cloned().collect()
    };
    for l in labels {
        send_json(&l, &msg);
    }
}

struct Placement {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// Work area / full bounds and scale of the monitor holding the foreground
/// window: that's where the user is looking.
fn active_monitor() -> (windows::Win32::Foundation::RECT, windows::Win32::Foundation::RECT, f64) {
    unsafe {
        let mon = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(mon, &mut info);
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        (info.rcWork, info.rcMonitor, dx as f64 / 96.0)
    }
}

fn pill_placement(position: &str) -> Placement {
    let (work, _, scale) = active_monitor();
    let w = (PILL_W * scale).round() as i32;
    let h = (PILL_H * scale).round() as i32;
    let x = if position.ends_with("left") {
        work.left
    } else if position.ends_with("right") {
        work.right - w
    } else {
        work.left + (work.right - work.left - w) / 2
    };
    let y = if position.starts_with("top") { work.top } else { work.bottom - h };
    Placement { x, y, w, h }
}

fn place_and_show(label: &'static str, p: Placement) {
    let Some(win) = window(label) else { return };
    let w2 = win.clone();
    let _ = win.run_on_main_thread(move || {
        let Ok(h) = w2.hwnd() else { return };
        unsafe {
            // Twice: crossing to a monitor with another DPI makes Windows
            // rescale the window during the first move.
            for _ in 0..2 {
                let _ = SetWindowPos(h, Some(HWND_TOPMOST), p.x, p.y, p.w, p.h, SWP_NOACTIVATE);
            }
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(h, Some(HWND_TOPMOST), p.x, p.y, p.w, p.h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    });
}

fn hide(label: &'static str) {
    if label == PILL {
        // Parked, not hidden (see `create`): just empty its content.
        send_json(PILL, &serde_json::json!({ "t": "clear" }));
        return;
    }
    let Some(win) = window(label) else { return };
    let w2 = win.clone();
    let _ = win.run_on_main_thread(move || {
        if let Ok(h) = w2.hwnd() {
            unsafe {
                let _ = ShowWindow(h, SW_HIDE);
            }
        }
    });
}

/// Toggles click-through with `WS_EX_TRANSPARENT` on the raw window. Not via
/// `set_ignore_cursor_events`: that rewrites the whole window style from the
/// window library's own flags, which still say "hidden" (we show with
/// `ShowWindow`), so it hid the pill the moment a notice made it clickable.
/// `WS_EX_LAYERED` and its attributes, set once at creation, stay put.
fn set_clickable(on: bool, action: ClickAction) {
    shared().lock().unwrap_or_else(|e| e.into_inner()).click = if on { action } else { ClickAction::None };
    let Some(win) = window(PILL) else { return };
    let w2 = win.clone();
    let _ = win.run_on_main_thread(move || {
        let Ok(h) = w2.hwnd() else { return };
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let through = WS_EX_TRANSPARENT.0 as isize;
            let ex = if on { ex & !through } else { ex | through };
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
            let _ = SetWindowPos(
                h,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    });
}

fn pill_anchor(position: &str) -> serde_json::Value {
    let v = if position.starts_with("top") { "top" } else { "bottom" };
    let h = position.rsplit('-').next().unwrap_or("center");
    serde_json::json!({ "v": v, "h": h })
}

/// Shows the chosen style and starts the listening state.
pub fn begin(style: &str, position: &str, hint: bool, max_seconds: u32) {
    set_clickable(false, ClickAction::None);
    let glow = style == "glow";
    let label = if glow { GLOW } else { PILL };
    let seq = bump(label);
    shared().lock().unwrap_or_else(|e| e.into_inner()).levels_to = Some(label);
    let msg = serde_json::json!({
        "t": "begin", "seq": seq, "anchor": pill_anchor(position), "hint": hint && !glow, "maxSeconds": max_seconds,
    });
    send_json(label, &msg);
    if glow {
        hide(PILL);
        let (_, mon, _) = active_monitor();
        place_and_show(GLOW, Placement { x: mon.left, y: mon.top, w: mon.right - mon.left, h: mon.bottom - mon.top });
    } else {
        hide(GLOW);
        place_and_show(PILL, pill_placement(position));
    }
}

/// A chord that turned out to be a native shortcut (or a pause): the overlay
/// vanishes on the spot, no exit animation.
pub fn abort() {
    let label = shared().lock().unwrap_or_else(|e| e.into_inner()).levels_to.take();
    match label {
        Some(GLOW) => {
            send_json(GLOW, &serde_json::json!({ "t": "clear" }));
            hide(GLOW);
        }
        Some(_) => hide(PILL),
        None => {}
    }
}

fn active_label() -> Option<&'static str> {
    shared().lock().unwrap_or_else(|e| e.into_inner()).levels_to
}

pub fn thinking(polishing: bool) {
    if let Some(l) = active_label() {
        send_json(l, &serde_json::json!({ "t": "thinking", "polishing": polishing }));
    }
}

/// A line of text on the working pill ("Rate limited · retrying 2/5"). The
/// glow style has no surface to write on, so it stays as it is.
pub fn status(text: &str) {
    if active_label().is_some() {
        send_json(PILL, &serde_json::json!({ "t": "status", "text": text }));
    }
}

/// Back to the plain working pill once the status no longer holds.
pub fn clear_status() {
    status("");
}

pub fn cancel() {
    if let Some(l) = active_label() {
        send_json(l, &serde_json::json!({ "t": "cancel" }));
    }
    shared().lock().unwrap_or_else(|e| e.into_inner()).levels_to = None;
}

/// Success. The glow only brightens and fades on "Pasted"; anything with
/// more to say ("Copied · Ctrl+V to paste") also needs the pill's surface.
pub fn done(style: &str, position: &str, label: &str) {
    let pasted = label == "Pasted";
    let active = active_label();
    shared().lock().unwrap_or_else(|e| e.into_inner()).levels_to = None;
    if style == "glow" && active == Some(GLOW) {
        send_json(GLOW, &serde_json::json!({ "t": "done", "label": label }));
        if pasted {
            return;
        }
        notice(position, label, "done", ClickAction::None);
        return;
    }
    send_json(PILL, &serde_json::json!({ "t": "done", "label": label }));
}

/// A standalone message pill ("Didn't catch that", errors). Errors are clickable.
pub fn notice(position: &str, text: &str, kind: &str, click: ClickAction) {
    let seq = bump(PILL);
    let active = {
        let mut g = shared().lock().unwrap_or_else(|e| e.into_inner());
        g.levels_to.take()
    };
    if active == Some(GLOW) {
        send_json(GLOW, &serde_json::json!({ "t": "fade" }));
    }
    let pill_visible = active == Some(PILL);
    send_json(PILL, &serde_json::json!({
        "t": "notice", "seq": seq, "text": text, "kind": kind, "anchor": pill_anchor(position),
        "clickable": click != ClickAction::None, "morph": pill_visible,
    }));
    if !pill_visible {
        place_and_show(PILL, pill_placement(position));
    }
    set_clickable(click != ClickAction::None, click);
}

/// The Settings "Show on screen" button: a 3 second run through every state.
pub fn preview(style: &str, position: &str) {
    set_clickable(false, ClickAction::None);
    let glow = style == "glow";
    let label = if glow { GLOW } else { PILL };
    let seq = bump(label);
    send_json(label, &serde_json::json!({ "t": "preview", "seq": seq, "anchor": pill_anchor(position) }));
    if glow {
        hide(PILL);
        let (_, mon, _) = active_monitor();
        place_and_show(GLOW, Placement { x: mon.left, y: mon.top, w: mon.right - mon.left, h: mon.bottom - mon.top });
    } else {
        hide(GLOW);
        place_and_show(PILL, pill_placement(position));
    }
}

#[tauri::command]
pub fn overlay_attach(window: WebviewWindow, channel: Channel<InvokeResponseBody>) {
    let mut g = shared().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(theme) = &g.theme {
        let _ = channel.send(InvokeResponseBody::Json(theme.clone()));
    }
    g.channels.insert(window.label().to_string(), channel);
}

/// The overlay finished its exit animation; hide it unless something newer
/// is already showing.
#[tauri::command]
pub fn overlay_finished(window: WebviewWindow, seq: u64) {
    if seq != seq_of(window.label()).load(Ordering::Relaxed) {
        return;
    }
    if window.label() == PILL {
        set_clickable(false, ClickAction::None);
        hide(PILL);
    } else {
        hide(GLOW);
    }
}

#[tauri::command]
pub fn overlay_click() {
    let action = shared().lock().unwrap_or_else(|e| e.into_inner()).click;
    set_clickable(false, ClickAction::None);
    hide(PILL);
    if let Some(tx) = tx().get() {
        let _ = tx.send(Msg::OverlayClick(action));
    }
}
