/** One thread's live state: its items, run state, approvals and stats.
 *  Adapters write into it; the view subscribes to its changes. */
import type {
  Approval,
  Decision,
  Item,
  RateWindow,
  RunState,
  SlashCommand,
  ThreadMeta,
  Todo,
  ToolItem,
} from "./model";

export type Change =
  | { t: "item"; id: string; added?: boolean }
  | { t: "status" }
  | { t: "meta" }
  | { t: "approvals" }
  | { t: "todos" }
  | { t: "usage" }
  | { t: "reset" };

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  kind: "edit" | "create" | "delete";
  /** Tool items that touched it, newest last. */
  tools: string[];
}

export class Runtime {
  meta: ThreadMeta;
  items = new Map<string, Item>();
  /** Top-level item ids in conversation order. */
  order: string[] = [];
  run: RunState = "sleeping";
  /** A turn is in progress (the agent is working). */
  busy = false;
  approvals: Approval[] = [];
  responders = new Map<string, (d: Decision) => void>();
  todos: Todo[] | null = null;
  context = { used: 0, window: 200_000 };
  rate: RateWindow[] = [];
  commands: SlashCommand[] = [];
  /** The model the harness reported it is actually using. */
  liveModel: string | null = null;
  files = new Map<string, FileChange>();
  turnStart = 0;
  turnTools = 0;
  /** Prompts sent while a turn was running, waiting their turn. */
  queue: string[] = [];
  loaded = false;
  replaying = false;
  stderr: string[] = [];
  /** Adapter-private state. */
  a: Record<string, any> = {};
  private listeners = new Set<(c: Change) => void>();

  constructor(meta: ThreadMeta) {
    this.meta = meta;
  }

  on(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(c: Change): void {
    if (this.replaying) return;
    for (const fn of this.listeners) fn(c);
  }

  get waiting(): boolean {
    return this.approvals.length > 0;
  }

  add(item: Item): Item {
    if (this.items.has(item.id)) return this.items.get(item.id)!;
    this.items.set(item.id, item);
    const parent = item.parent ? this.items.get(item.parent) : null;
    if (parent && parent.kind === "tool") {
      parent.children.push(item.id);
      this.emit({ t: "item", id: parent.id });
    } else {
      item.parent = parent ? item.parent : null;
      this.order.push(item.id);
    }
    this.emit({ t: "item", id: item.id, added: true });
    return item;
  }

  touch(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.emit({ t: "item", id });
    // A sub-agent's progress also changes how its parent card reads.
    if (item.parent) this.emit({ t: "item", id: item.parent });
  }

  tool(id: string): ToolItem | null {
    const it = this.items.get(id);
    return it && it.kind === "tool" ? it : null;
  }

  /** The newest top-level user prompt still marked queued. */
  dequeueUser(): void {
    for (const id of this.order) {
      const it = this.items.get(id);
      if (it?.kind === "user" && it.queued) {
        it.queued = false;
        this.touch(id);
        return;
      }
    }
  }

  addApproval(a: Approval, respond: (d: Decision) => void): void {
    this.approvals = this.approvals.filter((x) => x.key !== a.key).concat(a);
    this.responders.set(a.key, respond);
    if (a.toolId) {
      const t = this.tool(a.toolId);
      if (t) {
        t.status = "waiting";
        this.touch(t.id);
      }
    }
    this.emit({ t: "approvals" });
    this.emit({ t: "status" });
  }

  dropApproval(key: string): Approval | null {
    const a = this.approvals.find((x) => x.key === key) ?? null;
    if (!a) return null;
    this.approvals = this.approvals.filter((x) => x.key !== key);
    this.responders.delete(key);
    if (a.toolId) {
      const t = this.tool(a.toolId);
      if (t && t.status === "waiting") {
        t.status = "running";
        this.touch(t.id);
      }
    }
    this.emit({ t: "approvals" });
    this.emit({ t: "status" });
    return a;
  }

  /** After the process is gone: nothing can still be running or waiting. */
  settle(status: "stopped" | "done" = "stopped"): void {
    for (const it of this.items.values()) {
      if (it.kind === "tool" && (it.status === "running" || it.status === "waiting" || it.status === "streaming")) {
        it.status = status;
        it.endAt ??= Date.now();
        this.touch(it.id);
      } else if ((it.kind === "text" || it.kind === "thinking") && !it.done) {
        it.done = true;
        this.touch(it.id);
      }
    }
    for (const it of this.items.values()) if (it.kind === "user" && it.queued) it.queued = false;
    this.queue = [];
    if (this.approvals.length) {
      this.approvals = [];
      this.responders.clear();
      this.emit({ t: "approvals" });
    }
  }

  noteFile(path: string, added: number, removed: number, kind: FileChange["kind"], toolId: string): void {
    const prev = this.files.get(path);
    if (prev) {
      prev.added += added;
      prev.removed += removed;
      if (kind === "delete") prev.kind = "delete";
      prev.tools.push(toolId);
    } else this.files.set(path, { path, added, removed, kind, tools: [toolId] });
    this.meta.stats.files = this.files.size;
  }

  reset(): void {
    this.items.clear();
    this.order = [];
    this.approvals = [];
    this.responders.clear();
    this.todos = null;
    this.files.clear();
    this.queue = [];
    this.busy = false;
  }
}

/** Counts +/- lines in a unified diff or Claude's structuredPatch. */
export function diffCounts(patch: unknown): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const count = (line: string) => {
    if (line.startsWith("+++") || line.startsWith("---")) return;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  };
  if (typeof patch === "string") patch.split("\n").forEach(count);
  else if (Array.isArray(patch)) for (const h of patch) (h?.lines ?? []).forEach((l: string) => count(String(l)));
  return { added, removed };
}

export function lineCount(text: unknown): number {
  if (typeof text !== "string" || !text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
