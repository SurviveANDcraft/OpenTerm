// Settings > Dictation: History (what people come back to) and Setup (the
// simulator plus every option). The agent owns history and audio on disk;
// this tab reads snapshots and sends it small commands.

import { Channel, invoke } from "@tauri-apps/api/core";
import { copyText } from "../clipboard";
import type { ConfirmOptions } from "../confirm";
import { getTheme } from "../themes";
import { DEFAULT_VOCABULARY, DictationSettings, Settings } from "../types";
import { recorder } from "../keybinds";
import { createSimulator } from "./simulator";
import "./dictation.css";

// ---------------------------------------------------------------- sync with the agent

const THEME_TOKENS = ["--bg-raised", "--text", "--text-dim", "--accent", "--danger"] as const;

/** Writes the agent's config.json (settings, key, theme tokens), syncs the
 *  autostart entry and starts or stops the agent. Safe to call often. */
export function syncDictation(s: Settings): Promise<void> {
  const vars = getTheme(s.theme).vars;
  const theme = Object.fromEntries(THEME_TOKENS.map((k) => [k, vars[k]]));
  return invoke<void>("dictation_sync", {
    config: { settings: s.dictation, apiKey: s.openrouterApiKey.trim(), theme },
  }).catch(() => {});
}

function command(cmd: Record<string, unknown>): Promise<void> {
  return invoke<void>("dictation_command", { command: cmd });
}

// ---------------------------------------------------------------- data from disk

interface HistoryItem {
  id: string;
  text: string;
  createdAt: number;
  durationMs: number;
  language: string | null;
  app: string | null;
  cost: number | null;
  audio: string | null;
  audioExpired: boolean;
}

interface UnsentItem {
  id: string;
  createdAt: number;
  durationMs: number;
  reason: string;
  detail: string | null;
  cancelled: boolean;
  app: string | null;
  audio: string | null;
  updatedAt: number;
}

interface Snapshot {
  history: HistoryItem[];
  unsent: UnsentItem[];
  stats: { month: string; seconds: number; cost: number };
  audioDir: string;
  agentRunning: boolean;
}

// ---------------------------------------------------------------- small helpers

const LANGUAGES: [string, string][] = [
  ["af", "Afrikaans"], ["sq", "Albanian"], ["ar", "Arabic"], ["hy", "Armenian"], ["eu", "Basque"],
  ["bn", "Bengali"], ["bs", "Bosnian"], ["bg", "Bulgarian"], ["ca", "Catalan"], ["zh", "Chinese"],
  ["hr", "Croatian"], ["cs", "Czech"], ["da", "Danish"], ["nl", "Dutch"], ["en", "English"],
  ["et", "Estonian"], ["fil", "Filipino"], ["fi", "Finnish"], ["fr", "French"], ["gl", "Galician"],
  ["ka", "Georgian"], ["de", "German"], ["el", "Greek"], ["gu", "Gujarati"], ["he", "Hebrew"],
  ["hi", "Hindi"], ["hu", "Hungarian"], ["is", "Icelandic"], ["id", "Indonesian"], ["ga", "Irish"],
  ["it", "Italian"], ["ja", "Japanese"], ["kn", "Kannada"], ["kk", "Kazakh"], ["ko", "Korean"],
  ["lv", "Latvian"], ["lt", "Lithuanian"], ["mk", "Macedonian"], ["ms", "Malay"], ["ml", "Malayalam"],
  ["mt", "Maltese"], ["mr", "Marathi"], ["nb", "Norwegian"], ["fa", "Persian"], ["pl", "Polish"],
  ["pt", "Portuguese"], ["pa", "Punjabi"], ["ro", "Romanian"], ["ru", "Russian"], ["sr", "Serbian"],
  ["sk", "Slovak"], ["sl", "Slovenian"], ["es", "Spanish"], ["sw", "Swahili"], ["sv", "Swedish"],
  ["ta", "Tamil"], ["te", "Telugu"], ["th", "Thai"], ["tr", "Turkish"], ["uk", "Ukrainian"],
  ["ur", "Urdu"], ["vi", "Vietnamese"], ["cy", "Welsh"],
];

/** Windows shortcuts a custom chord would fight with. */
const WINDOWS_SHORTCUTS: Record<string, string> = {
  "Win+H": "voice typing",
  "Win+V": "clipboard history",
  "Win+D": "show desktop",
  "Win+E": "File Explorer",
  "Win+L": "locking the PC",
  "Win+R": "Run",
  "Win+Space": "switching keyboard layouts",
  "Shift+Win+S": "screenshots",
  "Ctrl+Shift+Win+B": "restarting the graphics driver",
  "Ctrl+Win+D": "new virtual desktops",
  "Ctrl+Win+F4": "closing virtual desktops",
  "Ctrl+Win+O": "the on-screen keyboard",
  "Ctrl+Win+Enter": "Narrator",
  "Alt+Win+R": "Game Bar recording",
};

const svg = (body: string, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.2A1.6 1.6 0 0 0 9 2.5H4.1A1.6 1.6 0 0 0 2.5 4.1V9a1.6 1.6 0 0 0 .7 1.3"/>'),
  check: svg('<path d="M3.5 8.4l3 2.9 6-6.3"/>'),
  play: svg('<path d="M5 3.6v8.8a.5.5 0 0 0 .76.43l7-4.4a.5.5 0 0 0 0-.86l-7-4.4A.5.5 0 0 0 5 3.6z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.4a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.4"/>'),
  close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', 12),
  minus: svg('<path d="M4 8h8"/>'),
  plus: svg('<path d="M4 8h8M8 4v8"/>'),
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "dict-icon-btn");
  b.type = "button";
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(at);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Ctrl+Win" → ["Ctrl", "Win"]. */
const chordParts = (chord: string) => chord.split("+").filter(Boolean);

function keycaps(chord: string, className = "dict-keycaps"): HTMLElement {
  const wrap = el("span", className);
  chordParts(chord).forEach((part, i) => {
    if (i > 0) wrap.appendChild(el("span", "dict-keycap-plus", "+"));
    wrap.appendChild(el("kbd", "dict-keycap", part));
  });
  return wrap;
}

// Chord recording mirrors the agent's parser: two modifiers, a modifier with a
// key, or a lone key nobody types by accident.
const MODIFIER_KEYS: Record<string, string> = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Win", OS: "Win" };
const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Win"];
const LONE_OK = /^(F\d{1,2}|Pause|ScrollLock|Insert)$/;

function keyName(e: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  const map: Record<string, string> = {
    Space: "Space", Backquote: "`", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
    BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=",
  };
  if (map[e.code]) return map[e.code];
  if (/^F([1-9]|1\d|2[0-4])$/.test(e.key)) return e.key;
  if (["Pause", "ScrollLock", "Insert", "Delete", "Home", "End", "PageUp", "PageDown", "Enter", "Tab", "Backspace",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return e.key;
  return null;
}

function chordWarning(chord: string): string {
  const parts = chordParts(chord);
  if (parts.includes("Ctrl") && parts.includes("Alt")) {
    return "Ctrl+Alt works as AltGr on many keyboard layouts, so typing some characters may start dictation.";
  }
  const use = WINDOWS_SHORTCUTS[chord];
  return use ? `Windows uses ${chord} for ${use}.` : "";
}

// ---------------------------------------------------------------- inline audio player

let activePlayer: InlinePlayer | null = null;
let audioCtx: AudioContext | null = null;

/** Play button + thin waveform scrubber drawn from the stored FLAC. No modal. */
class InlinePlayer {
  readonly el = el("div", "dict-player");
  private canvas = el("canvas", "dict-wave");
  private time = el("span", "dict-player-time");
  private buffer: AudioBuffer | null = null;
  private peaks: Float32Array | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private raf = 0;
  onStateChange: ((playing: boolean) => void) | null = null;

  constructor(private path: string, private accent: () => string) {
    this.el.append(this.canvas, this.time);
    const seek = (e: PointerEvent) => {
      if (!this.buffer) return;
      const r = this.canvas.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.offset = frac * this.buffer.duration;
      if (this.source) this.play();
      else this.draw();
    };
    this.canvas.addEventListener("pointerdown", (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      seek(e);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.canvas.hasPointerCapture(e.pointerId)) seek(e);
    });
  }

  get playing(): boolean {
    return this.source !== null;
  }

  async toggle(): Promise<void> {
    if (this.source) return this.pause();
    if (!this.buffer) {
      const b64 = await invoke<string>("read_file_base64", { path: this.path });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      audioCtx ??= new AudioContext();
      this.buffer = await audioCtx.decodeAudioData(bytes.buffer);
      this.peaks = this.computePeaks(96);
    }
    this.play();
  }

  private computePeaks(n: number): Float32Array {
    const data = this.buffer!.getChannelData(0);
    const out = new Float32Array(n);
    const step = Math.max(1, Math.floor(data.length / n));
    let max = 0;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 4) peak = Math.max(peak, Math.abs(data[j]));
      out[i] = peak;
      max = Math.max(max, peak);
    }
    if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
    return out;
  }

  private play(): void {
    if (!this.buffer || !audioCtx) return;
    if (activePlayer && activePlayer !== this) activePlayer.pause();
    activePlayer = this;
    this.stopSource();
    if (this.offset >= this.buffer.duration - 0.05) this.offset = 0;
    const src = audioCtx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(audioCtx.destination);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.offset = 0;
      this.onStateChange?.(false);
      this.draw();
    };
    src.start(0, this.offset);
    this.source = src;
    this.startedAt = audioCtx.currentTime - this.offset;
    this.onStateChange?.(true);
    this.tick();
  }

  pause(): void {
    if (!this.source || !audioCtx) return;
    this.offset = audioCtx.currentTime - this.startedAt;
    this.stopSource();
    this.onStateChange?.(false);
    this.draw();
  }

  private stopSource(): void {
    if (!this.source) return;
    const s = this.source;
    this.source = null;
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
    cancelAnimationFrame(this.raf);
  }

  private tick(): void {
    if (!this.source || !audioCtx) return;
    this.offset = audioCtx.currentTime - this.startedAt;
    this.draw();
    this.raf = requestAnimationFrame(() => this.tick());
  }

  draw(): void {
    const w = this.canvas.clientWidth || 240;
    const h = 22;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.peaks || !this.buffer) return;
    const n = this.peaks.length;
    const barW = w / n;
    const progress = this.offset / this.buffer.duration;
    const accent = this.accent();
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, this.peaks[i] * (h - 2));
      ctx.globalAlpha = i / n <= progress ? 1 : 0.32;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(i * barW + barW * 0.2, (h - bh) / 2, Math.max(1, barW * 0.6), bh, 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.time.textContent = `${duration(this.offset * 1000)} / ${duration(this.buffer.duration * 1000)}`;
  }
}

// ---------------------------------------------------------------- the tab

export interface DictationUi {
  field(label: string, control: HTMLElement, opts?: { desc?: string; tip?: string; stack?: boolean; keywords?: string }): HTMLElement;
  section(title: string, desc: string | null, rows: HTMLElement[], opts?: { keywords?: string; actions?: HTMLElement[]; className?: string }): HTMLElement;
  toggle(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement;
  segmented<T extends string>(options: { value: T; label: string }[], current: T, onChange: (v: T) => void): HTMLElement;
  btn(className: string, text: string, onClick?: () => void): HTMLButtonElement;
}

export interface DictationTabContext {
  draft(): Settings;
  markDirty(): void;
  openAiCategory(): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  ui: DictationUi;
}

type Pane = "history" | "setup";

export function createDictationTab(ctx: DictationTabContext) {
  const { ui } = ctx;
  const d = (): DictationSettings => ctx.draft().dictation;
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const hasKey = () => !!ctx.draft().openrouterApiKey.trim();

  const root = el("div", "dict-tab");
  let pane: Pane | null = null;
  let visible = false;

  // ------------------------------------------------------------ header
  const head = el("div", "dict-head");
  const paneSwitch = el("div", "segmented dict-pane-switch");
  paneSwitch.setAttribute("role", "tablist");
  const paneButtons = new Map<Pane, HTMLButtonElement>();
  for (const [value, label] of [["history", "History"], ["setup", "Setup"]] as [Pane, string][]) {
    const b = el("button", "", label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => showPane(value));
    paneButtons.set(value, b);
    paneSwitch.appendChild(b);
  }
  head.appendChild(paneSwitch);

  const historyPane = el("div", "dict-pane");
  const setupPane = el("div", "dict-pane");
  root.append(head, historyPane, setupPane);

  function showPane(p: Pane): void {
    pane = p;
    for (const [value, b] of paneButtons) {
      b.classList.toggle("selected", value === p);
      b.setAttribute("aria-selected", String(value === p));
    }
    historyPane.classList.toggle("dict-pane-off", p !== "history");
    setupPane.classList.toggle("dict-pane-off", p !== "setup");
    updateActivity();
  }

  // ------------------------------------------------------------ persistent pieces
  const simulator = createSimulator({
    style: () => d().style,
    position: () => d().position,
    onPosition: (pos) => {
      if (d().position === pos) return;
      d().position = pos;
      ctx.markDirty();
    },
    onShowOnScreen: () => {
      void command({ type: "preview", style: d().style, position: d().position }).catch(() => {});
    },
  });

  // Level meter: same capture path as dictation, only while Setup is on screen.
  const meterCanvas = el("canvas", "dict-meter");
  const meterNote = el("div", "dict-mic-note");
  const meterLevels = new Float32Array(12);
  const meterTarget = new Float32Array(12);
  let meterOn = false;
  let meterDevice: string | null | undefined;
  let meterRaf = 0;
  let meterLast = 0;

  function drawMeter(now: number): void {
    const dt = Math.min(0.05, (now - meterLast) / 1000);
    meterLast = now;
    const w = 64;
    const h = 20;
    const dpr = window.devicePixelRatio || 1;
    if (meterCanvas.width !== w * dpr) {
      meterCanvas.width = w * dpr;
      meterCanvas.height = h * dpr;
    }
    const c = meterCanvas.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = accent();
    for (let i = 0; i < 12; i++) {
      const tau = meterTarget[i] > meterLevels[i] ? 0.035 : 0.14;
      meterLevels[i] += (meterTarget[i] - meterLevels[i]) * (1 - Math.exp(-dt / tau));
      const bh = Math.max(3, meterLevels[i] * h);
      c.globalAlpha = meterLevels[i] > 0.04 ? 1 : 0.35;
      c.beginPath();
      c.roundRect(i * 5 + 2, (h - bh) / 2, 3, bh, 1.5);
      c.fill();
    }
    c.globalAlpha = 1;
    if (meterOn) meterRaf = requestAnimationFrame(drawMeter);
  }

  function startMeter(): void {
    const device = d().micDeviceId;
    if (meterOn && meterDevice === device) return;
    meterOn = true;
    meterDevice = device;
    meterNote.replaceChildren();
    meterNote.hidden = true;
    const ch = new Channel<ArrayBuffer | { error: string }>();
    ch.onmessage = (m) => {
      if (m instanceof ArrayBuffer) {
        const b = new Uint8Array(m);
        const rms = (b[24] ?? 0) / 255;
        for (let i = 0; i < 12; i++) meterTarget[i] = ((b[i * 2] + b[i * 2 + 1]) / 510) * 0.55 + rms * 0.45;
      } else if (m.error) {
        showMicProblem(m.error);
      }
    };
    void invoke("dictation_meter_start", { device, channel: ch });
    cancelAnimationFrame(meterRaf);
    meterLast = performance.now();
    meterRaf = requestAnimationFrame(drawMeter);
  }

  function stopMeter(): void {
    if (!meterOn) return;
    meterOn = false;
    meterDevice = undefined;
    meterTarget.fill(0);
    void invoke("dictation_meter_stop");
  }

  function showMicProblem(kind: string): void {
    meterNote.hidden = false;
    if (kind === "blocked") {
      meterNote.replaceChildren(
        el("span", "", "Windows privacy settings block the microphone."),
        ui.btn("dict-link", "Open privacy settings", () => void invoke("dictation_open_mic_privacy"))
      );
    } else {
      meterNote.replaceChildren(el("span", "", kind === "noDevice" ? "No microphone found." : "The microphone couldn't be opened."));
    }
  }

  // ------------------------------------------------------------ history pane
  let snapshot: Snapshot | null = null;
  let snapshotJson = "";
  const rows = new Map<string, HTMLElement>();
  const players = new Map<string, InlinePlayer>();
  const expanded = new Set<string>();
  const transcribing = new Set<string>();
  let pollTimer: number | undefined;

  const unsentSection = el("section", "settings-section dict-list-section");
  const unsentHead = el("div", "settings-section-head");
  const unsentTitle = el("div", "settings-section-text");
  unsentTitle.append(el("h2", "", "Unsent"), el("p", "settings-section-desc", "Recordings that were cancelled or couldn't be transcribed."));
  unsentHead.appendChild(unsentTitle);
  const unsentList = el("div", "dict-list");
  unsentSection.append(unsentHead, unsentList);
  unsentSection.dataset.search = "unsent cancelled failed recordings transcribe dictation";

  const historySection = el("section", "settings-section dict-list-section");
  const historyHead = el("div", "settings-section-head");
  const historyTitle = el("div", "settings-section-text");
  historyTitle.append(el("h2", "", "History"), el("p", "settings-section-desc", "Your last 15 dictations."));
  historyHead.appendChild(historyTitle);
  const historyList = el("div", "dict-list");
  const foot = el("div", "dict-foot");
  const monthLine = el("span", "dict-month");
  const clearBtn = ui.btn("dict-link", "Clear history", () => void clearHistory());
  foot.append(monthLine, clearBtn);
  historySection.append(historyHead, historyList, foot);
  historySection.dataset.search = "history dictation transcriptions clear";

  const empty = el("div", "dict-empty");
  historyPane.append(unsentSection, historySection, empty);

  async function clearHistory(): Promise<void> {
    const ok = await ctx.confirm({
      title: "Clear dictation history?",
      message: "Removes the text and audio of every transcription in History. Unsent recordings stay.",
      confirmLabel: "Clear history",
      danger: true,
    });
    if (!ok) return;
    await command({ type: "clearHistory" }).catch(() => {});
    void refresh(true);
  }

  function historyRow(item: HistoryItem): HTMLElement {
    const row = el("div", "dict-row");
    row.dataset.id = item.id;
    const main = el("div", "dict-row-main");
    main.tabIndex = 0;
    main.setAttribute("role", "button");
    const text = el("div", "dict-row-text", item.text);
    const meta = el("div", "dict-row-meta");
    main.append(text, meta);
    const toggleExpand = () => {
      if (expanded.has(item.id)) expanded.delete(item.id);
      else expanded.add(item.id);
      row.classList.toggle("expanded", expanded.has(item.id));
      main.setAttribute("aria-expanded", String(expanded.has(item.id)));
    };
    main.addEventListener("click", toggleExpand);
    main.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpand();
      }
    });

    const actions = el("div", "dict-row-actions");
    const copy = iconButton(ICON.copy, "Copy", () => {
      void copyText(item.text);
      copy.innerHTML = ICON.check;
      copy.classList.add("done");
      window.setTimeout(() => {
        copy.innerHTML = ICON.copy;
        copy.classList.remove("done");
      }, 1000);
    });
    const play = playButton(row, item.id, item.audio);
    const del = iconButton(ICON.trash, "Delete", () => void removeRow(row, { type: "deleteHistory", id: item.id }));
    actions.append(copy, play, del);
    row.append(main, actions);
    return row;
  }

  function playButton(row: HTMLElement, id: string, audio: string | null): HTMLButtonElement {
    const b = iconButton(ICON.play, audio ? "Play" : "Audio expired", () => {
      if (!audio || !snapshot) return;
      let p = players.get(id);
      if (!p) {
        p = new InlinePlayer(`${snapshot.audioDir}\\${audio}`, accent);
        p.onStateChange = (playing) => {
          b.innerHTML = playing ? ICON.pause : ICON.play;
          b.title = playing ? "Pause" : "Play";
        };
        players.set(id, p);
        row.appendChild(p.el);
        row.classList.add("with-player");
      }
      void p.toggle().catch(() => {});
    });
    b.disabled = !audio;
    return b;
  }

  function unsentRow(item: UnsentItem): HTMLElement {
    const row = el("div", "dict-row dict-unsent");
    row.dataset.id = item.id;
    const main = el("div", "dict-row-main");
    const text = el("div", "dict-row-text");
    const meta = el("div", "dict-row-meta");
    main.append(text, meta);
    const actions = el("div", "dict-row-actions");
    const play = playButton(row, item.id, item.audio);
    const transcribe = ui.btn("btn-primary dict-transcribe", "");
    transcribe.append(el("span", "dict-transcribe-label", "Transcribe"));
    const wave = el("span", "dict-transcribe-wave");
    for (let i = 0; i < 5; i++) wave.appendChild(el("i"));
    transcribe.appendChild(wave);
    transcribe.addEventListener("click", () => {
      if (transcribing.has(item.id)) return;
      transcribing.add(item.id);
      const current = snapshot?.unsent.find((u) => u.id === item.id);
      row.dataset.updated = String(current?.updatedAt ?? 0);
      row.classList.add("busy");
      void command({ type: "transcribe", id: item.id })
        .then(() => schedulePoll(400))
        .catch(() => {
          transcribing.delete(item.id);
          row.classList.remove("busy");
        });
    });
    const del = iconButton(ICON.trash, "Delete", () => void removeRow(row, { type: "deleteUnsent", id: item.id }));
    actions.append(play, transcribe, del);
    row.append(main, actions);
    return row;
  }

  async function removeRow(row: HTMLElement, cmd: { type: string; id: string }): Promise<void> {
    players.get(cmd.id)?.pause();
    const out = row.animate(
      [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-4px)" }],
      { duration: 160, easing: "ease-out", fill: "forwards" }
    );
    await command(cmd).catch(() => {});
    await out.finished.catch(() => {});
    void refresh(true);
  }

  function updateRowText(row: HTMLElement, text: string, meta: string, title?: string): void {
    const t = row.querySelector<HTMLElement>(".dict-row-text")!;
    const m = row.querySelector<HTMLElement>(".dict-row-meta")!;
    if (t.textContent !== text) t.textContent = text;
    if (m.textContent !== meta) m.textContent = meta;
    if (title !== undefined) t.title = title;
  }

  /** Reconciles rows by id, animating moves and inserts with FLIP transforms. */
  function renderList<T extends { id: string }>(list: HTMLElement, items: T[], make: (item: T) => HTMLElement): void {
    const before = new Map<string, number>();
    for (const child of Array.from(list.children) as HTMLElement[]) {
      before.set(child.dataset.id!, child.getBoundingClientRect().top);
    }
    const next = items.map((item) => rows.get(item.id) ?? make(item));
    for (const [id, row] of rows) {
      if (row.parentElement === list && !items.some((i) => i.id === id)) {
        row.remove();
        rows.delete(id);
        players.get(id)?.pause();
        players.delete(id);
      }
    }
    items.forEach((item, i) => rows.set(item.id, next[i]));
    list.replaceChildren(...next);
    if (!visible || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const row of next) {
      const old = before.get(row.dataset.id!);
      if (old === undefined) {
        if (before.size === 0) continue;
        row.animate(
          [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "translateY(0)" }],
          { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
        );
      } else {
        const dy = old - row.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) {
          row.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
            duration: 320,
            easing: "cubic-bezier(0.32, 0.72, 0, 1)",
          });
        }
      }
    }
  }

  function renderHistory(): void {
    const snap = snapshot;
    if (!snap) return;
    for (const id of Array.from(transcribing)) {
      const u = snap.unsent.find((x) => x.id === id);
      // Gone means it made it into History; a newer update means it failed again.
      if (!u || rows.get(id)?.dataset.updated !== String(u.updatedAt)) {
        transcribing.delete(id);
        rows.get(id)?.classList.remove("busy");
      }
    }

    // A class, not `hidden`: the settings search owns sections' hidden flag.
    unsentSection.classList.toggle("dict-off", snap.unsent.length === 0);
    renderList(unsentList, snap.unsent, unsentRow);
    for (const u of snap.unsent) {
      const row = rows.get(u.id)!;
      const title = u.cancelled ? "Cancelled" : u.reason;
      updateRowText(row, title, `${relativeTime(u.createdAt)} · ${duration(u.durationMs)}`, u.detail ?? "");
    }

    historySection.classList.toggle("dict-off", snap.history.length === 0);
    renderList(historyList, snap.history, historyRow);
    for (const h of snap.history) {
      const row = rows.get(h.id)!;
      const meta = [relativeTime(h.createdAt), h.app, duration(h.durationMs), h.audioExpired ? "Audio expired" : null]
        .filter(Boolean)
        .join(" · ");
      updateRowText(row, h.text, meta);
    }
    const mins = Math.round(snap.stats.seconds / 60);
    monthLine.textContent = `This month: ${mins} min dictated · $${snap.stats.cost.toFixed(2)}`;

    const isEmpty = snap.history.length === 0 && snap.unsent.length === 0;
    empty.hidden = !isEmpty;
    if (isEmpty) {
      const verb = d().mode === "toggle" ? "Press" : "Hold";
      empty.replaceChildren(
        keycaps(d().shortcut, "dict-keycaps dict-keycaps-large"),
        el("p", "", `${verb} ${chordParts(d().shortcut).join(" + ")} and start talking.`)
      );
    }
  }

  async function refresh(force = false): Promise<void> {
    try {
      const snap = await invoke<Snapshot>("dictation_read_store");
      const json = JSON.stringify(snap);
      if (!force && json === snapshotJson) return;
      snapshotJson = json;
      snapshot = snap;
      renderHistory();
    } catch {
      /* agent data unreadable right now; try again on the next tick */
    }
  }

  function schedulePoll(ms: number): void {
    window.clearTimeout(pollTimer);
    if (!visible) return;
    pollTimer = window.setTimeout(async () => {
      await refresh();
      // Faster while a Transcribe is in flight, so the result lands promptly.
      schedulePoll(transcribing.size ? 400 : 2000);
    }, ms);
  }

  window.addEventListener("focus", () => {
    if (visible) void refresh();
  });

  // ------------------------------------------------------------ visibility
  function updateActivity(): void {
    const setupOn = visible && pane === "setup";
    simulator.setRunning(setupOn);
    if (setupOn) startMeter();
    else stopMeter();
    if (visible) {
      void refresh();
      schedulePoll(2000);
    } else {
      window.clearTimeout(pollTimer);
      activePlayer?.pause();
    }
  }

  new IntersectionObserver((entries) => {
    const on = entries.some((e) => e.isIntersecting) && document.visibilityState === "visible";
    if (on === visible) return;
    visible = on;
    updateActivity();
  }).observe(root);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" && visible) {
      visible = false;
      updateActivity();
    }
  });

  // ------------------------------------------------------------ setup pane (rebuilt per render)
  let stopChordRecording: (() => void) | null = null;

  function shortcutSection(): HTMLElement {
    const s = d();
    const wrap = el("div", "control-stack dict-shortcut");
    const capsBtn = el("button", "dict-keycap-btn");
    capsBtn.type = "button";
    capsBtn.title = "Click to record a new shortcut";
    const warn = el("p", "field-hint dict-warn");
    const showChord = (chord: string) => {
      capsBtn.replaceChildren(keycaps(chord));
      warn.textContent = chordWarning(chord);
      warn.hidden = !warn.textContent;
    };
    showChord(s.shortcut);

    capsBtn.addEventListener("click", () => {
      if (stopChordRecording) return stopChordRecording();
      capsBtn.classList.add("recording");
      capsBtn.replaceChildren(el("span", "dict-recording-text", "Press your shortcut"));
      warn.hidden = true;
      recorder.active = true;
      void command({ type: "suspend", on: true }).catch(() => {});
      let mods = new Set<string>();
      let peak = new Set<string>();

      const finish = (chord: string | null, error?: string) => {
        window.removeEventListener("keydown", onDown, true);
        window.removeEventListener("keyup", onUp, true);
        capsBtn.removeEventListener("blur", onBlur);
        recorder.active = false;
        recorder.stop = null;
        stopChordRecording = null;
        capsBtn.classList.remove("recording");
        void command({ type: "suspend", on: false }).catch(() => {});
        if (chord && chord !== s.shortcut) {
          s.shortcut = chord;
          ctx.markDirty();
        }
        showChord(s.shortcut);
        if (error) {
          warn.textContent = error;
          warn.hidden = false;
        }
      };
      const ordered = (set: Set<string>) => MOD_ORDER.filter((m) => set.has(m));
      const onDown = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const mod = MODIFIER_KEYS[e.key];
        if (mod) {
          mods.add(mod);
          peak = new Set([...peak, mod]);
          capsBtn.replaceChildren(keycaps(ordered(peak).join("+")));
          return;
        }
        if (e.key === "Escape" && mods.size === 0) return finish(null);
        const key = keyName(e);
        if (!key) return;
        const held = ordered(mods);
        if (held.length === 0 && !LONE_OK.test(key)) {
          return finish(null, "Add a modifier to that key, or use a key like F13 or Pause.");
        }
        finish([...held, key].join("+"));
      };
      const onUp = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const mod = MODIFIER_KEYS[e.key];
        if (!mod) return;
        mods.delete(mod);
        if (mods.size === 0) {
          const chosen = ordered(peak);
          if (chosen.length >= 2) finish(chosen.join("+"));
          else finish(null, "Hold two modifiers together, like Ctrl + Win.");
        }
      };
      const onBlur = () => finish(null);
      window.addEventListener("keydown", onDown, true);
      window.addEventListener("keyup", onUp, true);
      capsBtn.addEventListener("blur", onBlur);
      stopChordRecording = () => finish(null);
      recorder.stop = stopChordRecording;
      mods = new Set();
    });
    wrap.append(capsBtn, warn);

    const modeDesc = el("p", "field-desc");
    const describe = (m: DictationSettings["mode"]) =>
      (modeDesc.textContent =
        m === "hold" ? "Hold the shortcut while you speak. Let go to finish." : "Press once to start, and again to finish.");
    describe(s.mode);
    const mode = ui.segmented(
      [
        { value: "hold", label: "Hold to talk" },
        { value: "toggle", label: "Press to start and stop" },
      ],
      s.mode,
      (v) => {
        s.mode = v;
        describe(v);
        ctx.markDirty();
      }
    );
    const modeWrap = el("div", "control-stack");
    modeWrap.append(mode, modeDesc);

    return ui.section("Shortcut", null, [
      ui.field("Shortcut", wrap, { desc: "Works everywhere in Windows. Click to record a new one.", keywords: "hotkey chord keys ctrl win" }),
      ui.field("Mode", modeWrap, { stack: true, keywords: "hold toggle press" }),
    ], { keywords: "shortcut hotkey dictation" });
  }

  function lookSection(): HTMLElement {
    const s = d();
    const styles = el("div", "dict-style-cards");
    styles.setAttribute("role", "radiogroup");
    for (const [value, label] of [["pill", "Pill"], ["glow", "Screen glow"]] as ["pill" | "glow", string][]) {
      const card = el("button", `dict-style-card dict-style-${value}`);
      card.type = "button";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(s.style === value));
      card.classList.toggle("selected", s.style === value);
      const art = el("span", "dict-style-art");
      art.appendChild(el("span", "dict-style-mark"));
      card.append(art, el("span", "dict-style-name", label));
      card.addEventListener("click", () => {
        if (s.style === value) return;
        s.style = value;
        for (const other of Array.from(styles.children)) {
          const on = other === card;
          other.classList.toggle("selected", on);
          other.setAttribute("aria-checked", String(on));
        }
        simulator.sync();
        ctx.markDirty();
      });
      styles.appendChild(card);
    }

    const soundWrap = el("div", "dict-sound");
    const hear = iconButton(ICON.play, "Hear the start sound", () => void invoke("dictation_play_sound"));
    hear.classList.add("dict-hear");
    soundWrap.append(
      hear,
      ui.toggle(s.startSound, (v) => {
        s.startSound = v;
        ctx.markDirty();
      })
    );

    return ui.section("Look & sound", null, [
      ui.field("Style", styles, { stack: true, keywords: "pill glow overlay appearance" }),
      ui.field("Start sound", soundWrap, { desc: "A soft cue when dictation starts and stops.", keywords: "sound audio cue chime" }),
    ], { keywords: "look sound style" });
  }

  let devices: string[] | null = null;
  let devicesLoading = false;

  function micSection(): HTMLElement {
    const s = d();
    const select = el("select");
    const fill = () => {
      select.replaceChildren(el("option", "", "System default"));
      (select.firstChild as HTMLOptionElement).value = "";
      for (const name of devices ?? []) {
        const o = el("option", "", name);
        o.value = name;
        select.appendChild(o);
      }
      const missing = s.micDeviceId && devices && !devices.includes(s.micDeviceId);
      if (missing) {
        const o = el("option", "", s.micDeviceId!);
        o.value = s.micDeviceId!;
        select.appendChild(o);
      }
      select.value = s.micDeviceId ?? "";
      missingHint.hidden = !missing;
    };
    const missingHint = el("p", "field-hint", "This microphone isn't connected. Dictation uses the system default until it's back.");
    fill();
    if (devices === null && !devicesLoading) {
      devicesLoading = true;
      void invoke<string[]>("dictation_list_devices").then((list) => {
        devices = list;
        devicesLoading = false;
        fill();
      });
    }
    select.addEventListener("change", () => {
      s.micDeviceId = select.value || null;
      missingHint.hidden = true;
      ctx.markDirty();
      if (meterOn) {
        stopMeter();
        startMeter();
      }
    });

    const row = el("div", "dict-mic-row");
    row.append(select, meterCanvas);
    const wrap = el("div", "control-stack");
    wrap.append(row, missingHint, meterNote);
    return ui.section("Microphone", null, [
      ui.field("Input device", wrap, { desc: "The meter moves when this microphone hears you.", keywords: "mic microphone input device level meter" }),
    ], { keywords: "microphone mic" });
  }

  function languageCombo(): HTMLElement {
    const s = d();
    const wrap = el("div", "dict-combo");
    const input = el("input");
    input.type = "text";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");
    const list = el("div", "dict-combo-list");
    list.setAttribute("role", "listbox");
    list.hidden = true;
    const options: [string | null, string][] = [[null, "Auto-detect (recommended)"], ...LANGUAGES];
    const nameOf = (code: string | null) => options.find(([c]) => c === code)?.[1] ?? "Auto-detect (recommended)";
    input.value = nameOf(s.language);
    let active = 0;
    let shown: [string | null, string][] = [];

    const render = () => {
      const q = input.value.trim().toLowerCase();
      const current = nameOf(s.language).toLowerCase();
      shown = q && q !== current ? options.filter(([, n]) => n.toLowerCase().includes(q)) : options;
      active = Math.max(0, Math.min(active, shown.length - 1));
      list.replaceChildren(
        ...shown.map(([code, name], i) => {
          const o = el("div", "dict-combo-option", name);
          o.setAttribute("role", "option");
          o.setAttribute("aria-selected", String(code === s.language));
          o.classList.toggle("active", i === active);
          o.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            pick(code);
          });
          return o;
        })
      );
      list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    };
    const open = () => {
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      active = Math.max(0, options.findIndex(([c]) => c === s.language));
      render();
    };
    const close = () => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.value = nameOf(s.language);
    };
    const pick = (code: string | null) => {
      if (s.language !== code) {
        s.language = code;
        ctx.markDirty();
      }
      close();
    };
    input.addEventListener("focus", () => {
      input.select();
      open();
    });
    input.addEventListener("input", () => {
      active = 0;
      list.hidden = false;
      render();
    });
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) return open();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (shown[active]) pick(shown[active][0]);
      } else if (e.key === "Escape") {
        e.stopPropagation();
        close();
        input.blur();
      }
    });
    wrap.append(input, list);
    return wrap;
  }

  function vocabularyControl(): HTMLElement {
    const s = d();
    const box = el("div", "dict-chips");
    const input = el("input", "dict-chip-input");
    input.type = "text";
    input.placeholder = "Add a word or name";
    input.spellcheck = false;

    const renderChips = () => {
      box.replaceChildren(
        ...s.vocabulary.map((word, i) => {
          const chip = el("span", "dict-chip");
          chip.append(el("span", "", word));
          const x = iconButton(ICON.close, `Remove ${word}`, () => {
            s.vocabulary.splice(i, 1);
            ctx.markDirty();
            renderChips();
            input.focus();
          });
          chip.appendChild(x);
          return chip;
        }),
        input
      );
    };
    const add = (raw: string) => {
      const have = new Set(s.vocabulary.map((w) => w.toLowerCase()));
      let changed = false;
      for (const word of raw.split(/[,\n]/).map((w) => w.trim()).filter(Boolean)) {
        if (have.has(word.toLowerCase())) continue;
        have.add(word.toLowerCase());
        s.vocabulary.push(word);
        changed = true;
      }
      if (changed) {
        ctx.markDirty();
        renderChips();
      }
      input.value = "";
      input.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        add(input.value);
      } else if (e.key === "Backspace" && !input.value && s.vocabulary.length) {
        s.vocabulary.pop();
        ctx.markDirty();
        renderChips();
        input.focus();
      }
    });
    input.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (/[,\n]/.test(text)) {
        e.preventDefault();
        add(text);
      }
    });
    box.addEventListener("click", (e) => {
      if (e.target === box) input.focus();
    });
    renderChips();

    const reset = ui.btn("dict-link", "Reset to defaults", () => {
      s.vocabulary = [...DEFAULT_VOCABULARY];
      ctx.markDirty();
      renderChips();
    });
    const wrap = el("div", "control-stack dict-vocab");
    wrap.append(box, reset);
    return wrap;
  }

  function languageSection(): HTMLElement {
    const s = d();
    const styleDesc = el("p", "field-desc");
    const describe = (v: DictationSettings["transcribeStyle"]) =>
      (styleDesc.textContent =
        v === "clean" ? "Leaves out filler like um and false starts." : "Keeps every word exactly as spoken.");
    describe(s.transcribeStyle);
    const styleWrap = el("div", "control-stack");
    styleWrap.append(
      ui.segmented(
        [
          { value: "clean", label: "Clean" },
          { value: "verbatim", label: "Verbatim" },
        ],
        s.transcribeStyle,
        (v) => {
          s.transcribeStyle = v;
          describe(v);
          ctx.markDirty();
        }
      ),
      styleDesc
    );

    return ui.section("Language & accuracy", null, [
      ui.field("Language", languageCombo(), {
        desc: "Auto-detect handles mixed languages and is best unless it keeps getting yours wrong. Picking one is a very strong hint.",
        keywords: "language locale auto detect",
      }),
      ui.field("Transcript style", styleWrap, { stack: true, keywords: "clean verbatim filler" }),
      ui.field(
        "AI polish",
        ui.toggle(s.aiPolish, (v) => {
          s.aiPolish = v;
          ctx.markDirty();
        }),
        { desc: "Runs your text through DeepSeek using your OpenRouter key. Adds about a second.", keywords: "deepseek punctuation polish ai" }
      ),
      ui.field("Vocabulary", vocabularyControl(), {
        stack: true,
        desc: "Names and terms to expect. These are hints, so a long list is fine.",
        keywords: "vocabulary words phrases names terms",
      }),
    ], { keywords: "language accuracy transcription" });
  }

  function recordingSection(): HTMLElement {
    const s = d();
    const stepper = el("div", "dict-stepper");
    const value = el("span", "dict-stepper-value");
    const minus = iconButton(ICON.minus, "Shorter", () => change(-1));
    const plus = iconButton(ICON.plus, "Longer", () => change(1));
    const show = () => {
      const m = Math.round(s.maxSeconds / 60);
      value.textContent = `${m} min`;
      minus.disabled = m <= 1;
      plus.disabled = m >= 15;
    };
    const change = (delta: number) => {
      const m = Math.min(15, Math.max(1, Math.round(s.maxSeconds / 60) + delta));
      if (m * 60 === s.maxSeconds) return;
      s.maxSeconds = m * 60;
      show();
      ctx.markDirty();
    };
    show();
    stepper.append(minus, value, plus);
    return ui.section("Recording", null, [
      ui.field("Maximum length", stepper, {
        desc: "Recording stops and transcribes on its own at this length. The last 10 seconds count down.",
        keywords: "max length limit minutes",
      }),
      ui.field(
        "Keep the destination",
        ui.toggle(s.lockTarget, (v) => {
          s.lockTarget = v;
          ctx.markDirty();
        }),
        {
          desc: "Sends the transcript back to the window and pane you were in when you started talking, switching to it if you moved on. Off types wherever you happen to be when the text comes back.",
          keywords: "target destination pane window focus paste agent lock",
        }
      ),
    ], { keywords: "recording length destination target" });
  }

  function availabilitySection(): HTMLElement {
    const s = d();
    const cards = el("div", "dict-radio-cards");
    cards.setAttribute("role", "radiogroup");
    const options: [DictationSettings["availability"], string, string][] = [
      ["always", "Always ready", "Starts with Windows and runs quietly in the tray."],
      ["whileOpen", "Only while OpenTerm is open", "Dictation stops when you close OpenTerm."],
    ];
    for (const [value, title, desc] of options) {
      const card = el("button", "dict-radio-card");
      card.type = "button";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(s.availability === value));
      card.classList.toggle("selected", s.availability === value);
      const text = el("span", "dict-radio-text");
      text.append(el("span", "dict-radio-title", title), el("span", "dict-radio-desc", desc));
      card.append(el("span", "dict-radio-dot"), text);
      card.addEventListener("click", () => {
        if (s.availability === value) return;
        s.availability = value;
        for (const other of Array.from(cards.children)) {
          const on = other === card;
          other.classList.toggle("selected", on);
          other.setAttribute("aria-checked", String(on));
        }
        ctx.markDirty();
      });
      cards.appendChild(card);
    }
    const enabled = ui.toggle(s.enabled, (v) => {
      s.enabled = v;
      ctx.markDirty();
    });
    enabled.setAttribute("aria-label", "Dictation on");
    return ui.section("Availability", null, [
      ui.field("Dictation", enabled, { desc: "Turn off to stop listening for the shortcut entirely.", keywords: "enable disable on off" }),
      ui.field("When", cards, { stack: true, keywords: "startup tray windows login autostart" }),
    ], { keywords: "availability autostart startup" });
  }

  function noKeyCard(): HTMLElement {
    const card = el("div", "dict-nokey");
    card.append(
      el("p", "", "Add your OpenRouter key to start dictating."),
      ui.btn("btn-primary", "Go to AI & Agents", () => ctx.openAiCategory())
    );
    return card;
  }

  // ------------------------------------------------------------ render
  function render(): HTMLElement {
    stopChordRecording?.();
    if (pane === null) pane = hasKey() ? "history" : "setup";

    const sim = ui.section("Preview", null, [simulator.el], { className: "dict-sim-section", keywords: "simulator preview position" });
    const sections = [
      sim,
      shortcutSection(),
      lookSection(),
      micSection(),
      languageSection(),
      recordingSection(),
      availabilitySection(),
    ];
    setupPane.replaceChildren(...(hasKey() ? [] : [noKeyCard()]), ...sections);
    simulator.sync();
    if (snapshot) renderHistory();
    showPane(pane);
    return root;
  }

  return { render };
}
