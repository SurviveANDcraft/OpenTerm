/** The Agents assistant's action tools (Act and Auto modes): layout changes,
 *  and typing into shells and agent CLIs.
 *
 *  A tool call is first *planned*: arguments and preconditions are checked
 *  and the plan says exactly what will happen, which is what an approval card
 *  shows. Nothing runs until `execute()`, which checks the preconditions again,
 *  since the screen may have moved on while the user was deciding.
 *
 *  Some rules hold in every mode and live here in code rather than in the
 *  prompt: an agent's own permission prompt is never answered, input only goes
 *  to a shell idle at its prompt or an agent idle at its composer, and risky
 *  input (see actionRisk.ts) or closing a busy pane is always hard-gated.
 *
 *  Pane operations belong to main.ts, which hands them in as an ActionHost. */

import { agentByPane, paneOfRef, refOf, visibleSessions, type AgentInfo, type ToolRun } from "./agentsData";
import { isPaneErrored, isPaneWaiting } from "./attention";
import { isShellPrompt, msSinceOutput } from "./commandQueue";
import { invoke } from "@tauri-apps/api/core";
import { panes } from "./terminals";
import { commandRisks, promptRisks } from "./actionRisk";
import type { Dir } from "./types";

export interface ActionHost {
  /** Splits a pane with a fresh terminal; returns the new pane's id. */
  splitPane(paneId: string, dir: Dir): string | null;
  /** A fresh terminal in a session, split off its focused pane. */
  openTerminal(sessionId: string, dir: Dir): string | null;
  /** Closes through the normal (undoable) path; true once the pane is gone. */
  closePane(paneId: string): Promise<boolean>;
  /** Shows the pane's session and focuses the pane. */
  focusPane(paneId: string): void;
  /** Grows (positive) or shrinks the pane along `dir`; false at a limit. */
  resizePane(paneId: string, dir: Dir, delta: number): boolean;
  paneLayout(paneId: string): { zoomed: boolean; folded: boolean } | null;
  toggleZoom(paneId: string): void;
  toggleFold(paneId: string): void;
  renamePane(paneId: string, name: string): void;
}

/** "layout" changes what's on screen; "input" types into a terminal. */
export type ActionTier = "layout" | "input";

export interface ActionResult extends ToolRun {
  ok: boolean;
  /** A pane this action opened, which later actions may then target. */
  created?: string;
}

export interface ActionPlan {
  tool: string;
  tier: ActionTier;
  /** Card heading: "Run command", "Split pane". */
  verb: string;
  /** Title of the pane acted on (or next to), if any. */
  target: string | null;
  /** Exact text that will be typed, if any. */
  text: string | null;
  /** The layout change in words, when there's no text to show. */
  detail: string | null;
  /** Why this needs approval even in Auto mode; empty when it doesn't. */
  risks: string[];
  paneIds: string[];
  /** Step line if the user says no. */
  deniedLabel: string;
  execute(signal: AbortSignal): Promise<ActionResult>;
}

export interface ActionContext {
  host: ActionHost;
  /** May the model touch this pane? Same rule as the read tools. */
  inScope(paneId: string): boolean;
  /** May the model open terminals in this session? */
  sessionInScope(sessionId: string): boolean;
  /** Session for open_terminal when the model names none. */
  defaultSessionId: string | null;
}

export type Planned = { plan: ActionPlan } | { refused: ToolRun };

// ---------------------------------------------------------------- schemas

const ref = { type: "string", description: "Terminal ref, e.g. T3" };
const direction = { type: "string", enum: ["right", "down"], description: "Where the new pane goes. Default right." };

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

/** Sent only in Act and Auto, so Ask requests don't carry them. */
export const ACTION_TOOL_DEFS = [
  tool(
    "open_terminal",
    "Open a new terminal, split beside `ref` or the session's focused pane. Optional start command.",
    {
      session: { type: "string", description: "Session name. Default: the one in scope." },
      ref: { type: "string", description: "Open beside this terminal instead" },
      direction,
      command: { type: "string", description: "Typed once the shell is ready. One command, no chaining." },
    },
    []
  ),
  tool("split_pane", "Split a pane, opening an empty terminal next to it.", { ref, direction }, ["ref"]),
  tool("close_pane", "Close a pane. The user can undo it.", { ref }, ["ref"]),
  tool("focus_pane", "Bring a pane into view and focus it.", { ref }, ["ref"]),
  tool(
    "resize_pane",
    "Resize a pane against its neighbour.",
    {
      ref,
      change: { type: "string", enum: ["wider", "narrower", "taller", "shorter"] },
      amount: { type: "string", enum: ["small", "medium", "large"], description: "Default medium." },
    },
    ["ref", "change"]
  ),
  tool("zoom_pane", "Expand a pane to fill its session (on) or restore it (off).", { ref, on: { type: "boolean" } }, ["ref", "on"]),
  tool("fold_pane", "Collapse a pane to its title bar (on) or unfold it (off).", { ref, on: { type: "boolean" } }, ["ref", "on"]),
  tool("rename_pane", "Set a pane's title.", { ref, name: { type: "string" } }, ["ref", "name"]),
  tool(
    "run_command",
    "Type one command into a plain shell idle at its prompt and press Enter.",
    { ref, command: { type: "string" } },
    ["ref", "command"]
  ),
  tool(
    "prompt_agent",
    "Send a new prompt to an agent CLI idle at its input. Never for answering its permission prompts.",
    { ref, text: { type: "string" } },
    ["ref", "text"]
  ),
];

const ACTION_NAMES = new Set(ACTION_TOOL_DEFS.map((d) => d.function.name));

export function isActionTool(name: string): boolean {
  return ACTION_NAMES.has(name);
}

// ---------------------------------------------------------------- planning

const MAX_COMMAND_CHARS = 500;
const MAX_PROMPT_CHARS = 4000;
const MAX_NAME_CHARS = 60;
const RESIZE_DELTA = { small: 0.05, medium: 0.12, large: 0.22 } as const;
/** How long open_terminal waits for a new shell's first prompt. */
const SHELL_READY_MS = 12_000;

/** Output must have been quiet this long before a process-idle shell counts as
 *  ready: long enough to span a prompt being drawn after a command exits. */
const IDLE_QUIET_MS = 600;

/** Panes whose shell had no child process at the last check. Refreshed before
 *  each planning step and before running, so the synchronous checks below can
 *  use it. */
let idleShells = new Set<string>();

/** Re-reads which shells are running nothing. One process snapshot for all
 *  panes; a failed read keeps the previous answer. */
export async function refreshShellIdle(): Promise<void> {
  const m = await invoke<Record<string, boolean>>("idle_shell_panes").catch(() => null);
  if (m) idleShells = new Set(Object.keys(m).filter((id) => m[id]));
}

/** Ready for a command: the screen shows a recognised prompt, or (for any
 *  custom prompt theme) the shell has no child process and its output has
 *  settled. The second test is what makes Oh My Posh / Starship prompts work. */
function shellReady(id: string): boolean {
  return isShellPrompt(id) || (idleShells.has(id) && msSinceOutput(id) >= IDLE_QUIET_MS);
}

function refuse(result: string, label: string): Planned {
  return { refused: { result: `Error: ${result}`, label, paneIds: [] } };
}

function short(s: string, max = 48): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Wraps text as inline code for a step label, keeping backticks balanced. */
function code(s: string): string {
  return "`" + short(s).replace(/`/g, "'") + "`";
}

function done(result: string, label: string, paneIds: string[], extra: Partial<ActionResult> = {}): ActionResult {
  return { ok: true, result, label, paneIds, ...extra };
}

function failed(result: string, label: string, paneIds: string[] = []): ActionResult {
  return { ok: false, result: `Error: ${result}`, label, paneIds };
}

/** The step-line version of a blocker: "busy", "waiting for you"… so the chat
 *  says why an action didn't happen, not just that it didn't. */
function why(blocker: string): string {
  if (/not a plain shell/.test(blocker)) return "an agent runs there";
  if (/plain shell, not an agent/.test(blocker)) return "not an agent";
  if (/permission|has to answer/.test(blocker)) return "waiting for you";
  if (/mid-turn/.test(blocker)) return "agent is busy";
  if (/busy/.test(blocker)) return "busy";
  return "blocked";
}

/** Why a shell can't take a command right now, or null when it can. */
function shellBlocker(a: AgentInfo): string | null {
  if (a.brand) return `${a.ref} runs ${a.program}, not a plain shell. Use prompt_agent to talk to it.`;
  if (isPaneWaiting(a.paneId))
    return `${a.ref} is waiting on a prompt the user has to answer themselves. Tell the user instead.`;
  if (!shellReady(a.paneId))
    return `${a.ref} is busy running something. Use open_terminal with the command to run it in a new terminal instead.`;
  return null;
}

/** Why an agent can't take a prompt right now, or null when it can. */
function agentBlocker(a: AgentInfo): string | null {
  if (!a.brand) return `${a.ref} is a plain shell, not an agent. Use run_command.`;
  if (isPaneWaiting(a.paneId) && !isPaneErrored(a.paneId))
    return `${a.ref} is asking for permission. Only the user may answer that; tell them it's waiting.`;
  if (a.status === "working") return `${a.ref} is mid-turn. Wait until it's idle, or ask the user.`;
  return null;
}

function waitForShell(paneId: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async (): Promise<void> => {
      if (signal.aborted || !panes.has(paneId)) return resolve(false);
      await refreshShellIdle();
      if (shellReady(paneId)) return resolve(true);
      if (Date.now() - start > SHELL_READY_MS) return resolve(false);
      window.setTimeout(() => void check(), 300);
    };
    void check();
  });
}

function dirOf(v: unknown): Dir {
  return v === "down" ? "col" : "row";
}

function dirWord(dir: Dir): string {
  return dir === "col" ? "below" : "to the right";
}

/** Checks one action call and describes it, without running anything. */
export function planAction(name: string, argsJson: string, ctx: ActionContext): Planned {
  let args: Record<string, unknown>;
  try {
    args = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return refuse("arguments were not valid JSON.", `${name} (bad arguments)`);
  }
  const { host } = ctx;

  const pane = (r: unknown): AgentInfo | null => {
    const id = typeof r === "string" ? paneOfRef(r) : null;
    return id && ctx.inScope(id) ? agentByPane(id) : null;
  };
  const noPane = (): Planned =>
    refuse(`no terminal "${String(args.ref)}" in scope. Use a ref from the snapshot.`, `${name} ${String(args.ref ?? "")}`.trim());
  /** Re-reads a pane at execution time; it may have closed meanwhile. */
  const live = (paneId: string): AgentInfo | null => (panes.has(paneId) ? agentByPane(paneId) : null);
  const gone = (label: string): ActionResult => failed("that terminal has closed.", label);

  switch (name) {
    case "open_terminal": {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (command.includes("\n")) return refuse("command must be a single line.", "Open terminal");
      if (command.length > MAX_COMMAND_CHARS) return refuse("command is too long.", "Open terminal");
      const dir = dirOf(args.direction);
      const beside = args.ref !== undefined && args.ref !== "" ? pane(args.ref) : null;
      if (args.ref && !beside) return noPane();
      let sessionId = beside?.sessionId ?? null;
      if (!sessionId) {
        const wanted = typeof args.session === "string" ? args.session.trim().toLowerCase() : "";
        const s = wanted
          ? visibleSessions().find((x) => x.name.toLowerCase() === wanted || x.id === wanted)
          : visibleSessions().find((x) => x.id === ctx.defaultSessionId);
        if (!s) return refuse(wanted ? `no session named "${String(args.session)}".` : "no session to open it in.", "Open terminal");
        sessionId = s.id;
      }
      if (!ctx.sessionInScope(sessionId)) return refuse("that session is outside the current scope.", "Open terminal");
      const sessionName = visibleSessions().find((x) => x.id === sessionId)?.name ?? "session";
      const where = beside ? `beside ${beside.title}` : `in ${sessionName}`;
      const targetSession = sessionId;
      return {
        plan: {
          tool: name,
          tier: command ? "input" : "layout",
          verb: command ? "Open terminal and run" : "Open terminal",
          target: beside?.title ?? sessionName,
          text: command || null,
          detail: `New terminal ${beside ? `${dirWord(dir)} of ${beside.title}` : `in ${sessionName}`}`,
          risks: command ? commandRisks(command) : [],
          paneIds: beside ? [beside.paneId] : [],
          deniedLabel: command ? `Denied: ${code(command)}` : `Denied: open terminal ${where}`,
          async execute(signal) {
            if (beside && !live(beside.paneId)) return gone("Open terminal");
            const id = beside ? host.splitPane(beside.paneId, dir) : host.openTerminal(targetSession, dir);
            if (!id) return failed("couldn't open a terminal there.", "Open terminal");
            const r = refOf(id);
            if (!command) return done(`Opened ${r} ${where}.`, `Opened a terminal ${where}`, [id], { created: id });
            if (!(await waitForShell(id, signal)))
              return failed(`opened ${r}, but its shell never became ready, so the command was not typed.`, `Opened a terminal ${where}`, [id]);
            panes.get(id)?.typeInput(command, false);
            return done(`Opened ${r} ${where} and ran the command.`, `Ran ${code(command)} in a new terminal`, [id], { created: id });
          },
        },
      };
    }

    case "split_pane": {
      const a = pane(args.ref);
      if (!a) return noPane();
      const dir = dirOf(args.direction);
      const side = dir === "col" ? "down" : "right";
      return {
        plan: {
          tool: name,
          tier: "layout",
          verb: "Split pane",
          target: a.title,
          text: null,
          detail: `New terminal ${dirWord(dir)} of ${a.title}`,
          risks: [],
          paneIds: [a.paneId],
          deniedLabel: `Denied: split ${a.title} ${side}`,
          async execute() {
            if (!live(a.paneId)) return gone(`Split ${a.title}`);
            const id = host.splitPane(a.paneId, dir);
            if (!id) return failed("couldn't split that pane.", `Split ${a.title}`);
            return done(`Split ${a.ref}; the new terminal is ${refOf(id)}.`, `Split ${a.title} ${side}`, [id], { created: id });
          },
        },
      };
    }

    case "close_pane": {
      const a = pane(args.ref);
      if (!a) return noPane();
      const risks: string[] = [];
      if (a.brand) risks.push(`Closes a running ${a.program}`);
      if (a.status === "working" || a.status === "waiting") risks.push("Closes a busy terminal");
      return {
        plan: {
          tool: name,
          tier: "layout",
          verb: "Close pane",
          target: a.title,
          text: null,
          detail: `Close ${a.title}. You can undo it.`,
          risks,
          paneIds: [a.paneId],
          deniedLabel: `Denied: close ${a.title}`,
          async execute() {
            if (!live(a.paneId)) return gone(`Close ${a.title}`);
            const closed = await host.closePane(a.paneId);
            return closed
              ? done(`Closed ${a.ref}.`, `Closed ${a.title}`, [])
              : failed("the pane stayed open (the user cancelled).", `Kept ${a.title} open`, [a.paneId]);
          },
        },
      };
    }

    case "focus_pane": {
      const a = pane(args.ref);
      if (!a) return noPane();
      return {
        plan: {
          tool: name,
          tier: "layout",
          verb: "Focus pane",
          target: a.title,
          text: null,
          detail: `Show and focus ${a.title}`,
          risks: [],
          paneIds: [a.paneId],
          deniedLabel: `Denied: focus ${a.title}`,
          async execute() {
            if (!live(a.paneId)) return gone(`Focus ${a.title}`);
            host.focusPane(a.paneId);
            return done(`Focused ${a.ref}.`, `Focused ${a.title}`, [a.paneId]);
          },
        },
      };
    }

    case "resize_pane": {
      const a = pane(args.ref);
      if (!a) return noPane();
      const change = String(args.change ?? "");
      if (!["wider", "narrower", "taller", "shorter"].includes(change))
        return refuse("change must be wider, narrower, taller or shorter.", `Resize ${a.title}`);
      const amount = (["small", "medium", "large"] as const).find((x) => x === args.amount) ?? "medium";
      const dir: Dir = change === "wider" || change === "narrower" ? "row" : "col";
      const delta = RESIZE_DELTA[amount] * (change === "wider" || change === "taller" ? 1 : -1);
      return {
        plan: {
          tool: name,
          tier: "layout",
          verb: "Resize pane",
          target: a.title,
          text: null,
          detail: `Make ${a.title} ${change}`,
          risks: [],
          paneIds: [a.paneId],
          deniedLabel: `Denied: resize ${a.title}`,
          async execute() {
            if (!live(a.paneId)) return gone(`Resize ${a.title}`);
            return host.resizePane(a.paneId, dir, delta)
              ? done(`Made ${a.ref} ${change}.`, `Made ${a.title} ${change}`, [a.paneId])
              : failed(`${a.ref} can't get ${change}: no neighbour that way, or it's at its limit.`, `Couldn't resize ${a.title}`, [a.paneId]);
          },
        },
      };
    }

    case "zoom_pane":
    case "fold_pane": {
      const a = pane(args.ref);
      if (!a) return noPane();
      const on = args.on !== false;
      const zoom = name === "zoom_pane";
      const words = zoom ? (on ? ["Zoom", "Zoomed"] : ["Unzoom", "Restored"]) : on ? ["Fold", "Folded"] : ["Unfold", "Unfolded"];
      return {
        plan: {
          tool: name,
          tier: "layout",
          verb: `${words[0]} pane`,
          target: a.title,
          text: null,
          detail: zoom
            ? on
              ? `Expand ${a.title} to fill its session`
              : `Restore ${a.title} to its place`
            : on
              ? `Collapse ${a.title} to its title bar`
              : `Unfold ${a.title}`,
          risks: [],
          paneIds: [a.paneId],
          deniedLabel: `Denied: ${words[0].toLowerCase()} ${a.title}`,
          async execute() {
            if (!live(a.paneId)) return gone(`${words[0]} ${a.title}`);
            const state = host.paneLayout(a.paneId);
            if (!state) return gone(`${words[0]} ${a.title}`);
            const current = zoom ? state.zoomed : state.folded;
            if (current !== on) (zoom ? host.toggleZoom : host.toggleFold)(a.paneId);
            return done(
              current === on ? `${a.ref} was already ${words[1].toLowerCase()}.` : `${words[1]} ${a.ref}.`,
              `${words[1]} ${a.title}`,
              [a.paneId]
            );
          },
        },
      };
    }

    case "rename_pane": {
      const a = pane(args.ref);
      if (!a) return noPane();
      const nameArg = typeof args.name === "string" ? args.name.replace(/\s+/g, " ").trim() : "";
      if (!nameArg) return refuse("name is empty.", `Rename ${a.title}`);
      const next = nameArg.slice(0, MAX_NAME_CHARS);
      return {
        plan: {
          tool: name,
          tier: "layout",
          verb: "Rename pane",
          target: a.title,
          text: null,
          detail: `Rename ${a.title} to “${next}”`,
          risks: [],
          paneIds: [a.paneId],
          deniedLabel: `Denied: rename ${a.title}`,
          async execute() {
            if (!live(a.paneId)) return gone(`Rename ${a.title}`);
            host.renamePane(a.paneId, next);
            return done(`Renamed ${a.ref} to "${next}".`, `Renamed ${a.title} to ${next}`, [a.paneId]);
          },
        },
      };
    }

    case "run_command": {
      const a = pane(args.ref);
      if (!a) return noPane();
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) return refuse("command is empty.", `Run in ${a.title}`);
      if (command.includes("\n")) return refuse("one single-line command per call.", `Run in ${a.title}`);
      if (command.length > MAX_COMMAND_CHARS) return refuse("command is too long.", `Run in ${a.title}`);
      const blocked = shellBlocker(a);
      if (blocked) return refuse(blocked, `Couldn't run in ${a.title}: ${why(blocked)}`);
      return {
        plan: {
          tool: name,
          tier: "input",
          verb: "Run command",
          target: a.title,
          text: command,
          detail: null,
          risks: commandRisks(command),
          paneIds: [a.paneId],
          deniedLabel: `Denied: ${code(command)}`,
          async execute() {
            const now = live(a.paneId);
            if (!now) return gone(`Run in ${a.title}`);
            await refreshShellIdle();
            const again = shellBlocker(now);
            if (again) return failed(again, `Couldn't run in ${a.title}: ${why(again)}`, [a.paneId]);
            panes.get(a.paneId)?.typeInput(command, false);
            return done(`Typed the command into ${a.ref} and pressed Enter.`, `Ran ${code(command)} in ${a.title}`, [a.paneId]);
          },
        },
      };
    }

    case "prompt_agent": {
      const a = pane(args.ref);
      if (!a) return noPane();
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return refuse("prompt is empty.", `Prompt ${a.title}`);
      if (text.length > MAX_PROMPT_CHARS) return refuse("prompt is too long.", `Prompt ${a.title}`);
      const blocked = agentBlocker(a);
      if (blocked) return refuse(blocked, `Couldn't prompt ${a.title}: ${why(blocked)}`);
      return {
        plan: {
          tool: name,
          tier: "input",
          verb: `Prompt ${a.program}`,
          target: a.title,
          text,
          detail: null,
          risks: promptRisks(text),
          paneIds: [a.paneId],
          deniedLabel: `Denied: prompt to ${a.title}`,
          async execute() {
            const now = live(a.paneId);
            if (!now) return gone(`Prompt ${a.title}`);
            const again = agentBlocker(now);
            if (again) return failed(again, `Couldn't prompt ${a.title}: ${why(again)}`, [a.paneId]);
            panes.get(a.paneId)?.typeInput(text, true);
            return done(`Sent the prompt to ${a.ref}.`, `Prompted ${a.title}: ${short(text, 60)}`, [a.paneId]);
          },
        },
      };
    }
  }
  return refuse(`unknown tool ${name}.`, name);
}
