//! Windows shell integration — the "type `OpenTerm` in Explorer's address bar"
//! hand-off.
//!
//! Registering writes a handful of `HKEY_CURRENT_USER` keys (so it never needs
//! admin rights, and it only ever affects the current user):
//!
//!   * `App Paths\OpenTerm.exe` — this is what makes typing `OpenTerm` into
//!     Explorer's address bar (or Win+R) find us at all. Explorer resolves the
//!     name through this key and then launches us **with the folder it was
//!     showing as our working directory** — exactly how typing `cmd` there opens
//!     a prompt in that folder. That working directory is the whole mechanism:
//!     we read it back at startup and turn it into a session.
//!   * `Directory\shell\OpenTerm` — right-click a folder → "Open in OpenTerm".
//!   * `Directory\Background\shell\OpenTerm` — right-click blank space *inside*
//!     a folder → same thing. These two pass the folder explicitly as `%V`.
//!
//! Unregistering deletes all three, leaving no trace.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const APP_PATHS: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths\OpenTerm.exe";
const DIR_VERB: &str = r"Software\Classes\Directory\shell\OpenTerm";
const DIR_BG_VERB: &str = r"Software\Classes\Directory\Background\shell\OpenTerm";
const VERB_LABEL: &str = "Open in OpenTerm";

/// Folder this process was launched for, parked here by `main`'s setup hook until
/// the frontend has booted far enough to ask for it via `take_launch_folder`.
static PENDING: Mutex<Option<String>> = Mutex::new(None);

// ------------------------------------------------------------ launch decoding

/// Strips the `\\?\` prefix `canonicalize` adds, which Explorer-style paths never
/// carry and which would break the frontend's "is this the same folder?" compare.
/// A network path comes back as `\\?\UNC\server\share`, which has to fold back to
/// `\\server\share` rather than losing its leading slashes.
fn tidy(p: &Path) -> String {
    let raw = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = raw.to_string_lossy().to_string();
    let s = match s.strip_prefix(r"\\?\UNC\") {
        Some(unc) => format!(r"\\{unc}"),
        None => s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    };
    // Keep a bare drive root as `C:\` — trimming it to `C:` would mean "the
    // process's current directory on C:", a different thing entirely.
    if s.ends_with(":\\") {
        s
    } else {
        s.trim_end_matches('\\').to_string()
    }
}

/// Directories Windows hands a process that was *not* started from a folder — the
/// install dir (Start-menu shortcut, updater relaunch) or a system dir. Treating
/// one of these as "the folder to open" would spawn a junk session on every
/// ordinary launch, so they're ignored.
fn is_neutral_dir(dir: &Path) -> bool {
    // Dev builds are always launched from a repo dir (`cargo run`'s cwd is
    // `src-tauri`), never a real Explorer hand-off — treating that cwd as a
    // folder to open spawned a ghost session on every `tauri dev` run.
    if cfg!(debug_assertions) {
        return true;
    }
    if let Ok(exe) = std::env::current_exe() {
        if exe.parent() == Some(dir) {
            return true;
        }
    }
    for var in ["SystemRoot", "windir"] {
        if let Ok(root) = std::env::var(var) {
            if dir.starts_with(Path::new(&root)) {
                return true;
            }
        }
    }
    false
}

/// Works out which folder a launch is asking us to open. Used both for our own
/// startup and for a second launch forwarded here by the single-instance plugin.
///
/// An explicit path argument wins (that's the context-menu route, `"%V"`); a file
/// argument resolves to its containing folder. Otherwise we fall back to the
/// working directory, which is the address-bar route.
pub fn folder_from_launch(argv: &[String], cwd: &str) -> Option<String> {
    for arg in argv.iter().skip(1) {
        let arg = arg.trim().trim_matches('"');
        if arg.is_empty() || arg.starts_with('-') {
            continue;
        }
        let p = PathBuf::from(arg);
        if p.is_dir() {
            return Some(tidy(&p));
        }
        if p.is_file() {
            if let Some(parent) = p.parent() {
                return Some(tidy(parent));
            }
        }
    }
    let dir = PathBuf::from(cwd);
    if dir.is_dir() && !is_neutral_dir(&dir) {
        Some(tidy(&dir))
    } else {
        None
    }
}

pub fn set_pending(folder: Option<String>) {
    *PENDING.lock().unwrap() = folder;
}

/// Handed to the frontend once, during boot. Taking it clears it so a later
/// reload can't resurrect a stale folder.
#[tauri::command]
pub fn take_launch_folder() -> Option<String> {
    PENDING.lock().unwrap().take()
}

/// Tears down the single-instance guard *before* the app relaunches itself.
///
/// `relaunch()` spawns the replacement process while this one is still alive, so
/// the guard would see a second instance, hand it our argv and let it exit — and
/// the app would simply never come back after an update. Dropping the guard first
/// closes that window.
#[tauri::command]
pub fn release_single_instance_lock(app: tauri::AppHandle) {
    tauri_plugin_single_instance::destroy(&app);
}

// -------------------------------------------------------------- registration

fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("can't locate the OpenTerm executable: {e}"))
}

/// `auto` marks the silent refresh we do on every boot. Debug builds skip that
/// one: a `cargo tauri dev` binary lives in `target/` and would be gone by the
/// next run, leaving `OpenTerm` pointing at nothing. Toggling the setting by hand
/// still registers whatever build is running.
#[tauri::command]
pub fn register_shell_integration(auto: Option<bool>) -> Result<(), String> {
    if auto.unwrap_or(false) && cfg!(debug_assertions) {
        return Ok(());
    }
    let exe = exe_path()?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let oops = |e: std::io::Error| e.to_string();

    let (app_paths, _) = hkcu.create_subkey(APP_PATHS).map_err(oops)?;
    app_paths.set_value("", &exe).map_err(oops)?;
    let dir = Path::new(&exe)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    app_paths.set_value("Path", &dir).map_err(oops)?;

    for base in [DIR_VERB, DIR_BG_VERB] {
        let (verb, _) = hkcu.create_subkey(base).map_err(oops)?;
        verb.set_value("", &VERB_LABEL.to_string()).map_err(oops)?;
        verb.set_value("Icon", &format!("\"{exe}\",0")).map_err(oops)?;
        let (cmd, _) = hkcu.create_subkey(format!(r"{base}\command")).map_err(oops)?;
        cmd.set_value("", &format!("\"{exe}\" \"%V\"")).map_err(oops)?;
    }
    Ok(())
}

#[tauri::command]
pub fn unregister_shell_integration() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for key in [APP_PATHS, DIR_VERB, DIR_BG_VERB] {
        match hkcu.delete_subkey_all(key) {
            Ok(()) => {}
            // Already absent — that's the state we wanted anyway.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// True only when the registration points at *this* executable — after an update
/// moves the binary, a stale key reads as unregistered so the boot refresh fixes it.
#[tauri::command]
pub fn shell_integration_status() -> bool {
    let Ok(exe) = exe_path() else { return false };
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey(APP_PATHS) else { return false };
    let registered: String = match key.get_value("") {
        Ok(v) => v,
        Err(_) => return false,
    };
    registered.eq_ignore_ascii_case(&exe)
}
