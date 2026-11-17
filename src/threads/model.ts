/** Threads mode data model.
 *
 *  A thread is one agent conversation, shown as a chat instead of a terminal.
 *  Every harness (Claude Code, Codex) is normalised into the same items, so
 *  the view never knows which one it is drawing. */

export type Harness = "claude" | "codex";

/** How much the agent may do without asking. Mapped per harness:
 *  Claude `default | acceptEdits | plan | bypassPermissions`, Codex
 *  approval policy + sandbox. */
export type PermissionMode = "ask" | "edits" | "plan" | "auto";

/** Where the agent runs. Only `local` exists today. */
export type ThreadLocation = { kind: "local" } | { kind: "cloud"; machineId: string; sessionId: string };

export interface ThreadStats {
  turns: number;
  tools: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  ms: number;
  files: number;
}

export interface ThreadMeta {
  id: string;
  title: string;
  /** The user named it; never auto-retitle. */
  titleLocked?: boolean;
  harness: Harness;
  cwd: string;
  /** Harness model alias/id; null = the CLI's own default. */
  model: string | null;
  /** Reasoning effort (low…max); null/absent = the model's default. */
  effort?: string | null;
  mode: PermissionMode;
  /** The harness's own conversation id (Claude session id, Codex thread id). */
  sessionId: string | null;
  /** The harness saved at least one turn, so `sessionId` can be resumed. */
  resumable: boolean;
  createdAt: number;
  updatedAt: number;
  /** A thread another agent started (future orchestration). */
  parentId?: string | null;
  pinned?: boolean;
  archived?: boolean;
  /** Finished while you were looking elsewhere. */
  unread?: boolean;
  lastOutcome?: "done" | "error" | "interrupted" | null;
  /** One line about what the agent is doing / did last, for the sidebar. */
  activity?: string;
  stats: ThreadStats;
  location: ThreadLocation;
}

export type ToolStatus = "streaming" | "running" | "waiting" | "done" | "error" | "denied" | "stopped";

export interface ItemBase {
  id: string;
  /** Tool-use id of the sub-agent call this belongs to; null = main agent. */
  parent: string | null;
  at: number;
}

export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
  images: string[]; // data URLs (thumbnails only, live session)
  /** Paths of attached files the agent reads with its own tools. */
  files?: string[];
  queued?: boolean;
}

export interface TextItem extends ItemBase {
  kind: "text";
  text: string;
  done: boolean;
}

export interface ThinkingItem extends ItemBase {
  kind: "thinking";
  text: string;
  done: boolean;
  endAt?: number;
}

export interface ToolItem extends ItemBase {
  kind: "tool";
  name: string;
  input: any;
  /** Raw JSON while the model is still writing the call. */
  partial?: string;
  status: ToolStatus;
  output?: string;
  /** Harness-specific structured result (Claude `tool_use_result`, Codex item). */
  result?: any;
  endAt?: number;
  /** Items of the sub-agent this call started. */
  children: string[];
}

export interface TurnItem extends ItemBase {
  kind: "turn";
  ms: number;
  tools: number;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  outcome: "done" | "error" | "interrupted";
  error?: string;
}

export interface NoticeItem extends ItemBase {
  kind: "notice";
  tone: "info" | "warn" | "error";
  text: string;
}

export type Item = UserItem | TextItem | ThinkingItem | ToolItem | TurnItem | NoticeItem;

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** Something the agent is blocked on until the user answers. */
export interface Approval {
  key: string;
  kind: "tool" | "question" | "plan";
  toolId: string | null;
  tool: string;
  input: any;
  description?: string;
  /** The harness offers "always allow" for the rest of the session. */
  canAlways: boolean;
  questions?: QuestionSpec[];
  at: number;
}

export type Decision =
  | { behavior: "allow"; always?: boolean; updatedInput?: any; nextMode?: PermissionMode }
  | { behavior: "deny"; message?: string };

export interface Todo {
  text: string;
  active?: string;
  status: "pending" | "in_progress" | "completed";
}

export interface RateWindow {
  label: string;
  used: number; // 0..1
  resetsAt: number | null; // ms
}

export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
}

export type RunState = "sleeping" | "starting" | "ready" | "running";

export function emptyStats(): ThreadStats {
  return { turns: 0, tools: 0, tokensIn: 0, tokensOut: 0, cost: 0, ms: 0, files: 0 };
}

export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "Ask first",
  edits: "Auto-edit",
  plan: "Plan",
  auto: "Full auto",
};

export const MODE_HINT: Record<PermissionMode, string> = {
  ask: "Asks before editing files or running commands",
  edits: "Edits files on its own, asks before commands",
  plan: "Reads and plans, changes nothing until you approve",
  auto: "Does everything without asking. Use in trusted folders",
};

export const HARNESS_LABEL: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };

export interface ModelChoice {
  id: string | null;
  label: string;
  hint?: string;
  /** Reasoning efforts this model accepts, lowest first; empty = none. */
  efforts?: string[];
  /** Descriptions per effort, when the harness gives them (Codex). */
  effortHints?: Record<string, string>;
  defaultEffort?: string;
  /** Full model id an alias currently points at. */
  resolved?: string;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Until Claude Code reports its own list (initialize), and as the fallback. */
export const CLAUDE_MODELS: ModelChoice[] = [
  { id: null, label: "Default", hint: "Your Claude Code default", efforts: CLAUDE_EFFORTS },
  { id: "opus", label: "Opus", hint: "For complex work and everyday tasks", efforts: CLAUDE_EFFORTS },
  { id: "fable", label: "Fable", hint: "For your toughest challenges", efforts: CLAUDE_EFFORTS },
  { id: "sonnet", label: "Sonnet", hint: "Most efficient for simpler tasks", efforts: CLAUDE_EFFORTS },
  { id: "haiku", label: "Haiku", hint: "Fastest for quick answers", efforts: CLAUDE_EFFORTS },
];

export const EFFORT_LABEL: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const EFFORT_HINT: Record<string, string> = {
  none: "No reasoning, answers straight away",
  minimal: "Barely thinks. Fastest",
  low: "Quick, light thinking",
  medium: "Balanced speed and depth",
  high: "Thinks harder on tricky problems",
  xhigh: "Deep thinking for hard tasks",
  max: "Thinks as long as it needs. Slowest",
};

const MODELS_KEY = "openterm.threads.models.";

/** Model lists the CLIs reported last time, so a thread that hasn't started
 *  a process yet can already offer every model. */
function cachedModels(h: Harness): ModelChoice[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(MODELS_KEY + h) ?? "null");
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}

function cacheModels(h: Harness, list: ModelChoice[]): void {
  try {
    localStorage.setItem(MODELS_KEY + h, JSON.stringify(list));
  } catch {
    /* convenience only */
  }
}

const lists: Record<Harness, ModelChoice[]> = {
  claude: cachedModels("claude") ?? CLAUDE_MODELS,
  codex: cachedModels("codex") ?? [{ id: null, label: "Default", hint: "Your Codex default" }],
};

export function modelList(h: Harness): ModelChoice[] {
  return lists[h];
}

export function setModelList(h: Harness, list: ModelChoice[]): void {
  if (!list.length) return;
  lists[h] = list;
  cacheModels(h, list);
}

/** What a new thread starts on: Opus for Claude Code (the alias always
 *  points at the newest Opus), the CLI's own default for Codex. */
export function defaultModel(h: Harness): string | null {
  return h === "claude" ? "opus" : null;
}

/** The model a thread is set to (or the default entry). */
export function modelChoice(h: Harness, id: string | null): ModelChoice | undefined {
  return lists[h].find((m) => m.id === id) ?? (id ? undefined : lists[h][0]);
}

export function uid(prefix = "th"): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}
