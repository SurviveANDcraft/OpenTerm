import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Frontend half of the Explorer hand-off: typing `OpenTerm` in a folder's
 *  address bar (or using the folder context menu) asks this app to open that
 *  folder. See `src-tauri/src/shell_integration.rs` for how the folder is found. */

/** Canonical form used to decide whether two paths mean the same folder.
 *  Windows paths are case-insensitive and accept either slash, and a trailing
 *  separator is meaningless — so `C:\Foo\` and `c:/foo` must compare equal. */
export function folderKey(path: string | null | undefined): string {
  if (!path) return "";
  return path.trim().replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** Last path segment, used to name a session after the folder it opens. */
export function folderLabel(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** The folder this app instance was launched for, if any. Cleared once taken,
 *  so a webview reload doesn't re-open it. */
export async function takeLaunchFolder(): Promise<string | null> {
  try {
    return await invoke<string | null>("take_launch_folder");
  } catch {
    return null;
  }
}

/** Fires when an *already running* app is asked to open a folder — a second
 *  `OpenTerm` launch that the single-instance plugin folded into this one. */
export function onOpenFolder(cb: (folder: string) => void): void {
  void listen<string>("open-folder", (e) => {
    if (e.payload) cb(e.payload);
  });
}

export async function isShellIntegrationRegistered(): Promise<boolean> {
  try {
    return await invoke<boolean>("shell_integration_status");
  } catch {
    return false;
  }
}

/** Writes (or removes) the registry keys behind the hand-off.
 *  `auto` marks the silent refresh done on every boot, which debug builds skip —
 *  a dev binary would leave `OpenTerm` pointing at a path that no longer exists. */
export async function syncShellIntegration(enabled: boolean, auto = false): Promise<void> {
  try {
    if (enabled) await invoke("register_shell_integration", { auto });
    else await invoke("unregister_shell_integration");
  } catch (e) {
    console.error("Explorer integration could not be updated:", e);
  }
}
