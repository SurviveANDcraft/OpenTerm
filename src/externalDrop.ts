import { getCurrentWebview } from "@tauri-apps/api/webview";
import { quotePathForShell } from "./explorer";

/** Files dragged in from outside the app (File Explorer, the desktop, another
 *  editor) land here. Tauri's native drag/drop handler is what gives us real
 *  filesystem paths — the webview's HTML5 `drop` only ever sees opaque File
 *  objects — so the hover highlight and hit-testing are done manually from the
 *  cursor position the handler reports.
 *
 *  Dropping onto a terminal types the path(s) into that pane's stdin, quoted if
 *  needed, exactly like dragging a file out of the sidebar's Files view. */
export function initExternalFileDrop(write: (paneId: string, data: string) => void): void {
  let targetEl: HTMLElement | null = null;

  const clear = () => {
    document.body.classList.remove("dragging-file");
    targetEl?.classList.remove("file-drop-target");
    targetEl = null;
  };

  // The handler reports physical (device) pixels; hit-testing needs CSS pixels.
  const paneAt = (pos: { x: number; y: number }): HTMLElement | null => {
    const dpr = window.devicePixelRatio || 1;
    const el = document
      .elementFromPoint(pos.x / dpr, pos.y / dpr)
      ?.closest<HTMLElement>(".pane");
    // External (reparented) window panes have no PTY here to write into.
    return el && el.dataset.external !== "1" && el.dataset.paneId ? el : null;
  };

  void getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "over") {
      document.body.classList.add("dragging-file");
      const next = paneAt(p.position);
      if (targetEl !== next) {
        targetEl?.classList.remove("file-drop-target");
        next?.classList.add("file-drop-target");
        targetEl = next;
      }
      return;
    }

    if (p.type === "drop") {
      const pane = paneAt(p.position) ?? targetEl;
      const paneId = pane?.dataset.paneId;
      clear();
      if (!paneId || !p.paths.length) return;
      write(paneId, p.paths.map(quotePathForShell).join(" "));
      return;
    }

    clear();
  });
}
