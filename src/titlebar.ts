/** Custom window chrome.
 *
 *  The OS titlebar is turned off (`decorations: false` in tauri.conf.json), so
 *  this strip *is* the window frame: it drags, double-click-maximizes, and
 *  carries the three window buttons. Everything in it is painted from the
 *  palette variables, so it re-themes with the rest of the app for free. */
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../app-icon.png";
import { store } from "./store";
import { prettyChord } from "./keybinds";
import sidebarIcon from "@phosphor-icons/core/regular/sidebar-simple.svg?raw";
import sidebarOnIcon from "@phosphor-icons/core/fill/sidebar-simple-fill.svg?raw";
import { createNowPlaying } from "./nowPlaying";
import { createTimerWidget } from "./timerWidget";
import { rearmTimers } from "./timers";
import { setMediaWatching } from "./media";
import type { TitlebarWidgetId } from "./types";

/** Panel toggles in the title bar: the left sidebar on the left, the Agents
 *  panel on the right (the same glyph mirrored), so each sits over its side. */
export interface TitlebarActions {
  onToggleSidebar(): void;
  onToggleAgents(): void;
}

function panelIcon(on: boolean): string {
  return (on ? sidebarOnIcon : sidebarIcon).replace("<svg ", '<svg width="15" height="15" aria-hidden="true" ');
}

const MIN = `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/></svg>`;
const MAX = `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
const RESTORE = `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.6 2.1v-.4a1.2 1.2 0 0 1 1.2-1.2h4.4a1.2 1.2 0 0 1 1.2 1.2v4.4a1.2 1.2 0 0 1-1.2 1.2h-.4" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
const CLOSE = `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0.6 0.6l8.8 8.8M9.4 0.6l-8.8 8.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`;

/** Home-relative and trimmed to its last few segments — the tail is what
 *  identifies a folder, and a full Windows path is far too long for a title.
 *  Elided in JS rather than with text-overflow so the visible part is always
 *  the tail (CSS would clip it) and never bidi-reordered. */
function prettyPath(p: string): string {
  const home = /^[A-Za-z]:\\Users\\[^\\]+/.exec(p);
  const rel = home ? "~\\" + p.slice(home[0].length + 1) : p;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return parts.join("\\");
  return "…\\" + parts.slice(-2).join("\\");
}

export function createTitlebar(actions: TitlebarActions) {
  const win = (() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  })();

  const el = document.createElement("div");
  el.className = "titlebar";
  el.setAttribute("data-tauri-drag-region", "");
  el.innerHTML = `
    <div class="tb-brand" data-tauri-drag-region><img src="${appIcon}" alt="" draggable="false" /></div>
    <button class="tb-tool tb-toggle-sidebar" data-act="sidebar" tabindex="-1"></button>
    <div class="tb-title" data-tauri-drag-region></div>
    <div class="tb-tools">
      <button class="tb-tool tb-toggle-agents" data-act="agents" tabindex="-1"><i class="tb-alert"></i></button>
    </div>
    <div class="tb-controls">
      <button class="tb-btn" data-act="min" title="Minimize" tabindex="-1">${MIN}</button>
      <button class="tb-btn" data-act="max" title="Maximize" tabindex="-1">${MAX}</button>
      <button class="tb-btn tb-close" data-act="close" title="Close" tabindex="-1">${CLOSE}</button>
    </div>`;

  // ---- Centre widgets, in the order Settings → Appearance → Title bar says.
  const titleEl = el.querySelector<HTMLElement>(".tb-title")!;
  const sessionEl = document.createElement("span");
  sessionEl.className = "tb-session";
  sessionEl.innerHTML = `<span class="tb-dot"></span><span class="tb-name"></span>`;
  const dot = sessionEl.querySelector<HTMLElement>(".tb-dot")!;
  const nameEl = sessionEl.querySelector<HTMLElement>(".tb-name")!;
  const pathEl = document.createElement("span");
  pathEl.className = "tb-path";
  const clockEl = document.createElement("span");
  clockEl.className = "tb-clock";
  const nowPlaying = createNowPlaying({ onShownChange: () => layout() });
  const timer = createTimerWidget({ onShownChange: () => layout() });
  const widgetEls: Record<TitlebarWidgetId, HTMLElement> = {
    session: sessionEl,
    path: pathEl,
    media: nowPlaying.el,
    timer: timer.el,
    clock: clockEl,
  };
  const seps: HTMLElement[] = [];
  let layoutSig = "";

  function visible(id: TitlebarWidgetId): boolean {
    if (id === "path") return !!pathEl.textContent;
    if (id === "media") return !nowPlaying.el.hidden;
    if (id === "timer") return !timer.el.hidden;
    return true;
  }

  /** Places the switched-on widgets in order, with a hairline between two
   *  pieces of text (the pills are their own capsules and need none). */
  const isPill = (id: TitlebarWidgetId | null) => id === "media" || id === "timer";
  function layout(): void {
    const order = store.state.settings.titlebarWidgets.filter((w) => w.on).map((w) => w.id);
    const shown = order.filter(visible);
    // The media slot stays in the DOM while it is on, so its width can animate.
    const placed = order.filter((id) => id === "media" || visible(id));
    const sig = placed.join(",") + "|" + shown.join(",");
    if (sig === layoutSig) return;
    layoutSig = sig;
    const nodes: HTMLElement[] = [];
    let prev: TitlebarWidgetId | null = null;
    let sepIdx = 0;
    for (const id of placed) {
      if (shown.includes(id)) {
        if (prev && !isPill(prev) && !isPill(id)) {
          const sep = (seps[sepIdx] ??= Object.assign(document.createElement("span"), { className: "tb-sep" }));
          sepIdx++;
          nodes.push(sep);
        }
        prev = id;
      }
      nodes.push(widgetEls[id]);
    }
    // Move only what changed: re-inserting the media slot would restart its
    // width animation.
    for (const child of Array.from(titleEl.children)) if (!nodes.includes(child as HTMLElement)) child.remove();
    nodes.forEach((n, i) => {
      if (titleEl.children[i] !== n) titleEl.insertBefore(n, titleEl.children[i] ?? null);
    });
  }

  let clockTimer = 0;
  function tickClock(): void {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    clockEl.title = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    clockTimer = window.setTimeout(tickClock, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  /** Re-reads the widget settings (on boot and after Settings → Save). */
  function applyWidgets(): void {
    const s = store.state.settings;
    const on = (id: TitlebarWidgetId) => s.titlebarWidgets.some((w) => w.id === id && w.on);
    void setMediaWatching(on("media"));
    nowPlaying.setOnlyWhilePlaying(s.mediaOnlyWhilePlaying);
    nowPlaying.setEnabled(on("media"));
    timer.setEnabled(on("timer"));
    rearmTimers();
    clearTimeout(clockTimer);
    if (on("clock")) tickClock();
    layoutSig = "";
    layout();
  }
  const maxBtn = el.querySelector<HTMLElement>('[data-act="max"]')!;

  const sidebarBtn = el.querySelector<HTMLElement>(".tb-toggle-sidebar")!;
  const agentsBtn = el.querySelector<HTMLElement>(".tb-toggle-agents")!;
  const agentsAlert = agentsBtn.querySelector<HTMLElement>(".tb-alert")!;
  const appEl = document.querySelector<HTMLElement>(".app");

  /** Mirrors the panels' real state off the app root's classes, so the
   *  buttons stay right however a panel was toggled (shortcut, its own close
   *  button, restored at boot). */
  function syncToggles(): void {
    const sidebarOn = !appEl?.classList.contains("sidebar-hidden");
    const agentsOn = !!appEl?.classList.contains("agents-open");
    const kb = store.state.settings.keybinds;
    for (const [btn, on, label, chord] of [
      [sidebarBtn, sidebarOn, "sidebar", kb.toggleSidebar],
      [agentsBtn, agentsOn, "Agents panel", kb.toggleAgents],
    ] as const) {
      btn.classList.toggle("on", on);
      const glyph = panelIcon(on);
      if (btn.dataset.on !== String(on)) {
        btn.querySelector("svg")?.remove();
        btn.insertAdjacentHTML("afterbegin", glyph);
        btn.dataset.on = String(on);
      }
      btn.title = `${on ? "Hide" : "Show"} ${label}${chord ? ` (${prettyChord(chord)})` : ""}`;
    }
  }
  if (appEl) new MutationObserver(syncToggles).observe(appEl, { attributes: true, attributeFilter: ["class"] });

  el.addEventListener("click", (e) => {
    const tool = (e.target as HTMLElement).closest<HTMLElement>(".tb-tool");
    if (tool) {
      if (tool.dataset.act === "sidebar") actions.onToggleSidebar();
      else actions.onToggleAgents();
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".tb-btn");
    if (!btn || !win) return;
    const act = btn.dataset.act;
    if (act === "min") void win.minimize();
    else if (act === "max") void win.toggleMaximize();
    else if (act === "close") void win.close();
  });

  async function syncMaximized(): Promise<void> {
    if (!win) return;
    const max = await win.isMaximized().catch(() => false);
    el.classList.toggle("is-max", max);
    document.documentElement.classList.toggle("win-maximized", max);
    maxBtn.innerHTML = max ? RESTORE : MAX;
    maxBtn.title = max ? "Restore" : "Maximize";
  }

  /** Repaints the window title from the active session. Cheap enough to call
   *  from every place that already refreshes the sidebar. */
  function refresh(): void {
    const s = store.state.sessions.find((x) => x.id === store.state.activeSessionId);
    if (s) {
      dot.style.background = s.color;
      dot.classList.remove("hidden");
      nameEl.textContent = s.name;
      pathEl.textContent = s.cwd ? prettyPath(s.cwd) : "";
    } else {
      dot.classList.add("hidden");
      nameEl.textContent = "OpenTerm";
      pathEl.textContent = "";
    }
    layout();
  }

  if (win) {
    void syncMaximized();
    void win.onResized(() => void syncMaximized());
    void win.onFocusChanged(({ payload }) => el.classList.toggle("blurred", !payload));
  }
  refresh();
  applyWidgets();
  syncToggles();

  return {
    el,
    refresh,
    applyWidgets,
    /** The expanded Now playing view is open (it overlaps the panes). */
    mediaOpen: () => nowPlaying.isOpen() || timer.isOpen(),
    /** Amber dot on the Agents toggle while any agent is waiting on the user. */
    setAgentsAlert(on: boolean): void {
      agentsAlert.classList.toggle("on", on);
    },
    syncToggles,
  };
}
