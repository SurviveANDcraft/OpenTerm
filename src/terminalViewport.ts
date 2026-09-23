import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

// xterm 5.5 exposes these to its own FitAddon, but not in its public typings.
// Keep the compatibility access here, using the same cell metrics as FitAddon.
type TerminalCore = {
  _core?: {
    _renderService?: { dimensions: { css: { cell: { height: number } } } };
    viewport?: { syncScrollArea(immediate?: boolean): void };
  };
};

function cellHeight(term: Terminal): number {
  return (term as Terminal & TerminalCore)._core?._renderService?.dimensions.css.cell.height ?? 0;
}

/** Sync the DOM scrollbar FROM the buffer before a pending native scroll event
 * can copy a layout-induced scrollTop=0 back INTO the buffer. No buffer scrolling:
 * focusing a terminal must also preserve a deliberately scrolled-up position. */
export function syncTerminalViewport(term: Terminal): void {
  const viewport = term.element?.querySelector<HTMLElement>(".xterm-viewport");
  const height = cellHeight(term);
  if (!viewport || !viewport.clientHeight || !(height > 0)) return;
  (term as Terminal & TerminalCore)._core?.viewport?.syncScrollArea(true);
  // xterm's sync uses its cached last scrollTop; it can miss a native reset that
  // hasn't delivered its scroll event yet (hide/show, reparent, or focus).
  const top = term.buffer.active.viewportY * height;
  if (viewport.scrollTop !== top) viewport.scrollTop = top;
}

/** Choose the final geometry before resizing. Dividing the previous canvas
 * height by the NEW row count is invalid while xterm's renderer is paused. */
export function fitTerminalToViewport(term: Terminal, fit: FitAddon): void {
  const dims = fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
  const viewport = term.element?.querySelector<HTMLElement>(".xterm-viewport");
  const height = cellHeight(term);
  const rows = viewport && viewport.clientHeight > 0 && height > 0
    ? Math.max(1, Math.floor(viewport.clientHeight / height))
    : dims.rows;
  if (term.cols !== dims.cols || term.rows !== rows) {
    term.resize(dims.cols, rows);
    term.refresh(0, term.rows - 1);
  }
}
