/** What the engine needs from a harness. Claude Code and Codex each
 *  implement it over their own local process protocol. */
import type { PermissionMode } from "./model";
import type { Runtime } from "./runtime";

export interface PromptImage {
  mediaType: string;
  data: string; // base64, no data: prefix
}

export interface TurnEnd {
  ms: number;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  outcome: "done" | "error" | "interrupted";
  error?: string;
}

export interface IO {
  /** False while replaying the journal: nothing may be written then. */
  live: boolean;
  write(msg: unknown): void;
  endTurn(t: TurnEnd): void;
  notice(tone: "info" | "warn" | "error", text: string): void;
}

export interface Adapter {
  cli: "claude" | "codex";
  /** Substrings of output lines not worth keeping in the journal (deltas). */
  journalSkip: string[];
  args(rt: Runtime): string[];
  /** Right after spawn: handshakes. */
  started(rt: Runtime, io: IO): void;
  prompt(rt: Runtime, io: IO, text: string, images: PromptImage[]): void;
  interrupt(rt: Runtime, io: IO): void;
  /** "live" = applied to the running process; "restart" = needs a respawn. */
  setMode(rt: Runtime, io: IO, mode: PermissionMode): "live" | "restart";
  setModel(rt: Runtime, io: IO, model: string | null): "live" | "restart";
  setEffort(rt: Runtime, io: IO, effort: string | null): "live" | "restart";
  ingest(rt: Runtime, io: IO, msg: any, at: number): void;
}
