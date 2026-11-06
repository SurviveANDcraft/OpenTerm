/** The Timer in the title bar.
 *
 *  Idle, it's a small round button. Counting down, it's a pill with a ring
 *  that empties as time runs out, the time left and the goal; through the last
 *  15 seconds the ring beats with the ticking. At zero the ring closes, pops,
 *  and becomes an alarm clock whose hammer strikes in time with the alarm,
 *  with ripples running out of the pill — until it's stopped, or the alarm
 *  gives up after 45 seconds and the pill settles to "Done".
 *
 *  Clicked, the pill grows into a panel (see islandMorph.ts): a big dial with
 *  pause, +1/+5 min, restart and cancel, the other timers, and a composer
 *  with a goal and one-click lengths. */
import "./timer.css";
import { createIsland } from "./islandMorph";
import { store } from "./store";
import {
  addTime,
  allTimers,
  cancelTimer,
  dismissDone,
  featuredTimer,
  formatClock,
  formatDuration,
  onTimerFired,
  onTimersChange,
  parseDuration,
  pauseTimer,
  progressOf,
  remainingOf,
  restartTimer,
  resumeTimer,
  startTimer,
  stopRinging,
  type Timer,
} from "./timers";
import timerSvg from "@phosphor-icons/core/fill/timer-fill.svg?raw";
import playSvg from "@phosphor-icons/core/fill/play-fill.svg?raw";
import pauseSvg from "@phosphor-icons/core/fill/pause-fill.svg?raw";
import restartSvg from "@phosphor-icons/core/bold/arrow-counter-clockwise-bold.svg?raw";
import trashSvg from "@phosphor-icons/core/bold/trash-simple-bold.svg?raw";
import plusSvg from "@phosphor-icons/core/bold/plus-bold.svg?raw";
import xSvg from "@phosphor-icons/core/bold/x-bold.svg?raw";

const svg = (raw: string, size: number): string =>
  raw.replace("<svg ", `<svg width="${size}" height="${size}" aria-hidden="true" focusable="false" `);

const reduceMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";
const POP = "cubic-bezier(0.34, 1.36, 0.5, 1)";

/** An alarm clock drawn in parts, so the hammer can swing between the bells
 *  and the hands can sweep home. */
function alarmClock(size: number): string {
  return `<svg class="am" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <g class="am-body">
      <path class="am-bell am-bell-l" d="M3.2 10.4a5.6 5.6 0 0 1 7.3-7.3z" fill="currentColor"/>
      <path class="am-bell am-bell-r" d="M28.8 10.4a5.6 5.6 0 0 0-7.3-7.3z" fill="currentColor"/>
      <g class="am-hammer"><path d="M16 7.2V3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="2.9" r="1.6" fill="currentColor"/></g>
      <path d="M9.4 26.6 7.2 29.4M22.6 26.6l2.2 2.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <circle cx="16" cy="17.4" r="10.2" fill="none" stroke="currentColor" stroke-width="2.3"/>
      <g class="am-hands" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path class="am-hour" d="M16 17.4V11.9"/>
        <path class="am-min" d="M16 17.4h4.4"/>
      </g>
      <circle cx="16" cy="17.4" r="1.4" fill="currentColor"/>
    </g>
  </svg>`;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function button(cls: string, html: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", cls, html);
  b.type = "button";
  b.tabIndex = -1;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!reduceMotion()) b.animate([{ transform: "scale(0.88)" }, { transform: "none" }], { duration: 300, easing: POP });
    onClick();
  });
  return b;
}

const SMALL_R = 7.4;
const SMALL_C = 2 * Math.PI * SMALL_R;
const BIG_R = 58;
const BIG_C = 2 * Math.PI * BIG_R;

const PRESETS: [string, number][] = [
  ["1m", 60_000],
  ["5m", 5 * 60_000],
  ["10m", 10 * 60_000],
  ["15m", 15 * 60_000],
  ["25m", 25 * 60_000],
  ["45m", 45 * 60_000],
  ["1h", 60 * 60_000],
];

export interface TimerWidget {
  el: HTMLElement;
  setEnabled(on: boolean): void;
  isOpen(): boolean;
  close(): void;
}

export function createTimerWidget(opts: { onShownChange(): void }): TimerWidget {
  let enabled = false;
  let open = false;
  let selectedId: string | null = null;
  let composing = false;
  let lastSecond = -1;

  // ---------------------------------------------------------------- pill
  const slot = h("div", "tm-slot");
  slot.hidden = true;
  const ripples = h("div", "tm-ripples", "<i></i><i></i><i></i>");
  const pill = h("div", "tm-pill");
  pill.setAttribute("role", "button");
  pill.tabIndex = -1;
  const dial = h("span", "tm-dial");
  dial.innerHTML = `<svg class="tm-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="tm-track" cx="10" cy="10" r="${SMALL_R}"/><circle class="tm-arc" cx="10" cy="10" r="${SMALL_R}"/></svg><span class="tm-icon">${svg(timerSvg, 14)}</span><span class="tm-alarm">${alarmClock(16)}</span>`;
  const arc = dial.querySelector<SVGCircleElement>(".tm-arc")!;
  const label = h("span", "tm-label");
  const timeEl = h("span", "tm-time");
  const goalEl = h("span", "tm-goal");
  label.append(timeEl, goalEl);
  const more = h("span", "tm-more");
  const stopBtn = button("tm-pill-btn tm-stop", "Stop", "Stop the alarm", () => stopRinging());
  const dismissBtn = button("tm-pill-btn tm-dismiss", svg(xSvg, 9), "Dismiss", () => dismissDone());
  pill.append(dial, label, more, stopBtn, dismissBtn);
  slot.append(ripples, pill);

  // ---------------------------------------------------------------- island
  const island = h("div", "tm-island np-island");
  island.hidden = true;
  island.setAttribute("role", "dialog");
  island.setAttribute("aria-label", "Timers");
  island.tabIndex = -1;
  const body = h("div", "tm-body");
  island.appendChild(body);
  document.body.appendChild(island);

  // Active view.
  const activeView = h("div", "tm-active");
  const bigDial = h("div", "tm-bigdial");
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const major = i % 5 === 0;
    const a = (i / 60) * Math.PI * 2;
    const r1 = major ? 65.5 : 66.5;
    const r2 = 69;
    const x1 = 70 + r1 * Math.sin(a);
    const y1 = 70 - r1 * Math.cos(a);
    const x2 = 70 + r2 * Math.sin(a);
    const y2 = 70 - r2 * Math.cos(a);
    return `<line class="${major ? "maj" : ""}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
  }).join("");
  bigDial.innerHTML = `<svg viewBox="0 0 140 140" aria-hidden="true">
      <defs><linearGradient id="tm-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color: color-mix(in srgb, var(--accent) 70%, white)"/>
        <stop offset="1" style="stop-color: var(--accent)"/>
      </linearGradient></defs>
      <g class="tm-ticks">${ticks}</g>
      <circle class="tm-bigtrack" cx="70" cy="70" r="${BIG_R}"/>
      <circle class="tm-bigarc" cx="70" cy="70" r="${BIG_R}" stroke="url(#tm-grad)"/>
      <g class="tm-tip"><circle cx="70" cy="${70 - BIG_R}" r="4.6"/></g>
    </svg>
    <div class="tm-bigcenter"><div class="tm-bigtime"></div><div class="tm-biggoal"></div></div>`;
  const bigArc = bigDial.querySelector<SVGCircleElement>(".tm-bigarc")!;
  const tip = bigDial.querySelector<SVGGElement>(".tm-tip")!;
  const bigTime = bigDial.querySelector<HTMLElement>(".tm-bigtime")!;
  const bigGoal = bigDial.querySelector<HTMLElement>(".tm-biggoal")!;

  const sel = (): Timer | null => allTimers().find((t) => t.id === selectedId) ?? featuredTimer();
  const withSel = (f: (t: Timer) => void) => () => {
    const t = sel();
    if (t) f(t);
  };
  const bMinus = button("tm-c tm-c-side", "+1 min", "Add a minute", withSel((t) => addTime(t, 60_000)));
  const bToggle = button("tm-c tm-c-main", "", "Pause", withSel((t) => (t.state === "running" ? pauseTimer(t) : resumeTimer(t))));
  const bPlus = button("tm-c tm-c-side", "+5 min", "Add five minutes", withSel((t) => addTime(t, 5 * 60_000)));
  const ctrls = h("div", "tm-ctrls");
  ctrls.append(bMinus, bToggle, bPlus);
  const subRow = h("div", "tm-subrow");
  subRow.append(
    button("tm-link", `${svg(restartSvg, 11)}Restart`, "Start this timer over", withSel(restartTimer)),
    button("tm-link tm-link-danger", `${svg(trashSvg, 11)}Cancel`, "Cancel this timer", withSel((t) => {
      cancelTimer(t);
      selectedId = null;
    }))
  );
  activeView.append(bigDial, ctrls, subRow);

  // Finished view.
  const doneView = h("div", "tm-doneview");
  const bigAlarm = h("div", "tm-bigalarm", `<div class="tm-bigripples"><i></i><i></i><i></i></div>${alarmClock(64)}`);
  const doneTitle = h("div", "tm-donetitle");
  const doneGoal = h("div", "tm-donegoal");
  const doneBtns = h("div", "tm-donebtns");
  const bStop = button("tm-c tm-c-main tm-c-wide", "Stop", "Stop the alarm", () => stopRinging());
  const bSnooze = button("tm-c tm-c-side", "+5 min", "Snooze for five minutes", withSel((t) => addTime(t, 5 * 60_000)));
  const bAgain = button("tm-c tm-c-side", `${svg(restartSvg, 12)}Again`, "Run it again", withSel(restartTimer));
  const bDismiss = button("tm-c tm-c-main tm-c-wide", "Dismiss", "Clear finished timers", () => {
    dismissDone();
    selectedId = null;
  });
  doneBtns.append(bSnooze, bStop, bDismiss, bAgain);
  doneView.append(bigAlarm, doneTitle, doneGoal, doneBtns);

  // Other timers.
  const listEl = h("div", "tm-list");

  // Composer.
  const newToggle = button("tm-newtoggle", `${svg(plusSvg, 11)}New timer`, "Set another timer", () => {
    composing = !composing;
    renderIsland();
    if (composing) requestAnimationFrame(() => goalInput.focus());
  });
  const composer = h("div", "tm-composer");
  const composerIn = h("div", "tm-composer-in");
  const goalInput = h("input", "tm-input tm-goalinput");
  goalInput.placeholder = "What's the goal?";
  goalInput.maxLength = 80;
  goalInput.spellcheck = false;
  const presets = h("div", "tm-presets");
  for (const [text, ms] of PRESETS) {
    presets.appendChild(button("tm-chip", text, `Start a ${formatDuration(ms)} timer`, () => begin(ms)));
  }
  const customRow = h("div", "tm-customrow");
  const durInput = h("input", "tm-input tm-durinput");
  durInput.placeholder = "Custom: 20m, 1h30, 90s";
  durInput.spellcheck = false;
  const startBtn = button("tm-start", `${svg(playSvg, 11)}Start`, "Start the timer", () => {
    const ms = parseDuration(durInput.value);
    if (ms == null) {
      durInput.focus();
      if (!reduceMotion())
        durInput.animate(
          [{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "none" }],
          { duration: 360, easing: "ease-out" }
        );
      durInput.classList.add("bad");
      return;
    }
    begin(ms);
  });
  durInput.addEventListener("input", () => {
    durInput.classList.remove("bad");
    const ms = parseDuration(durInput.value);
    startBtn.title = ms ? `Start a ${formatDuration(ms)} timer` : "Start the timer";
  });
  for (const input of [goalInput, durInput])
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (input === goalInput && !durInput.value.trim()) durInput.focus();
        else startBtn.click();
      }
    });
  customRow.append(durInput, startBtn);
  composerIn.append(goalInput, presets, customRow);
  composer.appendChild(composerIn);

  body.append(activeView, doneView, listEl, newToggle, composer);

  function begin(ms: number): void {
    const t = startTimer(ms, goalInput.value);
    selectedId = t.id;
    goalInput.value = "";
    durInput.value = "";
    composing = false;
    renderIsland();
    pop(dial);
  }

  function pop(e: Element): void {
    if (reduceMotion()) return;
    e.animate([{ transform: "scale(0.6)", opacity: 0.4 }, { transform: "scale(1.15)" }, { transform: "none", opacity: 1 }], {
      duration: 520,
      easing: POP,
    });
  }

  // ---------------------------------------------------------------- island control
  const isl = createIsland({
    pill,
    island,
    body,
    render: () => renderIsland(),
    onOpenChange(on) {
      open = on;
      if (!on) composing = false;
      kick();
    },
    canMorphClose: () => !slot.hidden,
    onFrame: () => paintLive(),
    focus: false,
  });

  island.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      isl.close();
    } else if (e.key === " " && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      const t = sel();
      if (t?.state === "running") pauseTimer(t);
      else if (t?.state === "paused") resumeTimer(t);
      else if (t?.state === "ringing") stopRinging();
    }
  });

  pill.addEventListener("click", () => {
    if (isl.isOpen()) {
      isl.close();
      return;
    }
    const nothing = !allTimers().length;
    composing = nothing;
    isl.open();
    island.focus({ preventScroll: true });
    if (nothing) requestAnimationFrame(() => goalInput.focus());
  });

  // ---------------------------------------------------------------- painting

  /** Changes the pill's content and lets its width follow smoothly. */
  function resizing(change: () => void): void {
    const w0 = pill.getBoundingClientRect().width;
    change();
    const w1 = pill.getBoundingClientRect().width;
    if (Math.abs(w1 - w0) > 1 && !reduceMotion() && !slot.hidden) {
      pill.animate([{ width: `${w0}px` }, { width: `${w1}px` }], { duration: 480, easing: SPRING });
    }
  }

  let pillSig = "";

  function renderPill(): void {
    const t = featuredTimer();
    const state = t ? t.state : "idle";
    const others = allTimers().length - 1;
    const goal = t?.goal ?? "";
    const sig = `${state}|${goal}|${others}|${t?.id ?? ""}`;
    if (sig !== pillSig) {
      pillSig = sig;
      resizing(() => {
        pill.dataset.state = state;
        slot.dataset.state = state;
        goalEl.textContent = goal;
        goalEl.hidden = !goal;
        more.textContent = others > 0 ? `+${others}` : "";
        more.hidden = others <= 0;
        more.title = others > 0 ? `${others} more timer${others === 1 ? "" : "s"}` : "";
        if (state === "ringing") timeEl.textContent = "Time's up";
        else if (state === "done") timeEl.textContent = "Done";
        else if (t) timeEl.textContent = formatClock(remainingOf(t));
        pill.title = !t
          ? "Timer"
          : state === "ringing"
            ? `Time's up${goal ? `: ${goal}` : ""}`
            : state === "done"
              ? `Finished${goal ? `: ${goal}` : ""}`
              : `${goal || "Timer"} — ${formatDuration(t.durationMs)}${state === "paused" ? " (paused)" : ""}`;
      });
    }
    slot.classList.toggle("no-anim", !store.state.settings.timerAnimation);
    paintLive();
  }

  /** The parts that move every frame or second. */
  function paintLive(): void {
    const t = featuredTimer();
    if (t && (t.state === "running" || t.state === "paused")) {
      const left = remainingOf(t);
      const p = progressOf(t);
      arc.style.strokeDasharray = `${(SMALL_C * (1 - p)).toFixed(2)} ${SMALL_C.toFixed(2)}`;
      const sec = Math.ceil(left / 1000);
      if (sec !== lastSecond) {
        lastSecond = sec;
        timeEl.textContent = formatClock(left);
        const final = t.state === "running" && sec <= 15 && sec > 0;
        pill.classList.toggle("final", final);
        if (final && store.state.settings.timerAnimation && !reduceMotion()) {
          dial.animate([{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }], {
            duration: 420,
            easing: "cubic-bezier(0.3, 0, 0.2, 1)",
          });
        }
      }
    } else {
      pill.classList.remove("final");
      lastSecond = -1;
    }
    if (open) paintBig();
  }

  function paintBig(): void {
    const t = sel();
    if (!t || t.state === "ringing" || t.state === "done") return;
    const left = remainingOf(t);
    const p = progressOf(t);
    bigArc.style.strokeDasharray = `${(BIG_C * (1 - p)).toFixed(2)} ${BIG_C.toFixed(2)}`;
    tip.style.transform = `rotate(${(360 * (1 - p)).toFixed(2)}deg)`;
    const text = formatClock(left);
    if (bigTime.textContent !== text) bigTime.textContent = text;
    bigDial.classList.toggle("final", t.state === "running" && left <= 15_000);
    bigDial.classList.toggle("paused", t.state === "paused");
  }

  let islandSig = "";

  function renderIsland(): void {
    const all = allTimers();
    const t = sel();
    if (t) selectedId = t.id;
    const finished = t && (t.state === "ringing" || t.state === "done");
    activeView.hidden = !t || !!finished;
    doneView.hidden = !finished;
    const showComposer = composing || !t;
    composer.classList.toggle("open", showComposer);
    newToggle.hidden = !t || composing;

    if (t && !finished) {
      bigGoal.textContent = t.goal || formatDuration(t.durationMs);
      bToggle.innerHTML = t.state === "running" ? svg(pauseSvg, 20) : svg(playSvg, 20);
      bToggle.title = t.state === "running" ? "Pause" : "Resume";
      bToggle.setAttribute("aria-label", bToggle.title);
      paintBig();
    }
    if (finished) {
      const ringing = t!.state === "ringing";
      doneView.classList.toggle("ringing", ringing);
      doneView.classList.toggle("no-anim", !store.state.settings.timerAnimation);
      doneTitle.textContent = ringing ? "Time's up" : "Done";
      doneGoal.textContent = t!.goal ? `${t!.goal} · ${formatDuration(t!.durationMs)}` : `${formatDuration(t!.durationMs)} timer`;
      bStop.hidden = !ringing;
      bDismiss.hidden = ringing;
    }

    const others = all.filter((x) => x !== t);
    const sig = others.map((x) => `${x.id}:${x.state}:${x.goal}`).join("|");
    if (sig !== islandSig) {
      islandSig = sig;
      listEl.replaceChildren(
        ...others.map((x) => {
          const row = h("button", `tm-row tm-row-${x.state}`);
          row.type = "button";
          row.tabIndex = -1;
          row.dataset.id = x.id;
          row.innerHTML = `<svg class="tm-rowring" viewBox="0 0 20 20" aria-hidden="true"><circle class="tm-track" cx="10" cy="10" r="${SMALL_R}"/><circle class="tm-arc" cx="10" cy="10" r="${SMALL_R}"/></svg><span class="tm-rowgoal"></span><span class="tm-rowtime"></span>`;
          row.querySelector(".tm-rowgoal")!.textContent = x.goal || formatDuration(x.durationMs);
          row.addEventListener("click", () => {
            selectedId = x.id;
            composing = false;
            renderIsland();
          });
          return row;
        })
      );
    }
    listEl.hidden = !others.length;
    paintRows();
  }

  function paintRows(): void {
    for (const row of Array.from(listEl.children) as HTMLElement[]) {
      const x = allTimers().find((t) => t.id === row.dataset.id);
      if (!x) continue;
      const p = progressOf(x);
      (row.querySelector(".tm-arc") as SVGCircleElement).style.strokeDasharray = `${(SMALL_C * (1 - p)).toFixed(2)} ${SMALL_C.toFixed(2)}`;
      const text = x.state === "ringing" ? "Time's up" : x.state === "done" ? "Done" : formatClock(remainingOf(x)) + (x.state === "paused" ? " ·  paused" : "");
      const timeCell = row.querySelector(".tm-rowtime")!;
      if (timeCell.textContent !== text) timeCell.textContent = text;
    }
  }

  // ---------------------------------------------------------------- live loop
  let raf = 0;
  let interval = 0;

  /** Smooth frames while the panel is open; four beats a second otherwise
   *  (enough for the pill, whose ring eases between them). */
  function kick(): void {
    const running = allTimers().some((t) => t.state === "running");
    cancelAnimationFrame(raf);
    raf = 0;
    clearInterval(interval);
    interval = 0;
    if (!enabled) return;
    if (open) {
      const frame = () => {
        paintLive();
        paintRows();
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    } else if (running) {
      interval = window.setInterval(paintLive, 250);
    }
    paintLive();
  }

  function render(): void {
    renderPill();
    if (open) renderIsland();
    kick();
  }

  onTimersChange(render);

  onTimerFired(() => {
    if (!enabled) return;
    selectedId = null;
    render();
    if (!store.state.settings.timerAnimation || reduceMotion()) return;
    // The ring closes and pops; the alarm clock springs out of it.
    dial.animate(
      [
        { transform: "scale(1)", filter: "none" },
        { transform: "scale(1.45)", filter: "brightness(1.6)" },
        { transform: "scale(0.9)" },
        { transform: "none", filter: "none" },
      ],
      { duration: 700, easing: POP }
    );
    pill.animate(
      [
        { boxShadow: "0 0 0 0 color-mix(in srgb, var(--accent) 70%, transparent)" },
        { boxShadow: "0 0 0 10px color-mix(in srgb, var(--accent) 0%, transparent)" },
      ],
      { duration: 900, easing: "ease-out" }
    );
  });

  return {
    el: slot,
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on && isl.isOpen()) isl.close();
      slot.hidden = !on;
      opts.onShownChange();
      if (on) {
        requestAnimationFrame(() => requestAnimationFrame(() => slot.classList.add("shown")));
        render();
      } else {
        slot.classList.remove("shown");
        kick();
      }
    },
    isOpen: () => isl.isOpen(),
    close: () => isl.close(),
  };
}
