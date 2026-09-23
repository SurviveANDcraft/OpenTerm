import type { Dir, PaneNode, Session, SplitNode } from "./types";
import { collectLeaves } from "./tree";
import { panes } from "./terminals";
import { browserPanes } from "./browserPanes";
import { externalPanes } from "./external";
import { filePanes } from "./filePanes";

const MIN_SIZE = 0.08;

/** Rebuild the DOM for a session's split tree inside its view element. */
export function renderSession(session: Session, view: HTMLElement, onSizesChanged: () => void): void {
  // A root leaf has no split to host the gap, so the view carries one itself —
  // otherwise folding the only pane would leave the session blank and inert.
  view.replaceChildren(renderNode(session.tree, onSizesChanged), makeFoldGap());
  applyFold(session, view);
  applyZoom(session, view);
}

/** What clicking a fold gap does: drop a fresh terminal into the freed space,
 *  next to `targetId` along `dir`. Wired once from main.ts. */
let onGapFill: ((targetId: string, dir: Dir, duplicate?: boolean) => void) | null = null;

export function setFoldGapHandler(
  fn: (targetId: string, dir: Dir, duplicate?: boolean) => void
): void {
  onGapFill = fn;
}

/** The space a fully folded row/column hands back: a real drop target (see
 *  resolveDrop in terminals.ts) that also offers to fill itself with a new
 *  terminal. It is always in the DOM at zero size so activating it animates. */
function makeFoldGap(): HTMLElement {
  const gap = document.createElement("div");
  gap.className = "fold-gap";
  const hint = document.createElement("div");
  hint.className = "drop-hint";
  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "fold-gap-cta";
  cta.innerHTML =
    '<svg viewBox="0 0 14 14"><line x1="7" y1="3" x2="7" y2="11" stroke="currentColor"/>' +
    '<line x1="3" y1="7" x2="11" y2="7" stroke="currentColor"/></svg><span>New terminal</span>';
  cta.title = "Click for a new terminal here — or drag a pane into this space";
  cta.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = gap.dataset.paneId;
    const dir = gap.dataset.gapDir as Dir | undefined;
    // Alt held: duplicate the neighbouring pane instead of a blank shell.
    if (target && dir) onGapFill?.(target, dir, e.altKey);
  });
  gap.append(hint, cta);
  return gap;
}

/** Point a gap at the slot a drop (or the CTA) should fill: after the last leaf
 *  of the folded group, along that group's own axis. */
function armFoldGap(gap: HTMLElement, node: PaneNode, dir: Dir, active: boolean): void {
  gap.classList.toggle("active", active);
  if (!active) {
    delete gap.dataset.paneId;
    return;
  }
  const leaves = collectLeaves(node);
  const last = leaves[leaves.length - 1];
  if (last) gap.dataset.paneId = last;
  gap.dataset.gapDir = dir;
  gap.dataset.gapRegion = dir === "row" ? "e" : "s";
}

export function applyZoom(session: Session, view: HTMLElement): void {
  const zoomed = session.zoomed;
  view.classList.toggle("has-zoom", !!zoomed);
  view.querySelectorAll<HTMLElement>(".pane").forEach((p) => {
    p.classList.toggle("zoomed", !!zoomed && p.dataset.paneId === zoomed);
  });
}

/** Height (or width, in a row split) a folded pane collapses to: exactly its
 *  title bar, so the pane stays grabbable and identifiable. Mirrors the
 *  `--fold-size` used by the stylesheet. */
const FOLD_SIZE = 32;

/** Re-apply fold state from the tree onto an already-rendered view: folded
 *  leaves shrink to their title bar and stop growing, their siblings take the
 *  freed space, and the dividers that would resize them are disabled. */
export function applyFold(session: Session, view: HTMLElement): void {
  const root = view.firstElementChild as HTMLElement | null;
  if (root) applyFoldNode(session.tree, root, null);
  // View-level gap: only a folded *root leaf* leaves space no split owns.
  const viewGap = view.querySelector<HTMLElement>(":scope > .fold-gap");
  if (viewGap) armFoldGap(viewGap, session.tree, "col", isFolded(session.tree));
}

/** The `flex` shorthand a child of `split` should carry, honouring folds.
 *  Folded children are pinned to their bar; the rest share what's left. Their
 *  grow factors are renormalised to sum to 1 — CSS only hands out free space up
 *  to the *total* grow factor, so leaving the raw fractions in place would strand
 *  a folded pane's reclaimed space as a dead gap. */
export function flexFor(split: SplitNode, i: number): string {
  const child = split.children[i];
  if (isFolded(child)) return `0 0 ${FOLD_SIZE}px`;
  let live = 0;
  split.children.forEach((c, j) => {
    if (!isFolded(c)) live += split.sizes[j];
  });
  const grow = live > 0 ? split.sizes[i] / live : 1;
  return `${grow} 1 0px`;
}

function applyFoldNode(node: PaneNode, el: HTMLElement, parentDir: Dir | null): void {
  if (node.type === "leaf") {
    const folded = !!node.folded;
    el.classList.toggle("folded", folded);
    // A pane folds along its parent split's axis: stacked panes collapse to a
    // strip of bar height, side-by-side panes to a narrow vertical rail.
    el.classList.toggle("fold-row", folded && parentDir === "row");
    el.classList.toggle("fold-col", folded && parentDir !== "row");
    return;
  }
  node.children.forEach((child, i) => {
    const childEl = el.children[i * 2] as HTMLElement | undefined;
    if (!childEl) return;
    childEl.style.flex = flexFor(node, i);
    applyFoldNode(child, childEl, node.dir);
    const divider = el.children[i * 2 + 1] as HTMLElement | undefined;
    if (divider?.classList.contains("divider")) {
      // Dragging a divider writes flex on both neighbours — pointless against a
      // pane pinned to its bar height, so it is inert while one side is folded.
      divider.classList.toggle("inert", isFolded(child) || isFolded(node.children[i + 1]));
    }
  });
  // Free space appears only when *every* child is folded — otherwise the live
  // panes have already absorbed it.
  const gap = el.querySelector<HTMLElement>(":scope > .fold-gap");
  if (gap) armFoldGap(gap, node, node.dir, node.children.every(isFolded));
}

function isFolded(node: PaneNode | undefined): boolean {
  return !!node && node.type === "leaf" && !!node.folded;
}

function renderNode(node: PaneNode, onSizesChanged: () => void): HTMLElement {
  if (node.type === "leaf") {
    const pane =
      panes.get(node.id) ??
      browserPanes.get(node.id) ??
      filePanes.get(node.id) ??
      externalPanes.get(node.id);
    if (!pane) {
      const missing = document.createElement("div");
      missing.className = "pane";
      return missing;
    }
    return pane.el;
  }

  const el = document.createElement("div");
  el.className = `split ${node.dir === "row" ? "split-row" : "split-col"}`;

  node.children.forEach((child, i) => {
    const childEl = renderNode(child, onSizesChanged);
    childEl.style.flex = flexFor(node, i);
    el.appendChild(childEl);
    if (i < node.children.length - 1) {
      el.appendChild(makeDivider(node, i, el, onSizesChanged));
    }
  });
  // Appended last so the children/divider indexing above (i*2, i*2+1) still holds.
  el.appendChild(makeFoldGap());

  return el;
}

function makeDivider(
  split: SplitNode,
  index: number,
  splitEl: HTMLElement,
  onSizesChanged: () => void
): HTMLElement {
  const div = document.createElement("div");
  div.className = "divider";

  div.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    div.classList.add("active");
    document.body.classList.add(split.dir === "row" ? "resizing-x" : "resizing-y");

    const horizontal = split.dir === "row";
    const rect = splitEl.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const start = horizontal ? e.clientX : e.clientY;
    const startA = split.sizes[index];
    const startB = split.sizes[index + 1];

    const onMove = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX : ev.clientY;
      let d = (pos - start) / total;
      d = Math.max(MIN_SIZE - startA, Math.min(startB - MIN_SIZE, d));
      split.sizes[index] = startA + d;
      split.sizes[index + 1] = startB - d;
      const elA = splitEl.children[index * 2] as HTMLElement;
      const elB = splitEl.children[(index + 1) * 2] as HTMLElement;
      elA.style.flex = flexFor(split, index);
      elB.style.flex = flexFor(split, index + 1);
    };

    const onUp = () => {
      div.classList.remove("active");
      document.body.classList.remove("resizing-x", "resizing-y");
      div.removeEventListener("pointermove", onMove);
      div.removeEventListener("pointerup", onUp);
      onSizesChanged();
    };

    div.addEventListener("pointermove", onMove);
    div.addEventListener("pointerup", onUp);
  });

  return div;
}

/** Re-apply flex sizes from the tree to an already-rendered view (keyboard resize). */
export function syncSizes(node: PaneNode, el: HTMLElement): void {
  if (node.type === "leaf") return;
  node.children.forEach((child, i) => {
    const childEl = el.children[i * 2] as HTMLElement | undefined;
    if (!childEl) return;
    childEl.style.flex = flexFor(node, i);
    syncSizes(child, childEl);
  });
}
