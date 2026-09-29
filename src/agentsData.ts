/** What the Agents panel knows about each terminal, and the read-only tools its
 *  assistant uses to look inside them.
 *
 *  Everything here reads state the app already maintains — the pane tree, the
 *  rendered xterm buffers, the attention detector's status flags — so building
 *  the roster costs nothing. The only IPC is the transcript lookup behind a
 *  pane's last prompt, which is cached.
 *
 *  Terminals are exposed to the model under short refs (T1, T2, …) instead of
 *  pane ids: fewer tokens, easier for the model to cite, and the UI turns them
 *  back into links. A ref sticks to its pane for the life of the app. */

import { invoke } from "@tauri-apps/api/core";
import { store } from "./store";
import { collectLeaves, findLeaf } from "./tree";
import { panes } from "./terminals";
import { isPaneErrored, isPaneWaiting, isPaneWorking, paneSubagentCount } from "./attention";
import { detectAgentCommand, type Session } from "./types";
import { agentBrand, markLabel, type AgentBrand } from "./paneIcons";
import { fetchPaneUsage, fmtCost } from "./usage";

export type AgentStatus = "working" | "waiting" | "error" | "idle";

export interface AgentInfo {
  paneId: string;
  ref: string;
  sessionId: string;
  sessionName: string;
  sessionColor: string;
  title: string;
  /** Agent brand when an agent CLI runs here; null for a plain shell. */
  brand: AgentBrand | null;
  /** Display name of what's running ("Claude Code", "PowerShell"). */
  program: string;
  status: AgentStatus;
  /** When the pane entered its current status (epoch ms). */
  since: number;
  subagents: number;
  cwd: string | null;
}

/** "all" or a session id. */
export type Scope = string;

// ---------------------------------------------------------------- refs

const refs = new Map<string, string>();
const byRef = new Map<string, string>();
let nextRef = 1;

export function refOf(paneId: string): string {
  let r = refs.get(paneId);
  if (!r) {
    r = `T${nextRef++}`;
    refs.set(paneId, r);
    byRef.set(r, paneId);
  }
  return r;
}

export function paneOfRef(ref: string): string | null {
  return byRef.get(ref.trim().toUpperCase()) ?? null;
}

// ---------------------------------------------------------------- roster

/** Resolves the agent running in a pane (live harness id or typed command).
 *  Injected by main.ts, which owns the process-tree poll. */
let harnessOf: (paneId: string) => string | null = () => null;

export function setAgentResolver(fn: (paneId: string) => string | null): void {
  harnessOf = fn;
}

const statusSince = new Map<string, { status: AgentStatus; since: number }>();

function statusOf(paneId: string): AgentStatus {
  if (isPaneWaiting(paneId)) return isPaneErrored(paneId) ? "error" : "waiting";
  if (isPaneWorking(paneId)) return "working";
  return "idle";
}

function trackSince(paneId: string, status: AgentStatus): number {
  const prev = statusSince.get(paneId);
  if (prev && prev.status === status) return prev.since;
  const since = Date.now();
  statusSince.set(paneId, { status, since });
  return since;
}

export function visibleSessions(): Session[] {
  return store.state.sessions.filter((s) => !s.archived);
}

/** Every live terminal pane in scope, agents first, then by session order. */
export function listAgents(scope: Scope): AgentInfo[] {
  const out: AgentInfo[] = [];
  for (const s of visibleSessions()) {
    if (scope !== "all" && s.id !== scope) continue;
    for (const id of collectLeaves(s.tree)) {
      const term = panes.get(id);
      if (!term) continue; // browser, file and external panes have no buffer to read
      const leaf = findLeaf(s.tree, id);
      const status = statusOf(id);
      const claimed = leaf?.lastCommand ? detectAgentCommand(leaf.lastCommand) : null;
      // The typed command only counts while the screen shows agent activity —
      // otherwise a pane where `claude` exited long ago would still wear it.
      const brand = agentBrand(harnessOf(id)) ?? (status !== "idle" ? agentBrand(claimed) : null);
      out.push({
        paneId: id,
        ref: refOf(id),
        sessionId: s.id,
        sessionName: s.name,
        sessionColor: s.color,
        title: term.title,
        brand,
        program: brand ? markLabel(brand) : "Shell",
        status,
        since: trackSince(id, status),
        subagents: paneSubagentCount(id),
        cwd: leaf?.cwd ?? s.cwd ?? null,
      });
    }
  }
  // Stable: agents first, keeping tree order within each group.
  return out.sort((a, b) => Number(!a.brand) - Number(!b.brand));
}

export function agentByPane(paneId: string): AgentInfo | null {
  return listAgents("all").find((a) => a.paneId === paneId) ?? null;
}

// ---------------------------------------------------------------- last prompt

export interface LastPrompt {
  harness: string;
  text: string;
  at: number | null;
}

const PROMPT_TTL_MS = 15_000;
const promptCache = new Map<string, { at: number; value: LastPrompt | null; inflight?: Promise<LastPrompt | null> }>();

/** The user's last prompt to the agent in this pane, from its transcript.
 *  Cached briefly — cards and the summariser both ask on every refresh. */
export function lastPrompt(paneId: string): Promise<LastPrompt | null> {
  const hit = promptCache.get(paneId);
  if (hit?.inflight) return hit.inflight;
  if (hit && Date.now() - hit.at < PROMPT_TTL_MS) return Promise.resolve(hit.value);
  const inflight = invoke<LastPrompt | null>("pane_last_prompt", { paneId })
    .catch(() => null)
    .then((value) => {
      promptCache.set(paneId, { at: Date.now(), value });
      return value;
    });
  promptCache.set(paneId, { at: hit?.at ?? 0, value: hit?.value ?? null, inflight });
  return inflight;
}

export function cachedLastPrompt(paneId: string): LastPrompt | null {
  return promptCache.get(paneId)?.value ?? null;
}

// ---------------------------------------------------------------- text cleaning

/** Box-drawing, block and spinner glyphs that TUIs paint their chrome with. */
const CHROME_CHARS = /[─-╿▀-▟⠀-⣿]/g;
const MAX_LINE_CHARS = 280;

/** Terminal text → what a model should read: TUI borders gone, repaint
 *  duplicates and blank runs collapsed, runaway lines clipped. Typically cuts
 *  an agent screen by a third or more without losing a word of content. */
export function cleanTerminalText(raw: string): string[] {
  const out: string[] = [];
  let blank = false;
  for (let line of raw.split("\n")) {
    line = line.replace(CHROME_CHARS, " ").replace(/[ \t]+/g, " ").trim();
    if (!line) {
      if (!blank && out.length) out.push("");
      blank = true;
      continue;
    }
    blank = false;
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) + "…";
    // Spinner/status repaints leave the same line stacked up in scrollback.
    if (out.length && out[out.length - 1] === line) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function paneLines(paneId: string, rawLines: number): string[] {
  const term = panes.get(paneId);
  return term ? cleanTerminalText(term.snapshotText(rawLines)) : [];
}

/** Last meaningful line on screen — the card's fallback "now" line. */
export function lastScreenLine(paneId: string): string {
  const term = panes.get(paneId);
  if (!term) return "";
  const lines = cleanTerminalText(term.screenTail(24)).filter(
    (l) => l.length > 2 && !/^[>❯$#%]\s*$/.test(l) && !/for shortcuts|esc to interrupt|\? for help/i.test(l)
  );
  return lines[lines.length - 1] ?? "";
}

/** Tail of a pane, cleaned, as the summariser and inline attachments see it. */
export function screenExcerpt(paneId: string, lines: number, maxChars: number): string {
  const text = paneLines(paneId, lines * 3).slice(-lines).join("\n");
  return text.length > maxChars ? "…" + text.slice(-maxChars) : text;
}

// ---------------------------------------------------------------- tools

/** OpenAI-format tool schemas. Descriptions are short on purpose: they ride
 *  along with every request (cached, but still). */
export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "read_terminal",
      description:
        "Read a terminal's recent output (cleaned). Use for specifics the snapshot doesn't give. Ask for the fewest lines that answer the question.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Terminal ref, e.g. T3" },
          lines: { type: "integer", description: "Lines from the end, 20-400. Default 60." },
          grep: {
            type: "string",
            description: "Optional: only lines matching this (case-insensitive regex), with 2 lines of context.",
          },
        },
        required: ["ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_terminals",
      description: "Find which terminals mention something. Returns matching lines per terminal.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Case-insensitive regex or plain text" },
          refs: { type: "array", items: { type: "string" }, description: "Limit to these refs; default all in scope" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent_details",
      description: "Full last prompt the user gave an agent, its folder, cost so far and status.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string", description: "Terminal ref, e.g. T3" } },
        required: ["ref"],
      },
    },
  },
];

/** Hard ceiling on any one tool result, so a single read can't flood the
 *  context (~2k tokens). */
const TOOL_RESULT_MAX_CHARS = 8000;
const SEARCH_SCAN_LINES = 3000;
const SEARCH_MAX_PER_TERMINAL = 6;
const SEARCH_MAX_TOTAL = 30;

function toRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function clip(s: string): string {
  return s.length > TOOL_RESULT_MAX_CHARS ? "…(earlier output clipped)\n" + s.slice(-TOOL_RESULT_MAX_CHARS) : s;
}

function unknownRef(ref: unknown): string {
  return `Error: no terminal "${String(ref)}". Use a ref from the snapshot.`;
}

function header(a: AgentInfo): string {
  return `${a.ref} "${a.title}" (${a.program}, ${a.status})`;
}

export interface ToolRun {
  /** What goes back to the model. */
  result: string;
  /** Short, human label for the activity line ("Read T3 · 60 lines"). */
  label: string;
  /** Pane ids the tool looked at, so the UI can highlight them. */
  paneIds: string[];
}

/** Runs one tool call. `scope` bounds what the model may see: a ref outside
 *  the chosen sessions is rejected unless it was explicitly attached. */
export async function runTool(
  name: string,
  argsJson: string,
  inScope: (paneId: string) => boolean
): Promise<ToolRun> {
  let args: Record<string, unknown>;
  try {
    args = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return { result: "Error: arguments were not valid JSON.", label: `${name} (bad arguments)`, paneIds: [] };
  }

  const resolve = (ref: unknown): AgentInfo | null => {
    const id = typeof ref === "string" ? paneOfRef(ref) : null;
    if (!id || !inScope(id)) return null;
    return agentByPane(id);
  };

  if (name === "read_terminal") {
    const a = resolve(args.ref);
    if (!a) return { result: unknownRef(args.ref), label: `Read ${String(args.ref)}`, paneIds: [] };
    const n = Math.max(20, Math.min(400, Number(args.lines) || 60));
    const grep = typeof args.grep === "string" && args.grep.trim() ? toRegex(args.grep.trim()) : null;
    let body: string;
    if (grep) {
      const lines = paneLines(a.paneId, SEARCH_SCAN_LINES);
      const keep = new Set<number>();
      lines.forEach((l, i) => {
        if (grep.test(l)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
      });
      const picked = [...keep].sort((x, y) => x - y);
      const parts: string[] = [];
      picked.forEach((i, k) => {
        if (k > 0 && i !== picked[k - 1] + 1) parts.push("…");
        parts.push(lines[i]);
      });
      body = parts.length ? parts.slice(-n).join("\n") : "(no matching lines)";
    } else {
      body = paneLines(a.paneId, n * 3).slice(-n).join("\n") || "(terminal is empty)";
    }
    return {
      result: clip(`${header(a)}\n${body}`),
      label: `Read ${a.title}${grep ? ` · “${String(args.grep)}”` : ""}`,
      paneIds: [a.paneId],
    };
  }

  if (name === "search_terminals") {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) return { result: "Error: empty pattern.", label: "Search", paneIds: [] };
    const re = toRegex(pattern);
    const wanted = Array.isArray(args.refs) ? new Set(args.refs.map((r) => String(r).toUpperCase())) : null;
    const hits: string[] = [];
    const touched: string[] = [];
    let total = 0;
    for (const a of listAgents("all")) {
      if (!inScope(a.paneId) || (wanted && !wanted.has(a.ref))) continue;
      const matches = paneLines(a.paneId, SEARCH_SCAN_LINES).filter((l) => re.test(l));
      if (!matches.length) continue;
      touched.push(a.paneId);
      const shown = matches.slice(-SEARCH_MAX_PER_TERMINAL);
      hits.push(`${header(a)} — ${matches.length} match${matches.length === 1 ? "" : "es"}`, ...shown.map((l) => `  ${l}`));
      total += shown.length;
      if (total >= SEARCH_MAX_TOTAL) break;
    }
    return {
      result: clip(hits.length ? hits.join("\n") : "No terminal in scope mentions that."),
      label: `Searched for “${pattern}”`,
      paneIds: touched,
    };
  }

  if (name === "agent_details") {
    const a = resolve(args.ref);
    if (!a) return { result: unknownRef(args.ref), label: `Details ${String(args.ref)}`, paneIds: [] };
    const [prompt, usage] = await Promise.all([
      lastPrompt(a.paneId),
      fetchPaneUsage(a.paneId).catch(() => null),
    ]);
    const lines = [
      header(a),
      `session: ${a.sessionName}`,
      a.cwd ? `folder: ${a.cwd}` : null,
      `status for: ${ago(a.since)}`,
      a.subagents ? `sub-agents running: ${a.subagents}` : null,
      usage && usage.cost_usd > 0 ? `cost so far: ${fmtCost(usage.cost_usd)} over ${usage.messages} messages` : null,
      prompt
        ? `last prompt${prompt.at ? ` (${ago(prompt.at)} ago)` : ""}:\n${prompt.text.slice(0, 2500)}`
        : "last prompt: unknown (no transcript for this agent)",
    ];
    return {
      result: clip(lines.filter(Boolean).join("\n")),
      label: `Checked ${a.title}`,
      paneIds: [a.paneId],
    };
  }

  return { result: `Error: unknown tool ${name}.`, label: name, paneIds: [] };
}

// ---------------------------------------------------------------- formatting

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
}
