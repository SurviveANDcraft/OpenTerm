import { InboxKind } from "./inbox";

export type Dir = "row" | "col";

export type SplitNode = {
  type: "split";
  dir: Dir;
  children: PaneNode[];
  sizes: number[]; // fractions, sum to 1
};

export type LeafNode = {
  type: "leaf";
  id: string;
  /** What this pane hosts: a PTY terminal (default) or an embedded browser. */
  kind?: PaneKind;
  /** Last AI agent CLI command line typed in this pane, replayed on relaunch. */
  lastCommand?: string;
  /** Folder the pane's shell was last in (reported by the shell's prompt via
   *  OSC 9;9 / OSC 7). Restored panes start here instead of the session's
   *  folder, so `cd`-ing around a pane survives an app restart. */
  cwd?: string;
  /** Collapsed to just its title bar, giving its space to its siblings. The
   *  pane keeps running — folding is purely a layout state. */
  folded?: boolean;
  /** File panes only: absolute path of the docked file, restored on restart. */
  filePath?: string;
  /** File panes only: display name shown in the pane bar. */
  fileName?: string;
  /** Browser panes only: the URL to restore on app restart. */
  url?: string;
  /** Browser panes only: last page title, so the bar looks right pre-load. */
  pageTitle?: string;
  /** Browser panes only: emulated device preset id ("iphone-16", …). */
  device?: string;
  /** Browser panes only: whether the emulated device is rotated. */
  landscape?: boolean;
  /** True when this leaf hosts an embedded *external* OS terminal window
   *  (dragged in from outside the app) instead of an in-app PowerShell PTY.
   *  External leaves are ephemeral — the reparented HWND can't survive a
   *  restart, so they're pruned when state is loaded. */
  external?: boolean;
  /** Title of the embedded external window, shown in the pane bar. */
  externalTitle?: string;
  /** User-set pane name, shown in the bar instead of the shell-reported title.
   *  With several agents running across many panes, the shell title ("PowerShell",
   *  "node") doesn't distinguish them — a custom name (e.g. "api", "worker") does. */
  customName?: string;
};

export type PaneKind = "term" | "browser" | "file";

/** The sidebar's "+" menu — quick ways to fill a new pane. Agent entries are
 *  plain terminals whose launch command is remembered (and auto-typed), so
 *  they get the full terminal feature set for free. */
export const PANE_KINDS: {
  id: string;
  label: string;
  kind: PaneKind;
  command?: string;
  hint: string;
}[] = [
  { id: "shell", label: "PowerShell", kind: "term", hint: "A plain terminal" },
  { id: "claude", label: "Claude Code", kind: "term", command: "claude", hint: "Launches claude" },
  { id: "codex", label: "Codex CLI", kind: "term", command: "codex", hint: "Launches codex" },
  { id: "opencode", label: "OpenCode", kind: "term", command: "opencode", hint: "Launches opencode" },
  { id: "gemini", label: "Gemini CLI", kind: "term", command: "gemini", hint: "Launches gemini" },
  { id: "cursor-agent", label: "Cursor Agent", kind: "term", command: "cursor-agent", hint: "Launches cursor-agent" },
  { id: "grok", label: "Grok Build", kind: "term", command: "grok", hint: "Launches Grok Build" },
  { id: "browser", label: "Browser", kind: "browser", hint: "Embedded web browser with console & network capture" },
];

/** Binaries recognized as AI agent CLIs — a matching typed command is remembered
 *  per-pane and replayed when the app restarts, so the agent session resumes. */
export const KNOWN_AGENT_COMMANDS = [
  "claude",
  "opencode",
  "aider",
  "codex",
  "gemini",
  "cursor-agent",
  "amp",
  "goose",
  "grok",
  "crush",
  "cline",
];

const PACKAGE_RUNNERS = ["npx", "npm", "pnpm", "yarn", "bunx", "uvx", "pipx"];

/** Flags that make these CLIs resume their most recent conversation instead of
 *  starting a new one. Only tools we've verified actually behave this way are
 *  listed — everything else in KNOWN_AGENT_COMMANDS just gets replayed as-typed. */
export const AGENT_RESUME_FLAGS: Record<string, string[]> = {
  claude: ["--continue"],
  opencode: ["--continue"],
};

/** Flags already present in a typed line that indicate the user asked for a
 *  specific/resumed session themselves — don't also append --continue then. */
const RESUME_FLAG_ALIASES: Record<string, string[]> = {
  claude: ["--continue", "-c", "--resume", "-r"],
  opencode: ["--continue", "-c", "--session", "-s"],
};

/** Subset of the aliases above that take a following value (e.g. `--resume <id>`),
 *  so that value has to be dropped too when stripping resume flags. */
const RESUME_VALUE_FLAGS: Record<string, string[]> = {
  claude: ["--resume", "-r"],
  opencode: ["--session", "-s"],
  codex: ["resume"],
};

/** Agent CLI → the harness id the usage poller records sessions under, for the
 *  agents whose exact conversation we can look up and resume by id. */
export const AGENT_HARNESS: Record<string, string> = {
  claude: "claude-code",
  opencode: "opencode",
  codex: "codex",
};

/** How each agent takes a specific session id: a flag, or a subcommand that has
 *  to sit right after the binary (`codex resume <id>`). */
const SESSION_RESUME_SYNTAX: Record<string, { flag?: string; subcommand?: string }> = {
  claude: { flag: "--resume" },
  opencode: { flag: "--session" },
  codex: { subcommand: "resume" },
};

/** Rebuilds a remembered launch line so it reopens one *specific* conversation
 *  instead of whatever `--continue` happens to pick. Returns null when the agent
 *  has no id-based resume syntax, so the caller can fall back. */
export function buildSessionResumeCommand(
  line: string,
  agent: string,
  sessionId: string
): string | null {
  const syn = SESSION_RESUME_SYNTAX[agent];
  if (!syn || !/^[\w.@:/-]+$/.test(sessionId)) return null;
  const base = stripResumeCommand(line, agent).trim();
  if (!base) return null;
  if (syn.flag) return `${base} ${syn.flag} ${sessionId}`;
  const tokens = base.split(/\s+/);
  return [tokens[0], syn.subcommand!, sessionId, ...tokens.slice(1)].join(" ");
}

const baseName = (tok: string): string =>
  tok
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/, "")
    .replace(/^@[^/]+\//, "")
    .replace(/@[^@/]+$/, "");

// Matches "claude", but also npm-package-style names like "claude-code" or
// "opencode-ai" (each hyphen-segment checked against the known list).
function agentForToken(tok: string): string | null {
  const base = baseName(tok);
  if (KNOWN_AGENT_COMMANDS.includes(base)) return base;
  const seg = base.split("-").find((s) => KNOWN_AGENT_COMMANDS.includes(s));
  return seg ?? null;
}

/** If this typed line launches a known AI agent CLI, returns which one. */
export function detectAgentCommand(line: string): string | null {
  const tokens = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let start = 0;
  // Skip leading `FOO=bar` env assignments.
  while (start < tokens.length && /^[a-z_][a-z0-9_]*=/.test(tokens[start])) start++;
  if (start >= tokens.length) return null;

  const direct = agentForToken(tokens[start]);
  if (direct) return direct;

  if (PACKAGE_RUNNERS.includes(baseName(tokens[start]))) {
    for (const t of tokens.slice(start + 1)) {
      const agent = agentForToken(t);
      if (agent) return agent;
    }
  }
  return null;
}

/** Appends the agent's resume flag to a typed line, unless the user already
 *  included a resume/session flag of their own. */
export function buildResumeCommand(line: string, agent: string): string {
  const trimmed = line.trim();
  const flags = AGENT_RESUME_FLAGS[agent];
  if (!flags) return trimmed;
  const aliases = RESUME_FLAG_ALIASES[agent] ?? [];
  const tokens = trimmed.toLowerCase().split(/\s+/);
  if (tokens.some((t) => aliases.includes(t))) return trimmed;
  return `${trimmed} ${flags.join(" ")}`;
}

/** Removes any resume/session flags from a typed line so the agent launches a
 *  brand-new conversation instead of resuming the previous one. */
export function stripResumeCommand(line: string, agent: string): string {
  const aliases = RESUME_FLAG_ALIASES[agent] ?? [];
  const valueFlags = RESUME_VALUE_FLAGS[agent] ?? [];
  const tokens = line.trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const low = tokens[i].toLowerCase();
    if (valueFlags.includes(low)) {
      i++; // also drop the flag's value (e.g. the session id after --resume)
      continue;
    }
    if (aliases.includes(low)) continue;
    out.push(tokens[i]);
  }
  return out.join(" ");
}

/** Turns a remembered command into the one to actually replay on relaunch:
 *  resume the previous conversation, or start a fresh one, per the user's
 *  "Resume agent sessions" setting. Non-agent commands are returned unchanged. */
export function applyResumePreference(line: string, resume: boolean): string {
  const agent = detectAgentCommand(line);
  if (!agent) return line.trim();
  return resume ? buildResumeCommand(line, agent) : stripResumeCommand(line, agent);
}

export type PaneNode = LeafNode | SplitNode;

/** A task's stage, by `TaskStage.id`. Free-form since stages are user-defined
 *  per session; "todo" / "doing" / "done" are just the ids of the defaults. */
export type TaskStatus = string;
export type TaskPriority = "low" | "medium" | "high";

export interface SubTask {
  id: string;
  title: string;
  done: boolean;
}

/** Agent CLIs a task can be delegated to — each is launched as a plain terminal
 *  whose command is the agent id itself, reusing the normal pane machinery. */
export type DelegationAgent = "claude" | "codex" | "opencode";

export const DELEGATION_AGENTS: { id: DelegationAgent; label: string; command: string }[] = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex CLI", command: "codex" },
  { id: "opencode", label: "OpenCode", command: "opencode" },
];

/** When a delegation kicks off: immediately, at a wall-clock time, or once
 *  another terminal's output goes quiet ("finished"). */
export type DelegationTrigger =
  | { type: "now" }
  | { type: "at"; time: number } // epoch ms
  | { type: "pane-finish"; sessionId: string; paneId: string; label: string };

export type DelegationStatus =
  | "scheduled"
  | "waiting"
  | "running"
  | "done"
  | "cancelled"
  | "failed";

export interface TaskDelegation {
  id: string;
  agent: DelegationAgent;
  trigger: DelegationTrigger;
  status: DelegationStatus;
  createdAt: number;
  startedAt?: number;
  /** Pane created to run the agent, once started. */
  targetPaneId?: string;
}

export function delegationActive(d: TaskDelegation): boolean {
  return d.status === "scheduled" || d.status === "waiting" || d.status === "running";
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Absolute local paths attached to this task. */
  files: string[];
  subtasks: SubTask[];
  tags: string[];
  /** ISO date string (yyyy-mm-dd), or null if unset. */
  dueDate: string | null;
  createdAt: number;
  updatedAt: number;
  /** One active hand-off to an AI agent at a time — creating a new one while
   *  one is pending cancels/replaces the old. */
  delegation?: TaskDelegation;
}

/** A column on the task board. Stages are per-session and fully user-editable:
 *  the three defaults below are only what a session starts with. */
export interface TaskStage {
  id: string;
  label: string;
  /** Dot colour. Null/absent means "no colour of its own" and renders in the
   *  muted text colour, which is what the default "To do" stage wants. */
  color?: string | null;
  /** Tasks parked here count as finished: struck through in the list, left out
   *  of the open-task counts and of due-date reminders. At most one stage in a
   *  session carries this. */
  done?: boolean;
}

export const DEFAULT_STAGES: TaskStage[] = [
  { id: "todo", label: "To do", color: null },
  { id: "doing", label: "In progress", color: "#6ea8d8" },
  { id: "done", label: "Done", color: "#71b978", done: true },
];

/** Palette offered when creating or recolouring a stage — the app's semantic
 *  hues plus a neutral, so a board stays legible in every theme. */
export const STAGE_COLORS: string[] = [
  "#6ea8d8",
  "#71b978",
  "#e8b45a",
  "#e06c75",
  "#c78fd6",
  "#5fbfae",
  "#d97b66",
  "#8b93a5",
];

/** A session's stages, filling in the defaults for sessions saved before stages
 *  existed (and for anyone who manages to delete the last one). */
export function sessionStages(session: Session): TaskStage[] {
  if (!session.stages || session.stages.length === 0) {
    session.stages = structuredClone(DEFAULT_STAGES);
  }
  return session.stages;
}

/** The stage a task sits in. Falls back to the first stage so a task whose
 *  stage was deleted out from under it can never vanish from the board. */
export function stageOf(session: Session, status: TaskStatus): TaskStage {
  const stages = sessionStages(session);
  return stages.find((s) => s.id === status) ?? stages[0];
}

export function isTaskDone(session: Session, task: Task): boolean {
  return stageOf(session, task.status).done === true;
}

/** Tasks not parked in a "done" stage — the number every badge outside the
 *  panel shows. */
export function openTaskCount(session: Session): number {
  return sessionTasks(session).filter((t) => !isTaskDone(session, t)).length;
}

export const TASK_PRIORITIES: { id: TaskPriority; label: string; color: string }[] = [
  { id: "low", label: "Low", color: "#6ea8d8" },
  { id: "medium", label: "Medium", color: "#e8b45a" },
  { id: "high", label: "High", color: "#e06c75" },
];

export function newTask(title = ""): Task {
  const now = Date.now();
  return {
    id: uid(),
    title,
    description: "",
    status: "todo",
    priority: "medium",
    files: [],
    subtasks: [],
    tags: [],
    dueDate: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Tasks are per-session but older saved sessions predate the feature, so the
 *  array may be missing on load — this is the single place that fills it in. */
export function sessionTasks(session: Session): Task[] {
  if (!session.tasks) session.tasks = [];
  return session.tasks;
}

export interface Session {
  id: string;
  name: string;
  color: string;
  tree: PaneNode;
  zoomed: string | null;
  /** Working directory new terminals in this session start in. */
  cwd?: string | null;
  /** Command auto-run when the session was created (kept as metadata). */
  command?: string | null;
  /** This session's todo list — scoped per-session, never shared. */
  tasks?: Task[];
  /** This session's board columns. Absent on sessions saved before stages were
   *  editable; `sessionStages()` fills in the defaults. */
  stages?: TaskStage[];
  /** Which view the task panel last showed for this session. */
  taskView?: "list" | "kanban";
  /** Hidden from the sidebar with its terminals stopped; layout, tasks and
   *  remembered agent commands are kept so it can be restored from Settings. */
  archived?: boolean;
  /** Epoch ms of when it was archived, shown in Settings → Archived sessions. */
  archivedAt?: number;
}

export const ACTIONS = {
  newSession: "New session",
  closeSession: "Close session",
  renameSession: "Rename session",
  nextSession: "Next session",
  prevSession: "Previous session",
  newTerminal: "New terminal (in session)",
  splitRight: "Split right",
  splitDown: "Split down",
  closePane: "Close pane",
  focusLeft: "Focus pane left",
  focusRight: "Focus pane right",
  focusUp: "Focus pane up",
  focusDown: "Focus pane down",
  resizeLeft: "Shrink pane width",
  resizeRight: "Grow pane width",
  resizeUp: "Shrink pane height",
  resizeDown: "Grow pane height",
  zoomPane: "Expand pane (toggle)",
  foldPane: "Fold pane (toggle)",
  toggleSidebar: "Toggle sidebar",
  toggleSidebarView: "Switch sidebar: Sessions ⇄ Files",
  fontInc: "Font size +",
  fontDec: "Font size −",
  fontReset: "Font size reset",
  search: "Find in terminal",
  highlightSearch: "Highlight search",
  queueCommand: "Queue command (run after current finishes)",
  cheatSheet: "Shortcut cheat sheet",
  openSettings: "Open settings",
  openTasks: "Open tasks",
  openInbox: "Open inbox",
  restoreLast: "Undo last close (session, pane or task)",
} as const;

export type Action = keyof typeof ACTIONS;

export const DEFAULT_KEYBINDS: Record<Action, string> = {
  newSession: "Ctrl+Shift+T",
  closeSession: "Ctrl+Shift+Q",
  renameSession: "F2",
  nextSession: "Ctrl+Tab",
  prevSession: "Ctrl+Shift+Tab",
  newTerminal: "Ctrl+T",
  splitRight: "Ctrl+Shift+E",
  splitDown: "Ctrl+Shift+O",
  closePane: "Ctrl+Shift+W",
  focusLeft: "Ctrl+ArrowLeft",
  focusRight: "Ctrl+ArrowRight",
  focusUp: "Ctrl+ArrowUp",
  focusDown: "Ctrl+ArrowDown",
  resizeLeft: "Ctrl+Alt+ArrowLeft",
  resizeRight: "Ctrl+Alt+ArrowRight",
  resizeUp: "Ctrl+Alt+ArrowUp",
  resizeDown: "Ctrl+Alt+ArrowDown",
  zoomPane: "Ctrl+Shift+Z",
  foldPane: "Ctrl+Shift+D",
  toggleSidebar: "Ctrl+B",
  toggleSidebarView: "Alt+`",
  fontInc: "Ctrl+=",
  fontDec: "Ctrl+-",
  fontReset: "Ctrl+0",
  search: "Ctrl+Shift+F",
  highlightSearch: "Ctrl+S",
  queueCommand: "Ctrl+Shift+Enter",
  cheatSheet: "Ctrl+/",
  openSettings: "Ctrl+,",
  openTasks: "Ctrl+Shift+K",
  openInbox: "Ctrl+Shift+I",
  restoreLast: "Ctrl+Shift+U",
};

export type DictationPosition =
  | "bottom-center"
  | "bottom-left"
  | "bottom-right"
  | "top-center"
  | "top-left"
  | "top-right";

/** Push-to-talk dictation, run by the background dictation agent. Saved into
 *  `dictation/config.json` for the agent on every settings save. */
export interface DictationSettings {
  enabled: boolean;
  /** "Ctrl+Win", "Ctrl+Shift+Space", "F13"... */
  shortcut: string;
  mode: "hold" | "toggle";
  style: "pill" | "glow";
  position: DictationPosition;
  startSound: boolean;
  /** Input device name; null follows the Windows default. */
  micDeviceId: string | null;
  /** Language code; null lets MAI detect it. */
  language: string | null;
  transcribeStyle: "clean" | "verbatim";
  aiPolish: boolean;
  vocabulary: string[];
  maxSeconds: number;
  availability: "always" | "whileOpen";
  /** Deliver the transcript to the window and pane that were focused when the
   *  key went down — switching back to them if focus has moved — instead of
   *  typing wherever focus happens to be when it comes back. */
  lockTarget: boolean;
}

export const DEFAULT_VOCABULARY = [
  "OpenTerm", "OpenRouter", "Claude", "Claude Code", "Codex", "opencode", "DeepSeek", "GitHub", "Git",
  "npm", "pnpm", "Node.js", "TypeScript", "JavaScript", "React", "Vite", "Tauri", "Rust", "Cargo",
  "PowerShell", "WSL", "VS Code", "API", "JSON", "YAML", "CLI", "README", "localhost", "SQL", "Docker",
  "Kubernetes", "Python", "pull request", "repo", "commit",
];

export const DEFAULT_DICTATION: DictationSettings = {
  // Off until the user opts in: this arms a system-wide keyboard hook and the
  // microphone, so it must never start without an explicit choice. Existing
  // users keep their stored value — store.ts merges saved settings over these.
  enabled: false,
  shortcut: "Ctrl+Win",
  mode: "hold",
  style: "pill",
  position: "bottom-center",
  startSound: true,
  micDeviceId: null,
  language: null,
  transcribeStyle: "clean",
  aiPolish: false,
  vocabulary: [...DEFAULT_VOCABULARY],
  maxSeconds: 300,
  availability: "always",
  lockTarget: true,
};

export interface Settings {
  /** Theme id — see themes.ts for the full palette list. */
  theme: string;
  fontSize: number;
  /** Text size of the file editor (code surface, Markdown preview and WYSIWYG).
   *  Kept apart from the terminal's `fontSize` so Ctrl+± zooms whichever
   *  surface you're actually reading. */
  editorFontSize: number;
  fontFamily: string;
  shell: string;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  /** Allow terminal windows opened outside OpenTerm to be dragged into a pane. */
  externalTerminalDrag: boolean;
  padding: number;
  sidebarVisible: boolean;
  sidebarWidth: number;
  soundNotifications: boolean;
  /** Path to a custom sound file to play instead of the built-in chime.
   *  `null` means use the default OpenTerm chime. */
  soundPath: string | null;
  /** When an app restart replays a remembered agent CLI (e.g. `claude`), resume
   *  its previous conversation (append `--continue`) instead of starting fresh. */
  resumeAgentSessions: boolean;
  /** Register the Windows shell hooks that let any folder be handed to OpenTerm —
   *  typing `OpenTerm` in Explorer's address bar, or the folder context menu. */
  shellIntegration: boolean;
  /** OpenRouter API key, used to have an AI clarify a task's prompt before it's
   *  delegated to an agent CLI. Empty = delegate the raw task text as-is. */
  openrouterApiKey: string;
  /** Have an AI give raw inbox notifications (terminal prompts, error lines) a
   *  readable name and one-line description. Needs `openrouterApiKey`; with no
   *  key set the raw text is shown as-is regardless of this setting. */
  aiInboxSummaries: boolean;
  /** Flash the taskbar icon when a pane needs attention (approval prompt or
   *  error), in addition to the sound and inbox item. */
  taskbarFlash: boolean;
  /** Per-kind opt-out for inbox items — false suppresses that kind entirely
   *  (no item added, no sound, no taskbar flash for it). Missing keys default
   *  to enabled, so new kinds show up without a migration. */
  inboxNotifications: Partial<Record<InboxKind, boolean>>;
  keybinds: Record<Action, string>;
  dictation: DictationSettings;
  /** When the first-run welcome was last seen (epoch ms), or null if never.
   *  Stamped on finish *and* on skip, so the flow can't reappear uninvited.
   *  Settings → About & Data can clear it by replaying the welcome. */
  onboardedAt: number | null;
}

export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 420;

export const DEFAULT_SETTINGS: Settings = {
  theme: "openterm",
  fontSize: 14,
  editorFontSize: 13,
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  shell: "powershell.exe",
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 8000,
  externalTerminalDrag: true,
  padding: 8,
  sidebarVisible: true,
  sidebarWidth: 224,
  soundNotifications: true,
  soundPath: null,
  resumeAgentSessions: true,
  shellIntegration: true,
  openrouterApiKey: "",
  // Off by default: this sends raw terminal output (which can carry tokens,
  // paths and command output) to OpenRouter, so it needs an explicit opt-in
  // rather than riding along with the API key being set for delegation.
  aiInboxSummaries: false,
  taskbarFlash: true,
  inboxNotifications: {},
  keybinds: { ...DEFAULT_KEYBINDS },
  dictation: structuredClone(DEFAULT_DICTATION),
  onboardedAt: null,
};

export interface AppState {
  sessions: Session[];
  activeSessionId: string | null;
  settings: Settings;
}

export const SESSION_COLORS = [
  "#e8b45a",
  "#7fb069",
  "#6ea8d8",
  "#c78fd6",
  "#d97b66",
  "#5fbfae",
  "#d6c35f",
  "#8b93a5",
];

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
