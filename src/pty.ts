import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Resolves true when this call actually spawned a new shell process, false
 *  when a PTY for this pane id was already running and got reused (e.g. a
 *  dev-mode reload re-requesting a pane that never really went away). */
export function spawnPty(
  id: string,
  cols: number,
  rows: number,
  shell: string,
  cwd?: string | null,
  args?: string[] | null,
  fallbackCwd?: string | null
): Promise<boolean> {
  return invoke("spawn_pty", {
    id,
    cols,
    rows,
    shell,
    cwd: cwd ?? null,
    args: args ?? null,
    fallbackCwd: fallbackCwd ?? null,
  });
}

export function writePty(id: string, data: string): Promise<void> {
  return invoke("write_pty", { id, data });
}

export function resizePty(id: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_pty", { id, cols, rows });
}

export function killPty(id: string): Promise<void> {
  return invoke("kill_pty", { id });
}

export interface PaneSessionLink {
  harness: string;
  sessionId: string;
  exact: boolean;
  lastSeen: number;
  /** Folder the agent was running in, when known. */
  cwd?: string | null;
}

/** The agent conversation this pane was last attached to, as observed by the
 *  usage poller (exact for Claude Code via its PID registry, inferred from
 *  process-alive windows for the others). Null when nothing was ever linked. */
export function paneLastSession(
  paneId: string,
  harness: string
): Promise<PaneSessionLink | null> {
  return invoke("pane_last_session", { paneId, harness });
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function onPtyOutput(cb: (id: string, data: Uint8Array) => void): void {
  void listen<{ id: string; data: string }>("pty-output", (e) => {
    cb(e.payload.id, b64ToBytes(e.payload.data));
  });
}

export function onPtyExit(cb: (id: string) => void): void {
  void listen<{ id: string }>("pty-exit", (e) => cb(e.payload.id));
}
