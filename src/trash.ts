/** A short-lived undo ring for destructive actions (closing a session, closing
 *  a pane, deleting a task). Keeps the last few closed things around so an
 *  accidental confirm doesn't mean permanent loss — mirrors "reopen closed
 *  tab" in a browser. Each entry knows how to undo itself; this module just
 *  tracks recency and expiry. */
export interface TrashEntry {
  id: string;
  label: string;
  closedAt: number;
  restore: () => void;
}

const MAX_ENTRIES = 3;
const TTL_MS = 10 * 60 * 1000;

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

class Trash {
  private entries: TrashEntry[] = [];
  private timers = new Map<string, number>();
  private listeners = new Set<(entry: TrashEntry) => void>();

  /** Called whenever a new entry is pushed — used to drive the undo toast. */
  onPush(fn: (entry: TrashEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(entry: { label: string; restore: () => void }): void {
    const full: TrashEntry = { id: uid(), closedAt: Date.now(), ...entry };
    this.entries.unshift(full);
    while (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.pop()!;
      this.clearTimer(dropped.id);
    }
    this.timers.set(
      full.id,
      window.setTimeout(() => this.discard(full.id), TTL_MS)
    );
    this.listeners.forEach((fn) => fn(full));
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) window.clearTimeout(t);
    this.timers.delete(id);
  }

  /** Drops an entry without restoring it (expiry, or ring overflow). */
  discard(id: string): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return;
    this.entries.splice(idx, 1);
    this.clearTimer(id);
  }

  /** Restores and removes an entry — the most recent one by default. Returns
   *  true if something was restored. */
  restore(id?: string): boolean {
    const idx = id ? this.entries.findIndex((e) => e.id === id) : 0;
    if (idx < 0 || idx >= this.entries.length) return false;
    const [entry] = this.entries.splice(idx, 1);
    this.clearTimer(entry.id);
    entry.restore();
    return true;
  }

  list(): TrashEntry[] {
    return this.entries;
  }
}

export const trash = new Trash();
