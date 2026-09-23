//! The global push-to-talk shortcut: a `WH_KEYBOARD_LL` hook on its own thread.
//!
//! The callback runs for every key typed anywhere on the system, so it only
//! touches thread-local state and atomics and posts to a channel. Windows
//! silently removes hooks that stall (~300 ms), and a slow hook makes typing
//! lag everywhere.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::mpsc::Sender;
use std::sync::OnceLock;
use std::thread;
use std::time::Instant;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, KBDLLHOOKSTRUCT,
    LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

use super::Msg;

pub const M_CTRL: u8 = 1;
pub const M_ALT: u8 = 2;
pub const M_SHIFT: u8 = 4;
pub const M_WIN: u8 = 8;
/// Bit in `PHYS_DOWN` for the chord's non-modifier key.
const KEY_BIT: u8 = 16;

const VK_ESCAPE: u32 = 0x1B;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
/// Unassigned virtual key. Tapping it while Win is held means Windows no longer
/// sees a lone Win press, so the Start menu stays shut (AutoHotkey's
/// "menu mask key" trick).
const VK_MASK: u16 = 0xE8;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Chord {
    pub mods: u8,
    /// 0 for a modifier-only chord like Ctrl+Win.
    pub key: u32,
}

impl Chord {
    fn pack(self) -> u32 {
        (self.mods as u32) << 16 | self.key & 0xFFFF
    }
    fn unpack(v: u32) -> Chord {
        Chord { mods: (v >> 16) as u8, key: v & 0xFFFF }
    }
    /// Modifier-only chords wait briefly before committing, so native combos
    /// that start with the same keys (Ctrl+Win+D) still reach Windows.
    pub fn modifier_only(self) -> bool {
        self.key == 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    ChordDown,
    ChordUp,
    /// Another key went down while the chord was held.
    OtherKey,
    Escape,
}

/// Parses the settings string ("Ctrl+Win", "Ctrl+Shift+Space", "F13").
/// Modifier-only chords need two modifiers; a lone key must be one nobody
/// types by accident (F-keys, Pause and friends).
pub fn parse_chord(s: &str) -> Option<Chord> {
    let mut mods = 0u8;
    let mut key = 0u32;
    for part in s.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        let bit = match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => M_CTRL,
            "alt" => M_ALT,
            "shift" => M_SHIFT,
            "win" | "meta" | "super" => M_WIN,
            _ => 0,
        };
        if bit != 0 {
            mods |= bit;
            continue;
        }
        if key != 0 {
            return None;
        }
        key = key_code(part)?;
    }
    if key == 0 {
        return (mods.count_ones() >= 2).then_some(Chord { mods, key });
    }
    if mods == 0 && !lone_key_ok(key) {
        return None;
    }
    Some(Chord { mods, key })
}

fn key_code(name: &str) -> Option<u32> {
    let upper = name.to_ascii_uppercase();
    let b = upper.as_bytes();
    if b.len() == 1 && (b[0].is_ascii_uppercase() || b[0].is_ascii_digit()) {
        return Some(b[0] as u32);
    }
    if let Some(n) = upper.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then_some(0x70 + n - 1);
    }
    Some(match upper.as_str() {
        "SPACE" => 0x20,
        "PAUSE" => 0x13,
        "SCROLLLOCK" => 0x91,
        "INSERT" => 0x2D,
        "DELETE" => 0x2E,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        "ARROWLEFT" => 0x25,
        "ARROWUP" => 0x26,
        "ARROWRIGHT" => 0x27,
        "ARROWDOWN" => 0x28,
        "ENTER" => 0x0D,
        "TAB" => 0x09,
        "BACKSPACE" => 0x08,
        "`" => 0xC0,
        "," => 0xBC,
        "." => 0xBE,
        "/" => 0xBF,
        ";" => 0xBA,
        "'" => 0xDE,
        "[" => 0xDB,
        "]" => 0xDD,
        "\\" => 0xDC,
        "-" => 0xBD,
        "=" => 0xBB,
        _ => return None,
    })
}

fn lone_key_ok(vk: u32) -> bool {
    (0x70..=0x87).contains(&vk) || matches!(vk, 0x13 | 0x91 | 0x2D)
}

fn mod_bit(vk: u32) -> u8 {
    match vk {
        0x11 | 0xA2 | 0xA3 => M_CTRL,
        0x12 | 0xA4 | 0xA5 => M_ALT,
        0x10 | 0xA0 | 0xA1 => M_SHIFT,
        VK_LWIN | VK_RWIN => M_WIN,
        _ => 0,
    }
}

static TX: OnceLock<Sender<Msg>> = OnceLock::new();
static CHORD: AtomicU32 = AtomicU32::new(0);
static ENABLED: AtomicBool = AtomicBool::new(false);
/// Arming or recording: Esc belongs to us, and a second press in toggle mode stops.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Chord keys physically held right now (modifier bits + `KEY_BIT`).
static PHYS_DOWN: AtomicU8 = AtomicU8::new(0);

pub fn set_chord(chord: Option<Chord>) {
    CHORD.store(chord.map_or(0, Chord::pack), Ordering::Relaxed);
    if chord.is_none() {
        ENABLED.store(false, Ordering::Relaxed);
    }
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on && CHORD.load(Ordering::Relaxed) != 0, Ordering::Relaxed);
}

pub fn set_active(on: bool) {
    ACTIVE.store(on, Ordering::Relaxed);
}

/// True once none of the chord's keys are held, so an injected Ctrl+V can't
/// fold into a still-held Win (Win+V opens clipboard history).
pub fn chord_keys_up() -> bool {
    PHYS_DOWN.load(Ordering::Relaxed) == 0
}

#[derive(Default)]
struct HookState {
    /// Modifiers physically down.
    down: u8,
    key_down: bool,
    /// Some other key was pressed since the chord modifiers were last all up.
    dirty: bool,
    /// The chord fired during this press.
    fired: bool,
    up_sent: bool,
    swallow_esc_up: bool,
}

thread_local! {
    static STATE: RefCell<HookState> = RefCell::new(HookState::default());
}

fn post(ev: Event) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(Msg::Hook(ev, Instant::now()));
    }
}

unsafe extern "system" fn hook_proc(ncode: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if ncode >= 0 {
        let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        // Our own mask key and Ctrl+V (and other tools' synthetic input) never
        // count as the user pressing anything.
        if kb.flags.0 & LLKHF_INJECTED.0 == 0 {
            let msg = wparam.0 as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            if STATE.with(|s| on_key(&mut s.borrow_mut(), kb.vkCode, down)) {
                return LRESULT(1);
            }
        }
    }
    unsafe { CallNextHookEx(None, ncode, wparam, lparam) }
}

/// Returns true when the key must be swallowed.
fn on_key(st: &mut HookState, vk: u32, down: bool) -> bool {
    let chord = Chord::unpack(CHORD.load(Ordering::Relaxed));
    let enabled = ENABLED.load(Ordering::Relaxed);
    let bit = mod_bit(vk);
    let swallow = if down {
        key_down(st, chord, enabled, vk, bit)
    } else {
        key_up(st, chord, enabled, vk, bit)
    };
    let mut phys = st.down & chord.mods;
    if st.key_down {
        phys |= KEY_BIT;
    }
    PHYS_DOWN.store(phys, Ordering::Relaxed);
    swallow
}

fn key_down(st: &mut HookState, chord: Chord, enabled: bool, vk: u32, bit: u8) -> bool {
    if vk == VK_ESCAPE && enabled && ACTIVE.load(Ordering::Relaxed) {
        st.swallow_esc_up = true;
        post(Event::Escape);
        return true;
    }
    if bit != 0 {
        let repeat = st.down & bit != 0;
        st.down |= bit;
        if repeat || !enabled {
            return false;
        }
        if chord.modifier_only() {
            if chord.mods & bit == 0 {
                st.dirty = true;
                if st.fired {
                    post(Event::OtherKey);
                }
            } else if st.down == chord.mods && !st.dirty && !st.fired {
                st.fired = true;
                st.up_sent = false;
                post(Event::ChordDown);
            }
        }
        return false;
    }
    if !enabled {
        return false;
    }
    if chord.key != 0 && vk == chord.key && st.down == chord.mods {
        if !st.key_down {
            st.key_down = true;
            st.fired = true;
            st.up_sent = false;
            post(Event::ChordDown);
        }
        return true;
    }
    if st.down & chord.mods != 0 {
        st.dirty = true;
        if st.fired && chord.modifier_only() {
            post(Event::OtherKey);
        }
    }
    false
}

fn key_up(st: &mut HookState, chord: Chord, enabled: bool, vk: u32, bit: u8) -> bool {
    if vk == VK_ESCAPE && st.swallow_esc_up {
        st.swallow_esc_up = false;
        return true;
    }
    if bit != 0 {
        st.down &= !bit;
        let mut swallow = false;
        if chord.mods & bit != 0 && st.fired {
            if !st.up_sent {
                st.up_sent = true;
                post(Event::ChordUp);
            }
            if bit == M_WIN && enabled {
                // Swallow the real Win-up and replay it after the mask key, so
                // Windows sees Win+<nothing it knows> instead of a lone Win tap.
                inject_mask_then_win_up(vk);
                swallow = true;
            }
        }
        if st.down & chord.mods == 0 && !st.key_down {
            st.dirty = false;
            st.fired = false;
        }
        return swallow;
    }
    if chord.key != 0 && vk == chord.key && st.key_down {
        st.key_down = false;
        if !st.up_sent {
            st.up_sent = true;
            post(Event::ChordUp);
        }
        if st.down & chord.mods == 0 {
            st.dirty = false;
            st.fired = false;
        }
        return true;
    }
    false
}

fn key_input(vk: u16, flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn inject_mask_then_win_up(win_vk: u32) {
    let inputs = [
        key_input(VK_MASK, Default::default()),
        key_input(VK_MASK, KEYEVENTF_KEYUP),
        key_input(win_vk as u16, KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY),
    ];
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

pub const VK_CONTROL: u16 = 0x11;
pub const VK_SHIFT: u16 = 0x10;
pub const VK_V: u16 = 0x56;

/// Sends modifiers + key as synthetic input (marked injected, so our hook
/// ignores it): modifiers down in order, key tap, modifiers up in reverse.
pub fn send_paste_chord(mods: &[u16], key: u16) {
    let mut inputs: Vec<INPUT> = mods.iter().map(|&m| key_input(m, Default::default())).collect();
    inputs.push(key_input(key, Default::default()));
    inputs.push(key_input(key, KEYEVENTF_KEYUP));
    inputs.extend(mods.iter().rev().map(|&m| key_input(m, KEYEVENTF_KEYUP)));
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

/// Installs the hook on a dedicated thread with its own message pump
/// (low-level hooks are called on the installing thread's loop).
pub fn install(tx: Sender<Msg>) {
    let _ = TX.set(tx);
    thread::spawn(|| unsafe {
        let Ok(_hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) else {
            return;
        };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modifier_only_chords() {
        assert_eq!(parse_chord("Ctrl+Win"), Some(Chord { mods: M_CTRL | M_WIN, key: 0 }));
        assert_eq!(parse_chord("shift + win"), Some(Chord { mods: M_SHIFT | M_WIN, key: 0 }));
        assert_eq!(parse_chord("Win"), None);
        assert_eq!(parse_chord(""), None);
    }

    #[test]
    fn parses_key_chords_and_lone_keys() {
        assert_eq!(parse_chord("Ctrl+Shift+Space"), Some(Chord { mods: M_CTRL | M_SHIFT, key: 0x20 }));
        assert_eq!(parse_chord("F13"), Some(Chord { mods: 0, key: 0x7C }));
        assert_eq!(parse_chord("F24"), Some(Chord { mods: 0, key: 0x87 }));
        assert_eq!(parse_chord("Pause"), Some(Chord { mods: 0, key: 0x13 }));
        assert_eq!(parse_chord("A"), None);
        assert_eq!(parse_chord("Ctrl+A+B"), None);
        assert_eq!(parse_chord("F25"), None);
        assert_eq!(parse_chord("Ctrl+Escape"), None);
    }

    fn setup(chord: &str) -> HookState {
        CHORD.store(parse_chord(chord).unwrap().pack(), Ordering::Relaxed);
        ENABLED.store(true, Ordering::Relaxed);
        HookState::default()
    }

    #[test]
    fn modifier_chord_fires_once_and_other_keys_block_it() {
        let chord = parse_chord("Ctrl+Win").unwrap();
        let mut st = setup("Ctrl+Win");
        // Ctrl, C (copy), then Win: another key came first, so no chord.
        key_down(&mut st, chord, true, 0xA2, M_CTRL);
        key_down(&mut st, chord, true, 0x43, 0);
        key_down(&mut st, chord, true, VK_LWIN, M_WIN);
        assert!(!st.fired);
        key_up(&mut st, chord, true, VK_LWIN, M_WIN);
        key_up(&mut st, chord, true, 0xA2, M_CTRL);
        assert!(!st.dirty);
        // A clean press fires, autorepeat doesn't re-fire.
        key_down(&mut st, chord, true, VK_LWIN, M_WIN);
        key_down(&mut st, chord, true, 0xA2, M_CTRL);
        assert!(st.fired);
        key_down(&mut st, chord, true, 0xA2, M_CTRL);
        key_up(&mut st, chord, true, 0xA2, M_CTRL);
        assert!(st.up_sent);
        st.down &= !M_WIN;
        assert_eq!(st.down & chord.mods, 0);
    }

    #[test]
    fn key_chord_swallows_its_key() {
        let chord = parse_chord("Ctrl+Shift+Space").unwrap();
        let mut st = setup("Ctrl+Shift+Space");
        key_down(&mut st, chord, true, 0xA2, M_CTRL);
        key_down(&mut st, chord, true, 0xA0, M_SHIFT);
        assert!(key_down(&mut st, chord, true, 0x20, 0));
        assert!(st.key_down);
        assert!(key_up(&mut st, chord, true, 0x20, 0));
        assert!(!st.key_down);
        // Space without the modifiers passes through.
        let mut st = HookState::default();
        assert!(!key_down(&mut st, chord, true, 0x20, 0));
    }
}
