/** Codex adapter: `codex app-server`, JSON-RPC over stdio (no "jsonrpc"
 *  header). initialize -> initialized -> thread/start|resume -> turn/start.
 *  Items stream as item/started, deltas, item/completed; approvals arrive as
 *  server requests answered with `{decision}`. */
import type { Adapter, IO, PromptImage } from "./adapter";
import { setModelList, type ModelChoice, type PermissionMode, type TextItem, type ThinkingItem, type ToolItem } from "./model";
import { diffCounts, type Runtime } from "./runtime";
import { activityOf } from "./tools";

let modelsAsked = false;

const POLICY: Record<PermissionMode, { approvalPolicy: string; sandbox: string }> = {
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  edits: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  plan: { approvalPolicy: "on-request", sandbox: "read-only" },
  auto: { approvalPolicy: "never", sandbox: "danger-full-access" },
};

interface CodexState {
  next: number;
  pending: Map<number, (result: any, error: any) => void>;
  threadReady: boolean;
  outbox: (() => void)[];
  turnId: string | null;
  interrupting: boolean;
  turnUsageIn: number;
  turnUsageOut: number;
  totalIn: number;
  totalOut: number;
}

function st(rt: Runtime): CodexState {
  if (!rt.a.codex)
    rt.a.codex = {
      next: 1,
      pending: new Map(),
      threadReady: false,
      outbox: [],
      turnId: null,
      interrupting: false,
      turnUsageIn: 0,
      turnUsageOut: 0,
      totalIn: 0,
      totalOut: 0,
    } satisfies CodexState;
  return rt.a.codex;
}

function request(rt: Runtime, io: IO, method: string, params: unknown, done?: (result: any, error: any) => void): void {
  const s = st(rt);
  const id = s.next++;
  if (done) s.pending.set(id, done);
  io.write({ id, method, params });
}

function whenReady(rt: Runtime, fn: () => void): void {
  const s = st(rt);
  if (s.threadReady) fn();
  else s.outbox.push(fn);
}

/** Codex reports commands wrapped in the shell call that ran them
 *  (`"…\pwsh.exe" -Command 'npm test'`); show the command itself. */
export function cleanCommand(cmd: unknown): string {
  const c = String(cmd ?? "").trim();
  const m = /^"?[^"\s]*?(?:pwsh|powershell|bash|sh|cmd|zsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c|\/c|\/s \/c)\s+([\s\S]+)$/i.exec(c);
  if (!m) return c;
  let inner = m[1].trim();
  const q = inner[0];
  if ((q === "'" || q === '"') && inner.endsWith(q)) inner = inner.slice(1, -1);
  return q === "'" ? inner.replace(/''/g, "'") : inner;
}

function mapItem(rt: Runtime, item: any, at: number, final: boolean): void {
  const id = String(item.id ?? "");
  if (!id) return;
  switch (item.type) {
    case "agentMessage":
    case "plan": {
      const ex = rt.items.get(id) as TextItem | undefined;
      if (ex) {
        if (item.text) ex.text = item.text;
        ex.done = final;
        rt.touch(id);
      } else if (!final || item.text) rt.add({ id, kind: "text", parent: null, at, text: item.text ?? "", done: final } as TextItem);
      return;
    }
    case "reasoning": {
      const text = [...(item.summary ?? []), ...(final && !(item.summary ?? []).length ? item.content ?? [] : [])].join("\n\n");
      const ex = rt.items.get(id) as ThinkingItem | undefined;
      if (ex) {
        if (text) ex.text = text;
        if (final) {
          ex.done = true;
          ex.endAt = at;
        }
        rt.touch(id);
      } else rt.add({ id, kind: "thinking", parent: null, at, text, done: final, endAt: final ? at : undefined } as ThinkingItem);
      return;
    }
    case "commandExecution":
      upsertTool(rt, id, "Bash", { command: cleanCommand(item.command), cwd: item.cwd }, at, final, () => ({
        status: item.status === "completed" ? (item.exitCode && item.exitCode !== 0 ? "error" : "done") : item.status === "declined" ? "denied" : item.status === "failed" ? "error" : "running",
        output: item.aggregatedOutput ?? undefined,
        result: { exitCode: item.exitCode, durationMs: item.durationMs },
      }));
      return;
    case "fileChange":
      upsertTool(rt, id, "Patch", { changes: item.changes ?? [] }, at, final, () => ({
        status: item.status === "completed" ? "done" : item.status === "declined" ? "denied" : item.status === "failed" ? "error" : "running",
        result: { changes: item.changes ?? [] },
      }));
      if (final && item.status === "completed")
        for (const c of item.changes ?? []) {
          const { added, removed } = diffCounts(c.diff);
          rt.noteFile(c.path, added, removed, c.kind?.type === "add" ? "create" : c.kind?.type === "delete" ? "delete" : "edit", id);
        }
      return;
    case "mcpToolCall":
      upsertTool(rt, id, `mcp__${item.server}__${item.tool}`, item.arguments ?? {}, at, final, () => ({
        status: item.status === "completed" ? (item.error ? "error" : "done") : item.status === "failed" ? "error" : "running",
        output: item.error?.message ?? (item.result?.content ?? []).map((c: any) => c?.text ?? "").join("\n"),
      }));
      return;
    case "dynamicToolCall":
      upsertTool(rt, id, item.tool ?? "tool", item.arguments ?? {}, at, final, () => ({
        status: final ? (item.success === false ? "error" : "done") : "running",
        output: (item.contentItems ?? []).map((c: any) => c?.text ?? "").join("\n"),
      }));
      return;
    case "webSearch":
      upsertTool(rt, id, "WebSearch", { query: item.query ?? item.action?.query ?? "" }, at, final, () => ({
        status: final ? "done" : "running",
      }));
      return;
    case "collabAgentToolCall":
      upsertTool(rt, id, "Agent", { description: (item.prompt ?? "Sub-agent").split("\n")[0].slice(0, 80), prompt: item.prompt }, at, final, () => ({
        status: item.status === "completed" ? "done" : item.status === "failed" ? "error" : "running",
      }));
      return;
    case "imageView":
      upsertTool(rt, id, "Read", { file_path: item.path }, at, final, () => ({ status: final ? "done" : "running" }));
      return;
    case "contextCompaction":
      if (final) rt.add({ id, kind: "notice", parent: null, at, tone: "info", text: "Context compacted. Older messages were summarised to make room." });
      return;
  }
}

function upsertTool(
  rt: Runtime,
  id: string,
  name: string,
  input: any,
  at: number,
  final: boolean,
  state: () => Partial<ToolItem>
): void {
  let t = rt.tool(id);
  if (!t) {
    t = rt.add({ id, kind: "tool", parent: null, at, name, input, status: "running", children: [] }) as ToolItem;
    rt.turnTools++;
    rt.meta.activity = activityOf(t);
    rt.emit({ t: "meta" });
  } else t.input = { ...t.input, ...input };
  const next = state();
  if (t.status === "waiting" && next.status === "running") delete next.status;
  Object.assign(t, next);
  if (final) t.endAt = at;
  rt.touch(id);
}

function onServerRequest(rt: Runtime, io: IO, msg: any, at: number): void {
  const p = msg.params ?? {};
  const key = String(msg.id);
  const reply = (decision: string) => io.write({ id: msg.id, result: { decision } });
  if (msg.method === "item/commandExecution/requestApproval" || msg.method === "execCommandApproval") {
    const toolId = p.itemId ? String(p.itemId) : null;
    if (toolId && !rt.tool(toolId)) upsertTool(rt, toolId, "Bash", { command: cleanCommand(p.command) }, at, false, () => ({}));
    rt.addApproval(
      { key, kind: "tool", toolId, tool: "Bash", input: { command: cleanCommand(p.command), cwd: p.cwd }, description: p.reason ?? undefined, canAlways: true, at },
      (d) => reply(d.behavior === "allow" ? (d.always ? "acceptForSession" : "accept") : "decline")
    );
  } else if (msg.method === "item/fileChange/requestApproval" || msg.method === "applyPatchApproval") {
    const toolId = p.itemId ? String(p.itemId) : null;
    const t = toolId ? rt.tool(toolId) : null;
    rt.addApproval(
      { key, kind: "tool", toolId, tool: "Patch", input: t?.input ?? {}, description: p.reason ?? undefined, canAlways: true, at },
      (d) => reply(d.behavior === "allow" ? (d.always ? "acceptForSession" : "accept") : "decline")
    );
  } else if (io.live) {
    io.write({ id: msg.id, error: { code: -32601, message: "Not supported by OpenTerm Threads" } });
  }
}

function threadParams(rt: Runtime): Record<string, unknown> {
  const m = rt.meta;
  return { cwd: m.cwd, model: m.model, ...POLICY[m.mode] };
}

export const codex: Adapter = {
  cli: "codex",
  journalSkip: [
    '"method":"item/agentMessage/delta"',
    '"method":"item/reasoning/summaryTextDelta"',
    '"method":"item/reasoning/textDelta"',
    '"method":"item/reasoning/summaryPartAdded"',
    '"method":"item/commandExecution/outputDelta"',
    '"method":"item/fileChange/outputDelta"',
    '"method":"command/exec/outputDelta"',
    '"method":"item/plan/delta"',
  ],

  args() {
    return ["app-server"];
  },

  started(rt, io) {
    const s = st(rt);
    s.threadReady = false;
    s.pending.clear();
    request(rt, io, "initialize", { clientInfo: { name: "openterm", title: "OpenTerm", version: "1" }, capabilities: null }, () => {
      io.write({ method: "initialized" });
      if (!modelsAsked)
        request(rt, io, "model/list", { limit: 60 }, (res) => {
          const list: any[] = (res?.data ?? []).filter((x: any) => !x.hidden);
          if (!list.length) return;
          modelsAsked = true;
          const one = (mo: any): ModelChoice => {
            const eff: any[] = Array.isArray(mo.supportedReasoningEfforts) ? mo.supportedReasoningEfforts : [];
            return {
              id: mo.model ?? mo.id,
              label: mo.displayName ?? mo.model,
              hint: mo.description,
              efforts: eff.map((e) => String(e.reasoningEffort)),
              effortHints: Object.fromEntries(eff.filter((e) => e.description).map((e) => [String(e.reasoningEffort), String(e.description)])),
              defaultEffort: mo.defaultReasoningEffort ?? undefined,
            };
          };
          const def = list.find((x) => x.isDefault) ?? list[0];
          setModelList("codex", [{ ...one(def), id: null, resolved: def.model ?? def.id, label: "Default", hint: `${def.displayName ?? def.model} · your Codex default` }, ...list.map(one)]);
          rt.emit({ t: "meta" });
        });
      const resume = rt.meta.sessionId && rt.meta.resumable;
      request(rt, io, resume ? "thread/resume" : "thread/start", resume ? { threadId: rt.meta.sessionId, ...threadParams(rt) } : threadParams(rt), (res, err) => {
        if (err || !res?.thread?.id) {
          if (resume) {
            // The saved conversation is gone: start fresh in the same folder.
            rt.meta.resumable = false;
            request(rt, io, "thread/start", threadParams(rt), (r2, e2) => afterThread(rt, io, r2, e2));
            return;
          }
          afterThread(rt, io, res, err);
          return;
        }
        afterThread(rt, io, res, err);
      });
    });
  },

  prompt(rt, io, text, images: PromptImage[]) {
    whenReady(rt, () => {
      const input: any[] = images.map((im) => ({ type: "image", url: `data:${im.mediaType};base64,${im.data}` }));
      if (text) input.push({ type: "text", text, text_elements: [] });
      const params: Record<string, unknown> = { threadId: rt.meta.sessionId, input };
      if (rt.meta.model) params.model = rt.meta.model;
      if (rt.meta.effort) params.effort = rt.meta.effort;
      request(rt, io, "turn/start", params, (_r, err) => {
        if (err) io.endTurn({ ms: 0, tokensIn: 0, tokensOut: 0, cost: null, outcome: "error", error: err.message ?? "Codex refused the message" });
      });
    });
  },

  interrupt(rt, io) {
    const s = st(rt);
    if (!s.turnId) return;
    s.interrupting = true;
    request(rt, io, "turn/interrupt", { threadId: rt.meta.sessionId, turnId: s.turnId });
  },

  setMode() {
    return "restart";
  },

  // Model and effort ride along with every turn/start.
  setModel(_rt, _io, model) {
    return model ? "live" : "restart";
  },

  setEffort(_rt, _io, effort) {
    return effort ? "live" : "restart";
  },

  ingest(rt, io, msg, at) {
    const s = st(rt);
    // Responses to our requests.
    if (msg.id !== undefined && !msg.method) {
      if (msg.result?.thread && typeof msg.result.model === "string") rt.liveModel = msg.result.model;
      const done = s.pending.get(msg.id);
      s.pending.delete(msg.id);
      done?.(msg.result, msg.error);
      return;
    }
    // Requests from the server (approvals).
    if (msg.id !== undefined && msg.method) {
      onServerRequest(rt, io, msg, at);
      return;
    }
    const p = msg.params ?? {};
    switch (msg.method) {
      case "thread/started":
        if (p.thread?.id && !rt.meta.sessionId) rt.meta.sessionId = p.thread.id;
        return;
      case "turn/started":
        s.turnId = p.turn?.id ?? null;
        s.turnUsageIn = 0;
        s.turnUsageOut = 0;
        return;
      case "item/started":
        if (p.item?.type !== "userMessage") mapItem(rt, p.item, at, false);
        return;
      case "item/completed":
        if (p.item?.type !== "userMessage") mapItem(rt, p.item, at, true);
        rt.meta.resumable = true;
        return;
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        let it = rt.items.get(String(p.itemId)) as TextItem | undefined;
        if (!it) it = rt.add({ id: String(p.itemId), kind: "text", parent: null, at, text: "", done: false } as TextItem) as TextItem;
        it.text += p.delta ?? "";
        rt.touch(it.id);
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        let it = rt.items.get(String(p.itemId)) as ThinkingItem | undefined;
        if (!it) it = rt.add({ id: String(p.itemId), kind: "thinking", parent: null, at, text: "", done: false } as ThinkingItem) as ThinkingItem;
        it.text += p.delta ?? "";
        rt.touch(it.id);
        return;
      }
      case "item/commandExecution/outputDelta": {
        const t = rt.tool(String(p.itemId));
        if (t) {
          t.output = ((t.output ?? "") + (p.delta ?? "")).slice(-20000);
          rt.touch(t.id);
        }
        return;
      }
      case "turn/plan/updated":
        rt.todos = (p.plan ?? []).map((x: any) => ({
          text: String(x.step ?? ""),
          status: x.status === "completed" ? "completed" : x.status === "inProgress" ? "in_progress" : "pending",
        }));
        rt.emit({ t: "todos" });
        return;
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage ?? {};
        if (u.modelContextWindow) rt.context.window = u.modelContextWindow;
        const last = u.last ?? {};
        rt.context.used = (last.inputTokens ?? 0) + (last.outputTokens ?? 0);
        const total = u.total ?? {};
        s.turnUsageIn = (total.inputTokens ?? 0) - s.totalIn;
        s.turnUsageOut = (total.outputTokens ?? 0) - s.totalOut;
        rt.emit({ t: "usage" });
        return;
      }
      case "account/rateLimits/updated": {
        const r = p.rateLimits ?? {};
        const win = (w: any, fallback: string) =>
          w
            ? {
                label: w.windowDurationMins ? (w.windowDurationMins >= 1440 ? "Weekly" : `${Math.round(w.windowDurationMins / 60)}-hour window`) : fallback,
                used: Math.max(0, Math.min(1, (w.usedPercent ?? 0) / 100)),
                resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
              }
            : null;
        rt.rate = [win(r.primary, "Primary"), win(r.secondary, "Secondary")].filter(Boolean) as any;
        rt.emit({ t: "usage" });
        return;
      }
      case "turn/completed": {
        const turn = p.turn ?? {};
        const interrupted = s.interrupting || turn.status === "interrupted";
        s.interrupting = false;
        s.turnId = null;
        s.totalIn += s.turnUsageIn;
        s.totalOut += s.turnUsageOut;
        io.endTurn({
          ms: turn.durationMs ?? Date.now() - rt.turnStart,
          tokensIn: Math.max(0, s.turnUsageIn),
          tokensOut: Math.max(0, s.turnUsageOut),
          cost: null,
          outcome: interrupted ? "interrupted" : turn.status === "failed" ? "error" : "done",
          error: turn.status === "failed" ? turn.error?.message ?? "The turn failed" : undefined,
        });
        return;
      }
      case "error":
        if (!p.willRetry) io.notice("error", p.error?.message ?? "Codex reported an error");
        return;
    }
  },
};

function afterThread(rt: Runtime, io: IO, res: any, err: any): void {
  const s = st(rt);
  if (err || !res?.thread?.id) {
    io.notice("error", `Codex couldn't open the conversation: ${err?.message ?? "no thread id"}`);
    io.endTurn({ ms: 0, tokensIn: 0, tokensOut: 0, cost: null, outcome: "error", error: err?.message ?? "Codex couldn't start" });
    return;
  }
  rt.meta.sessionId = res.thread.id;
  if (res.model) rt.liveModel = res.model;
  rt.emit({ t: "meta" });
  s.threadReady = true;
  const queued = s.outbox.splice(0);
  for (const fn of queued) fn();
}
