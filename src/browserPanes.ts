import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { copyText } from "./clipboard";
import {
  DEVICES,
  type Device,
  deviceById,
  deviceShim,
  RESPONSIVE,
  userAgentFor,
} from "./devices";
import { writePty } from "./pty";
import { clearHints, type DropRegion, dropRegion, resolveDrop, setHint } from "./terminals";
import type { Dir } from "./types";

// ---------------------------------------------------------------- Rust bridge

function createBrowserPane(
  id: string,
  url: string,
  rect: PhysRect,
  device: Device | null,
  zoom: number,
  force = false
): Promise<void> {
  return invoke("create_browser_pane", {
    id,
    url,
    ...rect,
    userAgent: device ? userAgentFor(device) : null,
    deviceScript: device ? deviceShim(device) : null,
    zoom,
    force,
  });
}
function positionBrowserPane(
  id: string,
  rect: PhysRect,
  visible: boolean,
  zoom: number
): Promise<void> {
  return invoke("position_browser_pane", { id, ...rect, visible, zoom });
}
function navigateBrowserPane(id: string, url: string): Promise<void> {
  return invoke("navigate_browser_pane", { id, url });
}
function browserHistory(id: string, action: string): Promise<void> {
  return invoke("browser_history", { id, action });
}
function destroyBrowserPane(id: string): Promise<void> {
  return invoke("destroy_browser_pane", { id });
}
interface CaptureResult {
  path: string;
  base64_png: string;
}
function captureBrowserPane(rect: PhysRect): Promise<CaptureResult> {
  return invoke("capture_browser_pane", { ...rect });
}

export interface PhysRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------- types

export interface BrowserHandlers {
  onFocus(id: string): void;
  onSplit(id: string, dir: Dir, duplicate?: boolean): void;
  onClose(id: string): void;
  onMove(srcId: string, targetId: string, region: DropRegion): void;
  /** Alt+drag (report) or Alt+Shift+drag (screenshot) onto another pane. */
  onSendContext(srcId: string, targetId: string, mode: "report" | "screenshot"): void;
  onToggleZoom(id: string): void;
  /** Collapse the pane to its title bar (or restore it) — see LeafNode.folded. */
  onToggleFold(id: string): void;
  /** Persisted so a restart restores the page. */
  onUrlChanged(id: string, url: string, title: string): void;
  /** Persisted so a restart restores the emulated device. */
  onDeviceChanged(id: string, deviceId: string, landscape: boolean): void;
}

/** One captured console line / JS error / network request. Shape comes straight
 *  from the injected monitor script (see browser.rs). */
interface LogEntry {
  t?: string;
  k: "c" | "e" | "n";
  level?: string;
  text?: string;
  method?: string;
  url?: string;
  status?: number;
  dur?: number;
}

const MAX_ENTRIES = 400;

const ICONS = {
  splitRight:
    '<svg viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="9" rx="1" fill="none" stroke="currentColor"/><line x1="7" y1="2.5" x2="7" y2="11.5" stroke="currentColor"/></svg>',
  splitDown:
    '<svg viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="9" rx="1" fill="none" stroke="currentColor"/><line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor"/></svg>',
  zoom:
    '<span class="zicon icon-expand"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3 6V3h3M11 8v3H8"/></svg></span>' +
    '<span class="zicon icon-restore"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M6 3v3H3M8 11V8h3"/></svg></span>',
  // Fold / unfold — CSS picks the chevron from the pane's `.folded` state.
  fold:
    '<span class="ficon icon-fold"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3.5 8.5 7 5l3.5 3.5"/></svg></span>' +
    '<span class="ficon icon-unfold"><svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M3.5 5.5 7 9l3.5-3.5"/></svg></span>',
  close:
    '<svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke="currentColor"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke="currentColor"/></svg>',
  copy:
    '<svg viewBox="0 0 14 14"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="none" stroke="currentColor"/><path fill="none" stroke="currentColor" d="M9.5 4.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/></svg>',
  back: '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M9 3 5 7l4 4"/></svg>',
  forward: '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="m5 3 4 4-4 4"/></svg>',
  reload:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M11.5 7a4.5 4.5 0 1 1-1.32-3.18M11.5 1.8v2.4H9.1"/></svg>',
  device:
    '<svg viewBox="0 0 14 14"><rect x="4.5" y="1.5" width="6" height="11" rx="1.5" fill="none" stroke="currentColor"/><line x1="6" y1="10.6" x2="9" y2="10.6" stroke="currentColor"/></svg>',
  rotate:
    '<svg viewBox="0 0 14 14"><rect x="1.5" y="5" width="11" height="6" rx="1.2" fill="none" stroke="currentColor"/><path fill="none" stroke="currentColor" d="M4.6 3.2A4 4 0 0 1 10 2.2M4.4 1.6l.3 1.7 1.7-.4"/></svg>',
  caret: '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="m4.5 6 2.5 2.5L9.5 6"/></svg>',
};

/** "example.com" → "https://example.com". Anything that already has a scheme
 *  (or looks like localhost:/about:) passes through untouched. */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (/^localhost(:\d+)?(\/|$)/i.test(raw)) return `http://${raw}`;
  return `https://${raw}`;
}

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") return u.host + u.pathname + u.search;
  } catch {
    /* keep raw */
  }
  return url;
}

function toPhys(r: DOMRect): PhysRect {
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    w: Math.round(r.width * dpr),
    h: Math.round(r.height * dpr),
  };
}

/** "iPhone 16 Pro Max" -> "16 Pro Max"; keeps the toolbar chip short. */
function shortName(d: Device): string {
  return d.name.replace(/^iPhone /, "").replace(/^Galaxy /, "").replace(" · ", " ");
}

// ------------------------------------------------------------- suppression

/** True while a full-screen overlay (settings, file viewer, panels…) covers the
 *  session area — the child webviews would float ABOVE such overlays, so they
 *  get hidden instead. Driven from main.ts where those states live. */
let overlaysOpen = false;

export function setBrowserOverlaysOpen(open: boolean): void {
  if (overlaysOpen === open) return;
  overlaysOpen = open;
  browserPanes.forEach((p) => p.syncSoon());
}

/** During pane drags our drop hints/ghost render in the main webview — which
 *  sits UNDER the child browser webviews. Hide them while dragging so the
 *  gesture feedback stays visible everywhere — EXCEPT the pane being dragged
 *  from (its content must stay on screen for Alt+Shift screenshot drops).
 *  Watched centrally so every drag source gets this for free. */
let dragSourceId: string | null = null;

new MutationObserver(() => {
  const dragging =
    document.body.classList.contains("dragging-pane") ||
    document.body.classList.contains("ext-dragging");
  if (!dragging) dragSourceId = null;
  browserPanes.forEach((p) => p.setDragActive(dragging));
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// ---------------------------------------------------------------- PaneBrowser

export class PaneBrowser {
  readonly id: string;
  readonly el: HTMLElement;
  private handlers: BrowserHandlers;
  private titleEl: HTMLElement;
  private host: HTMLElement;
  private startEl: HTMLElement;
  private urlInput: HTMLInputElement;
  private observer: ResizeObserver;
  private syncRaf: number | null = null;
  private disposed = false;
  private webviewCreated = false;
  /** Set on the first nav/title event from the child webview — proves the
   *  backend actually spun it up (drives the creation watchdog). */
  private receivedPageEvent = false;
  private dragActive = false;
  /** Last geometry/visibility state requested by the DOM. Native child
   *  webviews are positioned through async IPC, so requests must be applied in
   *  order: a late "show" from an earlier layout must never overtake the
   *  "hide" produced by a session switch or overlay. */
  private lastKey = "";
  private pendingPosition: {
    rect: PhysRect;
    visible: boolean;
    zoom: number;
  } | null = null;
  private positioning = false;
  private entries: LogEntry[] = [];
  private seenSinceCopy = false;
  private copyBadge: HTMLButtonElement;
  currentUrl = "";
  pageTitle = "";
  /** null = "Responsive" (the webview simply fills the pane). */
  private device: Device | null = null;
  private landscape = false;
  private scale = 1;
  private stage: HTMLElement;
  private frame: HTMLElement;
  private screen: HTMLElement;
  private deviceBtn: HTMLButtonElement;
  private deviceLabel: HTMLElement;
  private rotateBtn: HTMLButtonElement;
  private menu: HTMLElement | null = null;
  /** The in-flight create_browser_pane call, if any. create_browser_pane is
   *  async on the Rust side (webview creation can't happen synchronously —
   *  see wry#583), so a close that lands *during* creation can't destroy a
   *  webview that doesn't exist yet. Tracked so dispose() can re-destroy it
   *  once creation actually lands, instead of leaving an orphaned child
   *  webview glued to the main window forever (only a full app restart, which
   *  kills the whole process, would otherwise clear it). */
  private creating: Promise<void> | null = null;
  /** Native WebView2 creation/rebuilds must not overlap. In particular, rapid
   *  device changes each close and recreate the same Tauri label; allowing
   *  those calls to race can make an older device rebuild finish last. */
  private createTail: Promise<void> = Promise.resolve();

  constructor(
    id: string,
    startUrl: string,
    startTitle: string,
    handlers: BrowserHandlers,
    startDevice?: string,
    startLandscape?: boolean
  ) {
    this.id = id;
    this.handlers = handlers;
    this.device = deviceById(startDevice);
    this.landscape = !!startLandscape;
    this.currentUrl = startUrl;
    this.pageTitle = startTitle || "Browser";
    this.webviewCreated = !!startUrl;

    this.el = document.createElement("div");
    this.el.className = "pane browser-pane";
    this.el.dataset.paneId = id;

    // ---- title bar ----
    const bar = document.createElement("div");
    bar.className = "pane-bar";
    bar.title =
      "Drag to move · Alt+drag onto a terminal to hand over console & network logs · Alt+Shift+drag to send a screenshot";

    const badge = document.createElement("span");
    badge.className = "pane-ext-badge";
    badge.textContent = "WEB";
    badge.title = "Embedded browser";

    this.titleEl = document.createElement("span");
    this.titleEl.className = "pane-title";
    this.titleEl.textContent = this.pageTitle;

    const actions = document.createElement("div");
    actions.className = "pane-actions";
    const mkBtn = (
      icon: string,
      fn: (e: MouseEvent) => void,
      staticTitle: string
    ): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "pane-btn";
      b.innerHTML = icon;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn(e);
      });
      b.title = staticTitle;
      actions.appendChild(b);
      return b;
    };
    this.copyBadge = mkBtn(
      ICONS.copy,
      () => void this.copyReport(),
      "Copy console & network log"
    );
    mkBtn(ICONS.splitRight, (e) => handlers.onSplit(id, "row", e.altKey), "Split right");
    mkBtn(ICONS.splitDown, (e) => handlers.onSplit(id, "col", e.altKey), "Split down");
    mkBtn(ICONS.zoom, () => handlers.onToggleZoom(id), "Expand pane (toggle)");
    // Marked so the stylesheet can keep these two visible once folded.
    mkBtn(ICONS.fold, () => handlers.onToggleFold(id), "Fold pane (toggle)").dataset.act =
      "foldPane";
    mkBtn(ICONS.close, () => handlers.onClose(id), "Close pane").dataset.act = "closePane";

    bar.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".pane-btn")) return;
      handlers.onToggleFold(id);
    });

    bar.append(badge, this.titleEl, actions);

    // ---- URL toolbar ----
    const toolbar = document.createElement("div");
    toolbar.className = "browser-toolbar";

    const navBtn = (icon: string, action: string, label: string) => {
      const b = document.createElement("button");
      b.className = "browser-nav-btn";
      b.innerHTML = icon;
      b.title = label;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.webviewCreated) void browserHistory(id, action);
      });
      return b;
    };
    toolbar.append(
      navBtn(ICONS.back, "back", "Back"),
      navBtn(ICONS.forward, "forward", "Forward"),
      navBtn(ICONS.reload, "reload", "Reload")
    );

    // Device emulation picker.
    this.deviceBtn = document.createElement("button");
    this.deviceBtn.className = "browser-device-btn";
    this.deviceBtn.title = "Emulate a device size (phone, tablet, foldable…)";
    this.deviceBtn.innerHTML = ICONS.device;
    this.deviceLabel = document.createElement("span");
    this.deviceLabel.className = "browser-device-name";
    this.deviceBtn.appendChild(this.deviceLabel);
    const caret = document.createElement("span");
    caret.className = "browser-device-caret";
    caret.innerHTML = ICONS.caret;
    this.deviceBtn.appendChild(caret);
    this.deviceBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.deviceBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    this.rotateBtn = document.createElement("button");
    this.rotateBtn.className = "browser-nav-btn browser-rotate-btn";
    this.rotateBtn.innerHTML = ICONS.rotate;
    this.rotateBtn.title = "Rotate (portrait / landscape)";
    this.rotateBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.rotateBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setDevice(this.device, !this.landscape);
    });
    toolbar.append(this.deviceBtn, this.rotateBtn);

    this.urlInput = document.createElement("input");
    this.urlInput.className = "browser-url";
    this.urlInput.spellcheck = false;
    this.urlInput.placeholder = "Search or enter address";
    this.urlInput.value = startUrl ? prettyUrl(startUrl) : "";
    this.urlInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        this.urlInput.blur();
        return;
      }
      if (e.key === "Enter") {
        const url = normalizeUrl(this.urlInput.value);
        if (url) this.navigate(url);
        else this.urlInput.select();
      }
    });
    this.urlInput.addEventListener("focus", () => this.urlInput.select());
    toolbar.appendChild(this.urlInput);

    // ---- content host (the real webview glues over this) ----
    this.host = document.createElement("div");
    this.host.className = "pane-term browser-host";

    this.startEl = document.createElement("div");
    this.startEl.className = "browser-start";
    this.startEl.innerHTML =
      '<div class="browser-start-inner">' +
      '<svg class="browser-start-mark" viewBox="0 0 24 24" width="30" height="30"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.3"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M3 12h18M4.5 7.5h15M4.5 16.5h15" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>' +
      "<p>Type an address above to start browsing.</p>" +
      '<p class="browser-start-hint">Console & network activity is captured —<br>Alt+drag this pane onto a terminal to share it.</p></div>';
    this.startEl.classList.toggle("visible", !startUrl);
    this.host.appendChild(this.startEl);

    // Device stage: an empty frame the child webview is glued into. Drawn in
    // the main webview, so it can only paint *around* the webview's rect —
    // hence the bezel/cutout live outside the screen area.
    this.stage = document.createElement("div");
    this.stage.className = "device-stage";
    this.frame = document.createElement("div");
    this.frame.className = "device-frame";
    const cutout = document.createElement("div");
    cutout.className = "device-cutout";
    this.screen = document.createElement("div");
    this.screen.className = "device-screen";
    this.frame.append(cutout, this.screen);
    this.stage.appendChild(this.frame);
    this.host.appendChild(this.stage);
    this.syncDeviceUi();

    // ---- drag & drop overlay ----
    const overlay = document.createElement("div");
    overlay.className = "drop-overlay";
    const hint = document.createElement("div");
    hint.className = "drop-hint";
    overlay.appendChild(hint);

    this.el.append(bar, toolbar, this.host, overlay);

    bar.addEventListener("mousedown", () => handlers.onFocus(id));
    toolbar.addEventListener("mousedown", () => handlers.onFocus(id));

    this.bindDrag(bar);

    this.observer = new ResizeObserver(() => this.syncSoon());
    this.observer.observe(this.host);

    if (startUrl) {
      // Restored from saved state — spin the webview up right away.
      requestAnimationFrame(() => {
        this.layoutStage();
        const p = this.queueCreate(() =>
          createBrowserPane(id, startUrl, this.viewRect(), this.device, this.scale)
        );
        this.creating = p;
        p.then(() => {
            if (this.creating === p) this.creating = null;
            if (this.disposed) {
              void destroyBrowserPane(this.id).catch(() => {});
              return;
            }
            // A resize/session sync may have run while the async native
            // webview was still being created. That request could not affect
            // the not-yet-existing view, so force the current state through.
            this.lastKey = "";
            this.syncNow();
            requestAnimationFrame(() => this.syncNow());
          })
          .catch((err) => {
            const isLatest = this.creating === p;
            if (isLatest) this.creating = null;
            if (!this.disposed && isLatest) this.showLoadError(String(err));
          });
      });
    }
  }

  // ---- navigation ----

  navigate(url: string): void {
    if (this.disposed) return;
    this.currentUrl = url;
    this.urlInput.value = prettyUrl(url);
    this.startEl.classList.remove("visible");
    this.handlers.onUrlChanged(this.id, url, this.pageTitle);
    if (!this.webviewCreated) {
      this.webviewCreated = true;
      // Watchdog: if the webview never comes up (backend hiccup), say so
      // instead of leaving a silently blank pane.
      const watchdog = window.setTimeout(() => {
        if (!this.disposed && this.webviewCreated && !this.receivedPageEvent) {
          this.startEl.classList.add("visible");
          this.startEl.querySelector("p")!.textContent =
            "The browser view didn't start. Try closing and re-adding this pane.";
        }
      }, 10000);
      this.layoutStage();
      const p = this.queueCreate(() =>
        createBrowserPane(this.id, url, this.viewRect(), this.device, this.scale)
      );
      this.creating = p;
      p.then(() => {
          window.clearTimeout(watchdog);
          if (this.creating === p) this.creating = null;
          if (this.disposed) {
            void destroyBrowserPane(this.id).catch(() => {});
            return;
          }
          this.lastKey = "";
          this.syncNow();
          // The pane may still be settling (fonts, split animation) — re-sync
          // next frame so the webview lands exactly on the host.
          requestAnimationFrame(() => this.syncNow());
        })
        .catch((err) => {
          window.clearTimeout(watchdog);
          const isLatest = this.creating === p;
          if (isLatest) this.creating = null;
          if (!this.disposed && isLatest) this.showLoadError(String(err));
        });
    } else {
      void navigateBrowserPane(this.id, url).catch(() => {});
    }
  }

  private showLoadError(message: string): void {
    this.startEl.querySelector("p")!.textContent = `Couldn't open the browser: ${message}`;
    this.startEl.classList.add("visible");
  }

  // ---- events from the child webview (via Rust) ----

  ingestLog(json: string): void {
    let batch: LogEntry[];
    try {
      batch = JSON.parse(json) as LogEntry[];
    } catch {
      return;
    }
    if (!Array.isArray(batch)) return;
    for (const e of batch) {
      this.entries.push(e);
      if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    if (!this.seenSinceCopy) {
      this.seenSinceCopy = true;
      this.copyBadge.classList.add("has-data");
    }
  }

  onNav(url: string): void {
    this.receivedPageEvent = true;
    this.currentUrl = url;
    this.urlInput.value = prettyUrl(url);
    this.handlers.onUrlChanged(this.id, url, this.pageTitle);
  }

  onTitle(title: string): void {
    this.receivedPageEvent = true;
    this.pageTitle = title || "Browser";
    this.titleEl.textContent = this.pageTitle;
    this.handlers.onUrlChanged(this.id, this.currentUrl, this.pageTitle);
  }

  // ---- context payloads ----

  get title(): string {
    return this.currentUrl ? this.pageTitle : "Browser";
  }

  /** Plain-text digest of everything captured so far — what lands in an agent
   *  terminal on an Alt+drag, and what the copy button puts on the clipboard. */
  buildReport(): string {
    const lines: string[] = [];
    const console_ = this.entries.filter((e) => e.k === "c" || e.k === "e").slice(-60);
    const net = this.entries.filter((e) => e.k === "n").slice(-80);
    lines.push(`--- context: browser "${this.title}" (${this.currentUrl || "no page"}) ---`);
    if (console_.length) {
      lines.push(`[console] ${console_.length} entr${console_.length === 1 ? "y" : "ies"}:`);
      for (const e of console_) {
        const lvl = e.level ?? "error";
        lines.push(`${e.t ?? ""} [${lvl}] ${e.text ?? ""}`.trimEnd());
      }
    } else {
      lines.push("[console] no output captured");
    }
    if (net.length) {
      lines.push(`[network] ${net.length} request${net.length === 1 ? "" : "s"}:`);
      for (const e of net) {
        const status = e.status ? `${e.status}` : "failed";
        lines.push(`${e.method ?? "GET"} ${e.url ?? ""} -> ${status} (${e.dur ?? 0}ms)`);
      }
    } else {
      lines.push("[network] no requests captured");
    }
    lines.push("--- end context ---");
    return lines.join("\n");
  }

  async screenshotPath(): Promise<string | null> {
    if (!this.webviewCreated) return null;
    try {
      const r = await captureBrowserPane(this.viewRect());
      return r.path;
    } catch {
      return null;
    }
  }

  async copyReport(): Promise<void> {
    await copyText(this.buildReport());
    this.seenSinceCopy = false;
    this.copyBadge.classList.remove("has-data");
  }

  // ---- sizing / visibility ----

  hostRect(): PhysRect {
    return toPhys(this.host.getBoundingClientRect());
  }

  /** Where the webview must sit: the whole host in Responsive mode, or the
   *  device frame's screen area when emulating. */
  viewRect(): PhysRect {
    const host = this.host.getBoundingClientRect();
    if (!this.device) return toPhys(host);
    // Clamped to the host: the child webview is a sibling HWND, so anything
    // outside the pane would paint over the rest of the app.
    const r = this.screen.getBoundingClientRect();
    const left = Math.max(r.left, host.left);
    const top = Math.max(r.top, host.top);
    const right = Math.min(r.right, host.right);
    const bottom = Math.min(r.bottom, host.bottom);
    return toPhys(
      new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top))
    );
  }

  // ---- device emulation ----

  get deviceId(): string {
    return this.device?.id ?? RESPONSIVE.id;
  }

  /** Sizes the frame to the device's real CSS viewport and scales it down to
   *  fit the pane. The same factor becomes the webview's zoom, so the page
   *  still lays out at the device's full logical width. */
  private layoutStage(): void {
    if (!this.device || this.startEl.classList.contains("visible")) {
      this.scale = 1;
      this.stage.classList.remove("active");
      this.syncDeviceUi();
      return;
    }
    const dev = this.device;
    const land = this.landscape;
    const w = land ? dev.h : dev.w;
    const h = land ? dev.w : dev.h;
    const bezel = dev.frame === "tablet" ? 14 : dev.frame === "desktop" ? 7 : 11;
    const head = dev.frame === "desktop" ? 7 : dev.cutout === "none" ? bezel + 8 : bezel + 9;

    this.stage.classList.add("active");
    this.frame.classList.toggle("landscape", land);
    this.frame.dataset.frame = dev.frame;
    this.frame.dataset.cutout = dev.cutout;
    this.frame.style.setProperty("--bezel", bezel + "px");
    this.frame.style.setProperty("--head", head + "px");
    this.frame.style.setProperty("--screen-radius", Math.round(dev.radius / 2) + "px");
    this.screen.style.width = w + "px";
    this.screen.style.height = h + "px";

    // Measured, not derived: offsetWidth/Height ignore the transform, so this
    // is the frame's true unscaled footprint (screen + bezel + head).
    const host = this.host.getBoundingClientRect();
    const frameW = this.frame.offsetWidth || w + bezel * 2;
    const frameH = this.frame.offsetHeight || h + bezel * 2;
    const availW = Math.max(80, host.width - 24);
    const availH = Math.max(80, host.height - 24);
    const s = Math.min(1, availW / frameW, availH / frameH);
    this.scale = Math.max(0.25, Math.round(s * 1000) / 1000);
    // Centred by hand: an oversized flex/grid item gets clamped to the start
    // edge (its layout box is the *unscaled* size), which threw the frame —
    // and the webview glued to it — off the bottom-right of the pane.
    const x = Math.max(0, Math.round((host.width - frameW * this.scale) / 2));
    const y = Math.max(0, Math.round((host.height - frameH * this.scale) / 2));
    this.frame.style.transform =
      "translate(" + x + "px, " + y + "px) scale(" + this.scale + ")";
    this.deviceLabel.dataset.dims =
      w + " x " + h + (this.scale < 0.999 ? " - " + Math.round(this.scale * 100) + "%" : "");
    this.syncDeviceUi();
  }

  private syncDeviceUi(): void {
    const dev = this.device;
    this.deviceLabel.textContent = dev ? shortName(dev) : "Responsive";
    this.deviceBtn.classList.toggle("on", !!dev);
    this.rotateBtn.classList.toggle("hidden", !dev);
    this.rotateBtn.classList.toggle("on", this.landscape);
    this.deviceBtn.title = dev
      ? dev.name + " - " + (this.deviceLabel.dataset.dims ?? "") + "\nClick to pick another device"
      : "Emulate a device size (phone, tablet, foldable...)";
  }

  /** Switching device rebuilds the child webview: the user-agent and the
   *  devicePixelRatio/touch shim can only be applied at creation time. */
  setDevice(device: Device | null, landscape = this.landscape): void {
    this.device = device;
    this.landscape = device ? landscape : false;
    this.handlers.onDeviceChanged(this.id, this.deviceId, this.landscape);
    this.layoutStage();
    this.syncDeviceUi();
    if (!this.webviewCreated || !this.currentUrl) return;
    this.lastKey = "";
    const selectedDevice = this.device;
    const selectedScale = this.scale;
    const p = this.queueCreate(() =>
      createBrowserPane(
        this.id,
        this.currentUrl,
        this.viewRect(),
        selectedDevice,
        selectedScale,
        true
      )
    );
    this.creating = p;
    p.then(() => {
        if (this.creating === p) this.creating = null;
        if (this.disposed) {
          void destroyBrowserPane(this.id).catch(() => {});
          return;
        }
        this.lastKey = "";
        this.syncNow();
        requestAnimationFrame(() => this.syncNow());
      })
      .catch((err) => {
        const isLatest = this.creating === p;
        if (isLatest) this.creating = null;
        if (!this.disposed && isLatest) this.showLoadError(String(err));
      });
  }

  // ---- device menu ----

  private toggleMenu(): void {
    if (this.menu) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "device-menu";
    const add = (dev: Device | null) => {
      const row = document.createElement("button");
      row.className = "device-menu-item";
      row.classList.toggle("active", (dev?.id ?? RESPONSIVE.id) === this.deviceId);
      const name = document.createElement("span");
      name.textContent = dev ? dev.name : "Responsive (fill pane)";
      const dims = document.createElement("span");
      dims.className = "device-menu-dims";
      dims.textContent = dev ? dev.w + " x " + dev.h : "";
      row.append(name, dims);
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeMenu();
        this.setDevice(dev);
      });
      menu.appendChild(row);
    };
    add(null);
    let group = "";
    for (const dev of DEVICES) {
      if (dev.group !== group) {
        group = dev.group;
        const h = document.createElement("div");
        h.className = "device-menu-group";
        h.textContent = group;
        menu.appendChild(h);
      }
      add(dev);
    }
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    this.el.appendChild(menu);
    this.menu = menu;
    const btn = this.deviceBtn.getBoundingClientRect();
    const pane = this.el.getBoundingClientRect();
    menu.style.left =
      Math.max(4, Math.min(btn.left - pane.left, pane.width - menu.offsetWidth - 4)) + "px";
    const top = btn.bottom - pane.top + 4;
    menu.style.top = top + "px";
    menu.style.maxHeight = Math.max(140, pane.height - top - 8) + "px";
    this.deviceBtn.classList.add("open");
    // The child webview floats above this DOM - hide it while the menu is up.
    this.lastKey = "";
    this.syncNow();
    setTimeout(() => {
      window.addEventListener("mousedown", this.onDocDown, true);
      window.addEventListener("keydown", this.onMenuKey, true);
    }, 0);
  }

  /** Capture-phase, so it must ignore clicks on the menu itself (its rows act
   *  on "click", which never arrives if the menu is torn down on mousedown)
   *  and on the picker button (whose own click toggles). */
  private onDocDown = (e: MouseEvent): void => {
    const t = e.target as Node | null;
    if (t && (this.menu?.contains(t) || this.deviceBtn.contains(t))) return;
    this.closeMenu();
  };

  private onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      this.closeMenu();
    }
  };

  private closeMenu(): void {
    if (!this.menu) return;
    window.removeEventListener("mousedown", this.onDocDown, true);
    window.removeEventListener("keydown", this.onMenuKey, true);
    this.menu.remove();
    this.menu = null;
    this.deviceBtn.classList.remove("open");
    this.lastKey = "";
    this.syncNow();
  }

  syncSoon(): void {
    if (this.disposed || this.syncRaf !== null) return;
    this.syncRaf = window.requestAnimationFrame(() => {
      this.syncRaf = null;
      this.syncNow();
    });
  }

  setDragActive(active: boolean): void {
    if (this.dragActive === active) return;
    this.dragActive = active;
    this.syncSoon();
  }

  syncNow(): void {
    if (this.disposed || !this.webviewCreated) return;
    // Do not cache a no-op position call while create_browser_pane is still in
    // flight. Creation is asynchronous on Windows and the child does not exist
    // yet; the completion handler above will perform the authoritative sync.
    if (this.creating) return;
    const hiddenForDrag = this.dragActive && dragSourceId !== this.id;
    this.layoutStage();
    const visible =
      !overlaysOpen &&
      !hiddenForDrag &&
      !this.menu &&
      this.el.closest(".session-view.active") !== null &&
      this.host.offsetParent !== null &&
      this.el.offsetParent !== null;
    const rect = this.viewRect();
    const key = `${visible}:${rect.x},${rect.y},${rect.w},${rect.h}:${this.scale}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.pendingPosition = {
      rect,
      visible:
        visible && rect.w > 8 && rect.h > 8 && !this.startEl.classList.contains("visible"),
      zoom: this.scale,
    };
    void this.flushPosition();
  }

  /** Queues operations that create or replace the pane's single native
   *  webview. A rejected operation does not prevent the next requested rebuild
   *  from running. */
  private queueCreate(run: () => Promise<void>): Promise<void> {
    const next = this.createTail.catch(() => {}).then(() => {
      if (this.disposed) return;
      return run();
    });
    this.createTail = next;
    return next;
  }

  /** Serializes native bounds updates. Tauri commands are asynchronous; firing
   *  them independently allowed an older visible state to finish after a newer
   *  hidden state, leaving the browser HWND painted over the active session. */
  private async flushPosition(): Promise<void> {
    if (this.positioning || this.disposed) return;
    this.positioning = true;
    try {
      while (!this.disposed && this.pendingPosition) {
        const next = this.pendingPosition;
        this.pendingPosition = null;
        await positionBrowserPane(this.id, next.rect, next.visible, next.zoom);
      }
    } catch {
      // A transient native failure must not poison the dedupe key forever.
      // Re-measure on the next frame and try the latest state again.
      this.lastKey = "";
      if (!this.disposed) this.syncSoon();
    } finally {
      this.positioning = false;
      // A request can be queued between the loop's last check and this finally
      // block. Start another drain rather than leaving it stranded.
      if (!this.disposed && this.pendingPosition) void this.flushPosition();
    }
  }

  fitSoon(): void {
    this.syncSoon();
  }

  /** Called when the embedded page's own content is clicked — its child
   *  webview swallows the click before our DOM ever sees it, so the monitor
   *  script beacons a "focus" marker (see MONITOR_SCRIPT) that routes here. */
  notifyFocus(): void {
    this.handlers.onFocus(this.id);
  }

  focus(): void {
    // The pane's content is a separate child webview from our own DOM, so
    // selecting it here doesn't hand it real OS keyboard focus by itself —
    // ask the backend to do that directly (see focus_browser_pane). Before
    // the webview exists, put the cursor in the address bar instead so
    // keyboard users aren't stranded.
    if (this.webviewCreated) void invoke("focus_browser_pane", { id: this.id });
    else this.urlInput.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.closeMenu();
    this.disposed = true;
    if (this.syncRaf !== null) window.cancelAnimationFrame(this.syncRaf);
    this.pendingPosition = null;
    this.observer.disconnect();
    void destroyBrowserPane(this.id).catch(() => {});
    this.el.remove();
  }

  // ---- drag: move / context / screenshot ----

  private bindDrag(bar: HTMLElement): void {
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
      // Re-read on every pointermove so the user can flip modes mid-drag.
      let ctxMode = e.altKey;
      let shotMode = e.altKey && e.shiftKey;
      let finished = false;

      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          if (bar.hasPointerCapture(pointerId)) bar.releasePointerCapture(pointerId);
        } catch {
          /* capture may already be gone */
        }
        if (!dragging) return;
        document.body.classList.remove("dragging-pane", "dragging-context");
        ghost?.remove();
        ghost = null;
        dragSourceId = null;
        this.syncSoon();
        clearHints();
        if (commit && targetEl?.isConnected) {
          const target = targetEl.dataset.paneId;
          if (target && ctxMode) {
            this.handlers.onSendContext(this.id, target, shotMode ? "screenshot" : "report");
          } else if (target && region) {
            this.handlers.onMove(this.id, target, region);
          }
        }
      };

      const acceptsTarget = (el: HTMLElement): boolean =>
        !!el.dataset.paneId &&
        el.dataset.paneId !== this.id &&
        // Context drops need a writable stdin → terminal panes only.
        (!ctxMode ||
          (!el.classList.contains("browser-pane") && el.dataset.external !== "1"));

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
          dragging = true;
          dragSourceId = this.id;
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

        const label = this.title || "Browser";
        shotMode = ev.altKey && ev.shiftKey;
        const prevCtx = ctxMode;
        ctxMode = ev.altKey;
        if (prevCtx !== ctxMode && targetEl) setHint(targetEl, null);
        document.body.classList.toggle("dragging-context", ctxMode);
        ghost!.classList.toggle("context", ctxMode);
        ghost!.classList.toggle("shot", shotMode);
        ghostLabel!.textContent = shotMode
          ? `Screenshot: ${label}`
          : ctxMode
            ? `Context: ${label}`
            : label;

        const hit = resolveDrop(ev.clientX, ev.clientY, this.id, ctxMode, acceptsTarget);
        if (targetEl && targetEl !== hit?.el) setHint(targetEl, null);
        targetEl = hit?.el ?? null;
        region = hit?.region ?? null;
        if (hit) setHint(hit.el, hit.hint);
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (dragging) {
          ctxMode = ev.altKey;
          shotMode = ev.altKey && ev.shiftKey;
          if (!ctxMode && targetEl && !region && !targetEl.classList.contains("fold-gap")) {
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
  }
}

// ---------------------------------------------------------------- registry

export const browserPanes = new Map<string, PaneBrowser>();

/** Reposition/hide every browser webview — call after layout-affecting changes
 *  a single pane's ResizeObserver can't see (session switch, sidebar resize…). */
export function syncAllBrowsers(): void {
  browserPanes.forEach((p) => p.syncSoon());
}

// ---------------------------------------------------------------- event feed

let feedWired = false;

/** Wires the single "browser-event" listener that fans out to live panes.
 *  Idempotent — called from boot(). */
export function initBrowserEvents(): void {
  if (feedWired) return;
  feedWired = true;
  void listen<{ id: string; kind: string; data: string }>("browser-event", (e) => {
    const p = browserPanes.get(e.payload.id);
    if (!p) return;
    if (e.payload.kind === "log") p.ingestLog(e.payload.data);
    else if (e.payload.kind === "nav") p.onNav(e.payload.data);
    else if (e.payload.kind === "title") p.onTitle(e.payload.data);
    else if (e.payload.kind === "focus") p.notifyFocus();
  });
}

/** Paste-ready context blocks handed to terminal panes (bracketed-paste wrapped
 *  by the caller in main.ts, same as terminal→terminal Alt+drag). */
export async function browserContextBlock(
  srcId: string,
  mode: "report" | "screenshot"
): Promise<string | null> {
  const src = browserPanes.get(srcId);
  if (!src) return null;
  if (mode === "report") {
    const body = src.buildReport();
    return body.replace(/\r/g, "");
  }
  const path = await src.screenshotPath();
  if (!path) return null;
  return (
    `--- context: browser screenshot "${src.title}" ---\n` +
    `${src.currentUrl}\n` +
    `Screenshot saved to: ${path}\n` +
    `(PNG image of what the embedded browser currently shows — open it to view.)\n` +
    `--- end context ---\n`
  );
}

/** Shared writer used by main.ts: pastes a context block into a terminal. */
export function pasteIntoTerminal(targetId: string, block: string): void {
  void writePty(targetId, `\x1b[200~${block.replace(/\r/g, "")}\x1b[201~`);
}
