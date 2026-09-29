/** AI one-liners for the agent cards: what the user asked this agent to do,
 *  and where it stands now.
 *
 *  Refreshed on *events*, not a clock: a new prompt, or the agent changing
 *  state (finished, blocked, errored). A long working stretch gets an
 *  occasional refresh so its "now" line doesn't go stale. Each call sends a
 *  few hundred tokens — the prompt's head and tail and a cleaned screen tail —
 *  and nothing runs while the panel is closed. */

import { invoke } from "@tauri-apps/api/core";
import { lastPrompt, screenExcerpt, type AgentInfo, type AgentStatus } from "./agentsData";
import { store } from "./store";

export interface CardSummary {
  task: string;
  now: string;
  at: number;
}

interface Entry {
  summary: CardSummary | null;
  /** Fingerprint of the inputs the summary was made from. */
  key: string;
  status: AgentStatus | null;
  pending: boolean;
  failures: number;
}

/** Floor between two summaries of one pane, whatever happens. */
const MIN_INTERVAL_MS = 20_000;
/** A pane that keeps working gets its "now" refreshed this often. */
const WORKING_REFRESH_MS = 4 * 60_000;
const MAX_CONCURRENT = 2;
const MAX_FAILURES = 3;
const PROMPT_HEAD = 600;
const PROMPT_TAIL = 250;
const SCREEN_LINES = 36;
const SCREEN_MAX_CHARS = 1800;

const entries = new Map<string, Entry>();
/** Panes whose "is a refresh due?" check is awaiting the prompt lookup, so
 *  back-to-back panel refreshes can't queue the same pane twice. */
const checking = new Set<string>();
const queue: AgentInfo[] = [];
let running = 0;
let onUpdate: (paneId: string) => void = () => {};

export function onCardSummary(fn: (paneId: string) => void): void {
  onUpdate = fn;
}

export function cardSummary(paneId: string): CardSummary | null {
  return entries.get(paneId)?.summary ?? null;
}

export function isSummarizing(paneId: string): boolean {
  return entries.get(paneId)?.pending ?? false;
}

export function summariesEnabled(): boolean {
  const s = store.state.settings;
  return s.agentCardSummaries && s.openrouterApiKey.trim().length > 0;
}

/** Called on every panel refresh with the agent cards on screen. Cheap when
 *  nothing changed: one cached prompt lookup per card, no request. */
export function refreshSummaries(agents: AgentInfo[], force = false): void {
  if (!summariesEnabled()) return;
  for (const a of agents) {
    if (!a.brand) continue; // shells have no task to name
    void consider(a, force);
  }
}

async function consider(a: AgentInfo, force: boolean): Promise<void> {
  let e = entries.get(a.paneId);
  if (!e) {
    e = { summary: null, key: "", status: null, pending: false, failures: 0 };
    entries.set(a.paneId, e);
  }
  if (e.pending || checking.has(a.paneId) || (!force && e.failures >= MAX_FAILURES)) return;

  checking.add(a.paneId);
  const prompt = await lastPrompt(a.paneId).finally(() => checking.delete(a.paneId));
  const key = prompt ? `${prompt.at ?? ""}:${prompt.text.length}:${prompt.text.slice(0, 80)}` : "none";
  const age = e.summary ? Date.now() - e.summary.at : Infinity;
  const due =
    force ||
    !e.summary ||
    key !== e.key ||
    (a.status !== e.status && a.status !== "working") || // settled into a new state
    (a.status === "working" && age > WORKING_REFRESH_MS);
  if (!due || (!force && age < MIN_INTERVAL_MS)) return;

  e.pending = true;
  e.key = key;
  e.status = a.status;
  if (force) e.failures = 0;
  onUpdate(a.paneId);
  queue.push(a);
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length) {
    const a = queue.shift()!;
    running++;
    void summarize(a).finally(() => {
      running--;
      pump();
    });
  }
}

async function summarize(a: AgentInfo): Promise<void> {
  const e = entries.get(a.paneId)!;
  try {
    const prompt = await lastPrompt(a.paneId);
    const p = prompt?.text ?? "";
    const promptText =
      p.length > PROMPT_HEAD + PROMPT_TAIL ? `${p.slice(0, PROMPT_HEAD)}\n…\n${p.slice(-PROMPT_TAIL)}` : p;
    const context = [
      `Agent: ${a.program}. Status: ${a.status}.`,
      promptText ? `User's last prompt:\n${promptText}` : "User's last prompt: (unknown)",
      `Screen tail:\n${screenExcerpt(a.paneId, SCREEN_LINES, SCREEN_MAX_CHARS) || "(empty)"}`,
    ].join("\n\n");
    const raw = await invoke<string>("summarize_agent", {
      apiKey: store.state.settings.openrouterApiKey.trim(),
      context,
    });
    const parsed = parse(raw);
    e.summary = { ...parsed, at: Date.now() };
    e.failures = 0;
  } catch (err) {
    e.failures++;
    console.warn("Agent card summary failed:", err);
  } finally {
    e.pending = false;
    onUpdate(a.paneId);
  }
}

/** Small models sometimes wrap the object in prose or a fence; take the first
 *  object rather than failing the card over formatting. */
function parse(text: string): { task: string; now: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in response");
  const v = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const str = (x: unknown, max: number): string => {
    const s =
      typeof x === "string"
        ? x.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim().replace(/[.]$/, "")
        : "";
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  };
  return { task: str(v.task, 70), now: str(v.now, 90) };
}

export function forgetCardSummary(paneId: string): void {
  entries.delete(paneId);
}
