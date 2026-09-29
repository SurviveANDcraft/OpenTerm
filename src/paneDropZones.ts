/** Non-pane places a pane can be dropped on while it's dragged by its title bar
 *  (the Agents panel, so far). Kept in its own module so terminals.ts can ask
 *  "is the pointer over a zone?" without importing the panels that own them. */

export interface PaneDropZone {
  el: HTMLElement;
  /** Whether this pane can be dropped here (e.g. only terminals, not browsers). */
  accepts(paneId: string): boolean;
  /** Hover feedback while a drag is over (or leaves) the zone. */
  setHover(paneId: string | null): void;
  drop(paneId: string): void;
}

const zones = new Set<PaneDropZone>();

export function registerPaneDropZone(zone: PaneDropZone): void {
  zones.add(zone);
}

/** The zone under the pointer that will take this pane, if any. */
export function paneDropZoneAt(x: number, y: number, paneId: string): PaneDropZone | null {
  const under = document.elementFromPoint(x, y);
  if (!under) return null;
  for (const z of zones) {
    if (z.el.isConnected && z.el.contains(under) && z.accepts(paneId)) return z;
  }
  return null;
}
