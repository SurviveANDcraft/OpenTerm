import { invoke } from "@tauri-apps/api/core";

/** Mirrors the `usage.rs` serde output — field names are snake_case on purpose. */

export interface Tokens {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  reasoning: number;
  total: number;
}

export interface ModelUsage {
  model: string;
  harness: string;
  tokens: Tokens;
  cost_usd: number;
  /** False when no rate is known for this model — its tokens are still exact. */
  priced: boolean;
  messages: number;
}

export interface SessionUsage {
  harness: string;
  session_id: string;
  title: string | null;
  cwd: string | null;
  git_branch: string | null;
  models: string[];
  tokens: Tokens;
  cost_usd: number;
  priced: boolean;
  messages: number;
  tool_calls: number;
  web_searches: number;
  started_at: number | null;
  ended_at: number | null;
  /** True when the session was linked via a PID→session registry rather than
   *  matched by the window during which the agent process was alive. */
  exact: boolean;
}

export interface DayUsage {
  day: string;
  cost_usd: number;
  tokens: Tokens;
  messages: number;
}

export interface ToolUsage {
  name: string;
  calls: number;
}

export interface LiveAgent {
  harness: string;
  pid: number;
}

export interface PaneUsage {
  pane_id: string;
  cost_usd: number;
  /** True when every model seen had a known rate, so the total is not a floor. */
  cost_complete: boolean;
  tokens: Tokens;
  messages: number;
  tool_calls: number;
  web_searches: number;
  session_count: number;
  first_activity: number | null;
  last_activity: number | null;
  active_ms: number;
  by_harness: ModelUsage[];
  by_model: ModelUsage[];
  by_day: DayUsage[];
  top_tools: ToolUsage[];
  sessions: SessionUsage[];
  unpriced_models: string[];
  live: LiveAgent[];
  generated_at: number;
}

export function fetchPaneUsage(paneId: string): Promise<PaneUsage> {
  return invoke("pane_usage", { paneId });
}

/** Usage for every session ever recorded against a working directory, from
 *  any pane or window — not just the ones this app watched live. */
export function fetchFolderUsage(cwd: string): Promise<PaneUsage> {
  return invoke("folder_usage", { cwd });
}

export function pricingFilePath(): Promise<string> {
  return invoke("usage_pricing_path");
}

export function forgetPaneUsage(paneId: string): Promise<void> {
  return invoke("forget_pane_usage", { paneId });
}

export interface UsageWindow {
  used_percent: number;
  /** Epoch ms, or null if the harness didn't report one. */
  resets_at: number | null;
  window_minutes: number | null;
}

/** Rate-limit standing for one harness — not cost/tokens, but "how much of
 *  the account's usage window is left". Claude Code's `primary`/`secondary`
 *  are its 5-hour and 7-day windows; Codex's are whatever its own rollout
 *  reports (a short window and, when present, a longer one). */
export interface UsageLimit {
  harness: string;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  /** False when no usage data could be read at all (signed out, no sessions
   *  yet, endpoint unreachable) — `error` explains why. */
  available: boolean;
  error: string | null;
  fetched_at: number;
}

export function fetchClaudeUsageLimit(): Promise<UsageLimit> {
  return invoke("claude_usage_limit");
}

export function fetchCodexUsageLimit(): Promise<UsageLimit> {
  return invoke("codex_usage_limit");
}

/** pane id → harness id ("claude-code" | "codex" | …) for every pane with an
 *  agent process alive under its shell right now. Read from the process tree by
 *  the Rust poller, so it sees agents however they were started — including
 *  history recall, paste, shell autocompletion and wrapper scripts, none of
 *  which the typed-command sniffer can observe. */
export function fetchLivePaneHarnesses(): Promise<Record<string, string>> {
  return invoke("live_pane_harnesses");
}

function sumTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_write: a.cache_write + b.cache_write,
    cache_read: a.cache_read + b.cache_read,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
  };
}

const ZERO_TOKENS: Tokens = { input: 0, output: 0, cache_write: 0, cache_read: 0, reasoning: 0, total: 0 };

function mergeModelUsage(rows: ModelUsage[]): ModelUsage[] {
  const byKey = new Map<string, ModelUsage>();
  for (const r of rows) {
    const key = `${r.harness}\u0000${r.model}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.tokens = sumTokens(existing.tokens, r.tokens);
      existing.cost_usd += r.cost_usd;
      existing.messages += r.messages;
      existing.priced = existing.priced && r.priced;
    } else {
      byKey.set(key, { ...r, tokens: { ...r.tokens } });
    }
  }
  return [...byKey.values()].sort((a, b) => b.tokens.total - a.tokens.total);
}

function mergeDayUsage(rows: DayUsage[]): DayUsage[] {
  const byDay = new Map<string, DayUsage>();
  for (const r of rows) {
    const existing = byDay.get(r.day);
    if (existing) {
      existing.cost_usd += r.cost_usd;
      existing.tokens = sumTokens(existing.tokens, r.tokens);
      existing.messages += r.messages;
    } else {
      byDay.set(r.day, { ...r, tokens: { ...r.tokens } });
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function mergeToolUsage(rows: ToolUsage[]): ToolUsage[] {
  const byName = new Map<string, number>();
  for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? 0) + r.calls);
  return [...byName.entries()]
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8);
}

/** Combines per-pane usage into one view for every pane in a session, so the
 *  session-level "Stats" entry can show the same report the pane-level "i"
 *  button shows, just totalled across all its panes. */
export function mergePaneUsages(paneId: string, pages: PaneUsage[]): PaneUsage {
  if (pages.length === 1) return pages[0];

  const sessions = pages.flatMap((p) => p.sessions);
  const activities = pages.flatMap((p) => [p.first_activity, p.last_activity]).filter((n): n is number => n != null);
  const unpriced = new Set(pages.flatMap((p) => p.unpriced_models));

  return {
    pane_id: paneId,
    cost_usd: pages.reduce((a, p) => a + p.cost_usd, 0),
    cost_complete: pages.every((p) => p.cost_complete),
    tokens: pages.reduce((a, p) => sumTokens(a, p.tokens), ZERO_TOKENS),
    messages: pages.reduce((a, p) => a + p.messages, 0),
    tool_calls: pages.reduce((a, p) => a + p.tool_calls, 0),
    web_searches: pages.reduce((a, p) => a + p.web_searches, 0),
    session_count: pages.reduce((a, p) => a + p.session_count, 0),
    first_activity: activities.length ? Math.min(...activities) : null,
    last_activity: activities.length ? Math.max(...activities) : null,
    active_ms: pages.reduce((a, p) => a + p.active_ms, 0),
    by_harness: mergeModelUsage(pages.flatMap((p) => p.by_harness)),
    by_model: mergeModelUsage(pages.flatMap((p) => p.by_model)),
    by_day: mergeDayUsage(pages.flatMap((p) => p.by_day)),
    top_tools: mergeToolUsage(pages.flatMap((p) => p.top_tools)),
    sessions: sessions.sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0)),
    unpriced_models: [...unpriced],
    live: pages.flatMap((p) => p.live),
    generated_at: Math.max(...pages.map((p) => p.generated_at)),
  };
}

export const HARNESS_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
  gemini: "Gemini CLI",
};

export function harnessLabel(id: string): string {
  return HARNESS_LABELS[id] ?? id;
}

// ---- formatting ----

/** Costs span several orders of magnitude here — a long agent run is dollars,
 *  a one-shot question is a fraction of a cent — so the precision follows the
 *  value rather than truncating small amounts to a meaningless "$0.00". */
export function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function fmtWhen(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Trims a long absolute path to its last few segments for display. */
export function shortPath(p: string | null): string {
  if (!p) return "—";
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…${["", ...parts.slice(-2)].join("\\")}`;
}
