import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { store } from "./store";
import { trash } from "./trash";
import { collapse, cancelCollapse } from "./popAnim";
import {
  delegationActive,
  DelegationAgent,
  DELEGATION_AGENTS,
  DelegationTrigger,
  isTaskDone,
  newTask,
  Session,
  sessionStages,
  sessionTasks,
  stageOf,
  STAGE_COLORS,
  SubTask,
  Task,
  TASK_PRIORITIES,
  TaskStage,
  TaskStatus,
  uid,
} from "./types";

export interface OpenPaneInfo {
  sessionId: string;
  sessionName: string;
  sessionColor: string;
  paneId: string;
  title: string;
  lastLine: string;
}

export interface TasksPanelHandlers {
  /** Open a task's attached file the same way the sidebar's Files view would. */
  onOpenFile(path: string, name: string): void;
  /** Ask the user to confirm a destructive delete; resolves true to proceed. */
  confirmDelete(taskTitle: string): Promise<boolean>;
  /** Called when the panel closes, in case task counts shown elsewhere (e.g. the
   *  sidebar's open-task badge) need a refresh. */
  onChanged?(): void;
  /** Every currently open terminal pane, for the "when a terminal finishes" trigger picker. */
  listOpenPanes(): OpenPaneInfo[];
  /** Hand a task off to an agent CLI (replaces any pending delegation). */
  onDelegate(session: Session, task: Task, agent: DelegationAgent, trigger: DelegationTrigger): void;
  /** Drop a task's active delegation without running it. */
  onCancelDelegate(session: Session, task: Task): void;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

const ICONS = {
  close:
    '<svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke="currentColor"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke="currentColor"/></svg>',
  plus:
    '<svg viewBox="0 0 14 14"><line x1="7" y1="2" x2="7" y2="12" stroke="currentColor"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor"/></svg>',
  trash:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M2.5 4h9M5.5 4V2.7c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7V4M3.5 4l.5 8c0 .5.4.9.9.9h4.2c.5 0 .9-.4.9-.9l.5-8"/></svg>',
  paperclip:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M9.5 3.5L4.2 8.8a2 2 0 1 0 2.8 2.8l5-5a3.3 3.3 0 1 0-4.7-4.7L2.8 6.4"/></svg>',
  calendar:
    '<svg viewBox="0 0 14 14"><rect x="2" y="3" width="10" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><line x1="2" y1="5.5" x2="12" y2="5.5" stroke="currentColor" stroke-width="1.1"/><line x1="4.5" y1="2" x2="4.5" y2="4" stroke="currentColor" stroke-width="1.1"/><line x1="9.5" y1="2" x2="9.5" y2="4" stroke="currentColor" stroke-width="1.1"/></svg>',
  check:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M2.5 7.3l3 3 6-6.6"/></svg>',
  list:
    '<svg viewBox="0 0 14 14"><line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor"/><line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor"/></svg>',
  kanban:
    '<svg viewBox="0 0 14 14"><rect x="1.5" y="2" width="3" height="10" rx="0.6" fill="none" stroke="currentColor"/><rect x="5.5" y="2" width="3" height="6.5" rx="0.6" fill="none" stroke="currentColor"/><rect x="9.5" y="2" width="3" height="8.5" rx="0.6" fill="none" stroke="currentColor"/></svg>',
  robot:
    '<svg viewBox="0 0 14 14"><rect x="2.5" y="4.5" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.1"/><line x1="7" y1="4.5" x2="7" y2="2.4" stroke="currentColor" stroke-width="1.1"/><circle cx="7" cy="1.8" r="1" fill="currentColor"/><circle cx="5.2" cy="7.6" r="0.9" fill="currentColor"/><circle cx="8.8" cy="7.6" r="0.9" fill="currentColor"/></svg>',
  search:
    '<svg viewBox="0 0 14 14"><circle cx="6.2" cy="6.2" r="3.9" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="9.2" y1="9.2" x2="12" y2="12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  dots:
    '<svg viewBox="0 0 14 14"><circle cx="3" cy="7" r="1.15" fill="currentColor"/><circle cx="7" cy="7" r="1.15" fill="currentColor"/><circle cx="11" cy="7" r="1.15" fill="currentColor"/></svg>',
  arrowLeft:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M8.2 3.2L4.4 7l3.8 3.8"/></svg>',
  arrowRight:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M5.8 3.2L9.6 7l-3.8 3.8"/></svg>',
  pencil:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M9.4 2.3l2.3 2.3-6.5 6.5-3 .7.7-3z"/></svg>',
  checklist:
    '<svg viewBox="0 0 20 20"><rect x="3.5" y="2.5" width="13" height="15" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M6.8 7.6l1.4 1.4 2.9-3"/><line x1="12.4" y1="12.6" x2="13.6" y2="12.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="6.6" y1="12.6" x2="10.4" y2="12.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

function priorityColor(p: Task["priority"]): string {
  return TASK_PRIORITIES.find((x) => x.id === p)?.color ?? "#8b93a5";
}

function priorityLabel(p: Task["priority"]): string {
  return TASK_PRIORITIES.find((x) => x.id === p)?.label ?? p;
}

function fmtDue(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isOverdue(task: Task, session: Session): boolean {
  if (!task.dueDate || isTaskDone(session, task)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = task.dueDate.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime() < today.getTime();
}

export function createTasksPanel(handlers: TasksPanelHandlers) {
  const el = document.createElement("div");
  el.className = "tasks";

  const card = document.createElement("div");
  card.className = "tasks-card";

  // ---- header ----
  const head = document.createElement("div");
  head.className = "tasks-head";

  const heading = document.createElement("div");
  heading.className = "tasks-heading";
  const title = document.createElement("h2");
  title.textContent = "Tasks";
  const subtitle = document.createElement("div");
  subtitle.className = "tasks-subtitle";
  heading.append(title, subtitle);

  const searchWrap = document.createElement("div");
  searchWrap.className = "tasks-search";
  searchWrap.innerHTML = ICONS.search;
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search tasks…";
  searchWrap.appendChild(searchInput);

  const viewToggle = document.createElement("div");
  viewToggle.className = "tasks-view-toggle";
  const listViewBtn = document.createElement("button");
  listViewBtn.innerHTML = `${ICONS.list}<span>List</span>`;
  listViewBtn.title = "List view";
  const kanbanViewBtn = document.createElement("button");
  kanbanViewBtn.innerHTML = `${ICONS.kanban}<span>Board</span>`;
  kanbanViewBtn.title = "Kanban board";
  viewToggle.append(listViewBtn, kanbanViewBtn);

  const headActions = document.createElement("div");
  headActions.className = "tasks-head-actions";
  const newBtn = document.createElement("button");
  newBtn.className = "tasks-new-btn";
  newBtn.innerHTML = `${ICONS.plus}<span>New task</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "tasks-icon-btn";
  closeBtn.innerHTML = ICONS.close;
  closeBtn.title = "Close (Esc)";
  headActions.append(newBtn, closeBtn);

  head.append(heading, headActions);

  // ---- toolbar: search · status filter chips (list view only) · view + scope
  // switches. Keeping the switches here rather than in the title row gives the
  // toolbar something to hold in Board view, where the filter chips are hidden
  // and the band used to sit almost empty. ----
  const toolbar = document.createElement("div");
  toolbar.className = "tasks-toolbar";
  const filters = document.createElement("div");
  filters.className = "tasks-filters";
  const scopeToggle = document.createElement("div");
  scopeToggle.className = "tasks-view-toggle";
  const scopeSessionBtn = document.createElement("button");
  scopeSessionBtn.textContent = "This session";
  scopeSessionBtn.title = "Show only this session's tasks";
  const scopeAllBtn = document.createElement("button");
  scopeAllBtn.textContent = "All sessions";
  scopeAllBtn.title = "Show tasks from every session";
  scopeToggle.append(scopeSessionBtn, scopeAllBtn);
  const toolbarRight = document.createElement("div");
  toolbarRight.className = "tasks-toolbar-right";
  toolbarRight.append(viewToggle, scopeToggle);
  toolbar.append(searchWrap, filters, toolbarRight);

  // ---- body ----
  const body = document.createElement("div");
  body.className = "tasks-body";
  const main = document.createElement("div");
  main.className = "tasks-main";
  const drawer = document.createElement("div");
  drawer.className = "tasks-drawer";
  body.append(main, drawer);

  card.append(head, toolbar, body);
  el.appendChild(card);

  let open = false;
  /** The session the panel was opened from — always the target for new tasks,
   *  and the sole scope shown unless `scope` is switched to "all". */
  let homeSession: Session | null = null;
  let scope: "session" | "all" = "session";
  let view: "list" | "kanban" = "list";
  let filterStatus: "all" | TaskStatus = "all";
  let search = "";
  let selectedTaskId: string | null = null;
  /** Set while a stage header is showing its rename input instead of its name. */
  let renamingStageId: string | null = null;

  /** Puts the caret in whichever stage header is currently in rename mode. */
  function focusStageRename(): void {
    const input = main.querySelector<HTMLInputElement>(".tasks-stage-rename");
    if (!input) return;
    input.focus();
    input.select();
  }

  // ================= stages =================

  /** The columns to render. In "this session" scope that is simply the home
   *  session's stages, which are also the ones the stage editor writes to. In
   *  "all sessions" scope it is the union across visible sessions — home
   *  session's order first, then any stage only other sessions define — so no
   *  task can land outside a column. */
  function boardStages(): TaskStage[] {
    if (!homeSession) return [];
    const stages = [...sessionStages(homeSession)];
    if (scope === "all") {
      const seen = new Set(stages.map((s) => s.id));
      for (const s of visibleSessions()) {
        for (const st of sessionStages(s)) {
          if (seen.has(st.id)) continue;
          seen.add(st.id);
          stages.push(st);
        }
      }
    }
    return stages;
  }

  /** Stage editing always targets the home session, so it is offered only while
   *  that session is the one on screen. */
  function canEditStages(): boolean {
    return scope === "session" && homeSession !== null;
  }

  /** Which column a task belongs in, tolerating a status whose stage another
   *  session owns (or that was deleted) by falling back to the first column. */
  function stageIdFor(task: Task, stages: TaskStage[]): string {
    return stages.some((s) => s.id === task.status) ? task.status : (stages[0]?.id ?? task.status);
  }

  function stageColor(stage: TaskStage): string {
    return stage.color || "var(--text-dim)";
  }

  function uniqueStageId(label: string): string {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "stage";
    const taken = new Set(sessionStages(homeSession!).map((s) => s.id));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  /** Appends a stage and drops straight into renaming it — a new column that
   *  arrives pre-named "New stage" and waiting for input is one step, not two. */
  function addStage(): void {
    if (!canEditStages()) return;
    const stages = sessionStages(homeSession!);
    const used = new Set(stages.map((s) => s.color));
    const color = STAGE_COLORS.find((c) => !used.has(c)) ?? STAGE_COLORS[stages.length % STAGE_COLORS.length];
    const stage: TaskStage = { id: uniqueStageId("stage"), label: "New stage", color };
    stages.push(stage);
    store.save();
    renamingStageId = stage.id;
    render();
    // The board scrolls to the right so the new column is not created off-screen.
    requestAnimationFrame(() => {
      main.scrollTo({ left: main.scrollWidth, behavior: "smooth" });
      focusStageRename();
    });
  }

  function renameStage(stage: TaskStage, label: string): void {
    const next = label.trim();
    if (!next || next === stage.label) return;
    stage.label = next;
    store.save();
  }

  function moveStage(stage: TaskStage, delta: number): void {
    if (!canEditStages()) return;
    const stages = sessionStages(homeSession!);
    const i = stages.indexOf(stage);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= stages.length) return;
    stages.splice(j, 0, ...stages.splice(i, 1));
    store.save();
    render();
  }

  /** Only one stage can mean "finished" — turning it on elsewhere turns it off
   *  on the stage that had it, so the open-task counts stay unambiguous. */
  function setDoneStage(stage: TaskStage, done: boolean): void {
    if (!canEditStages()) return;
    for (const s of sessionStages(homeSession!)) s.done = false;
    stage.done = done || undefined;
    store.save();
    render();
  }

  function setStageColor(stage: TaskStage, color: string | null): void {
    stage.color = color;
    store.save();
    render();
  }

  /** Deleting a stage never deletes work: its tasks move to `moveToId` first.
   *  The whole thing is one undoable step. */
  function deleteStage(stage: TaskStage, moveToId: string): void {
    if (!canEditStages() || !homeSession) return;
    const session = homeSession;
    const stages = sessionStages(session);
    if (stages.length <= 1) return;
    const index = stages.indexOf(stage);
    if (index < 0) return;
    const moved = sessionTasks(session).filter((t) => t.status === stage.id);
    stages.splice(index, 1);
    for (const t of moved) t.status = moveToId;
    store.save();
    render();
    trash.push({
      label: `Stage “${stage.label}” deleted`,
      restore: () => {
        const list = sessionStages(session);
        list.splice(Math.min(index, list.length), 0, stage);
        for (const t of moved) t.status = stage.id;
        store.save();
        render();
      },
    });
  }

  /** The header shared by a list-view group and a board column: dot, name (or
   *  its rename input), count, and the stage menu. `variant` only changes the
   *  class names so the two layouts can differ in CSS. */
  function buildStageHead(stage: TaskStage, count: number, variant: "group" | "col"): HTMLElement {
    const head = document.createElement("div");
    head.className = variant === "col" ? "tasks-col-head" : "tasks-group-head";

    const dot = document.createElement("span");
    dot.className = "tasks-group-dot";
    dot.style.background = stageColor(stage);
    head.appendChild(dot);

    if (renamingStageId === stage.id && canEditStages()) {
      const input = document.createElement("input");
      input.className = "tasks-stage-rename";
      input.type = "text";
      input.value = stage.label;
      input.maxLength = 32;
      const commit = (save: boolean): void => {
        if (renamingStageId !== stage.id) return;
        renamingStageId = null;
        if (save) renameStage(stage, input.value);
        render();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          commit(false);
        }
      });
      input.addEventListener("blur", () => commit(true));
      head.appendChild(input);
    } else {
      const name = document.createElement("span");
      name.className = "tasks-stage-name";
      name.textContent = stage.label;
      if (canEditStages()) {
        name.title = "Double-click to rename";
        name.addEventListener("dblclick", () => {
          renamingStageId = stage.id;
          render();
          requestAnimationFrame(focusStageRename);
        });
      }
      head.appendChild(name);
      if (stage.done) {
        const flag = document.createElement("span");
        flag.className = "tasks-stage-done-flag";
        flag.innerHTML = ICONS.check;
        flag.title = "Tasks here count as finished";
        head.appendChild(flag);
      }
    }

    const countEl = document.createElement("span");
    countEl.className = variant === "col" ? "tasks-col-count" : "tasks-group-count";
    countEl.textContent = String(count);
    head.appendChild(countEl);

    if (canEditStages()) {
      const menuBtn = document.createElement("button");
      menuBtn.className = "tasks-stage-menu-btn";
      menuBtn.innerHTML = ICONS.dots;
      menuBtn.title = "Stage options";
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openStageMenu(stage, menuBtn);
      });
      head.appendChild(menuBtn);
    }
    return head;
  }

  /** Sessions currently in view, per `scope`. */
  function visibleSessions(): Session[] {
    if (scope === "all") return store.state.sessions.filter((s) => !s.archived);
    return homeSession ? [homeSession] : [];
  }

  /** Every task in scope, each paired with the session that owns it — the pairing
   *  is what lets the "all sessions" view show a per-task session badge and still
   *  route edits back to the right session's array. */
  function visibleEntries(): { task: Task; session: Session }[] {
    return visibleSessions().flatMap((s) => sessionTasks(s).map((task) => ({ task, session: s })));
  }

  /** Unfiltered (by search) task list for the current scope — used for header
   *  counts and to tell "no tasks at all" apart from "no search matches". */
  function scopeTasks(): Task[] {
    return visibleSessions().flatMap(sessionTasks);
  }

  /** Finds a task by id in any session — deliberately not scope-limited, so a
   *  task opened while scope was "all" still resolves if scope changes under it. */
  function findTask(id: string): Task | undefined {
    for (const s of store.state.sessions) {
      const t = sessionTasks(s).find((x) => x.id === id);
      if (t) return t;
    }
    return undefined;
  }

  /** The real backing array that owns a given task — needed because in "all
   *  sessions" scope a task on screen may belong to any session, not just
   *  `homeSession`. */
  function ownerArray(task: Task): Task[] | null {
    for (const s of store.state.sessions) {
      const arr = sessionTasks(s);
      if (arr.includes(task)) return arr;
    }
    return null;
  }

  function touch(task: Task): void {
    task.updatedAt = Date.now();
    store.save();
  }

  /** Drops a task the user opened but left completely blank. */
  function pruneIfEmpty(task: Task): boolean {
    const empty =
      !task.title.trim() &&
      !task.description.trim() &&
      task.subtasks.length === 0 &&
      task.files.length === 0 &&
      task.tags.length === 0;
    if (!empty) return false;
    const arr = ownerArray(task);
    const idx = arr ? arr.indexOf(task) : -1;
    if (arr && idx >= 0) arr.splice(idx, 1);
    store.save();
    return true;
  }

  function selectTask(id: string | null): void {
    if (selectedTaskId && selectedTaskId !== id) {
      const prev = findTask(selectedTaskId);
      if (prev) pruneIfEmpty(prev);
    }
    selectedTaskId = id;
    renderMain();
    renderDrawer();
    // The drawer pushes the board left, so whatever was just clicked can end up
    // under it. Once the push has played out, bring it back into view.
    if (id) {
      window.setTimeout(() => {
        main
          .querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }, 300);
    }
  }

  /** Same as `selectTask(null)` but skips the redundant render — used right
   *  before a `render()` call that's already coming (e.g. on scope switch). */
  function deselectSilently(): void {
    if (selectedTaskId) {
      const t = findTask(selectedTaskId);
      if (t) pruneIfEmpty(t);
    }
    selectedTaskId = null;
  }

  // ================= drag & drop (shared by list groups and kanban columns) =================

  /** Every currently-rendered draggable row/card, across all groups/columns. */
  function dragItems(): HTMLElement[] {
    return Array.from(main.querySelectorAll<HTMLElement>(".tasks-row, .tasks-drag-item"));
  }

  /** Records each element's current rect, runs `mutate` (a DOM reorder), then plays
   *  the resulting delta back as a transform-only transition — the classic FLIP
   *  technique — so siblings glide into their new slot instead of snapping. */
  function flip(elements: HTMLElement[], mutate: () => void): void {
    const before = new Map(elements.map((el) => [el, el.getBoundingClientRect()] as const));
    mutate();
    for (const el of elements) {
      if (!el.isConnected) continue;
      const from = before.get(el);
      if (!from) continue;
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 200ms cubic-bezier(0.22, 0.9, 0.3, 1)";
        el.style.transform = "";
      });
    }
  }

  /** The element that actually parents draggable items inside a `[data-status]`
   *  container — a kanban column nests its cards one level deeper (`.tasks-col-body`)
   *  than a list-view status group, whose rows are direct children. */
  function dragHost(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>(".tasks-col-body") ?? container;
  }

  /** Drops at the end of a column land above its trailing furniture (the empty
   *  hint and the "Add task" button), which live inside the same scroll body. */
  function appendCard(host: HTMLElement, handle: HTMLElement): void {
    const tail = host.querySelector<HTMLElement>(".tasks-col-empty, .tasks-col-add");
    if (tail) host.insertBefore(handle, tail);
    else host.appendChild(handle);
  }

  /** `handle` is the draggable row/card for `task`. Dropping onto a `[data-status]`
   *  container reorders within it; crossing into a different container's status
   *  also updates the task's status when `allowStatusChange` is set (kanban) —
   *  list-view drags are reorder-only, dropped outside the task's own group.
   *
   *  A floating clone follows the cursor for the "held in hand" feel, while the
   *  real element becomes an in-place placeholder that's physically moved to the
   *  candidate drop slot as the pointer crosses siblings, with FLIP-animated
   *  neighbours. On release the clone glides into that exact slot before the
   *  data mutation and re-render take over. */
  function bindDrag(handle: HTMLElement, task: Task, allowStatusChange: boolean): void {
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("button, input, textarea, select")) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      let dragging = false;
      let dropStatus: TaskStatus | null = null;
      let dropBeforeId: string | null = null;
      let dropKey = "";
      let finished = false;
      let ghost: HTMLElement | null = null;
      let baseLeft = 0;
      let baseTop = 0;
      let grabX = 0;
      let grabY = 0;
      let lastX = startX;
      let tilt = 0;
      let originalParent: HTMLElement | null = null;
      let originalNext: Element | null = null;

      const clearIndicators = () => {
        main.querySelectorAll(".drop-active").forEach((c) => c.classList.remove("drop-active"));
      };

      /** Slides the placeholder back to where the drag started, if it's since
       *  been moved elsewhere — keeps the visual state always matching "what
       *  happens if the pointer is released right now". */
      const revertPlaceholder = () => {
        if (!originalParent) return;
        const atOriginalSpot =
          handle.parentElement === originalParent && handle.nextElementSibling === originalNext;
        if (atOriginalSpot) return;
        flip(
          dragItems().filter((el) => el !== handle),
          () => {
            if (originalNext && originalNext.parentElement === originalParent) {
              originalParent!.insertBefore(handle, originalNext);
            } else {
              originalParent!.appendChild(handle);
            }
          }
        );
      };

      const startDrag = (x: number, y: number) => {
        dragging = true;
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          /* best-effort */
        }
        originalParent = handle.parentElement;
        originalNext = handle.nextElementSibling;

        const rect = handle.getBoundingClientRect();
        baseLeft = rect.left;
        baseTop = rect.top;
        grabX = x - rect.left;
        grabY = y - rect.top;
        lastX = x;

        ghost = handle.cloneNode(true) as HTMLElement;
        ghost.classList.add("tasks-drag-ghost");
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghost.style.left = `${baseLeft}px`;
        ghost.style.top = `${baseTop}px`;
        ghost.style.transform = "translate(0px, 0px) rotate(0deg) scale(1)";
        document.body.appendChild(ghost);
        requestAnimationFrame(() => ghost?.classList.add("lifted"));

        handle.classList.add("tasks-drag-placeholder");
        document.body.classList.add("tasks-dragging");
      };

      const positionGhost = (x: number, y: number) => {
        if (!ghost) return;
        const dxv = x - lastX;
        lastX = x;
        const targetTilt = Math.max(-6, Math.min(6, dxv * 0.7));
        tilt += (targetTilt - tilt) * 0.35;
        const tx = x - grabX - baseLeft;
        const ty = y - grabY - baseTop;
        ghost.style.transform = `translate(${tx}px, ${ty}px) rotate(${tilt.toFixed(2)}deg) scale(1.04)`;
      };

      const settleGhost = (andThen: () => void) => {
        if (!ghost) {
          andThen();
          return;
        }
        const g = ghost;
        const rect = handle.getBoundingClientRect();
        g.classList.remove("lifted");
        g.classList.add("settling");
        g.style.transform = `translate(${rect.left - baseLeft}px, ${rect.top - baseTop}px) rotate(0deg) scale(1)`;
        let done = false;
        const finishSettle = () => {
          if (done) return;
          done = true;
          g.remove();
          andThen();
        };
        g.addEventListener("transitionend", finishSettle, { once: true });
        setTimeout(finishSettle, 260); // safety net if transitionend never fires
      };

      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        } catch {
          /* capture may already be gone */
        }
        if (!dragging) return;
        document.body.classList.remove("tasks-dragging");
        clearIndicators();
        const shouldCommit = commit && dropStatus;
        if (!shouldCommit) revertPlaceholder();
        handle.classList.remove("tasks-drag-placeholder");
        settleGhost(() => {
          if (shouldCommit) moveTask(task, dropStatus as TaskStatus, dropBeforeId);
          else renderMain(); // matches the (already-reverted) visual state, so this is a no-op paint
        });
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
          startDrag(ev.clientX, ev.clientY);
        }
        positionGhost(ev.clientX, ev.clientY);

        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const container = under?.closest<HTMLElement>("[data-status]");
        if (!container || (!allowStatusChange && container.dataset.status !== task.status)) {
          if (dropKey !== "") {
            clearIndicators();
            revertPlaceholder();
            dropStatus = null;
            dropBeforeId = null;
            dropKey = "";
          }
          return;
        }
        const status = container.dataset.status as TaskStatus;
        const host = dragHost(container);
        const items = Array.from(
          host.querySelectorAll<HTMLElement>(".tasks-row, .tasks-drag-item")
        ).filter((c) => c !== handle);
        let before: HTMLElement | null = null;
        for (const c of items) {
          const r = c.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            before = c;
            break;
          }
        }
        const beforeId = before?.dataset.taskId ?? null;
        const key = `${status}|${beforeId}`;
        if (key === dropKey) return;
        dropKey = key;
        dropStatus = status;
        dropBeforeId = beforeId;

        clearIndicators();
        container.classList.add("drop-active");
        flip(
          dragItems().filter((el) => el !== handle),
          () => {
            if (before) host.insertBefore(handle, before);
            else appendCard(host, handle);
          }
        );
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(ev.type === "pointerup");
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }

  function moveTask(task: Task, newStatus: TaskStatus, beforeId: string | null): void {
    const list = ownerArray(task);
    if (!list) return;
    const idx = list.indexOf(task);
    if (idx < 0) return;
    list.splice(idx, 1);
    if (task.status !== newStatus) {
      task.status = newStatus;
      task.updatedAt = Date.now();
    }
    if (beforeId) {
      const bi = list.findIndex((t) => t.id === beforeId);
      list.splice(bi < 0 ? list.length : bi, 0, task);
    } else {
      let insertAt = list.length;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].status === newStatus) {
          insertAt = i + 1;
          break;
        }
      }
      list.splice(insertAt, 0, task);
    }
    store.save();
    renderMain();
    if (selectedTaskId === task.id) renderDrawer();
  }

  /** The row's status dot steps the task through its session's stages in board
   *  order, wrapping at the end — with custom stages there is no fixed triple
   *  to cycle through any more. */
  function cycleStatus(task: Task): void {
    const owner = ownerSession(task) ?? homeSession;
    if (!owner) return;
    const order = sessionStages(owner);
    const i = order.findIndex((st) => st.id === task.status);
    task.status = order[(i + 1) % order.length].id;
    touch(task);
    renderMain();
    if (selectedTaskId === task.id) renderDrawer();
  }

  async function attachFiles(task: Task): Promise<void> {
    const picked = await openFileDialog({ multiple: true, title: "Attach files to task" });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;
    for (const p of paths) if (!task.files.includes(p)) task.files.push(p);
    touch(task);
    renderDrawer();
    renderMain();
  }

  async function deleteTask(task: Task): Promise<void> {
    const ok = await handlers.confirmDelete(task.title || "Untitled task");
    if (!ok) return;
    const arr = ownerArray(task);
    const idx = arr ? arr.indexOf(task) : -1;
    if (arr && idx >= 0) arr.splice(idx, 1);
    if (selectedTaskId === task.id) selectedTaskId = null;
    store.save();
    renderMain();
    renderDrawer();

    if (arr && idx >= 0) {
      trash.push({
        label: `Task “${task.title || "Untitled task"}” deleted`,
        restore: () => {
          arr.splice(Math.min(idx, arr.length), 0, task);
          store.save();
          renderMain();
          renderDrawer();
        },
      });
    }
  }

  /** The session that owns a task — needed by the delegate flow even when the
   *  panel's current scope is a different one. */
  function ownerSession(task: Task): Session | null {
    for (const s of store.state.sessions) {
      if (sessionTasks(s).includes(task)) return s;
    }
    return null;
  }

  // ================= delegation =================

  function delegationPillLabel(t: Task): string {
    const d = t.delegation;
    if (!d) return "";
    switch (d.status) {
      case "scheduled": {
        const at =
          d.trigger.type === "at"
            ? new Date(d.trigger.time)
            : new Date(d.createdAt);
        return `Scheduled · ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      }
      case "waiting":
        return d.trigger.type === "pane-finish"
          ? `Waiting on “${d.trigger.label}”`
          : "Waiting";
      case "running":
        return "Running…";
      case "done":
        return "Delegated · done";
      case "failed":
        return "Delegation failed";
      default:
        return "Delegation cancelled";
    }
  }

  /** The card/row-level control: a robot icon button while nothing is pending,
   *  a live status pill once a delegation is scheduled/waiting/running. */
  function delegationControl(t: Task, session: Session): HTMLElement {
    if (t.delegation && delegationActive(t.delegation)) {
      const pill = document.createElement("button");
      pill.className = `tasks-chip tasks-deleg-pill tasks-deleg-${t.delegation.status}`;
      pill.title = "View / manage this delegation";
      pill.innerHTML = `${ICONS.robot}<span>${esc(delegationPillLabel(t))}</span>`;
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        openDelegatePopover(t, session, pill);
      });
      return pill;
    }
    const btn = document.createElement("button");
    btn.className = "tasks-row-trash tasks-delegate-btn";
    btn.innerHTML = ICONS.robot;
    btn.title = "Delegate to an AI agent";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDelegatePopover(t, session, btn);
    });
    return btn;
  }

  let popoverEl: HTMLElement | null = null;
  /** The button the popover hangs off, so the outside-click handler can spare it
   *  and so a second click on it closes instead of reopening. */
  let popoverAnchor: HTMLElement | null = null;

  /** `immediate` tears the popover out without the collapse animation — for when
   *  it's being replaced right away (reopened on another task) or the whole
   *  panel is closing underneath it. */
  function closeDelegatePopover(immediate = false): void {
    const pop = popoverEl;
    popoverEl = null;
    popoverAnchor = null;
    window.removeEventListener("pointerdown", onPopoverOutside, true);
    window.removeEventListener("keydown", onPopoverKey, true);
    if (!pop) return;
    if (immediate) {
      cancelCollapse(pop);
      pop.remove();
    } else {
      collapse(pop, () => pop.remove());
    }
  }

  function onPopoverOutside(e: PointerEvent): void {
    const t = e.target as Node;
    // The anchor's own click toggles; closing on its pointerdown would let that
    // click reopen the popover we just dismissed.
    if (popoverEl && !popoverEl.contains(t) && !popoverAnchor?.contains(t)) {
      closeDelegatePopover();
    }
  }

  function onPopoverKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeDelegatePopover();
    }
  }

  /** The delegate dialog: pick an agent CLI, pick when it should start
   *  (now / at a time / when another terminal goes quiet), confirm. Reopening it
   *  for a task with a live delegation doubles as the reschedule/cancel view. */
  function openDelegatePopover(task: Task, session: Session, anchor: HTMLElement): void {
    // Clicking the same button again closes the popover rather than rebuilding
    // it — and that one gets the collapse animation. Moving to a different task's
    // button swaps instantly instead, so the two don't overlap on screen.
    const reclick = popoverEl !== null && popoverAnchor === anchor;
    closeDelegatePopover(!reclick);
    if (reclick) return;

    let agent: DelegationAgent = task.delegation?.agent ?? DELEGATION_AGENTS[0].id;
    type DelegWhen = "now" | "at" | "pane-finish";
    let when: DelegWhen =
      task.delegation?.trigger.type === "pane-finish" ? "pane-finish" : "now";
    const defAt = new Date(Date.now() + 60 * 60 * 1000);
    const atValue = (): string => {
      const p = (n: number): string => String(n).padStart(2, "0");
      return `${defAt.getFullYear()}-${p(defAt.getMonth() + 1)}-${p(defAt.getDate())}T${p(defAt.getHours())}:${p(defAt.getMinutes())}`;
    };
    const openPanes = handlers.listOpenPanes();
    const prevPane =
      task.delegation?.trigger.type === "pane-finish" ? task.delegation.trigger.paneId : null;
    let paneId: string | null =
      openPanes.find((p) => p.paneId === prevPane)?.paneId ?? openPanes[0]?.paneId ?? null;

    const pop = document.createElement("div");
    pop.className = "deleg-popover";

    const head = document.createElement("div");
    head.className = "deleg-head";
    head.innerHTML = `<span>${ICONS.robot}</span><strong>Delegate task</strong>`;
    pop.appendChild(head);

    // ---- agent picker ----
    const agentWrap = document.createElement("div");
    agentWrap.className = "deleg-field";
    agentWrap.appendChild(Object.assign(document.createElement("label"), { textContent: "Run with" }));
    const agentRow = document.createElement("div");
    agentRow.className = "deleg-agents";
    for (const a of DELEGATION_AGENTS) {
      const b = document.createElement("button");
      b.className = "deleg-agent-btn";
      b.innerHTML = `${ICONS.robot}<span>${esc(a.label)}</span>`;
      b.classList.toggle("active", a.id === agent);
      b.addEventListener("click", () => {
        agent = a.id;
        agentRow.querySelectorAll(".deleg-agent-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
      agentRow.appendChild(b);
    }
    agentWrap.appendChild(agentRow);
    pop.appendChild(agentWrap);

    // ---- trigger picker ----
    const whenWrap = document.createElement("div");
    whenWrap.className = "deleg-field";
    whenWrap.appendChild(Object.assign(document.createElement("label"), { textContent: "When" }));
    const whenRow = document.createElement("div");
    whenRow.className = "deleg-whens";
    const extraWrap = document.createElement("div");

    const whenOptions: { id: DelegWhen; label: string }[] = [
      { id: "now", label: "Start now" },
      { id: "at", label: "At a time…" },
      { id: "pane-finish", label: "When a terminal finishes…" },
    ];
    const refreshExtra = (): void => {
      extraWrap.replaceChildren();
      if (when === "at") {
        const dt = document.createElement("input");
        dt.type = "datetime-local";
        dt.className = "deleg-datetime";
        dt.value = atValue();
        dt.addEventListener("change", () => {
          const ms = dt.valueAsNumber;
          if (!Number.isNaN(ms)) defAt.setTime(ms);
        });
        extraWrap.appendChild(dt);
      } else if (when === "pane-finish") {
        if (openPanes.length === 0) {
          const none = document.createElement("div");
          none.className = "deleg-panes-empty";
          none.textContent = "No other terminal panes are open.";
          extraWrap.appendChild(none);
        } else {
          const list = document.createElement("div");
          list.className = "deleg-panes";
          for (const p of openPanes) {
            const b = document.createElement("button");
            b.className = "deleg-pane-btn";
            b.classList.toggle("active", p.paneId === paneId);
            b.innerHTML =
              `<span class="tasks-session-dot" style="background:${p.sessionColor}"></span>` +
              `<span class="deleg-pane-name">${esc(p.sessionName)} · ${esc(p.title || "terminal")}</span>` +
              `<span class="deleg-pane-last">${esc(p.lastLine.slice(0, 60))}</span>`;
            b.addEventListener("click", () => {
              paneId = p.paneId;
              list.querySelectorAll(".deleg-pane-btn").forEach((x) => x.classList.remove("active"));
              b.classList.add("active");
            });
            list.appendChild(b);
          }
          extraWrap.appendChild(list);
        }
      }
    };
    for (const o of whenOptions) {
      const b = document.createElement("button");
      b.className = "deleg-when-btn";
      b.textContent = o.label;
      b.classList.toggle("active", o.id === when);
      b.addEventListener("click", () => {
        when = o.id;
        whenRow.querySelectorAll(".deleg-when-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        refreshExtra();
      });
      whenRow.appendChild(b);
    }
    whenWrap.append(whenRow, extraWrap);
    refreshExtra();
    pop.appendChild(whenWrap);

    // ---- actions ----
    const actions = document.createElement("div");
    actions.className = "deleg-actions";
    if (task.delegation && delegationActive(task.delegation)) {
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "deleg-cancel-btn";
      cancelBtn.textContent = "Cancel delegation";
      cancelBtn.addEventListener("click", () => {
        handlers.onCancelDelegate(session, task);
        closeDelegatePopover();
      });
      actions.appendChild(cancelBtn);
    }
    const goBtn = document.createElement("button");
    goBtn.className = "deleg-go-btn";
    goBtn.textContent = task.delegation && delegationActive(task.delegation)
      ? "Replace delegation"
      : "Delegate task";
    goBtn.addEventListener("click", () => {
      let trigger: DelegationTrigger;
      if (when === "at") {
        trigger = { type: "at", time: Math.max(Date.now(), defAt.getTime()) };
      } else if (when === "pane-finish") {
        const target = openPanes.find((p) => p.paneId === paneId);
        if (!target) return;
        trigger = {
          type: "pane-finish",
          sessionId: target.sessionId,
          paneId: target.paneId,
          label: `${target.sessionName} · ${target.title || "terminal"}`,
        };
      } else {
        trigger = { type: "now" };
      }
      handlers.onDelegate(session, task, agent, trigger);
      closeDelegatePopover();
    });
    actions.appendChild(goBtn);
    pop.appendChild(actions);

    const r = anchor.getBoundingClientRect();
    document.body.appendChild(pop);
    popoverEl = pop;
    popoverAnchor = anchor;

    // Park it at the anchor first, then make it visible and measure the real
    // size (it's display:none until .visible, so measuring before that gives
    // a 0×0 rect and the clamps would push it off-screen), then re-clamp.
    pop.style.left = `${r.left}px`;
    pop.style.top = `${r.bottom + 6}px`;
    requestAnimationFrame(() => {
      pop.classList.add("visible");
      const pr = pop.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.left), window.innerWidth - pr.width - 8);
      let top = r.bottom + 6;
      if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    });

    setTimeout(() => {
      window.addEventListener("pointerdown", onPopoverOutside, true);
      window.addEventListener("keydown", onPopoverKey, true);
    }, 0);
  }

  // ================= stage menu =================

  let stageMenuEl: HTMLElement | null = null;
  let stageMenuAnchor: HTMLElement | null = null;

  function closeStageMenu(immediate = false): void {
    const menu = stageMenuEl;
    stageMenuEl = null;
    stageMenuAnchor = null;
    window.removeEventListener("pointerdown", onStageMenuOutside, true);
    window.removeEventListener("keydown", onStageMenuKey, true);
    if (!menu) return;
    if (immediate) {
      cancelCollapse(menu);
      menu.remove();
    } else {
      collapse(menu, () => menu.remove());
    }
  }

  function onStageMenuOutside(e: PointerEvent): void {
    const t = e.target as Node;
    if (stageMenuEl && !stageMenuEl.contains(t) && !stageMenuAnchor?.contains(t)) closeStageMenu();
  }

  function onStageMenuKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeStageMenu();
    }
  }

  /** Parks a floating menu under its anchor, then clamps it into the viewport
   *  once it has a real size (it measures 0×0 while still display:none). */
  function placeAnchored(el: HTMLElement, anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    el.style.left = `${r.left}px`;
    el.style.top = `${r.bottom + 6}px`;
    requestAnimationFrame(() => {
      el.classList.add("visible");
      const pr = el.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.right - pr.width), window.innerWidth - pr.width - 8);
      let top = r.bottom + 6;
      if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
      el.style.left = `${Math.max(8, left)}px`;
      el.style.top = `${top}px`;
    });
  }

  /** Everything you can do to a column, in one menu: rename, recolour, mark as
   *  the finished stage, reorder, delete. Delete asks where its tasks should go
   *  rather than refusing (or silently dropping them). */
  function openStageMenu(stage: TaskStage, anchor: HTMLElement): void {
    const reclick = stageMenuEl !== null && stageMenuAnchor === anchor;
    closeStageMenu(!reclick);
    if (reclick || !homeSession) return;

    const stages = sessionStages(homeSession);
    const index = stages.indexOf(stage);
    const taskCount = sessionTasks(homeSession).filter((t) => t.status === stage.id).length;

    const menu = document.createElement("div");
    menu.className = "stage-menu";

    const body = document.createElement("div");
    body.className = "stage-menu-body";
    menu.appendChild(body);

    const item = (
      label: string,
      icon: string,
      onPick: () => void,
      opts: { danger?: boolean; disabled?: boolean } = {}
    ): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = `stage-menu-item${opts.danger ? " danger" : ""}`;
      b.innerHTML = `${icon}<span>${esc(label)}</span>`;
      b.disabled = !!opts.disabled;
      b.addEventListener("click", onPick);
      return b;
    };

    body.appendChild(
      item("Rename", ICONS.pencil, () => {
        closeStageMenu();
        renamingStageId = stage.id;
        render();
        requestAnimationFrame(focusStageRename);
      })
    );

    // ---- colour ----
    const colorField = document.createElement("div");
    colorField.className = "stage-menu-field";
    colorField.innerHTML = `<label>Colour</label>`;
    const swatches = document.createElement("div");
    swatches.className = "stage-swatches";
    const addSwatch = (color: string | null): void => {
      const s = document.createElement("button");
      s.className = "stage-swatch";
      s.classList.toggle("active", (stage.color ?? null) === color);
      s.classList.toggle("none", color === null);
      s.title = color === null ? "No colour" : color;
      if (color) s.style.background = color;
      s.addEventListener("click", () => {
        setStageColor(stage, color);
        swatches
          .querySelectorAll(".stage-swatch")
          .forEach((x) => x.classList.remove("active"));
        s.classList.add("active");
      });
      swatches.appendChild(s);
    };
    addSwatch(null);
    STAGE_COLORS.forEach(addSwatch);
    colorField.appendChild(swatches);
    body.appendChild(colorField);

    // ---- "counts as finished" ----
    const doneRow = document.createElement("button");
    doneRow.className = "stage-menu-item stage-menu-toggle";
    doneRow.innerHTML =
      `${ICONS.check}<span>Counts as finished</span>` +
      `<span class="stage-switch${stage.done ? " on" : ""}"></span>`;
    doneRow.title = "Tasks in this stage are struck through and left out of the open-task count";
    doneRow.addEventListener("click", () => {
      setDoneStage(stage, !stage.done);
      closeStageMenu();
    });
    body.appendChild(doneRow);

    // ---- order ----
    const orderField = document.createElement("div");
    orderField.className = "stage-menu-field";
    orderField.innerHTML = `<label>Order</label>`;
    const orderRow = document.createElement("div");
    orderRow.className = "stage-order";
    const left = document.createElement("button");
    left.className = "stage-order-btn";
    left.innerHTML = `${ICONS.arrowLeft}<span>Move left</span>`;
    left.disabled = index <= 0;
    left.addEventListener("click", () => {
      moveStage(stage, -1);
      closeStageMenu();
    });
    const right = document.createElement("button");
    right.className = "stage-order-btn";
    right.innerHTML = `<span>Move right</span>${ICONS.arrowRight}`;
    right.disabled = index >= stages.length - 1;
    right.addEventListener("click", () => {
      moveStage(stage, 1);
      closeStageMenu();
    });
    orderRow.append(left, right);
    orderField.appendChild(orderRow);
    body.appendChild(orderField);

    // ---- delete ----
    const canDelete = stages.length > 1;
    const delBtn = item(
      taskCount ? `Delete stage (${taskCount} tasks)` : "Delete stage",
      ICONS.trash,
      () => {
        if (taskCount === 0) {
          deleteStage(stage, stages.find((s) => s !== stage)!.id);
          closeStageMenu();
          return;
        }
        // With tasks in it, deleting is a two-step: pick their new home first.
        body.replaceChildren();
        const q = document.createElement("div");
        q.className = "stage-menu-confirm";
        q.textContent = `Delete “${stage.label}” and move its ${taskCount} ${
          taskCount === 1 ? "task" : "tasks"
        } to:`;
        body.appendChild(q);
        for (const target of stages) {
          if (target === stage) continue;
          const b = document.createElement("button");
          b.className = "stage-menu-item";
          b.innerHTML =
            `<span class="tasks-group-dot" style="background:${esc(stageColor(target))}"></span>` +
            `<span>${esc(target.label)}</span>`;
          b.addEventListener("click", () => {
            deleteStage(stage, target.id);
            closeStageMenu();
          });
          body.appendChild(b);
        }
        const back = document.createElement("button");
        back.className = "stage-menu-item";
        back.innerHTML = `${ICONS.arrowLeft}<span>Cancel</span>`;
        back.addEventListener("click", () => closeStageMenu());
        body.appendChild(back);
      },
      { danger: true, disabled: !canDelete }
    );
    if (!canDelete) delBtn.title = "A board keeps at least one stage";
    body.appendChild(delBtn);

    document.body.appendChild(menu);
    stageMenuEl = menu;
    stageMenuAnchor = anchor;
    placeAnchored(menu, anchor);
    setTimeout(() => {
      window.addEventListener("pointerdown", onStageMenuOutside, true);
      window.addEventListener("keydown", onStageMenuKey, true);
    }, 0);
  }

  function createNewTask(status?: TaskStatus): void {
    if (!homeSession) return;
    const t = newTask("");
    // No stage given (the header's "New task") means the first column, which is
    // where a board's intake belongs.
    t.status = status ?? sessionStages(homeSession)[0].id;
    sessionTasks(homeSession).push(t);
    store.save();
    selectedTaskId = t.id;
    renderMain();
    renderDrawer();
    requestAnimationFrame(() => {
      drawer.querySelector<HTMLInputElement>(".tasks-drawer-title")?.focus();
    });
  }

  // ================= filtering =================

  function matches(t: Task): boolean {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.title.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }

  /** Task+owning-session pairs, filtered by the search box. */
  function visibleEntriesFiltered(): { task: Task; session: Session }[] {
    return visibleEntries().filter((e) => matches(e.task));
  }

  // ================= rendering =================

  function render(): void {
    if (!homeSession) return;
    const entries = visibleEntries();
    const done = entries.filter((e) => isTaskDone(e.session, e.task)).length;
    const open = entries.length - done;
    subtitle.textContent =
      scope === "all"
        ? `All sessions (${visibleSessions().length}) · ${open} open · ${done} done`
        : `${homeSession.name} · ${open} open · ${done} done`;
    listViewBtn.classList.toggle("active", view === "list");
    kanbanViewBtn.classList.toggle("active", view === "kanban");
    scopeSessionBtn.classList.toggle("active", scope === "session");
    scopeAllBtn.classList.toggle("active", scope === "all");
    filters.classList.toggle("hidden", view !== "list");
    const targetNote = scope === "all" ? ` (adds to “${homeSession.name}”)` : "";
    newBtn.title = `New task${targetNote}`;
    renderFilters();
    renderMain();
    renderDrawer();
  }

  function renderFilters(): void {
    const stages = boardStages();
    const all = scopeTasks();
    const chips: { id: "all" | TaskStatus; label: string; color?: string | null }[] = [
      { id: "all", label: "All" },
      ...stages.map((st) => ({ id: st.id, label: st.label, color: st.color })),
    ];
    // A stage that was deleted or renamed away can still be the active filter;
    // fall back to "All" rather than showing an empty board with no way back.
    if (filterStatus !== "all" && !stages.some((st) => st.id === filterStatus)) filterStatus = "all";
    filters.replaceChildren(
      ...chips.map((c) => {
        const count =
          c.id === "all" ? all.length : all.filter((t) => t.status === c.id).length;
        const btn = document.createElement("button");
        btn.className = "tasks-filter-chip";
        btn.classList.toggle("active", filterStatus === c.id);
        const dot = c.color
          ? `<span class="tasks-group-dot" style="background:${esc(c.color)}"></span>`
          : "";
        btn.innerHTML = `${dot}${esc(c.label)}<span class="tasks-filter-count">${count}</span>`;
        btn.addEventListener("click", () => {
          filterStatus = c.id;
          renderFilters();
          renderMain();
        });
        return btn;
      })
    );
  }

  function renderMain(): void {
    main.classList.toggle("kanban-mode", view === "kanban");
    if (view === "list") renderListView();
    else renderKanbanView();
  }

  function renderListView(): void {
    const vis = visibleEntriesFiltered();
    const stages = boardStages();
    const groups = filterStatus === "all" ? stages : stages.filter((s) => s.id === filterStatus);

    if (scopeTasks().length === 0) {
      main.replaceChildren(emptyState());
      return;
    }
    if (vis.length === 0) {
      main.innerHTML = `<div class="tasks-empty"><div class="tasks-empty-mark">${ICONS.search}</div><p>No tasks match your search.</p><p class="tasks-dim">Try a different word, or clear the search box.</p></div>`;
      return;
    }

    const sections = groups.map((g) => {
      const rows = vis.filter((e) => stageIdFor(e.task, stages) === g.id);
      const section = document.createElement("div");
      section.className = "tasks-status-group";
      section.dataset.status = g.id;
      section.appendChild(buildStageHead(g, rows.length, "group"));
      if (rows.length === 0) {
        const ph = document.createElement("div");
        ph.className = "tasks-group-empty";
        ph.textContent = "Nothing here";
        section.appendChild(ph);
      } else {
        rows.forEach((e) => section.appendChild(buildRow(e.task, e.session)));
      }
      return section;
    });

    // The list gets the same "add a stage" affordance as the board, as a plain
    // row at the end where the next group would start.
    if (canEditStages() && filterStatus === "all") {
      const add = document.createElement("button");
      add.className = "tasks-add-stage-row";
      add.innerHTML = `${ICONS.plus}<span>Add stage</span>`;
      add.addEventListener("click", () => addStage());
      sections.push(add as unknown as HTMLDivElement);
    }
    main.replaceChildren(...sections);
  }

  function buildRow(t: Task, session: Session): HTMLElement {
    const badgeSession = scope === "all" ? session : undefined;
    const row = document.createElement("div");
    row.className = "tasks-row";
    row.dataset.taskId = t.id;
    row.classList.toggle("selected", selectedTaskId === t.id);
    const stage = stageOf(session, t.status);
    const done = stage.done === true;
    row.classList.toggle("done", done);

    const pill = document.createElement("button");
    pill.className = "tasks-status-pill";
    pill.classList.toggle("tasks-status-done", done);
    // An uncoloured stage keeps the neutral ring; a coloured one tints its own.
    if (!done && stage.color) {
      pill.style.borderColor = stage.color;
      pill.style.background = `color-mix(in srgb, ${stage.color} 18%, transparent)`;
    } else if (done) {
      pill.style.borderColor = stage.color || "var(--success)";
      pill.style.background = stage.color || "var(--success)";
    }
    pill.title = `${stage.label} — click for the next stage`;
    pill.innerHTML = done ? ICONS.check : "";
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleStatus(t);
    });

    // Title left, metadata right — a full-width row with everything crammed
    // into its left third read as a mis-sized slab at this panel width.
    const titleEl = document.createElement("div");
    titleEl.className = "tasks-row-title";
    titleEl.textContent = t.title || "Untitled task";
    titleEl.title = t.title || "Untitled task";

    const meta = buildMetaRow(t, session, badgeSession);

    const trash = document.createElement("button");
    trash.className = "tasks-row-trash";
    trash.innerHTML = ICONS.trash;
    trash.title = "Delete task";
    trash.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteTask(t);
    });

    row.append(pill, titleEl);
    if (meta) row.appendChild(meta);
    row.append(delegationControl(t, session), trash);
    row.addEventListener("click", () => selectTask(t.id));
    if (scope === "session") bindDrag(row, t, false);
    return row;
  }

  function buildMetaRow(t: Task, session: Session, badgeSession?: Session): HTMLElement | null {
    const parts: string[] = [];
    const overdue = isOverdue(t, session);
    if (badgeSession) {
      parts.push(
        `<span class="tasks-chip tasks-session-chip"><span class="tasks-session-dot" style="background:${badgeSession.color}"></span>${esc(badgeSession.name)}</span>`
      );
    }
    parts.push(`<span class="tasks-chip tasks-prio" style="--c:${priorityColor(t.priority)}">${esc(priorityLabel(t.priority))}</span>`);
    if (t.dueDate) {
      parts.push(
        `<span class="tasks-chip tasks-due${overdue ? " overdue" : ""}">${ICONS.calendar}${esc(fmtDue(t.dueDate))}</span>`
      );
    }
    if (t.subtasks.length) {
      const done = t.subtasks.filter((s) => s.done).length;
      parts.push(`<span class="tasks-chip">${done}/${t.subtasks.length} subtasks</span>`);
    }
    if (t.files.length) {
      parts.push(`<span class="tasks-chip">${ICONS.paperclip}${t.files.length}</span>`);
    }
    for (const tag of t.tags.slice(0, 3)) {
      parts.push(`<span class="tasks-chip tasks-tag">#${esc(tag)}</span>`);
    }
    if (parts.length === 0) return null;
    const meta = document.createElement("div");
    meta.className = "tasks-row-meta";
    meta.innerHTML = parts.join("");
    return meta;
  }

  function renderKanbanView(): void {
    const vis = visibleEntriesFiltered();
    const stages = boardStages();
    // Unlike the list, the board always renders its columns: an empty board is
    // still the place where you set stages up, so it must not collapse into a
    // blank slate with nothing to click.
    const cols: HTMLElement[] = stages.map((g) => {
      const col = document.createElement("div");
      col.className = "tasks-col";
      col.dataset.status = g.id;
      if (g.done) col.classList.add("tasks-col-done");

      const rows = vis.filter((e) => stageIdFor(e.task, stages) === g.id);
      col.appendChild(buildStageHead(g, rows.length, "col"));

      const colBody = document.createElement("div");
      colBody.className = "tasks-col-body";
      rows.forEach((e) => colBody.appendChild(buildCard(e.task, e.session)));

      if (rows.length === 0) {
        const ph = document.createElement("div");
        ph.className = "tasks-col-empty";
        ph.textContent = search ? "No matches" : "Drop tasks here";
        colBody.appendChild(ph);
      }

      // The add button lives inside the scrolling body so it always sits right
      // under the last card instead of at the far bottom of a tall column.
      const addBtn = document.createElement("button");
      addBtn.className = "tasks-col-add";
      addBtn.innerHTML = `${ICONS.plus}<span>Add task</span>`;
      addBtn.addEventListener("click", () => createNewTask(g.id));
      colBody.appendChild(addBtn);

      col.appendChild(colBody);
      return col;
    });

    if (canEditStages()) cols.push(buildAddStageRail());
    main.replaceChildren(...cols);
  }

  /** The vertical strip after the last column: a plus and a sideways label that
   *  widen on hover. The rail sits inside a slot that already reserves its
   *  widened size, so growing it never nudges the columns or the board's right
   *  padding — it just grows leftward into space that was always there. */
  function buildAddStageRail(): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "tasks-add-stage-slot";
    const rail = document.createElement("button");
    rail.className = "tasks-add-stage";
    rail.title = "Add a stage";
    rail.innerHTML = `${ICONS.plus}<span class="tasks-add-stage-label">Add stage</span>`;
    rail.addEventListener("click", () => addStage());
    slot.appendChild(rail);
    return slot;
  }

  function buildCard(t: Task, session: Session): HTMLElement {
    const badgeSession = scope === "all" ? session : undefined;
    const card2 = document.createElement("div");
    card2.className = "tasks-card2";
    card2.dataset.taskId = t.id;
    card2.classList.toggle("selected", selectedTaskId === t.id);

    // Title and the hover-revealed actions share the card's first row. Priority
    // is carried by the coloured chip in the meta row, so there is no separate
    // dot to duplicate it.
    const top = document.createElement("div");
    top.className = "tasks-card2-head";

    const titleEl = document.createElement("div");
    titleEl.className = "tasks-card2-title";
    titleEl.textContent = t.title || "Untitled task";
    top.appendChild(titleEl);

    const trash = document.createElement("button");
    trash.className = "tasks-row-trash";
    trash.innerHTML = ICONS.trash;
    trash.title = "Delete task";
    trash.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteTask(t);
    });

    const cardActions = document.createElement("div");
    cardActions.className = "tasks-card2-actions";
    const deleg = delegationControl(t, session);
    // A live delegation is status, not an action — it belongs in the meta row
    // under the title, where the other chips live.
    if (deleg.classList.contains("tasks-deleg-pill")) {
      cardActions.appendChild(trash);
      top.appendChild(cardActions);
      card2.append(top);
      const delegRow = document.createElement("div");
      delegRow.className = "tasks-row-meta";
      delegRow.appendChild(deleg);
      card2.appendChild(delegRow);
    } else {
      cardActions.append(deleg, trash);
      top.appendChild(cardActions);
      card2.append(top);
    }

    const meta = buildMetaRow(t, session, badgeSession);
    if (meta) {
      meta.classList.add("tasks-card2-meta");
      card2.appendChild(meta);
    }

    // Under the chips, not under the title — sitting directly below the title it
    // read as an underline rather than as progress.
    if (t.subtasks.length) {
      const done = t.subtasks.filter((s) => s.done).length;
      const bar = document.createElement("div");
      bar.className = "tasks-card2-progress";
      bar.innerHTML = `<span style="width:${(done / t.subtasks.length) * 100}%"></span>`;
      card2.appendChild(bar);
    }

    card2.addEventListener("click", () => selectTask(t.id));
    // Dedicated hook for bindDrag's generic lookup — "tasks-card" is already the
    // panel's outer shell class, so reusing it here made every kanban card inherit
    // that shell's fixed width/height.
    card2.classList.add("tasks-drag-item");
    if (scope === "session") bindDrag(card2, t, true);
    return card2;
  }

  function emptyState(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "tasks-empty";
    const body =
      scope === "all"
        ? `<p>No tasks yet in any session.</p><p class="tasks-dim">Add one to start tracking work here.</p>`
        : `<p>No tasks yet in this session.</p><p class="tasks-dim">Tasks are scoped to this session. Add one to start tracking work here.</p>`;
    wrap.innerHTML = `<div class="tasks-empty-mark">${ICONS.checklist}</div>${body}`;
    const cta = document.createElement("button");
    cta.className = "tasks-new-btn tasks-empty-cta";
    cta.innerHTML = `${ICONS.plus}<span>New task</span>`;
    cta.addEventListener("click", () => createNewTask());
    wrap.appendChild(cta);
    return wrap;
  }

  // ---- drawer ----

  /** Pending clear of the drawer's contents, held until its close animation has
   *  finished so the panel does not empty out mid-slide. */
  let drawerClearTimer: number | undefined;

  function renderDrawer(): void {
    const t = selectedTaskId ? findTask(selectedTaskId) : undefined;
    if (!t) {
      // The body is a grid whose second track animates from 0 to the drawer
      // width, so closing pushes the board back out rather than cutting away.
      body.classList.remove("with-drawer");
      drawer.classList.remove("visible");
      window.clearTimeout(drawerClearTimer);
      drawerClearTimer = window.setTimeout(() => {
        if (!selectedTaskId) drawer.replaceChildren();
      }, 280);
      return;
    }
    window.clearTimeout(drawerClearTimer);
    body.classList.add("with-drawer");
    drawer.classList.add("visible");
    drawer.innerHTML = "";

    const head = document.createElement("div");
    head.className = "tasks-drawer-head";
    const label = document.createElement("span");
    label.textContent = "Task details";
    const closeD = document.createElement("button");
    closeD.className = "tasks-icon-btn";
    closeD.innerHTML = ICONS.close;
    closeD.title = "Close details";
    closeD.addEventListener("click", () => selectTask(null));
    head.append(label, closeD);
    drawer.appendChild(head);

    const scroll = document.createElement("div");
    scroll.className = "tasks-drawer-scroll";
    drawer.appendChild(scroll);

    // A textarea, not an input: a long title has to wrap here rather than
    // scroll out of sight behind the drawer's edge. Enter still commits.
    const titleInput = document.createElement("textarea");
    titleInput.className = "tasks-drawer-title";
    titleInput.rows = 1;
    titleInput.placeholder = "Task title…";
    titleInput.value = t.title;
    const autoGrow = (): void => {
      titleInput.style.height = "auto";
      titleInput.style.height = `${titleInput.scrollHeight}px`;
    };
    titleInput.addEventListener("input", () => {
      t.title = titleInput.value;
      autoGrow();
      touch(t);
    });
    titleInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        titleInput.blur();
      }
    });
    titleInput.addEventListener("blur", () => {
      renderMain();
    });
    scroll.appendChild(titleInput);
    // Once now for the height, once after layout in case metrics were not final.
    autoGrow();
    requestAnimationFrame(autoGrow);

    // Stage picker — a wrapping set of chips rather than a segmented control,
    // because a board can have any number of stages and three equal thirds
    // stop working the moment there is a fourth.
    const owner = ownerSession(t) ?? homeSession;
    const stages = owner ? sessionStages(owner) : [];
    const statusWrap = document.createElement("div");
    statusWrap.className = "tasks-field";
    statusWrap.innerHTML = `<label>Stage</label>`;
    const stageRow = document.createElement("div");
    stageRow.className = "tasks-stage-picker";
    for (const st of stages) {
      const b = document.createElement("button");
      b.className = "tasks-stage-option";
      b.classList.toggle("active", st.id === t.status);
      b.innerHTML =
        `<span class="tasks-group-dot" style="background:${esc(stageColor(st))}"></span>` +
        `<span>${esc(st.label)}</span>`;
      b.addEventListener("click", () => {
        t.status = st.id;
        touch(t);
        renderMain();
        renderDrawer();
      });
      stageRow.appendChild(b);
    }
    statusWrap.appendChild(stageRow);
    scroll.appendChild(statusWrap);

    // priority segmented control
    const prioWrap = document.createElement("div");
    prioWrap.className = "tasks-field";
    prioWrap.innerHTML = `<label>Priority</label>`;
    prioWrap.appendChild(
      segmented(
        TASK_PRIORITIES.map((p) => ({ id: p.id, label: p.label })),
        t.priority,
        (id) => {
          t.priority = id as Task["priority"];
          touch(t);
          renderMain();
        },
        "tasks-seg-priority"
      )
    );
    scroll.appendChild(prioWrap);

    // due date
    const dueWrap = document.createElement("div");
    dueWrap.className = "tasks-field";
    dueWrap.innerHTML = `<label>Due date</label>`;
    const dueRow = document.createElement("div");
    dueRow.className = "tasks-due-row";
    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.value = t.dueDate ?? "";
    dueInput.addEventListener("change", () => {
      t.dueDate = dueInput.value || null;
      touch(t);
      renderMain();
    });
    dueRow.appendChild(dueInput);
    if (t.dueDate) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "tasks-icon-btn";
      clearBtn.innerHTML = ICONS.close;
      clearBtn.title = "Clear due date";
      clearBtn.addEventListener("click", () => {
        t.dueDate = null;
        touch(t);
        renderMain();
        renderDrawer();
      });
      dueRow.appendChild(clearBtn);
    }
    dueWrap.appendChild(dueRow);
    scroll.appendChild(dueWrap);

    // tags
    const tagsWrap = document.createElement("div");
    tagsWrap.className = "tasks-field";
    tagsWrap.innerHTML = `<label>Tags</label>`;
    const tagsBox = document.createElement("div");
    tagsBox.className = "tasks-tags-box";
    t.tags.forEach((tag) => {
      const chip = document.createElement("span");
      chip.className = "tasks-chip tasks-tag removable";
      chip.innerHTML = `#${esc(tag)}`;
      const x = document.createElement("button");
      x.innerHTML = ICONS.close;
      x.addEventListener("click", () => {
        t.tags = t.tags.filter((x2) => x2 !== tag);
        touch(t);
        renderDrawer();
        renderMain();
      });
      chip.appendChild(x);
      tagsBox.appendChild(chip);
    });
    const tagInput = document.createElement("input");
    tagInput.className = "tasks-tag-input";
    tagInput.type = "text";
    tagInput.placeholder = t.tags.length ? "" : "Add a tag…";
    tagInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const v = tagInput.value.trim().replace(/^#/, "");
        if (v && !t.tags.includes(v)) {
          t.tags.push(v);
          touch(t);
          renderDrawer();
          renderMain();
          requestAnimationFrame(() =>
            drawer.querySelector<HTMLInputElement>(".tasks-tag-input")?.focus()
          );
        } else {
          tagInput.value = "";
        }
      } else if (e.key === "Backspace" && !tagInput.value && t.tags.length) {
        t.tags.pop();
        touch(t);
        renderDrawer();
        renderMain();
      }
    });
    tagsBox.appendChild(tagInput);
    tagsWrap.appendChild(tagsBox);
    scroll.appendChild(tagsWrap);

    // description
    const descWrap = document.createElement("div");
    descWrap.className = "tasks-field";
    descWrap.innerHTML = `<label>Description</label>`;
    const desc = document.createElement("textarea");
    desc.className = "tasks-desc";
    desc.placeholder = "Notes, context, links…";
    desc.value = t.description;
    desc.rows = 4;
    desc.addEventListener("input", () => {
      t.description = desc.value;
      touch(t);
    });
    descWrap.appendChild(desc);
    scroll.appendChild(descWrap);

    // subtasks
    const subWrap = document.createElement("div");
    subWrap.className = "tasks-field";
    const subDone = t.subtasks.filter((s) => s.done).length;
    subWrap.innerHTML = `<label>Subtasks${
      t.subtasks.length ? ` <span class="tasks-dim">${subDone}/${t.subtasks.length}</span>` : ""
    }</label>`;
    const subList = document.createElement("div");
    subList.className = "tasks-subtasks";
    t.subtasks.forEach((st) => subList.appendChild(buildSubtaskRow(t, st)));
    subWrap.appendChild(subList);

    const subAdd = document.createElement("input");
    subAdd.className = "tasks-subtask-add";
    subAdd.type = "text";
    subAdd.placeholder = "Add subtask…";
    subAdd.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && subAdd.value.trim()) {
        e.preventDefault();
        const sub: SubTask = { id: uid(), title: subAdd.value.trim(), done: false };
        t.subtasks.push(sub);
        touch(t);
        renderDrawer();
        renderMain();
        requestAnimationFrame(() =>
          drawer.querySelector<HTMLInputElement>(".tasks-subtask-add")?.focus()
        );
      }
    });
    subWrap.appendChild(subAdd);
    scroll.appendChild(subWrap);

    // files
    const filesWrap = document.createElement("div");
    filesWrap.className = "tasks-field";
    filesWrap.innerHTML = `<label>Files</label>`;
    const filesList = document.createElement("div");
    filesList.className = "tasks-files";
    t.files.forEach((path) => {
      const chip = document.createElement("div");
      chip.className = "tasks-file-chip";
      chip.title = path;
      const name = document.createElement("span");
      name.innerHTML = `${ICONS.paperclip}${esc(baseName(path))}`;
      name.addEventListener("click", () => handlers.onOpenFile(path, baseName(path)));
      const x = document.createElement("button");
      x.innerHTML = ICONS.close;
      x.title = "Remove attachment";
      x.addEventListener("click", () => {
        t.files = t.files.filter((f) => f !== path);
        touch(t);
        renderDrawer();
        renderMain();
      });
      chip.append(name, x);
      filesList.appendChild(chip);
    });
    filesWrap.appendChild(filesList);
    const attachBtn = document.createElement("button");
    attachBtn.className = "tasks-attach-btn";
    attachBtn.innerHTML = `${ICONS.paperclip}<span>Attach files…</span>`;
    attachBtn.addEventListener("click", () => void attachFiles(t));
    filesWrap.appendChild(attachBtn);
    scroll.appendChild(filesWrap);

    // footer
    const foot = document.createElement("div");
    foot.className = "tasks-drawer-foot";
    const created = new Date(t.createdAt).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const delegSession = ownerSession(t);
    if (delegSession && t.delegation && delegationActive(t.delegation)) {
      const pill = delegationControl(t, delegSession) as HTMLButtonElement;
      if (pill.classList.contains("tasks-deleg-pill")) {
        const statusLine = document.createElement("div");
        statusLine.className = "tasks-drawer-deleg";
        statusLine.appendChild(pill);
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "deleg-cancel-btn";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => {
          handlers.onCancelDelegate(delegSession, t);
          renderDrawer();
          renderMain();
        });
        statusLine.appendChild(cancelBtn);
        foot.appendChild(statusLine);
      }
    }
    const createdEl = document.createElement("div");
    createdEl.className = "tasks-drawer-created";
    createdEl.textContent = `Created ${created}`;
    foot.appendChild(createdEl);

    const drawerFootActions = document.createElement("div");
    drawerFootActions.className = "tasks-drawer-foot-actions";
    if (delegSession) {
      const delegateBtn = document.createElement("button");
      delegateBtn.className = "tasks-delegate-btn-lg";
      delegateBtn.innerHTML = `${ICONS.robot}<span>Delegate…</span>`;
      delegateBtn.addEventListener("click", () => {
        openDelegatePopover(t, delegSession, delegateBtn);
      });
      drawerFootActions.appendChild(delegateBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.className = "tasks-delete-btn";
    delBtn.innerHTML = `${ICONS.trash}<span>Delete task</span>`;
    delBtn.addEventListener("click", () => void deleteTask(t));
    drawerFootActions.appendChild(delBtn);
    foot.appendChild(drawerFootActions);
    drawer.appendChild(foot);
  }

  function segmented(
    options: { id: string; label: string }[],
    active: string,
    onPick: (id: string) => void,
    cls: string
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `tasks-segmented ${cls}`;
    options.forEach((o) => {
      const btn = document.createElement("button");
      btn.className = `tasks-seg-btn tasks-seg-${o.id}`;
      btn.textContent = o.label;
      btn.classList.toggle("active", active === o.id);
      btn.addEventListener("click", () => onPick(o.id));
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function buildSubtaskRow(t: Task, st: SubTask): HTMLElement {
    const row = document.createElement("div");
    row.className = "tasks-subtask-row";
    row.classList.toggle("done", st.done);

    const cb = document.createElement("button");
    cb.className = "tasks-subtask-check";
    cb.innerHTML = st.done ? ICONS.check : "";
    cb.addEventListener("click", () => {
      st.done = !st.done;
      touch(t);
      renderDrawer();
      renderMain();
    });

    const nameInput = document.createElement("input");
    nameInput.className = "tasks-subtask-title";
    nameInput.type = "text";
    nameInput.value = st.title;
    nameInput.addEventListener("input", () => {
      st.title = nameInput.value;
      touch(t);
    });

    const del = document.createElement("button");
    del.className = "tasks-subtask-del";
    del.innerHTML = ICONS.close;
    del.addEventListener("click", () => {
      t.subtasks = t.subtasks.filter((x) => x.id !== st.id);
      touch(t);
      renderDrawer();
      renderMain();
    });

    row.append(cb, nameInput, del);
    return row;
  }

  // ================= open/close =================

  function close(): void {
    if (!open) return;
    if (selectedTaskId) {
      const t = findTask(selectedTaskId);
      if (t) pruneIfEmpty(t);
    }
    open = false;
    selectedTaskId = null;
    homeSession = null;
    scope = "session";
    search = "";
    searchInput.value = "";
    filterStatus = "all";
    closeDelegatePopover(true); // both float on body — don't leave them behind
    closeStageMenu(true);
    renamingStageId = null;
    el.classList.remove("visible");
    handlers.onChanged?.();
  }

  function show(s: Session, focusTaskId?: string): void {
    homeSession = s;
    scope = "session";
    view = s.taskView ?? "list";
    filterStatus = "all";
    search = "";
    searchInput.value = "";
    selectedTaskId = focusTaskId ?? null;
    open = true;
    el.classList.add("visible");
    render();
    if (!focusTaskId) requestAnimationFrame(() => searchInput.focus());
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) close();
  });
  card.addEventListener("pointerdown", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", () => close());
  newBtn.addEventListener("click", () =>
    createNewTask(filterStatus === "all" ? undefined : filterStatus)
  );
  listViewBtn.addEventListener("click", () => {
    view = "list";
    if (homeSession) homeSession.taskView = "list";
    store.save();
    render();
  });
  kanbanViewBtn.addEventListener("click", () => {
    view = "kanban";
    if (homeSession) homeSession.taskView = "kanban";
    store.save();
    render();
  });
  scopeSessionBtn.addEventListener("click", () => {
    if (scope === "session") return;
    scope = "session";
    deselectSilently();
    render();
  });
  scopeAllBtn.addEventListener("click", () => {
    if (scope === "all") return;
    scope = "all";
    deselectSilently();
    render();
  });
  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    renderMain();
  });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      if (selectedTaskId) selectTask(null);
      else close();
    }
  });

  return {
    el,
    show,
    close,
    isOpen: () => open,
    /** Re-render (only while open) — main.ts calls this when a delegation's
     *  status changes behind the panel's back, so pills stay truthful. */
    refresh: () => {
      if (open) render();
    },
  };
}
