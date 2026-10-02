/** Places outside the terminal grid that take a dragged file (the Agents
 *  panel's chat, so far). Both file drags ask here first: rows dragged out of
 *  the Files view (explorer.ts) and files dragged in from Windows
 *  (externalDrop.ts). Same idea as paneDropZones.ts, for files. */

export interface FileDropZone {
  el: HTMLElement;
  setHover(on: boolean): void;
  drop(paths: string[]): void;
}

const zones = new Set<FileDropZone>();

export function registerFileDropZone(zone: FileDropZone): void {
  zones.add(zone);
}

/** The zone under the pointer (CSS pixels), if any. */
export function fileDropZoneAt(x: number, y: number): FileDropZone | null {
  const under = document.elementFromPoint(x, y);
  if (!under) return null;
  for (const z of zones) if (z.el.isConnected && z.el.contains(under)) return z;
  return null;
}
