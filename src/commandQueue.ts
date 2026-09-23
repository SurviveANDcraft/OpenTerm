import { writePty } from "./pty";
import { isPaneWaiting } from "./attention";

/** Per-pane command queue: `Ctrl+Shift+Enter` stashes a command line for a
 *  pane and it's typed in automatically the next time that pane is sitting
 *  idle at its input prompt — i.e. once whatever is running there finishes.
 *
 *  There's no shell-integration hook (OSC 133) to say "the prompt is back",
 *  so readiness is inferred from the terminal's own rendered screen. Two
 *  things make that reliable enough to trust:
 *
 *  1. **We look at the text *before the cursor*, not the whole line.** A shell
 *     prompt fills the line up to the cursor ("PS C:\path> "), and so does an
 *     agent CLI's boxed input ("│ > "), while a *running* command almost always
 *     leaves the cursor at column 0 of a fresh line — so "there is text before
 *     the cursor ending in a prompt sigil" separates idle from busy without
 *     having to know the prompt's exact shape.
 *  2. **We learn the sigil from the user.** Every time the user presses Enter
 *     in a pane, the characters sitting between the start of the line and what
 *     they typed *are* that program's prompt; its trailing punctuation (">",
 *     "❯", "$", "#", …) is remembered per pane. So whatever is running there —
 *     PowerShell, cmd, bash, Claude Code, opencode — teaches us its own prompt
 *     rather than us guessing it. GENERIC_SIGILS covers the first queue in a
 *     pane, before anything has been learned.
 *
 *  On top of that, a pane with a non-empty queue is polled on a timer rather
 *  than only being checked when PTY output arrives, so a queue can never get
 *  stranded by a readiness check that happened to land at the wrong moment. */

export type QueueListener = (paneId: string, queue: string[]) => void;

/** What terminals.ts reports about a pane's current cursor position. */
export interface PromptContext {
  /** Text on the cursor's row, from column 0 up to the cursor. */
  before: string;
  /** True while a full-screen TUI (vim, less, …) owns the screen. */
  alternate: boolean;
}

const queues = new Map<string, string[]>();
const listeners = new Set<QueueListener>();
/** Supplies a pane's cursor context on demand. commandQueue has no xterm handle
 *  of its own — terminals.ts registers one reader per pane. */
const readySources = new Map<string, () => PromptContext>();
/** Prompt-terminating punctuation learned from what the user types, per pane. */
const learnedSigils = new Map<string, string>();
const lastOutputAt = new Map<string, number>();
const lastDispatchAt = new Map<string, number>();
const pollTimers = new Map<string, number>();

/** Output must be quiet this long before the screen is trusted, so a prompt-ish
 *  frame drawn mid-command (a progress bar, a spinner) can't fire the queue. */
const SETTLE_MS = 400;
/** After dispatching, ignore the screen this long: the program needs a moment to
 *  consume the line and repaint, and until it does its input prompt is still on
 *  screen — without this the rest of the queue would empty into it at once. */
const DISPATCH_COOLDOWN_MS = 1500;
/** How often a pane with a pending queue re-checks. Cheap (one buffer line). */
const POLL_MS = 400;

/** Prompt shapes unambiguous enough to trust on their own, before this pane has
 *  taught us anything — no other output looks like these. */
const STRONG_PROMPTS: RegExp[] = [
  /^PS(?: \[[^\]]*\])? .*>$/, // PowerShell: "PS C:\path>"
  /^[A-Za-z]:\\.*>$/, // cmd.exe: "C:\path>"
];

/** Prompt terminators accepted before anything has been learned. These are weak
 *  on their own — a stalled progress bar redrawn with a bare CR ("[###  ] 40%")
 *  also leaves the cursor at the end of a non-empty line — so they only count
 *  when followed by the space a prompt leaves between its sigil and the cursor.
 *  "%" is deliberately absent: percent-suffixed progress output is far more
 *  common on Windows than a zsh prompt, and a real one gets learned on the
 *  user's first Enter anyway. */
const GENERIC_SIGILS = [">", "$", "#", "❯", "›", "»", "λ", "▶"];

/** Prompts that specifically mean "a *shell* is waiting for a command", as
 *  opposed to the agent-CLI input boxes `isPromptLine` also accepts. Restarting
 *  an agent needs this stricter test: if the CLI hasn't actually quit yet, its
 *  own composer looks just as ready, and the launch command would be posted
 *  into the conversation as a chat message instead of run. */
const SHELL_PROMPTS: RegExp[] = [
  ...STRONG_PROMPTS,
  // bash/zsh: "user@host:~/path$". Box-drawing characters rule out an agent
  // CLI's framed composer, which can also end in "$" inside its border.
  /^[^\u2500-\u257f]*[$#]$/,
];

/** True when this pane's cursor is sitting at a shell prompt right now, and
 *  nothing has been printed for a moment. */
export function isShellPrompt(id: string): boolean {
  if (Date.now() - (lastOutputAt.get(id) ?? 0) < SETTLE_MS) return false;
  const read = readySources.get(id);
  if (!read) return false;
  const { before, alternate } = read();
  if (alternate) return false;
  const text = before.trimEnd();
  return !!text && SHELL_PROMPTS.some((re) => re.test(text));
}

export function registerReadySource(id: string, read: () => PromptContext): void {
  readySources.set(id, read);
}

/** Called by terminals.ts on every Enter: `before` is the cursor row up to the
 *  cursor, `typed` the raw line the user just submitted. The prompt is whatever
 *  precedes what they typed — we keep only its trailing punctuation, since the
 *  rest (a path, a git branch, a clock) changes from one prompt to the next. */
export function learnPromptSigil(id: string, before: string, typed: string): void {
  if (!typed || !before.endsWith(typed)) return;
  const prefix = before.slice(0, before.length - typed.length).trimEnd();
  const m = prefix.match(/[^A-Za-z0-9\s]+$/);
  if (m) learnedSigils.set(id, m[0].slice(-3));
}

/** Returns an unsubscribe so a disposed pane's badge listener doesn't leak. */
export function onQueueChange(fn: QueueListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(id: string): void {
  const q = queues.get(id) ?? [];
  for (const fn of listeners) fn(id, q);
}

export function getQueue(id: string): string[] {
  return queues.get(id) ?? [];
}

export function queueCommand(id: string, command: string): void {
  const cmd = command.trim();
  if (!cmd) return;
  const q = queues.get(id) ?? [];
  q.push(cmd);
  queues.set(id, q);
  emit(id);
  startPolling(id);
}

export function removeQueuedCommand(id: string, index: number): void {
  const q = queues.get(id);
  if (!q || index < 0 || index >= q.length) return;
  q.splice(index, 1);
  if (q.length === 0) {
    queues.delete(id);
    stopPolling(id);
  }
  emit(id);
}

export function clearQueue(id: string): void {
  if (!queues.has(id)) return;
  queues.delete(id);
  stopPolling(id);
  emit(id);
}

/** Record that a pane produced output. Called for every PTY chunk, so it stays
 *  a single map write — the readiness work happens on the poll timer instead. */
export function notifyPaneOutput(id: string): void {
  lastOutputAt.set(id, Date.now());
}

function startPolling(id: string): void {
  if (pollTimers.has(id)) return;
  pollTimers.set(
    id,
    window.setInterval(() => tick(id), POLL_MS)
  );
  tick(id); // queuing onto an already-idle pane shouldn't wait for the first tick
}

function stopPolling(id: string): void {
  const t = pollTimers.get(id);
  if (t !== undefined) window.clearInterval(t);
  pollTimers.delete(id);
}

function tick(id: string): void {
  const q = queues.get(id);
  if (!q || q.length === 0) {
    stopPolling(id);
    return;
  }
  const now = Date.now();
  if (now - (lastOutputAt.get(id) ?? 0) < SETTLE_MS) return; // still producing output
  if (now - (lastDispatchAt.get(id) ?? 0) < DISPATCH_COOLDOWN_MS) return;
  if (isPaneWaiting(id)) return; // a y/n or menu prompt — never answer it with a queued command
  const read = readySources.get(id);
  if (!read) return;
  const { before, alternate } = read();
  if (alternate) return; // a full-screen TUI owns the screen; don't type into it
  if (!isPromptLine(id, before)) return;
  dispatchNext(id);
}

function isPromptLine(id: string, before: string): boolean {
  const text = before.trimEnd();
  if (!text) return false; // cursor at the start of a blank line ⇒ something is running
  // Once this pane has taught us its prompt, trust that and nothing else — the
  // generic fallbacks below are strictly less precise than what we learned.
  const learned = learnedSigils.get(id);
  if (learned) return text.endsWith(learned);
  if (STRONG_PROMPTS.some((re) => re.test(text))) return true;
  if (before === text) return false; // no trailing space ⇒ not where typing starts
  return GENERIC_SIGILS.some((s) => text.endsWith(s));
}

/** Sends the next queued command. The newline goes in a separate write a beat
 *  later: agent CLIs and other TUI inputs read a pasted burst and its Enter in
 *  the same tick as one blob and can drop the submit, so give them a frame to
 *  render the line first. */
function dispatchNext(id: string): void {
  const q = queues.get(id);
  if (!q || q.length === 0) return;
  const cmd = q.shift()!;
  if (q.length === 0) {
    queues.delete(id);
    stopPolling(id);
  }
  lastDispatchAt.set(id, Date.now());
  emit(id);
  void writePty(id, cmd);
  window.setTimeout(() => void writePty(id, "\r"), 80);
}

/** Run the next queued command immediately, whatever the screen looks like —
 *  the manual escape hatch behind clicking a pane's queue badge. */
export function runNextNow(id: string): void {
  dispatchNext(id);
}

/** Call when a pane is torn down, to stop tracking it. */
export function forgetPane(id: string): void {
  stopPolling(id);
  queues.delete(id);
  readySources.delete(id);
  learnedSigils.delete(id);
  lastOutputAt.delete(id);
  lastDispatchAt.delete(id);
}
