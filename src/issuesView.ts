/** The Tasks panel's "Issues" tab: the GitHub issues of the repo a session's
 *  folder belongs to, fetched through the user's `gh` CLI.
 *
 *  It lives inside the Tasks panel card and borrows its layout classes
 *  (toolbar, body grid, sliding drawer) so the two tabs read as one surface.
 *  Everything that touches local tasks — turning an issue into a task,
 *  delegating it — goes back through `IssuesDeps`, so this module never edits
 *  a session's task list behind the panel's back. */

import "./issues.css";
import { collapse, cancelCollapse } from "./popAnim";
import {
  GhComment,
  GhIssue,
  GhStatus,
  ghErrorText,
  ghIssueAssignMe,
  ghIssueComment,
  ghIssueCreate,
  ghIssueList,
  ghIssueSetState,
  ghIssueView,
  ghStatus,
  IssueFilter,
  IssueStateAction,
} from "./github";
import { Session, Task } from "./types";

export interface IssuesDeps {
  /** The session's linked task for this issue, if one was already made. */
  findTask(session: Session, repo: string, number: number): Task | undefined;
  /** Makes (or returns the existing) local task for an issue. */
  ensureTask(session: Session, repo: string, issue: GhIssue): Task;
  /** Jumps to the Tasks tab with `task` open. */
  showTask(task: Task): void;
  /** Opens the delegate popover for `task`, hanging off `anchor`. */
  delegate(session: Session, task: Task, anchor: HTMLElement): void;
  /** Called after an issue closes/reopens, so a linked task can follow it. */
  onIssueState(session: Session, task: Task, closed: boolean): void;
  openUrl(session: Session, url: string): void;
  runInTerminal(session: Session, command: string): void;
  /** Tells the panel the open-issue count changed (for the tab badge). */
  onCount(count: number | null): void;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

const I = {
  search:
    '<svg viewBox="0 0 14 14"><circle cx="6.2" cy="6.2" r="3.9" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="9.2" y1="9.2" x2="12" y2="12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  open: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.7" fill="currentColor"/></svg>',
  done: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M5.4 8.2l1.8 1.8 3.4-3.7"/></svg>',
  skip: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="12" x2="12" y2="4" stroke="currentColor" stroke-width="1.5"/></svg>',
  comment:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M2.2 3.2c0-.6.5-1 1-1h7.6c.6 0 1 .4 1 1v5.2c0 .6-.4 1-1 1H6.4L3.8 11.6V9.4h-.6c-.5 0-1-.4-1-1z"/></svg>',
  refresh:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M11.6 5.6A4.8 4.8 0 1 0 12 8.4"/><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M12 2.6v3.2H8.8"/></svg>',
  external:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" d="M8.2 2.2h3.6v3.6M11.6 2.4L6.6 7.4M10.2 8.4v2.6c0 .4-.3.8-.8.8H3c-.4 0-.8-.4-.8-.8V4.6c0-.5.4-.8.8-.8h2.6"/></svg>',
  close:
    '<svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke="currentColor"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke="currentColor"/></svg>',
  robot:
    '<svg viewBox="0 0 14 14"><rect x="2.5" y="4.5" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.1"/><line x1="7" y1="4.5" x2="7" y2="2.4" stroke="currentColor" stroke-width="1.1"/><circle cx="7" cy="1.8" r="1" fill="currentColor"/><circle cx="5.2" cy="7.6" r="0.9" fill="currentColor"/><circle cx="8.8" cy="7.6" r="0.9" fill="currentColor"/></svg>',
  addTask:
    '<svg viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="7" y1="4.6" x2="7" y2="9.4" stroke="currentColor" stroke-width="1.2"/><line x1="4.6" y1="7" x2="9.4" y2="7" stroke="currentColor" stroke-width="1.2"/></svg>',
  chevron:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M3.8 5.6L7 8.8l3.2-3.2"/></svg>',
  person:
    '<svg viewBox="0 0 14 14"><circle cx="7" cy="4.8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.2"/><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" d="M2.6 12c.5-2.2 2.3-3.5 4.4-3.5s3.9 1.3 4.4 3.5"/></svg>',
  github:
    '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
};

/** "3m", "5h", "2d", then a short date once it's older than a month. */
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Deterministic hue per login, so the same person keeps the same avatar colour. */
function avatar(login: string, cls = "iss-avatar"): string {
  let h = 0;
  for (const c of login) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="${cls}" style="--h:${h}" title="@${esc(login)}">${esc(login.slice(0, 1).toUpperCase())}</span>`;
}

/** A label chip in the label's own GitHub colour, mixed toward the theme so a
 *  bright yellow label stays readable on the dark surface. */
function labelChip(name: string, color: string): string {
  const c = /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "var(--text-dim)";
  return `<span class="tasks-chip iss-label" style="--c:${c}">${esc(name)}</span>`;
}

function stateIcon(issue: Pick<GhIssue, "state" | "stateReason">): { svg: string; cls: string; label: string } {
  if (issue.state === "OPEN") return { svg: I.open, cls: "open", label: "Open" };
  if (issue.stateReason === "NOT_PLANNED") return { svg: I.skip, cls: "skipped", label: "Closed as not planned" };
  return { svg: I.done, cls: "closed", label: "Closed" };
}

// ---------------------------------------------------------------------------
// A small, safe Markdown renderer for issue bodies and comments. Everything is
// HTML-escaped first; only a fixed set of constructs is turned back into
// markup, and links carry their target in data-href so clicks go through the
// app (browser pane) instead of navigating the main webview.

function mdInline(t: string): string {
  const codes: string[] = [];
  t = t.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0001${codes.length - 1}\u0001`;
  });
  t = t
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (_, alt: string, u: string) => `<a data-href="${u}">${alt || "image"}</a>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a data-href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?'"])/g, '$1<a data-href="$2">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(])#(\d+)\b/g, '$1<span class="iss-md-ref">#$2</span>')
    .replace(/(^|[\s(])@([A-Za-z0-9-]+)/g, '$1<span class="iss-md-ref">@$2</span>');
  return t.replace(/\u0001(\d+)\u0001/g, (_, i: string) => codes[Number(i)]);
}

export function md(src: string): string {
  const blocks: string[] = [];
  let s = src.replace(/\r\n?/g, "\n");
  s = s.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, code: string) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\n\u0000${blocks.length - 1}\u0000\n`;
  });
  s = esc(s).replace(/&lt;!--[\s\S]*?--&gt;/g, "");

  const out: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = (): void => {
    if (para.length) out.push(`<p>${para.map(mdInline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = (): void => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${tag}>`);
    }
    list = null;
  };

  for (const line of s.split("\n")) {
    const block = /^\u0000(\d+)\u0000$/.exec(line.trim());
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (block) {
      flushPara();
      flushList();
      out.push(blocks[Number(block[1])]);
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<h4>${mdInline(heading[2])}</h4>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr>");
    } else if (item) {
      flushPara();
      const ordered = /\d/.test(item[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[2]);
      list.items.push(
        task
          ? `<span class="iss-md-check${task[1] === " " ? "" : " on"}"></span>${mdInline(task[2])}`
          : mdInline(item[2])
      );
    } else if (quote) {
      flushPara();
      flushList();
      out.push(`<blockquote>${mdInline(quote[1])}</blockquote>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      const l = list as { items: string[] };
      l.items[l.items.length - 1] += `<br>${mdInline(line.trim())}`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join("");
}

// ---------------------------------------------------------------------------

interface RepoCache {
  status: GhStatus | null;
  lists: Partial<Record<IssueFilter, GhIssue[]>>;
  details: Map<number, GhIssue>;
}

/** Keyed by folder, and kept for the app's lifetime, so reopening the tab shows
 *  the last list instantly while a fresh one loads behind it. */
const cache = new Map<string, RepoCache>();

function repoCache(cwd: string): RepoCache {
  let c = cache.get(cwd);
  if (!c) {
    c = { status: null, lists: {}, details: new Map() };
    cache.set(cwd, c);
  }
  return c;
}

export function createIssuesView(deps: IssuesDeps) {
  const el = document.createElement("div");
  el.className = "iss";

  // ---- toolbar ----
  const toolbar = document.createElement("div");
  toolbar.className = "tasks-toolbar";
  const searchWrap = document.createElement("div");
  searchWrap.className = "tasks-search";
  searchWrap.innerHTML = I.search;
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search issues…";
  searchWrap.appendChild(searchInput);
  const filters = document.createElement("div");
  filters.className = "tasks-filters";
  const right = document.createElement("div");
  right.className = "tasks-toolbar-right";
  const repoBtn = document.createElement("button");
  repoBtn.className = "iss-repo";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "tasks-icon-btn iss-refresh";
  refreshBtn.innerHTML = I.refresh;
  refreshBtn.title = "Refresh from GitHub";
  right.append(repoBtn, refreshBtn);
  toolbar.append(searchWrap, filters, right);

  // ---- body: same grid + sliding drawer as the Tasks tab ----
  const body = document.createElement("div");
  body.className = "tasks-body";
  const main = document.createElement("div");
  main.className = "tasks-main iss-main";
  const drawer = document.createElement("div");
  drawer.className = "tasks-drawer";
  body.append(main, drawer);

  const banner = document.createElement("div");
  banner.className = "iss-banner";

  el.append(toolbar, banner, body);

  let session: Session | null = null;
  let cwd = "";
  let filter: IssueFilter = "open";
  let search = "";
  let loading = false;
  let statusLoading = false;
  /** The issue shown in the drawer, or "new" while composing one. */
  let selected: number | "new" | null = null;
  let detailLoading = false;
  /** Issue numbers with a close/reopen/comment request in flight. */
  const busy = new Set<number>();
  /** Bumped on every fetch so a slow response for an old folder/filter can't
   *  overwrite a newer one. */
  let fetchSeq = 0;
  let bannerTimer: number | undefined;

  const c = (): RepoCache => repoCache(cwd);
  const repo = (): string => c().status?.repo ?? "";

  function showError(msg: string): void {
    banner.innerHTML = `<span>${esc(msg)}</span>`;
    const x = document.createElement("button");
    x.className = "tasks-icon-btn";
    x.innerHTML = I.close;
    x.title = "Dismiss";
    x.addEventListener("click", () => banner.classList.remove("visible"));
    banner.appendChild(x);
    banner.classList.add("visible");
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => banner.classList.remove("visible"), 7000);
  }

  // ================= data =================

  async function loadStatus(): Promise<void> {
    if (!cwd) return;
    const seq = ++fetchSeq;
    statusLoading = true;
    render();
    let st: GhStatus;
    try {
      st = await ghStatus(cwd);
    } catch (e) {
      st = { state: "error", message: ghErrorText(e) };
    }
    if (seq !== fetchSeq) return;
    c().status = st;
    statusLoading = false;
    if (st.state === "ok") await loadList();
    else {
      deps.onCount(null);
      render();
    }
  }

  async function loadList(): Promise<void> {
    if (!cwd || c().status?.state !== "ok") return;
    const seq = ++fetchSeq;
    const forFilter = filter;
    loading = true;
    render();
    try {
      const list = await ghIssueList(cwd, forFilter);
      if (seq !== fetchSeq) return;
      c().lists[forFilter] = list;
      if (forFilter === "open") deps.onCount(list.length);
    } catch (e) {
      if (seq !== fetchSeq) return;
      showError(ghErrorText(e));
    }
    loading = false;
    render();
  }

  async function loadDetail(number: number): Promise<GhIssue | null> {
    detailLoading = !c().details.has(number);
    renderDrawer();
    try {
      const d = await ghIssueView(cwd, number);
      c().details.set(number, d);
      patchListed(d);
      return d;
    } catch (e) {
      showError(ghErrorText(e));
      return null;
    } finally {
      detailLoading = false;
      if (selected === number) renderDrawer();
    }
  }

  /** Writes a fresher copy of an issue into every cached list that holds it. */
  function patchListed(d: GhIssue): void {
    for (const list of Object.values(c().lists)) {
      const i = list?.findIndex((x) => x.number === d.number) ?? -1;
      if (list && i >= 0) list[i] = { ...list[i], ...d, body: undefined };
    }
  }

  function issueByNumber(n: number): GhIssue | undefined {
    const d = c().details.get(n);
    if (d) return d;
    for (const list of Object.values(c().lists)) {
      const hit = list?.find((x) => x.number === n);
      if (hit) return hit;
    }
    return undefined;
  }

  // ================= actions =================

  async function setState(issue: GhIssue, action: IssueStateAction): Promise<void> {
    if (busy.has(issue.number) || !session) return;
    busy.add(issue.number);
    // Optimistic: flip it on screen now, put it back if GitHub says no.
    const before = { state: issue.state, stateReason: issue.stateReason };
    const closing = action !== "reopen";
    const apply = (state: GhIssue["state"], reason: string): void => {
      for (const target of [issue, c().details.get(issue.number)]) {
        if (!target) continue;
        target.state = state;
        target.stateReason = reason;
      }
    };
    apply(closing ? "CLOSED" : "OPEN", action === "close-not-planned" ? "NOT_PLANNED" : closing ? "COMPLETED" : "REOPENED");
    render();
    try {
      await ghIssueSetState(cwd, issue.number, action);
      const linked = deps.findTask(session, repo(), issue.number);
      if (linked) deps.onIssueState(session, linked, closing);
      // It now belongs to the other list; let the next load place it.
      delete c().lists[closing ? "closed" : "open"];
      const open = c().lists.open;
      if (open) {
        if (closing) c().lists.open = open.filter((x) => x.number !== issue.number);
        deps.onCount(c().lists.open!.length);
      }
    } catch (e) {
      apply(before.state, before.stateReason);
      showError(ghErrorText(e));
    } finally {
      busy.delete(issue.number);
      render();
    }
  }

  async function postComment(issue: GhIssue, text: string, box: HTMLTextAreaElement): Promise<void> {
    const bodyText = text.trim();
    if (!bodyText || busy.has(issue.number)) return;
    busy.add(issue.number);
    renderDrawer();
    try {
      await ghIssueComment(cwd, issue.number, bodyText);
      box.value = "";
      await loadDetail(issue.number);
    } catch (e) {
      showError(ghErrorText(e));
    } finally {
      busy.delete(issue.number);
      renderDrawer();
      renderMain();
    }
  }

  async function toggleAssignMe(issue: GhIssue): Promise<void> {
    const login = c().status?.login;
    if (!login || busy.has(issue.number)) return;
    const mine = issue.assignees.some((a) => a.login === login);
    busy.add(issue.number);
    renderDrawer();
    try {
      await ghIssueAssignMe(cwd, issue.number, !mine);
      delete c().lists.mine;
      await loadDetail(issue.number);
    } catch (e) {
      showError(ghErrorText(e));
    } finally {
      busy.delete(issue.number);
      renderDrawer();
      renderMain();
    }
  }

  /** Delegating or adding to tasks needs the full body, which the list call
   *  doesn't return — fetch it first if the drawer hasn't already. */
  async function withDetail(issue: GhIssue): Promise<GhIssue | null> {
    return c().details.get(issue.number) ?? (await loadDetail(issue.number));
  }

  async function delegateIssue(issue: GhIssue, anchor: HTMLElement): Promise<void> {
    if (!session) return;
    const d = await withDetail(issue);
    if (!d || !session) return;
    const task = deps.ensureTask(session, repo(), d);
    render();
    // The row the anchor sat in may have been re-rendered; hang off its
    // replacement so the popover lands in the same spot.
    const live =
      (anchor.isConnected ? anchor : null) ??
      el.querySelector<HTMLElement>(`[data-issue="${d.number}"] .iss-deleg`) ??
      el.querySelector<HTMLElement>(".iss-foot .tasks-delegate-btn-lg") ??
      anchor;
    deps.delegate(session, task, live);
  }

  async function addToTasks(issue: GhIssue): Promise<void> {
    if (!session) return;
    const d = await withDetail(issue);
    if (!d || !session) return;
    deps.showTask(deps.ensureTask(session, repo(), d));
  }

  async function createIssue(title: string, text: string): Promise<boolean> {
    try {
      const url = await ghIssueCreate(cwd, title.trim(), text.trim());
      const n = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
      filter = "open";
      await loadList();
      if (n) select(n);
      else select(null);
      return true;
    } catch (e) {
      showError(ghErrorText(e));
      return false;
    }
  }

  function select(n: number | "new" | null): void {
    selected = n;
    renderMain();
    renderDrawer();
    if (typeof n === "number") void loadDetail(n);
  }

  // ================= menus =================

  let menuEl: HTMLElement | null = null;
  let menuAnchor: HTMLElement | null = null;

  function closeMenu(immediate = false): void {
    const m = menuEl;
    menuEl = null;
    menuAnchor = null;
    window.removeEventListener("pointerdown", onMenuOutside, true);
    window.removeEventListener("keydown", onMenuKey, true);
    if (!m) return;
    if (immediate) {
      cancelCollapse(m);
      m.remove();
    } else collapse(m, () => m.remove());
  }
  function onMenuOutside(e: PointerEvent): void {
    const t = e.target as Node;
    if (menuEl && !menuEl.contains(t) && !menuAnchor?.contains(t)) closeMenu();
  }
  function onMenuKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }
  }

  /** The close button's split menu: completed vs. not planned. Reuses the stage
   *  menu's look so every little menu in the panel is the same object. */
  function openCloseMenu(issue: GhIssue, anchor: HTMLElement): void {
    const reclick = menuEl !== null && menuAnchor === anchor;
    closeMenu(!reclick);
    if (reclick) return;
    const menu = document.createElement("div");
    menu.className = "stage-menu";
    const inner = document.createElement("div");
    inner.className = "stage-menu-body";
    const opts: { action: IssueStateAction; label: string; icon: string }[] = [
      { action: "close", label: "Close as completed", icon: I.done },
      { action: "close-not-planned", label: "Close as not planned", icon: I.skip },
    ];
    for (const o of opts) {
      const b = document.createElement("button");
      b.className = `stage-menu-item iss-menu-${o.action}`;
      b.innerHTML = `${o.icon}<span>${o.label}</span>`;
      b.addEventListener("click", () => {
        closeMenu();
        void setState(issue, o.action);
      });
      inner.appendChild(b);
    }
    menu.appendChild(inner);
    document.body.appendChild(menu);
    menuEl = menu;
    menuAnchor = anchor;
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.top}px`;
    requestAnimationFrame(() => {
      menu.classList.add("visible");
      const pr = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(r.right - pr.width, window.innerWidth - pr.width - 8))}px`;
      // The button sits at the drawer's foot, so open upward.
      menu.style.top = `${Math.max(8, r.top - pr.height - 6)}px`;
    });
    setTimeout(() => {
      window.addEventListener("pointerdown", onMenuOutside, true);
      window.addEventListener("keydown", onMenuKey, true);
    }, 0);
  }

  // ================= rendering =================

  function render(): void {
    renderToolbar();
    renderMain();
    renderDrawer();
  }

  function renderToolbar(): void {
    const st = c().status;
    const ok = st?.state === "ok";
    searchWrap.style.display = ok ? "" : "none";
    filters.classList.toggle("hidden", !ok);
    repoBtn.style.display = ok && st?.repo ? "" : "none";
    if (ok && st?.repo) {
      repoBtn.innerHTML = `${I.github}<span>${esc(st.repo)}</span>${I.external}`;
      repoBtn.title = `Open ${st.repo} on GitHub`;
    }
    refreshBtn.classList.toggle("spinning", loading || statusLoading);
    refreshBtn.style.display = cwd ? "" : "none";
    if (!ok) return;

    const chips: { id: IssueFilter; label: string }[] = [
      { id: "open", label: "Open" },
      { id: "closed", label: "Closed" },
      { id: "mine", label: "Assigned to me" },
    ];
    filters.replaceChildren(
      ...chips.map((ch) => {
        const b = document.createElement("button");
        b.className = "tasks-filter-chip";
        b.classList.toggle("active", filter === ch.id);
        const list = c().lists[ch.id];
        b.innerHTML = `${esc(ch.label)}${list ? `<span class="tasks-filter-count">${list.length}${list.length >= 100 ? "+" : ""}</span>` : ""}`;
        b.addEventListener("click", () => {
          if (filter === ch.id) return;
          filter = ch.id;
          renderToolbar();
          renderMain();
          void loadList();
        });
        return b;
      })
    );
  }

  function matches(i: GhIssue): boolean {
    if (!search) return true;
    const q = search.toLowerCase().replace(/^#/, "");
    return (
      i.title.toLowerCase().includes(q) ||
      String(i.number).startsWith(q) ||
      i.labels.some((l) => l.name.toLowerCase().includes(q)) ||
      (i.author?.login.toLowerCase().includes(q) ?? false)
    );
  }

  function renderMain(): void {
    const st = c().status;
    if (!cwd) {
      main.replaceChildren(
        gate(I.github, "This session has no folder", "Issues come from the GitHub repo a session's folder belongs to. Set a folder for this session to see them here.")
      );
      return;
    }
    if (!st) {
      main.replaceChildren(skeleton());
      return;
    }
    if (st.state !== "ok") {
      main.replaceChildren(gateFor(st));
      return;
    }
    const all = c().lists[filter];
    if (!all) {
      main.replaceChildren(skeleton());
      return;
    }
    const list = all.filter(matches);
    if (all.length === 0) {
      const msg =
        filter === "open"
          ? ["No open issues", "Nothing is waiting in this repo. New issues show up here."]
          : filter === "closed"
            ? ["No closed issues", "Issues you close show up here."]
            : ["Nothing assigned to you", "Assign yourself from an issue's details to see it here."];
      const g = gate(I.done, msg[0], msg[1]);
      if (filter === "open") {
        const cta = document.createElement("button");
        cta.className = "tasks-new-btn tasks-empty-cta";
        cta.textContent = "New issue";
        cta.addEventListener("click", () => select("new"));
        g.appendChild(cta);
      }
      main.replaceChildren(g);
      return;
    }
    if (list.length === 0) {
      main.replaceChildren(gate(I.search, "No issues match your search", "Try a title word, a label, an author, or an issue number."));
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "iss-list";
    list.forEach((issue, i) => wrap.appendChild(buildRow(issue, i)));
    main.replaceChildren(wrap);
  }

  function buildRow(issue: GhIssue, index: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tasks-row iss-row";
    row.dataset.issue = String(issue.number);
    row.style.setProperty("--i", String(Math.min(index, 12)));
    row.classList.toggle("selected", selected === issue.number);
    row.classList.toggle("busy", busy.has(issue.number));
    const s = stateIcon(issue);

    const toggle = document.createElement("button");
    toggle.className = `iss-state ${s.cls}`;
    toggle.innerHTML = s.svg;
    toggle.title = issue.state === "OPEN" ? "Close issue" : "Reopen issue";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      void setState(issue, issue.state === "OPEN" ? "close" : "reopen");
    });

    const text = document.createElement("div");
    text.className = "iss-row-text";
    const title = document.createElement("div");
    title.className = "tasks-row-title";
    title.textContent = issue.title;
    title.title = issue.title;
    const sub = document.createElement("div");
    sub.className = "iss-row-sub";
    sub.textContent = `#${issue.number} opened ${ago(issue.createdAt)}${issue.author ? ` by ${issue.author.login}` : ""}`;
    text.append(title, sub);

    const meta = document.createElement("div");
    meta.className = "tasks-row-meta";
    const parts: string[] = [];
    const linked = session ? deps.findTask(session, repo(), issue.number) : undefined;
    if (linked) parts.push(`<span class="tasks-chip iss-linked" title="Tracked in your tasks">In tasks</span>`);
    for (const l of issue.labels.slice(0, 3)) parts.push(labelChip(l.name, l.color));
    if (issue.labels.length > 3) parts.push(`<span class="tasks-chip">+${issue.labels.length - 3}</span>`);
    if (issue.comments.length) parts.push(`<span class="iss-count" title="${issue.comments.length} comments">${I.comment}${issue.comments.length}</span>`);
    if (issue.assignees.length) {
      parts.push(`<span class="iss-avatars">${issue.assignees.slice(0, 3).map((a) => avatar(a.login)).join("")}</span>`);
    }
    meta.innerHTML = parts.join("");

    const deleg = document.createElement("button");
    deleg.className = "tasks-row-trash tasks-delegate-btn iss-deleg";
    deleg.innerHTML = I.robot;
    deleg.title = "Delegate to an AI agent";
    deleg.addEventListener("click", (e) => {
      e.stopPropagation();
      void delegateIssue(issue, deleg);
    });

    row.append(toggle, text, meta, deleg);
    row.addEventListener("click", () => select(issue.number));
    return row;
  }

  function skeleton(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "iss-list iss-skeleton";
    for (let i = 0; i < 7; i++) {
      const r = document.createElement("div");
      r.className = "iss-skel-row";
      r.style.setProperty("--w", `${38 + ((i * 37) % 45)}%`);
      r.innerHTML = `<span class="iss-skel-dot"></span><span class="iss-skel-lines"><span></span><span></span></span>`;
      wrap.appendChild(r);
    }
    return wrap;
  }

  function gate(icon: string, heading: string, text: string): HTMLElement {
    const g = document.createElement("div");
    g.className = "tasks-empty";
    g.innerHTML = `<div class="tasks-empty-mark">${icon}</div><p>${esc(heading)}</p><p class="tasks-dim">${esc(text)}</p>`;
    return g;
  }

  /** The "why can't I see issues" states, each with the one action that fixes it. */
  function gateFor(st: GhStatus): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "iss-gate-actions";
    const retry = document.createElement("button");
    retry.className = "iss-btn";
    retry.textContent = "Check again";
    retry.addEventListener("click", () => void loadStatus());

    let g: HTMLElement;
    if (st.state === "missing") {
      g = gate(I.github, "Install the GitHub CLI", "Issues are loaded with gh, GitHub's command-line tool. Install it, sign in once, and they appear here.");
      const get = document.createElement("button");
      get.className = "tasks-new-btn";
      get.textContent = "Get gh";
      get.addEventListener("click", () => session && deps.openUrl(session, "https://cli.github.com/"));
      actions.append(get, retry);
    } else if (st.state === "auth") {
      g = gate(I.github, "Connect GitHub", "Sign in to gh once and OpenTerm can read and update this repo's issues. Your token stays with gh.");
      const login = document.createElement("button");
      login.className = "tasks-new-btn";
      login.textContent = "Sign in with gh";
      login.title = "Opens a terminal running: gh auth login";
      login.addEventListener("click", () => session && deps.runInTerminal(session, "gh auth login --web"));
      actions.append(login, retry);
    } else if (st.state === "no-repo") {
      g = gate(I.github, "No GitHub repo here", "This session's folder isn't a GitHub repository, or its remote can't be reached.");
      actions.append(retry);
    } else {
      g = gate(I.github, "Couldn't reach GitHub", st.message || "Something went wrong talking to gh.");
      actions.append(retry);
    }
    g.appendChild(actions);
    return g;
  }

  // ---- drawer ----

  let drawerClearTimer: number | undefined;

  function renderDrawer(): void {
    const issue = typeof selected === "number" ? issueByNumber(selected) : undefined;
    if (selected === null || (typeof selected === "number" && !issue)) {
      body.classList.remove("with-drawer");
      drawer.classList.remove("visible");
      window.clearTimeout(drawerClearTimer);
      drawerClearTimer = window.setTimeout(() => {
        if (selected === null) drawer.replaceChildren();
      }, 280);
      return;
    }
    window.clearTimeout(drawerClearTimer);
    body.classList.add("with-drawer");
    drawer.classList.add("visible");
    // Keep a half-typed comment across re-renders.
    const draft = drawer.querySelector<HTMLTextAreaElement>(".iss-reply textarea");
    const draftFor = drawer.dataset.issue;
    const keep = draft && draftFor === String(selected) ? draft.value : "";
    drawer.dataset.issue = String(selected);
    drawer.replaceChildren();
    if (selected === "new") renderCompose();
    else if (issue) renderIssue(issue, keep);
  }

  function drawerHead(label: string, url?: string): HTMLElement {
    const head = document.createElement("div");
    head.className = "tasks-drawer-head";
    const l = document.createElement("span");
    l.textContent = label;
    const btns = document.createElement("div");
    btns.className = "iss-head-btns";
    if (url) {
      const ext = document.createElement("button");
      ext.className = "tasks-icon-btn";
      ext.innerHTML = I.external;
      ext.title = "Open on GitHub";
      ext.addEventListener("click", () => session && deps.openUrl(session, url));
      btns.appendChild(ext);
    }
    const x = document.createElement("button");
    x.className = "tasks-icon-btn";
    x.innerHTML = I.close;
    x.title = "Close details";
    x.addEventListener("click", () => select(null));
    btns.appendChild(x);
    head.append(l, btns);
    return head;
  }

  function renderIssue(issue: GhIssue, draft: string): void {
    drawer.appendChild(drawerHead(`Issue #${issue.number}`, issue.url));
    const scroll = document.createElement("div");
    scroll.className = "tasks-drawer-scroll iss-scroll";
    drawer.appendChild(scroll);

    const s = stateIcon(issue);
    const title = document.createElement("h3");
    title.className = "iss-title";
    title.textContent = issue.title;
    scroll.appendChild(title);

    const byline = document.createElement("div");
    byline.className = "iss-byline";
    byline.innerHTML =
      `<span class="iss-badge ${s.cls}">${s.svg}${s.label.replace(" as not planned", "")}</span>` +
      `<span>${issue.author ? `<strong>${esc(issue.author.login)}</strong> opened ` : "Opened "}${esc(ago(issue.createdAt))}</span>`;
    scroll.appendChild(byline);

    if (issue.labels.length) {
      const labels = document.createElement("div");
      labels.className = "iss-labels";
      labels.innerHTML = issue.labels.map((l) => labelChip(l.name, l.color)).join("");
      scroll.appendChild(labels);
    }

    // Assignees + the one-click "assign me" toggle.
    const login = c().status?.login;
    const assign = document.createElement("div");
    assign.className = "iss-assign";
    assign.innerHTML = issue.assignees.length
      ? issue.assignees.map((a) => `<span class="iss-person">${avatar(a.login)}${esc(a.login)}</span>`).join("")
      : `<span class="iss-muted">No one assigned</span>`;
    if (login) {
      const mine = issue.assignees.some((a) => a.login === login);
      const b = document.createElement("button");
      b.className = "iss-link-btn";
      b.innerHTML = `${I.person}<span>${mine ? "Unassign me" : "Assign me"}</span>`;
      b.disabled = busy.has(issue.number);
      b.addEventListener("click", () => void toggleAssignMe(issue));
      assign.appendChild(b);
    }
    scroll.appendChild(assign);

    const detail = c().details.get(issue.number);
    const bodyEl = document.createElement("div");
    bodyEl.className = "iss-md iss-body";
    if (!detail && detailLoading) {
      bodyEl.classList.add("iss-skel-text");
      bodyEl.innerHTML = "<span></span><span></span><span></span>";
    } else if (detail?.body?.trim()) {
      bodyEl.innerHTML = md(detail.body);
    } else {
      bodyEl.innerHTML = `<p class="iss-muted">No description provided.</p>`;
    }
    scroll.appendChild(bodyEl);

    const comments: GhComment[] = detail?.comments ?? [];
    if (comments.length) {
      const thread = document.createElement("div");
      thread.className = "iss-thread";
      thread.innerHTML =
        `<div class="iss-thread-label">${comments.length} ${comments.length === 1 ? "comment" : "comments"}</div>` +
        comments
          .map(
            (cm) =>
              `<div class="iss-comment">${avatar(cm.author?.login ?? "ghost", "iss-avatar lg")}<div class="iss-comment-main">` +
              `<div class="iss-comment-head"><strong>${esc(cm.author?.login ?? "ghost")}</strong><span>${esc(ago(cm.createdAt))}</span></div>` +
              `<div class="iss-md">${md(cm.body)}</div></div></div>`
          )
          .join("");
      scroll.appendChild(thread);
    }

    // Reply box.
    const reply = document.createElement("div");
    reply.className = "iss-reply";
    const box = document.createElement("textarea");
    box.className = "tasks-desc";
    box.rows = 3;
    box.placeholder = "Leave a comment…";
    box.value = draft;
    const send = document.createElement("button");
    send.className = "iss-btn primary";
    send.textContent = busy.has(issue.number) ? "Posting…" : "Comment";
    const sync = (): void => {
      send.disabled = !box.value.trim() || busy.has(issue.number);
    };
    sync();
    box.addEventListener("input", sync);
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void postComment(issue, box.value, box);
      }
    });
    send.addEventListener("click", () => void postComment(issue, box.value, box));
    const hint = document.createElement("span");
    hint.className = "iss-muted";
    hint.textContent = "Ctrl+Enter to post";
    const row = document.createElement("div");
    row.className = "iss-reply-row";
    row.append(hint, send);
    reply.append(box, row);
    scroll.appendChild(reply);

    // Footer actions.
    const foot = document.createElement("div");
    foot.className = "tasks-drawer-foot iss-foot";
    const actions = document.createElement("div");
    actions.className = "tasks-drawer-foot-actions";

    const deleg = document.createElement("button");
    deleg.className = "tasks-delegate-btn-lg";
    deleg.innerHTML = `${I.robot}<span>Delegate…</span>`;
    deleg.addEventListener("click", () => void delegateIssue(issue, deleg));

    const linked = session ? deps.findTask(session, repo(), issue.number) : undefined;
    const toTask = document.createElement("button");
    toTask.className = "iss-btn";
    toTask.innerHTML = `${I.addTask}<span>${linked ? "Open task" : "Add to tasks"}</span>`;
    toTask.addEventListener("click", () => void addToTasks(issue));

    actions.append(deleg, toTask);

    if (issue.state === "OPEN") {
      const split = document.createElement("div");
      split.className = "iss-split";
      const main = document.createElement("button");
      main.className = "iss-btn iss-close";
      main.innerHTML = `${I.done}<span>Close</span>`;
      main.disabled = busy.has(issue.number);
      main.addEventListener("click", () => void setState(issue, "close"));
      const more = document.createElement("button");
      more.className = "iss-btn iss-close iss-split-more";
      more.innerHTML = I.chevron;
      more.title = "More ways to close";
      more.disabled = busy.has(issue.number);
      more.addEventListener("click", () => openCloseMenu(issue, more));
      split.append(main, more);
      actions.appendChild(split);
    } else {
      const reopen = document.createElement("button");
      reopen.className = "iss-btn iss-reopen";
      reopen.innerHTML = `${I.open}<span>Reopen</span>`;
      reopen.disabled = busy.has(issue.number);
      reopen.addEventListener("click", () => void setState(issue, "reopen"));
      actions.appendChild(reopen);
    }
    foot.appendChild(actions);
    drawer.appendChild(foot);
  }

  function renderCompose(): void {
    drawer.appendChild(drawerHead("New issue"));
    const scroll = document.createElement("div");
    scroll.className = "tasks-drawer-scroll";
    drawer.appendChild(scroll);

    const title = document.createElement("textarea");
    title.className = "tasks-drawer-title";
    title.rows = 1;
    title.placeholder = "Issue title";
    const grow = (): void => {
      title.style.height = "auto";
      title.style.height = `${title.scrollHeight}px`;
    };
    title.addEventListener("input", () => {
      grow();
      sync();
    });

    const field = document.createElement("div");
    field.className = "tasks-field";
    field.innerHTML = `<label>Description</label>`;
    const text = document.createElement("textarea");
    text.className = "tasks-desc iss-compose-body";
    text.rows = 10;
    text.placeholder = "What's happening, what you expected, steps to reproduce… Markdown works.";
    field.appendChild(text);
    scroll.append(title, field);

    const foot = document.createElement("div");
    foot.className = "tasks-drawer-foot";
    const actions = document.createElement("div");
    actions.className = "tasks-drawer-foot-actions";
    const where = document.createElement("span");
    where.className = "iss-muted iss-compose-where";
    where.textContent = repo() ? `Creates the issue in ${repo()}` : "";
    const go = document.createElement("button");
    go.className = "tasks-new-btn";
    go.textContent = "Create issue";
    const sync = (): void => {
      go.disabled = !title.value.trim();
    };
    sync();
    const submit = async (): Promise<void> => {
      if (!title.value.trim() || go.classList.contains("busy")) return;
      go.classList.add("busy");
      go.textContent = "Creating…";
      if (!(await createIssue(title.value, text.value))) {
        go.classList.remove("busy");
        go.textContent = "Create issue";
      }
    };
    for (const input of [title, text]) {
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey || input === title)) {
          e.preventDefault();
          if (input === title && !e.ctrlKey && !e.metaKey) text.focus();
          else void submit();
        }
      });
    }
    go.addEventListener("click", () => void submit());
    actions.append(where, go);
    foot.appendChild(actions);
    drawer.appendChild(foot);
    requestAnimationFrame(() => {
      grow();
      title.focus();
    });
  }

  // ================= wiring =================

  // Links in rendered Markdown open in a browser pane, never in this webview.
  el.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-href]");
    if (!a || !session) return;
    e.preventDefault();
    e.stopPropagation();
    deps.openUrl(session, a.dataset.href!);
  });
  searchInput.addEventListener("input", () => {
    search = searchInput.value.trim();
    renderMain();
  });
  refreshBtn.addEventListener("click", () => {
    if (c().status?.state === "ok") {
      void loadList();
      if (typeof selected === "number") void loadDetail(selected);
    } else void loadStatus();
  });
  repoBtn.addEventListener("click", () => {
    const url = c().status?.url;
    if (url && session) deps.openUrl(session, `${url}/issues`);
  });

  return {
    el,
    /** Points the view at a session and (re)loads. Cached data paints first. */
    show(s: Session): void {
      const nextCwd = s.cwd ?? "";
      const changed = nextCwd !== cwd;
      session = s;
      cwd = nextCwd;
      if (changed) {
        selected = null;
        search = "";
        searchInput.value = "";
        filter = "open";
      }
      render();
      if (!cwd) {
        deps.onCount(null);
        return;
      }
      if (c().status?.state === "ok") void loadList();
      else void loadStatus();
    },
    /** Primes the tab badge without rendering anything. */
    peekCount(s: Session): number | null {
      const list = s.cwd ? cache.get(s.cwd)?.lists.open : undefined;
      return list ? list.length : null;
    },
    newIssue(): void {
      if (c().status?.state === "ok") select("new");
    },
    canCreate: (): boolean => c().status?.state === "ok",
    /** Esc closes the drawer first; returns false when there was nothing to close. */
    handleEscape(): boolean {
      if (menuEl) {
        closeMenu();
        return true;
      }
      if (selected !== null) {
        select(null);
        return true;
      }
      return false;
    },
    hide(): void {
      closeMenu(true);
      selected = null;
      renderDrawer();
    },
    focusSearch(): void {
      searchInput.focus();
    },
    /** Re-render after something outside changed (a linked task, a delegation). */
    refresh(): void {
      if (session) render();
    },
  };
}
