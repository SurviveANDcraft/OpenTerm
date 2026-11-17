/** The left sidebar in Threads mode: threads grouped by project folder.
 *  Rows are one quiet line (title, then status or age on the right); a
 *  thread that is working or waiting gets a second line saying what it's
 *  doing, and its running sub-agents hang under it. */
import { engine, type Runtime } from "./engine";
import { ic } from "./icons";
import { folderKey, folderLabel } from "../folderLaunch";
import type { ToolItem } from "./model";
import { isAgentTool } from "./tools";
import { morphInner } from "./morph";

export interface ThreadsSidebarHandlers {
  onSelect(id: string, focusItem?: string): void;
  onNew(cwd?: string): void;
  onMenu(id: string, anchor: HTMLElement): void;
  newChord(): string;
}

type Status = "running" | "waiting" | "error" | "unread" | "idle";

export function statusOf(rt: Runtime): Status {
  if (rt.approvals.length) return "waiting";
  if (rt.busy || rt.run === "starting") return "running";
  if (rt.meta.lastOutcome === "error") return "error";
  if (rt.meta.unread) return "unread";
  return "idle";
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const COLLAPSE_KEY = "openterm.threads.collapsed";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function liveAgents(rt: Runtime): ToolItem[] {
  if (!rt.loaded || !rt.busy) return [];
  const out: ToolItem[] = [];
  for (let i = rt.order.length - 1; i >= 0 && out.length < 6; i--) {
    const it = rt.items.get(rt.order[i]);
    if (it?.kind === "user") break;
    if (it?.kind === "tool" && isAgentTool(it.name)) out.unshift(it);
  }
  return out;
}

const SEARCH_ICON = ic("search", 14);

export function createThreadsSidebar(h: ThreadsSidebarHandlers) {
  const el = document.createElement("div");
  el.className = "ts";
  el.innerHTML = `
    <div class="sidebar-add-row ts-top">
      <button class="new-session ts-new" type="button"><span>New thread</span><kbd></kbd></button>
      <button class="add-pane-btn ts-search-btn" type="button" title="Search threads">${SEARCH_ICON}</button>
    </div>
    <label class="ts-search" hidden>${SEARCH_ICON}<input type="text" placeholder="Search threads" spellcheck="false" /></label>
    <div class="ts-list" role="tree"></div>`;
  const list = el.querySelector<HTMLElement>(".ts-list")!;
  const searchBox = el.querySelector<HTMLElement>(".ts-search")!;
  const search = searchBox.querySelector<HTMLInputElement>("input")!;
  const newBtn = el.querySelector<HTMLButtonElement>(".ts-new")!;
  newBtn.addEventListener("click", () => h.onNew());

  let activeId: string | null = null;
  let query = "";
  let showArchived = false;
  let lastHtml = "";
  const collapsed = loadCollapsed();

  function openSearch(on: boolean): void {
    searchBox.hidden = !on;
    searchBtn.classList.toggle("is-on", on);
    if (on) {
      search.focus();
      search.select();
    } else {
      search.value = "";
      query = "";
      render();
    }
  }
  const searchBtn = el.querySelector<HTMLElement>(".ts-search-btn")!;
  // Keep focus in the field on press, so its blur can't close it a moment
  // before the click toggles it back open.
  searchBtn.addEventListener("pointerdown", (e) => {
    if (!searchBox.hidden) e.preventDefault();
  });
  searchBtn.addEventListener("click", () => openSearch(searchBox.hidden));
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    render();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      openSearch(false);
    }
  });
  search.addEventListener("blur", () => {
    if (!search.value) openSearch(false);
  });

  list.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const more = t.closest<HTMLElement>("[data-more]");
    if (more) {
      e.stopPropagation();
      h.onMenu(more.dataset.more!, more);
      return;
    }
    const add = t.closest<HTMLElement>("[data-new-in]");
    if (add) {
      e.stopPropagation();
      h.onNew(add.dataset.newIn!);
      return;
    }
    const head = t.closest<HTMLElement>("[data-group]");
    if (head) {
      const k = head.dataset.group!;
      if (collapsed.has(k)) collapsed.delete(k);
      else collapsed.add(k);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
      } catch {
        /* per-viewer convenience only */
      }
      render();
      return;
    }
    if (t.closest("[data-archived-toggle]")) {
      showArchived = !showArchived;
      render();
      return;
    }
    const child = t.closest<HTMLElement>("[data-child]");
    if (child) {
      h.onSelect(child.dataset.thread!, child.dataset.child!);
      return;
    }
    const row = t.closest<HTMLElement>("[data-thread]");
    if (row) h.onSelect(row.dataset.thread!);
  });

  function matches(rt: Runtime): boolean {
    if (!query) return true;
    return (rt.meta.title + " " + rt.meta.cwd + " " + (rt.meta.activity ?? "")).toLowerCase().includes(query);
  }

  function trail(rt: Runtime, st: Status): string {
    switch (st) {
      case "running":
        return `<span class="ts-spin" title="Working"></span>`;
      case "waiting":
        return `<span class="ts-flag wait" title="Needs you"></span>`;
      case "error":
        return `<span class="ts-flag err" title="Failed"></span>`;
      case "unread":
        return `<span class="ts-flag new" title="Finished"></span>`;
      default:
        return `<span class="ts-time">${ago(rt.meta.updatedAt)}</span>`;
    }
  }

  function rowHtml(rt: Runtime): string {
    const m = rt.meta;
    const st = statusOf(rt);
    const live = st === "running" || st === "waiting";
    const sub = live
      ? `<span class="ts-sub">${esc(st === "waiting" ? "Needs your approval" : m.activity || "Working")}</span>`
      : "";
    const agents = liveAgents(rt);
    let kids = "";
    if (agents.length > 3) {
      const done = agents.filter((t) => t.status === "done").length;
      kids = `<div class="ts-fleet" data-thread="${esc(m.id)}" title="${done} of ${agents.length} sub-agents finished">
        <span class="ts-fleet-bar">${agents.map((t) => `<i class="seg-${t.status}"></i>`).join("")}</span>
        <span class="ts-fleet-n">${done}/${agents.length}</span>
      </div>`;
    } else
      kids = agents
        .map((t) => {
          const run = t.status === "running" || t.status === "waiting" || t.status === "streaming";
          return `<button class="ts-child ${run ? "is-running" : t.status === "error" ? "is-error" : "is-done"}" data-key="a:${esc(t.id)}" data-child="${esc(t.id)}" data-thread="${esc(m.id)}" type="button"><span class="ts-child-dot"></span><span class="ts-child-name">${esc(String(t.input?.description ?? "Sub-agent"))}</span></button>`;
        })
        .join("");
    return `
      <div class="ts-item ${m.id === activeId ? "active" : ""} st-${st}" data-key="t:${esc(m.id)}" data-thread="${esc(m.id)}" role="treeitem" title="${esc(m.title)}">
        <span class="ts-line">
          ${m.pinned ? `<span class="ts-pin">${ic("pinFill", 10)}</span>` : ""}
          <span class="ts-title ${engine.naming.has(m.id) ? "is-naming" : ""}">${esc(m.title)}</span>
          <span class="ts-trail">${trail(rt, st)}</span>
          <span class="ts-more" data-more="${esc(m.id)}" role="button" title="More">${ic("dots", 14)}</span>
        </span>
        ${sub}
      </div>
      ${kids ? `<div class="ts-children" data-key="c:${esc(m.id)}">${kids}</div>` : ""}`;
  }

  function render(): void {
    const all = engine.list().filter(matches);
    const live = all.filter((r) => !r.meta.archived);
    const archived = all.filter((r) => r.meta.archived);
    const byRecent = (a: Runtime, b: Runtime) => b.meta.updatedAt - a.meta.updatedAt;
    const pinned = live.filter((r) => r.meta.pinned).sort(byRecent);
    const groups = new Map<string, { label: string; cwd: string; items: Runtime[]; latest: number }>();
    for (const rt of live.filter((r) => !r.meta.pinned)) {
      const k = folderKey(rt.meta.cwd);
      const g = groups.get(k) ?? { label: folderLabel(rt.meta.cwd), cwd: rt.meta.cwd, items: [], latest: 0 };
      g.items.push(rt);
      g.latest = Math.max(g.latest, rt.meta.updatedAt);
      groups.set(k, g);
    }
    const parts: string[] = [];
    if (pinned.length)
      parts.push(`<section class="ts-group" data-key="g:pinned"><div class="ts-group-head static"><span class="ts-group-name">Pinned</span></div>${pinned.map(rowHtml).join("")}</section>`);
    for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].latest - a[1].latest)) {
      const shut = collapsed.has(k) && !query;
      parts.push(`
        <section class="ts-group ${shut ? "collapsed" : ""}" data-key="g:${esc(k)}">
          <div class="ts-group-head" data-group="${esc(k)}" title="${esc(g.cwd)}">
            <span class="ts-group-name">${esc(g.label)}</span>
            <span class="ts-caret">${ic("caretRight", 8)}</span>
            <span class="ts-group-add" data-new-in="${esc(g.cwd)}" role="button" title="New thread in ${esc(g.label)}">${ic("plus", 12)}</span>
          </div>
          <div class="ts-group-body">${g.items.sort(byRecent).map(rowHtml).join("")}</div>
        </section>`);
    }
    if (!live.length && !archived.length) {
      parts.push(
        query
          ? `<div class="ts-empty">No threads match “${esc(query)}”.</div>`
          : `<div class="ts-empty">No threads yet. Start one to talk to an agent like a chat, every step laid out.</div>`
      );
    }
    if (archived.length) {
      parts.push(`<button class="ts-archived-toggle" data-archived-toggle type="button"><span>Archived · ${archived.length}</span><span class="ts-caret ${showArchived ? "open" : ""}">${ic("caretRight", 8)}</span></button>`);
      if (showArchived) parts.push(`<section class="ts-group archived" data-key="g:archived">${archived.sort(byRecent).map(rowHtml).join("")}</section>`);
    }
    const html = parts.join("");
    if (html !== lastHtml) {
      lastHtml = html;
      morphInner(list, html);
    }
    newBtn.querySelector("kbd")!.textContent = h.newChord();
    newBtn.title = h.newChord() ? `New thread (${h.newChord()})` : "New thread";
  }

  engine.onList(render);
  // Relative times drift; a slow tick keeps them honest.
  window.setInterval(render, 30_000);

  return {
    el,
    render,
    setActive(id: string | null): void {
      activeId = id;
      render();
    },
    focusSearch(): void {
      openSearch(true);
    },
  };
}
