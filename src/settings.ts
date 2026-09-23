import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { store } from "./store";
import {
  ACTIONS,
  Action,
  DEFAULT_KEYBINDS,
  openTaskCount,
  Session,
  Settings,
} from "./types";
import { collectLeaves } from "./tree";
import { cancelRecording, chordFromEvent, prettyChord, recorder } from "./keybinds";
import { Theme, THEMES } from "./themes";
import { checkForUpdate, installUpdate, onUpdateState } from "./updater";
import { InboxKind, KIND_HINT, KIND_TITLE } from "./inbox";
import { onHarnessState, runHarnessCheck } from "./harnessUpdates";
import type { ConfirmOptions } from "./confirm";
import { createDictationTab } from "./dictation/settingsTab";

/** One backup on disk, as described by the `list_backups` command. */
export interface BackupInfo {
  filename: string;
  kind: "ring" | "daily" | "pre-restore";
  createdAt: number;
  sizeBytes: number;
  sessionNames: string[];
  paneCount: number;
  ringSlot: number | null;
  valid: boolean;
}

export interface SettingsHandlers {
  /** Called when the user clicks Save — commit the draft, apply it live, and persist. */
  onSave(draft: Settings): void;
  onResetData(): void;
  /** Close settings and run the first-run welcome again. */
  onReplayWelcome(): void;
  /** Confirm with the user, then swap state.json for this backup and reload.
   *  Resolves false when the user backed out. */
  onRestoreBackup(backup: BackupInfo): Promise<boolean>;
  /** Un-archive a session — puts it back in the sidebar with its panes relaunched. */
  onRestoreArchived(id: string): void;
  /** Confirm with the user, then permanently close an archived session. */
  onDeleteArchived(id: string): Promise<void>;
  /** Called when the user clicks the X in the top-right corner. */
  onClose(): void;
  /** The app's confirmation modal. */
  onConfirm(opts: ConfirmOptions): Promise<boolean>;
}

type CatId = "appearance" | "terminal" | "ai" | "dictation" | "notifications" | "keyboard" | "sessions" | "about";

const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const CATEGORIES: { id: CatId; label: string; desc: string; icon: string }[] = [
  {
    id: "appearance",
    label: "Appearance",
    desc: "Theme, fonts and how your terminals look.",
    icon: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>'),
  },
  {
    id: "terminal",
    label: "Terminal",
    desc: "Shell, scrollback and Windows integration.",
    icon: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5l2 1.5-2 1.5M8.5 10H11"/>'),
  },
  {
    id: "ai",
    label: "AI & Agents",
    desc: "Agent conversations, OpenRouter and agent CLI versions.",
    icon: svg('<path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z"/>'),
  },
  {
    id: "dictation",
    label: "Dictation",
    desc: "Hold a shortcut anywhere in Windows, speak, and your words appear.",
    icon: svg('<rect x="5.5" y="1.8" width="5" height="8" rx="2.5"/><path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v1.8"/>'),
  },
  {
    id: "notifications",
    label: "Notifications",
    desc: "How OpenTerm gets your attention, and what reaches the inbox.",
    icon: svg('<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z"/><path d="M6.5 14h3"/>'),
  },
  {
    id: "keyboard",
    label: "Keyboard",
    desc: "Shortcuts for every action.",
    icon: svg('<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6"/>'),
  },
  {
    id: "sessions",
    label: "Sessions & Backups",
    desc: "Archived sessions and restore points for your whole workspace.",
    icon: svg('<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5V5H5"/><path d="M8 5v3l2 1.5"/>'),
  },
  {
    id: "about",
    label: "About & Data",
    desc: "Version, updates and where your data lives.",
    icon: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5V11M8 5.2h.01"/>'),
  },
];

const CAT_STORAGE_KEY = "openterm.settings.category";

export function createSettingsView(handlers: SettingsHandlers) {
  const el = document.createElement("div");
  el.className = "settings-page";

  // Edits happen on a working copy so nothing takes effect (or gets written to
  // disk) until the user explicitly saves. `reset()` re-syncs this from the
  // live settings — called whenever the settings page is opened, so it never
  // shows stale data and never carries over an old unsaved draft.
  let draft: Settings = structuredClone(store.state.settings);
  let dirty = false;
  let justSaved = false;
  let savedTimer: number | undefined;
  let fieldSeq = 0;
  let query = "";
  let activeCat: CatId = loadCategory();

  function loadCategory(): CatId {
    try {
      const v = localStorage.getItem(CAT_STORAGE_KEY);
      if (CATEGORIES.some((c) => c.id === v)) return v as CatId;
    } catch {
      /* storage unavailable — fall through */
    }
    return "appearance";
  }

  function btn(className: string, text: string, onClick?: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = text;
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // ---------------------------------------------------------------- layout
  // Everything here is built once. render() only rebuilds `content`, so the
  // search box keeps focus and the scroll position survives re-renders.
  const nav = document.createElement("header");
  nav.className = "settings-nav";

  const navTitle = document.createElement("div");
  navTitle.className = "settings-nav-title";
  navTitle.textContent = "Settings";

  const searchWrap = document.createElement("label");
  searchWrap.className = "settings-search";
  searchWrap.innerHTML = svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>');
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search settings";
  search.spellcheck = false;
  search.addEventListener("input", () => {
    query = search.value;
    applyFilter();
    body.scrollTop = 0;
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      search.value = "";
      query = "";
      applyFilter();
    }
  });
  // Collapsed to an icon until focused (click or Ctrl+F) or holding a query.
  searchWrap.title = "Search settings (Ctrl+F)";
  searchWrap.appendChild(search);

  const navList = document.createElement("nav");
  navList.className = "settings-nav-list";
  // One glass pill that glides between tabs instead of each tab repainting.
  const navIndicator = document.createElement("span");
  navIndicator.className = "settings-nav-indicator";
  navIndicator.setAttribute("aria-hidden", "true");
  navList.appendChild(navIndicator);
  const navButtons = new Map<CatId, HTMLButtonElement>();
  const navBadges = new Map<CatId, HTMLElement>();
  for (const cat of CATEGORIES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "settings-nav-item";
    b.innerHTML = cat.icon;
    const label = document.createElement("span");
    label.className = "settings-nav-label";
    label.textContent = cat.label;
    const badge = document.createElement("span");
    badge.className = "settings-nav-badge";
    badge.hidden = true;
    b.append(label, badge);
    b.addEventListener("click", () => selectCategory(cat.id));
    navButtons.set(cat.id, b);
    navBadges.set(cat.id, badge);
    navList.appendChild(b);
  }

  const navFoot = document.createElement("div");
  navFoot.className = "settings-nav-foot";
  navFoot.textContent = "OpenTerm";


  const mainCol = document.createElement("div");
  mainCol.className = "settings-main";
  const body = document.createElement("div");
  body.className = "settings-body";
  const content = document.createElement("div");
  content.className = "settings-content";
  body.appendChild(content);

  const emptyEl = document.createElement("div");
  emptyEl.className = "settings-no-results";
  emptyEl.hidden = true;

  // Floating bar that appears only while there's something to save.
  const savebar = document.createElement("div");
  savebar.className = "settings-savebar";
  const saveMsg = document.createElement("span");
  saveMsg.className = "settings-savebar-msg";
  const discardBtn = btn("btn-ghost", "Discard", discard);
  const saveBtn = btn("btn-primary", "Save changes", save);
  saveBtn.title = "Save (Ctrl+S)";
  savebar.append(saveMsg, discardBtn, saveBtn);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "settings-close";
  closeBtn.title = "Close settings";
  closeBtn.setAttribute("aria-label", "Close settings");
  closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>`;
  closeBtn.addEventListener("click", () => handlers.onClose());

  // One capsule: tabs | search + close. The search pill lives in a fixed 32px
  // slot and unfurls leftward over the tabs, so opening it never shifts layout.
  const navSep = document.createElement("span");
  navSep.className = "settings-nav-sep";
  const searchSlot = document.createElement("div");
  searchSlot.className = "settings-search-slot";
  searchSlot.appendChild(searchWrap);
  const navDock = document.createElement("div");
  navDock.className = "settings-nav-dock";
  navDock.append(navList, navSep, searchSlot, closeBtn);
  nav.setAttribute("aria-label", navTitle.textContent ?? "Settings");
  nav.appendChild(navDock);

  mainCol.append(body, savebar);
  el.append(nav, mainCol);

  function moveIndicator(): void {
    const active = navButtons.get(activeCat)!;
    const show = !el.classList.contains("searching") && active.offsetWidth > 0;
    navIndicator.classList.toggle("visible", show);
    if (!show) {
      delete navIndicator.dataset.placed;
      return;
    }
    // First placement (page just opened / search cleared) snaps, later ones glide.
    navIndicator.classList.toggle("instant", !navIndicator.dataset.placed);
    navIndicator.dataset.placed = "1";
    navIndicator.style.width = `${active.offsetWidth}px`;
    navIndicator.style.transform = `translateX(${active.offsetLeft}px)`;
    active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
  new ResizeObserver(() => moveIndicator()).observe(navList);

  window.addEventListener(
    "keydown",
    (e) => {
      if (el.offsetParent === null || recorder.active) return; // settings closed / rebinding
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        e.stopPropagation();
        save();
      } else if (k === "f") {
        e.preventDefault();
        e.stopPropagation();
        search.focus();
        search.select();
      }
    },
    true
  );

  function setBadge(cat: CatId, text: string | null): void {
    const b = navBadges.get(cat)!;
    b.hidden = text === null;
    b.textContent = text ?? "";
    b.classList.toggle("dot", text === "");
  }

  function selectCategory(id: CatId): void {
    activeCat = id;
    try {
      localStorage.setItem(CAT_STORAGE_KEY, id);
    } catch {
      /* not critical */
    }
    if (query) {
      query = "";
      search.value = "";
    }
    applyFilter();
    body.scrollTop = 0;
  }

  /** Shows the active category — or, while searching, every section/row whose
   *  text matches, grouped under its category. Pure DOM toggling, no re-render. */
  function applyFilter(): void {
    const q = query.trim().toLowerCase();
    const searching = q.length > 0;
    el.classList.toggle("searching", searching);
    let total = 0;
    for (const catEl of Array.from(content.querySelectorAll<HTMLElement>(".settings-cat"))) {
      const id = catEl.dataset.cat as CatId;
      let hits = 0;
      for (const sec of Array.from(catEl.querySelectorAll<HTMLElement>(".settings-section"))) {
        const rows = Array.from(sec.querySelectorAll<HTMLElement>("[data-search]"));
        if (!searching) {
          sec.hidden = false;
          for (const r of rows) r.hidden = false;
          continue;
        }
        const secMatch = (sec.dataset.search ?? "").includes(q);
        let rowHits = 0;
        for (const r of rows) {
          const m = secMatch || (r.dataset.search ?? "").includes(q);
          r.hidden = !m;
          if (m) rowHits++;
        }
        sec.hidden = !(secMatch || rowHits > 0);
        if (!sec.hidden) hits++;
      }
      catEl.hidden = searching ? hits === 0 : id !== activeCat;
      navButtons.get(id)!.classList.toggle("active", !searching && id === activeCat);
      navButtons.get(id)!.classList.toggle("no-match", searching && hits === 0);
      total += hits;
    }
    emptyEl.hidden = !searching || total > 0;
    moveIndicator();
    emptyEl.textContent = `No settings match “${query.trim()}”.`;
  }

  function markDirty(): void {
    dirty = true;
    justSaved = false;
    updateSaveState();
  }

  function updateSaveState(): void {
    savebar.classList.toggle("visible", dirty || justSaved);
    savebar.classList.toggle("saved", justSaved && !dirty);
    saveBtn.disabled = !dirty;
    saveMsg.textContent = dirty ? "You have unsaved changes" : justSaved ? "Settings saved" : "";
  }

  function reset(): void {
    cancelRecording(); // in case a previous visit left a recording in progress
    draft = structuredClone(store.state.settings);
    dirty = false;
    justSaved = false;
    query = "";
    search.value = "";
    render();
    body.scrollTop = 0;
    // Opening settings is the moment the list needs to be current — a backup
    // written a second ago should already be in it.
    void loadBackups();
  }

  function discard(): void {
    cancelRecording();
    draft = structuredClone(store.state.settings);
    dirty = false;
    render();
  }

  function save(): void {
    if (!dirty) return;
    handlers.onSave(structuredClone(draft));
    dirty = false;
    justSaved = true;
    window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => {
      justSaved = false;
      updateSaveState();
    }, 1600);
    updateSaveState();
  }

  // ---------------------------------------------------------------- building blocks
  /** A small "i" badge that reveals `text` in a tooltip on hover/focus — for
   *  the long explanations that would otherwise crowd a row. */
  function infoIcon(text: string): HTMLElement {
    const i = document.createElement("span");
    i.className = "info-icon";
    i.textContent = "i";
    i.tabIndex = 0;
    i.dataset.tip = text;
    // Inside a <label>, a click would otherwise toggle the associated switch.
    i.addEventListener("click", (e) => e.preventDefault());
    return i;
  }

  interface FieldOpts {
    /** Short, always-visible explanation under the label. */
    desc?: string;
    /** Longer explanation behind an info icon. */
    tip?: string;
    /** Put the control on its own full-width line below the label. */
    stack?: boolean;
    /** Extra search terms. */
    keywords?: string;
  }

  function field(label: string, control: HTMLElement, opts: FieldOpts = {}): HTMLElement {
    const row = document.createElement("div");
    row.className = "field";
    if (opts.stack) row.classList.add("field-stack");

    const text = document.createElement("div");
    text.className = "field-text";
    const l = document.createElement("label");
    l.textContent = label;
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      if (!control.id) control.id = `settings-field-${++fieldSeq}`;
      l.htmlFor = control.id;
    }
    if (opts.tip) l.appendChild(infoIcon(opts.tip));
    text.appendChild(l);
    if (opts.desc) {
      const p = document.createElement("p");
      p.className = "field-desc";
      p.textContent = opts.desc;
      text.appendChild(p);
    }

    const ctl = document.createElement("div");
    ctl.className = "field-control";
    ctl.appendChild(control);

    row.append(text, ctl);
    row.dataset.search = [label, opts.desc, opts.tip, opts.keywords].filter(Boolean).join(" ").toLowerCase();
    return row;
  }

  function toggle(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "switch";
    cb.setAttribute("role", "switch");
    cb.checked = checked;
    cb.addEventListener("change", () => onChange(cb.checked));
    return cb;
  }

  function segmented<T extends string>(
    options: { value: T; label: string }[],
    current: T,
    onChange: (v: T) => void
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "segmented";
    wrap.setAttribute("role", "radiogroup");
    for (const o of options) {
      const b = btn("", o.label);
      b.setAttribute("role", "radio");
      const select = (on: boolean) => {
        b.classList.toggle("selected", on);
        b.setAttribute("aria-checked", String(on));
      };
      select(o.value === current);
      b.addEventListener("click", () => {
        for (const other of Array.from(wrap.children)) {
          other.classList.remove("selected");
          other.setAttribute("aria-checked", "false");
        }
        select(true);
        onChange(o.value);
      });
      wrap.appendChild(b);
    }
    return wrap;
  }

  function range(value: number, min: number, max: number, onInput: (v: number) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    const val = document.createElement("span");
    val.className = "range-val";
    val.textContent = `${value}px`;
    input.addEventListener("input", () => {
      val.textContent = `${input.value}px`;
      onInput(Number(input.value));
    });
    const wrap = document.createElement("div");
    wrap.className = "range-wrap";
    wrap.append(input, val);
    return wrap;
  }

  interface SectionOpts {
    /** Search terms that reveal the whole section. The title always counts. */
    keywords?: string;
    /** Buttons shown on the right of the section header. */
    actions?: HTMLElement[];
    className?: string;
  }

  function section(title: string, desc: string | null, rows: HTMLElement[], opts: SectionOpts = {}): HTMLElement {
    const s = document.createElement("section");
    s.className = "settings-section";
    if (opts.className) s.classList.add(opts.className);

    const head = document.createElement("div");
    head.className = "settings-section-head";
    const text = document.createElement("div");
    text.className = "settings-section-text";
    const h = document.createElement("h2");
    h.textContent = title;
    text.appendChild(h);
    if (desc) {
      const p = document.createElement("p");
      p.className = "settings-section-desc";
      p.textContent = desc;
      text.appendChild(p);
    }
    head.appendChild(text);
    if (opts.actions?.length) {
      const a = document.createElement("div");
      a.className = "settings-section-actions";
      a.append(...opts.actions);
      head.appendChild(a);
    }

    const sb = document.createElement("div");
    sb.className = "settings-section-body";
    sb.append(...rows);

    s.append(head, sb);
    s.dataset.search = [title, opts.keywords].filter(Boolean).join(" ").toLowerCase();
    return s;
  }

  function themeCard(theme: Theme): HTMLElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "theme-card";
    card.classList.toggle("selected", draft.theme === theme.id);

    const preview = document.createElement("div");
    preview.className = "theme-preview";
    preview.style.background = theme.vars["--bg-app"];
    preview.style.borderColor = theme.vars["--border"];
    for (const key of ["--bg-sidebar", "--accent", "--text-dim"] as const) {
      const dot = document.createElement("span");
      dot.className = "theme-preview-dot";
      dot.style.background = theme.vars[key];
      preview.appendChild(dot);
    }

    const name = document.createElement("span");
    name.className = "theme-name";
    name.textContent = theme.name;

    card.append(preview, name);
    card.addEventListener("click", () => {
      draft.theme = theme.id;
      markDirty();
      render();
    });
    return card;
  }

  // ---------------------------------------------------------------- updates
  // Built once, not per render(): these subscribe to updater state, and
  // rebuilding them on every render would stack up duplicate listeners.
  const updatesSection = buildUpdatesSection();
  // Built once like the sections above: it owns a live simulator, a level
  // meter and history polling that must not stack up across re-renders.
  const dictationTab = createDictationTab({
    draft: () => draft,
    markDirty,
    openAiCategory: () => selectCategory("ai"),
    confirm: (opts) => handlers.onConfirm(opts),
    ui: { field, section, toggle, segmented, btn },
  });
  const harnessSection = buildHarnessSection();

  function buildUpdatesSection(): HTMLElement {
    const versionEl = document.createElement("code");
    versionEl.className = "state-path";

    const status = document.createElement("span");
    status.className = "field-hint";

    const checkBtn = btn("btn-secondary", "Check for updates", () => void checkForUpdate());
    const installBtn = btn("btn-primary", "Download & install", () => void installUpdate());

    const row = document.createElement("div");
    row.className = "update-actions";
    row.append(checkBtn, installBtn, status);

    onUpdateState((s) => {
      versionEl.textContent = s.currentVersion;
      navFoot.textContent = s.currentVersion ? `OpenTerm ${s.currentVersion}` : "OpenTerm";
      installBtn.style.display = s.phase === "available" || s.phase === "downloading" ? "" : "none";
      const busy = s.phase === "checking" || s.phase === "downloading";
      checkBtn.disabled = busy;
      installBtn.disabled = s.phase === "downloading";
      setBadge("about", s.phase === "available" || s.phase === "downloading" || s.phase === "ready" ? "" : null);
      status.textContent =
        s.phase === "checking"
          ? "Checking…"
          : s.phase === "available"
            ? `Version ${s.newVersion} is available`
            : s.phase === "uptodate"
              ? "You're on the latest version"
              : s.phase === "downloading"
                ? `Downloading… ${s.progress != null ? Math.round(s.progress * 100) + "%" : ""}`
                : s.phase === "ready"
                  ? "Installing — restarting shortly"
                  : s.phase === "error"
                    ? `Couldn't check: ${s.error}`
                    : "";
    });

    return section(
      "Updates",
      null,
      [field("Installed version", versionEl), field("App updates", row, { keywords: "upgrade release" })],
      { keywords: "version update upgrade release" }
    );
  }

  /** Versions of the installed agent CLIs, plus a manual re-check. Purely a
   *  read-out: the check itself lives in `harnessUpdates.ts` and raising the
   *  inbox item (with its update button) is main.ts's job, so triggering a
   *  check here produces exactly what the background timer would. */
  function buildHarnessSection(): HTMLElement {
    const list = document.createElement("div");
    list.className = "harness-list";

    const status = document.createElement("span");
    status.className = "field-hint";

    const checkBtn = btn("btn-ghost", "Check now", () => void runHarnessCheck());

    onHarnessState((st) => {
      checkBtn.disabled = st.phase === "checking";
      setBadge("ai", st.results.some((h) => h.outdated) ? "" : null);
      status.textContent =
        st.phase === "checking"
          ? "Checking…"
          : st.phase === "error"
            ? `Couldn't check: ${st.error}`
            : st.phase === "done" && st.results.length === 0
              ? "No supported agent CLIs found on PATH"
              : "";
      status.hidden = !status.textContent;

      list.replaceChildren(
        ...st.results.map((h) => {
          const rowEl = document.createElement("div");
          rowEl.className = "harness-row";
          rowEl.classList.toggle("outdated", h.outdated);
          const name = document.createElement("span");
          name.className = "harness-name";
          name.textContent = h.label;
          const ver = document.createElement("code");
          ver.className = "state-path";
          ver.textContent = h.outdated ? `${h.current} → ${h.latest}` : h.current;
          const note = document.createElement("span");
          note.className = "harness-note";
          note.textContent = h.outdated ? "Update available — see Inbox" : "Up to date";
          rowEl.append(name, ver, note);
          return rowEl;
        })
      );
    });

    return section(
      "Agent CLIs",
      "Claude Code, Codex and other agent CLIs on your PATH. Outdated ones also show up in the Inbox with a one-click update.",
      [list, status],
      { keywords: "claude codex cli version harness update", actions: [checkBtn] }
    );
  }

  // ---------------------------------------------------------------- backups
  // Built once (like the updates section): render() re-appends it, so the
  // search box keeps its text and the list keeps its scroll across renders.
  let backups: BackupInfo[] = [];
  let backupsLoaded = false;
  let expanded: string | null = null;
  interface AiPick {
    /** Filename of the winning backup, or null when nothing matched. */
    filename: string | null;
    confidence: string;
    reason: string;
    runnersUp: string[];
  }
  let aiPick: AiPick | null = null;

  const backupSearch = document.createElement("input");
  const backupList = document.createElement("div");
  const backupStatus = document.createElement("span");
  const aiStatus = document.createElement("div");
  const aiQuery = document.createElement("input");
  const aiRow = document.createElement("div");
  const aiBtn = document.createElement("button");
  const aiGoBtn = document.createElement("button");

  function relTime(ms: number): string {
    const diff = Date.now() - ms;
    const min = Math.round(diff / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
    const d = Math.round(hr / 24);
    return d < 30 ? `${d} day${d === 1 ? "" : "s"} ago` : new Date(ms).toLocaleDateString();
  }

  function exactTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function kindLabel(b: BackupInfo): string {
    return b.kind === "daily" ? "daily" : b.kind === "pre-restore" ? "pre-restore" : "auto";
  }

  async function loadBackups(): Promise<void> {
    backupStatus.textContent = "Loading…";
    try {
      backups = await invoke<BackupInfo[]>("list_backups");
      backupsLoaded = true;
      backupStatus.textContent = "";
    } catch (e) {
      backupStatus.textContent = `Couldn't read backups: ${e instanceof Error ? e.message : String(e)}`;
    }
    renderBackups();
  }

  /** What changed between a backup's session line-up and the live one. */
  function diffSessions(b: BackupInfo): { gone: string[]; added: string[] } {
    const now = store.state.sessions.map((s) => s.name);
    const count = (names: string[]) =>
      names.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>());
    const inBackup = count(b.sessionNames);
    const inNow = count(now);
    const gone: string[] = [];
    const added: string[] = [];
    for (const [n, c] of inBackup) for (let i = 0; i < c - (inNow.get(n) ?? 0); i++) gone.push(n);
    for (const [n, c] of inNow) for (let i = 0; i < c - (inBackup.get(n) ?? 0); i++) added.push(n);
    return { gone, added };
  }

  function backupRow(b: BackupInfo): HTMLElement {
    const row = document.createElement("div");
    row.className = "backup-row";
    row.classList.toggle("ai-pick", aiPick?.filename === b.filename);
    if (!b.valid) row.classList.add("invalid");

    const head = document.createElement("div");
    head.className = "backup-head";

    const when = document.createElement("span");
    when.className = "backup-when";
    when.textContent = relTime(b.createdAt);
    when.title = b.filename;

    const meta = document.createElement("span");
    meta.className = "backup-meta";
    const sizeKb = Math.max(1, Math.round(b.sizeBytes / 1024));
    meta.textContent = b.valid
      ? `${exactTime(b.createdAt)} · ${kindLabel(b)} · ${b.sessionNames.length} session${
          b.sessionNames.length === 1 ? "" : "s"
        }, ${b.paneCount} pane${b.paneCount === 1 ? "" : "s"} · ${sizeKb} KB`
      : `${exactTime(b.createdAt)} · ${kindLabel(b)} · unreadable`;

    const names = document.createElement("span");
    names.className = "backup-names";
    names.textContent = b.sessionNames.join(" · ") || "—";
    names.title = names.textContent;

    const actions = document.createElement("div");
    actions.className = "backup-actions";
    const previewBtn = btn("btn-ghost", expanded === b.filename ? "Hide" : "Preview", () => {
      expanded = expanded === b.filename ? null : b.filename;
      renderBackups();
    });
    const restoreBtn = btn("btn-secondary", "Restore");
    restoreBtn.disabled = !b.valid;
    restoreBtn.addEventListener("click", () => {
      restoreBtn.disabled = true;
      void handlers.onRestoreBackup(b).then((ok) => {
        // On success the app reloads, so only a cancelled restore comes back.
        if (!ok) restoreBtn.disabled = false;
      });
    });
    actions.append(previewBtn, restoreBtn);

    head.append(when, meta, names, actions);
    row.appendChild(head);

    if (expanded === b.filename) {
      const { gone, added } = diffSessions(b);
      const detail = document.createElement("div");
      detail.className = "backup-detail";
      const line = (cls: string, label: string, items: string[]) => {
        const p = document.createElement("p");
        p.className = `backup-diff ${cls}`;
        p.textContent = `${label} ${items.join(", ")}`;
        return p;
      };
      if (gone.length) detail.appendChild(line("gone", "Restores (not open now):", gone));
      if (added.length) detail.appendChild(line("added", "Would disappear (opened since):", added));
      if (!gone.length && !added.length) {
        const p = document.createElement("p");
        p.className = "backup-diff same";
        p.textContent = "Same sessions as right now — only layout, tasks and settings may differ.";
        detail.appendChild(p);
      }
      const full = document.createElement("p");
      full.className = "backup-diff all";
      full.textContent = `Contains: ${b.sessionNames.join(", ") || "no sessions"}`;
      detail.appendChild(full);
      row.appendChild(detail);
    }
    return row;
  }

  function renderBackups(): void {
    backupList.replaceChildren();

    if (aiPick) {
      const banner = document.createElement("div");
      banner.className = "backup-ai-result";
      const found = aiPick.filename ? backups.find((b) => b.filename === aiPick!.filename) : undefined;
      banner.textContent = found
        ? `Best match: ${relTime(found.createdAt)} (${exactTime(found.createdAt)}) — confidence ${aiPick.confidence}. ${aiPick.reason}`
        : `No backup looks like a match. ${aiPick.reason}`;
      backupList.appendChild(banner);
    }

    const q = backupSearch.value.trim().toLowerCase();
    const rows = backups.filter((b) => {
      if (!q) return true;
      const hay = [b.filename, kindLabel(b), relTime(b.createdAt), exactTime(b.createdAt), ...b.sessionNames]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    // AI's pick (and its runners-up) float to the top so the answer is visible
    // without hunting through 37 rows.
    if (aiPick) {
      const rank = (b: BackupInfo) =>
        b.filename === aiPick!.filename ? 0 : aiPick!.runnersUp.includes(b.filename) ? 1 : 2;
      rows.sort((a, b) => rank(a) - rank(b));
    }

    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "backup-empty";
      empty.textContent = backupsLoaded
        ? q
          ? "No backup matches that search."
          : "No backups yet — they appear as you use the app."
        : "…";
      backupList.appendChild(empty);
      return;
    }
    for (const b of rows) backupList.appendChild(backupRow(b));
  }

  function parseAiJson(raw: string): AiPick {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const filename = typeof obj.bestBackup === "string" ? obj.bestBackup : null;
    return {
      // Guard against a hallucinated name: only accept one we actually sent.
      filename: filename && backups.some((b) => b.filename === filename) ? filename : null,
      confidence: typeof obj.confidence === "string" ? obj.confidence : "low",
      reason: typeof obj.reason === "string" ? obj.reason : "",
      runnersUp: Array.isArray(obj.runnersUp)
        ? obj.runnersUp.filter((f): f is string => typeof f === "string")
        : [],
    };
  }

  async function runAiFinder(): Promise<void> {
    const key = draft.openrouterApiKey.trim();
    const q = aiQuery.value.trim();
    if (!key || !q) return;
    aiGoBtn.disabled = true;
    aiStatus.textContent = "Searching your backups…";
    try {
      // Metadata only — timestamps and session names. No terminal content and
      // no file bodies ever leave the machine.
      const candidates = JSON.stringify(
        backups
          .filter((b) => b.valid)
          .map((b) => ({
            filename: b.filename,
            time: new Date(b.createdAt).toISOString(),
            sessions: b.sessionNames,
          }))
      );
      const raw = await invoke<string>("find_in_backups", { apiKey: key, query: q, candidates });
      aiPick = parseAiJson(raw);
      aiStatus.textContent = aiPick.filename
        ? "Top result is highlighted below."
        : "Nothing matched — the full list is below.";
    } catch (e) {
      aiPick = null;
      aiStatus.textContent = `Search failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      aiGoBtn.disabled = false;
      renderBackups();
    }
  }

  function buildBackupsSection(): HTMLElement {
    backupSearch.type = "search";
    backupSearch.placeholder = "Filter by session name or time…";
    backupSearch.className = "backup-search";
    backupSearch.addEventListener("input", renderBackups);

    const refreshBtn = btn("btn-ghost", "Refresh", () => void loadBackups());

    aiBtn.type = "button";
    aiBtn.className = "btn-ghost";
    aiBtn.textContent = "Find with AI";
    aiBtn.addEventListener("click", () => {
      aiRow.classList.toggle("open");
      if (aiRow.classList.contains("open")) aiQuery.focus();
    });

    backupStatus.className = "field-hint";

    const toolbar = document.createElement("div");
    toolbar.className = "backup-toolbar";
    toolbar.append(backupSearch, refreshBtn, aiBtn, backupStatus);

    aiQuery.type = "text";
    aiQuery.placeholder = "What are you looking for? e.g. “the OpenTerm session”";
    aiQuery.className = "backup-ai-query";
    aiQuery.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void runAiFinder();
    });
    aiGoBtn.type = "button";
    aiGoBtn.className = "btn-secondary";
    aiGoBtn.textContent = "Search";
    aiGoBtn.addEventListener("click", () => void runAiFinder());
    aiStatus.className = "field-hint backup-ai-status";
    aiRow.className = "backup-ai-row";
    aiRow.append(aiQuery, aiGoBtn, aiStatus);

    backupList.className = "backup-list";

    return section(
      "Backups",
      "Your last 30 changes plus one snapshot per day. Restoring saves a safety copy of the current state first, so a restore can itself be undone.",
      [toolbar, aiRow, backupList],
      { keywords: "backup restore snapshot history undo recover" }
    );
  }

  // ------------------------------------------------------- archived sessions
  function archivedRow(a: Session): HTMLElement {
    const row = document.createElement("div");
    row.className = "backup-row archived-row";
    row.dataset.search = `${a.name} ${a.cwd ?? ""}`.toLowerCase();

    const head = document.createElement("div");
    head.className = "backup-head";

    const name = document.createElement("span");
    name.className = "backup-when archived-name";
    const dot = document.createElement("span");
    dot.className = "archived-dot";
    dot.style.background = a.color;
    const label = document.createElement("span");
    label.textContent = a.name;
    name.append(dot, label);

    const paneCount = collectLeaves(a.tree).length;
    const openTasks = openTaskCount(a);
    const meta = document.createElement("span");
    meta.className = "backup-meta";
    meta.textContent = [
      a.archivedAt ? `archived ${relTime(a.archivedAt)}` : "archived",
      `${paneCount} pane${paneCount === 1 ? "" : "s"}`,
      openTasks ? `${openTasks} open task${openTasks === 1 ? "" : "s"}` : "",
      a.cwd ?? "",
    ]
      .filter(Boolean)
      .join(" · ");
    meta.title = meta.textContent;

    const actions = document.createElement("div");
    actions.className = "backup-actions";
    const restoreBtn = btn("btn-secondary", "Restore", () => {
      handlers.onRestoreArchived(a.id);
      render();
    });
    const deleteBtn = btn("btn-ghost", "Delete", () => {
      void handlers.onDeleteArchived(a.id).then(render);
    });
    actions.append(restoreBtn, deleteBtn);

    head.append(name, meta, actions);
    row.appendChild(head);
    return row;
  }

  // After the elements it wires up — this runs at construction time, so the
  // consts above must already exist.
  const backupsSection = buildBackupsSection();

  // ---------------------------------------------------------------- render
  function render(): void {
    const s = draft;
    const cats: Record<CatId, HTMLElement[]> = {
      appearance: [],
      terminal: [],
      ai: [],
      dictation: [],
      notifications: [],
      keyboard: [],
      sessions: [],
      about: [],
    };

    // ==================== Appearance ====================
    const themeGrid = document.createElement("div");
    themeGrid.className = "theme-picker";
    const categories: Theme["category"][] = ["Minimal", "Classic", "Wild"];
    for (const category of categories) {
      const group = document.createElement("div");
      group.className = "theme-group";
      const groupLabel = document.createElement("h3");
      groupLabel.className = "theme-group-label";
      groupLabel.textContent = category;
      const cards = document.createElement("div");
      cards.className = "theme-cards";
      for (const theme of THEMES.filter((t) => t.category === category)) cards.appendChild(themeCard(theme));
      group.append(groupLabel, cards);
      themeGrid.appendChild(group);
    }
    themeGrid.dataset.search = ["theme color dark light", ...THEMES.map((t) => t.name)].join(" ").toLowerCase();
    cats.appearance.push(
      section("Theme", "Colors for the whole app.", [themeGrid], { keywords: "theme colors palette dark light" })
    );

    // Live preview of the terminal text settings, drawn in the selected theme.
    const theme = THEMES.find((t) => t.id === s.theme) ?? THEMES[0];
    const preview = document.createElement("div");
    preview.className = "term-preview";
    preview.setAttribute("aria-hidden", "true");
    preview.style.setProperty("--pv-bg", theme.vars["--bg-pane"]);
    preview.style.setProperty("--pv-text", theme.vars["--text"]);
    preview.style.setProperty("--pv-dim", theme.vars["--text-dim"]);
    preview.style.setProperty("--pv-accent", theme.vars["--accent"]);
    preview.style.setProperty("--pv-border", theme.vars["--border"]);
    preview.innerHTML =
      `<div><span class="pv-prompt">PS C:\\dev\\openterm&gt;</span> git status</div>` +
      `<div class="pv-dim">On branch main — nothing to commit, working tree clean</div>` +
      `<div><span class="pv-prompt">PS C:\\dev\\openterm&gt;</span> <span class="pv-cursor"></span></div>`;
    const paintPreview = () => {
      preview.style.fontFamily = s.fontFamily;
      preview.style.fontSize = `${s.fontSize}px`;
      preview.style.padding = `${s.padding}px`;
      preview.querySelector<HTMLElement>(".pv-cursor")!.className =
        `pv-cursor ${s.cursorStyle}${s.cursorBlink ? " blink" : ""}`;
    };
    paintPreview();

    const fontSize = range(s.fontSize, 9, 24, (v) => {
      s.fontSize = v;
      paintPreview();
      markDirty();
    });

    const fontFamily = document.createElement("input");
    fontFamily.type = "text";
    fontFamily.value = s.fontFamily;
    fontFamily.spellcheck = false;
    const fontList = document.createElement("datalist");
    fontList.id = "settings-font-stacks";
    for (const f of [
      '"Cascadia Mono", Consolas, monospace',
      '"Cascadia Code", Consolas, monospace',
      '"JetBrains Mono", Consolas, monospace',
      '"Fira Code", Consolas, monospace',
      "Consolas, monospace",
      '"Courier New", monospace',
    ]) {
      const o = document.createElement("option");
      o.value = f;
      fontList.appendChild(o);
    }
    fontFamily.setAttribute("list", fontList.id);
    fontFamily.addEventListener("input", () => {
      s.fontFamily = fontFamily.value.trim() || '"Cascadia Mono", Consolas, monospace';
      paintPreview();
      markDirty();
    });
    const fontWrap = document.createElement("div");
    fontWrap.className = "control-wide";
    fontWrap.append(fontFamily, fontList);

    const cursorStyle = segmented(
      [
        { value: "bar", label: "Bar" },
        { value: "block", label: "Block" },
        { value: "underline", label: "Underline" },
      ],
      s.cursorStyle,
      (v) => {
        s.cursorStyle = v;
        paintPreview();
        markDirty();
      }
    );

    const cursorBlink = toggle(s.cursorBlink, (v) => {
      s.cursorBlink = v;
      paintPreview();
      markDirty();
    });

    const padding = range(s.padding, 0, 24, (v) => {
      s.padding = v;
      paintPreview();
      markDirty();
    });

    const editorFontSize = range(s.editorFontSize, 9, 28, (v) => {
      s.editorFontSize = v;
      markDirty();
    });

    cats.appearance.push(
      section(
        "Terminal text",
        "Font, cursor and spacing inside every pane.",
        [
          preview,
          field("Font size", fontSize, { keywords: "text zoom" }),
          field("Font family", fontWrap, { desc: "Any installed monospace font stack.", keywords: "typeface" }),
          field("Cursor style", cursorStyle, { keywords: "caret" }),
          field("Blinking cursor", cursorBlink, { keywords: "caret blink" }),
          field("Pane padding", padding, { desc: "Space between a pane's edge and its text.", keywords: "spacing margin" }),
        ],
        { keywords: "font cursor appearance" }
      )
    );

    cats.appearance.push(
      section(
        "Editor text",
        "Text size inside the file editor — code, Markdown preview and WYSIWYG.",
        [
          field("Editor text size", editorFontSize, {
            desc: "Ctrl+= and Ctrl+− change this while a file is in front of you.",
            keywords: "file editor font zoom code markdown",
          }),
        ],
        { keywords: "editor file font zoom" }
      )
    );

    // ==================== Terminal ====================
    const SHELL_PRESETS: { label: string; value: string }[] = [
      { label: "Windows PowerShell", value: "powershell.exe" },
      { label: "PowerShell 7", value: "pwsh.exe" },
      { label: "Command Prompt", value: "cmd.exe" },
      { label: "Git Bash", value: "C:\\Program Files\\Git\\bin\\bash.exe" },
    ];
    const CUSTOM_SHELL = "__custom__";

    const shellPreset = document.createElement("select");
    for (const { label, value } of SHELL_PRESETS) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      shellPreset.appendChild(o);
    }
    const customOpt = document.createElement("option");
    customOpt.value = CUSTOM_SHELL;
    customOpt.textContent = "Custom…";
    shellPreset.appendChild(customOpt);

    const shellCustom = document.createElement("input");
    shellCustom.type = "text";
    shellCustom.placeholder = "Path to shell executable";
    shellCustom.spellcheck = false;

    const isPreset = SHELL_PRESETS.some((p) => p.value === s.shell);
    shellPreset.value = isPreset ? s.shell : CUSTOM_SHELL;
    shellCustom.value = s.shell;
    shellCustom.hidden = isPreset;

    shellPreset.addEventListener("change", () => {
      if (shellPreset.value === CUSTOM_SHELL) {
        shellCustom.hidden = false;
        shellCustom.focus();
      } else {
        shellCustom.hidden = true;
        s.shell = shellPreset.value;
        markDirty();
      }
    });
    shellCustom.addEventListener("input", () => {
      s.shell = shellCustom.value.trim() || "powershell.exe";
      markDirty();
    });

    const shellWrap = document.createElement("div");
    shellWrap.className = "shell-select-wrap";
    shellWrap.append(shellPreset, shellCustom);

    const scrollback = document.createElement("input");
    scrollback.type = "number";
    scrollback.min = "500";
    scrollback.max = "100000";
    scrollback.step = "500";
    scrollback.value = String(s.scrollback);
    scrollback.addEventListener("change", () => {
      s.scrollback = Math.max(500, Math.min(100000, Number(scrollback.value) || 8000));
      scrollback.value = String(s.scrollback);
      markDirty();
    });
    const scrollWrap = document.createElement("div");
    scrollWrap.className = "input-suffix";
    const scrollUnit = document.createElement("span");
    scrollUnit.textContent = "lines";
    scrollWrap.append(scrollback, scrollUnit);

    cats.terminal.push(
      section(
        "Shell",
        null,
        [
          field("Default shell", shellWrap, {
            desc: "What new terminals run. Existing terminals keep their shell.",
            keywords: "powershell cmd bash pwsh",
          }),
          field("Scrollback", scrollWrap, { desc: "How much history each pane keeps (500–100,000).", keywords: "history buffer lines" }),
        ],
        { keywords: "shell" }
      )
    );

    const externalTerminalDrag = toggle(s.externalTerminalDrag, (v) => {
      s.externalTerminalDrag = v;
      markDirty();
    });
    const shellIntegration = toggle(s.shellIntegration, (v) => {
      s.shellIntegration = v;
      markDirty();
    });

    cats.terminal.push(
      section(
        "Windows integration",
        null,
        [
          field("Open folders in OpenTerm", shellIntegration, {
            desc: "Adds OpenTerm to Explorer's address bar and folder right-click menu.",
            tip:
              "Type “OpenTerm” in any folder's address bar (or right-click a folder → " +
              "Open in OpenTerm) to get a session rooted there. If OpenTerm is already " +
              "running it reuses that window, and a folder that already has a session " +
              "just brings it forward. Registers under your own user account only.",
            keywords: "explorer context menu shell integration",
          }),
          field("Drag in external terminals", externalTerminalDrag, {
            desc: "Drag terminal windows opened outside OpenTerm straight into a pane.",
            keywords: "window dock",
          }),
        ],
        { keywords: "windows explorer" }
      )
    );

    // ==================== AI & Agents ====================
    const resumeAgents = toggle(s.resumeAgentSessions, (v) => {
      s.resumeAgentSessions = v;
      markDirty();
      render(); // refresh the explanation for the new state
    });

    cats.ai.push(
      section(
        "Agent conversations",
        null,
        [
          field("Resume conversations on restart", resumeAgents, {
            desc: s.resumeAgentSessions
              ? "Each pane reopens the exact conversation it was running."
              : "Agent CLIs start a brand-new conversation when the app reopens.",
            tip: s.resumeAgentSessions
              ? "Each pane reopens the specific conversation it was running, by session id " +
                "(`claude --resume <id>`), so panes that ran different chats each get their own back. " +
                "Panes with no recorded session fall back to `--continue`."
              : "A pane that last ran `claude` relaunches as plain `claude`, starting a brand-new " +
                "conversation with no memory of the previous one. Your old sessions aren't deleted — just not reopened.",
            keywords: "claude codex resume continue session",
          }),
        ],
        { keywords: "agent" }
      )
    );

    const openrouterKey = document.createElement("input");
    openrouterKey.type = "password";
    openrouterKey.placeholder = "sk-or-…";
    openrouterKey.value = s.openrouterApiKey;
    openrouterKey.autocomplete = "off";
    openrouterKey.spellcheck = false;
    // `input`, not `change`: a key typed and left unfocused (or saved via the
    // keyboard) used to be dropped because `change` only fires on blur.
    openrouterKey.addEventListener("input", () => {
      s.openrouterApiKey = openrouterKey.value.trim();
      markDirty();
    });

    // Round-trips the key that's currently in the box (not the saved one) through
    // the same command delegation uses, and prints whatever comes back verbatim.
    // Without this the only signal a bad key gives is a silently un-refined prompt.
    const testStatus = document.createElement("span");
    testStatus.className = "field-hint";
    const revealBtn = btn("btn-ghost", "Show", () => {
      const show = openrouterKey.type === "password";
      openrouterKey.type = show ? "text" : "password";
      revealBtn.textContent = show ? "Hide" : "Show";
    });
    const testBtn = btn("btn-secondary", "Test key", () => {
      const key = openrouterKey.value.trim();
      testStatus.className = "field-hint";
      if (!key) {
        testStatus.textContent = "Enter a key first.";
        return;
      }
      testBtn.disabled = true;
      testStatus.textContent = "Contacting OpenRouter…";
      invoke<string>("enhance_prompt", { apiKey: key, prompt: "Say OK." })
        .then(() => {
          testStatus.textContent = "✓ Key works";
          testStatus.classList.add("ok");
        })
        .catch((e: unknown) => {
          testStatus.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
          testStatus.classList.add("bad");
        })
        .finally(() => {
          testBtn.disabled = false;
        });
    });
    const keyInputRow = document.createElement("div");
    keyInputRow.className = "key-input-row";
    keyInputRow.append(openrouterKey, revealBtn, testBtn);
    const keyWrap = document.createElement("div");
    keyWrap.className = "control-stack";
    keyWrap.append(keyInputRow, testStatus);

    const hasKey = !!s.openrouterApiKey.trim();
    const aiInbox = toggle(s.aiInboxSummaries, (v) => {
      s.aiInboxSummaries = v;
      markDirty();
    });

    cats.ai.push(
      section(
        "OpenRouter",
        "Optional. Powers prompt refinement before delegating tasks, AI-named inbox items and AI backup search.",
        [
          field("API key", keyWrap, {
            stack: true,
            tip:
              "Used to have an AI clarify a task's prompt before it's delegated to an agent. " +
              "Without a key, tasks are delegated exactly as written.",
            keywords: "openrouter token secret llm",
          }),
          field("Name inbox notifications with AI", aiInbox, {
            desc: hasKey
              ? "Approval prompts and errors get a short name and description. The original text stays on hover."
              : "Needs an API key — without one, notifications show the raw terminal text.",
            keywords: "summaries summary inbox",
          }),
        ],
        { keywords: "openrouter ai api key" }
      )
    );

    cats.ai.push(harnessSection);

    // ==================== Dictation ====================
    cats.dictation.push(dictationTab.render());

    // ==================== Notifications ====================
    const soundNotifications = toggle(s.soundNotifications, (v) => {
      s.soundNotifications = v;
      markDirty();
      render(); // enable/disable the sound picker
    });

    const soundPathWrap = document.createElement("div");
    soundPathWrap.className = "path-wrap";
    const soundPathLabel = document.createElement("span");
    soundPathLabel.className = "sound-path-label";
    soundPathLabel.textContent = s.soundPath ? s.soundPath.split(/[\\/]/).pop()! : "Default chime";
    soundPathLabel.title = s.soundPath ?? "Default chime";
    const soundBrowseBtn = btn("btn-secondary", "Choose…", async () => {
      const file = await openFileDialog({
        title: "Custom attention sound",
        filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "flac"] }],
      });
      if (typeof file === "string") {
        s.soundPath = file;
        markDirty();
        render();
      }
    });
    const soundResetBtn = btn("btn-ghost", "Use default", () => {
      s.soundPath = null;
      markDirty();
      render();
    });
    soundResetBtn.hidden = !s.soundPath;
    const soundTestBtn = btn("btn-ghost", "▶ Play", () => {
      void invoke("play_attention_sound", { path: s.soundPath });
    });
    soundPathWrap.append(soundPathLabel, soundBrowseBtn, soundResetBtn, soundTestBtn);

    const soundField = field("Sound", soundPathWrap, {
      desc: "Pick your own audio file, or keep the built-in chime.",
      keywords: "custom audio chime wav mp3",
    });
    soundField.classList.toggle("is-disabled", !s.soundNotifications);

    const taskbarFlash = toggle(s.taskbarFlash, (v) => {
      s.taskbarFlash = v;
      markDirty();
    });

    cats.notifications.push(
      section(
        "Attention alerts",
        "What happens when a terminal is waiting on your input.",
        [
          field("Play a sound", soundNotifications, { keywords: "audio chime alert" }),
          soundField,
          field("Flash taskbar icon", taskbarFlash, { keywords: "taskbar blink" }),
        ],
        { keywords: "attention alert" }
      )
    );

    const kinds = Object.keys(KIND_TITLE) as InboxKind[];
    const kindList = document.createElement("div");
    kindList.className = "notif-kind-list";
    for (const kind of kinds) {
      const row = document.createElement("label");
      row.className = "notif-kind-row";
      row.dataset.search = `${KIND_TITLE[kind]} ${KIND_HINT[kind]}`.toLowerCase();
      const info = document.createElement("span");
      info.className = "notif-kind-info";
      const title = document.createElement("span");
      title.className = "notif-kind-title";
      title.textContent = KIND_TITLE[kind];
      const hint = document.createElement("span");
      hint.className = "notif-kind-hint";
      hint.textContent = KIND_HINT[kind];
      hint.title = KIND_HINT[kind];
      info.append(title, hint);
      const cb = toggle(s.inboxNotifications[kind] !== false, (v) => {
        s.inboxNotifications[kind] = v;
        markDirty();
      });
      row.append(info, cb);
      kindList.appendChild(row);
    }

    const setAllKinds = (on: boolean) => {
      for (const kind of kinds) s.inboxNotifications[kind] = on;
      markDirty();
      render();
    };

    cats.notifications.push(
      section(
        "Inbox",
        "Choose which events land in the inbox. Turning one off skips it entirely — no item, no sound, no taskbar flash.",
        [kindList],
        {
          keywords: "inbox notification events",
          actions: [btn("btn-ghost", "All on", () => setAllKinds(true)), btn("btn-ghost", "All off", () => setAllKinds(false))],
        }
      )
    );

    // ==================== Keyboard ====================
    const table = document.createElement("div");
    table.className = "keybind-table";
    for (const [action, label] of Object.entries(ACTIONS) as [Action, string][]) {
      const row = document.createElement("div");
      row.className = "keybind-row";
      row.dataset.search = `${label} ${prettyChord(s.keybinds[action])}`.toLowerCase();
      const name = document.createElement("span");
      name.textContent = label;
      const kb = document.createElement("button");
      kb.type = "button";
      kb.className = "keybind-btn";
      const chord = prettyChord(s.keybinds[action]);
      kb.textContent = chord || "Not set";
      kb.classList.toggle("unset", !chord);
      kb.addEventListener("click", () => {
        if (recorder.active) return;
        recorder.active = true;
        kb.textContent = "Press keys…";
        kb.classList.add("recording");
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") {
            done();
            return;
          }
          const chord = chordFromEvent(e);
          if (!chord) return; // modifier only — keep listening
          // steal the chord from any other action
          for (const a of Object.keys(s.keybinds) as Action[]) {
            if (a !== action && s.keybinds[a] === chord) s.keybinds[a] = "";
          }
          s.keybinds[action] = chord;
          markDirty();
          done();
        };
        const done = () => {
          window.removeEventListener("keydown", onKey, true);
          recorder.active = false;
          recorder.stop = null;
          render();
        };
        recorder.stop = () => {
          window.removeEventListener("keydown", onKey, true);
          recorder.active = false;
          recorder.stop = null;
        };
        window.addEventListener("keydown", onKey, true);
      });
      row.append(name, kb);
      table.appendChild(row);
    }

    const resetBinds = btn("btn-ghost", "Reset to defaults", () => {
      s.keybinds = { ...DEFAULT_KEYBINDS };
      markDirty();
      render();
    });

    cats.keyboard.push(
      section(
        "Shortcuts",
        "Click a shortcut, then press the new key combination. Esc cancels. A combination already in use moves to the new action.",
        [table],
        { keywords: "keybinds hotkeys shortcuts keyboard", actions: [resetBinds] }
      )
    );

    // ==================== Sessions & Backups ====================
    // Acts immediately — this is session data, not a setting, so it doesn't
    // go through the Save draft.
    const archived = store.state.sessions.filter((x) => x.archived);
    setBadge("sessions", archived.length ? String(archived.length) : null);
    let archivedBody: HTMLElement;
    if (archived.length) {
      archivedBody = document.createElement("div");
      archivedBody.className = "archived-list";
      for (const a of archived) archivedBody.appendChild(archivedRow(a));
    } else {
      archivedBody = document.createElement("p");
      archivedBody.className = "settings-empty-note";
      archivedBody.textContent = "Nothing archived right now.";
    }
    cats.sessions.push(
      section(
        "Archived sessions",
        "Hidden from the sidebar with their terminals stopped. Restoring brings back the layout, tasks and folder, and relaunches any agent CLIs. Takes effect right away.",
        [archivedBody],
        { keywords: "archive archived hidden restore" }
      )
    );

    // The AI finder is gated on a key exactly like the other OpenRouter
    // features: visible, disabled, and saying why.
    aiBtn.disabled = !hasKey;
    aiBtn.title = hasKey
      ? "Describe what you lost and let AI pick the backup"
      : "Add an OpenRouter API key under AI & Agents to search backups by description";
    if (!hasKey) aiRow.classList.remove("open");
    cats.sessions.push(backupsSection);

    // ==================== About & Data ====================
    cats.about.push(updatesSection);

    const pathEl = document.createElement("code");
    pathEl.className = "state-path";
    pathEl.textContent = "…";
    void invoke<string>("state_file_path").then((p) => (pathEl.textContent = p));
    const copyBtn = btn("btn-ghost", "Copy", () => {
      void navigator.clipboard.writeText(pathEl.textContent ?? "").then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
      });
    });
    const pathWrap = document.createElement("div");
    pathWrap.className = "path-copy";
    pathWrap.append(pathEl, copyBtn);

    const replayBtn = btn("btn-secondary", "Replay welcome", () => handlers.onReplayWelcome());

    cats.about.push(
      section(
        "Data",
        null,
        [
          field("State file", pathWrap, { stack: true, keywords: "path json location storage" }),
          field("Welcome", replayBtn, {
            desc: "Walk through the first-run setup again: theme, terminal text size and the short tour.",
            keywords: "onboarding welcome tour intro first run getting started",
          }),
        ],
        { keywords: "data state storage onboarding welcome" }
      )
    );

    const resetData = btn("btn-danger", "Reset all data");
    let armed = false;
    resetData.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        resetData.textContent = "Click again to confirm";
        setTimeout(() => {
          armed = false;
          resetData.textContent = "Reset all data";
        }, 3000);
        return;
      }
      handlers.onResetData();
    });
    cats.about.push(
      section(
        "Danger zone",
        null,
        [
          field("Reset all data", resetData, {
            desc: "Deletes every session, task and setting. This can't be undone.",
            keywords: "wipe delete factory",
          }),
        ],
        { className: "danger", keywords: "danger reset" }
      )
    );

    // ==================== assemble ====================
    content.replaceChildren(
      ...CATEGORIES.map((cat) => {
        const wrap = document.createElement("div");
        wrap.className = "settings-cat";
        wrap.dataset.cat = cat.id;
        const head = document.createElement("header");
        head.className = "settings-cat-head";
        const h1 = document.createElement("h1");
        h1.textContent = cat.label;
        const p = document.createElement("p");
        p.textContent = cat.desc;
        head.append(h1, p);
        wrap.append(head, ...cats[cat.id]);
        return wrap;
      }),
      emptyEl
    );

    applyFilter();
    updateSaveState();
  }

  render();
  return {
    el,
    render,
    reset,
    /** Jump straight to one category (e.g. from the dictation tray menu). */
    openCategory: (id: CatId) => selectCategory(id),
  };
}
