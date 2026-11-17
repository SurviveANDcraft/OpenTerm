/** The thread manager: owns every thread's runtime, starts and resumes the
 *  agent processes, queues prompts, replays journals and persists the index.
 *  Views only call this and subscribe to changes. */
import { invoke } from "@tauri-apps/api/core";
import { hasSecret } from "../secrets";
import { claude } from "./claude";
import { codex } from "./codex";
import { host, type HostEvent } from "./host";
import type { Adapter, IO, PromptImage, TurnEnd } from "./adapter";
import {
  emptyStats,
  uid,
  type Decision,
  type Harness,
  type PermissionMode,
  type ThreadMeta,
  type TurnItem,
  type UserItem,
} from "./model";
import { Runtime } from "./runtime";
import { mcpConfigFor, toolsSignature } from "./appTools";
import { defaultModel } from "./model";

const ADAPTERS: Record<Harness, Adapter> = { claude, codex };
/** An idle agent process is put to sleep after this long; the next prompt
 *  resumes the same conversation. */
const IDLE_SLEEP_MS = 20 * 60_000;

export interface NewThreadOptions {
  harness: Harness;
  cwd: string;
  model?: string | null;
  mode?: PermissionMode;
}

export interface EngineHooks {
  /** A thread you aren't looking at finished, failed or needs you. */
  onAttention?(rt: Runtime, why: "done" | "error" | "approval"): void;
}

interface Deferred {
  itemId: string;
  text: string;
  images: PromptImage[];
}

function deriveTitle(text: string): string {
  const line = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "New thread";
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,.;:]$/, "") + "…";
}

function normaliseMeta(m: any): ThreadMeta | null {
  if (!m || typeof m.id !== "string" || typeof m.cwd !== "string") return null;
  return {
    id: m.id,
    title: typeof m.title === "string" ? m.title : "Thread",
    titleLocked: !!m.titleLocked,
    harness: m.harness === "codex" ? "codex" : "claude",
    cwd: m.cwd,
    model: typeof m.model === "string" ? m.model : null,
    mode: ["ask", "edits", "plan", "auto"].includes(m.mode) ? m.mode : "ask",
    sessionId: typeof m.sessionId === "string" ? m.sessionId : null,
    resumable: !!m.resumable,
    createdAt: Number(m.createdAt) || Date.now(),
    updatedAt: Number(m.updatedAt) || Date.now(),
    parentId: m.parentId ?? null,
    pinned: !!m.pinned,
    archived: !!m.archived,
    unread: !!m.unread,
    lastOutcome: m.lastOutcome ?? null,
    activity: typeof m.activity === "string" ? m.activity : "",
    stats: { ...emptyStats(), ...(m.stats ?? {}) },
    location: m.location?.kind === "cloud" ? m.location : { kind: "local" },
  };
}

class Engine {
  threads = new Map<string, Runtime>();
  /** The thread on screen; only others get the unread dot and chime. */
  visibleId: string | null = null;
  hooks: EngineHooks = {};
  private ios = new Map<string, IO>();
  private deferred = new Map<string, Deferred[]>();
  private listListeners = new Set<() => void>();
  private listQueued = false;
  private saveTimer = 0;
  private sleepTimers = new Map<string, number>();
  private ready: Promise<void> | null = null;

  init(): Promise<void> {
    this.ready ??= this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    let metas: ThreadMeta[] = [];
    try {
      const raw = await host.loadIndex();
      if (raw) metas = ((JSON.parse(raw)?.threads ?? []) as any[]).map(normaliseMeta).filter((m): m is ThreadMeta => !!m);
    } catch (e) {
      console.error("threads: couldn't read the index", e);
    }
    for (const m of metas) this.adopt(new Runtime(m));
    // A reloaded webview finds its agents still running: re-attach to them.
    for (const id of await host.running()) {
      const rt = this.threads.get(id);
      if (rt) {
        await host.attach(id, (ev) => this.onHostEvent(rt, ev));
        await this.ensureLoaded(rt);
      } else void host.kill(id);
    }
    this.listChanged();
  }

  private adopt(rt: Runtime): void {
    this.threads.set(rt.meta.id, rt);
    let approvals = 0;
    rt.on((c) => {
      if (c.t === "approvals") {
        const n = rt.approvals.length;
        if (n > approvals && rt.meta.id !== this.visibleId && this.io(rt).live) {
          rt.meta.unread = true;
          this.hooks.onAttention?.(rt, "approval");
        }
        approvals = n;
      }
      if (c.t === "status" || c.t === "meta" || c.t === "approvals") {
        this.listChanged();
        if (c.t === "meta") this.saveSoon();
      }
    });
  }

  // ------------------------------------------------------------ queries

  list(): Runtime[] {
    return [...this.threads.values()];
  }

  get(id: string | null | undefined): Runtime | null {
    return (id && this.threads.get(id)) || null;
  }

  onList(fn: () => void): () => void {
    this.listListeners.add(fn);
    return () => this.listListeners.delete(fn);
  }

  /** Coalesced to one notification per frame: streaming fires many changes. */
  listChanged(): void {
    if (this.listQueued) return;
    this.listQueued = true;
    requestAnimationFrame(() => {
      this.listQueued = false;
      for (const fn of this.listListeners) fn();
    });
  }

  adapter(rt: Runtime): Adapter {
    return ADAPTERS[rt.meta.harness];
  }

  queued(rt: Runtime): number {
    return this.deferred.get(rt.meta.id)?.length ?? 0;
  }

  // ------------------------------------------------------------ lifecycle

  create(opts: NewThreadOptions): Runtime {
    const now = Date.now();
    const meta: ThreadMeta = {
      id: uid("th"),
      title: "New thread",
      harness: opts.harness,
      cwd: opts.cwd,
      model: opts.model ?? defaultModel(opts.harness),
      mode: opts.mode ?? "ask",
      sessionId: null,
      resumable: false,
      createdAt: now,
      updatedAt: now,
      stats: emptyStats(),
      location: { kind: "local" },
      activity: "",
    };
    const rt = new Runtime(meta);
    rt.loaded = true;
    this.adopt(rt);
    this.saveSoon();
    this.listChanged();
    return rt;
  }

  async ensureLoaded(rt: Runtime): Promise<void> {
    if (rt.loaded) return;
    rt.loaded = true;
    const text = await host.readJournal(rt.meta.id);
    const adapter = this.adapter(rt);
    const io = this.io(rt);
    rt.reset();
    rt.replaying = true;
    try {
      for (const line of text.split("\n")) {
        if (!line) continue;
        let r: any;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        const at = Number(r.t) || rt.meta.createdAt;
        rt.a.clock = at;
        try {
          if (r.o !== undefined) adapter.ingest(rt, io, r.o, at);
          else if (r.u !== undefined) this.applyRecord(rt, r.u, at);
          else if ("x" in r) this.processGone(rt, at, true);
        } catch (e) {
          console.warn("threads: skipped a journal record", e);
        }
      }
    } finally {
      rt.replaying = false;
    }
    const alive = (await host.running()).includes(rt.meta.id);
    if (alive) rt.run = rt.busy ? "running" : "ready";
    else {
      rt.run = "sleeping";
      if (rt.busy || rt.approvals.length) this.processGone(rt, Date.now(), true);
      rt.settle();
      rt.busy = false;
    }
    rt.emit({ t: "reset" });
    this.listChanged();
  }

  /** Records the webview itself journaled (prompts, decisions). Shared by
   *  live sending and replay so both build the same items. */
  private applyRecord(rt: Runtime, u: any, at: number): void {
    switch (u.type) {
      case "prompt": {
        const queued = rt.busy;
        const files = Array.isArray(u.files) ? u.files.map(String) : undefined;
        rt.add({ id: u.id, kind: "user", parent: null, at, text: u.text ?? "", images: [], files, queued } as UserItem);
        if (!queued) this.beginTurn(rt, at);
        break;
      }
      case "dispatch": {
        const it = rt.items.get(u.id);
        if (it?.kind === "user") {
          it.queued = false;
          it.at = at;
          rt.order = rt.order.filter((x) => x !== it.id).concat(it.id);
        }
        this.beginTurn(rt, at);
        break;
      }
      case "cancel": {
        rt.items.delete(u.id);
        rt.order = rt.order.filter((id) => id !== u.id);
        rt.emit({ t: "reset" });
        break;
      }
      case "decision":
        rt.dropApproval(u.key);
        break;
      case "notice":
        rt.add({ id: u.id ?? uid("n"), kind: "notice", parent: null, at, tone: u.tone ?? "info", text: u.text ?? "" });
        break;
    }
  }

  private beginTurn(rt: Runtime, at: number): void {
    rt.busy = true;
    rt.turnStart = at;
    rt.turnTools = 0;
    rt.meta.activity = "Thinking";
    rt.meta.lastOutcome = null;
    rt.emit({ t: "status" });
  }

  private io(rt: Runtime): IO {
    let io = this.ios.get(rt.meta.id);
    if (!io) {
      const self = this;
      io = {
        get live() {
          return !rt.replaying;
        },
        write(msg) {
          if (rt.replaying || rt.run === "sleeping") return;
          host.write(rt.meta.id, msg).catch((e) => self.notice(rt, "error", String(e)));
        },
        endTurn(t) {
          self.endTurn(rt, t);
        },
        notice(tone, text) {
          self.notice(rt, tone, text);
        },
      };
      this.ios.set(rt.meta.id, io);
    }
    return io;
  }

  private notice(rt: Runtime, tone: "info" | "warn" | "error", text: string): void {
    rt.add({ id: uid("n"), kind: "notice", parent: null, at: rt.a.clock ?? Date.now(), tone, text });
  }

  private endTurn(rt: Runtime, t: TurnEnd): void {
    const at = rt.replaying ? rt.a.clock ?? Date.now() : Date.now();
    if (!rt.busy && t.outcome === "done" && !t.ms) return;
    const turn: TurnItem = {
      id: uid("turn"),
      kind: "turn",
      parent: null,
      at,
      ms: Math.max(0, t.ms),
      tools: rt.turnTools,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      cost: t.cost,
      outcome: t.outcome,
      error: t.error,
    };
    rt.add(turn);
    const s = rt.meta.stats;
    s.turns++;
    s.tools += rt.turnTools;
    s.tokensIn += t.tokensIn;
    s.tokensOut += t.tokensOut;
    s.cost += t.cost ?? 0;
    s.ms += turn.ms;
    rt.turnTools = 0;
    if (t.outcome !== "done") {
      for (const it of rt.items.values())
        if (it.kind === "tool" && (it.status === "running" || it.status === "streaming")) {
          it.status = "stopped";
          it.endAt = at;
          rt.touch(it.id);
        }
    }
    if (rt.approvals.length) {
      // A finished turn can't still be waiting on anything.
      for (const a of [...rt.approvals]) rt.dropApproval(a.key);
    }
    rt.meta.lastOutcome = t.outcome;
    const files = rt.files.size;
    rt.meta.activity =
      t.outcome === "error"
        ? t.error?.split("\n")[0].slice(0, 90) ?? "Failed"
        : t.outcome === "interrupted"
          ? "Stopped"
          : files
            ? `Changed ${files} file${files === 1 ? "" : "s"}`
            : "Done";
    rt.meta.updatedAt = at;
    rt.busy = false;
    rt.emit({ t: "status" });
    rt.emit({ t: "meta" });
    if (rt.replaying) return;

    const next = this.deferred.get(rt.meta.id)?.shift();
    if (next) {
      void this.dispatch(rt, next);
      return;
    }
    if (rt.meta.id !== this.visibleId) {
      rt.meta.unread = true;
      this.hooks.onAttention?.(rt, t.outcome === "error" ? "error" : "done");
    }
    if (rt.a.restartAfterTurn) {
      rt.a.restartAfterTurn = false;
      void this.sleep(rt);
    } else this.armSleep(rt);
    this.saveSoon();
  }

  private armSleep(rt: Runtime): void {
    clearTimeout(this.sleepTimers.get(rt.meta.id));
    this.sleepTimers.set(
      rt.meta.id,
      window.setTimeout(() => {
        if (!rt.busy && !rt.approvals.length) void this.sleep(rt);
      }, IDLE_SLEEP_MS)
    );
  }

  /** Ends the process on purpose; the conversation resumes on the next prompt. */
  /** OpenTerm's tools changed since this idle agent started (a setting, or
   *  a newer app): restart it before the turn, resuming the conversation, so
   *  it has them. Waits for the old process to be gone first. */
  private async refreshTools(rt: Runtime): Promise<void> {
    if (rt.busy || rt.run !== "ready" || this.adapter(rt).cli !== "claude") return;
    if (rt.a.toolsSig === undefined || rt.a.toolsSig === toolsSignature()) return;
    await this.sleep(rt);
    for (let i = 0; i < 100 && rt.a.expectExit; i++) await new Promise((r) => setTimeout(r, 30));
  }

  async sleep(rt: Runtime): Promise<void> {
    clearTimeout(this.sleepTimers.get(rt.meta.id));
    if (rt.run === "sleeping") return;
    rt.a.expectExit = true;
    await host.kill(rt.meta.id);
    rt.run = "sleeping";
    rt.emit({ t: "status" });
  }

  private processGone(rt: Runtime, at: number, replay: boolean): void {
    const unexpected = rt.busy && !rt.a.expectExit;
    rt.a.expectExit = false;
    if (unexpected) {
      const tail = rt.stderr.slice(-4).join("\n").trim();
      if (!replay) this.notice(rt, "error", tail ? `The agent stopped unexpectedly:\n${tail}` : "The agent stopped unexpectedly.");
      rt.a.clock = at;
      this.endTurn(rt, { ms: at - rt.turnStart, tokensIn: 0, tokensOut: 0, cost: null, outcome: "error", error: "The agent process ended" });
    }
    rt.settle();
    rt.busy = false;
  }

  private onHostEvent(rt: Runtime, ev: HostEvent): void {
    if (ev.kind === "out" && ev.line) {
      let msg: any;
      try {
        msg = JSON.parse(ev.line);
      } catch {
        return;
      }
      rt.a.clock = Date.now();
      try {
        this.adapter(rt).ingest(rt, this.io(rt), msg, Date.now());
      } catch (e) {
        console.error("threads: couldn't handle a message", e, msg);
      }
    } else if (ev.kind === "err" && ev.line) {
      rt.stderr.push(ev.line);
      if (rt.stderr.length > 40) rt.stderr.splice(0, rt.stderr.length - 40);
    } else if (ev.kind === "exit") {
      rt.run = "sleeping";
      this.processGone(rt, Date.now(), false);
      this.deferred.delete(rt.meta.id);
      rt.emit({ t: "status" });
      this.saveSoon();
    }
  }

  private async ensureProcess(rt: Runtime): Promise<void> {
    if (rt.run !== "sleeping") {
      while (rt.run === "starting") await new Promise((r) => setTimeout(r, 30));
      if ((rt.run as string) !== "sleeping") return;
    }
    rt.run = "starting";
    rt.emit({ t: "status" });
    const adapter = this.adapter(rt);
    try {
      await host.attach(rt.meta.id, (ev) => this.onHostEvent(rt, ev));
      if (adapter.cli === "claude") {
        rt.a.toolsSig = toolsSignature();
        rt.a.mcp = await mcpConfigFor(rt.meta.id);
      }
      const args = adapter.args(rt);
      rt.stderr = [];
      await host.spawn(rt.meta.id, adapter.cli, args, rt.meta.cwd, adapter.journalSkip);
      rt.run = "ready";
      this.saveSoon();
      adapter.started(rt, this.io(rt));
    } catch (e) {
      rt.run = "sleeping";
      rt.emit({ t: "status" });
      throw e;
    }
  }

  // ------------------------------------------------------------ actions

  async send(rt: Runtime, text: string, images: PromptImage[] = [], thumbs: string[] = [], files: string[] = [], extra = ""): Promise<void> {
    await this.ensureLoaded(rt);
    text = text.trim();
    if (!text && !images.length && !files.length) return;
    const at = Date.now();
    const id = uid("u");
    const queued = rt.busy;
    rt.add({ id, kind: "user", parent: null, at, text, images: thumbs, files: files.length ? files : undefined, queued } as UserItem);
    void host.append(rt.meta.id, { type: "prompt", id, text, images: images.length, ...(files.length ? { files } : {}) });
    if (!rt.meta.titleLocked && rt.order.filter((i) => rt.items.get(i)?.kind === "user").length === 1) {
      rt.meta.title = deriveTitle(text || files.map((f) => f.split(/[\\/]/).pop()).join(", "));
    }
    const first = rt.order.filter((i) => rt.items.get(i)?.kind === "user").length === 1;
    if (first && !rt.meta.titleLocked && text) void this.aiTitle(rt, false);
    rt.meta.updatedAt = at;
    rt.meta.archived = false;
    rt.emit({ t: "meta" });
    clearTimeout(this.sleepTimers.get(rt.meta.id));
    // Files go along as paths: both agents open them with their own tools
    // (Claude Code reads PDFs, images and notebooks natively).
    const prompt = files.length
      ? `${text}${text ? "\n\n" : ""}Attached file${files.length > 1 ? "s" : ""} (read ${files.length > 1 ? "them" : "it"} from disk):\n${files.map((f) => `- ${f}`).join("\n")}`
      : text;
    const job = { itemId: id, text: prompt + extra, images };
    if (queued) {
      const q = this.deferred.get(rt.meta.id) ?? [];
      q.push(job);
      this.deferred.set(rt.meta.id, q);
      rt.emit({ t: "status" });
      return;
    }
    await this.refreshTools(rt);
    this.beginTurn(rt, at);
    await this.run(rt, job);
  }

  private async dispatch(rt: Runtime, job: Deferred): Promise<void> {
    const it = rt.items.get(job.itemId);
    if (it?.kind === "user") {
      it.queued = false;
      it.at = Date.now();
      rt.order = rt.order.filter((x) => x !== it.id).concat(it.id);
      rt.emit({ t: "reset" });
    }
    void host.append(rt.meta.id, { type: "dispatch", id: job.itemId });
    await this.refreshTools(rt);
    this.beginTurn(rt, Date.now());
    await this.run(rt, job);
  }

  private async run(rt: Runtime, job: Deferred): Promise<void> {
    try {
      await this.ensureProcess(rt);
      this.adapter(rt).prompt(rt, this.io(rt), job.text, job.images);
    } catch (e) {
      this.notice(rt, "error", String(e));
      this.endTurn(rt, { ms: 0, tokensIn: 0, tokensOut: 0, cost: null, outcome: "error", error: String(e) });
    }
  }

  /** Drops a prompt that is still waiting in the queue. */
  cancelQueued(rt: Runtime, itemId: string): void {
    const q = this.deferred.get(rt.meta.id);
    if (!q) return;
    const i = q.findIndex((j) => j.itemId === itemId);
    if (i < 0) return;
    q.splice(i, 1);
    void host.append(rt.meta.id, { type: "cancel", id: itemId });
    rt.items.delete(itemId);
    rt.order = rt.order.filter((id) => id !== itemId);
    rt.emit({ t: "reset" });
  }

  interrupt(rt: Runtime): void {
    if (!rt.busy) return;
    if (rt.run === "sleeping") {
      rt.busy = false;
      rt.emit({ t: "status" });
      return;
    }
    // Answer anything pending first: the harness waits on it.
    for (const a of [...rt.approvals]) this.decide(rt, a.key, { behavior: "deny", message: "The user stopped the turn." });
    this.deferred.delete(rt.meta.id);
    const at = Date.now();
    rt.a.interruptAt = at;
    this.adapter(rt).interrupt(rt, this.io(rt));
    // A harness that ignores the interrupt still has to stop.
    const id = rt.meta.id;
    window.setTimeout(() => {
      const cur = this.threads.get(id);
      if (cur?.busy && cur.a.interruptAt === at) {
        this.notice(cur, "warn", "The agent didn't stop in time, so it was ended.");
        void this.sleep(cur).then(() => {
          if (cur.busy) this.endTurn(cur, { ms: Date.now() - cur.turnStart, tokensIn: 0, tokensOut: 0, cost: null, outcome: "interrupted" });
        });
      }
    }, 8000);
  }

  decide(rt: Runtime, key: string, d: Decision): void {
    const respond = rt.responders.get(key);
    if (!respond) return;
    respond(d);
    void host.append(rt.meta.id, { type: "decision", key, behavior: d.behavior });
    rt.dropApproval(key);
  }

  async setMode(rt: Runtime, mode: PermissionMode): Promise<void> {
    if (rt.meta.mode === mode) return;
    rt.meta.mode = mode;
    rt.emit({ t: "meta" });
    if (rt.run === "sleeping") return;
    if (this.adapter(rt).setMode(rt, this.io(rt), mode) === "restart") {
      if (rt.busy) rt.a.restartAfterTurn = true;
      else await this.sleep(rt);
    }
  }

  async setModel(rt: Runtime, model: string | null): Promise<void> {
    if (rt.meta.model === model) return;
    rt.meta.model = model;
    rt.emit({ t: "meta" });
    if (rt.run === "sleeping") return;
    if (this.adapter(rt).setModel(rt, this.io(rt), model) === "restart") {
      if (rt.busy) rt.a.restartAfterTurn = true;
      else await this.sleep(rt);
    }
  }

  async setEffort(rt: Runtime, effort: string | null): Promise<void> {
    if ((rt.meta.effort ?? null) === effort) return;
    rt.meta.effort = effort;
    rt.emit({ t: "meta" });
    if (rt.run === "sleeping") return;
    if (this.adapter(rt).setEffort(rt, this.io(rt), effort) === "restart") {
      if (rt.busy) rt.a.restartAfterTurn = true;
      else await this.sleep(rt);
    }
  }

  setHarness(rt: Runtime, harness: Harness): void {
    // Only before the first prompt: a conversation can't change harness.
    if (rt.order.length || rt.meta.harness === harness) return;
    rt.meta.harness = harness;
    rt.meta.model = defaultModel(harness);
    rt.meta.effort = null;
    rt.meta.sessionId = null;
    rt.emit({ t: "meta" });
  }

  setCwd(rt: Runtime, cwd: string): void {
    if (rt.order.length) return;
    rt.meta.cwd = cwd;
    rt.emit({ t: "meta" });
  }

  /** True while an AI title is being written for this thread. */
  naming = new Set<string>();

  /** Names the thread with the OpenRouter key, if one is saved. Silent on
   *  failure: the first-message title stays. `lock` = the user asked for it. */
  async aiTitle(rt: Runtime, lock: boolean): Promise<boolean> {
    if (this.naming.has(rt.meta.id)) return false;
    if (!hasSecret("openrouter")) {
      if (lock) this.notice(rt, "warn", "Naming with AI needs an OpenRouter key: add one in Settings → AI.");
      return false;
    }
    await this.ensureLoaded(rt);
    const users: string[] = [];
    const replies: string[] = [];
    for (const id of rt.order) {
      const it = rt.items.get(id);
      if (it?.kind === "user" && it.text) users.push(it.text);
      else if (it?.kind === "text" && !it.parent && it.text) replies.push(it.text);
    }
    if (!users.length) return false;
    const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);
    let context = `First message:\n${clip(users[0], 1200)}`;
    if (lock) {
      if (users.length > 1) context += `\n\nLater messages:\n${users.slice(1).slice(-3).map((u) => `- ${clip(u, 240)}`).join("\n")}`;
      if (replies.length) context += `\n\nAgent's latest reply:\n${clip(replies[replies.length - 1], 600)}`;
    }
    this.naming.add(rt.meta.id);
    rt.emit({ t: "meta" });
    try {
      const title = (await invoke<string>("name_thread", { context })).trim();
      // The user may have typed a name meanwhile.
      if (!title || (!lock && rt.meta.titleLocked)) return false;
      rt.meta.title = title.slice(0, 120);
      if (lock) rt.meta.titleLocked = true;
      return true;
    } catch (e) {
      console.warn("threads: AI title failed", e);
      if (lock) this.notice(rt, "warn", `Couldn't name this thread with AI: ${String(e)}`);
      return false;
    } finally {
      this.naming.delete(rt.meta.id);
      rt.emit({ t: "meta" });
    }
  }

  rename(rt: Runtime, title: string): void {
    const t = title.trim();
    if (!t) return;
    rt.meta.title = t.slice(0, 120);
    rt.meta.titleLocked = true;
    rt.emit({ t: "meta" });
  }

  patch(rt: Runtime, p: Partial<Pick<ThreadMeta, "pinned" | "archived" | "unread">>): void {
    Object.assign(rt.meta, p);
    rt.emit({ t: "meta" });
  }

  markSeen(rt: Runtime | null): void {
    this.visibleId = rt?.meta.id ?? null;
    if (rt?.meta.unread) this.patch(rt, { unread: false });
  }

  async remove(rt: Runtime): Promise<void> {
    clearTimeout(this.sleepTimers.get(rt.meta.id));
    rt.a.expectExit = true;
    host.detach(rt.meta.id);
    await host.deleteJournal(rt.meta.id);
    this.threads.delete(rt.meta.id);
    this.ios.delete(rt.meta.id);
    this.deferred.delete(rt.meta.id);
    this.saveSoon();
    this.listChanged();
  }

  /** Stops the headless process so the same conversation can continue in a
   *  terminal pane (`claude --resume` / `codex resume`). */
  async handoff(rt: Runtime): Promise<{ agent: string; sessionId: string; cwd: string } | null> {
    if (!rt.meta.sessionId || !rt.meta.resumable) return null;
    if (rt.busy) this.interrupt(rt);
    await this.sleep(rt);
    return { agent: rt.meta.harness, sessionId: rt.meta.sessionId, cwd: rt.meta.cwd };
  }

  saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const threads = [...this.threads.values()].map((r) => r.meta);
      host.saveIndex(JSON.stringify({ version: 1, threads })).catch((e) => console.error("threads: save failed", e));
    }, 400);
  }
}

export const engine = new Engine();
export type { Runtime };
