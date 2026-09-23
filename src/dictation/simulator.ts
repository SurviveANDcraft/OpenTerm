// The live simulator at the top of Dictation > Setup: a miniature of the
// user's own screen (their wallpaper, a taskbar strip) running the real
// overlay renderers, scaled down. The pill can be dragged; it springs to the
// nearest of six anchors.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { DictationPosition } from "../types";
import { Anchor, GlowRenderer, PillRenderer } from "./overlay";

/** Virtual screen the renderers lay out in, before scaling to fit. */
const VW = 1024;
const VH = 576;
const TASKBAR = 30;
/** One demo cycle: listening, thinking, done, then a short rest. */
const CYCLE_MS = 5000;

const POSITIONS: DictationPosition[] = [
  "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right",
];

const POSITION_LABEL: Record<DictationPosition, string> = {
  "top-left": "Top left",
  "top-center": "Top center",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
};

export function anchorOf(p: DictationPosition): Anchor {
  const [v, h] = p.split("-") as [Anchor["v"], Anchor["h"]];
  return { v, h };
}

export interface SimulatorOptions {
  style(): "pill" | "glow";
  position(): DictationPosition;
  onPosition(p: DictationPosition): void;
  onShowOnScreen(): void;
}

export function createSimulator(opts: SimulatorOptions) {
  const el = document.createElement("div");
  el.className = "dict-sim";

  const screen = document.createElement("div");
  screen.className = "dict-sim-screen";
  const wall = document.createElement("img");
  wall.className = "dict-sim-wall";
  wall.alt = "";
  wall.draggable = false;
  wall.hidden = true;
  wall.addEventListener("load", () => (wall.hidden = false));
  wall.addEventListener("error", () => (wall.hidden = true));

  const scaler = document.createElement("div");
  scaler.className = "dict-sim-scale";
  const work = document.createElement("div");
  work.className = "dict-sim-work";
  const taskbar = document.createElement("div");
  taskbar.className = "dict-sim-taskbar";
  for (let i = 0; i < 4; i++) taskbar.appendChild(document.createElement("span"));
  scaler.append(work, taskbar);
  screen.append(wall, scaler);

  const anchorButtons = new Map<DictationPosition, HTMLButtonElement>();
  for (const pos of POSITIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dict-sim-anchor";
    b.setAttribute("aria-label", `Show the pill at ${POSITION_LABEL[pos].toLowerCase()}`);
    b.addEventListener("click", () => choose(pos));
    anchorButtons.set(pos, b);
    work.appendChild(b);
  }

  const pill = new PillRenderer(work, { embedded: true });
  const glow = new GlowRenderer(scaler, { embedded: true });

  const caption = document.createElement("div");
  caption.className = "dict-sim-caption";
  const hint = document.createElement("span");
  hint.className = "dict-sim-hint";
  const showBtn = document.createElement("button");
  showBtn.type = "button";
  showBtn.className = "btn-secondary";
  showBtn.textContent = "Show on screen";
  showBtn.addEventListener("click", () => opts.onShowOnScreen());
  caption.append(hint, showBtn);
  el.append(screen, caption);

  let scale = 1;
  let running = false;
  let cycleTimer: number | undefined;
  let cycleStart = 0;
  let seq = 0;
  let style = opts.style();

  const ro = new ResizeObserver(() => {
    scale = screen.clientWidth / VW;
    scaler.style.transform = `scale(${scale})`;
  });
  ro.observe(screen);

  function placeAnchors(): void {
    const current = opts.position();
    for (const [pos, b] of anchorButtons) {
      const p = pill.anchorPoint(anchorOf(pos), 168);
      b.style.transform = `translate(${p.x - 84}px, ${p.y - 22}px)`;
      b.classList.toggle("chosen", pos === current);
      b.setAttribute("aria-pressed", String(pos === current));
    }
  }

  function choose(pos: DictationPosition): void {
    opts.onPosition(pos);
    pill.setAnchor(anchorOf(pos), true);
    placeAnchors();
  }

  function startCycle(): void {
    window.clearTimeout(cycleTimer);
    cycleStart = performance.now();
    seq++;
    if (style === "glow") {
      pill.hideNow();
      glow.demo({ seq, listen: 2.2, think: 1.2, loop: true });
    } else {
      glow.hideNow();
      pill.demo({ seq, anchor: anchorOf(opts.position()), listen: 2.2, think: 1.1, loop: true });
    }
  }

  const onFinished = () => {
    if (!running) return;
    cycleTimer = window.setTimeout(startCycle, Math.max(0, CYCLE_MS - (performance.now() - cycleStart)));
  };
  pill.onFinished = onFinished;
  glow.onFinished = onFinished;

  // Hover pauses the loop. An empty screen restarts it first, so there's
  // always something to look at (and drag).
  screen.addEventListener("pointerenter", () => {
    if (!running) return;
    if (!(style === "glow" ? glow.visible : pill.visible)) startCycle();
    pill.paused = glow.paused = true;
  });
  screen.addEventListener("pointerleave", () => {
    pill.paused = glow.paused = false;
  });

  // Dragging the pill.
  let dragging = false;
  const toVirtual = (e: PointerEvent) => {
    const r = work.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  screen.addEventListener("pointerdown", (e) => {
    if (style !== "pill" || !pill.visible || e.button !== 0) return;
    const p = toVirtual(e);
    const c = pill.center;
    if (Math.abs(p.x - c.x) > c.w / 2 + 10 || Math.abs(p.y - c.y) > 32) return;
    dragging = true;
    screen.setPointerCapture(e.pointerId);
    screen.classList.add("dragging");
    pill.dragTo(p.x, p.y);
    e.preventDefault();
  });
  screen.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const p = toVirtual(e);
    pill.dragTo(Math.min(VW, Math.max(0, p.x)), Math.min(VH - TASKBAR, Math.max(0, p.y)));
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    screen.classList.remove("dragging");
    const p = toVirtual(e);
    let best = opts.position();
    let bestD = Infinity;
    for (const pos of POSITIONS) {
      const a = pill.anchorPoint(anchorOf(pos));
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = pos;
      }
    }
    pill.endDrag();
    choose(best);
  };
  screen.addEventListener("pointerup", endDrag);
  screen.addEventListener("pointercancel", endDrag);

  let wallpaperLoaded = false;
  function loadWallpaper(): void {
    if (wallpaperLoaded) return;
    wallpaperLoaded = true;
    void invoke<string | null>("dictation_wallpaper")
      .then((path) => {
        if (path) wall.src = convertFileSrc(path);
      })
      .catch(() => {});
  }

  return {
    el,
    /** Re-sync with the draft (style or position changed elsewhere). */
    sync(): void {
      const nextStyle = opts.style();
      el.classList.toggle("glow", nextStyle === "glow");
      hint.textContent =
        nextStyle === "pill" ? "Drag the pill to where you want it." : "The edges of your screen light up as you speak.";
      placeAnchors();
      if (nextStyle !== style) {
        style = nextStyle;
        if (running) startCycle();
      }
    },
    setRunning(on: boolean): void {
      if (on === running) return;
      running = on;
      if (on) {
        loadWallpaper();
        pill.refreshTheme();
        placeAnchors();
        startCycle();
      } else {
        window.clearTimeout(cycleTimer);
        pill.hideNow();
        glow.hideNow();
      }
    },
  };
}
