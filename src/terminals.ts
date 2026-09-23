import { Terminal } from "@xterm/xterm";
import { fitTerminalToViewport, syncTerminalViewport } from "./terminalViewport";
import { copyText, pasteText } from "./clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { killPty, resizePty, spawnPty, writePty } from "./pty";
import { clearPaneAttention, forgetPane, onAttentionChange } from "./attention";
import {
  clearQueue,
  forgetPane as forgetPaneQueue,
  getQueue,
  learnPromptSigil,
  onQueueChange,
  type PromptContext,
  registerReadySource,
  removeQueuedCommand,
  runNextNow,
} from "./commandQueue";
import { prettyChord } from "./keybinds";
import { ACTIONS, type Action, type Dir, type Settings } from "./types";
import { getTermTheme } from "./themes";
import { createPaneUsagePill, type AgentHarness, type PaneUsagePill } from "./usageLimits";
import {
  markLabel,
  markSvg,
  shellBrand,
  type AgentBrand,
  type PaneBrand,
  type ShellBrand,
} from "./paneIcons";

/** The web-links addon's own default action, restated here because passing a
 *  handler (to catch Alt+click) replaces it: open the URL in a new window with
 *  the opener link severed. Exported so anything else that has to leave the app
 *  (the welcome's documentation link) hands off the same way. */
export function openExternalUrl(uri: string): void {
  const win = window.open();
  if (!win) return;
  try {
    win.opener = null;
  } catch {
    /* already detached */
  }
  win.location.href = uri;
}

/** Leading decorative glyphs in a reported terminal title — Claude Code's "✳",
 *  and the emoji other CLIs like to prefix. The pane now draws a real brand mark
 *  in its own slot, so the title repeating one just reads as two icons.
 *
 *  Matches only pictographs and "other symbols", never ASCII punctuation: plenty
 *  of legitimate titles open with `~/…`, `>`, `$` or a drive letter, and those
 *  have to survive untouched. */
// The trailing class is variation selectors (Mn) and joiners (Cf), so a
// multi-codepoint emoji is consumed whole instead of leaving its joiners behind.
const LEADING_GLYPHS = /^(?:[\p{Extended_Pictographic}\p{So}][\p{Mn}\p{Cf}]*\s*)+/u;

function stripLeadingGlyphs(title: string): string {
  const stripped = title.replace(LEADING_GLYPHS, "").trim();
  // A title that was *only* a glyph keeps it — better a symbol than a blank bar.
  return stripped || title.trim();
}

const MAX_TITLE_LEN = 40;

/** Turns a reported terminal title into a short, representative pane name.
 *  PowerShell titles the window with the full running command line — e.g.
 *  `npm list @tauri-apps/api @tauri-apps/plugin-fs …` — which is useless as a
 *  label. Command lines are condensed to the program plus its subcommand words
 *  (`npm list`), executable paths to their bare name, and anything still long
 *  is cut at a word boundary. Natural-language titles (Claude Code's task
 *  summaries) only ever hit the length cap. */
function representativeTitle(title: string): string {
  const trimmed = title.trim();
  // A quoted program path may contain spaces (`"C:\Program Files\…\node.exe" x`).
  const quoted = /^"([^"]*)"\s*(.*)$/.exec(trimmed);
  let tokens = quoted
    ? [quoted[1], ...quoted[2].split(/\s+/)].filter(Boolean)
    : trimmed.split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  // `C:\…\pwsh.exe -NoLogo` / `/usr/bin/node x` → `pwsh -NoLogo` / `node x`
  const first = tokens[0];
  if (/[\\/]/.test(first)) {
    const base = first.split(/[\\/]/).filter(Boolean).pop() ?? first;
    tokens[0] = base.replace(/\.(exe|cmd|bat|ps1|com)$/i, "");
  }
  // Looks like a command line if any later token is a flag, scoped package,
  // path, URL or key=value — plain prose never contains those.
  const isArgy = (t: string) => /^[-@]|[\\/=]|^\w+:\/\//.test(t);
  if (tokens.length > 1 && tokens.slice(1).some(isArgy)) {
    const kept = [tokens[0]];
    for (const t of tokens.slice(1)) {
      if (kept.length >= 3 || !/^[a-z][\w:.-]*$/i.test(t)) break;
      kept.push(t);
    }
    tokens = kept;
  }
  const joined = tokens.join(" ");
  if (joined.length <= MAX_TITLE_LEN) return joined;
  const cut = joined.slice(0, MAX_TITLE_LEN);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_TITLE_LEN / 2 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

export interface PaneHandlers {
  onFocus(id: string): void;
  /** `duplicate` (Alt held): open the new pane in this pane's current folder
   *  and relaunch the same agent CLI in it, as a new conversation. */
  onSplit(id: string, dir: Dir, duplicate?: boolean): void;
  onClose(id: string): void;
  onMove(srcId: string, targetId: string, region: DropRegion): void;
  /** Alt+drag of one pane onto another: hand the source terminal's recent output
   *  to the target as context (typically an AI agent CLI running there). */
  onSendContext(srcId: string, targetId: string): void;
  onToggleZoom(id: string): void;
  /** Collapse the pane to its title bar (or restore it) — see LeafNode.folded. */
  onToggleFold(id: string): void;
  onCommandEntered(id: string, line: string): void;
  onShowUsage(id: string, title: string): void;
  onQueueCommand(id: string, command: string): void;
  /** User renamed the pane from its right-click menu. `name` is empty to clear
   *  a custom name and fall back to the shell-reported title. */
  onRename(id: string, name: string): void;
  /** Alt+click on a link in the terminal output: show the URL in an embedded
   *  browser pane rather than handing it to the OS browser. */
  onOpenBrowser(id: string, url: string): void;
  /** The shell reported a new working directory (OSC 9;9 or OSC 7). */
  onCwdChange(id: string, cwd: string): void;
}

/** Text out of an OSC 52 payload (`52;<targets>;<base64>`).
 *
 *  OSC 52 is the only way a program running inside a PTY can put something on
 *  the host clipboard, and neither xterm.js nor we implemented it — so a CLI
 *  that copies for you (Claude Code's "copy on select", tmux, nvim's clipboard
 *  provider, ssh sessions) emitted the sequence and we silently swallowed it.
 *
 *  Returns null for anything that isn't a plain write we should honour:
 *   - a `?` payload is a clipboard *read* request. Deliberately unanswered:
 *     replying would let any program that can write to this terminal — a
 *     malicious postinstall script, something piped through `curl | sh` —
 *     exfiltrate whatever the user last copied, passwords included.
 *   - a target other than the clipboard/primary selection (`c`, `p`, `s`, or
 *     the empty default) is a cut-buffer we don't model. */
function parseOsc52(data: string): string | null {
  if (!data.startsWith("52;")) return null;
  const semi = data.indexOf(";", 3);
  if (semi < 0) return null;
  const targets = data.slice(3, semi);
  const payload = data.slice(semi + 1);
  if (payload === "?" || payload === "") return null;
  if (targets && !/^[cps]+$/.test(targets)) return null;
  try {
    // atob gives bytes-as-chars; OSC 52 payloads are UTF-8, so decode them as
    // such or any non-ASCII copied text arrives mojibaked.
    const bytes = Uint8Array.from(atob(payload.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null; // not valid base64 — leave the clipboard alone
  }
}

/** Folder path out of an OSC 9;9 payload (`"C:\path"`, quotes optional). */
function parseOsc99(data: string): string | null {
  if (!data.startsWith("9;")) return null;
  const path = data.slice(2).trim().replace(/^"(.*)"$/, "$1");
  return path || null;
}

/** Folder path out of an OSC 7 payload (`file://host/C:/path` or the MSYS
 *  flavour `file://host/c/path`), as a Windows path. */
function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!m) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const drive = /^\/([A-Za-z]):?(\/.*)?$/.exec(path);
  if (drive) path = `${drive[1].toUpperCase()}:${drive[2] ?? "/"}`;
  return path.replace(/\//g, "\\") || null;
}

export type DropRegion = "n" | "e" | "s" | "w" | "c";

const ICONS = {
  // Cost/усage readout for this pane — a circled "i" reads as "details about
  // this thing" without competing with the layout icons beside it.
  info:
    '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor"/><line x1="7" y1="6.2" x2="7" y2="9.8" stroke="currentColor"/><circle cx="7" cy="4.3" r="0.75" fill="currentColor" stroke="none"/></svg>',
  splitRight:
    '<svg viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="9" rx="1" fill="none" stroke="currentColor"/><line x1="7" y1="2.5" x2="7" y2="11.5" stroke="currentColor"/></svg>',
  splitDown:
    '<svg viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="9" rx="1" fill="none" stroke="currentColor"/><line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor"/></svg>',
  // Maximize / restore. CSS shows one icon based on the pane's `.zoomed` state.
  zoom:
    '<span class="zicon icon-expand"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3 6V3h3M11 8v3H8"/></svg></span>' +
    '<span class="zicon icon-restore"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M6 3v3H3M8 11V8h3"/></svg></span>',
  // Fold / unfold. Like the zoom icon, CSS shows one of the two based on the
  // pane's `.folded` state: a chevron pointing at the bar it collapses into,
  // and one pointing back out again.
  fold:
    '<span class="ficon icon-fold"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3.5 8.5 7 5l3.5 3.5"/></svg></span>' +
    '<span class="ficon icon-unfold"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3.5 5.5 7 9l3.5-3.5"/></svg></span>',
  close:
    '<svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke="currentColor"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke="currentColor"/></svg>',
};

export class PaneTerm {
  readonly id: string;
  readonly el: HTMLElement;
  readonly term: Terminal;
  private fit: FitAddon;
  private search: SearchAddon;
  private titleEl: HTMLElement;
  /** Mark for whatever this pane is running — the agent CLI when there is one,
   *  otherwise the shell underneath it. See renderPaneIcon. */
  private agentIcon: HTMLElement;
  private agentBrand: AgentBrand | null = null;
  /** Set once the PTY is spawned, from the shell it was actually started with;
   *  null before that, which is what keeps a not-yet-spawned pane iconless
   *  instead of briefly guessing. */
  private shellBrand: ShellBrand | null = null;
  /** What the icon currently shows, so an unchanged mark isn't re-rendered
   *  (which would restart its fade-in). */
  private shownBrand: PaneBrand | null = null;
  /** Name of the agent CLI running in this pane, shown in the title bar when
   *  the agent doesn't title the terminal itself. See setAgentLabel. */
  private agentLabel: string | null = null;
  /** Counts titles the terminal has reported; setAgentLabel snapshots it so a
   *  title arriving *after* the agent started is recognised as the agent's own. */
  private titleSeq = 0;
  private agentLabelAtSeq = -1;
  /** Shell/agent-reported title (from onTitleChange), shown whenever there's no
   *  user-set customName overriding it. */
  private liveTitle = "PowerShell";
  /** User-set pane name (see PaneHandlers.onRename); wins over liveTitle when set. */
  private customName: string | null = null;
  private ctxMenu: HTMLElement | null = null;
  private termHost: HTMLElement;
  private searchBar: HTMLElement;
  private searchInput: HTMLInputElement;
  private queueBar: HTMLElement;
  private queueInput: HTMLInputElement;
  private queueList: HTMLOListElement;
  private queueBadge: HTMLButtonElement;
  private usagePill: PaneUsagePill;
  private offQueueChange: () => void;
  private observer: ResizeObserver;
  private fitRaf: number | null = null;
  private fitTimer: number | null = null;
  private ptyResizeTimer: number | null = null;
  /** Size ConPTY was last actually told, so a desync with xterm is detectable
   *  without relying on xterm having emitted a resize event. See syncPtySize. */
  private lastSentCols = -1;
  private lastSentRows = -1;
  /** Timestamp of the last resize actually forwarded to the PTY, used to tell a
   *  lone resize from a burst (see scheduleResizePty). */
  private lastPtyResizeAt = 0;
  private spawned = false;
  private disposed = false;
  /** Fitting is suspended while folded, animating, or without a visible host. */
  private hidden = false;
  /** Raw-keystroke buffer for the line currently being typed, used to detect
   *  when the user launches a known AI agent CLI (see types.ts). */
  private inputLine = "";
  /** Pane action buttons whose tooltip shows the action's live keybind — refreshed
   *  in applySettings() whenever the user rebinds a shortcut. */
  private actionButtons: { el: HTMLButtonElement; action: Action }[] = [];
  /** Highlight-search state: the committed needle (lower-cased; empty when no
   *  preview is up), the match the popup jumped to, and the pooled boxes the
   *  overlay draws with. See renderHighlights(). */
  private hlNeedle = "";
  private hlActive: { row: number; col: number } | null = null;
  private hlLayer: HTMLElement | null = null;
  private hlBoxes: HTMLElement[] = [];

  constructor(id: string, settings: Settings, handlers: PaneHandlers) {
    this.id = id;

    this.el = document.createElement("div");
    this.el.className = "pane";
    this.el.dataset.paneId = id;

    // ---- title bar ----
    const bar = document.createElement("div");
    bar.className = "pane-bar";
    bar.title = "Drag to move · Alt+drag onto another terminal to send it as context · Right-click for actions";

    const attnDot = document.createElement("span");
    attnDot.className = "pane-attn-dot";
    attnDot.title = "Waiting for your input";

    // Sits between the attention dot and the title, so the eye picks up "which
    // agent" before "which directory" when scanning a grid of panes.
    this.agentIcon = document.createElement("span");
    this.agentIcon.className = "pane-agent-icon";

    this.titleEl = document.createElement("span");
    this.titleEl.className = "pane-title";
    this.titleEl.textContent = "PowerShell";

    // Queued-command count. Lives outside .pane-actions so it stays visible
    // even when the pane isn't hovered/focused — a queue you can't see is a
    // queue you forget about.
    this.queueBadge = document.createElement("button");
    this.queueBadge.type = "button";
    this.queueBadge.className = "pane-queue-badge";
    this.queueBadge.addEventListener("mousedown", (e) => e.preventDefault());
    // Left click force-runs the next queued command, so the user is never stuck
    // waiting on prompt detection; right click drops the queue.
    this.queueBadge.addEventListener("click", (e) => {
      e.stopPropagation();
      runNextNow(id);
    });
    this.queueBadge.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearQueue(id);
    });

    const actions = document.createElement("div");
    actions.className = "pane-actions";
    /** `action` is null for buttons with no keybind of their own — those keep a
     *  static tooltip instead of one that tracks the user's shortcuts. */
    const mkBtn = (
      icon: string,
      action: Action | null,
      fn: (e: MouseEvent) => void,
      staticTitle?: string
    ) => {
      const b = document.createElement("button");
      b.className = "pane-btn";
      b.innerHTML = icon;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn(e);
      });
      // Folded panes keep only the actions that still make sense (see styles.css).
      if (action) b.dataset.act = action;
      actions.appendChild(b);
      if (action) this.actionButtons.push({ el: b, action });
      else if (staticTitle) b.title = staticTitle;
    };
    mkBtn(ICONS.splitRight, "splitRight", (e) => handlers.onSplit(id, "row", e.altKey));
    mkBtn(ICONS.splitDown, "splitDown", (e) => handlers.onSplit(id, "col", e.altKey));
    mkBtn(ICONS.fold, "foldPane", () => handlers.onToggleFold(id));
    mkBtn(ICONS.zoom, "zoomPane", () => handlers.onToggleZoom(id));
    mkBtn(ICONS.close, "closePane", () => handlers.onClose(id));
    this.refreshActionTooltips(settings);

    // Double-clicking the bar folds/unfolds — the same gesture window title
    // bars use, and the only one that works on a pane collapsed to a rail.
    bar.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".pane-btn, .pane-queue-badge")) return;
      handlers.onToggleFold(id);
    });

    this.usagePill = createPaneUsagePill();

    bar.append(attnDot, this.agentIcon, this.titleEl, this.usagePill.el, this.queueBadge, actions);

    // ---- right-click menu: Rename / Queue command / Usage & Costs / Close ----
    const ctxMenu = document.createElement("div");
    ctxMenu.className = "context-menu";
    this.ctxMenu = ctxMenu;
    const ctxRename = document.createElement("button");
    ctxRename.className = "context-menu-item";
    ctxRename.textContent = "Rename";
    const ctxQueue = document.createElement("button");
    ctxQueue.className = "context-menu-item";
    ctxQueue.textContent = "Queue command…";
    const ctxUsage = document.createElement("button");
    ctxUsage.className = "context-menu-item";
    ctxUsage.textContent = "Usage & Costs";
    const ctxClose = document.createElement("button");
    ctxClose.className = "context-menu-item danger";
    ctxClose.textContent = "Close";
    ctxMenu.append(ctxRename, ctxQueue, ctxUsage, ctxClose);
    document.body.appendChild(ctxMenu);

    const closeCtxMenu = () => ctxMenu.classList.remove("visible");
    const openCtxMenu = (x: number, y: number) => {
      ctxMenu.style.left = `${x}px`;
      ctxMenu.style.top = `${y}px`;
      ctxMenu.classList.add("visible");
      const r = ctxMenu.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) ctxMenu.style.left = `${x - r.width}px`;
      if (r.bottom > window.innerHeight - 8) ctxMenu.style.top = `${y - r.height}px`;
    };
    bar.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.clientX, e.clientY);
    });
    const startRename = () => {
      const input = document.createElement("input");
      input.className = "rename-input pane-rename-input";
      input.value = this.customName ?? this.liveTitle;
      const commit = (save: boolean) => {
        input.replaceWith(this.titleEl);
        if (!save) return;
        const trimmed = input.value.trim();
        this.customName = trimmed || null;
        this.updateTitleDisplay();
        handlers.onRename(id, trimmed);
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(true);
        else if (e.key === "Escape") commit(false);
      });
      input.addEventListener("blur", () => commit(true));
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      this.titleEl.replaceWith(input);
      input.focus();
      input.select();
    };
    ctxRename.addEventListener("click", () => {
      closeCtxMenu();
      startRename();
    });
    ctxQueue.addEventListener("click", () => {
      closeCtxMenu();
      this.showQueueInput();
    });
    ctxUsage.addEventListener("click", () => {
      closeCtxMenu();
      handlers.onShowUsage(id, this.title);
    });
    ctxClose.addEventListener("click", () => {
      closeCtxMenu();
      handlers.onClose(id);
    });
    document.addEventListener("pointerdown", (e) => {
      if (ctxMenu.classList.contains("visible") && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
    });
    window.addEventListener("resize", closeCtxMenu);
    window.addEventListener("blur", closeCtxMenu);

    // ---- terminal host ----
    this.termHost = document.createElement("div");
    this.termHost.className = "pane-term";

    // ---- search bar ----
    this.searchBar = document.createElement("div");
    this.searchBar.className = "pane-search";
    this.searchInput = document.createElement("input");
    this.searchInput.placeholder = "Find…  (Enter next · Shift+Enter prev · Esc close)";
    this.searchBar.appendChild(this.searchInput);

    // ---- queue popover: title, command field, what's already waiting, key hints ----
    this.queueBar = document.createElement("div");
    this.queueBar.className = "pane-queue";
    this.queueBar.innerHTML =
      '<div class="pane-queue-head">' +
      '<span class="pane-queue-title">Queue command</span>' +
      '<span class="pane-queue-sub">Runs when this terminal is back at its prompt</span>' +
      "</div>" +
      '<label class="pane-queue-field"><span class="pane-queue-sigil" aria-hidden="true">&gt;</span></label>' +
      '<ol class="pane-queue-list"></ol>' +
      '<div class="pane-queue-foot">' +
      "<span><kbd>Enter</kbd> Queue</span>" +
      "<span><kbd>Shift</kbd><kbd>Enter</kbd> Queue another</span>" +
      "<span><kbd>Esc</kbd> Close</span>" +
      "</div>";
    this.queueInput = document.createElement("input");
    this.queueInput.spellcheck = false;
    this.queueInput.autocomplete = "off";
    this.queueInput.placeholder = "npm test";
    this.queueInput.setAttribute("aria-label", "Command to queue");
    this.queueBar.querySelector(".pane-queue-field")!.appendChild(this.queueInput);
    this.queueList = this.queueBar.querySelector<HTMLOListElement>(".pane-queue-list")!;
    this.queueBar.addEventListener("pointerdown", (e) => e.stopPropagation());

    // ---- drag/drop overlay ----
    const overlay = document.createElement("div");
    overlay.className = "drop-overlay";
    const hint = document.createElement("div");
    hint.className = "drop-hint";
    overlay.appendChild(hint);

    this.el.append(bar, this.termHost, this.searchBar, this.queueBar, overlay);

    // ---- xterm ----
    this.term = new Terminal({
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      // portable-pty uses ConPTY on Windows, and xterm has to be told so: the
      // backend owns its viewport, so when the terminal grows the new rows
      // belong to it. This makes xterm append blank rows for it to draw into
      // rather than pulling old scrollback down into them — content that the
      // program would then overwrite, losing it from screen and scrollback
      // both. That was the seemingly-random loss after expand/restore.
      //
      // buildNumber is deliberately omitted: reflow stays on (it is gated on a
      // *known* pre-21376 build), while the viewport-ownership behaviour above
      // is enabled by the presence of either ConPTY field.
      windowsPty: { backend: "conpty" },
      allowProposedApi: true,
      // Alt+click is ours (open the link in a browser pane). xterm's own
      // alt-click-moves-cursor would fire on the same mouseup and type a burst
      // of arrow keys into the shell, so it's off.
      altClickMovesCursor: false,
      theme: getTermTheme(),
    });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    // Plain click keeps the default "hand it to the OS browser" behavior;
    // Alt+click opens the URL in an embedded browser pane beside this one.
    this.term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.altKey) {
          handlers.onOpenBrowser(id, uri);
          return;
        }
        openExternalUrl(uri);
      })
    );
    this.term.open(this.termHost);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      /* DOM renderer fallback */
    }

    // Highlight-search overlay: lives inside xterm's own screen element (the
    // same coordinate space as the glyphs) and is redrawn from xterm's render
    // event, so the boxes always land in the frame that paints the text under
    // them. See renderHighlights().
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (screen) {
      this.hlLayer = document.createElement("div");
      this.hlLayer.className = "search-hl-layer";
      screen.appendChild(this.hlLayer);
    }
    this.term.onRender(() => this.renderHighlights());

    // ---- clipboard (Windows Terminal semantics) ----
    // Returning false keeps the key out of the PTY. Everything else falls
    // through to xterm, so Ctrl+C with no selection is still a plain SIGINT.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === "c") {
        if (this.term.hasSelection()) {
          void copyText(this.term.getSelection());
          this.term.clearSelection();
          e.preventDefault();
          return false;
        }
        // No selection: plain Ctrl+C is a SIGINT, Ctrl+Shift+C is a no-op.
        if (!e.shiftKey) return true;
        e.preventDefault();
        return false;
      }
      if (e.shiftKey && k === "v") {
        e.preventDefault();
        void this.paste();
        return false;
      }
      return true;
    });

    this.term.onData((d) => {
      void writePty(id, d);
      clearPaneAttention(id);
      this.trackInput(d, handlers);
    });
    onAttentionChange((paneId, waiting) => {
      if (paneId === id) this.el.classList.toggle("needs-attention", waiting);
    });
    this.offQueueChange = onQueueChange((paneId, queue) => {
      if (paneId !== id) return;
      this.updateQueueBadge(queue);
      this.renderQueueList(queue);
    });
    registerReadySource(id, () => this.promptContext());
    this.term.onResize(({ cols, rows }) => {
      if (this.spawned) this.scheduleResizePty(cols, rows);
    });
    this.term.onTitleChange((t) => {
      this.liveTitle = representativeTitle(stripLeadingGlyphs(t)) || "PowerShell";
      this.titleSeq++;
      this.updateTitleDisplay();
    });
    // Working-directory reports from the shell prompt (the backend wraps
    // PowerShell's prompt / cmd's PROMPT to emit OSC 9;9; other shells may send
    // OSC 7). Remembered per pane so a restart reopens the pane where it was.
    let lastCwd: string | null = null;
    const reportCwd = (cwd: string | null): boolean => {
      if (!cwd) return false;
      if (cwd !== lastCwd) {
        lastCwd = cwd;
        handlers.onCwdChange(this.id, cwd);
      }
      return true;
    };
    this.term.parser.registerOscHandler(9, (data) => reportCwd(parseOsc99(data)));
    this.term.parser.registerOscHandler(7, (data) => reportCwd(parseOsc7(data)));
    // Clipboard writes from the program (see parseOsc52). Returning true marks
    // the sequence handled so it never reaches the screen as stray text.
    this.term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data);
      if (text !== null) void copyText(text);
      return true;
    });

    // Repair the scrollbar before xterm handles focus/click and before a
    // queued native scroll event can interpret a layout reset as user input.
    this.termHost.addEventListener("pointerdown", () => syncTerminalViewport(this.term), true);
    this.termHost.addEventListener("focus", () => syncTerminalViewport(this.term), true);
    this.termHost.addEventListener("scroll", (event) => {
      if (this.hidden || this.el.classList.contains("folded") || this.el.closest(".session-view.folding")) {
        event.stopImmediatePropagation();
        syncTerminalViewport(this.term);
      }
    }, true);
    this.el.addEventListener("focusin", () => handlers.onFocus(id));
    bar.addEventListener("mousedown", () => handlers.onFocus(id));

    // ---- search behavior ----
    this.searchInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if (e.shiftKey) this.search.findPrevious(this.searchInput.value);
        else this.search.findNext(this.searchInput.value);
      } else if (e.key === "Escape") {
        this.hideSearch();
      }
    });
    this.searchInput.addEventListener("input", () => {
      this.search.findNext(this.searchInput.value, { incremental: true });
    });

    // ---- queue-command behavior ----
    this.queueInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const value = this.queueInput.value.trim();
        if (!value) {
          if (!e.shiftKey) this.hideQueueInput();
          return;
        }
        handlers.onQueueCommand(id, value);
        if (e.shiftKey) this.queueInput.value = "";
        else this.hideQueueInput();
      } else if (e.key === "Escape") {
        this.hideQueueInput();
      }
    });
    // Clicking anywhere outside the popover dismisses it, like the context menu.
    // No refocus here: the click may be landing on another pane.
    document.addEventListener("pointerdown", () => {
      this.queueBar.classList.remove("visible");
    });
    this.queueList.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".pane-queue-remove");
      if (!btn) return;
      removeQueuedCommand(id, Number(btn.dataset.index));
      this.queueInput.focus();
    });

    // ---- drag to move / Alt+drag to share context ----
    // (pointer-based: HTML5 DnD is unreliable inside WebView2)
    // Listeners live on `window`, not on `bar`: a drop (or any re-render) detaches
    // and rebuilds the pane DOM, which would silently drop pointer capture and leave
    // pointerup unhandled — stranding the global `dragging-pane` state (grabbing
    // cursor + drop overlays that swallow all input) across every session.
    bar.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".pane-btn")) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      let dragging = false;
      let ghost: HTMLElement | null = null;
      let ghostLabel: HTMLElement | null = null;
      let targetEl: HTMLElement | null = null;
      let region: DropRegion | null = null;
      // Alt held ⇒ "give this terminal as context" instead of "move this pane".
      // Re-read on every pointermove so the user can flip modes mid-drag.
      let ctxMode = e.altKey;
      let finished = false;

      // Guaranteed-once teardown: always clears the global drag state, even if the
      // pane was reparented mid-drag or a handler throws.
      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          if (bar.hasPointerCapture(pointerId)) bar.releasePointerCapture(pointerId);
        } catch {
          /* capture may already be gone after a reparent */
        }
        if (!dragging) return;
        document.body.classList.remove("dragging-pane", "dragging-context");
        ghost?.remove();
        ghost = null;
        clearHints();
        if (commit && targetEl?.isConnected) {
          const target = targetEl.dataset.paneId;
          if (target && ctxMode) handlers.onSendContext(id, target);
          else if (target && region) handlers.onMove(id, target, region);
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
            /* best-effort; window listeners are the real guarantee */
          }
          document.body.classList.add("dragging-pane");
          ghost = document.createElement("div");
          ghost.className = "drag-ghost";
          ghostLabel = document.createElement("span");
          ghost.appendChild(ghostLabel);
          document.body.appendChild(ghost);
        }
        ghost!.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;

        const title = this.titleEl.textContent || "Terminal";
        if (ctxMode !== ev.altKey) {
          ctxMode = ev.altKey;
          if (targetEl) setHint(targetEl, null); // region semantics differ per mode
        }
        document.body.classList.toggle("dragging-context", ctxMode);
        ghost!.classList.toggle("context", ctxMode);
        ghostLabel!.textContent = ctxMode ? `Context: ${title}` : title;

        // Skip external-window panes: their tree-move semantics (id swaps) don't
        // apply to a reparented HWND, and they have no PTY here to paste into.
        // In context mode also skip browser panes — same reason: no stdin.
        const hit = resolveDrop(
          ev.clientX,
          ev.clientY,
          id,
          ctxMode,
          (el) => el.dataset.external !== "1" && !(ctxMode && el.classList.contains("browser-pane"))
        );
        if (targetEl && targetEl !== hit?.el) setHint(targetEl, null);
        targetEl = hit?.el ?? null;
        region = hit?.region ?? null;
        if (hit) setHint(hit.el, hit.hint);
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        // The release decides the mode: dropping with Alt still down means
        // "context", even if Alt was toggled since the last pointermove. In move
        // mode a drop with no region resolved is a no-op anyway.
        if (dragging) {
          ctxMode = ev.altKey;
          if (!ctxMode && targetEl && !region && !targetEl.classList.contains("fold-gap")) {
            // Alt was released on the drop itself, so no split region was ever
            // previewed — resolve one from the release point.
            const r = targetEl.getBoundingClientRect();
            region = dropRegion((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
          }
        }
        finish(ev.type === "pointerup");
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });

    // ---- keep xterm sized to its host ----
    this.observer = new ResizeObserver(() => this.fitSoon());
    this.observer.observe(this.termHost);
  }

  /** Clipboard → PTY. Goes through term.paste() so bracketed-paste mode is
   *  honoured, and CRLF is normalised to CR (a bare LF submits every line). */
  async paste(): Promise<void> {
    const text = await pasteText();
    if (text) this.term.paste(text.replace(/\r\n/g, "\r"));
  }

  fitSoon(): void {
    if (this.disposed) return;
    // Coalesce a burst of resize notifications (a drag fires many per second)
    // into a single fit per animation frame. Fitting on every tick re-renders
    // the WebGL canvas and resizes the PTY dozens of times a second, which reads
    // as flicker and lag. One fit per frame tracks the gesture smoothly; the
    // trailing timeout guarantees a final fit once the size settles.
    if (this.fitRaf === null) {
      this.fitRaf = window.requestAnimationFrame(() => {
        this.fitRaf = null;
        this.fitNow();
      });
    }
    if (this.fitTimer !== null) window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      this.fitTimer = null;
      this.fitNow();
    }, 120);
  }

  /** Coalesce divider-drag resize bursts so ConPTY only repaints the settled
   *  geometry. Fold animations defer xterm fitting entirely in fitNow(). */
  private scheduleResizePty(cols: number, rows: number): void {
    // A lone resize (no burst in flight) fires immediately instead of joining
    // the 120ms debounce below. Layout settling shortly after the app starts
    // (window clamp, sidebar animation finishing, etc.) can reflow a pane's
    // host size once; xterm reflows its own screen for that instantly, but
    // the debounce used to leave ConPTY thinking it was still the old width
    // for 120ms. If the user typed in that window, PSReadLine redrew the
    // prompt for the *old* width while xterm was already laid out for the
    // *new* one, and the redraw landed at the wrong columns — visible as
    // typed characters overwriting the middle of the existing prompt line.
    // Only an actual burst (this fires again before the previous one's
    // timer/resize completed) still gets coalesced, which is what protects
    // ConPTY from repaint-spam during a drag-resize gesture.
    if (this.ptyResizeTimer === null && Date.now() - this.lastPtyResizeAt > 150) {
      this.sendPtyResize(cols, rows);
      return;
    }
    if (this.ptyResizeTimer !== null) window.clearTimeout(this.ptyResizeTimer);
    this.ptyResizeTimer = window.setTimeout(() => {
      this.ptyResizeTimer = null;
      // Deliberately ignores the captured size and re-reads the terminal's
      // *current* dimensions. The captured one is a snapshot from up to 120ms
      // ago; another fit may have adjusted rows since, and a stale value
      // sent here would leave ConPTY permanently disagreeing with xterm.
      this.sendPtyResize(this.term.cols, this.term.rows);
    }, 120);
  }

  /** The single place a size actually reaches ConPTY, so what the backend was
   *  last told is always known. */
  private sendPtyResize(cols: number, rows: number): void {
    if (this.disposed || !this.spawned) return;
    this.lastPtyResizeAt = Date.now();
    this.lastSentCols = cols;
    this.lastSentRows = rows;
    void resizePty(this.id, cols, rows);
  }

  /** Reconcile backend geometry even when a fit emits no resize event. */
  private syncPtySize(): void {
    if (this.disposed || !this.spawned) return;
    const { cols, rows } = this.term;
    if (cols === this.lastSentCols && rows === this.lastSentRows) return;
    this.scheduleResizePty(cols, rows);
  }

  fitNow(): void {
    if (this.disposed) return;
    // Folding is visual only: keep the running TUI at its last useful size.
    // Fit all affected panes once main.ts removes the animation class.
    if (this.el.classList.contains("folded") || this.el.closest(".session-view.folding")) {
      this.hidden = true;
      return;
    }
    const r = this.termHost.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) {
      this.hidden = true;
      return;
    }
    const reappeared = this.hidden;
    this.hidden = false;
    const buf = this.term.buffer.active;
    const wasAtBottom = buf.viewportY >= buf.baseY;
    try {
      fitTerminalToViewport(this.term, this.fit);
    } catch {
      /* ignore fit races */
    }
    this.syncPtySize();
    if (wasAtBottom) this.term.scrollToBottom();
    syncTerminalViewport(this.term);
    if (reappeared) {
      this.term.refresh(0, this.term.rows - 1);
      // Recheck when a paused renderer resumes, through the cancellable fit
      // scheduler. Never force scroll-to-bottom or fake a PTY size change.
      this.fitSoon();
    }
  }

  /** Tracks raw keystrokes into a per-line buffer so we can recognize when the
   *  user launches a known agent CLI (e.g. `claude`). Any control character or
   *  escape sequence (arrow keys, history recall, Ctrl+C, …) discards the
   *  in-progress line rather than risk recording garbage. */
  private trackInput(data: string, handlers: PaneHandlers): void {
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") {
        const line = this.inputLine;
        this.inputLine = "";
        // Read the screen *before* the shell consumes this Enter: the row still
        // shows "<prompt><what they typed>", which is what teaches the command
        // queue this program's prompt shape.
        if (line) learnPromptSigil(this.id, this.promptContext().before, line);
        if (line.trim()) handlers.onCommandEntered(this.id, line);
      } else if (ch === "\x7f" || ch === "\b") {
        this.inputLine = this.inputLine.slice(0, -1);
      } else if (code < 0x20 || code === 0x1b) {
        this.inputLine = "";
        return; // rest of this chunk belongs to the same escape sequence
      } else {
        this.inputLine += ch;
      }
    }
  }

  /** Whether this pane's PTY has been spawned (or is being spawned) already. */
  get started(): boolean {
    return this.spawned;
  }

  /** `resumeCommand` may be a promise: looking up which agent conversation this
   *  pane owned is a backend round-trip, and we'd rather start the shell now and
   *  type the command once the answer lands. `fallbackCwd` is used when `cwd`
   *  no longer exists (e.g. a remembered folder that was since deleted). */
  async ensureSpawned(
    shell: string,
    cwd?: string | null,
    resumeCommand?: string | Promise<string | null> | null,
    fallbackCwd?: string | null
  ): Promise<void> {
    if (this.spawned || this.disposed) return;
    this.spawned = true;
    // Taken from the shell this pane actually launched with, not from the live
    // setting, so changing the default shell later doesn't relabel terminals
    // that are still running the old one.
    this.shellBrand = shellBrand(shell);
    this.renderPaneIcon();
    this.fitNow();
    const cols = this.term.cols || 120;
    const rows = this.term.rows || 30;
    // The spawn size is the backend's starting point, so record it as "last
    // sent" — otherwise the first syncPtySize would see a phantom mismatch.
    this.lastSentCols = cols;
    this.lastSentRows = rows;
    try {
      const isNew = await spawnPty(this.id, cols, rows, shell, cwd ?? null, null, fallbackCwd ?? null);
      // A reused PTY is already running whatever it was running — typing the
      // resume command into it again would resubmit it as a fresh message
      // (e.g. into a live Claude Code session) on every dev-mode reload.
      if (!isNew) return;
      const line = typeof resumeCommand === "string" ? resumeCommand : await resumeCommand;
      if (line && !this.disposed) {
        // ConPTY buffers stdin, so this lands as soon as the shell starts reading.
        setTimeout(() => {
          if (this.disposed) return;
          void writePty(this.id, line + "\r");
        }, 700);
      }
    } catch (e) {
      this.term.write(`\x1b[31mFailed to start shell: ${e}\x1b[0m\r\n`);
    }
  }

  /** Displayed pane title — the user's custom name when set, else the
   *  shell/agent-reported title — for labelling context. */
  get title(): string {
    return this.customName || this.liveTitle || "Terminal";
  }

  /** The agent's name, but only while the terminal title is still whatever the
   *  shell left there: agents that title the terminal themselves (Claude Code's
   *  live status line) say more than their own name does, so the first title
   *  they emit takes the bar back. */
  private agentPrefix(): string | null {
    return this.agentLabel && this.titleSeq === this.agentLabelAtSeq ? this.agentLabel : null;
  }

  private updateTitleDisplay(): void {
    const agent = this.agentPrefix();
    this.titleEl.textContent =
      this.customName || (agent ? `${agent} · ${this.liveTitle}` : this.liveTitle);
  }

  /** Applies a persisted custom name on restore, without re-notifying
   *  onRename (the caller already has it from saved state). */
  setCustomName(name: string | null): void {
    this.customName = name && name.trim() ? name.trim() : null;
    this.updateTitleDisplay();
  }

  /** Plain-text snapshot of the tail of this terminal's scrollback + screen, used
   *  when handing the terminal to another pane as context. Soft-wrapped rows are
   *  rejoined into their logical line, and blank padding is trimmed off both ends
   *  so an idle terminal doesn't contribute a wall of empty lines. */
  snapshotText(maxLines = 400): string {
    const buf = this.term.buffer.active;
    const end = buf.baseY + this.term.rows;
    const start = Math.max(0, end - maxLines);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.map((l) => l.replace(/\s+$/, "")).join("\n");
  }

  write(data: Uint8Array): void {
    if (!this.disposed) this.term.write(data);
  }

  applySettings(s: Settings): void {
    this.term.options.fontSize = s.fontSize;
    this.term.options.fontFamily = s.fontFamily;
    this.term.options.cursorStyle = s.cursorStyle;
    this.term.options.cursorBlink = s.cursorBlink;
    this.term.options.scrollback = s.scrollback;
    this.refreshActionTooltips(s);
    this.fitNow();
  }

  /** Re-skins the terminal to match the active app theme (xterm can't read CSS
   *  variables, so the palette is recomputed and pushed in on theme changes). */
  applyTermTheme(theme: Record<string, string> = getTermTheme()): void {
    this.term.options.theme = theme;
  }

  /** Keeps pane action button tooltips in sync with the user's current keybinds. */
  private refreshActionTooltips(s: Settings): void {
    for (const { el, action } of this.actionButtons) {
      const chord = s.keybinds[action];
      let title = chord ? `${ACTIONS[action]} (${prettyChord(chord)})` : ACTIONS[action];
      // Discoverability: the Alt modifier is invisible otherwise.
      if (action === "splitRight" || action === "splitDown")
        title += " — hold Alt to duplicate this pane";
      el.title = title;
    }
  }

  showSearch(): void {
    this.searchBar.classList.add("visible");
    this.searchInput.focus();
    this.searchInput.select();
  }

  hideSearch(): void {
    this.searchBar.classList.remove("visible");
    this.search.clearDecorations();
    this.term.focus();
  }

  showQueueInput(): void {
    this.renderQueueList(getQueue(this.id));
    this.queueBar.classList.add("visible");
    this.queueInput.focus();
    this.queueInput.select();
  }

  hideQueueInput(): void {
    if (!this.queueBar.classList.contains("visible")) return;
    this.queueBar.classList.remove("visible");
    this.queueInput.value = "";
    this.term.focus();
  }

  /** Commands already waiting, each removable, so queuing another is never blind. */
  private renderQueueList(queue: string[]): void {
    this.queueList.replaceChildren(
      ...queue.map((cmd, i) => {
        const li = document.createElement("li");
        const text = document.createElement("span");
        text.className = "pane-queue-cmd";
        text.textContent = cmd;
        text.title = cmd;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "pane-queue-remove";
        remove.dataset.index = String(i);
        remove.title = "Remove from queue";
        remove.setAttribute("aria-label", `Remove ${cmd} from queue`);
        remove.innerHTML = ICONS.close;
        li.append(text, remove);
        return li;
      })
    );
  }

  private updateQueueBadge(queue: string[]): void {
    this.queueBadge.classList.toggle("visible", queue.length > 0);
    this.queueBadge.textContent = queue.length ? String(queue.length) : "";
    this.queueBadge.title = queue.length
      ? `Queued — runs once this terminal is back at its prompt:\n` +
        `${queue.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n` +
        `Click to run the next one now · right-click to cancel`
      : "";
  }

  /** The bottom of what is *currently on screen*, as plain text.
   *
   *  Deliberately reads the live screen region (baseY onwards) rather than the
   *  viewport: if the user has scrolled up into history, what they are looking
   *  at is not what the program is painting, and the running-agent check must
   *  follow the program.
   *
   *  This is the input to attention.ts's mid-turn detection. Scanning the
   *  rendered buffer instead of the raw PTY byte stream is the whole point:
   *  bytes accumulate, screens don't. A harness's "esc to interrupt" footer
   *  lingers forever in a byte tail after the turn it belonged to, but vanishes
   *  from the screen the instant the harness erases it. */
  screenTail(count = 14): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.slice(-count).join("\n");
  }

  /** Where the cursor currently sits, for the queue's "is this terminal idle at
   *  its prompt?" check (see commandQueue.ts). Reads straight from xterm's own
   *  buffer, so it reflects exactly what's rendered rather than re-parsing raw
   *  PTY bytes ourselves. Only the text *up to* the cursor is returned: that's
   *  the part a prompt occupies, and it stays empty while a command is running
   *  and the cursor is parked at the start of a fresh line. */
  private promptContext(): PromptContext {
    const buf = this.term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    return {
      before: line ? line.translateToString(true, 0, buf.cursorX) : "",
      alternate: buf.type === "alternate",
    };
  }

  /** Columns where `needle` (already lower-cased) starts on one buffer row. A
   *  match straddling a wrapped line break isn't counted — the overlay and the
   *  match count both go through here, so the two always agree. */
  private matchCols(row: number, needle: string): number[] {
    const line = this.term.buffer.active.getLine(row);
    if (!line) return [];
    const text = line.translateToString(false).toLowerCase();
    const cols: number[] = [];
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
      cols.push(i);
    }
    return cols;
  }

  /** Cell size in CSS px, straight off the renderer (the very numbers xterm
   *  positions glyphs with); falls back to measuring the rendered screen. */
  private cellSize(): { w: number; h: number } {
    const cell = (
      this.term as unknown as {
        _core?: {
          _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
        };
      }
    )._core?._renderService?.dimensions?.css?.cell;
    if (cell && cell.width > 0 && cell.height > 0) return { w: cell.width, h: cell.height };
    const screen = this.hlLayer?.parentElement;
    return {
      w: (screen?.clientWidth ?? 0) / this.term.cols,
      h: (screen?.clientHeight ?? 0) / this.term.rows,
    };
  }

  /** Redraws the highlight boxes for the rows currently on screen. Runs inside
   *  xterm's render event — the same frame that paints the glyphs — so a scroll
   *  or a TUI repaint can never leave a box floating over stale text. Only the
   *  visible rows are scanned (a few dozen) and the box elements are pooled and
   *  moved with transforms, so it's cheap enough to run on every render. */
  private renderHighlights(): void {
    const layer = this.hlLayer;
    if (!layer) return;
    let used = 0;
    if (this.hlNeedle) {
      const buf = this.term.buffer.active;
      const { w, h } = this.cellSize();
      const width = Math.round(this.hlNeedle.length * w);
      const height = Math.ceil(h);
      for (let y = 0; y < this.term.rows; y++) {
        const row = buf.viewportY + y;
        for (const col of this.matchCols(row, this.hlNeedle)) {
          let box = this.hlBoxes[used];
          if (!box) {
            box = document.createElement("div");
            box.className = "search-hl";
            this.hlBoxes.push(box);
            layer.appendChild(box);
          }
          box.style.transform = `translate(${Math.round(col * w)}px, ${Math.round(y * h)}px)`;
          box.style.width = `${width}px`;
          box.style.height = `${height}px`;
          box.classList.toggle(
            "active",
            this.hlActive !== null && this.hlActive.row === row && this.hlActive.col === col
          );
          box.style.display = "block";
          used++;
        }
      }
    }
    for (let i = used; i < this.hlBoxes.length; i++) this.hlBoxes[i].style.display = "none";
  }

  /** Used by the "highlight search" popup (any pane, whatever's running in it —
   *  plain shell, a CLI, an agent — since this searches the terminal's character
   *  buffer, not the process). Scrolls the nearest match into view and lights up
   *  every match; the highlight is persistent — it stays until clearHighlight()
   *  is called (the popup calls it on Esc), not on a timer.
   *
   *  The search addon's decorations aren't used for this. It repositions them in
   *  a debounced pass that restarts on every write, so while a TUI repaints (or
   *  you scroll one) the old boxes hang over the new text for as long as output
   *  keeps coming. The overlay redraws with the glyphs instead, so there is no
   *  window in which the two can disagree. */
  previewSearch(term: string): { count: number } {
    if (this.disposed) return { count: 0 };
    const needle = term.toLowerCase();
    if (!needle) return { count: 0 };

    const buf = this.term.buffer.active;
    let count = 0;
    let firstAny: { row: number; col: number } | null = null;
    let firstAhead: { row: number; col: number } | null = null;
    for (let row = 0; row < buf.length; row++) {
      const cols = this.matchCols(row, needle);
      if (cols.length === 0) continue;
      count += cols.length;
      if (!firstAny) firstAny = { row, col: cols[0] };
      if (!firstAhead && row >= buf.viewportY) firstAhead = { row, col: cols[0] };
    }
    if (count === 0) {
      this.clearHighlight();
      return { count: 0 };
    }

    // Jump to the first match from where you're looking, wrapping to the top.
    const active = (firstAhead ?? firstAny) as { row: number; col: number };
    this.hlNeedle = needle;
    this.hlActive = active;
    this.el.classList.add("search-preview");
    if (active.row < buf.viewportY || active.row >= buf.viewportY + this.term.rows) {
      this.term.scrollToLine(Math.max(0, active.row - Math.floor(this.term.rows / 2)));
    }
    this.renderHighlights();
    return { count };
  }

  /** Ends a highlight preview started by previewSearch() — called on Esc. */
  clearHighlight(): void {
    if (this.disposed) return;
    this.el.classList.remove("search-preview");
    this.hlNeedle = "";
    this.hlActive = null;
    this.renderHighlights();
  }

  focus(): void {
    if (this.disposed) return;
    syncTerminalViewport(this.term);
    this.term.focus();
  }

  /** Shows (and starts polling) the rate-limit pill for the given agent
   *  harness, or hides it — pass null for a plain shell or an agent we don't
   *  track usage for. */
  setAgentHarness(harness: AgentHarness | null): void {
    this.usagePill.setHarness(harness);
  }

  /** Records which agent CLI is running here, or null once it exits — at which
   *  point the icon falls back to the shell underneath. Unlike the usage pill
   *  this covers every agent we have a logo for, not just the two with a usage
   *  endpoint. */
  setAgentBrand(brand: AgentBrand | null): void {
    if (brand === this.agentBrand) return;
    this.agentBrand = brand;
    this.setAgentLabel(brand ? markLabel(brand) : null);
    this.renderPaneIcon();
  }

  /** Draws the mark for whatever the pane is running. The agent wins while one
   *  is up: knowing Claude Code is in this pane is worth more than knowing it
   *  was launched from PowerShell. */
  private renderPaneIcon(): void {
    const brand: PaneBrand | null = this.agentBrand ?? this.shellBrand;
    if (brand === this.shownBrand) return; // re-rendering would restart the fade
    this.shownBrand = brand;
    this.agentIcon.innerHTML = brand ? markSvg(brand) : "";
    this.agentIcon.title = brand ? markLabel(brand) : "";
    this.agentIcon.classList.toggle("visible", brand !== null);
    // Shell marks sit back a stop so a colored logo reads as "an agent is
    // running here" across a grid of panes. See styles.css.
    this.agentIcon.classList.toggle("shell", brand !== null && brand === this.shellBrand && !this.agentBrand);
  }

  /** Names the agent in the title bar while it hasn't titled the terminal
   *  itself — Codex leaves the shell's own title (the working directory) in
   *  place, so without this a Codex pane is indistinguishable from a bare
   *  shell sitting in the same folder. */
  private setAgentLabel(label: string | null): void {
    if (label === this.agentLabel) return;
    this.agentLabel = label;
    // Any title the agent emits from here on wins over its name.
    this.agentLabelAtSeq = this.titleSeq;
    this.updateTitleDisplay();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.usagePill.dispose();
    if (this.fitRaf !== null) window.cancelAnimationFrame(this.fitRaf);
    if (this.fitTimer !== null) window.clearTimeout(this.fitTimer);
    if (this.ptyResizeTimer !== null) window.clearTimeout(this.ptyResizeTimer);
    this.observer.disconnect();
    this.offQueueChange();
    forgetPane(this.id);
    forgetPaneQueue(this.id);
    void killPty(this.id);
    this.term.dispose();
    this.el.remove();
    this.ctxMenu?.remove();
  }
}

export function setHint(paneEl: HTMLElement, region: DropRegion | null): void {
  const hint = paneEl.querySelector(".drop-hint");
  if (hint) hint.className = region ? `drop-hint region-${region}` : "drop-hint";
}

/** Reset every pane's drop hint — used at drag teardown so no highlight survives. */
export function clearHints(): void {
  document
    .querySelectorAll<HTMLElement>(".drop-hint")
    .forEach((h) => (h.className = "drop-hint"));
}

/** What a pane drag is currently over. `region` is the tree operation to commit
 *  (null in context mode, where the whole pane is the target); `hint` is what to
 *  paint. Handles both panes and the free space a fully folded group hands back. */
export interface DropHit {
  el: HTMLElement;
  region: DropRegion | null;
  hint: DropRegion;
}

export function resolveDrop(
  x: number,
  y: number,
  selfId: string,
  ctxMode: boolean,
  accepts: (el: HTMLElement) => boolean
): DropHit | null {
  const under = document.elementFromPoint(x, y)?.closest<HTMLElement>(".pane, .fold-gap.active");
  if (!under) return null;
  if (under.classList.contains("fold-gap")) {
    // The gap takes moves only: there is no terminal behind it to hand context
    // to, and dropping the pane whose fold created the gap is a no-op.
    const target = under.dataset.paneId;
    if (ctxMode || !target || target === selfId) return null;
    return { el: under, region: (under.dataset.gapRegion as DropRegion) ?? "e", hint: "c" };
  }
  if (under.dataset.paneId === selfId || !accepts(under)) return null;
  if (ctxMode) return { el: under, region: null, hint: "c" };
  const r = under.getBoundingClientRect();
  const region = dropRegion((x - r.left) / r.width, (y - r.top) / r.height);
  return { el: under, region, hint: region };
}

export function dropRegion(x: number, y: number): DropRegion {
  if (x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7) return "c";
  const dx = x - 0.5;
  const dy = y - 0.5;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

export const panes = new Map<string, PaneTerm>();

/** Push the active theme's terminal palette into every live pane. Called after
 *  applyTheme() whenever the theme (or settings) change. */
export function syncPaneThemes(): void {
  const theme = getTermTheme();
  panes.forEach((p) => p.applyTermTheme(theme));
}
