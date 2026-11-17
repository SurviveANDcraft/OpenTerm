/** The Threads mode main area: one conversation at a time.
 *
 *  header ─ title, folder, branch, model, actions
 *  scroll ─ turns (sticky prompt, prose, work timelines, footers)
 *  dock   ─ plan strip, approval sheet, queued prompts, composer
 *  drawer ─ inspector (stats, context, limits, changed files, tools) */
import { engine, type Runtime } from "./engine";
import { ic } from "./icons";
import { markSvg } from "../paneIcons";
import { folderLabel } from "../folderLaunch";
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  HARNESS_LABEL,
  MODE_HINT,
  MODE_LABEL,
  modelChoice,
  modelList,
  type Approval,
  type Harness,
  type ModelChoice,
  type PermissionMode,
  type TurnItem,
} from "./model";
import type { PromptImage } from "./adapter";
import type { Change } from "./runtime";
import { morphInner } from "./morph";
import { esc, editDiffHtml, fileKind, fmtDuration, fmtTokens, segments, turnHtml, type RenderState } from "./render";
import { renderMarkdown } from "./markdown";
import { baseName, relPath, setToolBase, lookOf } from "./tools";
import { arrowNav, closeMenu, openMenu, openPopover } from "./menu";
import { ago } from "./sidebar";
import { registerFileDropZone } from "../fileDropZones";
import { createMention, threadBriefs } from "./mention";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export interface ThreadViewHandlers {
  onOpenFile(path: string): void;
  onOpenUrl(url: string): void;
  onContinueInTerminal(rt: Runtime): void;
  onPickFolder(current: string | null): Promise<string | null>;
  onThreadMenu(id: string, anchor: HTMLElement): void;
  onNewThread(): void;
}

const MODES: PermissionMode[] = ["ask", "edits", "plan", "auto"];
const MODE_ICON: Record<PermissionMode, string> = { ask: "hand", edits: "pencilLine", plan: "map", auto: "lightning" };
const INSPECTOR_KEY = "openterm.threads.inspector";
const ZOOM_KEY = "openterm.threads.zoom";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

const SUGGESTIONS = [
  { icon: "compass", label: "Explain this project", text: "Explain how this project is structured" },
  { icon: "binoculars", label: "Find bugs", text: "Find bugs in the most recent changes" },
  { icon: "listChecks", label: "Write tests", text: "Write tests for the code that has none" },
  { icon: "sparkle", label: "Suggest improvements", text: "Suggest three improvements worth making" },
] as const;

/** An image goes to the model inline; any other file goes as its path. */
type Attachment =
  | { kind: "image"; image: PromptImage; url: string; name: string }
  | { kind: "file"; path: string; name: string; size?: number };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function nameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Signal-style bars: one per effort level, lit up to `lvl`. */
function effortGlyph(efforts: string[], lvl: string | null): string {
  const n = Math.max(1, efforts.length);
  const on = lvl ? efforts.indexOf(lvl) + 1 : 0;
  const w = 2.6;
  const gap = 1.7;
  const H = 12;
  const W = n * w + (n - 1) * gap;
  let bars = "";
  for (let i = 0; i < n; i++) {
    const h = 3.5 + ((H - 3.5) * i) / Math.max(1, n - 1);
    bars += `<rect x="${(i * (w + gap)).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${w}" height="${h.toFixed(2)}" rx="0.9"${i < on ? ' class="on"' : ""}/>`;
  }
  return `<svg class="tv-effort-glyph" viewBox="0 0 ${W.toFixed(2)} ${H}" width="${W.toFixed(1)}" height="${H}" aria-hidden="true">${bars}</svg>`;
}

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writePref(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* convenience only */
  }
}

function modelLabel(rt: Runtime): string {
  const pick = modelChoice(rt.meta.harness, rt.meta.model);
  if (rt.meta.model && !pick) return rt.meta.model;
  if (!rt.meta.model) {
    const live = rt.liveModel ?? pick?.resolved;
    if (live) return prettyModel(live, rt.meta.harness);
  }
  return pick?.label ?? "Default";
}

function prettyModel(id: string, h?: Harness): string {
  if (h) {
    const hit = modelList(h).find((m) => m.id && (m.resolved === id || m.id === id));
    if (hit) return hit.label;
  }
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?=$|-|\[)/i.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  return id;
}

export function createThreadView(h: ThreadViewHandlers) {
  const el = document.createElement("section");
  el.className = "tv";
  el.innerHTML = `
    <header class="tv-head">
      <div class="tv-head-main">
        <h1 class="tv-title" title="Double-click to rename"></h1>
        <span class="tv-live-dot" hidden></span>
      </div>
      <div class="tv-head-actions">
        <button class="tv-ibtn" data-head="terminal" type="button" title="Continue this conversation in a terminal pane">${ic("terminalWindow", 16)}</button>
        <button class="tv-ibtn" data-head="inspector" type="button" title="Inspector: stats, limits and changed files">${ic("sidebar", 16)}</button>
        <button class="tv-ibtn" data-head="menu" type="button" title="More">${ic("dots", 16)}</button>
      </div>
    </header>
    <div class="tv-body">
      <div class="tv-col">
        <div class="tv-scroll">
          <div class="tv-hero" hidden></div>
          <div class="tv-convo"></div>
          <div class="tv-spacer"></div>
        </div>
        <button class="tv-jump" type="button" hidden>${ic("arrowUp", 12)}<span>Latest</span></button>
        <div class="tv-dock">
          <div class="tv-plan" hidden></div>
          <div class="tv-sheet" hidden></div>
          <div class="tv-queue" hidden></div>
          <div class="tv-composer">
            <div class="tv-slash" hidden></div>
            <div class="tv-attachments" hidden></div>
            <div class="tv-input-wrap"><div class="tv-input-mirror" aria-hidden="true"></div><textarea class="tv-input" rows="1" spellcheck="true" placeholder=""></textarea></div>
            <div class="tv-bar">
              <div class="tv-bar-left">
                <button class="tv-pick tv-pick-model" type="button" data-pick="model" aria-haspopup="true"><span class="tv-pick-mark"></span><span class="tv-pick-label"></span>${ic("caretDown", 11)}</button>
                <button class="tv-pick tv-pick-effort" type="button" data-pick="effort" aria-haspopup="true"><span class="tv-pick-icon"></span><span class="tv-pick-label"></span>${ic("caretDown", 11)}</button>
                <button class="tv-pick tv-pick-mode" type="button" data-pick="mode"><span class="tv-pick-icon"></span><span class="tv-pick-label"></span>${ic("caretDown", 11)}</button>
                <span class="tv-ctx" title=""><svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="7.5" class="tv-ctx-track"/><circle cx="10" cy="10" r="7.5" class="tv-ctx-fill"/></svg><span class="tv-ctx-label"></span></span>
              </div>
              <div class="tv-bar-right">
                <button class="tv-attach" type="button" title="Attach files (or paste, or drop them here)">${ic("paperclip", 15)}</button>
                <button class="tv-send" type="button" title="Send (Enter)">${ic("arrowUp", 15)}</button>
              </div>
            </div>
          </div>
          <div class="tv-dock-foot">
            <span class="tv-where"><button class="tv-where-folder" data-head="folder" type="button">${ic("folder", 12)}<span></span></button><span class="tv-where-branch" hidden>${ic("gitBranch", 12)}<span></span></span></span>
            <span class="tv-foot-hint"></span>
          </div>
        </div>
      </div>
      <aside class="tv-inspector" aria-label="Inspector"><div class="tv-insp-inner"></div></aside>
    </div>
    <div class="tv-lightbox" hidden><div class="tv-lightbox-bar"><span class="tv-lightbox-cap"></span><button class="tv-lightbox-btn" data-lb="open" type="button">Open file</button><button class="tv-lightbox-btn" data-lb="copy" type="button">Copy path</button><button class="tv-lightbox-x" data-lb="close" type="button" title="Close (Esc)">${ic("x", 16)}</button></div><img alt="" draggable="false" /></div>
    <div class="tv-dropzone"><div>${ic("paperclip", 22)}<span>Drop files to attach</span><small>Images go inline, anything else by path</small></div></div>
    <div class="tv-zoom-toast" hidden></div>`;

  const $ = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const titleEl = $<HTMLElement>(".tv-title");
  const liveDot = $<HTMLElement>(".tv-live-dot");
  const folderChip = $<HTMLElement>(".tv-where-folder");
  const branchChip = $<HTMLElement>(".tv-where-branch");
  const scroll = $<HTMLElement>(".tv-scroll");
  const convo = $<HTMLElement>(".tv-convo");
  const hero = $<HTMLElement>(".tv-hero");
  const jump = $<HTMLButtonElement>(".tv-jump");
  const plan = $<HTMLElement>(".tv-plan");
  const sheet = $<HTMLElement>(".tv-sheet");
  const queueEl = $<HTMLElement>(".tv-queue");
  const composer = $<HTMLElement>(".tv-composer");
  const input = $<HTMLTextAreaElement>(".tv-input");
  const slash = $<HTMLElement>(".tv-slash");
  const attachEl = $<HTMLElement>(".tv-attachments");
  const sendBtn = $<HTMLButtonElement>(".tv-send");
  const modelBtn = $<HTMLButtonElement>(".tv-pick-model");
  const modeBtn = $<HTMLButtonElement>(".tv-pick-mode");
  const effortBtn = $<HTMLButtonElement>(".tv-pick-effort");
  const zoomToast = $<HTMLElement>(".tv-zoom-toast");
  const mirror = $<HTMLElement>(".tv-input-mirror");
  const ctxEl = $<HTMLElement>(".tv-ctx");
  const footHint = $<HTMLElement>(".tv-foot-hint");
  const inspInner = $<HTMLElement>(".tv-insp-inner");

  let rt: Runtime | null = null;
  let off: (() => void) | null = null;
  const rs: RenderState = { open: new Set(), closed: new Set(), flash: null };
  let pinned = true; // follow the bottom while streaming
  let attachments: Attachment[] = [];
  let planOpen = false;
  let inspectorOn = readPref(INSPECTOR_KEY, false);
  let slashIndex = 0;
  let renderQueued = false;
  let dirtyTurns = new Set<string>();
  let fullRender = true;
  const answers = new Map<string, Map<string, string[]>>(); // approval key -> question -> labels
  el.classList.toggle("insp-on", inspectorOn);

  // ---------------------------------------------------------------- rendering

  function schedule(full = false, turnKey?: string): void {
    if (full) fullRender = true;
    if (turnKey) dirtyTurns.add(turnKey);
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderConvo();
    });
  }

  function turnKeyOf(itemId: string): string | null {
    if (!rt) return null;
    let id: string | null = itemId;
    // Walk up sub-agent parents to the top-level item.
    for (let i = 0; i < 6 && id; i++) {
      const it = rt.items.get(id);
      if (!it) return null;
      if (!it.parent) break;
      id = it.parent;
    }
    const idx = rt.order.indexOf(id!);
    for (let i = idx; i >= 0; i--) {
      const it = rt.items.get(rt.order[i]);
      if (it?.kind === "user" && !it.queued) return it.id;
    }
    return "pre";
  }

  function renderConvo(): void {
    if (!rt) return;
    const segs = segments(rt);
    const empty = !segs.length && !engine.queued(rt);
    hero.hidden = !empty;
    convo.hidden = empty;
    if (empty) renderHero();
    const nearBottom = pinned;
    const keys = new Set(segs.map((s) => s.key));
    // Drop turns that no longer exist (cancelled prompts).
    for (const child of Array.from(convo.children)) if (!keys.has((child as HTMLElement).dataset.turn!)) child.remove();
    let prev: HTMLElement | null = null;
    segs.forEach((seg, i) => {
      const isLast = i === segs.length - 1;
      let node = convo.querySelector<HTMLElement>(`:scope > [data-turn="${CSS.escape(seg.key)}"]`);
      const fresh = !node;
      if (!node) {
        node = document.createElement("div");
        node.className = "tv-turn";
        node.dataset.turn = seg.key;
        if (!fullRender) node.classList.add("is-new");
      }
      if (fresh || fullRender || dirtyTurns.has(seg.key) || isLast) morphInner(node, turnHtml(rt!, seg, isLast, rs));
      node.classList.toggle("is-last", isLast);
      const want: ChildNode | null = prev ? prev.nextSibling : convo.firstChild;
      if (want !== node) convo.insertBefore(node, want);
      prev = node;
    });
    dirtyTurns.clear();
    fullRender = false;
    linkPaths();
    if (nearBottom) toBottom();
    updateJump();
  }

  // ---------------------------------------------------------------- paths

  /** abs path (lowercased) -> 0 missing, 1 file, 2 folder; -1 asking. */
  const pathKinds = new Map<string, number>();
  let missesAt = 0;

  function pathOf(raw: string, cwd: string): string | null {
    let t = raw.trim().replace(/^["'`]|["'`]$/g, "");
    if (!t || t.length > 260 || /^[a-z]+:\/\//i.test(t) || /[\s*?<>|]/.test(t.replace(/ /g, ""))) return null;
    t = t.replace(/:\d+(?::\d+)?$/, ""); // file.ts:42
    // A path needs a separator or an extension; bare words stay words.
    if (!/[\\/]/.test(t) && !/^[\w.-]+\.[a-z0-9]{1,8}$/i.test(t) && !/^[\w.-]{2,}$/.test(t)) return null;
    if (/^[\d.]+$/.test(t)) return null; // 1.4.1
    const abs = /^[a-z]:[\\/]/i.test(t) || t.startsWith("\\\\") ? t : `${cwd.replace(/[\\/]$/, "")}\\${t.replace(/^\.[\\/]/, "")}`;
    return abs.replace(/\//g, "\\");
  }

  /** Inline code in the agent's replies that names a real file or folder
   *  becomes a link: files open in the viewer, folders in Explorer. */
  function linkPaths(): void {
    if (!rt) return;
    const cwd = rt.meta.cwd;
    const ask: string[] = [];
    for (const c of convo.querySelectorAll<HTMLElement>(".tv-prose code")) {
      if (c.closest("pre")) continue;
      const abs = pathOf(c.textContent ?? "", cwd);
      if (!abs) continue;
      const k = pathKinds.get(abs.toLowerCase());
      if (k === undefined) {
        pathKinds.set(abs.toLowerCase(), -1);
        ask.push(abs);
      } else if (k > 0) {
        c.classList.add("tv-path", k === 2 ? "is-dir" : "is-file");
        c.dataset.path = abs;
        c.title = k === 2 ? `Open ${abs} in Explorer` : `Open ${abs}`;
      }
    }
    if (ask.length)
      void invoke<number[]>("paths_kind", { paths: ask })
        .then((kinds) => {
          kinds.forEach((k, i) => pathKinds.set(ask[i].toLowerCase(), k));
          if (kinds.some((k) => k > 0)) linkPaths();
        })
        .catch(() => ask.forEach((p) => pathKinds.set(p.toLowerCase(), 0)));
  }

  function renderHero(): void {
    if (!rt) return;
    const m = rt.meta;
    const recent = engine
      .list()
      .filter((r) => r !== rt && r.meta.cwd.toLowerCase() === m.cwd.toLowerCase() && !r.meta.archived && r.meta.stats.turns)
      .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
      .slice(0, 3);
    const html = `
      <div class="tv-hero-inner">
        <div class="tv-hero-glyph ${m.harness}">${markSvg(m.harness)}</div>
        <h2 class="tv-hero-title">What should we work on?</h2>
        <div class="tv-seg" role="radiogroup" aria-label="Agent" data-on="${m.harness}">
          ${(["claude", "codex"] as Harness[])
            .map(
              (hn) =>
                `<button class="tv-seg-btn ${hn === m.harness ? "on" : ""}" data-hero="harness" data-harness="${hn}" role="radio" aria-checked="${hn === m.harness}" type="button"><span class="tv-harness-mark ${hn}">${markSvg(hn)}</span>${esc(HARNESS_LABEL[hn])}</button>`
            )
            .join("")}
        </div>
        <button class="tv-hero-folder" data-hero="folder" type="button" title="${esc(m.cwd)}">${ic("folder", 13)}<span class="tv-hero-folder-name">${esc(folderLabel(m.cwd))}</span><span class="tv-hero-change">Change</span></button>
        <div class="tv-suggest">
          ${SUGGESTIONS.map((s) => `<button class="tv-suggest-btn" data-hero="suggest" data-text="${esc(s.text)}" type="button" title="${esc(s.text)}">${ic(s.icon, 13)}<span>${esc(s.label)}</span></button>`).join("")}
        </div>
        ${
          recent.length
            ? `<div class="tv-recent"><div class="tv-recent-label">Recent in ${esc(folderLabel(m.cwd))}</div>${recent
                .map((r) => `<button class="tv-recent-row" data-hero="open" data-id="${esc(r.meta.id)}" type="button">${ic("chats", 13)}<span>${esc(r.meta.title)}</span><span class="tv-recent-time">${ago(r.meta.updatedAt)}</span></button>`)
                .join("")}</div>`
            : ""
        }
      </div>`;
    morphInner(hero, html);
  }

  function renderHead(): void {
    if (!rt) return;
    const m = rt.meta;
    if (document.activeElement !== titleEl) titleEl.textContent = m.title;
    titleEl.classList.toggle("is-naming", engine.naming.has(m.id));
    folderChip.querySelector("span")!.textContent = folderLabel(m.cwd);
    folderChip.title = rt.order.length ? `${m.cwd} (click to copy)` : `${m.cwd} (click to change)`;
    const st = rt.approvals.length ? "waiting" : rt.busy || rt.run === "starting" ? "running" : "";
    liveDot.hidden = !st;
    liveDot.className = `tv-live-dot ${st}`;
    liveDot.title = st === "waiting" ? "Needs you" : "Working";
    el.querySelector<HTMLElement>('[data-head="terminal"]')!.hidden = !(m.resumable && m.sessionId);
  }

  function renderComposer(): void {
    if (!rt) return;
    const m = rt.meta;
    modelBtn.querySelector(".tv-pick-mark")!.innerHTML = markSvg(m.harness);
    modelBtn.querySelector(".tv-pick-mark")!.className = `tv-pick-mark ${m.harness}`;
    modelBtn.querySelector(".tv-pick-label")!.textContent = modelLabel(rt);
    modeBtn.querySelector(".tv-pick-icon")!.innerHTML = ic(MODE_ICON[m.mode] as any, 13);
    modeBtn.querySelector(".tv-pick-label")!.textContent = MODE_LABEL[m.mode];
    modeBtn.dataset.mode = m.mode;
    modeBtn.title = MODE_HINT[m.mode];
    const choice = modelChoice(m.harness, m.model);
    const efforts = choice?.efforts ?? [];
    effortBtn.hidden = !efforts.length;
    if (efforts.length) {
      const cur = m.effort && efforts.includes(m.effort) ? m.effort : null;
      const lvl = cur ?? choice?.defaultEffort ?? null;
      effortBtn.querySelector(".tv-pick-icon")!.innerHTML = effortGlyph(efforts, lvl);
      effortBtn.querySelector(".tv-pick-label")!.textContent = lvl ? (EFFORT_LABEL[lvl] ?? lvl) : "Auto";
      effortBtn.title = `Thinking intensity: ${cur ? EFFORT_LABEL[cur] ?? cur : "the model's default"}. Higher thinks harder and longer.`;
      effortBtn.dataset.level = lvl ?? "";
    }
    const busy = rt.busy;
    const hasText = !!input.value.trim() || attachments.length > 0;
    const approval = rt.approvals[0];
    sendBtn.classList.toggle("is-stop", busy && !hasText && !approval);
    sendBtn.innerHTML = busy && !hasText && !approval ? ic("stop", 13) : ic("arrowUp", 15);
    sendBtn.title = approval
      ? hasText
        ? "Decline and send these instructions instead"
        : "Allow (Enter)"
      : busy
        ? hasText
          ? "Queue this message (Enter)"
          : "Stop (Esc)"
        : "Send (Enter)";
    sendBtn.disabled = !busy && !hasText && !approval;
    input.placeholder = approval
      ? approval.kind === "question"
        ? "Or type your own answer…"
        : "Tell the agent what to do instead…"
      : busy
        ? "Add a follow-up. It sends when the agent finishes…"
        : rt.order.length
          ? "Reply…"
          : `Ask ${HARNESS_LABEL[m.harness]} to do something…`;
    footHint.innerHTML = approval
      ? approval.kind === "question"
        ? `Pick an answer, or type your own<i></i><kbd>Esc</kbd> skip`
        : `<kbd>Enter</kbd> ${approval.kind === "plan" ? "approve" : "allow"}<i></i><kbd>Esc</kbd> ${approval.kind === "plan" ? "keep planning" : "decline"}<i></i>type to steer instead`
      : busy
      ? `<kbd>Esc</kbd> stop<i></i><kbd>Enter</kbd> queue`
      : `<kbd>Enter</kbd> send<i></i><kbd>Shift</kbd>+<kbd>Enter</kbd> new line<i></i><kbd>/</kbd> commands`;
    // Context ring.
    const used = rt.context.used;
    const frac = rt.context.window ? Math.min(1, used / rt.context.window) : 0;
    const fill = ctxEl.querySelector<SVGCircleElement>(".tv-ctx-fill")!;
    const len = 2 * Math.PI * 7.5;
    fill.style.strokeDasharray = `${len}`;
    fill.style.strokeDashoffset = `${len * (1 - frac)}`;
    ctxEl.classList.toggle("warn", frac > 0.7);
    ctxEl.classList.toggle("hot", frac > 0.88);
    ctxEl.hidden = used === 0;
    ctxEl.querySelector(".tv-ctx-label")!.textContent = `${Math.round(frac * 100)}%`;
    ctxEl.title = `Context: ${fmtTokens(used)} of ${fmtTokens(rt.context.window)} tokens used`;
  }

  function renderPlan(): void {
    if (!rt?.todos?.length) {
      plan.hidden = true;
      return;
    }
    const todos = rt.todos;
    const done = todos.filter((t) => t.status === "completed").length;
    const cur = todos.find((t) => t.status === "in_progress");
    plan.hidden = false;
    plan.classList.toggle("is-open", planOpen);
    const pct = Math.round((done / todos.length) * 100);
    morphInner(
      plan,
      `<button class="tv-plan-head" data-act="plan" type="button">
        <span class="tv-plan-ring" style="--p:${pct}"></span>
        <span class="tv-plan-now">${esc(cur ? cur.active || cur.text : done === todos.length ? "All steps done" : todos.find((t) => t.status === "pending")?.text ?? "")}</span>
        <span class="tv-plan-count">${done}/${todos.length}</span>
        <span class="tv-chev">${ic("caretRight", 9)}</span>
      </button>
      ${
        planOpen
          ? `<ol class="tv-plan-list">${todos
              .map((t) => `<li class="is-${t.status}"><span class="tv-plan-box">${t.status === "completed" ? ic("check", 9) : ""}</span><span>${esc(t.text)}</span></li>`)
              .join("")}</ol>`
          : ""
      }`
    );
  }

  function approvalPreview(a: Approval): string {
    const i = a.input ?? {};
    if (a.tool === "Bash" || a.tool === "PowerShell")
      return `<div class="tv-cmd big"><span class="tv-cmd-sigil">${a.tool === "PowerShell" ? "PS" : "$"}</span><code>${esc(i.command ?? "")}</code></div>${
        i.description ? `<div class="tv-sheet-why">${esc(i.description)}</div>` : ""
      }`;
    if (a.tool === "Edit" || a.tool === "MultiEdit" || a.tool === "Write" || a.tool === "Patch") {
      const t = { name: a.tool, input: i, result: undefined };
      const path = a.tool === "Patch" ? "" : relPath(i.file_path);
      return `${path ? `<div class="tv-file-head">${ic("fileText", 12)}<span>${esc(path)}</span></div>` : ""}<div class="tv-sheet-diff">${editDiffHtml(t)}</div>`;
    }
    if (a.tool === "WebFetch") return `<div class="tv-cmd big"><code>${esc(i.url ?? "")}</code></div>`;
    const json = JSON.stringify(i, null, 2);
    return json && json !== "{}" ? `<pre class="tv-out">${esc(json.slice(0, 4000))}</pre>` : "";
  }

  function renderSheet(): void {
    const a = rt?.approvals[0];
    if (!rt || !a) {
      sheet.hidden = true;
      sheet.innerHTML = "";
      composer.classList.remove("has-sheet");
      return;
    }
    sheet.hidden = false;
    composer.classList.add("has-sheet");
    const who = HARNESS_LABEL[rt.meta.harness].split(" ")[0];
    const more = rt.approvals.length > 1 ? `<span class="tv-sheet-count">1 of ${rt.approvals.length}</span>` : "";
    let html = "";
    if (a.kind === "question" && a.questions?.length) {
      const picked = answers.get(a.key) ?? new Map<string, string[]>();
      answers.set(a.key, picked);
      const qs = a.questions
        .map(
          (q, qi) => `
          <div class="tv-q">
            ${q.header ? `<span class="tv-q-tag">${esc(q.header)}</span>` : ""}
            <div class="tv-q-text">${esc(q.question)}</div>
            <div class="tv-q-opts">
              ${q.options
                .map((o, oi) => {
                  const on = (picked.get(q.question) ?? []).includes(o.label);
                  return `<button class="tv-q-opt ${on ? "on" : ""} ${q.multiSelect ? "multi" : ""}" data-act="answer" data-q="${qi}" data-o="${oi}" type="button">
                    <span class="tv-q-key">${on ? ic("check", 10) : oi + 1}</span>
                    <span class="tv-q-label">${esc(o.label)}${o.description ? `<span class="tv-q-desc">${esc(o.description)}</span>` : ""}</span>
                  </button>`;
                })
                .join("")}
            </div>
          </div>`
        )
        .join("");
      const ready = a.questions.every((q) => (picked.get(q.question) ?? []).length > 0);
      html = `
        <div class="tv-sheet-head"><span class="tv-sheet-icon q">${ic("question", 14)}</span><span class="tv-sheet-title">${esc(who)} has a question</span>${more}</div>
        <div class="tv-sheet-body">${qs}</div>
        <div class="tv-sheet-actions">
          <button class="tv-btn ghost" data-act="deny" type="button">Skip</button>
          <button class="tv-btn primary" data-act="submit-answers" type="button" ${ready ? "" : "disabled"}>Send answers</button>
        </div>`;
    } else if (a.kind === "plan") {
      html = `
        <div class="tv-sheet-head"><span class="tv-sheet-icon plan">${ic("map", 14)}</span><span class="tv-sheet-title">${esc(who)} has a plan</span>${more}</div>
        <div class="tv-sheet-body tv-sheet-plan tv-prose">${renderMarkdown(String(a.input?.plan ?? "The plan is ready."))}</div>
        <div class="tv-sheet-actions">
          <button class="tv-btn ghost" data-act="deny" type="button" title="Reject and keep planning (Esc). Type feedback below first to say why.">Keep planning</button>
          <span class="tv-grow"></span>
          <button class="tv-btn" data-act="approve-plan" data-next="ask" type="button">Approve, ask before edits</button>
          <button class="tv-btn primary" data-act="approve-plan" data-next="edits" type="button">Approve and build <kbd>Enter</kbd></button>
        </div>`;
    } else {
      const look = lookOf({ name: a.tool, input: a.input });
      const verb =
        a.tool === "Bash" || a.tool === "PowerShell"
          ? "run a command"
          : a.tool === "Write"
            ? `create ${baseName(String(a.input?.file_path ?? "a file"))}`
            : a.tool === "Edit" || a.tool === "MultiEdit" || a.tool === "Patch"
              ? `edit ${a.tool === "Patch" ? "files" : baseName(String(a.input?.file_path ?? "a file"))}`
              : a.tool === "WebFetch"
                ? "open a web page"
                : `use ${look.verb}${look.target && !look.mono ? ` (${look.target})` : ""}`;
      html = `
        <div class="tv-sheet-head"><span class="tv-sheet-icon">${ic(look.icon, 14)}</span><span class="tv-sheet-title">${esc(who)} wants to ${esc(verb)}</span>${more}</div>
        <div class="tv-sheet-body">${approvalPreview(a)}${a.description && !/^(Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|Patch)$/.test(a.tool) ? `<div class="tv-sheet-why">${esc(a.description)}</div>` : ""}</div>
        <div class="tv-sheet-actions">
          <button class="tv-btn ghost" data-act="deny" type="button">Decline <kbd>Esc</kbd></button>
          <span class="tv-grow"></span>
          ${a.canAlways ? `<button class="tv-btn" data-act="allow-always" type="button" title="Don't ask again for this kind of action in this conversation">Allow for this chat <kbd>Alt+A</kbd></button>` : ""}
          <button class="tv-btn primary" data-act="allow" type="button">Allow <kbd>Enter</kbd></button>
        </div>`;
    }
    const sig = `${a.key}|${html.length}|${html}`;
    if (sheet.dataset.sig !== sig) {
      const freshKey = sheet.dataset.key !== a.key;
      sheet.dataset.sig = sig;
      sheet.dataset.key = a.key;
      sheet.innerHTML = `<div class="tv-sheet-card">${html}</div>`;
      if (freshKey) {
        sheet.classList.remove("enter");
        void sheet.offsetWidth;
        sheet.classList.add("enter");
      }
    }
  }

  function renderQueue(): void {
    if (!rt) return;
    const queued = rt.order.map((id) => rt!.items.get(id)).filter((it) => it?.kind === "user" && it.queued);
    queueEl.hidden = !queued.length;
    morphInner(
      queueEl,
      queued
        .map(
          (q) =>
            `<div class="tv-queued" data-key="${esc(q!.id)}">${ic("clock", 12)}<span class="tv-queued-text">${esc(q!.kind === "user" ? q!.text : "")}</span><span class="tv-queued-tag">Queued</span><button class="tv-queued-x" data-act="unqueue" data-id="${esc(q!.id)}" type="button" title="Remove from queue">${ic("x", 12)}</button></div>`
        )
        .join("")
    );
  }

  function renderInspector(): void {
    if (!rt || !inspectorOn) return;
    morphInner(inspInner, inspectorHtml(rt));
    fitInspector();
  }

  /** Everything fits the drawer: changed files show as many rows as there
   *  is room for, then a count of the rest. Nothing scrolls. */
  function fitInspector(): void {
    const box = inspInner.querySelector<HTMLElement>(".tv-files");
    const more = inspInner.querySelector<HTMLElement>(".tv-files-more");
    if (!box || !more) return;
    const rows = Array.from(box.querySelectorAll<HTMLElement>(".tv-file"));
    for (const r of rows) r.hidden = false;
    more.hidden = true;
    const limit = box.getBoundingClientRect().bottom + 0.5;
    let hidden = 0;
    for (const r of rows) {
      if (r.getBoundingClientRect().bottom > limit) {
        r.hidden = true;
        hidden++;
      }
    }
    if (hidden) {
      // Make room for the "+N more" line itself.
      more.hidden = false;
      const last = rows.filter((r) => !r.hidden).pop();
      if (last && more.getBoundingClientRect().bottom > inspInner.getBoundingClientRect().bottom) {
        last.hidden = true;
        hidden++;
      }
      more.textContent = `+${hidden} more file${hidden > 1 ? "s" : ""}`;
    }
  }

  function inspectorHtml(rt: Runtime): string {
    const m = rt.meta;
    const s = m.stats;
    const files = [...rt.files.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed));
    const tools = new Map<string, number>();
    const agents: { id: string; name: string; status: string; ms: number }[] = [];
    for (const it of rt.items.values()) {
      if (it.kind !== "tool" || it.parent) continue;
      const v = lookOf(it).verb;
      tools.set(v, (tools.get(v) ?? 0) + 1);
      if (it.name === "Task" || it.name === "Agent")
        agents.push({ id: it.id, name: String(it.input?.description ?? "Sub-agent"), status: it.status, ms: (it.endAt ?? Date.now()) - it.at });
    }
    const sorted = [...tools.entries()].sort((a, b) => b[1] - a[1]);
    const topTools = sorted.slice(0, 4);
    const rest = sorted.slice(4).reduce((n, t) => n + t[1], 0);
    if (rest) topTools.push(["Other", rest]);
    const totalTools = Math.max(1, sorted.reduce((n, t) => n + t[1], 0));
    const ctxPct = rt.context.window ? Math.min(100, (rt.context.used / rt.context.window) * 100) : 0;
    const ctxTone = ctxPct > 88 ? "hot" : ctxPct > 70 ? "warn" : "";
    const R = 23;
    const C = 2 * Math.PI * R;
    const st = rt.approvals.length ? "wait" : rt.busy || rt.run === "starting" ? "run" : "idle";
    const stLabel = st === "wait" ? "Needs you" : st === "run" ? "Working" : rt.run === "sleeping" ? "Asleep" : "Idle";
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const stat = (label: string, value: string, title = "") =>
      `<div class="tv-stat" ${title ? `title="${esc(title)}"` : ""}><span class="tv-stat-value">${value}</span><span class="tv-stat-label">${label}</span></div>`;
    return `
      <div class="tv-insp-head">
        <span class="tv-insp-title">Inspector</span>
        <span class="tv-insp-status st-${st}"><i></i>${stLabel}</span>
        <button class="tv-ibtn small" data-head="inspector" type="button" title="Close">${ic("x", 13)}</button>
      </div>
      <section class="tv-insp-card tv-insp-ctx ${ctxTone}">
        <svg class="tv-ring" viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">
          <circle cx="28" cy="28" r="${R}" class="tv-ring-track"/>
          <circle cx="28" cy="28" r="${R}" class="tv-ring-fill" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - ctxPct / 100)).toFixed(2)}"/>
        </svg>
        <span class="tv-ring-val">${Math.round(ctxPct)}<small>%</small></span>
        <div class="tv-ctx-info">
          <span class="tv-insp-label">Context window</span>
          <span class="tv-ctx-big">${fmtTokens(rt.context.used)}<span> / ${fmtTokens(rt.context.window)}</span></span>
          <span class="tv-ctx-sub">${s.tokensOut ? `${fmtTokens(s.tokensIn)} in · ${fmtTokens(s.tokensOut)} out this chat` : "No tokens used yet"}</span>
        </div>
      </section>
      <section class="tv-insp-card tv-stats">
        ${stat("Working", s.ms ? fmtDuration(s.ms) : "–")}
        ${stat("Turns", String(s.turns))}
        ${stat("Steps", String(s.tools))}
        ${stat("Files", String(rt.files.size || s.files || 0))}
        ${stat("Tokens", s.tokensOut ? fmtTokens(s.tokensIn + s.tokensOut) : "–")}
        ${stat("API value", s.cost ? `$${s.cost.toFixed(s.cost < 1 ? 3 : 2)}` : "–", s.cost ? "What this would cost on the API" : "")}
      </section>
      ${
        rt.rate.length
          ? `<section class="tv-insp-sec tv-limits"><div class="tv-insp-label">Plan limits</div>${rt.rate
              .slice(0, 3)
              .map(
                (r) => `<div class="tv-limit"><div class="tv-limit-row"><span>${esc(r.label)}</span>${
                  r.resetsAt ? `<span class="tv-limit-reset">resets ${new Date(r.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>` : ""
                }<b>${Math.round(r.used * 100)}%</b></div><div class="tv-meter ${r.used > 0.85 ? "hot" : r.used > 0.6 ? "warn" : ""}"><span style="width:${(r.used * 100).toFixed(1)}%"></span></div></div>`
              )
              .join("")}</section>`
          : ""
      }
      <section class="tv-insp-sec tv-insp-files">
        <div class="tv-insp-label">Changed files <span class="tv-insp-count">${files.length}</span>${
          files.length ? `<span class="tv-insp-delta">${added ? `<span class="tv-add">+${added}</span>` : ""}${removed ? `<span class="tv-del">−${removed}</span>` : ""}</span>` : ""
        }</div>
        ${
          files.length
            ? `<div class="tv-files">${files
                .map((f) => {
                  const rel = relPath(f.path);
                  const name = baseName(rel);
                  const dir = rel.slice(0, Math.max(0, rel.length - name.length)).replace(/[\\/]$/, "");
                  return `<button class="tv-file" data-act="open-file" data-path="${esc(f.path)}" type="button" title="${esc(f.path)}">
                    <span class="tv-file-kind k-${f.kind}">${f.kind === "create" ? "A" : f.kind === "delete" ? "D" : "M"}</span>
                    <span class="tv-file-name"><span>${esc(name)}</span>${dir ? `<span class="tv-file-dir">${esc(dir)}</span>` : ""}</span>
                    <span class="tv-file-delta">${f.added ? `<span class="tv-add">+${f.added}</span>` : ""}${f.removed ? `<span class="tv-del">−${f.removed}</span>` : ""}</span>
                  </button>`;
                })
                .join("")}</div><div class="tv-files-more" hidden></div>`
            : `<div class="tv-insp-empty">${ic("files", 18)}<span>Files the agent changes show up here</span></div>`
        }
      </section>
      ${
        agents.length
          ? `<section class="tv-insp-sec tv-insp-agents"><div class="tv-insp-label">Sub-agents <span class="tv-insp-count">${agents.length}</span></div>${agents
              .slice(-3)
              .map(
                (a) =>
                  `<button class="tv-insp-agent st-${a.status}" data-act="goto" data-id="${esc(a.id)}" type="button"><span class="tv-insp-agent-dot"></span><span class="tv-insp-agent-name">${esc(a.name)}</span><span class="tv-insp-agent-time">${fmtDuration(a.ms)}</span></button>`
              )
              .join("")}</section>`
          : ""
      }
      ${
        topTools.length
          ? `<section class="tv-insp-sec tv-kinds"><div class="tv-insp-label">Steps by kind</div>
              <div class="tv-kind-bar">${topTools.map(([k, n], i) => `<span class="c${i}" style="flex:${n}" title="${esc(k)}: ${n}"></span>`).join("")}</div>
              <div class="tv-kind-legend">${topTools.map(([k, n], i) => `<span class="tv-kind"><i class="c${i}"></i><span class="tv-kind-name">${esc(k)}</span><b>${Math.round((n / totalTools) * 100)}%</b></span>`).join("")}</div>
            </section>`
          : ""
      }
      <footer class="tv-insp-meta">
        <span class="tv-insp-who"><span class="tv-insp-mark ${m.harness}">${markSvg(m.harness)}</span><span><b>${esc(rt.liveModel ? prettyModel(rt.liveModel, m.harness) : modelLabel(rt))}</b><span>${esc(HARNESS_LABEL[m.harness])}${m.effort ? ` · ${esc(EFFORT_LABEL[m.effort] ?? m.effort)} effort` : ""}</span></span></span>
        <span class="tv-insp-when">${new Date(m.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${
          m.sessionId ? `<button class="tv-copy-id" data-copy-text="${esc(m.sessionId)}" type="button" title="Copy session id">${esc(m.sessionId.slice(0, 8))}${ic("copy", 10)}</button>` : ""
        }</span>
      </footer>`;
  }


  // ---------------------------------------------------------------- scroll

  function toBottom(): void {
    scroll.scrollTop = scroll.scrollHeight;
  }

  function updateJump(): void {
    const away = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 160;
    jump.hidden = !away;
    jump.classList.toggle("is-live", !!rt?.busy);
  }

  scroll.addEventListener(
    "scroll",
    () => {
      pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
      updateJump();
    },
    { passive: true }
  );
  jump.addEventListener("click", () => {
    pinned = true;
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
  });
  new ResizeObserver(() => {
    if (pinned) toBottom();
  }).observe(convo);
  const dock = $<HTMLElement>(".tv-dock");
  new ResizeObserver(() => {
    el.style.setProperty("--dock-h", `${dock.offsetHeight}px`);
    if (pinned) toBottom();
  }).observe(dock);

  // Live elapsed clock in the "working" line, without re-rendering the turn.
  window.setInterval(() => {
    if (!rt?.busy) return;
    const t = convo.querySelector<HTMLElement>("[data-elapsed]");
    if (t) t.textContent = fmtDuration(Date.now() - Number(t.dataset.elapsed));
  }, 1000);

  // ---------------------------------------------------------------- changes

  function onChange(c: Change): void {
    if (!rt) return;
    switch (c.t) {
      case "item": {
        // A file just written may have been looked up (and missed) before.
        if (Date.now() - missesAt > 3000) {
          missesAt = Date.now();
          for (const [p, k] of pathKinds) if (k === 0) pathKinds.delete(p);
        }
        const k = turnKeyOf(c.id);
        schedule(false, k ?? undefined);
        break;
      }
      case "reset":
        schedule(true);
        renderAll();
        break;
      case "status":
        schedule(false);
        renderHead();
        renderComposer();
        renderQueue();
        break;
      case "meta":
        renderHead();
        renderComposer();
        scheduleInspector();
        break;
      case "approvals":
        renderSheet();
        renderComposer();
        renderHead();
        if (rt.approvals.length && document.activeElement !== input) focusComposer();
        break;
      case "todos":
        renderPlan();
        break;
      case "usage":
        renderComposer();
        scheduleInspector();
        break;
    }
    if (c.t === "item") scheduleInspector();
  }

  let inspQueued = false;
  function scheduleInspector(): void {
    if (!inspectorOn || inspQueued) return;
    inspQueued = true;
    window.setTimeout(() => {
      inspQueued = false;
      renderInspector();
    }, 250);
  }

  function renderAll(): void {
    renderHead();
    renderComposer();
    renderPlan();
    renderSheet();
    renderQueue();
    renderInspector();
    schedule(true);
  }

  async function show(id: string | null, focusItem?: string): Promise<void> {
    const next = engine.get(id);
    if (next !== rt) {
      off?.();
      off = null;
      rt = next;
      rs.open.clear();
      rs.closed.clear();
      rs.flash = null;
      convo.innerHTML = "";
      attachments = [];
      renderAttachments();
      mention.close();
      planOpen = false;
      pinned = true;
      el.classList.toggle("is-none", !rt);
      if (!rt) return;
      setToolBase(rt.meta.cwd);
      off = rt.on(onChange);
      input.value = rt.a.draft ?? "";
      autosize();
      el.classList.add("switching");
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("switching")));
      renderAll();
      void engine.ensureLoaded(rt).then(() => {
        if (rt === next) {
          schedule(true);
          renderAll();
          requestAnimationFrame(toBottom);
        }
      });
      void refreshBranch();
    }
    engine.markSeen(rt);
    if (rt && focusItem) {
      rs.flash = focusItem;
      schedule(true);
      window.setTimeout(() => {
        const node = convo.querySelector<HTMLElement>(`[data-step="${CSS.escape(focusItem)}"]`);
        node?.scrollIntoView({ block: "center", behavior: "smooth" });
        pinned = false;
      }, 80);
      window.setTimeout(() => {
        if (rs.flash === focusItem) {
          rs.flash = null;
          rs.open.add(focusItem);
          schedule(true);
        }
      }, 1600);
    }
  }

  async function refreshBranch(): Promise<void> {
    if (!rt) return;
    const want = rt;
    const { host } = await import("./host");
    const b = await host.gitBranch(want.meta.cwd);
    if (want !== rt) return;
    branchChip.hidden = !b;
    branchChip.querySelector("span")!.textContent = b ?? "";
  }

  // ---------------------------------------------------------------- composer

  function autosize(): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.38))}px`;
    paintMirror();
  }

  /** Mentions in the draft get a soft highlight drawn behind the text. */
  function paintMirror(): void {
    const v = input.value;
    if (!v.includes("@")) {
      if (mirror.innerHTML) mirror.innerHTML = "";
      return;
    }
    mirror.innerHTML =
      esc(v).replace(/(^|[\s(])(@(?:\[[^\]\n]+\]|&quot;[^\n]*?&quot;|[^\s@]+))/g, (_m, pre, tag) => `${pre}<span class="${tag.startsWith("@[") ? "t" : "f"}">${tag}</span>`) + "\n";
    mirror.scrollTop = input.scrollTop;
  }
  input.addEventListener("scroll", () => (mirror.scrollTop = input.scrollTop), { passive: true });

  function renderAttachments(): void {
    attachEl.hidden = !attachments.length;
    attachEl.innerHTML = attachments
      .map((a, i) => {
        const x = `<button class="tv-att-x" data-act="unattach" data-i="${i}" type="button" title="Remove">${ic("x", 10)}</button>`;
        if (a.kind === "image") return `<span class="tv-att img" title="${esc(a.name)}"><img src="${a.url}" alt="" />${x}</span>`;
        const k = fileKind(a.name);
        const dir = a.path.slice(0, Math.max(0, a.path.length - a.name.length)).replace(/[\\/]$/, "");
        return `<span class="tv-att file" title="${esc(a.path)}"><span class="tv-fext k-${k.kind}">${esc(k.ext)}</span><span class="tv-att-meta"><span class="tv-att-name">${esc(a.name)}</span><span class="tv-att-sub">${esc(a.size != null ? fmtBytes(a.size) : nameOf(dir) || dir)}</span></span>${x}</span>`;
      })
      .join("");
    renderComposer();
  }

  function readDataUrl(f: Blob): Promise<string> {
    return new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(f);
    });
  }

  function hasPath(path: string): boolean {
    return attachments.some((a) => a.kind === "file" && a.path.toLowerCase() === path.toLowerCase());
  }

  /** Files from the clipboard have no path: small images go inline, the
   *  rest is saved to a temp folder so the agent can open it. */
  async function addBlobs(files: File[]): Promise<void> {
    for (const f of files) {
      const url = await readDataUrl(f);
      const data = url.slice(url.indexOf(",") + 1);
      const name = f.name || (f.type.startsWith("image/") ? `pasted.${f.type.split("/")[1] || "png"}` : "pasted-file");
      if (f.type.startsWith("image/") && f.size <= MAX_IMAGE_BYTES) {
        attachments.push({ kind: "image", url, name, image: { mediaType: f.type, data } });
        continue;
      }
      try {
        const path = await invoke<string>("save_attachment", { name, data });
        attachments.push({ kind: "file", path, name: nameOf(path), size: f.size });
      } catch {
        /* unreadable clipboard item: skip it */
      }
    }
    renderAttachments();
  }

  /** Files from disk (picker or drop): images inline, anything else by path. */
  async function addPaths(paths: string[]): Promise<void> {
    for (const p of paths) {
      if (hasPath(p)) continue;
      if (IMAGE_EXT.test(p)) {
        try {
          const blob = await (await fetch(convertFileSrc(p))).blob();
          if (blob.size <= MAX_IMAGE_BYTES) {
            const ext = p.split(".").pop()!.toLowerCase();
            const type = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
            const url = await readDataUrl(new Blob([blob], { type }));
            attachments.push({ kind: "image", url, name: nameOf(p), image: { mediaType: type, data: url.slice(url.indexOf(",") + 1) } });
            continue;
          }
        } catch {
          /* fall back to sending the path */
        }
      }
      attachments.push({ kind: "file", path: p, name: nameOf(p) });
    }
    renderAttachments();
  }

  async function pickFiles(): Promise<void> {
    if (!rt) return;
    const picked = await openDialog({ multiple: true, title: "Attach files", defaultPath: rt.meta.cwd }).catch(() => null);
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    if (paths.length) await addPaths(paths.map(String));
    input.focus();
  }

  function commands(): { name: string; description: string }[] {
    if (!rt) return [];
    const base = rt.commands.length
      ? rt.commands
      : rt.meta.harness === "claude"
        ? [
            { name: "compact", description: "Summarise the conversation to free up context" },
            { name: "review", description: "Review the current changes" },
            { name: "init", description: "Write a CLAUDE.md for this project" },
          ]
        : [];
    return base;
  }

  function renderSlash(): void {
    const v = input.value;
    const m = /^\/(\S*)$/.exec(v);
    if (!m || !rt) {
      slash.hidden = true;
      return;
    }
    const q = m[1].toLowerCase();
    const list = commands()
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
      .slice(0, 8);
    if (!list.length) {
      slash.hidden = true;
      return;
    }
    slashIndex = Math.min(slashIndex, list.length - 1);
    slash.hidden = false;
    slash.innerHTML = list
      .map(
        (c, i) =>
          `<button class="tv-slash-item ${i === slashIndex ? "on" : ""}" data-act="slash" data-name="${esc(c.name)}" type="button"><span class="tv-slash-name">/${esc(c.name)}</span><span class="tv-slash-desc">${esc(c.description.split("\n")[0].slice(0, 110))}</span></button>`
      )
      .join("");
  }

  function pickSlash(name: string): void {
    input.value = `/${name} `;
    slash.hidden = true;
    autosize();
    input.focus();
    renderComposer();
  }

  async function submit(): Promise<void> {
    if (!rt) return;
    const text = input.value;
    const a = rt.approvals[0];
    if (a) {
      if (text.trim()) {
        if (a.kind === "question") answerFreeText(a, text.trim());
        else engine.decide(rt, a.key, { behavior: "deny", message: text.trim() });
        clearInput();
      } else if (a.kind === "tool") engine.decide(rt, a.key, { behavior: "allow" });
      else if (a.kind === "plan") engine.decide(rt, a.key, { behavior: "allow", nextMode: "edits" });
      return;
    }
    if (!text.trim() && !attachments.length) {
      if (rt.busy) engine.interrupt(rt);
      return;
    }
    const extra = await threadBriefs(text, rt);
    const imgs = attachments.filter((x): x is Extract<Attachment, { kind: "image" }> => x.kind === "image");
    const files = attachments.flatMap((x) => (x.kind === "file" ? [x.path] : []));
    clearInput();
    attachments = [];
    renderAttachments();
    pinned = true;
    await engine.send(
      rt,
      text,
      imgs.map((x) => x.image),
      imgs.map((x) => x.url),
      files,
      extra
    );
  }

  function clearInput(): void {
    input.value = "";
    if (rt) rt.a.draft = "";
    autosize();
    slash.hidden = true;
    renderComposer();
  }

  function answerFreeText(a: Approval, text: string): void {
    if (!rt) return;
    const q = a.questions?.[0]?.question ?? "Answer";
    const ans: Record<string, string> = {};
    for (const qq of a.questions ?? []) ans[qq.question] = (answers.get(a.key)?.get(qq.question) ?? []).join(", ");
    ans[q] = text;
    engine.decide(rt, a.key, { behavior: "allow", updatedInput: { ...a.input, answers: ans } });
  }

  const mention = createMention({
    input,
    host: composer,
    current: () => rt,
    changed: () => {
      if (rt) rt.a.draft = input.value;
      autosize();
      renderComposer();
    },
  });

  input.addEventListener("input", () => {
    if (rt) rt.a.draft = input.value;
    autosize();
    slashIndex = 0;
    renderSlash();
    renderComposer();
    mention.refresh();
  });

  input.addEventListener("keydown", (e) => {
    if (mention.key(e)) return;
    if (!slash.hidden) {
      const items = slash.querySelectorAll<HTMLElement>(".tv-slash-item");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        renderSlash();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const on = items[slashIndex];
        if (on) {
          e.preventDefault();
          pickSlash(on.dataset.name!);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        slash.hidden = true;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Escape" && rt) {
      const a = rt.approvals[0];
      if (a) {
        e.preventDefault();
        engine.decide(rt, a.key, { behavior: "deny", message: input.value.trim() || undefined });
        clearInput();
        return;
      }
      if (rt.busy) {
        e.preventDefault();
        engine.interrupt(rt);
      }
      return;
    }
    if (e.altKey && (e.key === "a" || e.key === "A") && rt?.approvals[0]?.canAlways) {
      e.preventDefault();
      engine.decide(rt, rt.approvals[0].key, { behavior: "allow", always: true });
      return;
    }
    if (e.key === "ArrowUp" && !input.value && rt) {
      // Edit-last-prompt convenience: recall the previous message.
      const last = [...rt.order].reverse().map((id) => rt!.items.get(id)).find((it) => it?.kind === "user");
      if (last?.kind === "user") {
        e.preventDefault();
        input.value = last.text;
        autosize();
        renderComposer();
      }
    }
  });

  input.addEventListener("paste", (e) => {
    // Screenshots (Win+Shift+S) arrive as clipboard items, not always as files.
    const dt = e.clipboardData;
    const files = [
      ...Array.from(dt?.files ?? []),
      ...Array.from(dt?.items ?? [])
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f),
    ].filter((f, i, all) => all.findIndex((g) => g.size === f.size && g.type === f.type && g.name === f.name) === i);
    if (files.length) {
      e.preventDefault();
      void addBlobs(files);
    }
  });

  // Files dragged in from Windows arrive through the native drop handler
  // (HTML5 drag events never reach the page): images become attachments,
  // anything else is mentioned by path, which the agent can read itself.
  registerFileDropZone({
    el,
    setHover(on) {
      el.classList.toggle("dropping", on && !!rt);
    },
    drop(paths) {
      if (!rt) return;
      void addPaths(paths).then(() => input.focus());
    },
  });

  sendBtn.addEventListener("click", () => {
    if (!rt) return;
    if (rt.busy && !input.value.trim() && !attachments.length && !rt.approvals.length) engine.interrupt(rt);
    else void submit();
  });
  el.querySelector(".tv-attach")!.addEventListener("click", () => void pickFiles());
  composer.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    input.focus();
  });

  /** Model picker: the current generation on one page, older models one
   *  click away, both agents side by side until the first message. The
   *  lists come from the CLIs themselves, so new models appear on their own. */
  function openModelPicker(): void {
    if (!rt) return;
    const cur = rt;
    let box: HTMLElement | null = null;
    let older = false;
    const rows = () => Array.from(box?.querySelectorAll<HTMLButtonElement>(".tv-mp-row, .tv-mp-more") ?? []);
    const pop = openPopover(
      modelBtn,
      () => {
        box = document.createElement("div");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "Model");
        return box;
      },
      { place: "above", width: 320, className: "tv-mp" },
      (e) => {
        if (!box) return false;
        if (arrowNav(box, e, ".tv-mp-row, .tv-mp-more")) return true;
        if (older && (e.key === "Backspace" || e.key === "ArrowLeft")) {
          e.preventDefault();
          older = false;
          fill();
          return true;
        }
        return false;
      }
    );
    if (!pop || !box) return;
    const host: HTMLElement = box;
    /** The row a thread on the CLI default counts as. */
    const isOn = (m: ModelChoice, list: ModelChoice[]) => {
      if (cur.meta.model) return m.id === cur.meta.model;
      const d = list.find((x) => x.id === null);
      return !!d?.resolved && m.id !== null && (m.resolved ?? m.id) === d.resolved;
    };
    const fill = () => {
      const h = cur.meta.harness;
      const all = modelList(h);
      const real = all.filter((m) => m.id !== null);
      const latest = h === "claude" ? real.filter((m) => !m.id!.startsWith("claude-")) : real;
      const old = h === "claude" ? real.filter((m) => m.id!.startsWith("claude-")) : [];
      const onOld = old.some((m) => isOn(m, all));
      const row = (m: ModelChoice, compact = false) => {
        const on = isOn(m, all);
        const big = /\[1m\]/i.test(m.id ?? "") ? `<span class="tv-mp-tag">1M</span>` : "";
        return `<button class="tv-mp-row ${on ? "on" : ""} ${compact ? "compact" : ""}" data-model="${esc(m.id ?? "")}" type="button">
          <span class="tv-mp-text"><span class="tv-mp-name">${esc(m.label)}${big}</span>${m.hint ? `<span class="tv-mp-hint">${esc(m.hint)}</span>` : ""}</span>
          <span class="tv-mp-check">${on ? ic("check", 12) : ""}</span>
        </button>`;
      };
      const canSwitch = !cur.order.length;
      const head = older
        ? `<button class="tv-mp-back" data-back type="button">${ic("caretRight", 10)}<span>Older models</span><span class="tv-mp-title-sub">${old.length}</span></button>`
        : canSwitch
          ? `<div class="tv-mp-seg tv-seg" data-on="${h}" role="radiogroup" aria-label="Agent">${(["claude", "codex"] as Harness[])
              .map(
                (hn) =>
                  `<button class="tv-seg-btn ${hn === h ? "on" : ""}" data-harness="${hn}" role="radio" aria-checked="${hn === h}" type="button"><span class="tv-harness-mark ${hn}">${markSvg(hn)}</span>${esc(HARNESS_LABEL[hn])}</button>`
              )
              .join("")}</div>`
          : `<div class="tv-mp-title"><span class="tv-harness-mark ${h}">${markSvg(h)}</span>${esc(HARNESS_LABEL[h])}</div>`;
      host.innerHTML = `
        <div class="tv-mp-head">${head}</div>
        <div class="tv-mp-list ${older ? "is-older" : ""}">
          ${older ? old.map((m) => row(m, true)).join("") : latest.map((m) => row(m)).join("")}
        </div>
        ${
          !older && old.length
            ? `<button class="tv-mp-more ${onOld ? "has-on" : ""}" data-older type="button"><span>Older models</span><span class="tv-mp-more-n">${onOld ? "In use · " : ""}${old.length}</span>${ic("caretRight", 10)}</button>`
            : ""
        }`;
      pop.place();
      requestAnimationFrame(() => (host.querySelector<HTMLElement>(".tv-mp-row.on") ?? rows()[0])?.focus({ preventScroll: true }));
    };
    fill();
    host.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-older]")) {
        older = true;
        fill();
        return;
      }
      if (t.closest("[data-back]")) {
        older = false;
        fill();
        return;
      }
      const hb = t.closest<HTMLElement>("[data-harness]");
      if (hb) {
        engine.setHarness(cur, hb.dataset.harness as Harness);
        renderAll();
        fill();
        return;
      }
      const r = t.closest<HTMLElement>(".tv-mp-row");
      if (!r) return;
      const id = r.dataset.model || null;
      pop.close();
      const next = modelChoice(cur.meta.harness, id);
      if (cur.meta.effort && !(next?.efforts ?? []).includes(cur.meta.effort)) void engine.setEffort(cur, null);
      void engine.setModel(cur, id);
      focusComposer();
    });
  }

  modelBtn.addEventListener("click", openModelPicker);

  effortBtn.addEventListener("click", () => {
    if (!rt) return;
    const cur = rt;
    const choice = modelChoice(cur.meta.harness, cur.meta.model);
    const efforts = choice?.efforts ?? [];
    if (!efforts.length) return;
    const def = choice?.defaultEffort;
    openMenu(
      effortBtn,
      [
        {
          id: "",
          label: def ? `Default (${EFFORT_LABEL[def] ?? def})` : "Auto",
          hint: def ? "What this model uses unless told otherwise" : "Let Claude Code decide per model",
          iconHtml: effortGlyph(efforts, def ?? null),
          checked: !cur.meta.effort,
        },
        { id: "", label: "", sep: true },
        ...efforts.map((x) => ({
          id: x,
          label: EFFORT_LABEL[x] ?? x,
          hint: choice?.effortHints?.[x] ?? EFFORT_HINT[x],
          iconHtml: effortGlyph(efforts, x),
          checked: cur.meta.effort === x,
        })),
      ],
      (id) => {
        void engine.setEffort(cur, id || null);
        focusComposer();
      },
      { title: "Thinking intensity", place: "above", width: 280, className: "tv-effort-menu" }
    );
  });

  modeBtn.addEventListener("click", () => {
    if (!rt) return;
    const cur = rt;
    openMenu(
      modeBtn,
      MODES.map((m) => ({ id: m, label: MODE_LABEL[m], hint: MODE_HINT[m], icon: MODE_ICON[m] as any, checked: m === cur.meta.mode, danger: m === "auto" })),
      (id) => void engine.setMode(cur, id as PermissionMode),
      { title: "Permissions", place: "above", width: 290 }
    );
  });

  // ---------------------------------------------------------------- clicks

  function copyText(text: string, btn?: HTMLElement): void {
    void navigator.clipboard.writeText(text).then(() => {
      if (!btn) return;
      btn.classList.add("copied");
      window.setTimeout(() => btn.classList.remove("copied"), 1200);
    });
  }

  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const link = t.closest<HTMLAnchorElement>("a[data-ext]");
    if (link) {
      e.preventDefault();
      h.onOpenUrl(link.getAttribute("href") ?? "");
      return;
    }
    const pathLink = t.closest<HTMLElement>("code.tv-path");
    if (pathLink?.dataset.path && !window.getSelection()?.toString()) {
      e.preventDefault();
      if (pathLink.classList.contains("is-dir")) void invoke("reveal_in_explorer", { path: pathLink.dataset.path });
      else h.onOpenFile(pathLink.dataset.path);
      return;
    }
    const codeCopy = t.closest<HTMLElement>("[data-copy]");
    if (codeCopy) {
      const code = codeCopy.closest(".th-code")?.querySelector("code")?.textContent ?? "";
      copyText(code, codeCopy);
      codeCopy.textContent = "Copied";
      window.setTimeout(() => (codeCopy.textContent = "Copy"), 1200);
      return;
    }
    const copyBtn = t.closest<HTMLElement>("[data-copy-text]");
    if (copyBtn) {
      copyText(copyBtn.dataset.copyText ?? "", copyBtn);
      return;
    }
    const head = t.closest<HTMLElement>("[data-head]");
    if (head && rt) {
      const what = head.dataset.head;
      if (what === "inspector") {
        inspectorOn = !inspectorOn;
        writePref(INSPECTOR_KEY, inspectorOn);
        el.classList.toggle("insp-on", inspectorOn);
        renderInspector();
      } else if (what === "terminal") h.onContinueInTerminal(rt);
      else if (what === "menu") h.onThreadMenu(rt.meta.id, head);
      else if (what === "folder") {
        if (!rt.order.length) void pickFolder();
        else copyText(rt.meta.cwd, head);
      }
      return;
    }
    const heroBtn = t.closest<HTMLElement>("[data-hero]");
    if (heroBtn && rt) {
      const what = heroBtn.dataset.hero;
      if (what === "folder") void pickFolder();
      else if (what === "harness") {
        engine.setHarness(rt, heroBtn.dataset.harness as Harness);
        renderAll();
      } else if (what === "suggest") {
        input.value = heroBtn.dataset.text ?? "";
        autosize();
        renderComposer();
        input.focus();
      } else if (what === "open") void show(heroBtn.dataset.id!);
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]");
    if (!act || !rt) return;
    const id = act.dataset.id ?? "";
    switch (act.dataset.act) {
      case "step":
        if (rs.open.has(id)) {
          rs.open.delete(id);
          rs.closed.add(id);
        } else {
          rs.open.add(id);
          rs.closed.delete(id);
        }
        pinned = false;
        schedule(false, turnKeyOf(id) ?? undefined);
        break;
      case "group": {
        const k = act.dataset.key!;
        if (rs.open.has(k)) rs.open.delete(k);
        else rs.open.add(k);
        pinned = false;
        schedule(true);
        break;
      }
      case "prompt":
        if (rs.open.has(`p:${id}`)) rs.open.delete(`p:${id}`);
        else rs.open.add(`p:${id}`);
        schedule(true);
        break;
      case "open-file":
        e.stopPropagation();
        h.onOpenFile(act.dataset.path!);
        break;
      case "goto":
        void show(rt.meta.id, id);
        break;
      case "retry": {
        const last = [...rt.order].reverse().map((x) => rt!.items.get(x)).find((it) => it?.kind === "user");
        if (last?.kind === "user") void engine.send(rt, last.text);
        break;
      }
      case "copy-turn": {
        const idx = rt.order.indexOf(id);
        const texts: string[] = [];
        for (let i = idx - 1; i >= 0; i--) {
          const it = rt.items.get(rt.order[i]);
          if (!it || it.kind === "user") break;
          if (it.kind === "text") texts.unshift(it.text);
        }
        copyText(texts.join("\n\n"), act);
        break;
      }
      case "plan":
        planOpen = !planOpen;
        renderPlan();
        break;
      case "fig-toggle": {
        const k = "fig:" + id;
        if (rs.closed.has(k)) rs.closed.delete(k);
        else rs.closed.add(k);
        pinned = false;
        schedule(false, turnKeyOf(id) ?? undefined);
        break;
      }
      case "fig-open":
        openLightbox(act.dataset.src ?? "", act.dataset.path ?? "", act.dataset.caption ?? "");
        break;
      case "unqueue":
        engine.cancelQueued(rt, id);
        break;
      case "unattach":
        attachments.splice(Number(act.dataset.i), 1);
        renderAttachments();
        break;
      case "slash":
        pickSlash(act.dataset.name!);
        break;
      case "allow":
        if (rt.approvals[0]) engine.decide(rt, rt.approvals[0].key, { behavior: "allow" });
        break;
      case "allow-always":
        if (rt.approvals[0]) engine.decide(rt, rt.approvals[0].key, { behavior: "allow", always: true });
        break;
      case "deny":
        if (rt.approvals[0]) {
          engine.decide(rt, rt.approvals[0].key, { behavior: "deny", message: input.value.trim() || undefined });
          clearInput();
        }
        break;
      case "approve-plan":
        if (rt.approvals[0]) engine.decide(rt, rt.approvals[0].key, { behavior: "allow", nextMode: act.dataset.next as PermissionMode });
        break;
      case "answer": {
        const a = rt.approvals[0];
        const q = a?.questions?.[Number(act.dataset.q)];
        const o = q?.options[Number(act.dataset.o)];
        if (!a || !q || !o) break;
        const picked = answers.get(a.key) ?? new Map();
        answers.set(a.key, picked);
        const cur: string[] = picked.get(q.question) ?? [];
        picked.set(q.question, q.multiSelect ? (cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label]);
        // A single single-choice question answers on the first click.
        if (!q.multiSelect && a.questions!.length === 1) {
          submitAnswers(a);
          break;
        }
        renderSheet();
        break;
      }
      case "submit-answers":
        if (rt.approvals[0]) submitAnswers(rt.approvals[0]);
        break;
    }
  });

  el.addEventListener("keydown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tv-step-row[data-act]");
    if (row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      row.click();
    }
  });

  // ---------------------------------------------------------------- lightbox

  const lightbox = $<HTMLElement>(".tv-lightbox");
  const lbImg = lightbox.querySelector("img")!;
  let lbPath = "";
  function openLightbox(src: string, path: string, caption: string): void {
    if (!src) return;
    lbPath = path;
    lbImg.src = src;
    lightbox.querySelector<HTMLElement>(".tv-lightbox-cap")!.textContent = caption || baseName(path);
    lightbox.hidden = false;
    lightbox.classList.remove("show");
    void lightbox.offsetWidth;
    lightbox.classList.add("show");
  }
  function closeLightbox(): void {
    lightbox.hidden = true;
    lbImg.removeAttribute("src");
  }
  lightbox.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-lb]");
    e.stopPropagation();
    if (b?.dataset.lb === "open") {
      closeLightbox();
      h.onOpenFile(lbPath);
    } else if (b?.dataset.lb === "copy") {
      copyText(lbPath, b);
      b.textContent = "Copied";
      window.setTimeout(() => (b.textContent = "Copy path"), 1200);
    } else if (!(e.target as HTMLElement).closest(".tv-lightbox-bar")) closeLightbox();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !lightbox.hidden) {
        e.preventDefault();
        e.stopPropagation();
        closeLightbox();
      }
    },
    true
  );
  // An image that can't load says so instead of showing a broken icon.
  el.addEventListener(
    "error",
    (e) => {
      const img = e.target as HTMLElement;
      if (img instanceof HTMLImageElement) img.closest(".tv-figure")?.classList.add("is-broken");
    },
    true
  );

  function submitAnswers(a: Approval): void {
    if (!rt) return;
    const picked = answers.get(a.key) ?? new Map<string, string[]>();
    const ans: Record<string, string> = {};
    for (const q of a.questions ?? []) ans[q.question] = (picked.get(q.question) ?? []).join(", ");
    engine.decide(rt, a.key, { behavior: "allow", updatedInput: { ...a.input, answers: ans } });
    answers.delete(a.key);
  }

  async function pickFolder(): Promise<void> {
    if (!rt || rt.order.length) return;
    const dir = await h.onPickFolder(rt.meta.cwd);
    if (!dir || !rt) return;
    engine.setCwd(rt, dir);
    setToolBase(dir);
    renderAll();
    void refreshBranch();
  }

  titleEl.addEventListener("dblclick", () => {
    if (!rt) return;
    titleEl.contentEditable = "plaintext-only";
    titleEl.classList.add("editing");
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  const endRename = (save: boolean) => {
    if (titleEl.contentEditable !== "plaintext-only") return;
    titleEl.contentEditable = "false";
    titleEl.classList.remove("editing");
    if (rt && save) engine.rename(rt, titleEl.textContent ?? "");
    if (rt) titleEl.textContent = rt.meta.title;
  };
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      endRename(true);
      input.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      endRename(false);
    }
  });
  titleEl.addEventListener("blur", () => endRename(true));

  function insertText(text: string): void {
    const at = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, at) + text + input.value.slice(input.selectionEnd ?? at);
    if (rt) rt.a.draft = input.value;
    autosize();
    renderComposer();
    input.focus();
  }

  function focusComposer(): void {
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  // ---------------------------------------------------------------- zoom

  let zoom = (() => {
    try {
      const v = Number(localStorage.getItem(ZOOM_KEY));
      return v >= 0.7 && v <= 1.6 ? v : 1;
    } catch {
      return 1;
    }
  })();
  let toastTimer = 0;
  const applyZoom = () => el.style.setProperty("--tv-zoom", String(zoom));
  applyZoom();

  /** Ctrl+= / Ctrl+- / Ctrl+0: the conversation's text size. */
  function zoomBy(step: number): void {
    const keep = pinned ? null : scroll.scrollTop / Math.max(1, scroll.scrollHeight);
    zoom = step === 0 ? 1 : Math.min(1.6, Math.max(0.7, Math.round((zoom + step * 0.1) * 10) / 10));
    applyZoom();
    autosize();
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      /* convenience only */
    }
    if (pinned) toBottom();
    else if (keep !== null) scroll.scrollTop = keep * scroll.scrollHeight;
    zoomToast.textContent = `${Math.round(zoom * 100)}%`;
    zoomToast.hidden = false;
    zoomToast.classList.remove("show");
    void zoomToast.offsetWidth;
    zoomToast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (zoomToast.hidden = true), 1100);
  }

  new ResizeObserver(() => {
    if (inspectorOn) fitInspector();
  }).observe(inspInner);

  return {
    el,
    show,
    focusComposer,
    current: () => rt,
    startRename(): void {
      titleEl.dispatchEvent(new MouseEvent("dblclick"));
    },
    closeMenus: closeMenu,
    zoom: zoomBy,
    /** Text typed or dropped from elsewhere in the app (file paths). */
    insertText,
  };
}

export type ThreadView = ReturnType<typeof createThreadView>;
export type { TurnItem };
