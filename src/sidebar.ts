import { store } from "./store";
import { collectLeaves } from "./tree";
import { prettyChord } from "./keybinds";
import { collapse, cancelCollapse } from "./popAnim";
import { createExplorer } from "./explorer";
import type { DropRegion } from "./terminals";
import { ACTIONS, openTaskCount, PANE_KINDS, type Session } from "./types";
import { hasUnreadUrgent, onInboxChange, unreadCount } from "./inbox";

/** What the dot in front of a session name is telling you:
 *  - `running`   an AI agent in this session is working, and nothing is wrong
 *  - `subagents` an agent here has background sub-agents in flight (blue —
 *                same orbit animation as `running`, different hue, because it
 *                is a different kind of busy: work is fanned out, not linear)
 *  - `waiting`   an agent is blocked on a prompt it needs you to answer
 *  - `error`     an agent (or a tool under it) hit a hard failure
 *  Sessions with none of the above get the neutral resting dot. */
export type SessionStatus = "running" | "subagents" | "waiting" | "error";

const STATUS_TITLES: Record<SessionStatus | "idle", string> = {
  idle: "Idle",
  running: "An agent here is working",
  subagents: "An agent here is running sub-agents",
  waiting: "An agent here is waiting for your input",
  error: "An agent here hit an error",
};

export interface SidebarHandlers {
  onNewSession(): void;
  onAddPane(kindId: string): void;
  onSelect(id: string): void;
  onCloseSession(id: string): void;
  onArchiveSession(id: string): void;
  onRename(id: string, name: string): void;
  onReorder(fromId: string, toId: string): void;
  onOpenSettings(): void;
  onOpenSessionSettings(id: string): void;
  onOpenSessionStats(id: string): void;
  onOpenGitMap(id: string): void;
  onOpenTasks(id: string): void;
  onOpenInbox(): void;
  onOpenFile(path: string, name: string): void;
  onDropFileToPane(path: string, name: string, paneId: string): void;
  onDockFileToPane(
    path: string,
    name: string,
    paneId: string,
    region: DropRegion,
    at: { x: number; y: number }
  ): void;
  onConfirmDeleteFile(name: string, isDir: boolean): Promise<boolean>;
}

const GEAR =
  '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M8 5.2A2.8 2.8 0 1 0 8 10.8 2.8 2.8 0 1 0 8 5.2zM8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"/></svg>';

const TASKS_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.8 6.2l1.4 1.4 2.4-2.6" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="8.8" y1="5.4" x2="11.4" y2="5.4" stroke="currentColor" stroke-width="1.2"/><path d="M4.8 10.2l1.4 1.4 2.4-2.6" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="8.8" y1="9.4" x2="11.4" y2="9.4" stroke="currentColor" stroke-width="1.2"/></svg>';

const DOTS =
  '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="3.2" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="12.8" r="1.3" fill="currentColor"/></svg>';

const BELL =
  '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M8 2.2c-2 0-3.2 1.5-3.2 3.6v1.5c0 .95-.32 1.75-.94 2.45l-.46.55h9.2l-.46-.55c-.62-.7-.94-1.5-.94-2.45V5.8c0-2.1-1.2-3.6-3.2-3.6z"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="M6.3 12.5a1.8 1.8 0 0 0 3.4 0"/></svg>';

export function createSidebar(handlers: SidebarHandlers) {
  const el = document.createElement("aside");
  el.className = "sidebar";

  const head = document.createElement("div");
  head.className = "sidebar-head";
  head.innerHTML = '<span class="wordmark">OPEN<b>TERM</b></span>';

  const inboxBtn = document.createElement("button");
  inboxBtn.className = "inbox-btn";
  inboxBtn.innerHTML = `${BELL}<span class="inbox-badge hidden"></span>`;
  inboxBtn.addEventListener("click", handlers.onOpenInbox);
  head.appendChild(inboxBtn);

  function refreshInboxBadge(): void {
    const n = unreadCount();
    const badge = inboxBtn.querySelector<HTMLElement>(".inbox-badge")!;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.toggle("hidden", n === 0);
    inboxBtn.classList.toggle("urgent", hasUnreadUrgent());
    inboxBtn.title = n > 0 ? `Inbox (${n} unread)` : "Inbox";
  }
  onInboxChange(refreshInboxBadge);
  refreshInboxBadge();

  const modeToggle = document.createElement("div");
  modeToggle.className = "sidebar-mode-toggle";
  const sessionsTab = document.createElement("button");
  sessionsTab.className = "sidebar-mode-btn active";
  sessionsTab.textContent = "Sessions";
  sessionsTab.title = "Show the session list";
  const filesTab = document.createElement("button");
  filesTab.className = "sidebar-mode-btn";
  filesTab.textContent = "Files";
  filesTab.title = "Browse files in the active session's folder";
  modeToggle.append(sessionsTab, filesTab);

  const newBtn = document.createElement("button");
  newBtn.className = "new-session";
  newBtn.innerHTML = `<span>New session</span><kbd></kbd>`;
  newBtn.addEventListener("click", handlers.onNewSession);

  // "+" → add a specific pane (agent CLI, shell or browser) to the session.
  const addPaneBtn = document.createElement("button");
  addPaneBtn.className = "add-pane-btn";
  addPaneBtn.title = "Add a terminal, agent or browser pane";
  addPaneBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';

  const addRow = document.createElement("div");
  addRow.className = "sidebar-add-row";
  addRow.append(newBtn, addPaneBtn);

  const list = document.createElement("div");
  list.className = "session-list";

  const sessionsContent = document.createElement("div");
  sessionsContent.className = "sidebar-sessions";
  sessionsContent.append(addRow, list);

  const explorer = createExplorer({
    onOpenFile: handlers.onOpenFile,
    onDropToPane: handlers.onDropFileToPane,
    onDockToPane: handlers.onDockFileToPane,
    onConfirmDelete: handlers.onConfirmDeleteFile,
  });
  explorer.el.classList.add("sidebar-explorer", "hidden");

  const foot = document.createElement("div");
  foot.className = "sidebar-foot";
  const tasksBtn = document.createElement("button");
  tasksBtn.className = "settings-btn tasks-launch-btn";
  tasksBtn.innerHTML = `${TASKS_ICON}<span>Tasks</span><span class="tasks-launch-badge hidden"></span><kbd></kbd>`;
  tasksBtn.addEventListener("click", () => {
    const active = store.state.sessions.find((s) => s.id === store.state.activeSessionId);
    if (active) handlers.onOpenTasks(active.id);
  });
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "settings-btn";
  settingsBtn.innerHTML = `${GEAR}<span>Settings</span><kbd></kbd>`;
  settingsBtn.addEventListener("click", handlers.onOpenSettings);
  foot.append(tasksBtn, settingsBtn);

  // Shared per-session context menu (⋮ button) — one instance, repositioned and
  // re-targeted on open rather than building one per session item.
  const sessionMenu = document.createElement("div");
  sessionMenu.className = "session-menu";
  const menuSettingsBtn = document.createElement("button");
  menuSettingsBtn.className = "session-menu-item";
  menuSettingsBtn.textContent = "Session settings…";
  const menuStatsBtn = document.createElement("button");
  menuStatsBtn.className = "session-menu-item";
  menuStatsBtn.textContent = "Stats…";
  const menuGitMapBtn = document.createElement("button");
  menuGitMapBtn.className = "session-menu-item";
  menuGitMapBtn.textContent = "Git Map…";
  const menuArchiveBtn = document.createElement("button");
  menuArchiveBtn.className = "session-menu-item";
  menuArchiveBtn.textContent = "Archive session";
  menuArchiveBtn.title = "Hide from the sidebar — restore it any time from Settings";
  const menuDeleteBtn = document.createElement("button");
  menuDeleteBtn.className = "session-menu-item danger";
  menuDeleteBtn.textContent = "Delete session";
  sessionMenu.append(menuSettingsBtn, menuStatsBtn, menuGitMapBtn, menuArchiveBtn, menuDeleteBtn);
  document.body.appendChild(sessionMenu);

  let menuOpenFor: string | null = null;
  /** The "⋯" button the menu is hanging off, so the outside-click handler can
   *  spare it — otherwise its pointerdown closes the menu and the click that
   *  follows immediately reopens it. Re-set on every render (the row's button
   *  is recreated), so it always points at the live element. */
  let menuAnchor: HTMLElement | null = null;

  function closeMenu(): void {
    if (!menuOpenFor) return;
    menuOpenFor = null;
    menuAnchor = null;
    collapse(sessionMenu, () => sessionMenu.classList.remove("visible"));
  }

  function openMenu(id: string, anchor: HTMLElement): void {
    cancelCollapse(sessionMenu); // reopened mid-collapse: start from a clean state
    menuOpenFor = id;
    menuAnchor = anchor;
    const r = anchor.getBoundingClientRect();
    sessionMenu.style.top = `${r.bottom + 4}px`;
    sessionMenu.style.left = `${r.right}px`;
    sessionMenu.classList.add("visible");
    // Flip to the left of the button if it would overflow the viewport.
    const menuRect = sessionMenu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      sessionMenu.style.left = `${r.right - menuRect.width}px`;
    }
  }

  menuSettingsBtn.addEventListener("click", () => {
    const id = menuOpenFor;
    closeMenu();
    if (id) handlers.onOpenSessionSettings(id);
  });
  menuStatsBtn.addEventListener("click", () => {
    const id = menuOpenFor;
    closeMenu();
    if (id) handlers.onOpenSessionStats(id);
  });
  menuGitMapBtn.addEventListener("click", () => {
    const id = menuOpenFor;
    closeMenu();
    if (id) handlers.onOpenGitMap(id);
  });
  menuArchiveBtn.addEventListener("click", () => {
    const id = menuOpenFor;
    closeMenu();
    if (id) handlers.onArchiveSession(id);
  });
  menuDeleteBtn.addEventListener("click", () => {
    const id = menuOpenFor;
    closeMenu();
    if (id) handlers.onCloseSession(id);
  });
  document.addEventListener("pointerdown", (e) => {
    if (menuOpenFor && !sessionMenu.contains(e.target as Node) &&
      !menuAnchor?.contains(e.target as Node)) closeMenu();
    if (addMenuOpen && !addPaneMenu.contains(e.target as Node) && e.target !== addPaneBtn &&
      !addPaneBtn.contains(e.target as Node)) closeAddMenu();
  });
  window.addEventListener("resize", () => {
    closeMenu();
    closeAddMenu();
  });
  window.addEventListener("blur", () => {
    closeMenu();
    closeAddMenu();
  });

  // ---- "+" add-pane menu ----
  const addPaneMenu = document.createElement("div");
  addPaneMenu.className = "session-menu add-pane-menu";
  for (const def of PANE_KINDS) {
    const item = document.createElement("button");
    item.className = "add-pane-item";
    item.innerHTML =
      `<span class="add-pane-label">${def.label}</span><span class="add-pane-hint">${def.hint}</span>`;
    item.addEventListener("click", () => {
      closeAddMenu();
      handlers.onAddPane(def.id);
    });
    addPaneMenu.appendChild(item);
  }
  document.body.appendChild(addPaneMenu);

  let addMenuOpen = false;
  function closeAddMenu(): void {
    addMenuOpen = false;
    addPaneMenu.classList.remove("visible");
    addPaneBtn.classList.remove("menu-open");
  }
  addPaneBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (addMenuOpen) {
      closeAddMenu();
      return;
    }
    const r = addPaneBtn.getBoundingClientRect();
    addPaneMenu.style.top = `${r.bottom + 6}px`;
    addPaneMenu.style.left = `${r.left}px`;
    addPaneMenu.classList.add("visible");
    addPaneBtn.classList.add("menu-open");
    // Flip above the button when it would spill past the viewport bottom.
    const menuRect = addPaneMenu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - 8) {
      addPaneMenu.style.top = `${window.innerHeight - menuRect.height - 8}px`;
    }
    addMenuOpen = true;
  });

  el.append(head, modeToggle, sessionsContent, explorer.el, foot);

  let renaming: string | null = null;
  let mode: "sessions" | "files" = "sessions";

  function setMode(next: "sessions" | "files"): void {
    if (mode === next) return;
    mode = next;
    modeToggle.classList.toggle("files", mode === "files");
    sessionsTab.classList.toggle("active", mode === "sessions");
    filesTab.classList.toggle("active", mode === "files");
    sessionsContent.classList.toggle("hidden", mode !== "sessions");
    explorer.el.classList.toggle("hidden", mode !== "files");
    // Re-trigger the entry fade on whichever view just came in.
    const shown = mode === "files" ? explorer.el : sessionsContent;
    shown.classList.remove("mode-enter");
    void shown.offsetWidth;
    shown.classList.add("mode-enter");
    if (mode === "files") {
      const active = store.state.sessions.find((s) => s.id === store.state.activeSessionId);
      explorer.open(active?.cwd ?? null);
    }
  }

  sessionsTab.addEventListener("click", () => setMode("sessions"));
  filesTab.addEventListener("click", () => setMode("files"));

  // Session reorder is pointer-driven rather than HTML5 drag-and-drop: the window
  // has Tauri's native drag/drop handler enabled (so files dropped from Explorer
  // carry real paths), and that handler swallows the webview's HTML5 DnD events.
  let suppressClick = false;

  const FOLDER_ICON =
    '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M1.8 4.2c0-.66.54-1.2 1.2-1.2h3.1l1.4 1.5H13c.66 0 1.2.54 1.2 1.2v6.1c0 .66-.54 1.2-1.2 1.2H3c-.66 0-1.2-.54-1.2-1.2z"/></svg>';

  /** Floating pill that follows the cursor during an Alt+drag of a session: the
   *  folder that will be pasted, so the drop is never a surprise. */
  function makePathGhost(name: string, cwd: string): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "session-path-ghost";
    const icon = document.createElement("span");
    icon.className = "session-path-ghost-icon";
    icon.innerHTML = FOLDER_ICON;
    const text = document.createElement("span");
    text.className = "session-path-ghost-text";
    const title = document.createElement("span");
    title.className = "session-path-ghost-name";
    title.textContent = name;
    const path = document.createElement("span");
    path.className = "session-path-ghost-path";
    path.textContent = cwd;
    text.append(title, path);
    ghost.append(icon, text);
    return ghost;
  }

  /** Drop feedback: the pill collapses into the drop point while the target pane
   *  pulses once, or it just fades away when the drag is abandoned. */
  function releasePathGhost(ghost: HTMLElement, pane: HTMLElement | null): void {
    ghost.classList.add(pane ? "landed" : "cancelled");
    if (pane) {
      pane.classList.remove("path-landed");
      void pane.offsetWidth;
      pane.classList.add("path-landed");
      setTimeout(() => pane.classList.remove("path-landed"), 700);
    }
    setTimeout(() => ghost.remove(), 260);
  }

  function bindReorderDrag(item: HTMLElement, session: Session): void {
    const id = session.id;
    item.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(".session-menu-btn")) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      let dragging = false;
      let targetEl: HTMLElement | null = null;
      let finished = false;
      // Alt held = "paste this session's folder into a terminal" instead of
      // reordering. Re-evaluated live, so Alt can be pressed mid-drag.
      const cwd = session.cwd ?? null;
      let pathMode = false;
      let ghost: HTMLElement | null = null;
      let paneTarget: HTMLElement | null = null;
      let lastX = startX;
      let lastY = startY;

      const setPaneTarget = (next: HTMLElement | null) => {
        if (paneTarget === next) return;
        paneTarget?.classList.remove("file-drop-target");
        next?.classList.add("file-drop-target");
        paneTarget = next;
      };
      const setRowTarget = (next: HTMLElement | null) => {
        if (targetEl === next) return;
        targetEl?.classList.remove("drop-target");
        next?.classList.add("drop-target");
        targetEl = next;
      };

      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
        try {
          if (item.hasPointerCapture(pointerId)) item.releasePointerCapture(pointerId);
        } catch {
          /* capture may already be gone */
        }
        if (!dragging) return;
        item.classList.remove("dragging", "path-dragging");
        document.body.classList.remove("dragging-file");
        const to = targetEl?.dataset.sessionId;
        const pane = paneTarget;
        setRowTarget(null);
        setPaneTarget(null);
        // The click that follows this pointerup would otherwise select the session
        // we just dragged past; swallow it for this gesture only.
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 0);
        if (pathMode) {
          const landed = commit && cwd && pane?.dataset.paneId ? pane : null;
          if (ghost) releasePathGhost(ghost, landed);
          ghost = null;
          if (landed) handlers.onDropFileToPane(cwd!, session.name, landed.dataset.paneId!);
          return;
        }
        if (commit && to && to !== id) handlers.onReorder(id, to);
      };

      /** Switches between reorder and path mode and refreshes the drop target. */
      const refresh = (alt: boolean) => {
        const wantPath = alt && !!cwd;
        if (wantPath !== pathMode) {
          pathMode = wantPath;
          item.classList.toggle("dragging", !pathMode);
          item.classList.toggle("path-dragging", pathMode);
          document.body.classList.toggle("dragging-file", pathMode);
          if (pathMode) {
            setRowTarget(null);
            ghost = makePathGhost(session.name, cwd!);
            document.body.appendChild(ghost);
          } else {
            setPaneTarget(null);
            if (ghost) releasePathGhost(ghost, null);
            ghost = null;
          }
        }
        const hit = document.elementFromPoint(lastX, lastY);
        if (pathMode) {
          ghost!.style.transform = `translate(${lastX + 16}px, ${lastY + 14}px)`;
          // Only in-app terminal panes have a PTY to type the path into.
          const under = hit?.closest<HTMLElement>(".pane");
          setPaneTarget(
            under && under.dataset.external !== "1" && under.dataset.paneId ? under : null
          );
        } else {
          const under = hit?.closest<HTMLElement>(".session-item");
          setRowTarget(under && under !== item ? under : null);
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        lastX = ev.clientX;
        lastY = ev.clientY;
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
          dragging = true;
          try {
            item.setPointerCapture(pointerId);
          } catch {
            /* best-effort; window listeners are the real guarantee */
          }
          item.classList.add("dragging");
        }
        refresh(ev.altKey);
      };

      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Alt") return;
        // Keep Alt from reaching the webview's menu-focus handling mid-drag.
        ev.preventDefault();
        if (dragging) refresh(ev.type === "keydown");
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(ev.type === "pointerup");
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("keyup", onKey, true);
    });
  }

  function update(
    settingsOpen: boolean,
    sessionStatus?: Map<string, SessionStatus>,
    subagentCounts?: Map<string, number>,
  ): void {
    const { sessions, activeSessionId, settings } = store.state;
    newBtn.querySelector("kbd")!.textContent = prettyChord(settings.keybinds.newSession);
    newBtn.title = `${ACTIONS.newSession} (${prettyChord(settings.keybinds.newSession)})`;
    settingsBtn.querySelector("kbd")!.textContent = prettyChord(settings.keybinds.openSettings);
    settingsBtn.title = `${ACTIONS.openSettings} (${prettyChord(settings.keybinds.openSettings)})`;
    settingsBtn.classList.toggle("active", settingsOpen);

    const active = sessions.find((s) => s.id === activeSessionId);
    tasksBtn.disabled = !active;
    tasksBtn.classList.toggle("disabled", !active);
    const openCount = active ? openTaskCount(active) : 0;
    const badge = tasksBtn.querySelector<HTMLElement>(".tasks-launch-badge")!;
    badge.textContent = String(openCount);
    badge.classList.toggle("hidden", openCount === 0);
    tasksBtn.querySelector("kbd")!.textContent = prettyChord(settings.keybinds.openTasks);
    tasksBtn.title = `${ACTIONS.openTasks} (${prettyChord(settings.keybinds.openTasks)})`;
    const viewChord = settings.keybinds.toggleSidebarView;
    const viewHint = viewChord ? ` (${prettyChord(viewChord)})` : "";
    sessionsTab.title = `Show the session list${viewHint}`;
    filesTab.title = `Browse files in the active session's folder${viewHint}`;

    list.replaceChildren(
      ...sessions.filter((s) => !s.archived).map((s) => {
        const item = document.createElement("div");
        item.className = "session-item";
        item.classList.toggle("active", !settingsOpen && s.id === activeSessionId);
        const status = sessionStatus?.get(s.id);
        item.classList.toggle("needs-attention", status === "waiting" || status === "error");
        item.dataset.sessionId = s.id;

        const count = collectLeaves(s.tree).length;

        const dot = document.createElement("span");
        dot.className = `session-status-dot${status ? ` ${status}` : ""}`;
        const subs = subagentCounts?.get(s.id) ?? 0;
        dot.title =
          status === "subagents" && subs > 0
            ? `${subs} sub-agent${subs === 1 ? "" : "s"} running here`
            : STATUS_TITLES[status ?? "idle"];

        if (renaming === s.id) {
          const input = document.createElement("input");
          input.className = "rename-input";
          input.value = s.name;
          const commit = () => {
            renaming = null;
            handlers.onRename(s.id, input.value.trim() || s.name);
          };
          input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              renaming = null;
              update(settingsOpen);
            }
          });
          input.addEventListener("blur", commit);
          item.append(dot, input);
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        } else {
          const name = document.createElement("span");
          name.className = "session-name";
          name.textContent = s.name;

          const badge = document.createElement("span");
          badge.className = "session-badge";
          badge.textContent = String(count);


          const menuBtn = document.createElement("button");
          menuBtn.className = "session-menu-btn";
          menuBtn.title = "Session options";
          menuBtn.innerHTML = DOTS;
          menuBtn.classList.toggle("menu-open", menuOpenFor === s.id);
          menuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (menuOpenFor === s.id) {
              closeMenu();
            } else {
              openMenu(s.id, menuBtn);
            }
          });

          item.append(dot, name, badge, menuBtn);
          item.addEventListener("click", () => {
            if (!suppressClick) handlers.onSelect(s.id);
          });
          item.addEventListener("dblclick", () => {
            renaming = s.id;
            update(settingsOpen);
          });
        }

        if (renaming !== s.id) bindReorderDrag(item, s);

        return item;
      })
    );

    // A rerender while the menu is open (e.g. an attention-dot update) tears down
    // the anchor button — reposition against its replacement, or close if the
    // session it belonged to is gone.
    if (menuOpenFor) {
      const btn = list.querySelector<HTMLElement>(
        `[data-session-id="${menuOpenFor}"] .session-menu-btn`
      );
      if (btn) openMenu(menuOpenFor, btn);
      else closeMenu();
    }
  }

  function startRename(id: string): void {
    renaming = id;
  }

  function toggleMode(): void {
    closeMenu();
    closeAddMenu();
    setMode(mode === "sessions" ? "files" : "sessions");
  }

  return {
    el,
    update,
    startRename,
    toggleMode,
    inboxAnchor: inboxBtn,
    isAddMenuOpen: () => addMenuOpen,
  };
}
