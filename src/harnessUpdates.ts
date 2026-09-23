/** Agent-CLI ("harness") version checks — the Claude Code / Codex / Gemini CLI
 *  side of updating, as opposed to OpenTerm's own updater in `updater.ts`.
 *
 *  Everything that decides *what* runs lives in Rust (`harness.rs`): the
 *  catalog of harnesses, their version probes, and their update commands. This
 *  module is only the typed doorway to it, so the webview can never hand the
 *  backend a shell command of its own — only a harness id from that table.
 *
 *  One shared state object drives both consumers, the same way `updater.ts`
 *  does it: the background timer in main.ts (which turns results into inbox
 *  items) and the Updates section in Settings (which shows them and offers a
 *  manual re-check). Whoever triggers a check, both see the outcome. */

import { invoke } from "@tauri-apps/api/core";

export interface HarnessStatus {
  /** Binary name, matching what `detectAgentCommand` reports for a pane. */
  id: string;
  label: string;
  current: string;
  latest: string;
  outdated: boolean;
}

export interface HarnessUpdateResult {
  id: string;
  success: boolean;
  /** The update command line that ran (last one tried, if several failed). */
  command: string;
  output: string;
  /** Version the CLI reported after updating, when it could be read. */
  version?: string | null;
}

export type HarnessPhase = "idle" | "checking" | "done" | "error";

export interface HarnessCheckState {
  phase: HarnessPhase;
  /** Installed harnesses from the last successful check. Uninstalled CLIs are
   *  absent — there is nothing to update. */
  results: HarnessStatus[];
  /** Why the last check failed, when `phase` is "error". */
  error?: string;
  checkedAt?: number;
}

const state: HarnessCheckState = { phase: "idle", results: [] };
const listeners = new Set<(s: HarnessCheckState) => void>();

function emit(): void {
  for (const fn of listeners) fn(state);
}

/** Subscribes to check results. Fires immediately with the current state, so a
 *  late subscriber (Settings, opened after a background check) still renders. */
export function onHarnessState(fn: (s: HarnessCheckState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function harnessState(): HarnessCheckState {
  return state;
}

/** Probes every known agent CLI and compares it against its registry.
 *
 *  Never throws — but unlike a plain swallowed error, a failure lands in
 *  `phase: "error"` with the reason, so "the check broke" is distinguishable
 *  from "everything is up to date". Getting those two confused is exactly how
 *  a stale build looks like a working one. */
export async function runHarnessCheck(): Promise<HarnessStatus[]> {
  if (state.phase === "checking") return state.results;
  state.phase = "checking";
  state.error = undefined;
  emit();
  try {
    state.results = await invoke<HarnessStatus[]>("check_harness_updates");
    state.phase = "done";
    state.checkedAt = Date.now();
  } catch (e) {
    state.phase = "error";
    state.error = String(e);
    console.error("agent CLI update check failed:", e);
  }
  emit();
  return state.phase === "done" ? state.results : [];
}

/** Runs the update for one harness. Can take minutes (`npm install -g` on a
 *  cold cache), so callers should show progress rather than await silently. */
export function updateHarness(id: string): Promise<HarnessUpdateResult> {
  return invoke<HarnessUpdateResult>("update_harness", { id });
}
