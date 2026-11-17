/** The tool groups a thread agent can be given, as switches in Settings →
 *  Threads. Fewer tools keep every request's context smaller, which matters
 *  on smaller plans. */
import { store } from "../store";
import type { ThreadToolGroup, ThreadsSettings } from "../types";

export interface ToolGroupDef {
  id: ThreadToolGroup;
  label: string;
  desc: string;
  kind: "openterm" | "builtin";
}

export const TOOL_GROUPS: ToolGroupDef[] = [
  { id: "images", kind: "openterm", label: "Show images", desc: "Put a screenshot, diagram or any image file right into the chat. Click to enlarge." },
  { id: "terminals", kind: "openterm", label: "See terminals and agents", desc: "List your sessions' terminals and agents and read what's on their screens." },
  { id: "layout", kind: "openterm", label: "Arrange panes", desc: "Open, split, close, resize and rename terminals." },
  { id: "input", kind: "openterm", label: "Type into terminals", desc: "Run commands in idle shells and prompt idle agents." },
  { id: "sessions", kind: "openterm", label: "Sessions and threads", desc: "List, start and rename sessions and threads, change a session's colour or folder. Renaming another thread asks first." },
  { id: "tasks", kind: "openterm", label: "Tasks", desc: "Read, add and edit tasks in the Tasks panel." },
  { id: "ui", kind: "openterm", label: "Panels", desc: "Show and hide the sidebar, Tasks, inbox and Settings, switch sessions, ping you." },
  { id: "media", kind: "openterm", label: "Music and timers", desc: "Control what's playing and set, pause or cancel timers." },
  { id: "usage", kind: "openterm", label: "Usage and cost", desc: "Tokens, cost and active time per terminal and session." },
  { id: "settings", kind: "openterm", label: "Settings", desc: "Appearance, terminal and notification settings. Every change waits for your approval." },
  { id: "web", kind: "builtin", label: "Web search and fetch", desc: "Claude Code's WebSearch and WebFetch." },
  { id: "subagents", kind: "builtin", label: "Sub-agents", desc: "Let the agent hand work to sub-agents (the Agent tool)." },
  { id: "skills", kind: "builtin", label: "Skills", desc: "Your installed Claude Code skills." },
  { id: "userMcp", kind: "builtin", label: "Your MCP servers", desc: "MCP servers from your own Claude Code config. Often the biggest context cost." },
];

/** Claude Code tool names behind each built-in group. */
export const BUILTIN_TOOLS: Partial<Record<ThreadToolGroup, string[]>> = {
  web: ["WebFetch", "WebSearch"],
  subagents: ["Task", "Agent"],
  skills: ["Skill"],
};

export function threadsSettings(): ThreadsSettings {
  const t = store.state.settings.threads as Partial<ThreadsSettings> | undefined;
  return { enabled: t?.enabled !== false, sessionsTab: t?.sessionsTab !== false, tools: { ...(t?.tools ?? {}) } };
}

export function toolOn(id: ThreadToolGroup): boolean {
  return threadsSettings().tools[id] !== false;
}

/** Built-ins switched off, for `--disallowedTools`. */
export function disallowedBuiltins(): string[] {
  return Object.entries(BUILTIN_TOOLS).flatMap(([id, names]) => (toolOn(id as ThreadToolGroup) ? [] : names ?? []));
}
