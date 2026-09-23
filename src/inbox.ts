/** Cross-session event log: approvals, errors, and other things that happened
 *  in a session you weren't looking at. In-memory only for now — items are
 *  session-lifetime, same as the attention dots they're mostly sourced from. */

export type InboxKind =
  | "approval"
  | "error"
  | "task-due"
  | "finished"
  | "process-exited"
  | "update-available"
  | "delegation"
  | "backup"
  | "github-outdated"
  | "harness-update";

export interface InboxItem {
  id: string;
  kind: InboxKind;
  message: string;
  sessionId?: string;
  /** Snapshot of the session name at creation time, so a later rename/delete
   *  doesn't change or blank out what an old item says. */
  sessionName?: string;
  paneId?: string;
  taskId?: string;
  createdAt: number;
  read: boolean;
  /** True when `message` is unprocessed terminal output (a prompt line, an
   *  error line) rather than text this app composed. Only raw items are worth
   *  handing to the AI namer — everything else already reads fine. */
  raw?: boolean;
  /** Short human name for the item, replacing the generic kind label in the UI.
   *  Set by the AI namer, or locally for app-composed items. */
  title?: string;
  /** One-sentence description of what happened, shown instead of `message`. */
  summary?: string;
  /** Progress of the AI naming pass. Undefined = not looked at yet. */
  aiState?: "pending" | "done" | "failed";
  /** github-outdated items only: the repo/branch this item is about, and the
   *  ahead/behind counts vs its GitHub remote at the time it was raised. */
  repoRoot?: string;
  repoBranch?: string;
  repoAhead?: number;
  repoBehind?: number;
  /** harness-update items only: which agent CLI is behind, and the versions
   *  the check found. `harnessId` is the binary name (`claude`, `codex`), so
   *  it matches what `detectAgentCommand` reports for a pane. */
  harnessId?: string;
  harnessLabel?: string;
  harnessCurrent?: string;
  harnessLatest?: string;
  /** Progress of a user-triggered harness update, so the Inbox button keeps
   *  showing "Updating…" across re-renders and panel close/reopen. */
  harnessState?: "updating" | "failed";
}

/** Default name for an item, used as-is for app-composed items and as the
 *  fallback when AI naming is off or fails. */
export const KIND_TITLE: Record<InboxKind, string> = {
  approval: "Needs approval",
  error: "Error",
  "task-due": "Task due",
  finished: "Finished",
  "process-exited": "Process exited",
  "update-available": "Update available",
  delegation: "Delegated task",
  backup: "Backup",
  "github-outdated": "Behind GitHub",
  "harness-update": "Agent CLI update",
};

/** One-line explanation of when each kind fires, shown next to its toggle in
 *  Settings → Notifications. */
export const KIND_HINT: Record<InboxKind, string> = {
  approval: "A terminal is waiting on a confirmation or permission prompt",
  error: "A terminal's output matched a known error pattern",
  "task-due": "A task's due date has arrived or passed",
  finished: "A delegated task's agent finished its work",
  "process-exited": "A tracked process ended unexpectedly",
  "update-available": "A new OpenTerm version is ready to install",
  delegation: "A task was handed off to an agent CLI",
  backup: "A session backup was created or restored",
  "github-outdated": "A repo has fallen behind its GitHub remote",
  "harness-update": "An installed agent CLI (Claude Code, Codex, …) has a newer version",
};

const MAX_ITEMS = 200;
const items: InboxItem[] = [];
const listeners = new Set<() => void>();

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function onInboxChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function inboxItems(): InboxItem[] {
  return items;
}

export function unreadCount(): number {
  return items.filter((i) => !i.read).length;
}

/** True when an unread item represents something that broke, rather than just
 *  needing attention or informing — drives the bell badge's urgent color. */
export function hasUnreadUrgent(): boolean {
  return items.some((i) => !i.read && (i.kind === "error" || i.kind === "process-exited"));
}

/** Called with every newly-added item so the AI namer (see `inboxAi.ts`) can
 *  pick it up. Registered rather than imported so this module stays free of
 *  settings/Tauri dependencies — and so the namer is trivially disableable. */
type InboxEnricher = (item: InboxItem) => void;
let enricher: InboxEnricher | null = null;

export function setInboxEnricher(fn: InboxEnricher | null): void {
  enricher = fn;
}

/** Called before an item is added to decide whether it should be, so the user
 *  can turn individual notification kinds off. Same registration pattern as
 *  the enricher above, for the same reason — keeps this module free of a
 *  settings import. Unset (or returning true) means "add it". */
type InboxKindFilter = (kind: InboxKind) => boolean;
let kindFilter: InboxKindFilter | null = null;

export function setInboxKindFilter(fn: InboxKindFilter | null): void {
  kindFilter = fn;
}

export function addInboxItem(item: Omit<InboxItem, "id" | "createdAt" | "read">): void {
  if (kindFilter && !kindFilter(item.kind)) return;
  const entry: InboxItem = { ...item, id: uid(), createdAt: Date.now(), read: false };
  items.unshift(entry);
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
  enricher?.(entry);
  emit();
}

/** Applies a name/description to an item, if it's still in the list. Ignored
 *  for items the user dismissed while the AI call was in flight. */
export function setInboxSummary(
  id: string,
  title: string,
  summary: string,
  state: "done" | "failed"
): void {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (state === "done") {
    item.title = title;
    item.summary = summary;
  }
  item.aiState = state;
  emit();
}

export function setInboxAiState(id: string, state: InboxItem["aiState"]): void {
  const item = items.find((i) => i.id === id);
  if (!item || item.aiState === state) return;
  item.aiState = state;
  emit();
}

export function markInboxRead(id: string): void {
  const item = items.find((i) => i.id === id);
  if (item && !item.read) {
    item.read = true;
    emit();
  }
}

export function markAllInboxRead(): void {
  let changed = false;
  for (const i of items) {
    if (!i.read) {
      i.read = true;
      changed = true;
    }
  }
  if (changed) emit();
}

/** Finds an existing unread "github-outdated" item for a repo, so a repeated
 *  background check updates the count in place instead of piling up dupes. */
export function findGithubInboxItem(repoRoot: string): InboxItem | undefined {
  return items.find((i) => i.kind === "github-outdated" && i.repoRoot === repoRoot && !i.read);
}

/** Merges a patch into an item and notifies listeners. For the few flows that
 *  keep progress state on the item itself (harness updates) rather than in the
 *  panel's DOM, which is rebuilt on every change. */
export function patchInboxItem(id: string, patch: Partial<InboxItem>): void {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  emit();
}

/** Finds an existing unread "harness-update" item for an agent CLI, so a
 *  later background check refreshes it in place instead of stacking dupes. */
export function findHarnessInboxItem(harnessId: string): InboxItem | undefined {
  return items.find((i) => i.kind === "harness-update" && i.harnessId === harnessId && !i.read);
}

/** Drops any "harness-update" item for an agent CLI, read or not — used once
 *  the update has actually landed, so a stale "update available" row doesn't
 *  outlive the version it was about. */
export function clearHarnessInboxItem(harnessId: string): void {
  const before = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "harness-update" && items[i].harnessId === harnessId) items.splice(i, 1);
  }
  if (items.length !== before) emit();
}

export function removeInboxItem(id: string): void {
  const idx = items.findIndex((i) => i.id === id);
  if (idx >= 0) {
    items.splice(idx, 1);
    emit();
  }
}

/** Drops any unread "github-outdated" item for a repo — used once the branch
 *  catches back up with its remote, so a stale warning doesn't linger. */
export function clearGithubInboxItem(repoRoot: string): void {
  const idx = items.findIndex((i) => i.kind === "github-outdated" && i.repoRoot === repoRoot && !i.read);
  if (idx >= 0) {
    items.splice(idx, 1);
    emit();
  }
}

export function clearInbox(): void {
  if (items.length === 0) return;
  items.length = 0;
  emit();
}
