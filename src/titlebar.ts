/** Custom window chrome.
 *
 *  The OS titlebar is turned off (`decorations: false` in tauri.conf.json), so
 *  this strip *is* the window frame: it drags, double-click-maximizes, and
 *  carries the three window buttons. Everything in it is painted from the
 *  palette variables, so it re-themes with the rest of the app for free. */
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../app-icon.png";
import { store } from "./store";

const MIN = `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/></svg>`;
const MAX = `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
const RESTORE = `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.6 2.1v-.4a1.2 1.2 0 0 1 1.2-1.2h4.4a1.2 1.2 0 0 1 1.2 1.2v4.4a1.2 1.2 0 0 1-1.2 1.2h-.4" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
const CLOSE = `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0.6 0.6l8.8 8.8M9.4 0.6l-8.8 8.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`;

/** Home-relative and trimmed to its last few segments — the tail is what
 *  identifies a folder, and a full Windows path is far too long for a title.
 *  Elided in JS rather than with text-overflow so the visible part is always
 *  the tail (CSS would clip it) and never bidi-reordered. */
function prettyPath(p: string): string {
  const home = /^[A-Za-z]:\Users\[^\]+/.exec(p);
  const rel = home ? "~\\" + p.slice(home[0].length + 1) : p;
  const parts = rel.split(/[\/]+/).filter(Boolean);
  if (parts.length <= 3) return parts.join("\\");
  return "…\\" + parts.slice(-2).join("\\");
}

export function createTitlebar() {
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
    <div class="tb-title" data-tauri-drag-region>
      <span class="tb-dot"></span>
      <span class="tb-name"></span>
      <span class="tb-sep"></span>
      <span class="tb-path"></span>
    </div>
    <div class="tb-controls">
      <button class="tb-btn" data-act="min" title="Minimize" tabindex="-1">${MIN}</button>
      <button class="tb-btn" data-act="max" title="Maximize" tabindex="-1">${MAX}</button>
      <button class="tb-btn tb-close" data-act="close" title="Close" tabindex="-1">${CLOSE}</button>
    </div>`;

  const dot = el.querySelector<HTMLElement>(".tb-dot")!;
  const nameEl = el.querySelector<HTMLElement>(".tb-name")!;
  const sepEl = el.querySelector<HTMLElement>(".tb-sep")!;
  const pathEl = el.querySelector<HTMLElement>(".tb-path")!;
  const maxBtn = el.querySelector<HTMLElement>('[data-act="max"]')!;

  el.addEventListener("click", (e) => {
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
      const p = s.cwd ? prettyPath(s.cwd) : "";
      pathEl.textContent = p;
      sepEl.classList.toggle("hidden", !p);
      pathEl.classList.toggle("hidden", !p);
    } else {
      dot.classList.add("hidden");
      nameEl.textContent = "OpenTerm";
      sepEl.classList.add("hidden");
      pathEl.classList.add("hidden");
    }
  }

  if (win) {
    void syncMaximized();
    void win.onResized(() => void syncMaximized());
    void win.onFocusChanged(({ payload }) => el.classList.toggle("blurred", !payload));
  }
  refresh();

  return { el, refresh };
}
