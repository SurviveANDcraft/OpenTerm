import type { PaneTerm } from "./terminals";

export interface SearchModalHandlers {
  /** The pane the popup should search — whatever's focused when it opens. */
  getFocusedPane(): PaneTerm | null;
}

const ICON_SEARCH =
  '<svg id="search-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="10.5" cy="10.5" r="6" stroke="currentColor" stroke-width="1.8"/>' +
  '<line x1="15.1" y1="15.1" x2="20.5" y2="20.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  "</svg>";

/** The "highlight search" popup: a global, keyboard-driven search over whatever
 *  terminal pane currently has focus. It doesn't care what's running in that pane
 *  (shell, a CLI, an agent) since it searches xterm's own character buffer.
 *
 *  Enter commits the search: every match lights up and the popup gets out of the
 *  way (closes) so you can actually see the terminal and scroll through results —
 *  the highlight and the pane's colored border stay up until Esc, which main.ts
 *  routes here globally even while the popup itself is closed. A query with no
 *  matches reports "No results" and keeps the popup open instead of closing. */
export function createSearchModal(handlers: SearchModalHandlers) {
  const el = document.createElement("div");
  el.className = "search-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "search-modal";

  // ---- the glowing "portal" input, per the reference design ----
  const container = document.createElement("div");
  container.className = "search-container";
  container.id = "poda";

  const glow = document.createElement("div");
  glow.className = "glow";
  const darkBorderBg = document.createElement("div");
  darkBorderBg.className = "darkBorderBg";
  const white = document.createElement("div");
  white.className = "white";
  const border = document.createElement("div");
  border.className = "border";

  const main = document.createElement("div");
  main.id = "main";

  const input = document.createElement("input");
  input.className = "search-input";
  input.type = "text";
  input.placeholder = "Search this terminal…";
  input.autocomplete = "off";
  input.spellcheck = false;

  const inputMask = document.createElement("div");
  inputMask.id = "input-mask";
  const pinkMask = document.createElement("div");
  pinkMask.id = "pink-mask";
  const icon = document.createElement("div");
  icon.innerHTML = ICON_SEARCH;
  const iconEl = icon.firstElementChild!;

  main.append(input, inputMask, pinkMask, iconEl);
  container.append(glow, darkBorderBg, white, border, main);

  // ---- result status ----
  const status = document.createElement("div");
  status.className = "search-status";

  // ---- footer hints ----
  const footer = document.createElement("div");
  footer.className = "search-footer";
  footer.innerHTML =
    '<span class="search-hint"><kbd>Enter</kbd> Highlight all &amp; close</span>' +
    '<span class="search-hint"><kbd>Esc</kbd> Close</span>';

  modal.append(container, status, footer);
  el.appendChild(modal);

  /** Pane the popup is currently searching (only while open — nothing has been
   *  committed yet). */
  let pane: PaneTerm | null = null;
  /** Pane holding a committed, persistent highlight — set on a successful Enter,
   *  cleared on Esc. Tracked independently of `pane` since the popup is closed
   *  for the whole time this is set. */
  let activePane: PaneTerm | null = null;
  let open = false;

  function setStatus(text: string, noMatch: boolean): void {
    status.textContent = text;
    status.classList.toggle("no-match", noMatch);
  }

  function clearActivePreview(): void {
    activePane?.clearHighlight();
    activePane = null;
  }

  function commitSearch(): void {
    const term = input.value.trim();
    if (!term || !pane) return;
    const result = pane.previewSearch(term);
    if (result.count === 0) {
      pane.clearHighlight();
      setStatus("No results", true);
      return; // stay open — nothing to preview
    }
    activePane = pane;
    setStatus(`${result.count} match${result.count === 1 ? "" : "es"} highlighted`, false);
    open = false;
    el.classList.remove("visible");
    pane = null;
  }

  input.addEventListener("keydown", (e) => {
    // Owns every key while open — the app's global shortcut handler stands
    // down for it (see main.ts), so this is the only place these fire.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitSearch();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) close();
  });
  modal.addEventListener("pointerdown", (e) => e.stopPropagation());

  /** Cancels the popup with nothing committed (backdrop click, Esc before Enter). */
  function close(): void {
    if (!open) return;
    open = false;
    el.classList.remove("visible");
    pane = null;
  }

  function openModal(): void {
    clearActivePreview(); // starting a new search retires the previous one
    pane = handlers.getFocusedPane();
    if (!pane) return;
    open = true;
    input.value = "";
    setStatus("", false);
    el.classList.add("visible");
    requestAnimationFrame(() => input.focus());
  }

  return {
    el,
    open: openModal,
    close,
    isOpen: () => open,
    hasActivePreview: () => activePane !== null,
    clearActivePreview,
  };
}
