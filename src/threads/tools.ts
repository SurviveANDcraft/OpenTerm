/** How each tool call reads in the timeline: an icon, a verb, a target, and
 *  what kind of detail it can expand into. Pure data, no DOM. Names cover
 *  Claude Code's tools and the Codex items mapped onto them. */
import type { IconName } from "./icons";
import type { ToolItem } from "./model";

export type DetailKind = "diff" | "write" | "output" | "search" | "agent" | "json" | "none";

export interface ToolLook {
  icon: IconName;
  /** "Read", "Edit"... */
  verb: string;
  /** Verb while it runs ("Reading"). */
  active: string;
  target: string;
  /** A mono target (paths, commands) vs plain text. */
  mono: boolean;
  detail: DetailKind;
  /** Hidden from the timeline (shown elsewhere, e.g. the plan strip). */
  quiet?: boolean;
}

let baseDir = "";

/** Paths inside the thread's folder are shown relative to it. */
export function setToolBase(cwd: string): void {
  baseDir = cwd.replace(/[\\/]+$/, "");
}

export function relPath(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const norm = p.replace(/\//g, "\\");
  const base = baseDir.replace(/\//g, "\\");
  if (base && norm.toLowerCase().startsWith(base.toLowerCase() + "\\")) return norm.slice(base.length + 1);
  return p;
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function firstLine(s: unknown, max = 120): string {
  const t = typeof s === "string" ? s.trim().split("\n")[0] : "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function mcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1].replace(/_/g, " "), tool: m[2].replace(/_/g, " ") } : null;
}

export function lookOf(t: Pick<ToolItem, "name" | "input">): ToolLook {
  const i = t.input ?? {};
  const L = (icon: IconName, verb: string, active: string, target: string, mono: boolean, detail: DetailKind): ToolLook => ({
    icon,
    verb,
    active,
    target,
    mono,
    detail,
  });
  switch (t.name) {
    case "Read":
      return L("fileText", "Read", "Reading", relPath(i.file_path), true, "none");
    case "Write":
      return L("filePlus", "Wrote", "Writing", relPath(i.file_path), true, "write");
    case "Edit":
    case "MultiEdit":
      return L("pencilLine", "Edited", "Editing", relPath(i.file_path), true, "diff");
    case "NotebookEdit":
      return L("pencilLine", "Edited", "Editing", relPath(i.notebook_path), true, "diff");
    case "Patch": {
      const ch: any[] = Array.isArray(i.changes) ? i.changes : [];
      const target = ch.length === 1 ? relPath(ch[0].path) : `${ch.length} files`;
      return L("pencilLine", "Edited", "Editing", target, ch.length === 1, "diff");
    }
    case "Bash":
    case "PowerShell":
      return L("terminal", "Ran", "Running", firstLine(i.command, 160), true, "output");
    case "Grep":
      return L("search", "Searched", "Searching", `${i.pattern ?? ""}${i.path ? `  in ${relPath(i.path)}` : ""}`, true, "search");
    case "Glob":
      return L("folderOpen", "Found files", "Finding files", String(i.pattern ?? ""), true, "search");
    case "LS":
      return L("folderOpen", "Listed", "Listing", relPath(i.path), true, "search");
    case "WebFetch":
      return L("globe", "Fetched", "Fetching", String(i.url ?? ""), true, "output");
    case "WebSearch":
      return L("globe", "Searched the web", "Searching the web", String(i.query ?? ""), false, "output");
    case "Task":
    case "Agent":
      return L("robot", "Agent", "Agent", String(i.description ?? firstLine(i.prompt, 60) ?? "Sub-agent"), false, "agent");
    case "TaskCreate":
      return L("listChecks", "Added a step", "Adding a step", String(i.subject ?? ""), false, "none");
    case "TaskUpdate":
      return L(
        "listChecks",
        i.status === "completed" ? "Finished a step" : i.status === "in_progress" ? "Started a step" : "Updated a step",
        "Updating the plan",
        String(i.subject ?? (i.taskId ? `#${i.taskId}` : "")),
        false,
        "none"
      );
    case "TaskList":
    case "TaskGet":
      return L("listChecks", "Checked the plan", "Checking the plan", "", false, "none");
    case "TodoWrite":
      return { ...L("listChecks", "Updated the plan", "Planning", "", false, "none"), quiet: false };
    case "AskUserQuestion":
      return L("question", "Asked", "Asking", firstLine(i.questions?.[0]?.question ?? "", 90), false, "none");
    case "ExitPlanMode":
      return L("map", "Proposed a plan", "Planning", "", false, "none");
    case "EnterPlanMode":
      return L("map", "Switched to planning", "Planning", "", false, "none");
    case "Skill":
      return L("lightning", "Used skill", "Using skill", String(i.skill ?? i.name ?? ""), false, "output");
    case "ToolSearch":
      return L("binoculars", "Looked up tools", "Looking up tools", String(i.query ?? ""), false, "none");
    case "Monitor":
      return L("eye", "Watched", "Watching", firstLine(i.command ?? i.description ?? "", 100), true, "output");
    case "TaskStop":
    case "KillShell":
      return L("stop", "Stopped a task", "Stopping a task", "", false, "none");
    case "BashOutput":
      return L("terminal", "Checked output", "Checking output", "", false, "output");
  }
  const mcp = mcpName(t.name);
  if (mcp?.server === "openterm") {
    const words = mcp.tool.trim();
    const label = words.charAt(0).toUpperCase() + words.slice(1);
    const i2 = t.input ?? {};
    const target = firstLine(i2.title ?? i2.name ?? i2.text ?? i2.ref ?? i2.key ?? i2.session ?? "", 80);
    return L("sliders", label, label, target, false, "json");
  }
  if (mcp) return L("puzzle", mcp.tool, mcp.tool, mcp.server, false, "json");
  return L("wrench", t.name, t.name, "", false, "json");
}

/** One line for the sidebar about what a running tool is doing. */
export function activityOf(t: Pick<ToolItem, "name" | "input">): string {
  const l = lookOf(t);
  const target = l.target && l.mono ? baseName(l.target.split("  in ")[0]) : l.target;
  return target ? `${l.active} ${target}` : l.active;
}

export function isEditTool(name: string): boolean {
  return name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit" || name === "Patch";
}

export function isAgentTool(name: string): boolean {
  return name === "Task" || name === "Agent";
}
