import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  applyHookStatus,
  isHookDriven,
  screenShowsPrompt,
  screenShowsWorking,
  setHookDriven,
  setHookHandlers,
  type HookPaneStatus,
} from "./attention";

/** Exact agent status, straight from Claude Code's and Codex's lifecycle hooks.
 *
 *  The backend registers OpenTerm as a hook command with both agents (see
 *  agent_hooks.rs) and forwards every firing here, tagged with the pane it
 *  came from. This module turns that stream into the same three facts the
 *  screen heuristics in attention.ts guess at — is a turn running, is the agent
 *  blocked on the user, how many sub-agents are out — and owns them for every
 *  pane an agent has reported from. Panes that never report (a shell, Gemini,
 *  opencode, an agent started before the hooks were installed) keep the
 *  heuristics.
 *
 *  Hooks are facts, so nothing here infers a state from text. The two places a
 *  hook can't see — the user pressing Esc mid-turn, or rejecting a permission —
 *  are the only spots that consult the screen, and only ever to *end* a state,
 *  never to raise one. */

interface HookEvent {
  seq: number;
  at: number;
  paneId: string;
  agent: string;
  event: string;
  sessionId: string;
  agentId: string | null;
  agentType: string | null;
  toolName: string | null;
  toolUseId: string | null;
  detail: string | null;
  notificationType: string | null;
  message: string | null;
  errorType: string | null;
  source: string | null;
  runningAgents: string[] | null;
}

interface Ask {
  kind: "permission" | "question";
  tool: string | null;
  detail: string | null;
  /** False for asks with no tool call id (a Notification): any tool finishing
   *  clears those, since there is nothing more specific to match. */
  exact: boolean;
}

interface PaneHook {
  agent: string;
  /** The session this pane's status follows. Another session reporting from
   *  the same pane is a nested agent (`codex exec` run by Claude, say). */
  root: string;
  working: boolean;
  asks: Map<string, Ask>;
  error: { sig: string; message: string } | null;
  subagents: Set<string>;
  lastEventAt: number;
  /** Bumped per event, so a scheduled screen check knows if a hook spoke since. */
  epoch: number;
  /** Polls in a row the process tree showed no agent in this pane. */
  missing: number;
  timers: number[];
}

/** Tools that put a question, not a permission, in front of the user. */
const QUESTION_TOOLS = new Set(["askuserquestion", "exitplanmode", "request_user_input"]);

/** How long an ask must stay open before it chimes: a permission another hook
 *  or auto-approval resolves on the spot never reaches the user. */
const ASK_SETTLE_MS = 450;

/** After a keystroke a hook can't see the result of (Esc, Ctrl+C, answering a
 *  permission), how long until the screen is asked whether a turn is still
 *  running. The footer repaints within a frame; this leaves room for a slow one. */
const VERIFY_MS = [1500, 4500];

/** Process-tree polls (3s apart) with no agent in a pane before its hook state
 *  is dropped — the agent crashed or was killed without a SessionEnd. */
const MISSING_POLLS = 2;

const panes = new Map<string, PaneHook>();
const raiseTimers = new Map<string, number>();
/** The attention sig last handed to attention.ts per pane, so re-rendering an
 *  ask that's already up (another event arrived meanwhile) leaves it alone
 *  instead of lowering and re-raising — and re-chiming — it. */
const shownSig = new Map<string, string>();
let enabled = false;
let started = false;
let lastSeq = 0;

const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

function agentName(agent: string): string {
  return AGENT_NAME[agent] ?? agent;
}

function fresh(agent: string, root: string): PaneHook {
  return {
    agent,
    root,
    working: false,
    asks: new Map(),
    error: null,
    subagents: new Set(),
    lastEventAt: Date.now(),
    epoch: 0,
    missing: 0,
    timers: [],
  };
}

function clearTimers(id: string, p: PaneHook): void {
  for (const t of p.timers) clearTimeout(t);
  p.timers = [];
  const r = raiseTimers.get(id);
  if (r !== undefined) {
    clearTimeout(r);
    raiseTimers.delete(id);
  }
}

function drop(id: string): void {
  const p = panes.get(id);
  if (p) clearTimers(id, p);
  panes.delete(id);
  shownSig.delete(id);
  setHookDriven(id, false);
}

function statusOf(p: PaneHook): HookPaneStatus {
  const asks = [...p.asks.entries()];
  if (asks.length) {
    const [key, ask] = asks[asks.length - 1];
    const who = agentName(p.agent);
    const title = ask.kind === "question" ? `${who} has a question` : `${who} needs permission`;
    const what = ask.detail ?? (ask.tool ? `Use ${ask.tool}` : "");
    const message =
      ask.kind === "permission" && ask.tool && ask.detail ? `${ask.tool}: ${ask.detail}` : what || title;
    return {
      working: false,
      subagents: p.subagents.size,
      attention: { kind: "prompt", sig: `hook:${p.root}:${key}`, title, message },
    };
  }
  if (p.error) {
    return {
      working: false,
      subagents: p.subagents.size,
      attention: {
        kind: "error",
        sig: p.error.sig,
        title: `${agentName(p.agent)} hit an error`,
        message: p.error.message,
      },
    };
  }
  return { working: p.working, subagents: p.subagents.size, attention: null };
}

/** Pushes a pane's state to attention.ts. A new ask waits ASK_SETTLE_MS first;
 *  everything else applies at once. */
function render(id: string): void {
  const p = panes.get(id);
  if (!p) return;
  const st = statusOf(p);
  const pending = raiseTimers.get(id);
  if (pending !== undefined) {
    clearTimeout(pending);
    raiseTimers.delete(id);
  }
  if (st.attention?.kind === "prompt" && shownSig.get(id) !== st.attention.sig) {
    // Until it settles, show the pane as it was minus the turn: the agent has
    // stopped to ask, it just hasn't been confirmed as a real dialog yet.
    show(id, { working: false, subagents: st.subagents, attention: null });
    raiseTimers.set(
      id,
      window.setTimeout(() => {
        raiseTimers.delete(id);
        const now = panes.get(id);
        if (now) show(id, statusOf(now));
      }, ASK_SETTLE_MS),
    );
    return;
  }
  show(id, st);
}

function show(id: string, st: HookPaneStatus): void {
  if (st.attention) shownSig.set(id, st.attention.sig);
  else shownSig.delete(id);
  applyHookStatus(id, st);
}

function askKey(ev: HookEvent): string {
  return ev.toolUseId ?? `${ev.event}:${ev.seq}`;
}

function apply(ev: HookEvent): void {
  if (ev.seq <= lastSeq) return;
  lastSeq = ev.seq;
  if (!enabled) return;
  const id = ev.paneId;
  let p = panes.get(id);

  if (ev.event === "sessionstart") {
    // A new root when the pane has none, or the old one is resting (a /clear,
    // a /resume, a fresh launch). One that starts mid-turn is nested.
    if (!p || !p.working || p.root === ev.sessionId) {
      if (p) clearTimers(id, p);
      p = fresh(ev.agent, ev.sessionId);
      panes.set(id, p);
      setHookDriven(id, true, ev.agent === "codex");
      render(id);
    }
    return;
  }
  if (!p) {
    // First word from a session already running (the frontend reloaded, or
    // the hooks were installed mid-session): adopt it from here.
    if (ev.event === "sessionend") return;
    p = fresh(ev.agent, ev.sessionId);
    panes.set(id, p);
    setHookDriven(id, true, ev.agent === "codex");
  }

  const isRoot = !ev.sessionId || ev.sessionId === p.root;
  const main = isRoot && !ev.agentId;
  p.lastEventAt = Date.now();
  p.epoch++;
  p.missing = 0;
  for (const t of p.timers) clearTimeout(t);
  p.timers = [];

  switch (ev.event) {
    case "sessionend":
      if (isRoot) drop(id);
      return;
    case "userpromptsubmit":
      if (!isRoot) return;
      p.working = true;
      p.error = null;
      p.asks.clear();
      break;
    case "pretooluse": {
      const tool = (ev.toolName ?? "").toLowerCase();
      if (QUESTION_TOOLS.has(tool)) {
        p.asks.set(askKey(ev), { kind: "question", tool: ev.toolName, detail: ev.detail, exact: !!ev.toolUseId });
      } else if (main) {
        p.working = true;
      }
      break;
    }
    case "permissionrequest": {
      // Any session or sub-agent in the pane: whoever asks, the user answers.
      const key = askKey(ev);
      const prev = p.asks.get(key);
      const tool = (ev.toolName ?? "").toLowerCase();
      const kind = prev?.kind === "question" || QUESTION_TOOLS.has(tool) ? "question" : "permission";
      p.asks.set(key, { kind, tool: ev.toolName, detail: ev.detail ?? prev?.detail ?? null, exact: !!ev.toolUseId });
      break;
    }
    case "posttooluse":
    case "posttoolusefailure": {
      if (ev.toolUseId) p.asks.delete(ev.toolUseId);
      for (const [k, a] of p.asks) if (!a.exact && a.kind === "permission") p.asks.delete(k);
      if (main) p.working = true;
      break;
    }
    case "notification":
      switch (ev.notificationType) {
        case "permission_prompt":
          // Usually doubles a PermissionRequest; only stands alone if that
          // one didn't come through.
          if (![...p.asks.values()].some((a) => a.kind === "permission")) {
            p.asks.set("notify", { kind: "permission", tool: null, detail: ev.message, exact: false });
          }
          break;
        case "elicitation_dialog":
        case "elicitation_url_dialog":
          p.asks.set("elicit", { kind: "question", tool: null, detail: ev.message, exact: false });
          break;
        case "elicitation_complete":
        case "elicitation_response":
          p.asks.delete("elicit");
          break;
        case "idle_prompt":
          // Sitting at its input box: nothing running, nothing pending.
          if (!isRoot) return;
          p.working = false;
          p.asks.clear();
          break;
        default:
          return;
      }
      break;
    case "stop":
      if (!main) return;
      p.working = false;
      p.asks.clear();
      if (ev.runningAgents) p.subagents = new Set(ev.runningAgents);
      break;
    case "stopfailure":
      if (!main) return;
      p.working = false;
      p.asks.clear();
      p.error = {
        sig: `hook:${p.root}:error:${ev.seq}`,
        message: [ev.errorType?.replace(/_/g, " "), ev.message].filter(Boolean).join(": ") || "The turn failed",
      };
      break;
    case "interrupt":
      if (!isRoot) return;
      p.working = false;
      p.asks.clear();
      break;
    case "subagentstart":
      if (ev.agentId) p.subagents.add(ev.agentId);
      break;
    case "subagentstop":
      if (ev.agentId) p.subagents.delete(ev.agentId);
      break;
    default:
      return;
  }
  render(id);
}

/** Keys that answer a permission menu, as opposed to moving through it. */
function answersMenu(data: string): boolean {
  return /[\r\n]/.test(data) || /^[0-9yYnNaApP]$/.test(data) || data === "\x1b" || data === "\x03";
}

function cancels(data: string): boolean {
  return data === "\x1b" || data === "\x03" || data === "\x1b\x1b";
}

/** After a keystroke whose outcome no hook reports, settle the pane from the
 *  screen — unless a hook speaks first, which always wins. */
function verifyLater(id: string, p: PaneHook, check: (p: PaneHook) => boolean): void {
  const epoch = p.epoch;
  for (const ms of VERIFY_MS) {
    p.timers.push(
      window.setTimeout(() => {
        const now = panes.get(id);
        if (now !== p || p.epoch !== epoch) return;
        if (check(p)) render(id);
      }, ms),
    );
  }
}

function onInput(id: string, data: string): void {
  const p = panes.get(id);
  if (!p || !data) return;
  if (p.error) {
    // Typing after a failure is the user picking it up.
    p.error = null;
    render(id);
  }
  if (p.asks.size) {
    if (!answersMenu(data)) return;
    const questions = [...p.asks.values()].some((a) => a.kind === "question");
    if (!questions || cancels(data)) {
      // A permission answered (or anything cancelled): the hook for what
      // happens next may be minutes away — the approved tool's PostToolUse
      // only fires when it finishes — so act on the answer now.
      p.asks.clear();
      p.working = true;
      render(id);
      verifyLater(id, p, (q) => {
        if (!q.working || screenShowsWorking(id)) return false;
        q.working = false;
        return true;
      });
    } else {
      // A question can span several screens (one per question, then a review),
      // and its PostToolUse lands the moment it's fully answered. Only if the
      // panel is gone with no word from the hooks is it treated as answered.
      verifyLater(id, p, (q) => {
        if (!q.asks.size || screenShowsPrompt(id)) return false;
        q.asks.clear();
        q.working = screenShowsWorking(id);
        return true;
      });
    }
    return;
  }
  if (p.working && cancels(data)) {
    verifyLater(id, p, (q) => {
      if (!q.working || screenShowsWorking(id)) return false;
      q.working = false;
      return true;
    });
  }
}

/** Drops panes whose agent is gone from the process tree without having said
 *  goodbye (crashed, killed), handing them back to the heuristics. */
async function reapMissing(): Promise<void> {
  if (!panes.size) return;
  let live: Record<string, string>;
  try {
    live = await invoke<Record<string, string>>("live_pane_harnesses");
  } catch {
    return;
  }
  const now = Date.now();
  for (const [id, p] of panes) {
    if (live[id] || now - p.lastEventAt < 8000) {
      p.missing = 0;
      continue;
    }
    if (++p.missing >= MISSING_POLLS) drop(id);
  }
}

function dropAll(): void {
  for (const id of [...panes.keys()]) drop(id);
}

/** Installs (or removes) the hooks to match the setting, and starts listening.
 *  Called at boot and whenever the setting changes. */
export async function syncAgentHooks(on: boolean): Promise<{ claude: string; codex: string } | null> {
  enabled = on;
  if (!on) dropAll();
  if (!started) {
    started = true;
    setHookHandlers(onInput, (id) => {
      const p = panes.get(id);
      if (p) clearTimers(id, p);
      panes.delete(id);
      shownSig.delete(id);
    });
    const buffered: HookEvent[] = [];
    let replaying = true;
    await listen<HookEvent>("agent-hook", (e) => {
      if (replaying) buffered.push(e.payload);
      else apply(e.payload);
    });
    // Replay what the backend saw before this frontend existed (a reload with
    // agents mid-turn), then drain what arrived meanwhile — seq dedups both.
    try {
      const past = await invoke<HookEvent[]>("agent_hook_events");
      for (const ev of past) apply(ev);
    } catch {
      /* nothing to replay */
    }
    replaying = false;
    buffered.sort((a, b) => a.seq - b.seq).forEach(apply);
    window.setInterval(() => void reapMissing(), 3000);
  }
  try {
    return await invoke<{ claude: string; codex: string }>("agent_hooks_sync", { enabled: on });
  } catch (e) {
    console.warn("[agent-hooks] sync failed", e);
    return null;
  }
}

/** True when this pane's status is coming from the agent's hooks. */
export function paneHasExactStatus(id: string): boolean {
  return isHookDriven(id);
}
