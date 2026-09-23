//! Delivery: where the text is going (terminal? elevated?), the clipboard
//! write, and the synthetic paste keystroke.

use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HWND};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindow,
    SetForegroundWindow, ShowWindow, SwitchToThisWindow, SW_RESTORE,
};

use super::hotkey;

pub struct Target {
    /// Friendly app name for History ("Windows Terminal").
    pub app: Option<String>,
    pub terminal: bool,
    /// Agent CLI that owns the paste in this window, if we can tell.
    pub agent: Option<&'static str>,
    /// False for elevated windows (Windows drops our input) and for no window.
    pub pasteable: bool,
}

/// Desktop and taskbar: there's no text field to paste into.
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

/// Where a recording was aimed when the key went down. Captured up front so a
/// transcript that takes a second to come back can still be checked against
/// the window (and OpenTerm pane) the user was actually talking to.
#[derive(Clone, Debug)]
pub struct Origin {
    /// Raw HWND; kept as an integer so the value can cross threads.
    pub hwnd: isize,
    pub openterm: bool,
    /// Agent CLI of the focused pane at key-down, for OpenTerm windows.
    pub agent: Option<&'static str>,
    /// OpenTerm's focused pane id at key-down, or None elsewhere.
    pub pane: Option<String>,
}

fn hwnd_of(raw: isize) -> HWND {
    HWND(raw as *mut core::ffi::c_void)
}

pub fn foreground_hwnd() -> isize {
    unsafe { GetForegroundWindow() }.0 as isize
}

/// Snapshots the focused window at key-down. Deliberately cheap: no process
/// tree walk, since this runs on the hotkey path.
pub fn capture_origin(agent: Option<&'static str>, pane: Option<String>) -> Origin {
    let h = unsafe { GetForegroundWindow() };
    let openterm = crate::process_image_name(h).as_deref() == Some("openterm.exe");
    Origin { hwnd: h.0 as isize, openterm, agent: openterm.then_some(agent).flatten(), pane }
}

pub fn inspect_foreground(focused_agent: Option<&'static str>) -> Target {
    inspect(unsafe { GetForegroundWindow() }, focused_agent)
}

/// Same inspection against a window captured earlier. A window that has since
/// closed comes back as "nothing to paste into".
pub fn inspect_origin(origin: &Origin) -> Target {
    let h = hwnd_of(origin.hwnd);
    if !unsafe { IsWindow(Some(h)) }.as_bool() {
        return Target { app: None, terminal: false, agent: None, pasteable: false };
    }
    inspect(h, origin.agent)
}

fn inspect(h: HWND, focused_agent: Option<&'static str>) -> Target {
    if h.0.is_null() {
        return Target { app: None, terminal: false, agent: None, pasteable: false };
    }
    let class = crate::window_class(h);
    let exe = crate::process_image_name(h);
    let terminal = crate::TERMINAL_CLASSES.iter().any(|c| class.eq_ignore_ascii_case(c))
        || exe.as_deref().is_some_and(|e| e == "openterm.exe" || crate::TERMINAL_EXES.contains(&e));
    let agent = if !terminal {
        None
    } else if exe.as_deref() == Some("openterm.exe") {
        // OpenTerm publishes its focused pane's agent (see `dictation_set_focused_agent`).
        focused_agent
    } else {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        crate::usage::sole_harness_under(pid)
    };
    let shell = SHELL_CLASSES.iter().any(|c| class.eq_ignore_ascii_case(c));
    Target {
        app: exe.as_deref().map(friendly_name),
        terminal,
        agent,
        pasteable: !shell && (!is_elevated_window(h) || self_elevated()),
    }
}

fn friendly_name(exe: &str) -> String {
    let known = [
        ("windowsterminal.exe", "Windows Terminal"),
        ("openterm.exe", "OpenTerm"),
        ("code.exe", "VS Code"),
        ("chrome.exe", "Chrome"),
        ("msedge.exe", "Edge"),
        ("firefox.exe", "Firefox"),
        ("notepad.exe", "Notepad"),
        ("explorer.exe", "File Explorer"),
        ("slack.exe", "Slack"),
        ("discord.exe", "Discord"),
        ("winword.exe", "Word"),
        ("outlook.exe", "Outlook"),
        ("olk.exe", "Outlook"),
        ("cursor.exe", "Cursor"),
    ];
    if let Some((_, name)) = known.iter().find(|(e, _)| *e == exe) {
        return name.to_string();
    }
    let stem = exe.strip_suffix(".exe").unwrap_or(exe);
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => stem.to_string(),
    }
}

fn token_elevated(process: HANDLE) -> Option<bool> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut info = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut info as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok.then_some(info.TokenIsElevated != 0)
    }
}

fn self_elevated() -> bool {
    token_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false)
}

/// A token we aren't allowed to open belongs to a higher-integrity process,
/// which is exactly the case where our input would be dropped.
fn is_elevated_window(h: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    if pid == 0 {
        return false;
    }
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return true;
        };
        let elevated = token_elevated(process).unwrap_or(true);
        let _ = CloseHandle(process);
        elevated
    }
}

/// Brings a window captured at key-down back to the front so the transcript
/// lands where it was dictated. Windows only lets the foreground process
/// change the foreground window, so this borrows the current foreground
/// thread's input state (the standard AttachThreadInput dance) and falls back
/// to `SwitchToThisWindow`, which the shell itself uses for Alt+Tab.
pub fn focus_window(raw: isize) -> bool {
    let h = hwnd_of(raw);
    unsafe {
        if !IsWindow(Some(h)).as_bool() {
            return false;
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        if SetForegroundWindow(h).as_bool() && settles_on(h) {
            return true;
        }
        let fg = GetForegroundWindow();
        let their_thread = if !fg.0.is_null() { GetWindowThreadProcessId(fg, None) } else { 0 };
        let our_thread = GetCurrentThreadId();
        let attached =
            their_thread != 0 && their_thread != our_thread && AttachThreadInput(their_thread, our_thread, true).as_bool();
        let _ = BringWindowToTop(h);
        let _ = SetForegroundWindow(h);
        let _ = SetActiveWindow(h);
        if attached {
            let _ = AttachThreadInput(their_thread, our_thread, false);
        }
        if settles_on(h) {
            return true;
        }
        SwitchToThisWindow(h, true);
        settles_on(h)
    }
}

/// Foreground changes are asynchronous: give the window a moment to actually
/// become foreground before believing the call failed.
fn settles_on(h: HWND) -> bool {
    for _ in 0..40 {
        if unsafe { GetForegroundWindow() }.0 == h.0 {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    false
}

pub fn is_foreground(raw: isize) -> bool {
    foreground_hwnd() == raw
}

/// Final text for the target. Terminals get every line break flattened to a
/// space: a newline pasted into a shell runs whatever came before it. Control
/// characters are dropped everywhere, and a trailing space keeps back-to-back
/// dictations apart.
pub fn prepare_text(raw: &str, terminal: bool) -> String {
    let trimmed = raw.trim();
    let mut out = String::with_capacity(trimmed.len() + 2);
    let mut chars = trimmed.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' || c == '\n' {
            let mut breaks = usize::from(c == '\n');
            while let Some(&n) = chars.peek().filter(|n| n.is_whitespace()) {
                breaks += usize::from(n == '\n');
                chars.next();
            }
            while out.ends_with(' ') || out.ends_with('\t') {
                out.pop();
            }
            if terminal {
                out.push(' ');
            } else {
                // A blank line between paragraphs survives; any other run is one break.
                out.push_str(if breaks >= 2 { "\r\n\r\n" } else { "\r\n" });
            }
        } else if c.is_control() && c != '\t' {
            continue;
        } else if terminal && c == '\t' {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out.push(' ');
    out
}

pub fn set_clipboard(text: &str) -> Result<(), String> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    // Another app may hold the clipboard for a moment; retry briefly.
    let mut opened = false;
    for _ in 0..20 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            opened = true;
            break;
        }
        thread::sleep(Duration::from_millis(15));
    }
    if !opened {
        return Err("clipboard busy".into());
    }
    let result = unsafe {
        (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let bytes = wide.len() * std::mem::size_of::<u16>();
            let mem = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| e.to_string())?;
            let ptr = GlobalLock(mem) as *mut u16;
            if ptr.is_null() {
                let _ = GlobalFree(Some(mem));
                return Err("clipboard lock failed".into());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            let _ = GlobalUnlock(mem);
            // On success the clipboard owns the memory.
            if let Err(e) = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(mem.0))) {
                let _ = GlobalFree(Some(mem));
                return Err(e.to_string());
            }
            Ok(())
        })()
    };
    unsafe {
        let _ = CloseClipboard();
    }
    result
}

/// Waits for the chord keys to be physically released, so an injected Ctrl+V
/// can't combine with a still-held Win or Alt.
pub fn wait_keys_up(timeout: Duration) -> bool {
    let start = Instant::now();
    while !hotkey::chord_keys_up() {
        if start.elapsed() > timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
    true
}

/// The agent CLIs that read a paste off Ctrl+Shift+V. Claude Code, Codex and
/// opencode all accept it; everything else gets the standard Ctrl+V, which is
/// also the right fallback for a terminal we can't identify.
const CHORD_AGENTS: &[&str] = &["claude-code", "codex", "opencode"];

pub fn paste(agent: Option<&str>) {
    if agent.is_some_and(|a| CHORD_AGENTS.contains(&a)) {
        hotkey::send_paste_chord(&[hotkey::VK_CONTROL, hotkey::VK_SHIFT], hotkey::VK_V);
    } else {
        hotkey::send_paste_chord(&[hotkey::VK_CONTROL], hotkey::VK_V);
    }
}

/// Maps the agent name OpenTerm writes to a known harness id.
pub fn parse_agent(s: &str) -> Option<&'static str> {
    match s.trim() {
        "claude-code" => Some("claude-code"),
        "codex" => Some("codex"),
        "opencode" => Some("opencode"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::prepare_text;

    #[test]
    fn terminals_never_get_newlines() {
        assert_eq!(prepare_text("git status\nrm -rf x\r\n  done", true), "git status rm -rf x done ");
        assert_eq!(prepare_text("a \n\n b\tc", true), "a b c ");
        assert!(!prepare_text("x\r\ny\rz\u{2028}", true).contains(['\r', '\n']));
    }

    #[test]
    fn other_apps_keep_paragraphs_as_crlf() {
        assert_eq!(prepare_text("  Hello.\n\nWorld\u{7}  ", false), "Hello.\r\n\r\nWorld ");
        assert_eq!(prepare_text("a \r\nb", false), "a\r\nb ");
        assert_eq!(prepare_text("one\rtwo", false), "one\r\ntwo ");
    }
}
