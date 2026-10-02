/** The Agents assistant's app-level tools: tasks, sessions, panels, usage
 *  statistics and a safe subset of settings.
 *
 *  Same shape as agentsActions.ts: reads run directly, changes are planned
 *  first and run from `execute()`. Each tool belongs to a permission the user
 *  can switch off in Settings, AI.
 *
 *  Two rules live here in code rather than in the prompt: a setting change
 *  always waits for approval (in every mode), and only the settings listed in
 *  SETTINGS can be read or changed at all. API keys, the assistant's own
 *  configuration, the shell program, dictation and keybinds are out of reach. */

import { store } from "./store";
import { listAgents, paneOfRef, visibleSessions, type ToolRun } from "./agentsData";
import type { ActionContext, ActionPlan, ActionResult, Planned } from "./agentsActions";
import { commandRisks } from "./actionRisk";
import { THEMES } from "./themes";
import { fetchPaneUsage, fmtCost, fmtDuration, fmtTokens } from "./usage";
import {
  isTaskDone,
  newTask,
  openTaskCount,
  sessionStages,
  sessionTasks,
  stageOf,
  uid,
  type AssistantPerm,
  type Session,
  type Task,
  type TaskPriority,
  type TaskStage,
} from "./types";

export type UiPanel = "sidebar" | "tasks" | "inbox" | "settings";

/** App operations that belong to main.ts. */
export interface AppHost {
  /** Creates and shows a session; returns its id. */
  createSession(opts: { name: string; cwd: string | null; command: string | null; count: number }): string | null;
  showSession(sessionId: string): void;
  /** A session's name, colour or folder was edited in place. */
  sessionsChanged(): void;
  /** A session's tasks were edited in place. */
  tasksChanged(): void;
  /** store.state.settings was edited in place: apply and save it. */
  applySettings(): void;
  panelOpen(panel: UiPanel): boolean;
  togglePanel(panel: UiPanel): void;
}

// ---------------------------------------------------------------- schemas

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const session = { type: "string", description: "Session name. Default: the one in scope." };
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const taskFields = {
  description: { type: "string" },
  priority: { type: "string", enum: ["low", "medium", "high"] },
  stage: { type: "string", description: "Stage (board column) name" },
  due: { type: "string", description: "yyyy-mm-dd, or empty for none" },
  tags: strings("Replaces the task's tags"),
};

interface AppTool {
  def: ReturnType<typeof tool>;
  perm: AssistantPerm;
  /** Read tools are offered in every mode; the rest only in Act and Auto. */
  read: boolean;
}

const APP_TOOLS: AppTool[] = [
  { perm: "sessions", read: true, def: tool("list_sessions", "List sessions: folder, terminals, open tasks.", {}, []) },
  {
    perm: "tasks",
    read: true,
    def: tool("list_tasks", "List a session's tasks with ids, stage, priority, due date and subtasks.", {
      session,
      include_done: { type: "boolean" },
    }, []),
  },
  {
    perm: "usage",
    read: true,
    def: tool("usage_stats", "Agent usage and cost (tokens, messages, active time, models) for one terminal, one session, or everything in scope.", {
      ref: { type: "string", description: "Terminal ref, e.g. T3" },
      session: { type: "string", description: "Session name" },
    }, []),
  },
  {
    perm: "settings",
    read: true,
    def: tool("get_settings", "List the app settings you may change, with current values and allowed values.", {}, []),
  },
  {
    perm: "tasks",
    read: false,
    def: tool("create_task", "Create a task in a session's Tasks panel.", {
      session,
      title: { type: "string" },
      ...taskFields,
      subtasks: strings("Subtask titles"),
    }, ["title"]),
  },
  {
    perm: "tasks",
    read: false,
    def: tool("update_task", "Edit a task. Only the fields you pass change.", {
      session,
      task: { type: "string", description: "Task id or title" },
      title: { type: "string" },
      ...taskFields,
      add_subtasks: strings("Subtask titles to add"),
      complete_subtasks: strings("Titles of subtasks to mark done"),
    }, ["task"]),
  },
  {
    perm: "sessions",
    read: false,
    def: tool("create_session", "Create a new session and switch to it.", {
      name: { type: "string" },
      folder: { type: "string", description: "Absolute path its terminals start in" },
      terminals: { type: "integer", description: "1-6. Default 1." },
      command: { type: "string", description: "Typed into every terminal at start, e.g. claude. One line." },
    }, ["name"]),
  },
  {
    perm: "sessions",
    read: false,
    def: tool("update_session", "Rename a session, recolour it or change its folder.", {
      session: { type: "string", description: "Session name" },
      name: { type: "string" },
      color: { type: "string", description: "#rrggbb" },
      folder: { type: "string" },
    }, ["session"]),
  },
  { perm: "ui", read: false, def: tool("switch_session", "Show a session.", { session: { type: "string" } }, ["session"]) },
  {
    perm: "ui",
    read: false,
    def: tool("toggle_panel", "Show or hide part of the app: the left sidebar, the Tasks panel, the inbox or the Settings page.", {
      panel: { type: "string", enum: ["sidebar", "tasks", "inbox", "settings"] },
      on: { type: "boolean", description: "true shows, false hides. Default: flip." },
    }, ["panel"]),
  },
  {
    perm: "settings",
    read: false,
    def: tool("set_setting", "Change one app setting. The user approves every change. Keys come from get_settings.", {
      key: { type: "string" },
      value: { type: "string" },
    }, ["key", "value"]),
  },
];

const BY_NAME = new Map(APP_TOOLS.map((t) => [t.def.function.name, t]));

/** Schemas to send: reads always, changes when the mode acts, and only for
 *  permissions the user left on. */
export function appToolDefs(actions: boolean, can: (perm: AssistantPerm) => boolean): unknown[] {
  return APP_TOOLS.filter((t) => (t.read || actions) && can(t.perm)).map((t) => t.def);
}

export function isAppRead(name: string): boolean {
  return BY_NAME.get(name)?.read === true;
}

export function isAppAction(name: string): boolean {
  return BY_NAME.get(name)?.read === false;
}

// ---------------------------------------------------------------- settings

interface SettingSpec {
  label: string;
  /** Allowed values, in words, for get_settings. */
  hint: string;
  /** The value to store, or undefined when it isn't allowed. */
  parse(v: string): unknown;
}

const int = (label: string, min: number, max: number): SettingSpec => ({
  label,
  hint: `integer ${min}-${max}`,
  parse: (v) => {
    const n = Number(v);
    return v.trim() && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  },
});
const bool = (label: string): SettingSpec => ({
  label,
  hint: "true or false",
  parse: (v) => (/^(true|on|yes)$/i.test(v.trim()) ? true : /^(false|off|no)$/i.test(v.trim()) ? false : undefined),
});
const oneOf = (label: string, options: string[]): SettingSpec => ({
  label,
  hint: options.join(", "),
  parse: (v) => options.find((o) => o.toLowerCase() === v.trim().toLowerCase()),
});

/** Every setting the assistant may read or change. Anything not listed here
 *  is out of its reach, whatever the model asks for. */
const SETTINGS: Record<string, SettingSpec> = {
  theme: oneOf("Theme", THEMES.map((t) => t.id)),
  fontSize: int("Terminal font size", 8, 32),
  editorFontSize: int("Editor font size", 8, 32),
  fontFamily: {
    label: "Terminal font",
    hint: "CSS font-family list",
    parse: (v) => (v.trim() && v.length <= 120 && !/[;{}<>]/.test(v) ? v.trim() : undefined),
  },
  cursorStyle: oneOf("Cursor style", ["bar", "block", "underline"]),
  cursorBlink: bool("Cursor blink"),
  scrollback: int("Scrollback lines", 500, 100000),
  padding: int("Pane padding", 0, 32),
  soundNotifications: bool("Attention sound"),
  taskbarFlash: bool("Flash taskbar icon"),
  resumeAgentSessions: bool("Resume agent sessions on restart"),
  externalTerminalDrag: bool("Drag external terminals in"),
};

const PROTECTED_NOTE =
  "Protected, only the user can change these in Settings: API keys, the assistant's modes, model and permissions, AI summaries, the shell program, shell integration, dictation, keybinds.";

// ---------------------------------------------------------------- helpers

function refuse(result: string, label: string): Planned {
  return { refused: { result: `Error: ${result}`, label, paneIds: [] } };
}

function done(result: string, label: string): ActionResult {
  return { ok: true, result, label, paneIds: [] };
}

function failed(result: string, label: string): ActionResult {
  return { ok: false, result: `Error: ${result}`, label, paneIds: [] };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function list(v: unknown): string[] | null {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : null;
}

function findSession(arg: unknown, ctx: ActionContext): Session | null {
  const want = str(arg).toLowerCase();
  const all = visibleSessions();
  return (want ? all.find((s) => s.name.toLowerCase() === want || s.id === want) : all.find((s) => s.id === ctx.defaultSessionId)) ?? null;
}

function findTask(s: Session, arg: unknown): Task | null {
  const want = str(arg).toLowerCase();
  if (!want) return null;
  const tasks = sessionTasks(s);
  const exact = tasks.find((t) => t.id === want || t.title.toLowerCase() === want);
  if (exact) return exact;
  const partial = tasks.filter((t) => t.title.toLowerCase().includes(want));
  return partial.length === 1 ? partial[0] : null;
}

function findStage(s: Session, arg: string): TaskStage | null {
  const want = arg.toLowerCase();
  return sessionStages(s).find((x) => x.id === want || x.label.toLowerCase() === want) ?? null;
}

const PRIORITIES: TaskPriority[] = ["low", "medium", "high"];
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;

/** The task fields create_task and update_task share, as edits to apply.
 *  Returns an error string when a value isn't valid. */
function taskEdits(s: Session, args: Record<string, unknown>): { edits: [string, (t: Task) => void][] } | string {
  const edits: [string, (t: Task) => void][] = [];
  if (typeof args.description === "string") {
    const d = args.description.trim().slice(0, MAX_DESCRIPTION);
    edits.push(["description", (t) => (t.description = d)]);
  }
  if (args.priority !== undefined) {
    const p = PRIORITIES.find((x) => x === str(args.priority).toLowerCase());
    if (!p) return "priority must be low, medium or high.";
    edits.push([`${p} priority`, (t) => (t.priority = p)]);
  }
  if (args.stage !== undefined) {
    const st = findStage(s, str(args.stage));
    if (!st) return `no stage "${str(args.stage)}". Stages: ${sessionStages(s).map((x) => x.label).join(", ")}.`;
    edits.push([`stage ${st.label}`, (t) => (t.status = st.id)]);
  }
  if (args.due !== undefined) {
    const due = str(args.due);
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return "due must be yyyy-mm-dd.";
    edits.push([due ? `due ${due}` : "no due date", (t) => (t.dueDate = due || null)]);
  }
  const tags = list(args.tags);
  if (tags) edits.push([tags.length ? `tags ${tags.join(", ")}` : "no tags", (t) => (t.tags = tags)]);
  return { edits };
}

function plan(p: Omit<ActionPlan, "text" | "risks" | "paneIds"> & Partial<ActionPlan>): Planned {
  return { plan: { text: null, risks: [], paneIds: [], ...p } };
}

// ---------------------------------------------------------------- planning

/** Checks one app action and describes it, without running anything. */
export function planAppAction(name: string, argsJson: string, ctx: ActionContext): Planned {
  let args: Record<string, unknown>;
  try {
    args = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return refuse("arguments were not valid JSON.", `${name} (bad arguments)`);
  }
  const app = ctx.host.app;
  const noSession = (label: string): Planned =>
    refuse(str(args.session) ? `no session named "${str(args.session)}". Use list_sessions.` : "no session in scope; name one.", label);

  switch (name) {
    case "create_task": {
      const s = findSession(args.session, ctx);
      if (!s) return noSession("Create task");
      if (!ctx.sessionInScope(s.id)) return refuse("that session is outside the current scope.", "Create task");
      const title = str(args.title).slice(0, MAX_TITLE);
      if (!title) return refuse("title is empty.", "Create task");
      const fields = taskEdits(s, args);
      if (typeof fields === "string") return refuse(fields, "Create task");
      const subtasks = list(args.subtasks) ?? [];
      const notes = fields.edits.map(([what]) => what).filter((w) => w !== "description");
      if (subtasks.length) notes.push(`${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"}`);
      return plan({
        tool: name,
        tier: "tasks",
        verb: "Create task",
        target: s.name,
        detail: `“${title}”${notes.length ? `: ${notes.join(", ")}` : ""}`,
        deniedLabel: `Denied: create task “${title}”`,
        async execute() {
          const t = newTask(title);
          t.status = sessionStages(s)[0].id;
          for (const [, apply] of fields.edits) apply(t);
          t.subtasks = subtasks.map((x) => ({ id: uid(), title: x.slice(0, MAX_TITLE), done: false }));
          sessionTasks(s).push(t);
          app.tasksChanged();
          return done(`Created task "${title}" (id ${t.id}) in session "${s.name}".`, `Created task “${title}”`);
        },
      });
    }

    case "update_task": {
      const s = findSession(args.session, ctx);
      if (!s) return noSession("Update task");
      if (!ctx.sessionInScope(s.id)) return refuse("that session is outside the current scope.", "Update task");
      const task = findTask(s, args.task);
      if (!task) return refuse(`no single task matches "${str(args.task)}" in "${s.name}". Use list_tasks and pass its id.`, "Update task");
      const fields = taskEdits(s, args);
      if (typeof fields === "string") return refuse(fields, `Update “${task.title}”`);
      const edits = fields.edits;
      const title = str(args.title).slice(0, MAX_TITLE);
      if (title) edits.unshift([`rename to “${title}”`, (t) => (t.title = title)]);
      const add = list(args.add_subtasks) ?? [];
      if (add.length)
        edits.push([
          `add ${add.length} subtask${add.length === 1 ? "" : "s"}`,
          (t) => t.subtasks.push(...add.map((x) => ({ id: uid(), title: x.slice(0, MAX_TITLE), done: false }))),
        ]);
      const complete = (list(args.complete_subtasks) ?? []).map((x) => x.toLowerCase());
      if (complete.length) {
        const hits = task.subtasks.filter((x) => complete.includes(x.title.toLowerCase()));
        if (!hits.length) return refuse(`no subtask with that title. Subtasks: ${task.subtasks.map((x) => x.title).join("; ") || "none"}.`, `Update “${task.title}”`);
        edits.push([
          `complete ${hits.length} subtask${hits.length === 1 ? "" : "s"}`,
          (t) => t.subtasks.forEach((x) => complete.includes(x.title.toLowerCase()) && (x.done = true)),
        ]);
      }
      if (!edits.length) return refuse("nothing to change was passed.", `Update “${task.title}”`);
      const what = edits.map(([w]) => w).join(", ");
      return plan({
        tool: name,
        tier: "tasks",
        verb: "Edit task",
        target: task.title,
        detail: `${what[0].toUpperCase()}${what.slice(1)}`,
        deniedLabel: `Denied: edit task “${task.title}”`,
        async execute() {
          const now = sessionTasks(s).find((t) => t.id === task.id);
          if (!now) return failed("that task no longer exists.", `Update “${task.title}”`);
          for (const [, apply] of edits) apply(now);
          now.updatedAt = Date.now();
          app.tasksChanged();
          return done(`Updated task "${now.title}": ${what}.`, `Edited task “${now.title}”: ${what}`);
        },
      });
    }

    case "create_session": {
      const sessionName = str(args.name).replace(/\s+/g, " ").slice(0, 60);
      if (!sessionName) return refuse("name is empty.", "Create session");
      const command = str(args.command);
      if (command.includes("\n") || command.length > 500) return refuse("command must be one short line.", "Create session");
      if (command && !ctx.can("input")) return refuse("typing into terminals is turned off in Settings, AI. Create it without a command.", "Create session");
      const cwd = str(args.folder) || null;
      const count = Math.max(1, Math.min(6, Math.round(Number(args.terminals)) || 1));
      return plan({
        tool: name,
        tier: "sessions",
        verb: "Create session",
        target: sessionName,
        text: command || null,
        detail: `${count} terminal${count === 1 ? "" : "s"}${cwd ? ` in ${cwd}` : ""}`,
        risks: command ? commandRisks(command) : [],
        deniedLabel: `Denied: create session ${sessionName}`,
        async execute() {
          const id = app.createSession({ name: sessionName, cwd, command: command || null, count });
          return id
            ? done(`Created session "${sessionName}" with ${count} terminal(s) and switched to it.`, `Created session ${sessionName}`)
            : failed("couldn't create the session.", "Create session");
        },
      });
    }

    case "update_session": {
      const s = findSession(args.session, ctx);
      if (!s || !str(args.session)) return noSession("Update session");
      const next = str(args.name).replace(/\s+/g, " ").slice(0, 60);
      const color = str(args.color);
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) return refuse("color must be #rrggbb.", `Update ${s.name}`);
      const folder = str(args.folder);
      const notes = [next && `rename to “${next}”`, color && `colour ${color}`, folder && `folder ${folder}`].filter(Boolean);
      if (!notes.length) return refuse("nothing to change was passed.", `Update ${s.name}`);
      const what = notes.join(", ");
      const was = s.name;
      return plan({
        tool: name,
        tier: "sessions",
        verb: "Edit session",
        target: was,
        detail: `${what[0].toUpperCase()}${what.slice(1)}`,
        deniedLabel: `Denied: edit session ${was}`,
        async execute() {
          if (!visibleSessions().includes(s)) return failed("that session is gone.", `Update ${was}`);
          if (next) s.name = next;
          if (color) s.color = color;
          if (folder) s.cwd = folder;
          app.sessionsChanged();
          return done(`Updated session "${was}": ${what}.`, `Edited session ${was}: ${what}`);
        },
      });
    }

    case "switch_session": {
      const s = findSession(args.session, ctx);
      if (!s || !str(args.session)) return noSession("Switch session");
      return plan({
        tool: name,
        tier: "ui",
        verb: "Switch session",
        target: s.name,
        detail: `Show ${s.name}`,
        deniedLabel: `Denied: switch to ${s.name}`,
        async execute() {
          if (!visibleSessions().includes(s)) return failed("that session is gone.", "Switch session");
          app.showSession(s.id);
          return done(`Now showing session "${s.name}".`, `Switched to ${s.name}`);
        },
      });
    }

    case "toggle_panel": {
      const panel = (["sidebar", "tasks", "inbox", "settings"] as const).find((p) => p === args.panel);
      if (!panel) return refuse("panel must be sidebar, tasks, inbox or settings.", "Toggle panel");
      const want = typeof args.on === "boolean" ? args.on : !app.panelOpen(panel);
      const label = `${want ? "Show" : "Hide"} ${panel}`;
      return plan({
        tool: name,
        tier: "ui",
        verb: label,
        target: null,
        detail: `${label} ${panel === "settings" ? "page" : panel === "sidebar" ? "" : "panel"}`.trim(),
        deniedLabel: `Denied: ${label.toLowerCase()}`,
        async execute() {
          if (app.panelOpen(panel) !== want) app.togglePanel(panel);
          return app.panelOpen(panel) === want
            ? done(`The ${panel} is now ${want ? "shown" : "hidden"}.`, `${want ? "Showed" : "Hid"} the ${panel}`)
            : failed(`couldn't ${want ? "show" : "hide"} the ${panel}.`, label);
        },
      });
    }

    case "set_setting": {
      const key = str(args.key);
      const spec = SETTINGS[key];
      if (!spec)
        return refuse(
          `"${key}" is not a setting you can change. ${PROTECTED_NOTE} Tell the user if they asked for one of those. get_settings lists what you can change.`,
          `Can't change ${key || "that setting"}`
        );
      const value = spec.parse(String(args.value ?? ""));
      if (value === undefined) return refuse(`invalid value for ${key}. Allowed: ${spec.hint}.`, `Set ${spec.label}`);
      const settings = store.state.settings as unknown as Record<string, unknown>;
      const before = settings[key];
      if (before === value) return refuse(`${key} is already ${String(value)}.`, `${spec.label} unchanged`);
      return plan({
        tool: name,
        tier: "settings",
        verb: "Change setting",
        target: spec.label,
        detail: `${spec.label}: ${String(before)} → ${String(value)}`,
        confirm: true,
        deniedLabel: `Denied: set ${spec.label} to ${String(value)}`,
        async execute() {
          settings[key] = value;
          app.applySettings();
          return done(`Set ${key} to ${String(value)} (was ${String(before)}).`, `Set ${spec.label} to ${String(value)}`);
        },
      });
    }
  }
  return refuse(`unknown tool ${name}.`, name);
}

// ---------------------------------------------------------------- reads

const MAX_TASKS_LISTED = 60;

/** Runs one app read tool. */
export async function runAppRead(name: string, argsJson: string, ctx: ActionContext): Promise<ToolRun> {
  const out = (result: string, label: string, paneIds: string[] = []): ToolRun => ({ result, label, paneIds });
  let args: Record<string, unknown>;
  try {
    args = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return out("Error: arguments were not valid JSON.", `${name} (bad arguments)`);
  }
  const perm = BY_NAME.get(name)?.perm;
  if (perm && !ctx.can(perm)) return out("Error: the user turned this permission off in Settings, AI. Tell them.", `${name} (turned off)`);

  if (name === "list_sessions") {
    const lines = visibleSessions().map((s) => {
      const terms = listAgents(s.id);
      const agents = terms.filter((a) => a.brand).length;
      return `"${s.name}"${s.id === store.state.activeSessionId ? " (showing)" : ""} | ${s.cwd ?? "no folder"} | ${terms.length} terminals, ${agents} agents | ${openTaskCount(s)} open tasks | ${s.color}`;
    });
    return out(lines.join("\n") || "No sessions.", "Listed sessions");
  }

  if (name === "list_tasks") {
    const s = findSession(args.session, ctx);
    if (!s || !ctx.sessionInScope(s.id)) return out(`Error: no session ${str(args.session) ? `"${str(args.session)}" ` : ""}in scope.`, "List tasks");
    const tasks = sessionTasks(s).filter((t) => args.include_done === true || !isTaskDone(s, t));
    const lines = tasks.slice(0, MAX_TASKS_LISTED).map((t) => {
      const parts = [`${t.id} | ${t.title} | ${stageOf(s, t.status).label} | ${t.priority}`];
      if (t.dueDate) parts.push(`due ${t.dueDate}`);
      if (t.tags.length) parts.push(`tags ${t.tags.join(", ")}`);
      if (t.subtasks.length) parts.push(`subtasks ${t.subtasks.map((x) => `${x.done ? "[x]" : "[ ]"} ${x.title}`).join("; ")}`);
      if (t.description) parts.push(`"${t.description.replace(/\s+/g, " ").slice(0, 160)}"`);
      return parts.join(" | ");
    });
    const head = `Session "${s.name}", stages: ${sessionStages(s).map((x) => x.label).join(", ")}. ${tasks.length} task${tasks.length === 1 ? "" : "s"}${
      tasks.length > MAX_TASKS_LISTED ? ` (first ${MAX_TASKS_LISTED} shown)` : ""
    }.`;
    return out([head, ...lines].join("\n"), `Listed tasks in ${s.name}`);
  }

  if (name === "get_settings") {
    const settings = store.state.settings as unknown as Record<string, unknown>;
    const lines = Object.entries(SETTINGS).map(([key, spec]) => `${key} = ${String(settings[key])} (${spec.label}; ${spec.hint})`);
    return out([...lines, PROTECTED_NOTE].join("\n"), "Read settings");
  }

  if (name === "usage_stats") {
    let rows = listAgents("all").filter((a) => ctx.inScope(a.paneId));
    if (str(args.ref)) {
      const id = paneOfRef(str(args.ref));
      rows = rows.filter((a) => a.paneId === id);
      if (!rows.length) return out(`Error: no terminal "${str(args.ref)}" in scope.`, "Usage");
    } else if (str(args.session)) {
      const s = findSession(args.session, ctx);
      if (!s) return out(`Error: no session named "${str(args.session)}".`, "Usage");
      rows = rows.filter((a) => a.sessionId === s.id);
    }
    const usages = await Promise.all(rows.map((a) => fetchPaneUsage(a.paneId).catch(() => null)));
    const stat = (cost: number, tokens: number, messages: number, activeMs: number, complete: boolean): string =>
      `${fmtCost(cost)}${complete ? "" : "+ (some models have no known price)"}, ${fmtTokens(tokens)} tokens, ${messages} messages, active ${fmtDuration(activeMs)}`;
    const lines: string[] = [];
    const total = { cost: 0, tokens: 0, messages: 0, active: 0, complete: true };
    for (const s of visibleSessions()) {
      const mine: string[] = [];
      const sum = { cost: 0, tokens: 0, messages: 0, active: 0, complete: true };
      rows.forEach((a, i) => {
        const u = usages[i];
        if (a.sessionId !== s.id || !u || !u.tokens.total) return;
        for (const t of [sum, total]) {
          t.cost += u.cost_usd;
          t.tokens += u.tokens.total;
          t.messages += u.messages;
          t.active += u.active_ms;
          t.complete &&= u.cost_complete;
        }
        const models = u.by_model.map((m) => m.model).slice(0, 4).join(", ");
        mine.push(`  ${a.ref} "${a.title}" (${a.program}): ${stat(u.cost_usd, u.tokens.total, u.messages, u.active_ms, u.cost_complete)}${models ? `, models: ${models}` : ""}`);
      });
      if (mine.length) lines.push(`Session "${s.name}": ${stat(sum.cost, sum.tokens, sum.messages, sum.active, sum.complete)}`, ...mine);
    }
    if (!lines.length) return out("No recorded agent usage for those terminals.", "Checked usage", rows.map((a) => a.paneId));
    lines.push(`Total: ${stat(total.cost, total.tokens, total.messages, total.active, total.complete)}`);
    return out(lines.join("\n"), "Checked usage and cost", rows.map((a) => a.paneId));
  }

  return out(`Error: unknown tool ${name}.`, name);
}
