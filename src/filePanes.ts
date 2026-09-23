import { createFileViewerPanel, type FileSurface } from "./editor";
import { clearHints, resolveDrop, type DropRegion } from "./terminals";
import type { Dir } from "./types";

/** Tiled file panes: a file opened from the sidebar starts life as the
 *  full-screen viewer, and can be *docked* (Alt+drag its title bar) into the
 *  ordinary pane grid, where it sits beside terminals and is split, resized,
 *  folded and moved like any other pane. The editor surface is literally the
 *  same component in both places (see createFileViewerPanel's "pane" mode), so
 *  nothing about editing changes when a file crosses between the two spaces —
 *  only its chrome and the morph animation that carries it across. */

const ICONS = {
  splitRight:
    '<svg viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="9" rx="1" fill="none" stroke="currentColor"/><line x1="7" y1="2.5" x2="7" y2="11.5" stroke="currentColor"/></svg>',
  splitDown:
    '<svg viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="9" rx="1" fill="none" stroke="currentColor"/><line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor"/></svg>',
  zoom:
    '<span class="zicon icon-expand"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3 6V3h3M11 8v3H8"/></svg></span>' +
    '<span class="zicon icon-restore"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M6 3v3H3M8 11V8h3"/></svg></span>',
  fold:
    '<span class="ficon icon-fold"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3.5 8.5 7 5l3.5 3.5"/></svg></span>' +
    '<span class="ficon icon-unfold"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3.5 5.5 7 9l3.5-3.5"/></svg></span>',
  close:
    '<svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke="currentColor"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke="currentColor"/></svg>',
  expandFull:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M8.5 2.5H11.5V5.5M5.5 11.5H2.5V8.5M11.5 2.5 8 6M2.5 11.5 6 8"/></svg>',
};

export interface FilePaneHandlers {
  onFocus(id: string): void;
  onSplit(id: string, dir: Dir): void;
  onClose(id: string): void;
  onMove(srcId: string, targetId: string, region: DropRegion): void;
  onToggleZoom(id: string): void;
  onToggleFold(id: string): void;
  /** Lift the pane back out into the full-screen viewer (with the morph). */
  onExpand(id: string): void;
}

export class PaneFile {
  readonly id: string;
  readonly el: HTMLElement;
  readonly surface: FileSurface;
  path: string;
  name: string;
  private titleEl: HTMLElement;
  private handlers: FilePaneHandlers;
  private disposed = false;

  constructor(id: string, path: string, name: string, handlers: FilePaneHandlers) {
    this.id = id;
    this.path = path;
    this.name = name;
    this.handlers = handlers;

    this.surface = createFileViewerPanel(
      { onRequestClose: () => handlers.onClose(id) },
      { mode: "pane" }
    );

    this.el = this.surface.el;
    this.el.dataset.paneId = id;

    const bar = this.surface.header;
    bar.title = "Drag to move · Alt+drag onto the top bar area to expand full screen";

    const badge = document.createElement("span");
    badge.className = "pane-ext-badge pane-file-badge";
    badge.textContent = "FILE";
    badge.title = "Docked file";
    bar.prepend(badge);

    this.titleEl = bar.querySelector<HTMLElement>(".file-viewer-title")!;
    this.titleEl.classList.add("pane-title");
    this.titleEl.textContent = name;

    const actions = document.createElement("div");
    actions.className = "pane-actions";
    const mkBtn = (icon: string, fn: (e: MouseEvent) => void, label: string) => {
      const b = document.createElement("button");
      b.className = "pane-btn";
      b.innerHTML = icon;
      b.title = label;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn(e);
      });
      actions.appendChild(b);
      return b;
    };
    mkBtn(ICONS.expandFull, () => handlers.onExpand(id), "Expand to full screen");
    mkBtn(ICONS.splitRight, () => handlers.onSplit(id, "row"), "Split right");
    mkBtn(ICONS.splitDown, () => handlers.onSplit(id, "col"), "Split down");
    mkBtn(ICONS.zoom, () => handlers.onToggleZoom(id), "Expand pane (toggle)");
    mkBtn(ICONS.fold, () => handlers.onToggleFold(id), "Fold pane (toggle)").dataset.act =
      "foldPane";
    mkBtn(ICONS.close, () => handlers.onClose(id), "Close pane").dataset.act = "closePane";
    bar.appendChild(actions);

    const overlay = document.createElement("div");
    overlay.className = "drop-overlay";
    const hint = document.createElement("div");
    hint.className = "drop-hint";
    overlay.appendChild(hint);
    this.el.appendChild(overlay);

    bar.addEventListener("mousedown", () => handlers.onFocus(id));
    this.el.addEventListener("mousedown", () => handlers.onFocus(id), true);
    bar.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".pane-btn")) return;
      handlers.onToggleFold(id);
    });

    this.bindDrag(bar);
  }

  get title(): string {
    return this.name;
  }

  async open(pending?: string): Promise<void> {
    await this.surface.open(this.path, this.name, pending);
  }

  focus(): void {
    this.surface.focus();
  }

  isDirty(): boolean {
    return this.surface.isDirty();
  }

  containsFocus(node: Node | null): boolean {
    return this.surface.containsFocus(node);
  }

  save(): Promise<boolean> {
    return this.surface.save();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.surface.close();
    this.el.remove();
  }

  // ---- drag: move within the grid, or Alt+drag to go full screen ----

  private bindDrag(bar: HTMLElement): void {
    bar.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".pane-btn, .file-viewer-save, .file-viewer-md-toggle"))
        return;

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      let dragging = false;
      let ghost: HTMLElement | null = null;
      let ghostLabel: HTMLElement | null = null;
      let targetEl: HTMLElement | null = null;
      let region: DropRegion | null = null;
      let liftMode = e.altKey;
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
          /* capture may already be gone */
        }
        if (!dragging) return;
        document.body.classList.remove("dragging-pane", "dragging-file-lift");
        ghost?.remove();
        ghost = null;
        clearHints();
        if (!commit) return;
        if (liftMode) this.handlers.onExpand(this.id);
        else if (targetEl?.isConnected) {
          const target = targetEl.dataset.paneId;
          if (target && region) this.handlers.onMove(this.id, target, region);
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
            /* window listeners are the real guarantee */
          }
          document.body.classList.add("dragging-pane");
          ghost = document.createElement("div");
          ghost.className = "drag-ghost file-ghost";
          ghostLabel = document.createElement("span");
          ghost.appendChild(ghostLabel);
          document.body.appendChild(ghost);
        }
        ghost!.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
        liftMode = ev.altKey;
        document.body.classList.toggle("dragging-file-lift", liftMode);
        ghost!.classList.toggle("lift", liftMode);
        ghostLabel!.textContent = liftMode ? `Expand: ${this.name}` : this.name;

        if (liftMode) {
          if (targetEl) clearHints();
          targetEl = null;
          region = null;
          return;
        }
        const hit = resolveDrop(ev.clientX, ev.clientY, this.id, false, (el) => !!el.dataset.paneId);
        if (targetEl && targetEl !== hit?.el) clearHints();
        targetEl = hit?.el ?? null;
        region = hit?.region ?? null;
        if (hit) {
          const h = hit.el.querySelector(".drop-hint");
          if (h) h.className = `drop-hint region-${hit.hint}`;
        }
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish(true);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }
}

export const filePanes = new Map<string, PaneFile>();

// ------------------------------------------------------------------ morph

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The premium bit: a live-looking clone of the file surface that flies between
 *  the full-screen viewer's rect and a pane's rect. A clone (rather than the
 *  real element) is used so CodeMirror is never re-laid-out mid-flight — the
 *  clone is a pixel-accurate still of the surface, and the real thing is only
 *  revealed once the flight lands, which reads as one continuous object.
 *
 *  Scaling (not stretching) keeps the text at its true size through the whole
 *  arc, so the panel looks like a physical card being placed, not a rubber
 *  sheet. The source is measured at `from`, so both directions are the same
 *  code path. */
export function morphSurface(
  source: HTMLElement,
  from: Rect,
  to: Rect,
  opts: { duration?: number; onDone?: () => void } = {}
): void {
  const duration = opts.duration ?? 420;
  const clone = source.cloneNode(true) as HTMLElement;
  clone.classList.add("file-morph");
  clone.removeAttribute("data-pane-id");
  // Fixed at the source geometry; the transform does all the travelling.
  clone.style.width = `${from.w}px`;
  clone.style.height = `${from.h}px`;
  clone.style.left = "0px";
  clone.style.top = "0px";
  clone.style.transform = `translate3d(${from.x}px, ${from.y}px, 0)`;
  clone.style.transformOrigin = "0 0";
  document.body.appendChild(clone);

  const sx = to.w / Math.max(1, from.w);
  const sy = to.h / Math.max(1, from.h);

  const anim = clone.animate(
    [
      { transform: `translate3d(${from.x}px, ${from.y}px, 0) scale(1, 1)`, opacity: 1 },
      {
        transform: `translate3d(${to.x}px, ${to.y}px, 0) scale(${sx}, ${sy})`,
        opacity: 1,
        offset: 0.82,
      },
      {
        transform: `translate3d(${to.x}px, ${to.y}px, 0) scale(${sx}, ${sy})`,
        opacity: 0,
      },
    ],
    {
      duration,
      // Gentle overshoot-free settle: fast out of the gate, long soft landing.
      easing: "cubic-bezier(0.22, 0.9, 0.24, 1)",
      fill: "forwards",
    }
  );
  const done = () => {
    clone.remove();
    opts.onDone?.();
  };
  anim.addEventListener("finish", done);
  anim.addEventListener("cancel", done);
}

/** Counterpart to the flying clone: the element that *receives* the file grows
 *  into place from the flight's landing scale, so the hand-off has no visible
 *  seam. Runs on the real pane/viewer element. */
export function settleIn(el: HTMLElement, delay = 180): void {
  el.animate(
    [
      { opacity: 0, transform: "scale(0.985)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    { duration: 260, delay, easing: "cubic-bezier(0.22, 0.9, 0.24, 1)", fill: "backwards" }
  );
}

/** Landing animation for a pane that was created by a drop rather than flown
 *  in by the morph (a Ctrl+Alt drag from the sidebar has no on-screen surface
 *  to carry across). The pane grows out of the point the file was dropped at,
 *  so the new tile still visibly comes *from* the gesture. */
export function materializeIn(el: HTMLElement, at: { x: number; y: number }): void {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const ox = Math.max(0, Math.min(100, ((at.x - r.left) / r.width) * 100));
  const oy = Math.max(0, Math.min(100, ((at.y - r.top) / r.height) * 100));
  const prev = el.style.transformOrigin;
  el.style.transformOrigin = `${ox}% ${oy}%`;
  const anim = el.animate(
    [
      { opacity: 0, transform: "scale(0.88)", filter: "blur(2px)" },
      { opacity: 1, transform: "scale(1.012)", filter: "blur(0px)", offset: 0.68 },
      { opacity: 1, transform: "scale(1)", filter: "blur(0px)" },
    ],
    { duration: 420, easing: "cubic-bezier(0.22, 0.9, 0.24, 1)", fill: "backwards" }
  );
  const restore = () => {
    el.style.transformOrigin = prev;
  };
  anim.addEventListener("finish", restore);
  anim.addEventListener("cancel", restore);
}
