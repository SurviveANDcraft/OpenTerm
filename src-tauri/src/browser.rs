// ===================================================================
//  Embedded browser panes
// ===================================================================
//
// A browser pane hosts a real Chromium webview created as a *child* of the
// main window (`Window::add_child`, gated behind tauri's "unstable" feature).
// The frontend positions it over an empty host box exactly like a docked
// external window; this module creates/destroys/positions those webviews.
//
// Console + network capture works without granting any IPC to remote pages:
// every browser webview gets an initialization script that hooks console.*,
// fetch/XHR and error events, batches entries, and ships them via
// `navigator.sendBeacon` to the custom `tdlog` scheme (registered on the
// builder below, so WebView2 routes the request to us instead of the
// network). The handler just forwards the raw JSON to the main webview as an
// event — no capabilities, no remote-origin IPC.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use serde::Serialize;
use windows::Win32::Foundation::HWND;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Size, Url,
    WebviewBuilder, WebviewUrl,
};

fn browser_registry() -> &'static Mutex<HashSet<String>> {
    static R: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn label_for(id: &str) -> String {
    format!("browser-{id}")
}

#[derive(Clone, Serialize)]
struct BrowserEvent {
    id: String,
    kind: String, // "log" | "nav" | "title"
    data: String,
}

fn emit_browser<R: tauri::Runtime>(app: &AppHandle<R>, id: &str, kind: &str, data: String) {
    let _ = app.emit(
        "browser-event",
        BrowserEvent {
            id: id.to_string(),
            kind: kind.to_string(),
            data,
        },
    );
}

/// The monitoring script injected into every page loaded by a browser pane.
/// Kept dependency-free (no Tauri APIs): it only talks to the tdlog beacon.
/// The sending webview's label tells us which pane a beacon came from, so no
/// per-pane id needs to be baked in here. Not a format! string — the JS is
/// brace-heavy and static.
const MONITOR_SCRIPT: &str = r#"(function(){
  if (window.__tdMon) return; window.__tdMon = true;
  var buf = [];
  function flush(){
    if (!buf.length) return;
    var payload = JSON.stringify(buf);
    buf = [];
    try { navigator.sendBeacon("https://tdlog.localhost/log", payload); } catch (e) {}
  }
  setInterval(flush, 600);
  addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "hidden") flush(); });
  function now(){
    try { return new Date().toTimeString().slice(0, 8); } catch (e) { return ""; }
  }
  function push(e){ if (buf.length < 200) buf.push(e); }
  function fmt(a){
    var out = [];
    for (var i = 0; i < a.length; i++) {
      var v = a[i];
      try { out.push(typeof v === "string" ? v : JSON.stringify(v)); } catch (e) { out.push(String(v)); }
    }
    return out.join(" ");
  }
  ["log","info","warn","error","debug"].forEach(function(level){
    var orig = console[level] ? console[level].bind(console) : function(){};
    console[level] = function(){
      push({ t: now(), k: "c", level: level, text: fmt(arguments) });
      orig.apply(null, arguments);
    };
  });
  window.addEventListener("error", function(e){
    push({ t: now(), k: "e", text: (e.message || "Error") + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "") });
  }, true);
  window.addEventListener("unhandledrejection", function(e){
    var r = e.reason;
    var text = (r && r.stack) ? String(r.stack).split("\n")[0] : String(r);
    push({ t: now(), k: "e", text: "Unhandled rejection: " + text });
  });
  var of = window.fetch;
  if (of) {
    window.fetch = function(input, init){
      var method = (init && init.method) || (input && input.method) || "GET";
      var url = (typeof input === "string") ? input : ((input && input.url) || String(input));
      var started = Date.now();
      return of.apply(this, arguments).then(function(res){
        push({ t: now(), k: "n", method: method, url: url, status: res.status, dur: Date.now() - started });
        return res;
      }, function(err){
        push({ t: now(), k: "n", method: method, url: url, status: 0, dur: Date.now() - started });
        throw err;
      });
    };
  }
  // Content is a separate child webview from the app's own DOM, so a click
  // in the page never reaches our window's click/mousedown handlers — the
  // pane just never gets selected. Beacon a lightweight "focus" marker on the
  // capture phase so the host app can select the pane on the very same click.
  addEventListener("pointerdown", function(){
    try { navigator.sendBeacon("https://tdlog.localhost/focus", "1"); } catch (e) {}
  }, true);
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__m = m; this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    var xhr = this;
    var started = Date.now();
    xhr.addEventListener("loadend", function(){
      push({ t: now(), k: "n", method: xhr.__m || "GET", url: String(xhr.__u || ""), status: xhr.status || 0, dur: Date.now() - started });
    });
    return os.apply(this, arguments);
  };
})()"#;

/// Handles `https://tdlog.localhost/log` beacons sent by browser panes'
/// monitoring scripts. Forwards the raw JSON entry array to the main webview
/// and answers with an empty 200 (CORS-open for good measure). The sending
/// webview's label (`browser-<paneId>`) identifies the pane.
pub fn handle_tdlog<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    use std::borrow::Cow;

    if request.method() == tauri::http::Method::POST {
        let path = request.uri().path().to_string();
        let label = ctx.webview_label();
        if let Some(id) = label.strip_prefix("browser-") {
            if path.starts_with("/log") {
                // sendBeacon bodies arrive as plain bytes; forward untouched so
                // the frontend owns parsing (keeps this path allocation-light).
                let body = String::from_utf8_lossy(request.body()).to_string();
                if !body.is_empty() {
                    emit_browser(ctx.app_handle(), id, "log", body);
                }
            } else if path.starts_with("/focus") {
                emit_browser(ctx.app_handle(), id, "focus", String::new());
            }
        }
    }
    tauri::http::Response::builder()
        .status(200)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-headers", "*")
        .body(Cow::Borrowed(&b""[..]))
        .unwrap()
}

/// Creates a child webview hosting `url` inside the main window. Idempotent:
/// re-requesting an existing browser pane keeps the current one.
///
/// `async` on purpose — the Tauri docs call out that creating webviews from
/// synchronous commands deadlocks on Windows (WebView2 controller creation
/// pumps the main thread; see wry#583).
#[tauri::command]
pub async fn create_browser_pane(
    app: AppHandle,
    id: String,
    url: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    user_agent: Option<String>,
    device_script: Option<String>,
    zoom: Option<f64>,
    force: Option<bool>,
) -> Result<(), String> {
    let label = label_for(&id);
    if app.get_webview(&label).is_some() {
        if !force.unwrap_or(false) {
            return Ok(());
        }
        // Device switch: the UA and the shim script can only be set at creation
        // time, so the webview is torn down and rebuilt. Wait for the label to
        // free up before reusing it.
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.close();
        }
        for _ in 0..100 {
            if app.get_webview(&label).is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
    }
    let parsed: Url = Url::parse(&url).map_err(|e| format!("invalid URL '{url}': {e}"))?;

    let app_for_nav = app.clone();
    let app_for_title = app.clone();
    let id_nav = id.clone();
    let id_title = id.clone();

    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        // HTTPS custom-scheme origin (https://tdlog.localhost) so the monitor's
        // beacons aren't blocked as mixed content on HTTPS pages.
        .use_https_scheme(true)
        .initialization_script(MONITOR_SCRIPT)
        .on_page_load(move |_wv, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                emit_browser(&app_for_nav, &id_nav, "nav", payload.url().to_string());
            }
        })
        .on_document_title_changed(move |_, title| {
            emit_browser(&app_for_title, &id_title, "title", title);
        });

    // Device emulation: a spoofed UA plus a shim that makes devicePixelRatio /
    // touch-point detection agree with it. Both are creation-time only.
    if let Some(ua) = user_agent.as_deref().filter(|s| !s.is_empty()) {
        builder = builder.user_agent(ua);
    }
    if let Some(script) = device_script.as_deref().filter(|s| !s.is_empty()) {
        builder = builder.initialization_script(script);
    }

    let Some(window) = app.get_window("main") else {
        return Err("main window not found".into());
    };

    // Born directly at the pane's host rect (physical px, client-relative) so
    // the first paint is already in place.
    let size = PhysicalSize::new(w.clamp(1, 100000) as u32, h.clamp(1, 100000) as u32);
    let wv = window
        .add_child(builder, PhysicalPosition::new(x, y), size)
        .map_err(|e| e.to_string())?;
    // Emulated devices render at their real CSS width inside a smaller pane —
    // the zoom factor is what shrinks the frame without changing the viewport.
    if let Some(z) = zoom {
        let _ = wv.set_zoom(z.clamp(0.25, 5.0));
    }
    browser_registry().lock().unwrap().insert(id);
    Ok(())
}

/// Gives a browser pane's embedded webview real OS keyboard focus.
///
/// Selecting a pane in the UI (clicking its toolbar, or switching to it via a
/// keybind) only updates our own DOM/state — the pane's content is a
/// *separate* child webview, and nothing else hands keyboard focus to it. So
/// the pane could show as selected while every keystroke, including
/// keybinds, still went to whatever window last had OS focus. `set_focus`
/// asks WebView2 directly to take it.
#[tauri::command]
pub fn focus_browser_pane(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label_for(&id)) {
        let _ = wv.set_focus();
    }
    Ok(())
}

/// Glue the child webview to its pane's host rect (physical px, client-relative)
/// or hide it when the pane isn't on screen.
#[tauri::command]
pub fn position_browser_pane(
    app: AppHandle,
    id: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    visible: bool,
    zoom: Option<f64>,
) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };

    let Some(wv) = app.get_webview(&label_for(&id)) else {
        return Ok(());
    };
    if visible && w > 4 && h > 4 {
        if let Some(z) = zoom {
            let _ = wv.set_zoom(z.clamp(0.25, 5.0));
        }
        let _ = wv.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(x, y)),
            size: Size::Physical(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32)),
        });
        let _ = wv.show();
        // The main webview is a sibling HWND that can end up re-raised above us;
        // pin the browser container back on top so its content is actually seen.
        let raw = crate::APP_HWND.load(std::sync::atomic::Ordering::Relaxed);
        if raw != 0 {
            if let Some(container) =
                find_webview_hwnd(crate::hwnd(raw), x, y, w, h)
            {
                unsafe {
                    let _ = SetWindowPos(
                        container,
                        Some(HWND_TOP),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                }
            }
        }
    } else {
        let _ = wv.hide();
    }
    Ok(())
}

/// Navigate the browser pane to `url` (already normalized client-side).
#[tauri::command]
pub fn navigate_browser_pane(id: String, url: String) -> Result<(), String> {
    let app = crate::app_handle()
        .get()
        .ok_or_else(|| "app not ready".to_string())?;
    let Some(wv) = app.get_webview(&label_for(&id)) else {
        return Err("browser pane not found".into());
    };
    let parsed: Url = Url::parse(&url).map_err(|e| format!("invalid URL '{url}': {e}"))?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

/// History / reload controls, driven through eval since Tauri exposes no
/// navigation-history API on a bare child Webview.
#[tauri::command]
pub fn browser_history(id: String, action: String) -> Result<(), String> {
    let app = crate::app_handle()
        .get()
        .ok_or_else(|| "app not ready".to_string())?;
    let Some(wv) = app.get_webview(&label_for(&id)) else {
        return Err("browser pane not found".into());
    };
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        _ => "location.reload()",
    };
    wv.eval(js).map_err(|e| e.to_string())
}

/// Tear down the child webview for a closed browser pane.
#[tauri::command]
pub fn destroy_browser_pane(id: String) -> Result<(), String> {
    if let Some(app) = crate::app_handle().get() {
        if let Some(wv) = app.get_webview(&label_for(&id)) {
            let _ = wv.close();
        }
    }
    browser_registry().lock().unwrap().remove(&id);
    Ok(())
}

#[derive(Clone, Serialize)]
pub struct CaptureResult {
    path: String,
    pub base64_png: String,
}

/// Finds the WebView2 child HWND whose window rect matches the given
/// client-area rect (±3px). PrintWindow+PW_RENDERFULLCONTENT captures the
/// DirectComposition content reliably on the webview's own HWND, so capturing
/// it directly beats cropping a whole-window grab.
fn find_webview_hwnd(
    parent: HWND,
    screen_x: i32,
    screen_y: i32,
    w: i32,
    h: i32,
) -> Option<HWND> {
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::core::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GWL_STYLE, GetClassNameW, GetWindowLongPtrW, GetWindowRect,
        IsWindowVisible, WS_VISIBLE,
    };

    struct Match {
        best: isize,
        x: i32,
        y: i32,
        r: i32,
        b: i32,
    }

    unsafe extern "system" fn cb(child: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut Match);
        if unsafe { !IsWindowVisible(child).as_bool() } {
            return BOOL(1);
        }
        let style = unsafe { GetWindowLongPtrW(child, GWL_STYLE) } as u32;
        if style & WS_VISIBLE.0 == 0 {
            return BOOL(1);
        }
        // wry hosts every webview in a "WRY_WEBVIEW" child class — match that
        // so we don't grab WebView2's inner Chrome_* descendants.
        let mut cls = [0u16; 32];
        let n = unsafe { GetClassNameW(child, &mut cls) };
        let cls = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        if cls != "WRY_WEBVIEW" {
            return BOOL(1);
        }
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(child, &mut rect) }.is_err() {
            return BOOL(1);
        }
        // The WebView2 root child fills exactly the bounds we positioned it at
        // (±3px tolerance for rounding).
        let near = |a: i32, b: i32| (a - b).abs() <= 3;
        if near(rect.left, state.x)
            && near(rect.top, state.y)
            && near(rect.right, state.r)
            && near(rect.bottom, state.b)
        {
            state.best = child.0 as isize;
            return BOOL(0); // stop at the first (outermost) match
        }
        BOOL(1)
    }

    let mut state = Match {
        best: 0,
        x: screen_x,
        y: screen_y,
        r: screen_x + w,
        b: screen_y + h,
    };
    unsafe {
        let _ = EnumChildWindows(Some(parent), Some(cb), LPARAM(&mut state as *mut Match as isize));
    }
    (state.best != 0).then_some(HWND(state.best as *mut std::ffi::c_void))
}

/// Captures what a browser pane currently shows. Prefers grabbing the WebView2
/// child HWND directly (PrintWindow + PW_RENDERFULLCONTENT renders
/// DirectComposition content correctly there), falling back to a whole-window
/// grab cropped to the pane's client-area rect. Encodes PNG, saves to a temp
/// file and returns both path and base64. Used by Alt+Shift+drag to hand a
/// screenshot of the page to an AI agent terminal.
#[tauri::command]
pub fn capture_browser_pane(x: i32, y: i32, w: i32, h: i32) -> Result<CaptureResult, String> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
        HDC, HBITMAP,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, PW_RENDERFULLCONTENT};

    let raw = crate::APP_HWND.load(std::sync::atomic::Ordering::Relaxed);
    if raw == 0 {
        return Err("no window".into());
    }
    let hwnd = crate::hwnd(raw);

    // Where the pane's content box sits in SCREEN coords.
    let mut origin = POINT { x: 0, y: 0 };
    unsafe {
        let _ = ClientToScreen(hwnd, &mut origin);
    }

    // Preferred: capture the WebView2 child directly.
    let target = find_webview_hwnd(hwnd, origin.x + x, origin.y + y, w, h);
    let (capture_hwnd, cap_w, cap_h, crop_x, crop_y) = match target {
        Some(t) => {
            let mut r = RECT::default();
            if unsafe { GetWindowRect(t, &mut r) }.is_ok() {
                let rw = (r.right - r.left).max(1);
                let rh = (r.bottom - r.top).max(1);
                (t, rw, rh, (origin.x + x - r.left).clamp(0, rw - 1), (origin.y + y - r.top).clamp(0, rh - 1))
            } else {
                (hwnd, 0, 0, 0, 0)
            }
        }
        None => (hwnd, 0, 0, 0, 0),
    };

    let fallback = cap_w == 0;
    let (full_w, full_h, off_x, off_y, crop_w, crop_h) = if fallback {
        unsafe {
            let mut win = RECT::default();
            GetWindowRect(hwnd, &mut win).map_err(|e| e.to_string())?;
            let fw = (win.right - win.left).max(1);
            let fh = (win.bottom - win.top).max(1);
            let fx = origin.x - win.left;
            let fy = origin.y - win.top;
            (
                fw,
                fh,
                fx,
                fy,
                w.clamp(1, fw - x - fx).max(1),
                h.clamp(1, fh - y - fy).max(1),
            )
        }
    } else {
        (
            cap_w,
            cap_h,
            0,
            0,
            w.clamp(1, cap_w).max(1),
            h.clamp(1, cap_h).max(1),
        )
    };
    let bx = if fallback { (x + off_x).clamp(0, full_w - crop_w) as usize } else { crop_x as usize };
    let by = if fallback { (y + off_y).clamp(0, full_h - crop_h) as usize } else { crop_y as usize };

    unsafe {
        let hdc_window = GetDC(Some(capture_hwnd));
        if hdc_window.is_invalid() {
            return Err("GetDC failed".into());
        }
        let mem: HDC = CreateCompatibleDC(Some(hdc_window));
        let bmp: HBITMAP = CreateCompatibleBitmap(hdc_window, full_w, full_h);
        let old = SelectObject(mem, bmp.into());

        let printed = PrintWindow(capture_hwnd, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT));
        let mut out: Vec<u8> = Vec::new();
        if printed.as_bool() {
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = full_w;
            // Negative height → top-down rows.
            bmi.bmiHeader.biHeight = -full_h;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0; // BI_RGB

            let stride = (full_w * 4) as usize;
            let mut buf = vec![0u8; stride * full_h as usize];
            let copied = GetDIBits(
                mem,
                bmp,
                0,
                full_h as u32,
                Some(buf.as_mut_ptr().cast()),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            if copied == full_h {
                // Crop + BGRA→RGBA.
                let mut rgba = Vec::with_capacity((crop_w * crop_h * 4) as usize);
                for row in 0..crop_h as usize {
                    let line = &buf[(by + row) * stride + bx * 4..][..crop_w as usize * 4];
                    for px in line.chunks_exact(4) {
                        rgba.push(px[2]);
                        rgba.push(px[1]);
                        rgba.push(px[0]);
                        rgba.push(px[3]);
                    }
                }
                out = rgba;
            }
        }

        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        let _ = ReleaseDC(Some(capture_hwnd), hdc_window);

        if out.is_empty() {
            return Err("capture failed".into());
        }

        let img =
            image::RgbaImage::from_raw(crop_w as u32, crop_h as u32, out).ok_or("bad image buffer")?;
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;

        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "openterm-browser-{}.png",
            chrono_millis()
        ));
        std::fs::write(&path, &png).map_err(|e| e.to_string())?;

        Ok(CaptureResult {
            path: path.to_string_lossy().to_string(),
            base64_png: base64::engine::general_purpose::STANDARD.encode(&png),
        })
    }
}

fn chrono_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Closes every live browser webview — used at shutdown.
pub fn destroy_all() {
    if let Some(app) = crate::app_handle().get() {
        let ids: Vec<String> = browser_registry().lock().unwrap().iter().cloned().collect();
        for id in ids {
            if let Some(wv) = app.get_webview(&label_for(&id)) {
                let _ = wv.close();
            }
        }
    }
    browser_registry().lock().unwrap().clear();
}
