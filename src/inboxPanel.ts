import { store } from "./store";
import { collapse, cancelCollapse } from "./popAnim";
import { DELEGATION_AGENTS, DelegationAgent } from "./types";
import {
  clearInbox,
  InboxItem,
  InboxKind,
  inboxItems,
  KIND_TITLE,
  markAllInboxRead,
  markInboxRead,
  onInboxChange,
  removeInboxItem,
} from "./inbox";

export interface InboxPanelHandlers {
  /** Focus the session (and pane, if given) an item came from. */
  onGoToPane(sessionId: string, paneId?: string): void;
  /** Open the tasks panel for a session, focused on one task. */
  onGoToTask(sessionId: string, taskId: string): void;
  /** Open the settings view (used for the update-available item). */
  onGoToSettings(): void;
  /** "Update now" on a harness-update item — runs the agent CLI's updater and
   *  refreshes any pane running it. Resolves when the update has finished. */
  onUpdateHarness(item: InboxItem): void;
  /** "Review with AI" on a github-outdated item — opens `agent` in the item's
   *  session and hands it the sync-status prompt. */
  onReviewGithub(item: InboxItem, agent: DelegationAgent): void;
}

const ICONS: Record<InboxKind, string> = {
  approval:
    '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v3.4l2.2 1.3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  error:
    '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="8" y1="5.2" x2="8" y2="9" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="11.1" r="0.9" fill="currentColor"/></svg>',
  "task-due":
    '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="2.5" y="3" width="11" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.1"/><line x1="2.5" y1="6" x2="13.5" y2="6" stroke="currentColor" stroke-width="1.1"/><line x1="5.3" y1="1.6" x2="5.3" y2="4" stroke="currentColor" stroke-width="1.1"/><line x1="10.7" y1="1.6" x2="10.7" y2="4" stroke="currentColor" stroke-width="1.1"/></svg>',
  finished:
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 8.3l3 3 7-7.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  "process-exited":
    '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="3" y="3" width="10" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="6" y1="6" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="6" x2="6" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>',
  "update-available":
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 2v7.5M5 7l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="3.5" y1="13" x2="12.5" y2="13" stroke="currentColor" stroke-width="1.2"/></svg>',
  delegation:
    '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="4" y="6" width="8" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.1"/><line x1="7.9" y1="6" x2="7.9" y2="3.2" stroke="currentColor" stroke-width="1.1"/><circle cx="7.9" cy="2.4" r="0.9" fill="currentColor"/><circle cx="6.3" cy="8.7" r="0.8" fill="currentColor"/><circle cx="9.5" cy="8.7" r="0.8" fill="currentColor"/></svg>',
  backup:
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 2.5v7M5.4 7l2.6 2.6L10.6 7" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="2.5" y="11.5" width="11" height="2.5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  "harness-update":
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M13 8a5 5 0 1 0-1.5 3.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M13 4.6V8h-3.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  "github-outdated":
    '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 1.5a6.5 6.5 0 0 0-2.05 12.67c.32.06.44-.14.44-.31v-1.2c-1.82.4-2.2-.78-2.2-.78-.3-.76-.73-.96-.73-.96-.6-.4.05-.4.05-.4.66.05 1 .68 1 .68.58 1 1.53.71 1.9.54.06-.42.23-.71.41-.88-1.45-.16-2.98-.73-2.98-3.23 0-.71.26-1.3.68-1.75-.07-.16-.3-.83.06-1.73 0 0 .55-.18 1.8.67a6.2 6.2 0 0 1 3.28 0c1.25-.85 1.8-.67 1.8-.67.36.9.13 1.57.06 1.73.42.45.68 1.04.68 1.75 0 2.51-1.53 3.06-3 3.22.24.21.45.62.45 1.25v1.85c0 .17.12.38.45.31A6.5 6.5 0 0 0 8 1.5z" fill="currentColor"/></svg>',
};

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function createInboxPanel(handlers: InboxPanelHandlers) {
  const el = document.createElement("div");
  el.className = "inbox-panel";

  const head = document.createElement("div");
  head.className = "inbox-panel-head";
  const title = document.createElement("span");
  title.textContent = "Inbox";
  const actions = document.createElement("div");
  actions.className = "inbox-panel-actions";
  const markBtn = document.createElement("button");
  markBtn.className = "inbox-text-btn";
  markBtn.textContent = "Mark all read";
  const clearBtn = document.createElement("button");
  clearBtn.className = "inbox-text-btn";
  clearBtn.textContent = "Clear";
  actions.append(markBtn, clearBtn);
  head.append(title, actions);

  const list = document.createElement("div");
  list.className = "inbox-panel-list";

  el.append(head, list);
  document.body.appendChild(el);

  let open = false;
  /** The button we were opened from, so the outside-click handler can spare it. */
  let anchorEl: HTMLElement | null = null;
  let lastReviewAgent: DelegationAgent = DELEGATION_AGENTS[0].id;

  function sessionColor(id?: string): string {
    return (id && store.state.sessions.find((s) => s.id === id)?.color) || "var(--text-faint)";
  }

  function navigate(it: InboxItem): void {
    if ((it.kind === "task-due" || it.kind === "delegation") && it.sessionId && it.taskId) {
      handlers.onGoToTask(it.sessionId, it.taskId);
    } else if (it.kind === "harness-update") {
      // Nothing to jump to — the item's own "Update" button is the action.
    } else if (it.kind === "update-available") {
      handlers.onGoToSettings();
    } else if (it.sessionId) {
      handlers.onGoToPane(it.sessionId, it.paneId);
    }
  }

  function render(): void {
    const items = inboxItems();
    if (items.length === 0) {
      list.innerHTML = `<div class="inbox-empty">Nothing here — approvals, errors and other cross-session events will show up here.</div>`;
      return;
    }
    list.replaceChildren(
      ...items.map((it) => {
        const row = document.createElement("div");
        row.className = `inbox-row inbox-kind-${it.kind}`;
        row.classList.toggle("unread", !it.read);

        const icon = document.createElement("span");
        icon.className = "inbox-row-icon";
        icon.innerHTML = ICONS[it.kind];

        const main = document.createElement("div");
        main.className = "inbox-row-main";
        const top = document.createElement("div");
        top.className = "inbox-row-top";
        // Name and description, when the item has them — raw terminal items get
        // theirs from the AI namer, and fall back to their original text here
        // while that's in flight (or if it failed).
        const naming = it.aiState === "pending" ? '<span class="inbox-row-naming">naming…</span>' : "";
        top.innerHTML = `<span class="inbox-row-kind">${esc(it.title || KIND_TITLE[it.kind])}</span>${naming}<span class="inbox-row-time">${relTime(it.createdAt)}</span>`;
        const msg = document.createElement("div");
        msg.className = "inbox-row-msg";
        msg.textContent = it.summary || it.message;
        // The original output stays one hover away — a rewritten line should
        // never be the only copy of what the terminal actually said.
        if (it.summary && it.summary !== it.message) msg.title = it.message;
        main.append(top, msg);
        if (it.sessionName) {
          const chip = document.createElement("span");
          chip.className = "inbox-row-session";
          chip.innerHTML = `<span class="inbox-row-session-dot" style="background:${sessionColor(it.sessionId)}"></span>${esc(it.sessionName)}`;
          main.appendChild(chip);
        }
        if (it.kind === "harness-update" && it.harnessId) {
          const row2 = document.createElement("div");
          row2.className = "inbox-row-review";
          const updateBtn = document.createElement("button");
          updateBtn.className = "inbox-review-btn";
          const busy = it.harnessState === "updating";
          updateBtn.textContent = busy
            ? "Updating…"
            : it.harnessState === "failed"
              ? "Try again"
              : `Update to ${it.harnessLatest ?? "latest"}`;
          updateBtn.disabled = busy;
          updateBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (it.harnessState === "updating") return;
            handlers.onUpdateHarness(it);
          });
          row2.append(updateBtn);
          main.appendChild(row2);
        }
        if (it.kind === "github-outdated" && it.sessionId) {
          const row2 = document.createElement("div");
          row2.className = "inbox-row-review";

          const select = document.createElement("select");
          select.className = "inbox-review-agent";
          for (const a of DELEGATION_AGENTS) {
            const opt = document.createElement("option");
            opt.value = a.id;
            opt.textContent = a.label;
            select.appendChild(opt);
          }
          select.value = lastReviewAgent;

          const reviewBtn = document.createElement("button");
          reviewBtn.className = "inbox-review-btn";
          reviewBtn.textContent = "Review with AI";
          reviewBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            lastReviewAgent = select.value as DelegationAgent;
            markInboxRead(it.id);
            handlers.onReviewGithub(it, select.value as DelegationAgent);
            close();
          });

          select.addEventListener("click", (e) => e.stopPropagation());
          select.addEventListener("change", (e) => {
            e.stopPropagation();
            lastReviewAgent = select.value as DelegationAgent;
          });

          row2.append(select, reviewBtn);
          main.appendChild(row2);
        }

        const dismiss = document.createElement("button");
        dismiss.className = "inbox-row-dismiss";
        dismiss.title = "Dismiss";
        dismiss.textContent = "×";
        dismiss.addEventListener("click", (e) => {
          e.stopPropagation();
          removeInboxItem(it.id);
        });

        row.append(icon, main, dismiss);
        row.addEventListener("click", () => {
          markInboxRead(it.id);
          navigate(it);
          // Harness updates act in place; closing the panel would hide the
          // progress the user just asked to see.
          if (it.kind !== "harness-update") close();
        });
        return row;
      })
    );
  }

  function position(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    el.style.top = `${r.bottom + 6}px`;
    el.style.left = `${r.left}px`;
    const panelRect = el.getBoundingClientRect();
    if (panelRect.right > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - panelRect.width - 8)}px`;
    }
  }

  function show(anchor: HTMLElement): void {
    cancelCollapse(el); // reopened mid-collapse: start from a clean state
    open = true;
    anchorEl = anchor;
    render();
    el.classList.add("visible");
    position(anchor);
  }

  function close(): void {
    if (!open) return;
    open = false;
    anchorEl = null;
    collapse(el, () => el.classList.remove("visible"));
  }

  function toggle(anchor: HTMLElement): void {
    if (open) close();
    else show(anchor);
  }

  markBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    markAllInboxRead();
  });
  clearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearInbox();
  });
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  // Ignore pointerdowns on the button that opened us: this fires before its
  // click, so closing here would let that click reopen the panel — making the
  // toggle look like it never closes.
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (open && !el.contains(t) && !anchorEl?.contains(t)) close();
  });
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  });

  onInboxChange(() => {
    if (open) render();
  });

  return { el, show, close, toggle, isOpen: () => open };
}
