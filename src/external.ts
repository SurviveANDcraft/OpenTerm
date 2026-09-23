import { invoke } from "@tauri-apps/api/core";
import { clearHints, DropRegion, dropRegion, setHint } from "./terminals";

// -------------------------------------------------------------- Rust bridge

/** Reparent an external OS window (by HWND) into the app window and dock it over
 *  the given client-area rectangle (physical pixels). */
export function embedExternalWindow(
  id: string,
  hwnd: string,
  rect: PhysRect
): Promise<void> {
  return invoke("embed_external_window", { id, hwnd, ...rect });
}

/** Keep an embedded window glued to its pane: reposition to `rect` (physical px,
 *  client-relative) or hide it entirely when the pane isn't visible. */
export function positionEmbeddedWindow(
  id: string,
  rect: PhysRect,
  visible: boolean
): Promise<void> {
  return invoke("position_embedded_window", { id, ...rect, visible });
}

/** Pop the window back out into a free-floating top-level window (restores its
 *  caption/border/parent). */
export function releaseEmbeddedWindow(id: string): Promise<void> {
  return invoke("release_embedded_window", { id });
}

export interface PhysRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// -------------------------------------------------------------- ExternalPane

const EJECT_ICON =
  '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3 10.5h8M7 2.5 3.5 8h7z"/></svg>';

export interface ExternalHandlers {
  onFocus(id: string): void;
  onEject(id: string): void;
  /** Rearrange this docked terminal into another pane slot (edges only — a
   *  reparented window can't be center-swapped like an in-app terminal). */
  onMove(srcId: string, targetId: string, region: DropRegion): void;
}

/** External windows are moved by re-docking into a pane edge; never a center
 *  swap. Coerce a center hit to its dominant edge so the gesture still lands. */
function edgeRegion(x: number, y: number): DropRegion {
  const r = dropRegion(x, y);
  if (r !== "c") return r;
  const dx = x - 0.5;
  const dy = y - 0.5;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

/** A pane whose content is a reparented external OS terminal window. It renders
 *  only chrome — a title bar and an empty host box. The real window is glued
 *  over the host box on the Rust side; this class just measures the host and
 *  streams its screen rect so the window tracks resizes, session switches, etc. */
export class ExternalPane {
  readonly id: string;
  readonly hwnd: string;
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private host: HTMLElement;
  private observer: ResizeObserver;
  private syncRaf: number | null = null;
  private disposed = false;
  private lastKey = "";

  constructor(id: string, hwnd: string, title: string, handlers: ExternalHandlers) {
    this.id = id;
    this.hwnd = hwnd;

    this.el = document.createElement("div");
    this.el.className = "pane external-pane";
    this.el.dataset.paneId = id;
    this.el.dataset.external = "1";

    const bar = document.createElement("div");
    bar.className = "pane-bar";

    const badge = document.createElement("span");
    badge.className = "pane-ext-badge";
    badge.textContent = "EXTERNAL";
    badge.title = "Docked external terminal";

    this.titleEl = document.createElement("span");
    this.titleEl.className = "pane-title";
    this.titleEl.textContent = title || "External terminal";

    const actions = document.createElement("div");
    actions.className = "pane-actions";
    const eject = document.createElement("button");
    eject.className = "pane-btn";
    eject.title = "Eject — pop the terminal back out to its own window";
    eject.innerHTML = EJECT_ICON;
    eject.addEventListener("mousedown", (e) => e.preventDefault());
    eject.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onEject(id);
    });
    actions.appendChild(eject);

    bar.append(badge, this.titleEl, actions);

    this.host = document.createElement("div");
    this.host.className = "pane-term external-host";

    this.el.append(bar, this.host);

    bar.addEventListener("mousedown", () => handlers.onFocus(id));
    this.host.addEventListener("mousedown", () => handlers.onFocus(id));

    // ---- drag the bar to re-dock this window into another pane slot ----
    // Mirrors PaneTerm's pointer drag, but restricted to edge drops. Window
    // listeners (not bar-scoped) survive the reparent that a drop triggers.
    bar.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".pane-btn")) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      let dragging = false;
      let ghost: HTMLElement | null = null;
      let targetEl: HTMLElement | null = null;
      let region: DropRegion | null = null;
      let finished = false;

      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          if (bar.hasPointerCapture(pointerId)) bar.releasePointerCapture(pointerId);
        } catch {
          /* capture may already be gone after a reparent */
        }
        if (!dragging) return;
        document.body.classList.remove("dragging-pane");
        ghost?.remove();
        ghost = null;
        clearHints();
        if (commit && targetEl?.isConnected) {
          const target = targetEl.dataset.paneId;
          if (target && region) handlers.onMove(id, target, region);
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
          dragging = true;
          try {
            bar.setPointerCapture(pointerId);
          } catch {
            /* best-effort */
          }
          document.body.classList.add("dragging-pane");
          ghost = document.createElement("div");
          ghost.className = "drag-ghost";
          ghost.textContent = this.titleEl.textContent ?? "External terminal";
          document.body.appendChild(ghost);
        }
        ghost!.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;

        const under = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>(".pane");
        if (targetEl && targetEl !== under) setHint(targetEl, null);
        targetEl = under && under.dataset.paneId !== id ? under : null;
        region = null;
        if (targetEl) {
          const r = targetEl.getBoundingClientRect();
          region = edgeRegion((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
          setHint(targetEl, region);
        }
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(ev.type === "pointerup");
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });

    this.observer = new ResizeObserver(() => this.syncSoon());
    this.observer.observe(this.host);
  }

  setTitle(title: string): void {
    this.titleEl.textContent = title || "External terminal";
  }

  /** Coalesce a burst of size changes (e.g. a divider drag) into one reposition
   *  per animation frame so the docked window tracks the gesture smoothly. */
  syncSoon(): void {
    if (this.disposed || this.syncRaf !== null) return;
    this.syncRaf = window.requestAnimationFrame(() => {
      this.syncRaf = null;
      this.syncNow();
    });
  }

  /** Measure the host box and tell Rust where to place (or whether to hide) the
   *  embedded window. Skips redundant updates so we don't spam SetWindowPos. */
  syncNow(): void {
    if (this.disposed) return;
    const visible = this.host.offsetParent !== null;
    const rect = this.hostRect();
    const key = `${visible}:${rect.x},${rect.y},${rect.w},${rect.h}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    void positionEmbeddedWindow(this.id, rect, visible && rect.w > 2 && rect.h > 2);
  }

  hostRect(): PhysRect {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      w: Math.round(r.width * dpr),
      h: Math.round(r.height * dpr),
    };
  }

  focus(): void {
    // The embedded OS window owns real focus; nothing to do here.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.syncRaf !== null) window.cancelAnimationFrame(this.syncRaf);
    this.observer.disconnect();
    this.el.remove();
  }
}

/** Registry of live external panes, parallel to `panes` in terminals.ts. */
export const externalPanes = new Map<string, ExternalPane>();

/** Reposition every docked window — call after a layout change that a single
 *  pane's ResizeObserver won't catch (session switch, settings overlay, etc.). */
export function syncAllExternal(): void {
  externalPanes.forEach((p) => p.syncNow());
}
