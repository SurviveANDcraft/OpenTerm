/** OpenTerm's own tools for thread agents.
 *
 *  The same tools the Agents assistant and voice mode use (sessions,
 *  terminals, tasks, timers, panels, a safe subset of settings, usage) are
 *  served to Claude Code over a local MCP server (src-tauri/src/app_mcp.rs).
 *  Calls come back here and run through Conversation.runExternal, so the
 *  permissions in Settings, AI and the code-enforced rules still apply.
 *
 *  Approval: Claude asks before any non-read tool through the thread's own
 *  approval sheet. In Full auto it doesn't, so changes the app always wants
 *  confirmed (settings, risky actions) are asked for here instead. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Conversation, toolDefsFor } from "../agentsAssistant";
import { modeDef } from "../agentsModes";
import { isActionTool, tierOfTool, type ActionHost } from "../agentsActions";
import { appToolPerm, isAppAction } from "../agentsAppActions";
import type { ThreadToolGroup } from "../types";
import { toolOn } from "./toolGroups";
import { store } from "../store";
import { engine } from "./engine";
import { uid } from "./model";

interface Call {
  id: string;
  name: string;
  arguments: Record<string, unknown> | null;
  caller: string | null;
}

/** Needs the assistant's polling of a terminal, which a thread can't receive. */
const LEFT_OUT = new Set(["notify_when_done"]);
export const SERVER = "openterm";

let host: ActionHost | null = null;
const conversation = new Conversation();

/** Puts an image into the thread's chat; handled here, not by the assistant. */
export const SHOW_IMAGE = "show_image";
const SHOW_IMAGE_DEF = {
  name: SHOW_IMAGE,
  description:
    "Show an image inline in this chat: a screenshot, diagram, chart, generated image or design. Pass the absolute path of a local image file (png, jpg, gif, webp, svg). For an image on the web, download it to a temp file first. The user can click it to enlarge.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the image file." },
      caption: { type: "string", description: "One short line shown under the image." },
    },
    required: ["path"],
  },
};

/** Threads themselves: list them, rename this one or (with approval) others. */
const LIST_THREADS = "list_threads";
const RENAME_THREAD = "rename_thread";
const THREAD_DEFS = [
  {
    name: LIST_THREADS,
    description:
      "List the user's OpenTerm threads (chat conversations with coding agents, including this one): id, title, agent, folder, status and last activity. Use it to find a thread before renaming it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: RENAME_THREAD,
    description:
      "Rename an OpenTerm thread. Leave `thread` out to rename this conversation (no approval needed, do it when the user asks or when the title no longer fits the work). Renaming another thread asks the user first unless they are in Full auto. Titles: 2 to 6 words, sentence case, no quotes.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The new title." },
        thread: { type: "string", description: "Id or exact current title of another thread. Omit for this one." },
      },
      required: ["title"],
    },
  },
];

/** The Settings → Threads switch a tool belongs to. */
export function groupOf(name: string): ThreadToolGroup {
  if (name === SHOW_IMAGE) return "images";
  if (name === LIST_THREADS || name === RENAME_THREAD) return "sessions";
  if (isActionTool(name)) return tierOfTool(name) as ThreadToolGroup;
  const perm = appToolPerm(name);
  if (perm) return perm as ThreadToolGroup;
  if (name === "notify_user") return "ui";
  return "terminals";
}

function defs(): { name: string; description: string; inputSchema: unknown }[] {
  const can = (perm: string) => (store.state.settings.assistantPerms as Record<string, boolean | undefined>)[perm] !== false;
  const all = (toolDefsFor(modeDef("auto"), can as any) as any[])
    .map((d) => d.function)
    .filter((f) => f && !LEFT_OUT.has(f.name))
    .map((f) => ({ name: f.name as string, description: (f.description ?? "") as string, inputSchema: f.parameters ?? { type: "object", properties: {} } }));
  return [SHOW_IMAGE_DEF, ...THREAD_DEFS, ...all].filter((t) => toolOn(groupOf(t.name)));
}

function isRead(name: string): boolean {
  return !isActionTool(name) && !isAppAction(name);
}

export function initAppTools(actionHost: ActionHost): void {
  host = actionHost;
  void listen<Call>("app-mcp-call", (e) => void run(e.payload));
}

/** Which OpenTerm tools a freshly started agent would get. A running agent
 *  keeps the list it launched with, so a change means a respawn. */
export function toolsSignature(): string {
  return host ? defs().map((t) => t.name).sort().join(",") : "";
}

/** The `--mcp-config` JSON for one thread (tagged with its id) and the read
 *  tools to pre-allow. Null when the server can't start: the thread still
 *  works, just without OpenTerm's tools. */
export async function mcpConfigFor(threadId: string): Promise<{ json: string; allowed: string[] } | null> {
  if (!host) return null;
  try {
    const tools = defs();
    if (!tools.length) return null;
    const config = await invoke<any>("app_mcp_start", { tools });
    const c = structuredClone(config);
    c.mcpServers[SERVER].headers["X-OpenTerm-Thread"] = threadId;
    return { json: JSON.stringify(c), allowed: tools.filter((t) => isRead(t.name)).map((t) => `mcp__${SERVER}__${t.name}`) };
  } catch (e) {
    console.warn("threads: OpenTerm tools unavailable", e);
    return null;
  }
}

async function threadTool(call: Call, self: ReturnType<typeof engine.get>): Promise<string> {
  const args = call.arguments ?? {};
  if (call.name === LIST_THREADS) {
    const rows = engine
      .list()
      .filter((r) => !r.meta.archived)
      .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
      .slice(0, 40)
      .map((r) => ({
        id: r.meta.id,
        title: r.meta.title,
        thisThread: r === self,
        agent: r.meta.harness,
        folder: r.meta.cwd,
        status: r.approvals.length ? "waiting for the user" : r.busy ? "working" : "idle",
        activity: r.meta.activity ?? null,
        updated: new Date(r.meta.updatedAt).toISOString(),
      }));
    return JSON.stringify(rows, null, 1);
  }
  const title = String(args.title ?? "").trim().replace(/^["']|["']$/g, "");
  if (!title) throw new Error("pass a non-empty title");
  const want = String(args.thread ?? "").trim();
  const target = want ? engine.get(want) ?? engine.list().find((r) => r.meta.title.toLowerCase() === want.toLowerCase()) ?? null : self;
  if (!target) throw new Error(want ? `no thread with id or title "${want}". Call list_threads to find it.` : "this call has no thread");
  const old = target.meta.title;
  if (target !== self && self && self.meta.mode !== "auto") {
    const ok = await new Promise<boolean>((resolve) =>
      self.addApproval(
        {
          key: uid("app"),
          kind: "tool",
          toolId: null,
          tool: `mcp__${SERVER}__${RENAME_THREAD}`,
          input: { thread: old, title },
          description: `Rename another thread: "${old}" → "${title}"`,
          canAlways: false,
          at: Date.now(),
        },
        (d) => resolve(d.behavior === "allow")
      )
    );
    if (!ok) return "The user declined renaming that thread.";
  }
  engine.rename(target, title);
  return `Renamed "${old}" to "${target.meta.title}".`;
}

async function run(call: Call): Promise<void> {
  const reply = (text: string, isError = false) => void invoke("app_mcp_result", { id: call.id, text, isError }).catch(() => {});
  if (!host) return reply("OpenTerm's tools aren't ready yet.", true);
  const rt = engine.get(call.caller);
  if (call.name === SHOW_IMAGE) {
    const path = String(call.arguments?.path ?? "");
    if (!/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path)) return reply("Error: pass the path of an image file (png, jpg, gif, webp, svg).", true);
    return reply("The image is now shown in the chat.");
  }
  if (!toolOn(groupOf(call.name))) return reply("Error: the user turned this tool off in Settings, Threads.", true);
  if (call.name === LIST_THREADS || call.name === RENAME_THREAD) {
    try {
      return reply(await threadTool(call, rt));
    } catch (e) {
      return reply(`Error: ${String(e instanceof Error ? e.message : e)}`, true);
    }
  }
  const abort = new AbortController();
  try {
    const out = await conversation.runExternal(
      [{ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }],
      { scope: "all", mode: "auto", host, allowed: new Set(), signal: abort.signal },
      {
        onText: () => {},
        onTool: () => {},
        onAction: () => {},
        watch: () => "Watching a terminal isn't available in threads. Read it again later with read_terminal.",
        requestApproval: (plan) => {
          const mustAsk = !!(plan.confirm || plan.risks.length);
          if (!rt || !mustAsk || rt.meta.mode !== "auto") return Promise.resolve(true);
          return new Promise<boolean>((resolve) => {
            rt.addApproval(
              {
                key: uid("app"),
                kind: "tool",
                toolId: null,
                tool: `mcp__${SERVER}__${call.name}`,
                input: call.arguments ?? {},
                description: [plan.verb, plan.target, plan.text ?? plan.detail, ...plan.risks].filter(Boolean).join(" · "),
                canAlways: false,
                at: Date.now(),
              },
              (d) => resolve(d.behavior === "allow")
            );
          });
        },
      }
    );
    reply(out[0]?.content ?? "Done.");
  } catch (e) {
    reply(`Error: ${String(e)}`, true);
  }
}
