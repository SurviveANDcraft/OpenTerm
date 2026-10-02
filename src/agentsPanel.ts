/** The Agents panel: a right-hand sidebar listing every agent, and an
 *  assistant that answers questions about them and, in Act or Auto mode, acts
 *  on them (every action it wants approved shows up as a card in the thread).
 *
 *  It sits in the layout (not over it), so the session area simply narrows
 *  while it's open: terminals refit, and embedded browsers never paint over
 *  it. The agent list is pure local state and costs nothing; only the
 *  assistant and the optional AI summaries use the OpenRouter key. */

import { store } from "./store";
import { playAttentionChime } from "./attention";
import { openExternalUrl, panes } from "./terminals";
import { markSvg, shellBrand, type PaneBrand } from "./paneIcons";
import { registerPaneDropZone } from "./paneDropZones";
import { registerFileDropZone } from "./fileDropZones";
import { chatFile, fileBlock, type ChatFile } from "./agentsFiles";
import {
  agentByPane,
  cachedLastPrompt,
  lastPrompt,
  lastScreenLine,
  listAgents,
  paneOfRef,
  refOf,
  screenExcerpt,
  visibleSessions,
  type AgentInfo,
  type AgentStatus,
  type Scope,
} from "./agentsData";
import { Conversation, type ActionStep } from "./agentsAssistant";
import { paneState, type ActionHost, type ActionPlan } from "./agentsActions";
import { MODES, effectiveMode, isModeUnlocked, type ModeDef } from "./agentsModes";
import {
  cardSummary,
  isSummarizing,
  onCardSummary,
  refreshSummaries,
  summariesEnabled,
} from "./agentsSummary";
import { fetchPaneUsage, fmtCost } from "./usage";
import { AGENTS_PANEL_WIDTH_MAX, AGENTS_PANEL_WIDTH_MIN } from "./types";
import { icon, type IconName } from "./agentsIcons";
import { createVoiceView } from "./voice/voiceView";

export interface AgentsPanelHost {
  focusPane(sessionId: string, paneId: string): void;
  openAiSettings(): void;
  /** The panel opened, closed or resized: refit the session area. */
  onLayoutChange(): void;
  /** Give keyboard focus back to the workspace (Esc from the composer). */
  focusWorkspace(): void;
  /** Pane operations the assistant's action tools run. */
  actions: ActionHost;
}

const DOCS_URL = "https://openterm.app/documentation#agents-panel";

/** List refresh while open. Status flags are in-memory reads, so this is
 *  cheap; rows whose markup didn't change aren't touched. */
const TICK_MS = 1200;
/** Summary/prompt checks run on a slower beat, since they may touch disk. */
const SUMMARY_TICK_MS = 6000;
/** Cost per agent, read from transcripts: the slowest thing we show. */
const COST_TTL_MS = 30_000;

/** Rows needing the user float to the top, then busy ones, then the rest. */
const STATUS_ORDER: Record<AgentStatus, number> = { waiting: 0, error: 0, working: 1, idle: 2 };

const SUGGESTIONS = ["What's each agent doing?", "Who needs me?", "Anything failing?"];

const TOOL_ICON: Record<string, IconName> = {
  read_terminal: "terminal",
  search_terminals: "search",
  list_processes: "search",
  agent_details: "info",
  open_terminal: "plusSquare",
  split_pane: "split",
  close_pane: "xSquare",
  focus_pane: "crosshair",
  resize_pane: "resize",
  zoom_pane: "cornersOut",
  fold_pane: "fold",
  rename_pane: "pencil",
  run_command: "play",
  prompt_agent: "paperPlane",
  notify_when_done: "bell",
  list_sessions: "search",
  list_tasks: "search",
  usage_stats: "info",
  get_settings: "info",
  create_task: "plusSquare",
  update_task: "pencil",
  create_session: "plusSquare",
  update_session: "pencil",
  switch_session: "crosshair",
  toggle_panel: "cornersOut",
  set_setting: "pencil",
};

/** A step label, with `code` spans rendered as code. */
function stepLabel(label: string): string {
  return esc(label).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

/** Minute-grained age: rows re-render when it changes, so seconds would churn
 *  the DOM every tick for no real information. */
function coarseAgo(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function firstLine(s: string, max = 90): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** markSvg mints fresh gradient ids on every call (they must be unique per
 *  document), so its markup is never identical twice. Cached per owner, or
 *  every row would look "changed" and be rewritten on every refresh tick. */
const markCache = new Map<string, { brand: PaneBrand; svg: string }>();
function mark(owner: string, brand: PaneBrand): string {
  const hit = markCache.get(owner);
  if (hit && hit.brand === brand) return hit.svg;
  const svg = markSvg(brand);
  markCache.set(owner, { brand, svg });
  return svg;
}

/** The sidebar's status dot, orbit and all, so a busy agent reads the same in
 *  both places: green while the agent itself works, blue while sub-agents do. */
function orbit(kind: "run" | "sub"): string {
  return `<i class="ap-orbit ${kind}" aria-hidden="true"></i>`;
}

/** Sort rank: an idle parent with sub-agents in flight is busy, not idle. */
function rank(a: AgentInfo): number {
  return a.status === "idle" && a.subagents ? STATUS_ORDER.working : STATUS_ORDER[a.status];
}

function stateHtml(a: AgentInfo): string {
  // Sub-agents keep running while the parent sits between turns, so they're
  // shown whenever they exist, not only while the parent is "working".
  if (a.subagents && a.status !== "waiting" && a.status !== "error")
    return `<span class="ap-state s-sub" title="Sub-agents running">${orbit("sub")}${a.subagents} sub-agent${
      a.subagents === 1 ? "" : "s"
    }</span>`;
  switch (a.status) {
    case "working":
      return `<span class="ap-state s-working">${orbit("run")}${coarseAgo(a.since)}</span>`;
    case "waiting":
      return `<span class="ap-state s-waiting">${icon("bell", 11)}Needs you</span>`;
    case "error":
      return `<span class="ap-state s-error">${icon("warning", 11)}Error</span>`;
    default:
      return `<span class="ap-state s-idle">Idle ${coarseAgo(a.since)}</span>`;
  }
}

// ---------------------------------------------------------------- markdown

/** The answer's markup: a deliberately tiny subset (paragraphs, "- " lists,
 *  fenced and inline code, bold) over escaped text, plus [T3] refs turned into
 *  pane links. Anything else renders as the plain text it is. */
function renderAnswer(md: string): string {
  const out: string[] = [];
  const blocks = md.replace(/\r/g, "").split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      const body = block.replace(/^[\w-]*\n/, "");
      out.push(`<pre class="ap-code">${esc(body.replace(/\n$/, ""))}</pre>`);
      return;
    }
    for (const para of block.split(/\n{2,}/)) {
      const lines = para.split("\n").filter((l) => l.trim());
      if (!lines.length) continue;
      let list: string[] | null = null;
      const flush = (): void => {
        if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
        list = null;
      };
      const textLines: string[] = [];
      const flushText = (): void => {
        if (textLines.length) out.push(`<p>${textLines.map(inline).join("<br>")}</p>`);
        textLines.length = 0;
      };
      for (const l of lines) {
        const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
        if (m) {
          flushText();
          (list ??= []).push(m[1]);
        } else {
          flush();
          textLines.push(l);
        }
      }
      flush();
      flushText();
    }
  });
  return out.join("");
}

function inline(s: string): string {
  // House style has no em dashes; the prompt asks, this makes sure.
  return esc(s.replace(/\s*[—–]\s*/g, ", "))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(T\d+)\]|\b(T\d+)\b/g, (whole, a: string | undefined, b: string | undefined) => {
      const ref = (a ?? b)!;
      const id = paneOfRef(ref);
      const agent = id ? agentByPane(id) : null;
      // Bare "T3" only becomes a link when it really is one of our refs.
      if (!agent) return whole;
      return `<button class="ap-ref" data-pane="${esc(agent.paneId)}" title="Go to ${esc(agent.title)}">${esc(
        agent.title
      )}</button>`;
    });
}

const THINKING = `<span class="ap-thinking">Thinking</span>`;

// ---------------------------------------------------------------- panel

export function createAgentsPanel(host: AgentsPanelHost) {
  const el = document.createElement("aside");
  el.className = "agents-panel";
  el.innerHTML = `
    <div class="ap-resizer" title="Drag to resize"></div>
    <header class="ap-head">
      <div class="ap-switch" role="tablist" aria-label="View">
        <span class="ap-switch-thumb"></span>
        <button class="ap-switch-btn" data-view="agents" role="tab">Agents<span class="ap-switch-badge"></span></button>
        <button class="ap-switch-btn" data-view="chat" role="tab">Chat</button>
      </div>
      <button class="ap-icon-btn ap-close" title="Close">${icon("x", 15)}</button>
    </header>
    <div class="ap-subbar">
      <div class="ap-scope">
        <button class="ap-scope-btn" aria-haspopup="listbox" aria-expanded="false">
          <i class="ap-scope-dot"></i><span class="ap-scope-label">All sessions</span>${icon("caretDown", 12)}
        </button>
        <div class="ap-scope-menu" role="listbox" hidden></div>
      </div>
      <div class="ap-sub-right">
        <span class="ap-summary"></span>
        <span class="ap-spend"></span>
        <button class="ap-icon-btn ap-resummarize" title="Refresh AI summaries">${icon("sparkle", 15)}</button>
        <button class="ap-icon-btn ap-new-chat" title="New chat">${icon("notePencil", 15)}</button>
      </div>
    </div>
    <div class="ap-views">
      <section class="ap-view ap-agents-view">
        <div class="ap-list"></div>
        <div class="ap-shells"></div>
      </section>
      <section class="ap-view ap-chat">
        <div class="ap-thread"></div>
        <footer class="ap-composer">
          <div class="ap-field">
            <div class="ap-attached"></div>
            <div class="ap-input-row">
              <textarea class="ap-input" rows="1" spellcheck="false"></textarea>
              <button class="ap-voice-btn" title="Talk to the assistant" aria-label="Start a voice conversation">${icon("waveform", 16)}</button>
              <button class="ap-send" title="Send (Enter)"></button>
            </div>
          </div>
          <div class="ap-meta">
            <div class="ap-mode">
              <button class="ap-mode-btn" aria-haspopup="listbox" aria-expanded="false" title="Assistant mode">
                <span class="ap-mode-icon"></span><span class="ap-mode-label"></span>${icon("caretDown", 11)}
              </button>
              <div class="ap-mode-menu" role="listbox" aria-label="Assistant mode" hidden></div>
            </div>
            <span class="ap-disclaimer"><span class="ap-disclaimer-text"></span><button class="ap-learn">Learn more</button></span>
          </div>
        </footer>
      </section>
    </div>
    <div class="ap-drop"><div class="ap-drop-card">${icon("terminal", 18)}<span class="ap-drop-label">Ask about this terminal</span></div></div>
  `;

  // A slim tab on the window's right edge while a pane is dragged with the
  // panel closed. Dropping there opens the panel with that terminal attached.
  const edge = document.createElement("div");
  edge.className = "ap-edge-drop";
  edge.innerHTML = `${icon("chat", 15)}<span>Ask Agents</span>`;

  const $ = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
  const scopeBtn = $<HTMLButtonElement>(".ap-scope-btn");
  const scopeMenu = $(".ap-scope-menu");
  const scopeLabel = $(".ap-scope-label");
  const scopeDot = $(".ap-scope-dot");
  const summaryEl = $(".ap-summary");
  const switchBadge = $(".ap-switch-badge");
  const agentsView = $(".ap-agents-view");
  const listEl = $(".ap-list");
  const shellsEl = $(".ap-shells");
  const thread = $(".ap-thread");
  const input = $<HTMLTextAreaElement>(".ap-input");
  const sendBtn = $<HTMLButtonElement>(".ap-send");
  const attachedEl = $(".ap-attached");
  const spendEl = $(".ap-spend");
  const dropLabel = $(".ap-drop-label");
  const resummarizeBtn = $<HTMLButtonElement>(".ap-resummarize");
  const modeBtn = $<HTMLButtonElement>(".ap-mode-btn");
  const modeMenu = $(".ap-mode-menu");
  const modeIcon = $(".ap-mode-icon");
  const modeLabel = $(".ap-mode-label");
  const disclaimer = $(".ap-disclaimer");
  const disclaimerText = $(".ap-disclaimer-text");

  let open = false;
  let view: "agents" | "chat" = "agents";
  let scope: Scope = "all";
  let attached: string[] = [];
  /** Files dropped into the chat, sent with the next question. */
  let files: ChatFile[] = [];
  let shellsOpen = false;
  let tick: number | null = null;
  let summaryTick: number | null = null;
  const conversation = new Conversation();
  const history: string[] = [];
  let historyIdx = -1;
  const rowEls = new Map<string, { el: HTMLElement; html: string }>();
  const costs = new Map<string, { at: number; usd: number | null; pending: boolean }>();
  /** Last markup written to each region. Compared against instead of
   *  innerHTML, which the browser re-serialises and so never matches. */
  const shown = new Map<HTMLElement, string>();
  function setHtml(target: HTMLElement, html: string): void {
    if (shown.get(target) === html) return;
    shown.set(target, html);
    target.innerHTML = html;
  }

  // ------------------------------------------------------------ layout

  function applyWidth(w: number): void {
    const width = Math.max(AGENTS_PANEL_WIDTH_MIN, Math.min(AGENTS_PANEL_WIDTH_MAX, w));
    document.documentElement.style.setProperty("--agents-width", `${width}px`);
    store.state.settings.agentsPanelWidth = width;
  }

  function setOpen(next: boolean, focusInput = next): void {
    if (open === next) {
      if (next && focusInput && view === "chat") input.focus();
      return;
    }
    open = next;
    store.state.settings.agentsPanelVisible = next;
    document.querySelector(".app")?.classList.toggle("agents-open", next);
    store.save();
    host.onLayoutChange();
    if (next) {
      render();
      refreshSlow(true);
      tick = window.setInterval(render, TICK_MS);
      summaryTick = window.setInterval(() => refreshSlow(false), SUMMARY_TICK_MS);
      if (focusInput && view === "chat") requestAnimationFrame(() => input.focus());
    } else {
      if (tick !== null) window.clearInterval(tick);
      if (summaryTick !== null) window.clearInterval(summaryTick);
      tick = summaryTick = null;
      clearPeek();
      voice.end(); // no hot mic behind a closed panel
    }
  }

  const resizer = $(".ap-resizer");
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = store.state.settings.agentsPanelWidth;
    document.body.classList.add("resizing-agents");
    const move = (ev: PointerEvent): void => {
      applyWidth(startW - (ev.clientX - startX));
      host.onLayoutChange();
    };
    const up = (): void => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing-agents");
      store.save();
      host.onLayoutChange();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });

  // ------------------------------------------------------------ scope

  function renderScope(): void {
    const sessions = visibleSessions();
    if (scope !== "all" && !sessions.some((s) => s.id === scope)) scope = "all";
    const current = sessions.find((s) => s.id === scope);
    scopeLabel.textContent = current ? current.name : "All sessions";
    scopeDot.style.background = current ? current.color : "";
    scopeDot.hidden = !current;
    if (!scopeMenu.hidden) renderScopeMenu();
  }

  function renderScopeMenu(): void {
    const all = listAgents("all").filter((a) => a.brand);
    const item = (id: string, label: string, n: number, color?: string): string =>
      `<button class="ap-scope-item${scope === id ? " selected" : ""}" role="option" aria-selected="${
        scope === id
      }" data-scope="${esc(id)}">${
        color ? `<i style="background:${esc(color)}"></i>` : `<i class="all"></i>`
      }<span class="ap-scope-name">${esc(label)}</span><span class="ap-scope-count">${n}</span><span class="ap-scope-check">${icon(
        "check",
        11
      )}</span></button>`;
    setHtml(
      scopeMenu,
      [
        item("all", "All sessions", all.length),
        `<div class="ap-scope-sep"></div>`,
        ...visibleSessions().map((s) => item(s.id, s.name, all.filter((a) => a.sessionId === s.id).length, s.color)),
      ].join("")
    );
  }

  function setMenu(openMenu: boolean): void {
    scopeMenu.hidden = !openMenu;
    scopeBtn.setAttribute("aria-expanded", String(openMenu));
    scopeBtn.classList.toggle("open", openMenu);
    if (openMenu) renderScopeMenu();
  }

  scopeBtn.addEventListener("click", () => setMenu(scopeMenu.hidden));
  scopeMenu.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".ap-scope-item");
    if (!t) return;
    scope = t.dataset.scope ?? "all";
    setMenu(false);
    render();
    refreshSlow(false);
    updatePlaceholder();
  });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (!scopeMenu.hidden && !t.closest(".ap-scope")) setMenu(false);
    if (!modeMenu.hidden && !t.closest(".ap-mode")) setModeMenu(false);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!scopeMenu.hidden) {
      e.stopPropagation();
      setMenu(false);
      scopeBtn.focus();
    } else if (!modeMenu.hidden) {
      e.stopPropagation();
      setModeMenu(false);
      modeBtn.focus();
    }
  });

  // ------------------------------------------------------------ mode

  /** A locked mode the user picked, pending its switch in Settings. */
  let wantedMode: ModeDef | null = null;

  /** The mode in force. A mode whose switch was turned off in Settings falls
   *  back to Ask, and that fallback is saved. */
  function currentMode(): ModeDef {
    const s = store.state.settings;
    const m = effectiveMode(s);
    if (s.assistantMode !== m.id) {
      s.assistantMode = m.id;
      store.save();
    }
    return m;
  }

  function renderMode(): void {
    const m = currentMode();
    el.dataset.mode = m.id;
    modeIcon.innerHTML = icon(m.icon, 12);
    modeLabel.textContent = m.label;
    disclaimerText.textContent = m.disclaimer;
    disclaimer.title = m.disclaimer;
    if (!modeMenu.hidden) renderModeMenu();
  }

  function renderModeMenu(): void {
    const s = store.state.settings;
    const current = currentMode();
    setHtml(
      modeMenu,
      MODES.map((m) => {
        const unlocked = isModeUnlocked(m, s);
        const on = m.id === current.id;
        return `<button class="ap-mode-item${on ? " selected" : ""}${unlocked ? "" : " locked"}" role="option" aria-selected="${on}" data-mode="${m.id}"${
          unlocked ? "" : ` title="Turn on ${esc(m.label)} mode in Settings, AI"`
        }><span class="ap-mode-item-icon">${icon(m.icon, 14)}</span><span class="ap-mode-text"><span class="ap-mode-name">${esc(
          m.label
        )}</span><span class="ap-mode-hint">${esc(unlocked ? m.hint : "Enable in Settings")}</span></span><span class="ap-mode-end">${
          unlocked ? icon("check", 11) : icon("lock", 12)
        }</span></button>`;
      }).join("")
    );
  }

  function setModeMenu(openMenu: boolean): void {
    modeMenu.hidden = !openMenu;
    modeBtn.setAttribute("aria-expanded", String(openMenu));
    modeBtn.classList.toggle("open", openMenu);
    if (openMenu) {
      renderModeMenu();
      modeMenu.querySelector<HTMLElement>(".ap-mode-item.selected")?.focus();
    }
  }

  modeBtn.addEventListener("click", () => setModeMenu(modeMenu.hidden));
  modeMenu.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".ap-mode-item");
    const m = MODES.find((x) => x.id === t?.dataset.mode);
    if (!m) return;
    setModeMenu(false);
    if (!isModeUnlocked(m, store.state.settings)) {
      // Switched to as soon as Settings unlocks it (see refreshSettings).
      wantedMode = m;
      host.openAiSettings();
      return;
    }
    wantedMode = null;
    selectMode(m);
    input.focus();
  });

  function selectMode(m: ModeDef): void {
    store.state.settings.assistantMode = m.id;
    store.save();
    renderMode();
    updatePlaceholder();
  }
  modeMenu.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...modeMenu.querySelectorAll<HTMLElement>(".ap-mode-item")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  });
  $(".ap-learn").addEventListener("click", () => openExternalUrl(DOCS_URL));

  // ------------------------------------------------------------ views

  function setView(next: "agents" | "chat", focus = false): void {
    view = next;
    el.dataset.view = next;
    el.querySelectorAll<HTMLElement>(".ap-switch-btn").forEach((b) => {
      const on = b.dataset.view === next;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    render();
    if (focus && next === "chat") requestAnimationFrame(() => input.focus());
  }

  $(".ap-switch").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".ap-switch-btn");
    if (b) setView(b.dataset.view as "agents" | "chat", true);
  });

  // ------------------------------------------------------------ agent rows

  function rowHtml(a: AgentInfo): string {
    const sum = cardSummary(a.paneId);
    const prompt = cachedLastPrompt(a.paneId);
    const task = sum?.task || (prompt ? firstLine(prompt.text) : "");
    const pending = !sum && isSummarizing(a.paneId);
    const now = sum?.now || lastScreenLine(a.paneId);
    const cost = costs.get(a.paneId)?.usd;
    const isAttached = attached.includes(a.paneId);
    const promptTitle = prompt ? esc(prompt.text.slice(0, 600)) : "";
    return `
      <span class="ap-mark">${a.brand ? mark(`row:${a.paneId}`, a.brand) : ""}</span>
      <div class="ap-row-body">
        <div class="ap-row-top">
          <span class="ap-row-title" title="${esc(a.title)}">${esc(a.title)}</span>
          ${stateHtml(a)}
        </div>
        ${
          pending && !task
            ? `<div class="ap-row-task"><span class="ap-skeleton"></span></div>`
            : task
              ? `<div class="ap-row-task" title="${promptTitle}">${esc(task)}</div>`
              : ""
        }
        ${now ? `<div class="ap-row-now" title="${esc(now)}">${esc(now)}</div>` : ""}
        <div class="ap-row-meta">
          <span class="ap-row-session"><i style="background:${esc(a.sessionColor)}"></i>${esc(a.sessionName)}</span>
          ${cost ? `<span class="ap-row-cost" title="Spent in this terminal">${fmtCost(cost)}</span>` : ""}
          <button class="ap-ask${isAttached ? " on" : ""}" data-ask="${esc(a.paneId)}" title="${
            isAttached ? "Remove from your next question" : "Ask about this agent"
          }">${icon("chat", 12)}${isAttached ? "Attached" : "Ask"}</button>
        </div>
      </div>`;
  }

  function render(): void {
    if (!open) return;
    renderScope();
    const all = listAgents(scope);
    const agents = all
      .filter((a) => a.brand)
      .sort((x, y) => rank(x) - rank(y));
    const shells = all.filter((a) => !a.brand);
    const needYou = agents.filter((a) => a.status === "waiting" || a.status === "error").length;
    const working = agents.filter((a) => rank(a) === STATUS_ORDER.working).length;
    setHtml(
      summaryEl,
      needYou
        ? `<b>${needYou} need${needYou === 1 ? "s" : ""} you</b>`
        : agents.length
          ? `${agents.length} agent${agents.length === 1 ? "" : "s"}${working ? `, ${working} working` : ""}`
          : ""
    );
    switchBadge.textContent = needYou ? String(needYou) : "";

    // Keyed update: only rows whose markup changed are rewritten, so hover
    // and button focus survive the refresh tick.
    const seen = new Set<string>();
    let prev: HTMLElement | null = null;
    for (const a of agents) {
      seen.add(a.paneId);
      let entry = rowEls.get(a.paneId);
      if (!entry) {
        const row = document.createElement("article");
        row.dataset.pane = a.paneId;
        entry = { el: row, html: "" };
        rowEls.set(a.paneId, entry);
      }
      entry.el.className = `ap-row s-${a.status}${attached.includes(a.paneId) ? " attached" : ""}`;
      const html = rowHtml(a);
      if (html !== entry.html) {
        entry.el.innerHTML = html;
        entry.html = html;
      }
      const want: Element | null = prev ? prev.nextElementSibling : listEl.firstElementChild;
      if (want !== entry.el) listEl.insertBefore(entry.el, want);
      prev = entry.el;
    }
    for (const [id, entry] of rowEls) {
      if (!seen.has(id)) {
        entry.el.remove();
        rowEls.delete(id);
      }
    }
    const empty = listEl.querySelector(".ap-empty");
    if (!agents.length && !empty) {
      listEl.insertAdjacentHTML(
        "beforeend",
        `<div class="ap-empty">Start Claude Code, Codex or another agent in a terminal and it appears here.</div>`
      );
    } else if (agents.length) empty?.remove();

    const shellMark = mark("shell", shellBrand(store.state.settings.shell));
    setHtml(
      shellsEl,
      shells.length
        ? `<button class="ap-shells-toggle${shellsOpen ? " open" : ""}">${icon("caretDown", 11)}${shells.length} other terminal${
            shells.length === 1 ? "" : "s"
          }</button>${
            shellsOpen
              ? `<div class="ap-shell-list">${shells
                  .map(
                    (s) =>
                      `<div class="ap-shell" data-pane="${esc(s.paneId)}"><span class="ap-mark">${shellMark}</span><span class="ap-shell-title">${esc(
                        s.title
                      )}</span><span class="ap-shell-session">${esc(s.sessionName)}</span><button class="ap-ask${
                        attached.includes(s.paneId) ? " on" : ""
                      }" data-ask="${esc(s.paneId)}" title="Ask about this terminal">${
                        attached.includes(s.paneId) ? "Attached" : "Ask"
                      }</button></div>`
                  )
                  .join("")}</div>`
              : ""
          }`
        : ""
    );
    renderAttached();
  }

  /** Slow-beat work: last prompts, costs and AI summaries for rows in view. */
  function refreshSlow(force: boolean): void {
    if (!open) return;
    const agents = listAgents(scope).filter((a) => a.brand);
    for (const a of agents) {
      void lastPrompt(a.paneId).then(() => render());
      const c = costs.get(a.paneId);
      if (!c || (!c.pending && Date.now() - c.at > COST_TTL_MS)) {
        costs.set(a.paneId, { at: Date.now(), usd: c?.usd ?? null, pending: true });
        void fetchPaneUsage(a.paneId)
          .then((u) => costs.set(a.paneId, { at: Date.now(), usd: u.cost_usd || null, pending: false }))
          .catch(() => costs.set(a.paneId, { at: Date.now(), usd: null, pending: false }))
          .finally(render);
      }
    }
    refreshSummaries(agents, force);
    resummarizeBtn.hidden = !summariesEnabled();
  }

  onCardSummary(() => {
    if (open) render();
  });

  // Hovering a row outlines its pane, so you can see which one it is.
  let peeked: HTMLElement | null = null;
  function clearPeek(): void {
    peeked?.classList.remove("ap-peek");
    peeked = null;
  }
  function peek(paneId: string | null): void {
    const target = paneId ? (panes.get(paneId)?.el ?? null) : null;
    if (target === peeked) return;
    clearPeek();
    if (target) {
      target.classList.add("ap-peek");
      peeked = target;
    }
  }

  function goTo(paneId: string): void {
    const a = agentByPane(paneId);
    if (!a) return;
    host.focusPane(a.sessionId, paneId);
    const target = panes.get(paneId)?.el;
    if (target) {
      target.classList.remove("ap-flash");
      void target.offsetWidth;
      target.classList.add("ap-flash");
      window.setTimeout(() => target.classList.remove("ap-flash"), 900);
    }
  }

  agentsView.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".ap-shells-toggle")) {
      shellsOpen = !shellsOpen;
      render();
      return;
    }
    const ask = t.closest<HTMLElement>("[data-ask]");
    if (ask) {
      // "Ask" is a way into the chat: attach, then take the user there.
      if (!attached.includes(ask.dataset.ask!)) attach(ask.dataset.ask!);
      setView("chat", true);
      return;
    }
    const row = t.closest<HTMLElement>("[data-pane]");
    if (row) goTo(row.dataset.pane!);
  });
  agentsView.addEventListener("pointerover", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-pane]");
    peek(row?.dataset.pane ?? null);
  });
  agentsView.addEventListener("pointerleave", () => peek(null));

  // ------------------------------------------------------------ attachments

  function attach(paneId: string): void {
    if (!panes.has(paneId)) return;
    if (!attached.includes(paneId)) attached.push(paneId);
    render();
    updatePlaceholder();
  }

  function renderAttached(): void {
    attached = attached.filter((id) => panes.has(id));
    const html = attached
      .map((id) => {
        const a = agentByPane(id);
        if (!a) return "";
        const glyph = mark(`att:${id}`, a.brand ?? shellBrand(store.state.settings.shell));
        return `<span class="ap-att" data-pane="${esc(id)}"><span class="ap-mark">${glyph}</span><span class="ap-att-name">${esc(
          a.title
        )}</span><button data-detach="${esc(id)}" title="Remove">${icon("x", 10)}</button></span>`;
      })
      .join("");
    const fileHtml = files
      .map(
        (f) =>
          `<span class="ap-att" title="${esc(f.path)}">${icon("file", 13)}<span class="ap-att-name">${esc(
            f.name
          )}</span><button data-unfile="${esc(f.path)}" title="Remove">${icon("x", 10)}</button></span>`
      )
      .join("");
    setHtml(attachedEl, html + fileHtml);
    attachedEl.hidden = !attached.length && !files.length;
  }

  attachedEl.addEventListener("click", (e) => {
    const f = (e.target as HTMLElement).closest<HTMLElement>("[data-unfile]");
    if (f) {
      files = files.filter((x) => x.path !== f.dataset.unfile);
      render();
      input.focus();
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-detach]");
    if (b) {
      attached = attached.filter((id) => id !== b.dataset.detach);
      render();
      updatePlaceholder();
      input.focus();
    }
  });

  registerPaneDropZone({
    el,
    accepts: (id: string) => panes.has(id),
    setHover: (id: string | null) => {
      el.classList.toggle("drop-hover", id !== null);
      if (id) dropLabel.textContent = `Ask about ${panes.get(id)?.title ?? "this terminal"}`;
    },
    drop: (id: string) => {
      attach(id);
      setView("chat", true);
    },
  });
  // Files, from the Files view or from Windows, attach the same way.
  registerFileDropZone({
    el,
    setHover: (on) => {
      el.classList.toggle("drop-hover", on);
      if (on) dropLabel.textContent = "Attach to your question";
    },
    drop: (paths) => {
      for (const p of paths) if (!files.some((f) => f.path === p)) files.push(chatFile(p));
      setView("chat", true);
    },
  });
  registerPaneDropZone({
    el: edge,
    accepts: (id) => !open && panes.has(id),
    setHover: (id) => edge.classList.toggle("hover", id !== null),
    drop: (id) => {
      setOpen(true, false);
      attach(id);
      setView("chat", true);
    },
  });

  // ------------------------------------------------------------ chat

  function updatePlaceholder(): void {
    const locked = !store.state.settings.openrouterApiKey.trim();
    input.disabled = locked;
    sendBtn.disabled = locked;
    el.classList.toggle("locked", locked);
    if (locked) {
      input.placeholder = "Add an OpenRouter key to ask questions";
      return;
    }
    if (attached.length) {
      input.placeholder = attached.length === 1 ? "Ask about this terminal…" : `Ask about these ${attached.length} terminals…`;
    } else if (currentMode().actions) input.placeholder = "Ask, or say what to do…";
    else if (scope === "all") input.placeholder = "Ask about your agents…";
    else {
      const s = store.state.sessions.find((x) => x.id === scope);
      input.placeholder = `Ask about ${s?.name ?? "this session"}…`;
    }
  }

  function renderEmptyThread(): void {
    const locked = !store.state.settings.openrouterApiKey.trim();
    thread.innerHTML = locked
      ? `<div class="ap-welcome">
          <div class="ap-welcome-mark">${icon("sparkle", 18)}</div>
          <h3>Connect OpenRouter</h3>
          <p>Add a key to ask questions about your agents.</p>
          <button class="ap-primary ap-open-settings">Add API key</button>
        </div>`
      : `<div class="ap-welcome">
          <div class="ap-welcome-mark">${icon("sparkle", 18)}</div>
          <h3>Ask about your agents</h3>
          <p>Or drag a terminal here to ask about it.</p>
          <div class="ap-suggestions">${SUGGESTIONS.map((q) => `<button class="ap-suggestion">${esc(q)}</button>`).join(
            ""
          )}</div>
        </div>`;
  }

  function scrollToEnd(): void {
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    if (nearBottom) thread.scrollTop = thread.scrollHeight;
  }

  function autosize(): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }

  function setRunning(running: boolean): void {
    el.classList.toggle("running", running);
    sendBtn.innerHTML = running ? icon("stop", 12) : icon("arrowUp", 14);
    sendBtn.title = running ? "Stop (Esc)" : "Send (Enter)";
  }

  function updateSpend(): void {
    const u = conversation.usage;
    spendEl.textContent = u.tokens ? `${fmtCost(u.cost)} this chat` : "";
    spendEl.title = u.tokens ? `${u.tokens.toLocaleString()} tokens` : "";
  }

  // ------------------------------------------------------------ approvals

  /** Cards waiting for a decision, in the order they were shown. */
  const pending = new Map<ActionPlan, { el: HTMLElement; settle(ok: boolean): void }>();
  /** The step line each decided card collapsed into, so the action's outcome
   *  lands in the same spot. */
  const stepOf = new WeakMap<ActionPlan, HTMLElement>();

  function cardHtml(plan: ActionPlan): string {
    const risky = plan.risks.length > 0;
    const body = plan.text
      ? `<pre class="ap-card-text">${esc(plan.text)}</pre>`
      : plan.detail
        ? `<p class="ap-card-detail">${esc(plan.detail)}</p>`
        : "";
    return `
      <div class="ap-card-head">
        ${icon(TOOL_ICON[plan.tool] ?? "info", 13)}
        <span class="ap-card-verb">${esc(plan.verb)}</span>
        ${plan.target ? `<span class="ap-card-target" title="${esc(plan.target)}">${esc(plan.target)}</span>` : ""}
        ${risky ? `<span class="ap-card-risk" title="Needs your approval in every mode">${icon("shieldWarning", 11)}Risky</span>` : ""}
      </div>
      ${body}
      ${risky ? `<p class="ap-card-why">${esc(plan.risks.join(". "))}.</p>` : ""}
      <div class="ap-card-actions">
        <button class="ap-card-all" hidden></button>
        <button class="ap-card-deny" title="Deny (Esc)">Deny</button>
        <button class="ap-card-ok" title="Approve (Enter)">Approve</button>
      </div>`;
  }

  /** Only while several cards wait does each offer "Approve all". */
  function syncApproveAll(): void {
    for (const { el: card } of pending.values()) {
      const all = card.querySelector<HTMLButtonElement>(".ap-card-all")!;
      all.hidden = pending.size < 2;
      all.textContent = `Approve all ${pending.size}`;
    }
  }

  function focusNextCard(): void {
    const next = pending.values().next().value;
    if (next) next.el.querySelector<HTMLElement>(".ap-card-ok")?.focus();
    else if (el.contains(document.activeElement) || document.activeElement === document.body) input.focus();
  }

  function requestApproval(plan: ActionPlan, signal: AbortSignal, container: HTMLElement): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      const card = document.createElement("div");
      card.className = `ap-card${plan.risks.length ? " risky" : ""}`;
      card.setAttribute("role", "group");
      card.setAttribute("aria-label", `${plan.verb}${plan.target ? `, ${plan.target}` : ""}: approve or deny`);
      card.innerHTML = cardHtml(plan);
      container.append(card);
      // Cards from one step arrive together; the shared cooldown keeps that
      // to a single chime.
      if (store.state.settings.assistantApprovalSound) playAttentionChime();

      const onAbort = (): void => settle(false, true);
      const settle = (ok: boolean, cancelled = false): void => {
        if (!pending.has(plan)) return;
        const hadFocus = card.contains(document.activeElement);
        pending.delete(plan);
        signal.removeEventListener("abort", onAbort);
        // The card collapses into its step line; showAction fills in the outcome.
        card.className = `ap-step${ok ? "" : " denied"}`;
        card.removeAttribute("role");
        card.removeAttribute("aria-label");
        card.innerHTML = `${icon(ok ? (TOOL_ICON[plan.tool] ?? "info") : "prohibit", 12)}<span>${stepLabel(
          cancelled ? `Cancelled: ${plan.verb.toLowerCase()}` : ok ? `${plan.verb}…` : plan.deniedLabel
        )}</span>`;
        stepOf.set(plan, card);
        syncApproveAll();
        if (hadFocus || !pending.size) focusNextCard();
        resolve(ok);
      };
      pending.set(plan, { el: card, settle });
      signal.addEventListener("abort", onAbort);
      syncApproveAll();
      scrollToEnd();
      // Focus goes to the first card still waiting, not the newest.
      if (pending.size === 1 || !thread.contains(document.activeElement)) focusNextCard();
    });
  }

  function showAction(plan: ActionPlan | null, step: ActionStep, container: HTMLElement): void {
    const glyph: IconName = step.outcome === "denied" ? "prohibit" : step.outcome === "failed" ? "warning" : (TOOL_ICON[step.tool] ?? "info");
    const line = (plan && stepOf.get(plan)) || document.createElement("div");
    line.className = `ap-step${step.outcome === "done" ? "" : ` ${step.outcome}`}`;
    line.innerHTML = `${icon(glyph, 12)}<span>${stepLabel(step.label)}</span>`;
    if (!line.isConnected) container.append(line);
    scrollToEnd();
  }

  /** Enter approves and Esc denies the focused card. Cards live in the chat
   *  thread and, during a voice conversation, in its transcript: both listen. */
  function cardKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>(".ap-card");
    const entry = card ? [...pending.values()].find((p) => p.el === card) : undefined;
    if (!entry) return;
    // Enter on Deny or "Approve all" does what that button says.
    if (e.key === "Enter" && t.closest(".ap-card-deny, .ap-card-all")) return;
    e.preventDefault();
    e.stopPropagation();
    entry.settle(e.key === "Enter");
  }

  /** A click on a card's Approve, Deny or "Approve all". True when it was one. */
  function cardClick(t: HTMLElement): boolean {
    const decision = t.closest<HTMLElement>(".ap-card-ok, .ap-card-deny, .ap-card-all");
    if (!decision) return false;
    const card = decision.closest(".ap-card");
    if (decision.classList.contains("ap-card-all")) {
      for (const p of [...pending.values()]) p.settle(true);
    } else {
      [...pending.values()].find((p) => p.el === card)?.settle(decision.classList.contains("ap-card-ok"));
    }
    return true;
  }

  thread.addEventListener("keydown", cardKey);

  // ------------------------------------------------------------ watches

  /** Terminals the assistant asked to hear back about (notify_when_done). */
  const watches = new Map<string, { title: string; note: string; at: number; busy: boolean; quiet: number }>();
  let watchTimer: number | null = null;
  let watchChecking = false;
  const WATCH_TICK_MS = 1500;
  const MAX_WATCHES = 8;
  /** A terminal never seen busy only counts as finished after this long, so a
   *  command that hasn't visibly started yet isn't reported as done. */
  const WATCH_GRACE_MS = 5000;

  function addWatch(paneId: string, note: string): string | null {
    if (!watches.has(paneId) && watches.size >= MAX_WATCHES) return `already watching ${MAX_WATCHES} terminals.`;
    watches.set(paneId, { title: panes.get(paneId)?.title ?? refOf(paneId), note, at: Date.now(), busy: false, quiet: 0 });
    watchTimer ??= window.setInterval(() => void checkWatches(), WATCH_TICK_MS);
    return null;
  }

  function clearWatches(): void {
    watches.clear();
    if (watchTimer !== null) window.clearInterval(watchTimer);
    watchTimer = null;
  }

  async function checkWatches(): Promise<void> {
    if (watchChecking) return;
    watchChecking = true;
    try {
      for (const [id, w] of [...watches]) {
        const state = await paneState(id);
        if (!watches.has(id)) continue;
        if (state === "busy") {
          w.busy = true;
          w.quiet = 0;
          continue;
        }
        if (state !== "gone" && !w.busy && Date.now() - w.at < WATCH_GRACE_MS) continue;
        // Two quiet checks in a row: a prompt redraw between commands isn't "done".
        if (state === "done" && ++w.quiet < 2) continue;
        if (conversation.running) continue; // delivered on a later tick
        const what = state === "gone" ? "was closed" : state === "waiting" ? "is now waiting on the user" : "has finished";
        const label = `${w.title} ${state === "gone" ? "was closed" : state === "waiting" ? "needs you" : "finished"}`;
        const notice = `[Automatic notification, not typed by the user] ${refOf(id)} "${w.title}" ${what}.${w.note ? ` Your note: ${w.note}.` : ""}${
          state === "gone" ? "" : " Its latest output is attached."
        } Tell the user the actual result now (the agent's answer, the outcome, any error), not just that it finished, then carry on with anything you planned for this moment.`;
        // A live voice conversation hears about it instead of the typed chat.
        if (voice.isActive()) {
          const output = state === "gone" ? "" : `

<terminal ref="${refOf(id)}">
${screenExcerpt(id, 80, 5000) || "(terminal is empty)"}
</terminal>`;
          if (voice.notify(notice + output, label)) watches.delete(id);
          continue;
        }
        watches.delete(id);
        void send(notice, { paneId: state === "gone" ? null : id, label });
      }
    } finally {
      watchChecking = false;
      if (!watches.size) clearWatches();
    }
  }

  /** `notice` marks a turn started by a watch rather than by the user: it
   *  shows as a step line and leaves the composer alone. */
  async function send(text: string, notice?: { paneId: string | null; label: string }): Promise<void> {
    const q = text.trim();
    if (!q || conversation.running) return;
    if (!store.state.settings.openrouterApiKey.trim()) return;
    if (thread.querySelector(".ap-welcome")) thread.innerHTML = "";

    const sentAttached = notice ? (notice.paneId ? [notice.paneId] : []) : [...attached];
    const sentFiles = notice ? [] : files;
    if (!notice) {
      files = [];
      history.unshift(q);
      historyIdx = -1;
      attached = [];
      input.value = "";
      autosize();
      render();
      updatePlaceholder();
    }

    const userEl = document.createElement("div");
    userEl.className = notice ? "ap-msg ai" : "ap-msg user";
    userEl.innerHTML = notice
      ? `<div class="ap-steps"><div class="ap-step">${icon("bell", 12)}<span>${esc(notice.label)}</span></div></div>`
      : `${
      sentAttached.length
        ? `<div class="ap-msg-refs">${sentAttached
            .map((id) => `<button class="ap-ref" data-pane="${esc(id)}">${esc(panes.get(id)?.title ?? refOf(id))}</button>`)
            .join("")}</div>`
        : ""
    }${
      sentFiles.length
        ? `<div class="ap-msg-refs">${sentFiles
            .map((f) => `<span class="ap-att" title="${esc(f.path)}">${icon("file", 13)}<span class="ap-att-name">${esc(f.name)}</span></span>`)
            .join("")}</div>`
        : ""
    }<div class="ap-bubble">${esc(q)}</div>`;
    const aiEl = document.createElement("div");
    aiEl.className = "ap-msg ai";
    aiEl.innerHTML = `<div class="ap-steps"></div><div class="ap-answer">${THINKING}</div><div class="ap-msg-meta"></div>`;
    thread.append(userEl, aiEl);
    thread.scrollTop = thread.scrollHeight;
    const steps = aiEl.querySelector<HTMLElement>(".ap-steps")!;
    const answer = aiEl.querySelector<HTMLElement>(".ap-answer")!;
    const meta = aiEl.querySelector<HTMLElement>(".ap-msg-meta")!;

    let frame = 0;
    let latest = "";
    setRunning(true);
    try {
      const blocks = await Promise.all(sentFiles.map(async (f) => ({ name: f.name, block: await fileBlock(f) })));
      const res = await conversation.ask(q, sentAttached, scope, currentMode().id, host.actions, {
        onText: (t) => {
          latest = t;
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            answer.innerHTML = latest.trim() ? renderAnswer(latest) : THINKING;
            scrollToEnd();
          });
        },
        onTool: (label, _paneIds, tool) => {
          const step = document.createElement("div");
          step.className = "ap-step";
          step.innerHTML = `${icon(TOOL_ICON[tool] ?? "info", 12)}<span>${esc(label)}</span>`;
          steps.append(step);
          scrollToEnd();
        },
        watch: addWatch,
        requestApproval: (plan, signal) => requestApproval(plan, signal, steps),
        onAction: (plan, step) => showAction(plan, step, steps),
      }, blocks);
      if (frame) cancelAnimationFrame(frame);
      answer.innerHTML = res.text
        ? renderAnswer(res.text)
        : `<p class="ap-muted">${res.cancelled ? "Stopped." : "No answer came back. Try rephrasing."}</p>`;
      if (res.cancelled && res.text) answer.insertAdjacentHTML("beforeend", `<p class="ap-muted">Stopped.</p>`);
      if (res.tokens) meta.textContent = `${fmtCost(res.cost)}, ${res.tokens.toLocaleString()} tokens`;
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      const msg = String(err instanceof Error ? err.message : err);
      answer.innerHTML = `<div class="ap-error">${icon("warning", 14)}<span>${esc(
        friendlyError(msg)
      )}</span><button class="ap-retry">Retry</button></div>`;
      answer.querySelector(".ap-retry")?.addEventListener("click", () => {
        userEl.remove();
        aiEl.remove();
        attached = sentAttached.filter((id) => panes.has(id));
        files = sentFiles;
        void send(q, notice);
      });
    } finally {
      setRunning(false);
      updateSpend();
      scrollToEnd();
    }
  }

  function friendlyError(msg: string): string {
    if (/401|invalid.*key|no auth/i.test(msg)) return "OpenRouter rejected the API key. Check it in Settings, AI.";
    if (/402|credit/i.test(msg)) return "Your OpenRouter account is out of credits.";
    if (/429|rate/i.test(msg)) return "Rate limited by OpenRouter. Wait a moment and retry.";
    if (/timed? ?out|request failed|interrupted/i.test(msg)) return "Couldn't reach OpenRouter. Check your connection.";
    return msg;
  }

  sendBtn.addEventListener("click", () => {
    if (conversation.running) conversation.stop();
    else void send(input.value);
  });

  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send(input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (conversation.running) conversation.stop();
      else host.focusWorkspace();
    } else if (e.key === "ArrowUp" && !input.value && history.length) {
      e.preventDefault();
      historyIdx = Math.min(history.length - 1, historyIdx + 1);
      input.value = history[historyIdx];
      autosize();
    } else if (e.key === "ArrowDown" && historyIdx >= 0 && input.selectionStart === input.value.length) {
      e.preventDefault();
      historyIdx--;
      input.value = historyIdx >= 0 ? history[historyIdx] : "";
      autosize();
    }
  });

  thread.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (cardClick(t)) return;
    const ref = t.closest<HTMLElement>(".ap-ref");
    if (ref?.dataset.pane) {
      goTo(ref.dataset.pane);
      return;
    }
    const sug = t.closest<HTMLElement>(".ap-suggestion");
    if (sug) {
      void send(sug.textContent ?? "");
      return;
    }
    if (t.closest(".ap-open-settings")) host.openAiSettings();
  });
  thread.addEventListener("pointerover", (e) => {
    const ref = (e.target as HTMLElement).closest<HTMLElement>(".ap-ref");
    peek(ref?.dataset.pane ?? null);
  });
  thread.addEventListener("pointerleave", () => peek(null));
  attachedEl.addEventListener("pointerover", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".ap-att");
    peek(chip?.dataset.pane ?? null);
  });
  attachedEl.addEventListener("pointerleave", () => peek(null));

  $(".ap-close").addEventListener("click", () => setOpen(false));
  $(".ap-new-chat").addEventListener("click", () => {
    conversation.reset();
    clearWatches();
    renderEmptyThread();
    updateSpend();
    input.focus();
  });
  resummarizeBtn.addEventListener("click", () => refreshSlow(true));

  // ------------------------------------------------------------ voice

  /** Voice mode covers the panel; what's underneath must not take focus. */
  function setCovered(covered: boolean): void {
    for (const part of el.querySelectorAll<HTMLElement>(":scope > .ap-head, :scope > .ap-subbar, :scope > .ap-views"))
      part.inert = covered;
  }

  const voice = createVoiceView({
    conversation,
    host: host.actions,
    scope: () => scope,
    mode: currentMode,
    openAiSettings: host.openAiSettings,
    renderAnswer,
    toolIcon: (tool) => TOOL_ICON[tool] ?? "info",
    watch: addWatch,
    requestApproval,
    showAction,
    onEnd: (messages) => {
      setCovered(false);
      if (messages.length) {
        if (thread.querySelector(".ap-welcome")) thread.innerHTML = "";
        thread.append(...messages);
        thread.scrollTop = thread.scrollHeight;
      }
      if (open && !input.disabled) input.focus();
    },
  });
  el.append(voice.el);
  // Approval cards shown during a voice conversation sit outside the thread.
  voice.el.addEventListener("keydown", cardKey);
  voice.el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (cardClick(t)) return;
    const ref = t.closest<HTMLElement>(".ap-ref");
    if (ref?.dataset.pane) goTo(ref.dataset.pane);
  });

  $(".ap-voice-btn").addEventListener("click", () => {
    if (conversation.running) return;
    voice.start();
    if (voice.isActive()) setCovered(true);
  });

  // ------------------------------------------------------------ init

  applyWidth(store.state.settings.agentsPanelWidth);
  el.dataset.view = view;
  el.querySelector(`.ap-switch-btn[data-view="${view}"]`)?.classList.add("active");
  renderEmptyThread();
  renderMode();
  updatePlaceholder();
  setRunning(false);
  attachedEl.hidden = true;

  return {
    el,
    edge,
    isOpen: () => open,
    toggle(): void {
      setOpen(!open);
    },
    /** Boot: restore the persisted open state without stealing focus. */
    restore(): void {
      applyWidth(store.state.settings.agentsPanelWidth);
      if (store.state.settings.agentsPanelVisible) setOpen(true, false);
    },
    /** Settings changed (API key added/removed, shortcut rebound…). */
    refreshSettings(): void {
      if (wantedMode && isModeUnlocked(wantedMode, store.state.settings)) {
        selectMode(wantedMode);
        wantedMode = null;
      }
      renderMode();
      updatePlaceholder();
      if (!conversation.running && (thread.querySelector(".ap-welcome") || !thread.children.length)) renderEmptyThread();
      if (open) refreshSlow(false);
    },
  };
}

export type AgentsPanel = ReturnType<typeof createAgentsPanel>;
