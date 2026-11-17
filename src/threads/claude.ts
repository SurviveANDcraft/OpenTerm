/** Claude Code adapter: `claude -p` in stream-json mode.
 *
 *  Input: one JSON message per line on stdin (user turns, control requests).
 *  Output: system/init, stream_event deltas (live only), assistant/user
 *  messages (complete blocks), result (end of turn), rate_limit_event and
 *  control_request `can_use_tool` (approvals, enabled by
 *  `--permission-prompt-tool stdio`, answered with a control_response).
 *  Sub-agent messages carry `parent_tool_use_id` = the Agent/Task call. */
import type { Adapter, IO, PromptImage } from "./adapter";
import { setModelList, type ModelChoice, type PermissionMode, type QuestionSpec, type TextItem, type ThinkingItem, type ToolItem } from "./model";
import { diffCounts, lineCount, type Runtime } from "./runtime";
import { activityOf, isAgentTool } from "./tools";
import { disallowedBuiltins, toolOn } from "./toolGroups";

const MODE: Record<PermissionMode, string> = {
  ask: "default",
  edits: "acceptEdits",
  plan: "plan",
  auto: "bypassPermissions",
};
const MODE_BACK: Record<string, PermissionMode> = {
  default: "ask",
  acceptEdits: "edits",
  plan: "plan",
  bypassPermissions: "auto",
};

function reqId(): string {
  return "ot_" + Math.random().toString(36).slice(2, 10);
}

interface MsgState {
  /** stream block index -> item id */
  blocks: Map<number, string>;
  /** item ids created for this message, in order (stream or final). */
  ids: string[];
}

function st(rt: Runtime): { msgs: Map<string, MsgState>; pending: Map<string, string>; interrupting: boolean; counter: number; current?: string | null } {
  rt.a.msgs ??= new Map();
  rt.a.pending ??= new Map();
  rt.a.counter ??= 0;
  return rt.a as any;
}

function msgState(rt: Runtime, id: string): MsgState {
  const s = st(rt);
  let m = s.msgs.get(id);
  if (!m) {
    m = { blocks: new Map(), ids: [] };
    s.msgs.set(id, m);
    // Keep the map small: only recent messages can still be streaming.
    if (s.msgs.size > 64) s.msgs.delete(s.msgs.keys().next().value!);
  }
  return m;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  return content == null ? "" : JSON.stringify(content);
}

function startTool(rt: Runtime, id: string, name: string, input: any, parent: string | null, at: number, streaming: boolean): ToolItem {
  let t = rt.tool(id);
  if (!t) {
    t = rt.add({
      id,
      kind: "tool",
      parent,
      at,
      name,
      input: input ?? {},
      status: streaming ? "streaming" : "running",
      children: [],
    }) as ToolItem;
    if (!parent) rt.turnTools++;
  } else {
    if (input && Object.keys(input).length) t.input = input;
    if (t.status === "streaming" && !streaming) t.status = "running";
    rt.touch(id);
  }
  if (!parent && !streaming) {
    if (name === "TodoWrite" && Array.isArray(input?.todos)) {
      rt.todos = input.todos.map((x: any) => ({ text: String(x.content ?? ""), active: x.activeForm, status: x.status }));
      rt.emit({ t: "todos" });
    }
    syncTasks(rt, t, "start");
    rt.meta.activity = activityOf(t);
    rt.emit({ t: "meta" });
  }
  return t;
}

/** Claude Code's task tools (TaskCreate/TaskUpdate/TaskList) feed the same
 *  plan strip TodoWrite does. */
function syncTasks(rt: Runtime, t: ToolItem, phase: "start" | "done"): void {
  const tasks: Map<string, { text: string; active?: string; status: any }> = (rt.a.tasks ??= new Map());
  const i = t.input ?? {};
  let changed = false;
  if (t.name === "TaskCreate" && phase === "done" && t.result?.task?.id) {
    tasks.set(String(t.result.task.id), { text: String(i.subject ?? t.result.task.subject ?? ""), active: i.activeForm, status: "pending" });
    changed = true;
  } else if (t.name === "TaskUpdate" && phase === "start" && i.taskId) {
    const cur = tasks.get(String(i.taskId));
    if (i.status === "deleted") tasks.delete(String(i.taskId));
    else if (cur) {
      if (i.status) cur.status = i.status;
      if (i.subject) cur.text = i.subject;
      if (i.activeForm) cur.active = i.activeForm;
    }
    changed = true;
  } else if (t.name === "TaskList" && phase === "done" && Array.isArray(t.result?.tasks)) {
    tasks.clear();
    for (const x of t.result.tasks) tasks.set(String(x.id), { text: String(x.subject ?? ""), status: x.status });
    changed = true;
  }
  if (changed) {
    rt.todos = tasks.size ? [...tasks.values()].map((x) => ({ text: x.text, active: x.active, status: x.status })) : null;
    rt.emit({ t: "todos" });
  }
}

function finishTool(rt: Runtime, block: any, structured: any, at: number): void {
  const t = rt.tool(block.tool_use_id);
  if (!t) return;
  // Settled elsewhere (a rule, a hook, a cancel): the question is moot.
  for (const a of rt.approvals.filter((x) => x.toolId === t.id)) rt.dropApproval(a.key);
  t.output = toolResultText(block.content);
  t.result = structured ?? t.result;
  t.endAt = at;
  const denied = /^(The user doesn't want to proceed|User rejected|Permission to use .* (was )?denied)/i.test(t.output ?? "");
  t.status = denied ? "denied" : block.is_error ? "error" : "done";
  if (t.status === "done" && !t.parent) {
    noteFiles(rt, t);
    syncTasks(rt, t, "done");
  }
  rt.touch(t.id);
}

function noteFiles(rt: Runtime, t: ToolItem): void {
  const i = t.input ?? {};
  if (t.name === "Write") {
    const created = t.result?.type === "create" || !t.result?.originalFile;
    const before = lineCount(t.result?.originalFile);
    const after = lineCount(i.content);
    rt.noteFile(i.file_path, created ? after : Math.max(0, after), created ? 0 : before, created ? "create" : "edit", t.id);
  } else if (t.name === "Edit" || t.name === "MultiEdit") {
    let { added, removed } = diffCounts(t.result?.structuredPatch);
    if (!added && !removed) {
      const edits = t.name === "MultiEdit" ? i.edits ?? [] : [i];
      for (const e of edits) {
        removed += lineCount(e.old_string);
        added += lineCount(e.new_string);
      }
    }
    rt.noteFile(i.file_path, added, removed, "edit", t.id);
  } else if (t.name === "NotebookEdit") rt.noteFile(i.notebook_path, 1, 0, "edit", t.id);
}

function partialPreview(json: string): any {
  // Enough of the input to label the row while the model is still typing it.
  const out: Record<string, string> = {};
  for (const key of ["command", "file_path", "pattern", "description", "url", "query", "path", "notebook_path"]) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
    if (m) {
      try {
        out[key] = JSON.parse(`"${m[1].replace(/\\$/, "")}"`);
      } catch {
        out[key] = m[1];
      }
    }
  }
  return out;
}

function onStream(rt: Runtime, ev: any, parent: string | null, at: number): void {
  const s = st(rt);
  if (ev.type === "message_start") {
    s.current = ev.message?.id ?? null;
    return;
  }
  const msgId: string | null = s.current ?? null;
  if (!msgId) return;
  const m = msgState(rt, msgId);
  if (ev.type === "content_block_start") {
    const b = ev.content_block ?? {};
    if (b.type === "text" || b.type === "thinking") {
      const id = `${msgId}:${ev.index}`;
      const item =
        b.type === "text"
          ? ({ id, kind: "text", parent, at, text: b.text ?? "", done: false } as TextItem)
          : ({ id, kind: "thinking", parent, at, text: b.thinking ?? "", done: false } as ThinkingItem);
      rt.add(item);
      m.blocks.set(ev.index, id);
      m.ids.push(id);
    } else if (b.type === "tool_use" || b.type === "server_tool_use") {
      startTool(rt, b.id, b.name, b.input, parent, at, true);
      m.blocks.set(ev.index, b.id);
    }
    return;
  }
  if (ev.type === "content_block_delta") {
    const id = m.blocks.get(ev.index);
    if (!id) return;
    const it = rt.items.get(id);
    const d = ev.delta ?? {};
    if (!it) return;
    if (d.type === "text_delta" && it.kind === "text") it.text += d.text ?? "";
    else if (d.type === "thinking_delta" && it.kind === "thinking") it.text += d.thinking ?? "";
    else if (d.type === "input_json_delta" && it.kind === "tool") {
      it.partial = (it.partial ?? "") + (d.partial_json ?? "");
      const pre = partialPreview(it.partial);
      if (Object.keys(pre).length) it.input = { ...it.input, ...pre };
    } else return;
    rt.touch(id);
    return;
  }
  if (ev.type === "content_block_stop") {
    const id = m.blocks.get(ev.index);
    const it = id ? rt.items.get(id) : null;
    if (it?.kind === "thinking" && !it.done) {
      it.endAt = at;
      rt.touch(it.id);
    }
  }
}

function onAssistant(rt: Runtime, msg: any, parent: string | null, at: number): void {
  const message = msg.message ?? {};
  const msgId: string = message.id ?? `m${st(rt).counter++}`;
  const m = msgState(rt, msgId);
  for (const b of message.content ?? []) {
    if (b.type === "text" || b.type === "thinking") {
      const kind = b.type;
      const body: string = kind === "text" ? b.text ?? "" : b.thinking ?? "";
      const openId = m.ids.find((id) => {
        const it = rt.items.get(id);
        return !!it && (it.kind === "text" || it.kind === "thinking") && it.kind === kind && !it.done;
      });
      if (openId) {
        const it = rt.items.get(openId) as TextItem | ThinkingItem;
        if (body) it.text = body;
        it.done = true;
        if (it.kind === "thinking") it.endAt ??= at;
        rt.touch(openId);
      } else {
        if (kind === "text" && !body.trim()) continue;
        const id = `${msgId}:f${m.ids.length}`;
        m.ids.push(id);
        rt.add(
          kind === "text"
            ? ({ id, kind, parent, at, text: body, done: true } as TextItem)
            : ({ id, kind, parent, at, text: body, done: true, endAt: at } as ThinkingItem)
        );
      }
    } else if (b.type === "tool_use" || b.type === "server_tool_use") {
      const t = startTool(rt, b.id, b.name, b.input, parent, at, false);
      delete t.partial;
    }
  }
  const u = message.usage;
  if (u && !parent) {
    const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    if (used > 0) {
      rt.context.used = used;
      rt.emit({ t: "usage" });
    }
  }
}

function onUser(rt: Runtime, msg: any, at: number): void {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) if (b?.type === "tool_result") finishTool(rt, b, msg.tool_use_result, at);
}

function onResult(rt: Runtime, io: IO, msg: any): void {
  const s = st(rt);
  const u = msg.usage ?? {};
  const interrupted = s.interrupting || msg.subtype === "error_during_execution";
  s.interrupting = false;
  let window = 0;
  for (const mu of Object.values<any>(msg.modelUsage ?? {})) window = Math.max(window, mu?.contextWindow ?? 0);
  if (window) rt.context.window = window;
  io.endTurn({
    ms: msg.duration_ms ?? Date.now() - rt.turnStart,
    tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    tokensOut: u.output_tokens ?? 0,
    cost: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
    outcome: interrupted ? "interrupted" : msg.is_error ? "error" : "done",
    error: msg.is_error && !interrupted ? String(msg.result || msg.errors?.[0] || msg.subtype || "The turn failed") : undefined,
  });
}

function onControlRequest(rt: Runtime, io: IO, msg: any, at: number): void {
  const r = msg.request ?? {};
  const key: string = msg.request_id;
  if (r.subtype !== "can_use_tool") {
    if (io.live)
      io.write({ type: "control_response", response: { subtype: "error", request_id: key, error: "Not supported by OpenTerm Threads" } });
    return;
  }
  const name: string = r.tool_name;
  const input = r.input ?? {};
  const kind = name === "AskUserQuestion" ? "question" : name === "ExitPlanMode" ? "plan" : "tool";
  const questions: QuestionSpec[] | undefined =
    kind === "question" && Array.isArray(input.questions)
      ? input.questions.map((q: any) => ({
          question: String(q.question ?? ""),
          header: q.header,
          multiSelect: !!q.multiSelect,
          options: (q.options ?? []).map((o: any) => ({ label: String(o.label ?? ""), description: o.description })),
        }))
      : undefined;
  if (r.tool_use_id) startTool(rt, r.tool_use_id, name, input, null, at, false);
  const suggestions = r.permission_suggestions;
  rt.addApproval(
    {
      key,
      kind,
      toolId: r.tool_use_id ?? null,
      tool: name,
      input,
      description: r.description || r.title,
      canAlways: Array.isArray(suggestions) && suggestions.length > 0,
      questions,
      at,
    },
    (d) => {
      const response =
        d.behavior === "allow"
          ? {
              behavior: "allow",
              updatedInput: d.updatedInput ?? input,
              ...(d.always && suggestions ? { updatedPermissions: suggestions } : {}),
            }
          : { behavior: "deny", message: d.message || "The user declined this. Ask what to do instead." };
      io.write({ type: "control_response", response: { subtype: "success", request_id: key, response } });
      if (d.behavior === "allow" && d.nextMode) {
        rt.meta.mode = d.nextMode;
        io.write({ type: "control_request", request_id: reqId(), request: { subtype: "set_permission_mode", mode: MODE[d.nextMode] } });
        rt.emit({ t: "meta" });
      }
    }
  );
}

/** Where the agent is running and what it can reach beyond the code. */
function systemNote(tools: boolean): string {
  let s =
    "You are running inside OpenTerm, a terminal organizer, as a chat thread the user reads in a GUI (markdown renders). " +
    "The user can paste screenshots into this chat; you see them as images.";
  if (tools)
    s +=
      " The `openterm` MCP tools act on OpenTerm itself (its sessions, terminals, tasks, timers, panels, usage or settings, whichever the user enabled). Use them when the user asks about or wants changes in OpenTerm.";
  if (tools && toolOn("images"))
    s += " To show the user an image (a screenshot you took, a chart, a design), call show_image with the file's path; it appears inline in the chat.";
  return s;
}

export const claude: Adapter = {
  cli: "claude",
  journalSkip: ['"type":"stream_event"'],

  args(rt) {
    const m = rt.meta;
    const a = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      MODE[m.mode],
    ];
    if (m.model) a.push("--model", m.model);
    if (m.effort) a.push("--effort", m.effort);
    const mcp = rt.a.mcp as { json: string; allowed: string[] } | null | undefined;
    if (mcp) {
      a.push("--mcp-config", mcp.json);
      if (mcp.allowed.length) a.push("--allowedTools", mcp.allowed.join(","));
    }
    const off = disallowedBuiltins();
    if (off.length) a.push("--disallowedTools", off.join(","));
    if (!toolOn("userMcp")) a.push("--strict-mcp-config");
    a.push("--append-system-prompt", systemNote(!!mcp));
    if (m.sessionId && m.resumable) a.push("--resume", m.sessionId);
    else {
      m.sessionId = crypto.randomUUID();
      a.push("--session-id", m.sessionId);
    }
    return a;
  },

  started(rt, io) {
    const id = reqId();
    st(rt).pending.set(id, "initialize");
    io.write({ type: "control_request", request_id: id, request: { subtype: "initialize" } });
  },

  prompt(rt, io, text, images: PromptImage[]) {
    const content: any[] = images.map((im) => ({
      type: "image",
      source: { type: "base64", media_type: im.mediaType, data: im.data },
    }));
    if (text) content.push({ type: "text", text });
    io.write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  },

  interrupt(rt, io) {
    st(rt).interrupting = true;
    io.write({ type: "control_request", request_id: reqId(), request: { subtype: "interrupt" } });
  },

  setMode(rt, io, mode) {
    io.write({ type: "control_request", request_id: reqId(), request: { subtype: "set_permission_mode", mode: MODE[mode] } });
    return "live";
  },

  setModel(rt, io, model) {
    io.write({ type: "control_request", request_id: reqId(), request: { subtype: "set_model", model: model ?? "default" } });
    return "live";
  },

  // --effort is a launch flag: the next turn resumes the session with it.
  setEffort() {
    return "restart";
  },

  ingest(rt, io, msg, at) {
    const parent: string | null = msg.parent_tool_use_id ?? null;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          if (msg.session_id) rt.meta.sessionId = msg.session_id;
          rt.liveModel = msg.model ?? rt.liveModel;
          if (Array.isArray(msg.slash_commands) && !rt.commands.length)
            rt.commands = msg.slash_commands.map((n: string) => ({ name: n, description: "" }));
          const mode = MODE_BACK[msg.permissionMode];
          if (mode && mode !== rt.meta.mode && !rt.replaying) rt.meta.mode = mode;
          rt.emit({ t: "meta" });
        } else if (msg.subtype === "compact_boundary") {
          io.notice("info", "Context compacted. Older messages were summarised to make room.");
        } else if (msg.subtype === "status" && msg.status === "compacting") {
          rt.meta.activity = "Compacting context";
          rt.emit({ t: "meta" });
        } else if ((msg.subtype === "task_progress" || msg.subtype === "task_started") && msg.tool_use_id) {
          // Live progress of a sub-agent: what it's doing now and how far along.
          const t = rt.tool(msg.tool_use_id);
          if (t) {
            t.result = { ...(t.result ?? {}), progress: msg.description, toolUses: msg.usage?.tool_uses };
            rt.touch(t.id);
          }
        } else if (msg.subtype === "api_retry") {
          io.notice("warn", `Connection hiccup, retrying${msg.attempt ? ` (attempt ${msg.attempt})` : ""}…`);
        }
        return;
      case "stream_event":
        if (msg.event) onStream(rt, msg.event, parent, at);
        return;
      case "assistant":
        onAssistant(rt, msg, parent, at);
        if (!parent) rt.meta.resumable = true;
        return;
      case "user":
        onUser(rt, msg, at);
        return;
      case "result":
        onResult(rt, io, msg);
        return;
      case "rate_limit_event": {
        const w = msg.rate_limit_info?.unifiedWindows ?? {};
        const label: Record<string, string> = { five_hour: "5-hour window", seven_day: "Weekly", seven_day_opus: "Weekly (Opus)" };
        rt.rate = Object.entries<any>(w).map(([k, v]) => ({
          label: label[k] ?? k.replace(/_/g, " "),
          used: Math.max(0, Math.min(1, Number(v?.utilization ?? 0))),
          resetsAt: v?.resetsAt ? v.resetsAt * 1000 : null,
        }));
        rt.emit({ t: "usage" });
        return;
      }
      case "control_request":
        onControlRequest(rt, io, msg, at);
        return;
      case "control_cancel_request":
        rt.dropApproval(msg.request_id);
        return;
      case "control_response": {
        const res = msg.response ?? {};
        const what = st(rt).pending.get(res.request_id);
        st(rt).pending.delete(res.request_id);
        if (what === "initialize" && Array.isArray(res.response?.commands)) {
          rt.commands = res.response.commands
            .filter((c: any) => c?.name)
            .map((c: any) => ({ name: String(c.name), description: String(c.description ?? ""), hint: c.argumentHint }));
          rt.emit({ t: "meta" });
        }
        if (what === "initialize" && Array.isArray(res.response?.models)) {
          const list: ModelChoice[] = res.response.models
            .filter((x: any) => x?.value)
            .map((x: any) => ({
              id: x.value === "default" ? null : String(x.value),
              label: x.value === "default" ? "Default" : String(x.displayName ?? x.value),
              hint: x.description ? String(x.description) : undefined,
              efforts: x.supportsEffort && Array.isArray(x.supportedEffortLevels) ? x.supportedEffortLevels.map(String) : [],
              resolved: x.resolvedModel ? String(x.resolvedModel) : undefined,
            }));
          setModelList("claude", list);
          rt.emit({ t: "meta" });
        }
        return;
      }
    }
  },
};

export function isSubagentTool(name: string): boolean {
  return isAgentTool(name);
}
