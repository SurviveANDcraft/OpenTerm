/** Watch faces for the expanded Timer, and the carousel that switches them.
 *
 *  Every face shows the same countdown its own way; they share one paint
 *  contract, so the timer logic never knows which is showing. Press, hold and
 *  swipe sideways on the dial to change face (or scroll sideways, or [ and ]);
 *  the choice is remembered in settings. */
import { store } from "./store";
import { formatClock, formatDuration } from "./timers";

export interface FaceState {
  leftMs: number;
  /** 0 at the start, 1 at the end. */
  progress: number;
  durationMs: number;
  running: boolean;
  paused: boolean;
  /** Within the last 15 seconds. */
  final: boolean;
  /** performance.now(), for faces that move on their own. */
  now: number;
}

interface Face {
  id: string;
  name: string;
  el: HTMLElement;
  paint(s: FaceState): void;
}

let uidSeq = 0;

function div(cls: string, html = ""): HTMLDivElement {
  const e = document.createElement("div");
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** `count` ticks around (cx, cy), major every `every`. */
function ticks(cx: number, cy: number, rOuter: number, count: number, every: number, minor: number, major: number): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const isMajor = i % every === 0;
    const a = (i / count) * Math.PI * 2;
    const r1 = rOuter - (isMajor ? major : minor);
    const x1 = cx + r1 * Math.sin(a);
    const y1 = cy - r1 * Math.cos(a);
    const x2 = cx + rOuter * Math.sin(a);
    const y2 = cy - rOuter * Math.cos(a);
    out += `<line class="${isMajor ? "maj" : ""}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
  }
  return out;
}

const endsAt = (s: FaceState): string =>
  s.paused
    ? "Paused"
    : `Ends ${new Date(Date.now() + s.leftMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

// ---------------------------------------------------------------- 1. Ring

function ring(): Face {
  const id = `tf-g${++uidSeq}`;
  const R = 58;
  const C = 2 * Math.PI * R;
  const el = div(
    "tf-face tf-ring",
    `<svg viewBox="0 0 140 140" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color: color-mix(in srgb, var(--tf-c) 70%, white)"/>
        <stop offset="1" style="stop-color: var(--tf-c)"/>
      </linearGradient></defs>
      <g class="tf-ticks">${ticks(70, 70, 69, 60, 5, 2.5, 3.5)}</g>
      <circle class="tf-track" cx="70" cy="70" r="${R}"/>
      <circle class="tf-arc" cx="70" cy="70" r="${R}" stroke="url(#${id})"/>
      <g class="tf-tip"><circle cx="70" cy="${70 - R}" r="4.6"/></g>
    </svg>
    <div class="tf-center"><div class="tf-time"></div><div class="tf-sub"></div></div>`
  );
  const arc = el.querySelector<SVGCircleElement>(".tf-arc")!;
  const tip = el.querySelector<SVGGElement>(".tf-tip")!;
  const time = el.querySelector<HTMLElement>(".tf-time")!;
  const sub = el.querySelector<HTMLElement>(".tf-sub")!;
  return {
    id: "ring",
    name: "Ring",
    el,
    paint(s) {
      const left = 1 - s.progress;
      arc.style.strokeDasharray = `${(C * left).toFixed(2)} ${C.toFixed(2)}`;
      tip.style.transform = `rotate(${(360 * left).toFixed(2)}deg)`;
      set(time, formatClock(s.leftMs));
      set(sub, `of ${formatDuration(s.durationMs)}`);
    },
  };
}

// ---------------------------------------------------------------- 2. Minimal

function minimal(): Face {
  const el = div(
    "tf-face tf-minimal",
    `<div class="tf-min-time"></div><div class="tf-min-bar"><i></i></div><div class="tf-min-sub"></div>`
  );
  const time = el.querySelector<HTMLElement>(".tf-min-time")!;
  const bar = el.querySelector<HTMLElement>(".tf-min-bar i")!;
  const sub = el.querySelector<HTMLElement>(".tf-min-sub")!;
  return {
    id: "minimal",
    name: "Minimal",
    el,
    paint(s) {
      set(time, formatClock(s.leftMs));
      bar.style.transform = `scaleX(${(1 - s.progress).toFixed(4)})`;
      set(sub, endsAt(s));
    },
  };
}

// ---------------------------------------------------------------- 3. Chrono

/** A stopwatch: the long hand sweeps through the seconds left, the subdial
 *  counts the minutes. */
function chrono(): Face {
  let nums = "";
  for (let i = 1; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    nums += `<text x="${(80 + 55 * Math.sin(a)).toFixed(1)}" y="${(80 - 55 * Math.cos(a) + 3).toFixed(1)}">${i * 5}</text>`;
  }
  const el = div(
    "tf-face tf-chrono",
    `<svg viewBox="0 0 160 160" aria-hidden="true">
      <circle class="tf-chrono-bezel" cx="80" cy="80" r="77"/>
      <circle class="tf-chrono-face" cx="80" cy="80" r="72"/>
      <g class="tf-ticks">${ticks(80, 80, 70, 60, 5, 3, 6)}</g>
      <g class="tf-chrono-nums">${nums}</g>
      <g class="tf-subdial">
        <circle cx="80" cy="106" r="16"/>
        <g class="tf-ticks">${ticks(80, 106, 15, 12, 3, 1.6, 3)}</g>
        <line class="tf-subhand" x1="80" y1="106" x2="80" y2="94"/>
      </g>
      <text class="tf-chrono-read" x="80" y="58"></text>
      <g class="tf-hand">
        <line x1="80" y1="96" x2="80" y2="16"/>
        <circle cx="80" cy="80" r="4.2"/>
      </g>
      <circle class="tf-chrono-cap" cx="80" cy="80" r="1.7"/>
    </svg>`
  );
  const hand = el.querySelector<SVGGElement>(".tf-hand")!;
  const sub = el.querySelector<SVGLineElement>(".tf-subhand")!;
  const read = el.querySelector<SVGTextElement>(".tf-chrono-read")!;
  return {
    id: "chrono",
    name: "Chrono",
    el,
    paint(s) {
      const sec = (s.leftMs / 1000) % 60;
      hand.style.transform = `rotate(${((sec / 60) * 360).toFixed(2)}deg)`;
      const min = (s.leftMs / 60_000) % 60;
      sub.style.transform = `rotate(${((min / 60) * 360).toFixed(2)}deg)`;
      set(read, formatClock(s.leftMs));
    },
  };
}

// ---------------------------------------------------------------- 4. Flip

/** Split-flap cards: on each change the top leaf falls and the new bottom
 *  half swings down to meet it. */
function flip(): Face {
  const el = div("tf-face tf-flip");
  const row = div("tf-flip-row");
  const sub = div("tf-flip-sub");
  el.append(row, sub);
  let shown = "";
  let cards: { el: HTMLElement; value: string; done?: () => void }[] = [];

  function card(ch: string): { el: HTMLElement; value: string } {
    const c = div("tf-card", `<div class="tf-half tf-top"><span>${ch}</span></div><div class="tf-half tf-bot"><span>${ch}</span></div>`);
    return { el: c, value: ch };
  }

  function rebuild(text: string): void {
    row.replaceChildren();
    cards = [];
    for (const ch of text) {
      if (ch === ":") {
        row.appendChild(div("tf-colon", "<i></i><i></i>"));
        continue;
      }
      const c = card(ch);
      cards.push(c);
      row.appendChild(c.el);
    }
  }

  /** One flap: the old top half falls to the hinge (darkening as it tips
   *  away), then the new bottom half swings down from the hinge onto the old
   *  one, which dims under its shadow meanwhile. No overshoot: a real flap
   *  stops dead on the card below. */
  function turn(c: { el: HTMLElement; value: string; done?: () => void }, next: string): void {
    // A flip still running finishes at once, so flaps never stack.
    c.done?.();
    const prev = c.value;
    c.value = next;
    const top = c.el.querySelector<HTMLElement>(".tf-top:not(.tf-leaf) span")!;
    const botHalf = c.el.querySelector<HTMLElement>(".tf-bot:not(.tf-leaf)")!;
    const bot = botHalf.querySelector<HTMLElement>("span")!;
    top.textContent = next;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      bot.textContent = next;
      return;
    }
    const leafTop = div("tf-half tf-top tf-leaf", `<span>${prev}</span>`);
    const leafBot = div("tf-half tf-bot tf-leaf", `<span>${next}</span>`);
    c.el.append(leafTop, leafBot);
    const FALL = 190;
    const SWING = 240;
    const anims = [
      leafTop.animate(
        [
          { transform: "rotateX(0deg)", filter: "brightness(1)" },
          { transform: "rotateX(-90deg)", filter: "brightness(0.55)" },
        ],
        { duration: FALL, easing: "cubic-bezier(0.5, 0, 0.75, 0.3)", fill: "forwards" }
      ),
      leafBot.animate(
        [
          { transform: "rotateX(90deg)", filter: "brightness(1.35)" },
          { transform: "rotateX(0deg)", filter: "brightness(1)" },
        ],
        { duration: SWING, delay: FALL, easing: "cubic-bezier(0.2, 0.6, 0.35, 1)", fill: "both" }
      ),
      botHalf.animate([{ filter: "brightness(1)" }, { filter: "brightness(0.62)" }], {
        duration: FALL + SWING,
        easing: "ease-in",
      }),
    ];
    const done = () => {
      if (c.done !== done) return;
      c.done = undefined;
      anims.forEach((a) => a.cancel());
      bot.textContent = next;
      leafTop.remove();
      leafBot.remove();
    };
    c.done = done;
    anims[1].onfinish = done;
  }

  return {
    id: "flip",
    name: "Flip",
    el,
    paint(s) {
      const text = formatClock(s.leftMs);
      set(sub, endsAt(s));
      if (text === shown) return;
      const digits = text.replace(/:/g, "");
      if (text.length !== shown.length || text.indexOf(":") !== shown.indexOf(":")) rebuild(text);
      else cards.forEach((c, i) => c.value !== digits[i] && turn(c, digits[i]));
      shown = text;
    },
  };
}

// ---------------------------------------------------------------- 5. Dots

/** Sixty dots, going dark one by one; the last lit one breathes. */
function dots(): Face {
  let ring = "";
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const big = i % 5 === 0;
    ring += `<circle cx="${(80 + 68 * Math.sin(a)).toFixed(2)}" cy="${(80 - 68 * Math.cos(a)).toFixed(2)}" r="${big ? 3 : 2.2}"/>`;
  }
  const el = div(
    "tf-face tf-dots",
    `<svg viewBox="0 0 160 160" aria-hidden="true"><g class="tf-dotring">${ring}</g></svg>
    <div class="tf-center"><div class="tf-time"></div><div class="tf-sub"></div></div>`
  );
  const all = Array.from(el.querySelectorAll<SVGCircleElement>(".tf-dotring circle"));
  const time = el.querySelector<HTMLElement>(".tf-time")!;
  const sub = el.querySelector<HTMLElement>(".tf-sub")!;
  let lit = -1;
  return {
    id: "dots",
    name: "Dots",
    el,
    paint(s) {
      const n = Math.ceil(60 * (1 - s.progress) - 1e-6);
      if (n !== lit) {
        lit = n;
        all.forEach((d, i) => {
          d.classList.toggle("on", i < n);
          d.classList.toggle("edge", i === n - 1);
        });
      }
      set(time, formatClock(s.leftMs));
      set(sub, endsAt(s));
    },
  };
}

// ---------------------------------------------------------------- 6. Liquid

/** A glass orb of colour that drains as time runs out, its surface moving.
 *  The time is drawn twice — page colour above the surface, ink-on-colour
 *  below it — so the digits change colour where the liquid passes. */
function liquid(): Face {
  const id = `tf-l${++uidSeq}`;
  const S = 152;
  const el = div(
    "tf-face tf-liquid",
    `<div class="tf-orb">
      <svg viewBox="0 0 ${S} ${S}" aria-hidden="true">
        <defs>
          <clipPath id="${id}c"><circle cx="${S / 2}" cy="${S / 2}" r="${S / 2 - 3}"/></clipPath>
          <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style="stop-color: color-mix(in srgb, var(--tf-c) 80%, white)"/>
            <stop offset="1" style="stop-color: color-mix(in srgb, var(--tf-c) 70%, black)"/>
          </linearGradient>
        </defs>
        <g clip-path="url(#${id}c)">
          <path class="tf-wave tf-wave-back"/>
          <path class="tf-wave tf-wave-front" fill="url(#${id}g)"/>
        </g>
      </svg>
      <div class="tf-orb-text tf-orb-text-a"></div>
      <div class="tf-orb-text tf-orb-text-b"></div>
      <div class="tf-orb-glass"></div>
    </div>`
  );
  const back = el.querySelector<SVGPathElement>(".tf-wave-back")!;
  const front = el.querySelector<SVGPathElement>(".tf-wave-front")!;
  const ta = el.querySelector<HTMLElement>(".tf-orb-text-a")!;
  const tb = el.querySelector<HTMLElement>(".tf-orb-text-b")!;
  let level = -1;

  const wave = (top: number, amp: number, len: number, phase: number): string => {
    let d = `M0 ${S}`;
    for (let x = 0; x <= S; x += 4) {
      const y = top + amp * Math.sin((x / len) * Math.PI * 2 + phase);
      d += `L${x} ${y.toFixed(2)}`;
    }
    return `${d}L${S} ${S}Z`;
  };

  return {
    id: "liquid",
    name: "Liquid",
    el,
    paint(s) {
      // Ease the surface toward the level so ticks don't step it.
      const target = 6 + (S - 12) * s.progress;
      level = level < 0 ? target : level + (target - level) * 0.12;
      const t = s.now / 1000;
      const calm = s.paused ? 0.35 : 1;
      back.setAttribute("d", wave(level - 2, 3.4 * calm, 118, t * 1.7 + 1.4));
      front.setAttribute("d", wave(level, 4.2 * calm, 152, -t * 2.3));
      const text = formatClock(s.leftMs);
      set(ta, text);
      set(tb, text);
      tb.style.clipPath = `inset(${level.toFixed(1)}px 0 0 0)`;
    },
  };
}

// ---------------------------------------------------------------- 7. Diver

/** A luxury dive watch, working the way divers use one: the hands keep the
 *  real time, the ceramic bezel is turned so its triangle sits on the minute
 *  the timer ends, and a lume arc on the minute track spans what's left. The
 *  magnified window at 3 shows the minutes left (seconds, in the last one).
 *  Built from CSS layers (steel, ceramic, sunburst) under an SVG of the
 *  printed and applied parts. */
function diver(): Face {
  const C = 80;
  const pt = (r: number, turn: number): [number, number] => [C + r * Math.sin(turn * Math.PI * 2), C - r * Math.cos(turn * Math.PI * 2)];

  // Bezel: a minute scale, numerals every 10, the first 15 minutes graduated.
  let bezel = "";
  for (let i = 0; i < 60; i++) {
    const turn = i / 60;
    if (i === 0) {
      const [ax, ay] = pt(76.5, 0);
      bezel += `<path class="dv-tri" d="M${ax - 6} ${ay - 0.5}L${ax + 6} ${ay - 0.5}L${ax} ${ay + 9}Z"/><circle class="dv-pip" cx="${ax}" cy="${ay + 3}" r="1.7"/>`;
    } else if (i % 10 === 0) {
      const [x, y] = pt(71, turn);
      bezel += `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" transform="rotate(${turn * 360} ${x.toFixed(2)} ${y.toFixed(2)})">${i}</text>`;
    } else if (i % 5 === 0 || i < 15) {
      const [x1, y1] = pt(i % 5 === 0 ? 76 : 76.5, turn);
      const [x2, y2] = pt(i % 5 === 0 ? 68 : 72.5, turn);
      bezel += `<line class="${i % 5 === 0 ? "maj" : ""}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
    }
  }

  // Dial: minute track, applied indices (a triangle at 12, batons at 6 and 9,
  // the window at 3, round markers elsewhere), and the printed text.
  let track = "";
  for (let i = 0; i < 60; i++) {
    const [x1, y1] = pt(57.5, i / 60);
    const [x2, y2] = pt(i % 5 === 0 ? 54 : 55.5, i / 60);
    track += `<line class="${i % 5 === 0 ? "maj" : ""}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
  }
  let indices = "";
  for (let h = 0; h < 12; h++) {
    const turn = h / 12;
    if (h === 0) {
      indices += `<path class="dv-idx" d="M${C - 5.6} ${C - 51}L${C + 5.6} ${C - 51}L${C} ${C - 40.5}Z"/>`;
    } else if (h === 3) {
      continue;
    } else if (h === 6 || h === 9) {
      const [x, y] = pt(46, turn);
      const rot = h === 6 ? 0 : 90;
      indices += `<rect class="dv-idx" x="${(x - 2.6).toFixed(2)}" y="${(y - 6.5).toFixed(2)}" width="5.2" height="13" rx="0.8" transform="rotate(${rot} ${x.toFixed(2)} ${y.toFixed(2)})"/>`;
    } else {
      const [x, y] = pt(47.5, turn);
      indices += `<circle class="dv-idx" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.7"/>`;
    }
  }

  const id = `dv${++uidSeq}`;
  const el = div(
    "tf-face tf-diver",
    `<div class="dv-watch">
      <div class="dv-crown"></div>
      <div class="dv-case"></div>
      <div class="dv-bezel"><svg viewBox="0 0 160 160" aria-hidden="true"><g class="dv-bezel-marks">${bezel}</g></svg></div>
      <div class="dv-rehaut"></div>
      <div class="dv-dial"></div>
      <svg class="dv-top" viewBox="0 0 160 160" aria-hidden="true">
        <defs>
          <linearGradient id="${id}m" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#ffffff"/>
            <stop offset="0.5" stop-color="#b9c0c9"/>
            <stop offset="1" stop-color="#eef1f5"/>
          </linearGradient>
        </defs>
        <path class="dv-arc" fill="none"/>
        <g class="dv-track">${track}</g>
        <g class="dv-indices" stroke="url(#${id}m)">${indices}</g>
        <text class="dv-brand" x="${C}" y="${C - 22}">OPENTERM</text>
        <text class="dv-model" x="${C}" y="${C + 25}">COUNTDOWN</text>
        <text class="dv-left" x="${C}" y="${C + 33}"></text>
        <g class="dv-window">
          <rect stroke="url(#${id}m)" x="${C + 40}" y="${C - 6}" width="13" height="12" rx="1.4"/>
          <text class="dv-date" x="${C + 46.5}" y="${C + 3.6}"></text>
        </g>
        <g class="dv-hour"><path fill="url(#${id}m)" d="M${C - 2.6} ${C + 9}L${C - 2.6} ${C - 22}L${C} ${C - 30}L${C + 2.6} ${C - 22}L${C + 2.6} ${C + 9}Z"/><path class="dv-lume" d="M${C - 1.3} ${C - 8}L${C - 1.3} ${C - 22}L${C} ${C - 26.5}L${C + 1.3} ${C - 22}L${C + 1.3} ${C - 8}Z"/></g>
        <g class="dv-min"><path fill="url(#${id}m)" d="M${C - 2} ${C + 11}L${C - 2} ${C - 40}L${C} ${C - 52}L${C + 2} ${C - 40}L${C + 2} ${C + 11}Z"/><path class="dv-lume" d="M${C - 1} ${C - 10}L${C - 1} ${C - 40}L${C} ${C - 48}L${C + 1} ${C - 40}L${C + 1} ${C - 10}Z"/></g>
        <g class="dv-sec">
          <line x1="${C}" y1="${C + 16}" x2="${C}" y2="${C - 55}"/>
          <circle cx="${C}" cy="${C - 36}" r="3.2"/>
          <circle class="dv-lume" cx="${C}" cy="${C - 36}" r="1.9"/>
          <circle cx="${C}" cy="${C}" r="3"/>
        </g>
        <circle class="dv-cap" cx="${C}" cy="${C}" r="1.4"/>
      </svg>
      <div class="dv-cyclops"><span></span></div>
      <div class="dv-glass"></div>
    </div>`
  );
  const bezelEl = el.querySelector<HTMLElement>(".dv-bezel")!;
  const arc = el.querySelector<SVGPathElement>(".dv-arc")!;
  const hour = el.querySelector<SVGGElement>(".dv-hour")!;
  const min = el.querySelector<SVGGElement>(".dv-min")!;
  const sec = el.querySelector<SVGGElement>(".dv-sec")!;
  const date = el.querySelector<SVGTextElement>(".dv-date")!;
  const lens = el.querySelector<HTMLElement>(".dv-cyclops span")!;
  const left = el.querySelector<SVGTextElement>(".dv-left")!;
  let bezelTurn: number | null = null;

  return {
    id: "diver",
    name: "Diver",
    el,
    paint(s) {
      const now = new Date();
      const ms = now.getMilliseconds();
      const sNow = now.getSeconds() + ms / 1000;
      const mNow = now.getMinutes() + sNow / 60;
      const hNow = (now.getHours() % 12) + mNow / 60;
      hour.style.transform = `rotate(${(hNow * 30).toFixed(3)}deg)`;
      min.style.transform = `rotate(${(mNow * 6).toFixed(3)}deg)`;
      sec.style.transform = `rotate(${(sNow * 6).toFixed(3)}deg)`;

      // The bezel's zero on the minute the timer ends; turned the short way.
      const end = new Date(now.getTime() + s.leftMs);
      const endTurn = (end.getMinutes() + end.getSeconds() / 60) / 60;
      if (bezelTurn == null) bezelTurn = endTurn;
      else {
        let d = endTurn - (bezelTurn % 1);
        if (d > 0.5) d -= 1;
        if (d < -0.5) d += 1;
        bezelTurn += d;
      }
      bezelEl.style.transform = `rotate(${(bezelTurn * 360).toFixed(3)}deg)`;

      // Lume arc from now to the end, on the minute track (up to an hour).
      const spanTurn = Math.min(s.leftMs / 3600_000, 0.9999);
      if (spanTurn <= 0.0005) arc.setAttribute("d", "");
      else {
        const r = 59.5;
        const a0 = (mNow / 60) * Math.PI * 2;
        const a1 = a0 + spanTurn * Math.PI * 2;
        const x0 = C + r * Math.sin(a0);
        const y0 = C - r * Math.cos(a0);
        const x1 = C + r * Math.sin(a1);
        const y1 = C - r * Math.cos(a1);
        arc.setAttribute(
          "d",
          `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${spanTurn > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
        );
      }

      const mins = Math.ceil(s.leftMs / 60_000);
      const shown = s.leftMs < 60_000 ? String(Math.ceil(s.leftMs / 1000)) : String(Math.min(mins, 999));
      set(date, shown);
      set(lens, shown);
      el.classList.toggle("dv-seconds", s.leftMs < 60_000);
      set(left, `${formatClock(s.leftMs)} LEFT`);
    },
  };
}

function set(e: Element, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

// ---------------------------------------------------------------- carousel

const MAKERS: (() => Face)[] = [ring, minimal, diver, chrono, flip, dots, liquid];

export interface FaceCarousel {
  el: HTMLElement;
  paint(s: FaceState): void;
  step(dir: 1 | -1): void;
}

export function createFaceCarousel(): FaceCarousel {
  const faces = MAKERS.map((m) => m());
  const N = faces.length;
  const el = div("tf-carousel");
  const stage = div("tf-stage");
  const track = div("tf-rail");
  faces.forEach((f) => {
    f.el.style.flexBasis = `${100 / N}%`;
    track.appendChild(f.el);
  });
  track.style.width = `${N * 100}%`;
  stage.appendChild(track);
  const name = div("tf-name");
  const dotsEl = div("tf-pages", faces.map(() => "<i></i>").join(""));
  const pageDots = Array.from(dotsEl.children) as HTMLElement[];
  el.append(stage, name, dotsEl);

  let index = Math.max(0, faces.findIndex((f) => f.id === store.state.settings.timerFace));
  let drag: { x0: number; y0: number; id: number; on: boolean; samples: [number, number][] } | null = null;
  let dx = 0;
  let last: FaceState | null = null;
  let nameTimer = 0;

  function place(animate: boolean): void {
    track.style.transition = animate ? "transform 520ms cubic-bezier(0.32, 0.72, 0, 1)" : "none";
    track.style.transform = `translateX(calc(${(-index * 100) / N}% + ${dx.toFixed(1)}px))`;
    pageDots.forEach((d, i) => d.classList.toggle("on", i === index));
    faces.forEach((f, i) => f.el.classList.toggle("current", i === index));
  }

  function showName(i: number, hold = false): void {
    name.textContent = faces[i].name;
    name.classList.add("on");
    clearTimeout(nameTimer);
    if (!hold) nameTimer = window.setTimeout(() => name.classList.remove("on"), 1100);
  }

  function go(i: number): void {
    const next = Math.max(0, Math.min(N - 1, i));
    const changed = next !== index;
    index = next;
    dx = 0;
    place(true);
    showName(index);
    if (changed) {
      store.state.settings.timerFace = faces[index].id;
      store.save();
      if (last) paint(last);
    }
  }

  // Press, hold and drag: the track follows the pointer, and on release it
  // springs to the nearest face (or the next one, on a quick flick).
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x0: e.clientX, y0: e.clientY, id: e.pointerId, on: false, samples: [[performance.now(), e.clientX]] };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const mx = e.clientX - drag.x0;
    const my = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(mx) < 6 || Math.abs(mx) < Math.abs(my)) return;
      drag.on = true;
      stage.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    }
    const w = stage.clientWidth || 280;
    const atEdge = (index === 0 && mx > 0) || (index === N - 1 && mx < 0);
    dx = atEdge ? mx * 0.32 : mx;
    place(false);
    drag.samples.push([performance.now(), e.clientX]);
    if (drag.samples.length > 6) drag.samples.shift();
    const peek = index + (dx < -w * 0.25 ? 1 : dx > w * 0.25 ? -1 : 0);
    showName(Math.max(0, Math.min(N - 1, peek)), true);
    if (last) paintNear(last);
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.on) return;
    el.classList.remove("dragging");
    const w = stage.clientWidth || 280;
    const [t0, x0] = d.samples[0];
    const v = (e.clientX - x0) / Math.max(1, performance.now() - t0);
    let target = index;
    if (dx < -w * 0.22 || v < -0.45) target = index + 1;
    else if (dx > w * 0.22 || v > 0.45) target = index - 1;
    go(target);
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);

  // Sideways scrolling (trackpads, tilt wheels).
  let wheelAcc = 0;
  let wheelLock = 0;
  stage.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (performance.now() < wheelLock) return;
      wheelAcc += e.deltaX;
      if (Math.abs(wheelAcc) > 50) {
        go(index + (wheelAcc > 0 ? 1 : -1));
        wheelAcc = 0;
        wheelLock = performance.now() + 380;
      }
    },
    { passive: false }
  );

  function paintNear(s: FaceState): void {
    for (const i of [index - 1, index, index + 1]) if (i >= 0 && i < N) faces[i].paint(s);
  }

  function paint(s: FaceState): void {
    last = s;
    el.classList.toggle("final", s.final);
    el.classList.toggle("paused", s.paused);
    if (drag?.on) paintNear(s);
    else faces[index].paint(s);
  }

  place(false);
  return { el, paint, step: (dir) => go(index + dir) };
}
