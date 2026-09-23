// The dictation overlay renderers: the pill and the screen glow. The agent's
// overlay windows and the Settings simulator use these same classes, so the
// preview is exactly what shows on screen.
//
// Only transform and opacity ever change on the DOM. Geometry is driven by a
// single rAF loop (springs + tweens) that stops whenever nothing is visible.

import "./overlay.css";

export type Anchor = { v: "top" | "bottom"; h: "left" | "center" | "right" };
export type NoticeKind = "info" | "error" | "done";

const H = 44;
const DOT = 10;
const REST_W = 168;
/** Width with the timer next to the bars (shown from the first second). */
const TIMER_W = 224;
const MARGIN = 24;
const BARS = 24;
const BAR_W = 3;
const BAR_GAP = 3;
const MAX_BAR = 26;
const BARS_CANVAS_W = 150;
/** Room around the capsule for the rim's glow (matches .dp-rim offsets). */
const RIM_PAD = 14;
const TAU = Math.PI * 2;

type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a)})`;
function parseRgb(css: string): RGB | null {
  const m = css.match(/[\d.]+/g);
  return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : null;
}

const ATTACK = 0.035;
const RELEASE = 0.14;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp(t), 3);

export function prefersReducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t * t * t;
const smooth = (current: number, target: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-dt / (target > current ? ATTACK : RELEASE)));

class Spring {
  velocity = 0;
  target: number;
  constructor(public value: number, private stiffness = 420, private damping = 32) {
    this.target = value;
  }
  step(dt: number): void {
    // Two substeps keep a stiff spring stable on a slow frame.
    const h = dt / 2;
    for (let i = 0; i < 2; i++) {
      const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
    }
  }
  snap(v: number): void {
    this.value = this.target = v;
    this.velocity = 0;
  }
  get settled(): boolean {
    return Math.abs(this.value - this.target) < 0.002 && Math.abs(this.velocity) < 0.02;
  }
}

/** Bars are ordered from the center out, alternating sides, so the low bands
 *  (where most voice energy is) sit in the middle and the shape stays balanced. */
const BAR_BAND: number[] = Array.from({ length: BARS }, (_, j) => {
  const d = Math.floor(Math.abs(j - (BARS - 1) / 2));
  return Math.min(BARS - 1, d * 2 + (j < BARS / 2 ? 0 : 1));
});

// A short recorded voice envelope (syllable start, length, loudness), used by
// the simulator and the "Show on screen" preview.
const SYLLABLES: [number, number, number][] = [
  [0.08, 0.2, 0.75], [0.33, 0.16, 0.55], [0.54, 0.3, 1], [0.92, 0.14, 0.45],
  [1.12, 0.26, 0.9], [1.46, 0.18, 0.65], [1.72, 0.34, 0.95], [2.14, 0.12, 0.4],
];

export function demoLevels(t: number, out: Uint8Array): void {
  const tt = t % 2.4;
  let env = 0;
  for (const [s, d, a] of SYLLABLES) {
    if (tt >= s && tt < s + d) env = Math.max(env, a * Math.sin(Math.PI * ((tt - s) / d)) ** 0.7);
  }
  for (let b = 0; b < BARS; b++) {
    const formant = Math.exp(-((b - 5) ** 2) / 18) + 0.55 * Math.exp(-((b - 13) ** 2) / 10) + 0.18;
    const jitter = 0.85 + 0.15 * Math.sin(t * 23 + b * 1.7) * Math.sin(t * 7.1 + b);
    out[b] = Math.round(clamp(env * formant * jitter) * 255);
  }
  out[BARS] = Math.round(env * 230);
}

function sizeCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function div(className: string, parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  parent?.appendChild(d);
  return d;
}

/** A capsule drawn from two half-circle caps and a stretched middle, so its
 *  width can change through transforms alone without distorting the ends. */
function capsule(className: string, parent: HTMLElement) {
  const root = div(className, parent);
  const l = div("dp-cap dp-cap-l", root);
  div("dp-cap-disc", l);
  const m = div("dp-mid", root);
  const r = div("dp-cap dp-cap-r", root);
  div("dp-cap-disc", r);
  return {
    root,
    setWidth(w: number) {
      m.style.transform = `translateX(${H / 2 - 0.5}px) scaleX(${Math.max(0, w - H + 1) / 100})`;
      r.style.transform = `translateX(${w - H / 2}px)`;
    },
  };
}

type Script = { t: number; listen: number; think: number; loop: boolean; phase: number };

type PillMode = "idle" | "listening" | "thinking" | "done" | "notice" | "exit";

export interface PillOptions {
  /** The simulator: never hides for good, and its position is draggable. */
  embedded?: boolean;
}

export class PillRenderer {
  readonly el: HTMLDivElement;
  onFinished: ((seq: number) => void) | null = null;
  onClick: (() => void) | null = null;

  private pill: HTMLDivElement;
  private surface: ReturnType<typeof capsule>;
  private ring: ReturnType<typeof capsule>;
  private dot: HTMLDivElement;
  private content: HTMLDivElement;
  private bars: HTMLCanvasElement;
  private barsCtx: CanvasRenderingContext2D;
  private timer: HTMLDivElement;
  private ringCanvas: HTMLCanvasElement;
  private ringCtx: CanvasRenderingContext2D;
  private label: HTMLDivElement;
  private check: HTMLCanvasElement;
  private checkCtx: CanvasRenderingContext2D;
  private hint: HTMLDivElement;
  private rim: HTMLCanvasElement;
  private rimCtx: CanvasRenderingContext2D;
  private rimCap = 0;
  private rimAngle = -Math.PI / 2;
  private rimThink = 0;
  private rimFlash = 0;
  private textRgb: RGB = [236, 236, 236];
  private accentRgb: RGB = [232, 180, 90];

  private anchor: Anchor = { v: "bottom", h: "center" };
  private ax = new Spring(0, 380, 30);
  private ay = new Spring(0, 380, 30);
  private dragging = false;
  private seq = 0;
  private mode: PillMode = "idle";
  private modeAt = 0;
  private P = new Spring(0);
  private W = new Spring(REST_W, 520, 42);
  private opacity = 1;
  private exitKind: "shrink" | "sink" = "shrink";
  private exitFrom = 1;
  private holdMs = 0;
  private hintOn = false;
  private startedAt = 0;
  private maxSeconds = 300;
  private polishing = false;
  private waveMix = 0;
  private wavePhase = 0;
  private wavePeriod = 1.2;
  private flat = 0;
  private checkAt = -1;
  private labelW = 0;
  private timerShown = false;
  private accent = "#e8b45a";
  private target = new Float32Array(BARS + 1);
  private cur = new Float32Array(BARS);
  private rms = 0;
  private raf = 0;
  private last = 0;
  private reduced = prefersReducedMotion();
  private script: Script | null = null;
  private demoBuf = new Uint8Array(BARS + 1);
  paused = false;

  constructor(container: HTMLElement, private opts: PillOptions = {}) {
    this.el = div("dp-stage");
    this.el.hidden = true;
    this.pill = div("dp-pill", this.el);
    this.surface = capsule("dp-surface", this.pill);
    this.rim = document.createElement("canvas");
    this.rim.className = "dp-rim";
    this.pill.appendChild(this.rim);
    this.rimCtx = this.rim.getContext("2d")!;
    this.ensureRim(TIMER_W + 80);
    this.ring = capsule("dp-ring", this.pill);
    div("dp-sweep", div("dp-clip", this.pill));
    this.dot = div("dp-dot", this.el);
    this.content = div("dp-content", this.el);
    this.bars = document.createElement("canvas");
    this.bars.className = "dp-bars";
    this.barsCtx = sizeCanvas(this.bars, BARS_CANVAS_W, H);
    this.timer = div("dp-timer", this.content);
    this.ringCanvas = document.createElement("canvas");
    this.ringCanvas.className = "dp-countdown";
    this.ringCtx = sizeCanvas(this.ringCanvas, 14, 14);
    this.label = div("dp-label", this.content);
    this.check = document.createElement("canvas");
    this.check.className = "dp-check";
    this.checkCtx = sizeCanvas(this.check, 18, 18);
    this.content.prepend(this.bars);
    this.content.append(this.ringCanvas, this.check);
    this.hint = div("dp-hint", this.el);
    this.hint.textContent = "Esc to cancel";
    this.pill.addEventListener("click", () => {
      if (this.el.classList.contains("dp-clickable")) this.onClick?.();
    });
    container.appendChild(this.el);
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => (this.reduced = e.matches));
  }

  /** Re-read theme colors (canvas can't use CSS variables directly). */
  refreshTheme(): void {
    this.accent = getComputedStyle(this.el).getPropertyValue("--accent").trim() || this.accent;
    this.textRgb = parseRgb(getComputedStyle(this.el).color) ?? this.textRgb;
    this.accentRgb = parseRgb(getComputedStyle(this.dot).backgroundColor) ?? this.accentRgb;
  }

  /** The rim canvas only reallocates when the capsule outgrows it. */
  private ensureRim(w: number): void {
    if (w + RIM_PAD * 2 <= this.rimCap) return;
    this.rimCap = Math.ceil(w + RIM_PAD * 2 + 80);
    this.rimCtx = sizeCanvas(this.rim, this.rimCap, H + RIM_PAD * 2);
  }

  /** The container's size (the stage itself may be hidden right now). */
  private get size() {
    const box = this.el.parentElement ?? this.el;
    return { w: box.clientWidth, h: box.clientHeight };
  }

  /** Where the capsule is right now, in container pixels. */
  get center(): { x: number; y: number; w: number } {
    return { x: this.ax.value, y: this.ay.value, w: this.W.value };
  }

  /** Capsule center for an anchor, in container pixels. */
  anchorPoint(a: Anchor, w = this.W.target): { x: number; y: number } {
    const { w: cw, h: ch } = this.size;
    const x = a.h === "left" ? MARGIN + w / 2 : a.h === "right" ? cw - MARGIN - w / 2 : cw / 2;
    const y = a.v === "top" ? MARGIN + H / 2 : ch - MARGIN - H / 2;
    return { x, y };
  }

  setAnchor(a: Anchor, animate = false): void {
    this.anchor = a;
    const p = this.anchorPoint(a);
    if (animate && !this.reduced) {
      this.ax.target = p.x;
      this.ay.target = p.y;
    } else {
      this.ax.snap(p.x);
      this.ay.snap(p.y);
    }
    this.kick();
  }

  /** Simulator drag: follow the pointer until released. */
  dragTo(x: number, y: number): void {
    this.dragging = true;
    this.ax.snap(x);
    this.ay.snap(y);
    this.kick();
  }

  endDrag(): void {
    this.dragging = false;
  }

  get visible(): boolean {
    return this.mode !== "idle";
  }

  private enter(mode: PillMode): void {
    this.mode = mode;
    this.modeAt = performance.now();
  }

  private resetVisuals(): void {
    this.target.fill(0);
    this.cur.fill(0);
    this.rms = 0;
    this.waveMix = 0;
    this.flat = 0;
    this.checkAt = -1;
    this.check.style.opacity = "0";
    this.timerShown = false;
    this.polishing = false;
    this.wavePeriod = 1.2;
    this.rimThink = 0;
    this.rimFlash = 0;
    this.opacity = 1;
    this.el.classList.remove("dp-error", "dp-clickable", "dp-show-label", "dp-show-timer", "dp-thinking", "dp-countdown-on");
    this.label.textContent = "";
  }

  private appear(): void {
    this.el.hidden = false;
    this.refreshTheme();
    this.W.snap(REST_W);
    if (this.reduced) {
      this.P.snap(1);
      this.opacity = 0;
    } else {
      this.P.snap(0);
      this.P.target = 1;
    }
  }

  begin(o: { seq: number; anchor: Anchor; hint: boolean; maxSeconds: number }): void {
    this.script = null;
    this.seq = o.seq;
    this.resetVisuals();
    this.hintOn = o.hint;
    this.maxSeconds = o.maxSeconds;
    this.startedAt = performance.now();
    this.appear();
    this.timerShown = true;
    this.timer.textContent = "0:00";
    this.el.classList.add("dp-show-timer");
    this.W.snap(TIMER_W);
    if (!this.opts.embedded || !this.dragging) this.setAnchor(o.anchor);
    this.enter("listening");
    this.kick();
  }

  levels(bytes: Uint8Array): void {
    for (let i = 0; i <= BARS; i++) this.target[i] = (bytes[i] ?? 0) / 255;
  }

  thinking(polishing: boolean): void {
    if (this.mode === "listening") {
      this.enter("thinking");
      this.el.classList.add("dp-thinking");
      this.el.classList.remove("dp-show-timer", "dp-countdown-on");
      this.W.target = REST_W;
    }
    this.polishing = polishing;
    this.kick();
  }

  /** A line of text on the working pill ("Rate limited · retrying 2/5"); empty
   *  clears it. Only meaningful while a job is in flight. */
  status(text: string): void {
    if (this.mode !== "thinking") return;
    if (!text) {
      this.el.classList.remove("dp-show-label");
      this.label.textContent = "";
      this.W.target = REST_W;
      return;
    }
    this.setLabel(text, false);
    this.el.classList.add("dp-show-label");
    this.kick();
  }

  private setLabel(text: string, check: boolean): void {
    this.label.textContent = text;
    this.labelW = this.label.offsetWidth;
    // Check mark and label are centered as one group.
    const group = this.labelW + (check ? 24 : 0);
    this.check.style.transform = `translate(${-group / 2}px, -9px)`;
    this.label.style.left = `${-group / 2 + (check ? 24 : 0)}px`;
    this.check.style.opacity = check ? "1" : "0";
    this.W.target = Math.max(REST_W - 40, group + 44);
  }

  done(label: string): void {
    if (this.mode === "idle") return;
    this.el.classList.remove("dp-thinking", "dp-show-timer", "dp-countdown-on");
    this.setLabel(label, true);
    this.el.classList.add("dp-show-label");
    this.enter("done");
    this.checkAt = performance.now() + 120;
    this.rimFlash = 1;
    // "Pasted" needs a glance; an instruction needs reading time.
    this.holdMs = label === "Pasted" ? 700 : 1800;
    this.kick();
  }

  notice(o: { seq: number; text: string; kind: NoticeKind; anchor: Anchor; clickable: boolean; morph: boolean }): void {
    this.script = null;
    this.seq = o.seq;
    const morph = o.morph && this.mode !== "idle" && this.mode !== "exit";
    if (!morph) {
      this.resetVisuals();
      this.appear();
      this.setAnchor(o.anchor);
    } else {
      this.el.classList.remove("dp-thinking", "dp-show-timer", "dp-countdown-on");
    }
    this.hintOn = false;
    this.flat = 1;
    this.setLabel(o.text, o.kind === "done");
    this.el.classList.add("dp-show-label");
    this.el.classList.toggle("dp-error", o.kind === "error");
    this.el.classList.toggle("dp-clickable", o.clickable);
    this.checkAt = o.kind === "done" ? performance.now() + 120 : -1;
    this.holdMs = o.kind === "error" ? 2800 : o.kind === "done" ? 1800 : 1200;
    this.enter("notice");
    this.kick();
  }

  cancel(): void {
    if (this.mode === "idle" || this.mode === "exit") return;
    this.target.fill(0);
    this.exit("sink");
  }

  private exit(kind: "shrink" | "sink"): void {
    this.exitKind = kind;
    this.exitFrom = this.P.value;
    this.el.classList.remove("dp-clickable");
    this.enter("exit");
    this.kick();
  }

  /** Scripted run through listening, thinking and done ("Show on screen" and the simulator). */
  demo(o: { seq: number; anchor: Anchor; listen: number; think: number; loop: boolean }): void {
    this.begin({ seq: o.seq, anchor: o.anchor, hint: false, maxSeconds: 300 });
    this.script = { t: 0, listen: o.listen, think: o.think, loop: o.loop, phase: 0 };
  }

  hideNow(): void {
    this.script = null;
    this.mode = "idle";
    this.el.hidden = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private kick(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private runScript(dt: number): void {
    const s = this.script;
    if (!s || this.paused) return;
    s.t += dt;
    if (s.phase === 0) {
      demoLevels(s.t, this.demoBuf);
      this.levels(this.demoBuf);
      if (s.t >= s.listen) {
        s.phase = 1;
        this.target.fill(0);
        this.thinking(false);
      }
    } else if (s.phase === 1 && s.t >= s.listen + s.think) {
      s.phase = 2;
      this.done("Pasted");
    }
  }

  private frame(now: number): void {
    this.raf = 0;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.runScript(dt);
    if (this.paused && this.script) {
      // Hovering the simulator freezes every timed hold too, not just the script.
      this.modeAt += dt * 1000;
      if (this.checkAt >= 0) this.checkAt += dt * 1000;
    }
    const since = now - this.modeAt;

    this.P.step(dt);
    this.W.step(dt);
    if (!this.dragging) {
      this.ax.step(dt);
      this.ay.step(dt);
    }
    // Keep left/right anchored pills pinned to their edge as the width changes.
    if (!this.dragging && this.anchor.h !== "center") {
      const p = this.anchorPoint(this.anchor, this.W.value);
      this.ax.target = p.x;
      if (this.ax.settled || this.reduced) this.ax.snap(p.x);
    }

    let p = this.P.value;
    let extraY = 0;
    let fade = 1;
    if (this.reduced) {
      // States crossfade instead of springing.
      this.opacity = this.mode === "exit" ? clamp(1 - since / 180) : clamp(this.opacity + dt / 0.15);
      fade = this.opacity;
      p = 1;
    }

    switch (this.mode) {
      case "listening": {
        const elapsed = (now - this.startedAt) / 1000;
        const left = this.maxSeconds - elapsed;
        if (this.timerShown) {
          const secs = left <= 10 ? Math.max(0, Math.ceil(left)) : Math.floor(elapsed);
          const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
          if (this.timer.textContent !== text) this.timer.textContent = text;
          this.el.classList.toggle("dp-countdown-on", left <= 10);
          if (left <= 10) this.drawCountdown(clamp(left / 10));
        }
        break;
      }
      case "thinking":
        this.waveMix = clamp(this.waveMix + dt / 0.42);
        break;
      case "done":
      case "notice": {
        this.flat = clamp(this.flat + dt / 0.16);
        const checkDone = this.checkAt < 0 || now >= this.checkAt + 260;
        if (checkDone && now - this.modeAt >= this.holdMs + (this.checkAt < 0 ? 0 : 380)) this.exit("shrink");
        break;
      }
      case "exit": {
        const dur = this.exitKind === "sink" ? 180 : 280;
        const e = clamp(since / dur);
        if (this.exitKind === "sink") {
          extraY = 6 * easeOut(e);
          fade *= 1 - easeOut(e);
          p = this.reduced ? 1 : this.exitFrom * (1 - 0.08 * easeOut(e));
        } else if (!this.reduced) {
          p = this.exitFrom * (1 - easeIn(e));
          fade *= 1 - clamp((e - 0.55) / 0.45);
        }
        if (e >= 1) return this.finish();
        break;
      }
    }

    this.render(now, dt, p, extraY, fade);

    if (this.mode !== "idle") this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private finish(): void {
    this.mode = "idle";
    this.el.hidden = !this.opts.embedded;
    this.el.classList.remove("dp-show-label", "dp-error", "dp-clickable", "dp-thinking");
    this.pill.style.opacity = "0";
    this.content.style.opacity = "0";
    this.dot.style.opacity = "0";
    this.hint.style.opacity = "0";
    this.script = null;
    this.onFinished?.(this.seq);
  }

  private render(now: number, dt: number, p: number, extraY: number, fade: number): void {
    const w = H + (this.W.value - H) * clamp(p, 0, 1.15);
    const s = lerp(DOT / H, 1, p);
    const cx = this.ax.value;
    const cy = this.ay.value + extraY + (this.anchor.v === "bottom" ? (H / 2) * (1 - s) : -(H / 2) * (1 - s));

    const shape = `translate(${cx}px, ${cy}px) scale(${s}) translate(${-w / 2}px, ${-H / 2}px)`;
    this.pill.style.transform = shape;
    this.pill.style.opacity = String(clamp(p * 3) * fade);
    this.surface.setWidth(w);
    this.ring.setWidth(w);

    this.dot.style.transform = `translate(${cx - DOT / 2}px, ${cy - DOT / 2}px) scale(${(s * H) / DOT})`;
    this.dot.style.opacity = String(clamp(1 - p * 2.4) * fade);

    const contentOpacity = clamp((p - 0.6) / 0.4) * fade;
    this.content.style.transform = `translate(${cx}px, ${cy}px) scale(${s})`;
    this.content.style.opacity = String(contentOpacity);

    const hintShow = this.hintOn && this.mode === "listening" ? contentOpacity : 0;
    this.hint.style.transform = `translate(${cx}px, ${cy + H / 2 + 6}px)`;
    this.hint.style.opacity = String(hintShow);

    this.drawRim(dt, w);
    this.drawBars(now, dt);
    if (this.checkAt >= 0) this.drawCheck(clamp((now - this.checkAt) / 260));
  }

  private drawBars(now: number, dt: number): void {
    const ctx = this.barsCtx;
    ctx.clearRect(0, 0, BARS_CANVAS_W, H);
    const listening = this.mode === "listening";
    this.rms = smooth(this.rms, this.target[BARS], dt);
    if (this.mode === "thinking") {
      // Slows a little while polishing: a second step, without any text.
      const period = this.polishing ? 1.6 : 1.2;
      this.wavePeriod = lerp(this.wavePeriod, period, clamp(dt * 3));
      this.wavePhase += (dt / this.wavePeriod) * Math.PI * 2;
    }
    const t = now / 1000;
    const start = (BARS_CANVAS_W - (BARS * BAR_W + (BARS - 1) * BAR_GAP)) / 2;
    const wave = easeOut(this.waveMix);
    const flat = easeOut(this.flat);
    ctx.fillStyle = this.accent;
    for (let j = 0; j < BARS; j++) {
      const band = this.target[BAR_BAND[j]];
      const level = listening ? band * 0.65 + this.target[BARS] * 0.35 : 0;
      this.cur[j] = smooth(this.cur[j], level, dt);
      const v = this.cur[j];
      // Silence settles into gently breathing dots so the pill never looks frozen.
      const breathe = 1 + 0.08 * Math.sin(t * ((Math.PI * 2) / 1.8) + j * 0.35);
      let h = v < 0.04 ? BAR_W * breathe : BAR_W + (MAX_BAR - BAR_W) * v ** 0.8;
      let alpha = 1;
      if (wave > 0) {
        // Thinking: a ripple leaves the center and runs to both ends; while
        // polishing it runs back inward. Lit bars grow taller and brighter.
        const d = Math.abs(j - (BARS - 1) / 2) / ((BARS - 1) / 2);
        const dir = this.polishing ? -1 : 1;
        const pulse = (0.5 + 0.5 * Math.cos(TAU * (d * 0.85) - this.wavePhase * dir)) ** 3;
        const wh = BAR_W + 1.5 + 13 * pulse * (1 - 0.4 * d);
        h = lerp(h, wh, wave);
        alpha = lerp(1, 0.32 + 0.68 * pulse, wave);
      }
      if (flat > 0) {
        h = lerp(h, 2, flat);
        alpha = lerp(alpha, 1, flat);
      }
      const x = start + j * (BAR_W + BAR_GAP);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.roundRect(x, (H - h) / 2, BAR_W, h, BAR_W / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** The glass outline, a faint voice-reactive glow, and the light that
   *  circles the rim while transcribing. */
  private drawRim(dt: number, w: number): void {
    this.ensureRim(w);
    const ctx = this.rimCtx;
    ctx.clearRect(0, 0, this.rimCap, H + RIM_PAD * 2);
    const thinking = this.mode === "thinking";
    this.rimThink = clamp(this.rimThink + (thinking ? dt / 0.45 : -dt / 0.25));
    this.rimFlash = clamp(this.rimFlash - dt / 0.7);
    if (thinking && !this.reduced) this.rimAngle += dt * (TAU / (this.polishing ? 2.4 : 1.7));

    const x = RIM_PAD + 0.5;
    const y = RIM_PAD + 0.5;
    const rw = Math.max(H - 1, w - 1);
    const rh = H - 1;
    ctx.beginPath();
    ctx.roundRect(x, y, rw, rh, rh / 2);

    // Glass edge: a lit lip on top, nearly clear along the sides, a soft
    // return at the bottom.
    const edge = ctx.createLinearGradient(0, y, 0, y + rh);
    edge.addColorStop(0, rgba(this.textRgb, 0.3));
    edge.addColorStop(0.4, rgba(this.textRgb, 0.08));
    edge.addColorStop(0.75, rgba(this.textRgb, 0.05));
    edge.addColorStop(1, rgba(this.textRgb, 0.14));
    ctx.lineWidth = 1;
    ctx.strokeStyle = edge;
    ctx.stroke();

    const error = this.el.classList.contains("dp-error");
    const voice = this.mode === "listening" ? 0.1 + 0.5 * this.rms : 0;
    const accentA = error ? 0 : Math.max(voice, 0.55 * easeOut(this.rimFlash));
    ctx.save();
    ctx.shadowColor = rgba(this.accentRgb, 0.9);
    if (accentA > 0.005) {
      ctx.shadowBlur = 6 + 8 * accentA;
      ctx.strokeStyle = rgba(this.accentRgb, accentA);
      ctx.stroke();
    }
    const think = easeOut(this.rimThink);
    if (think > 0.005 && !error) {
      const cx = x + rw / 2;
      const cy = y + rh / 2;
      const g = ctx.createConicGradient(this.rimAngle, cx, cy);
      const a = this.reduced ? 0.45 : 1;
      // Two opposing comets: a long tail, a bright head, a quick falloff.
      for (const o of [0, 0.5]) {
        g.addColorStop(o, rgba(this.accentRgb, 0));
        g.addColorStop(o + 0.2, rgba(this.accentRgb, 0.55 * a));
        g.addColorStop(o + 0.26, rgba(this.accentRgb, a));
        g.addColorStop(o + 0.3, rgba(this.accentRgb, 0));
      }
      g.addColorStop(1, rgba(this.accentRgb, 0));
      ctx.globalAlpha = think;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = g;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCheck(k: number): void {
    const ctx = this.checkCtx;
    ctx.clearRect(0, 0, 18, 18);
    if (k <= 0) return;
    const pts: [number, number][] = [[3.5, 9.5], [7.4, 13.2], [14.8, 5.2]];
    const seg1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    const seg2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
    let len = easeOut(k) * (seg1 + seg2);
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(...pts[0]);
    const a = Math.min(1, len / seg1);
    ctx.lineTo(lerp(pts[0][0], pts[1][0], a), lerp(pts[0][1], pts[1][1], a));
    len -= seg1;
    if (len > 0) {
      const b = Math.min(1, len / seg2);
      ctx.lineTo(lerp(pts[1][0], pts[2][0], b), lerp(pts[1][1], pts[2][1], b));
    }
    ctx.stroke();
  }

  private drawCountdown(frac: number): void {
    const ctx = this.ringCtx;
    ctx.clearRect(0, 0, 14, 14);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = this.accent;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(7, 7, 5.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(7, 7, 5.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- screen glow

type GlowMode = "idle" | "listening" | "thinking" | "done" | "fade";

export class GlowRenderer {
  readonly el: HTMLDivElement;
  onFinished: ((seq: number) => void) | null = null;

  private edges: HTMLDivElement[];
  private mode: GlowMode = "idle";
  private modeAt = 0;
  private seq = 0;
  private level = 0;
  private target = 0;
  private depth = 0;
  private bright = 0;
  private raf = 0;
  private last = 0;
  private script: Script | null = null;
  private demoBuf = new Uint8Array(BARS + 1);
  private reduced = prefersReducedMotion();
  paused = false;

  constructor(container: HTMLElement, private opts: PillOptions = {}) {
    this.el = div("dg-stage");
    this.el.hidden = true;
    this.edges = ["top", "right", "bottom", "left"].map((side) => div(`dg-edge dg-${side}`, this.el));
    container.appendChild(this.el);
  }

  get visible(): boolean {
    return this.mode !== "idle";
  }

  private enter(m: GlowMode): void {
    this.mode = m;
    this.modeAt = performance.now();
  }

  begin(o: { seq: number }): void {
    this.script = null;
    this.seq = o.seq;
    this.level = this.target = 0;
    this.depth = 0;
    this.bright = 0;
    this.el.hidden = false;
    this.enter("listening");
    this.kick();
  }

  levels(bytes: Uint8Array): void {
    this.target = (bytes[BARS] ?? 0) / 255;
  }

  thinking(): void {
    if (this.mode === "listening") this.enter("thinking");
    this.kick();
  }

  done(): void {
    if (this.mode === "idle") return;
    this.enter("done");
    this.kick();
  }

  fade(): void {
    if (this.mode === "idle") return;
    this.enter("fade");
    this.kick();
  }

  demo(o: { seq: number; listen: number; think: number; loop: boolean }): void {
    this.begin({ seq: o.seq });
    this.script = { t: 0, listen: o.listen, think: o.think, loop: o.loop, phase: 0 };
  }

  hideNow(): void {
    this.script = null;
    this.mode = "idle";
    this.el.hidden = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private kick(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    this.raf = 0;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const s = this.script;
    if (s && this.paused) this.modeAt += dt * 1000;
    if (s && !this.paused) {
      s.t += dt;
      if (s.phase === 0) {
        demoLevels(s.t, this.demoBuf);
        this.levels(this.demoBuf);
        if (s.t >= s.listen) {
          s.phase = 1;
          this.target = 0;
          this.thinking();
        }
      } else if (s.phase === 1 && s.t >= s.listen + s.think) {
        s.phase = 2;
        this.done();
      }
    }
    const since = (now - this.modeAt) / 1000;
    this.level = smooth(this.level, this.mode === "listening" ? this.target : 0, dt);

    // Depth in px (the layers are 64 px, scaled) and brightness 0..1.
    let depth = 22;
    let bright = 0.55;
    let fade = 1;
    switch (this.mode) {
      case "listening": {
        // Your voice pushes the light in; silence leaves a slow, faint breath
        // so the edge never looks frozen.
        const idle = this.reduced ? 0 : 0.5 - 0.5 * Math.cos((now / 1000) * ((2 * Math.PI) / 3.2));
        depth = 20 + 4 * idle + 36 * this.level;
        bright = 0.5 + 0.08 * idle + 0.45 * this.level;
        break;
      }
      case "thinking": {
        // Thinking: the light settles and breathes, a calm inhale/exhale.
        const b = this.reduced ? 0.5 : 0.5 - 0.5 * Math.cos(since * ((2 * Math.PI) / 1.9));
        depth = 12 + 22 * b;
        bright = 0.42 + 0.4 * b;
        break;
      }
      case "done": {
        // One soft swell inward, then the light eases out.
        const k = clamp(since / 0.7);
        depth = 56;
        bright = 1;
        fade = k < 0.3 ? 1 : 1 - easeOutCubic((k - 0.3) / 0.7);
        if (k >= 1) return this.finish();
        break;
      }
      case "fade":
        fade = 1 - easeOutCubic(clamp(since / 0.3));
        if (since >= 0.3) return this.finish();
        break;
    }
    const intro = this.reduced ? 1 : easeOutCubic(clamp(since / 0.35));
    // Frame-rate independent easing toward the target: fluid, never twitchy.
    const rate = this.reduced ? 1 : 1 - Math.exp(-dt * (this.mode === "done" ? 10 : 7));
    this.depth = this.depth === 0 ? depth * intro : lerp(this.depth, depth, rate);
    this.bright = lerp(this.bright, bright, rate);
    const opacity = String(this.bright * fade * (this.mode === "listening" ? intro : 1));
    const [top, right, bottom, left] = this.edges;
    top.style.transform = bottom.style.transform = `scaleY(${this.depth / 64})`;
    left.style.transform = right.style.transform = `scaleX(${this.depth / 64})`;
    for (const e of this.edges) e.style.opacity = opacity;

    if (this.mode !== "idle") this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private finish(): void {
    this.mode = "idle";
    this.depth = 0;
    this.el.hidden = !this.opts.embedded;
    for (const e of this.edges) e.style.opacity = "0";
    this.script = null;
    this.onFinished?.(this.seq);
  }
}
