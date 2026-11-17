/** Threads mode as a whole: the Panes ⇄ Threads switch at the top of the
 *  sidebar, the threads sidebar, the thread view, and the glue to the rest of
 *  the app (folder picker, file viewer, terminals, chime). main.ts only
 *  creates it and forwards a few actions. */
import "./threads.css";
import { engine, type Runtime } from "./engine";
import { createThreadsSidebar, statusOf } from "./sidebar";
import { createThreadView } from "./view";
import { openMenu } from "./menu";
import { hasSecret } from "../secrets";
import { folderLabel } from "../folderLaunch";
import { threadsSettings } from "./toolGroups";
import type { Harness } from "./model";

export type WorkspaceMode = "panes" | "threads";

export interface ThreadsModeHost {
  sidebarEl: HTMLElement;
  mainEl: HTMLElement;
  appEl: HTMLElement;
  /** The folder a new thread starts in (the active session's, usually). */
  defaultCwd(): string | null;
  pickFolder(current: string | null): Promise<string | null>;
  openFile(path: string): void;
  openUrl(url: string): void;
  /** Continue a conversation in a terminal pane (switches to Panes). */
  resumeInTerminal(agent: string, sessionId: string, cwd: string): void;
  confirm(opts: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
  chime(): void;
  chord(action: "toggleWorkspace" | "newSession"): string;
  onModeChange(mode: WorkspaceMode): void;
}

const MODE_KEY = "openterm.workspaceMode";
const LAST_KEY = "openterm.threads.last";
const HARNESS_KEY = "openterm.threads.harness";

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* per-viewer convenience only */
  }
}

export function createThreadsMode(host: ThreadsModeHost) {
  let mode: WorkspaceMode = load(MODE_KEY) === "threads" ? "threads" : "panes";
  let activeId: string | null = load(LAST_KEY);

  // ---------------------------------------------------------------- switch
  // Threads is a third tab in the sidebar's own toggle: Sessions | Threads |
  // Files. Sessions and Threads decide what the main area shows; Files stays
  // a sidebar view on top of either, so files can be browsed beside a chat.

  const toggle = host.sidebarEl.querySelector<HTMLElement>(".sidebar-mode-toggle")!;
  const [sessionsTab, filesTab] = Array.from(toggle.querySelectorAll<HTMLElement>(".sidebar-mode-btn"));
  const threadsTab = document.createElement("button");
  threadsTab.className = "sidebar-mode-btn threads-tab";
  threadsTab.type = "button";
  threadsTab.innerHTML = `Threads<span class="ws-badge" hidden></span>`;
  toggle.insertBefore(threadsTab, filesTab);
  toggle.classList.add("three");
  const badge = threadsTab.querySelector<HTMLElement>(".ws-badge")!;
  let syncing = false;
  sessionsTab.addEventListener("click", () => {
    if (!syncing) void setMode("panes");
  });
  threadsTab.addEventListener("click", () => {
    if (toggle.classList.contains("files")) {
      // Leave Files through the sidebar's own handler, then take over.
      syncing = true;
      sessionsTab.click();
      syncing = false;
    }
    void setMode("threads");
    syncTabs();
  });
  new MutationObserver(syncTabs).observe(toggle, { attributes: true, attributeFilter: ["class"] });

  function syncTabs(): void {
    const files = toggle.classList.contains("files");
    toggle.classList.toggle("threads", mode === "threads" && !files);
    sessionsTab.classList.toggle("active", mode === "panes" && !files);
    threadsTab.classList.toggle("active", mode === "threads" && !files);
  }

  // ---------------------------------------------------------------- parts

  const sidebar = createThreadsSidebar({
    onSelect: (id, item) => void select(id, item),
    onNew: (cwd) => void newThread(cwd),
    onMenu: (id, anchor) => threadMenu(id, anchor),
    newChord: () => host.chord("newSession"),
  });

  const view = createThreadView({
    onOpenFile: host.openFile,
    onOpenUrl: host.openUrl,
    onContinueInTerminal: (rt) => void continueInTerminal(rt),
    onPickFolder: host.pickFolder,
    onThreadMenu: (id, anchor) => threadMenu(id, anchor, true),
    onNewThread: () => void newThread(),
  });

  // The threads list takes the sessions list's place while Threads is on.
  const foot = host.sidebarEl.querySelector(".sidebar-foot");
  host.sidebarEl.insertBefore(sidebar.el, foot);
  // Behind Settings and the file viewer, which float over the work area.
  const empty = host.mainEl.querySelector(".empty-state");
  host.mainEl.insertBefore(view.el, empty ? empty.nextSibling : host.mainEl.firstChild);

  engine.hooks.onAttention = (rt, why) => {
    host.chime();
    void why;
    void rt;
    refreshBadge();
  };
  engine.onList(refreshBadge);

  function refreshBadge(): void {
    const all = engine.list();
    const waiting = all.filter((r) => r.approvals.length).length;
    const working = all.filter((r) => r.busy && !r.approvals.length).length;
    const unread = all.filter((r) => r.meta.unread && !r.busy).length;
    const n = waiting || unread;
    badge.hidden = (mode === "threads" && !toggle.classList.contains("files")) || (!n && !working);
    badge.className = `ws-badge ${waiting ? "is-wait" : unread ? "is-unread" : "is-work"}`;
    badge.textContent = waiting ? String(waiting) : unread ? String(unread) : "";
    badge.title = waiting ? `${waiting} waiting for you` : unread ? `${unread} finished` : `${working} working`;
  }

  // ---------------------------------------------------------------- actions

  function apply(): void {
    host.appEl.classList.toggle("mode-threads", mode === "threads");
    syncTabs();
    const chord = host.chord("toggleWorkspace");
    threadsTab.title = `Agents as conversations${chord ? ` (${chord} switches)` : ""}`;
    refreshBadge();
  }

  async function setMode(next: WorkspaceMode): Promise<void> {
    if (next === mode) return;
    mode = next;
    save(MODE_KEY, mode);
    apply();
    host.appEl.classList.add("mode-switching");
    window.setTimeout(() => host.appEl.classList.remove("mode-switching"), 260);
    if (mode === "threads") {
      await engine.init();
      if (!engine.get(activeId)) activeId = mostRecent()?.meta.id ?? null;
      if (activeId) await select(activeId);
      else await newThread();
      view.focusComposer();
    } else engine.markSeen(null);
    host.onModeChange(mode);
  }

  function mostRecent(): Runtime | null {
    return engine.list().filter((r) => !r.meta.archived).sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)[0] ?? null;
  }

  async function select(id: string, item?: string): Promise<void> {
    activeId = id;
    save(LAST_KEY, id);
    sidebar.setActive(id);
    await view.show(id, item);
    if (!item) view.focusComposer();
  }

  /** Reuses an untouched new thread for the same folder instead of piling
   *  up empty ones. */
  async function newThread(cwd?: string): Promise<void> {
    await engine.init();
    const folder = cwd ?? host.defaultCwd() ?? engine.get(activeId)?.meta.cwd ?? mostRecent()?.meta.cwd ?? null;
    const dir = folder ?? (await host.pickFolder(null));
    if (!dir) return;
    const harness = (load(HARNESS_KEY) as Harness) === "codex" ? "codex" : "claude";
    const blank = engine.list().find((r) => !r.order.length && r.loaded && !r.meta.stats.turns && r.meta.cwd.toLowerCase() === dir.toLowerCase());
    const rt = blank ?? engine.create({ harness, cwd: dir, mode: engine.get(activeId)?.meta.mode ?? "ask" });
    if (mode !== "threads") {
      mode = "threads";
      save(MODE_KEY, mode);
      apply();
      host.onModeChange(mode);
    }
    await select(rt.meta.id);
  }

  async function continueInTerminal(rt: Runtime): Promise<void> {
    const h = await engine.handoff(rt);
    if (!h) return;
    await setMode("panes");
    host.resumeInTerminal(h.agent, h.sessionId, h.cwd);
  }

  async function remove(rt: Runtime): Promise<void> {
    const ok = await host.confirm({
      title: `Delete “${rt.meta.title}”?`,
      message: "The thread and its history in OpenTerm are removed. The agent's own copy of the conversation stays on disk.",
      confirmLabel: "Delete thread",
      danger: true,
    });
    if (!ok) return;
    const wasActive = activeId === rt.meta.id;
    await engine.remove(rt);
    if (wasActive) {
      const next = mostRecent();
      if (next) await select(next.meta.id);
      else {
        activeId = null;
        await view.show(null);
        await newThread(rt.meta.cwd);
      }
    }
  }

  function threadMenu(id: string, anchor: HTMLElement, fromHeader = false): void {
    const rt = engine.get(id);
    if (!rt) return;
    const m = rt.meta;
    openMenu(
      anchor,
      [
        { id: "rename", label: "Rename", icon: "pencil" },
        {
          id: "ai-rename",
          label: engine.naming.has(id) ? "Naming…" : "Rename with AI",
          icon: "sparkle",
          disabled: engine.naming.has(id) || (!m.stats.turns && !rt.order.some((x) => rt.items.get(x)?.kind === "user")),
          hint: hasSecret("openrouter") ? undefined : "Add an OpenRouter key in Settings",
        },
        { id: "pin", label: m.pinned ? "Unpin" : "Pin to top", icon: "pin" },
        { id: "terminal", label: "Open in terminal", icon: "terminalWindow", disabled: !(m.resumable && m.sessionId), hint: "Continue in a pane" },
        { id: "sleep", label: "Stop the agent process", icon: "stop", disabled: rt.run === "sleeping", hint: "It resumes on your next message" },
        { id: "", label: "", sep: true },
        { id: "archive", label: m.archived ? "Unarchive" : "Archive", icon: "archive" },
        { id: "delete", label: "Delete", icon: "trash", danger: true },
      ],
      (what) => {
        if (what === "rename") {
          if (activeId !== id) void select(id).then(() => view.startRename());
          else view.startRename();
        } else if (what === "ai-rename") void engine.aiTitle(rt, true);
        else if (what === "pin") engine.patch(rt, { pinned: !m.pinned });
        else if (what === "terminal") void continueInTerminal(rt);
        else if (what === "sleep") void engine.sleep(rt);
        else if (what === "archive") {
          engine.patch(rt, { archived: !m.archived });
          if (!m.archived && activeId === id) {
            const next = mostRecent();
            if (next) void select(next.meta.id);
          }
        } else if (what === "delete") void remove(rt);
      },
      { align: fromHeader ? "end" : "start", width: 230 }
    );
  }

  let toolsSig = JSON.stringify(threadsSettings().tools);

  /** Settings → Threads: which tabs exist, and new tools for idle agents. */
  function applySettings(): void {
    const t = threadsSettings();
    threadsTab.hidden = !t.enabled;
    sessionsTab.hidden = !t.sessionsTab;
    toggle.classList.toggle("three", t.enabled && t.sessionsTab);
    toggle.classList.toggle("no-sessions", !t.sessionsTab);
    if (!t.enabled && mode === "threads") void setMode("panes");
    else if (!t.sessionsTab && mode === "panes") void setMode("threads");
    const sig = JSON.stringify(t.tools);
    if (sig !== toolsSig) {
      toolsSig = sig;
      // Tools are fixed when an agent starts: idle ones restart on their next
      // message with the new set; busy ones pick it up after they sleep.
      for (const rt of engine.list()) if (!rt.busy && rt.run !== "sleeping") void engine.sleep(rt);
    }
    refreshBadge();
  }

  /** Threads in the order the sidebar shows them. */
  function ordered(): Runtime[] {
    return [...sidebar.el.querySelectorAll<HTMLElement>(".ts-item[data-thread]")]
      .map((n) => engine.get(n.dataset.thread))
      .filter((r): r is Runtime => !!r && !r.meta.archived);
  }

  /** Ctrl+Tab style cycling through the visible threads. */
  function cycle(step: number): void {
    const list = ordered();
    if (!list.length) return;
    const i = list.findIndex((r) => r.meta.id === activeId);
    const next = list[(i + step + list.length) % list.length];
    void select(next.meta.id);
  }

  apply();
  applySettings();
  if (!threadsSettings().enabled) mode = "panes";
  if (mode === "threads") {
    // Restore after the rest of the app has booted.
    window.setTimeout(() => {
      mode = "panes";
      void setMode("threads");
    }, 0);
  } else void engine.init();

  // Remember which harness the last new thread used.
  engine.onList(() => {
    const rt = engine.get(activeId);
    if (rt && !rt.order.length) save(HARNESS_KEY, rt.meta.harness);
  });

  return {
    get mode() {
      return mode;
    },
    isThreads: () => mode === "threads",
    setMode,
    toggle: () => {
      const t = threadsSettings();
      if (t.enabled && t.sessionsTab) void setMode(mode === "threads" ? "panes" : "threads");
    },
    applySettings,
    newThread: (cwd?: string) => newThread(cwd),
    cycle,
    selectIndex(i: number): void {
      const rt = ordered()[i];
      if (rt) void select(rt.meta.id);
    },
    rename: () => view.startRename(),
    focus: () => view.focusComposer(),
    /** Text size of the conversation: +1 / -1, 0 resets. */
    zoom: (step: number) => view.zoom(step),
    insertText: (t: string) => view.insertText(t),
    /** Name/status of the active thread, for the title bar. */
    titleInfo(): { name: string; path: string; status: string } | null {
      const rt = engine.get(activeId);
      if (!rt || mode !== "threads") return null;
      return { name: rt.meta.title, path: rt.meta.cwd, status: statusOf(rt) };
    },
    folderLabel,
  };
}
