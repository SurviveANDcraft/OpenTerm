/** Now playing in the title bar.
 *
 *  Compact, it's a pill: cover, title and artist, and level bars that move
 *  with the app's real output. Hovering slides the transport controls out of
 *  it, and scrolling over it changes the volume. Clicked, the pill grows into
 *  the "island" below it — cover, timeline, transport, volume and the other
 *  sources — and shrinks back into it on close. Data and commands come from
 *  media.ts; the whole thing tints itself from the cover art. */
import "./nowPlaying.css";
import { createIsland } from "./islandMorph";
import { invoke } from "@tauri-apps/api/core";
import {
  activeSource,
  formatTime,
  mediaControl,
  mediaSources,
  onMediaChange,
  onMediaLevel,
  pinSource,
  positionOf,
  setMeter,
  volumeOf,
  type MediaSource,
} from "./media";
import playSvg from "@phosphor-icons/core/fill/play-fill.svg?raw";
import pauseSvg from "@phosphor-icons/core/fill/pause-fill.svg?raw";
import nextSvg from "@phosphor-icons/core/fill/skip-forward-fill.svg?raw";
import prevSvg from "@phosphor-icons/core/fill/skip-back-fill.svg?raw";
import shuffleSvg from "@phosphor-icons/core/bold/shuffle-bold.svg?raw";
import repeatSvg from "@phosphor-icons/core/bold/repeat-bold.svg?raw";
import repeatOnceSvg from "@phosphor-icons/core/bold/repeat-once-bold.svg?raw";
import volHighSvg from "@phosphor-icons/core/fill/speaker-simple-high-fill.svg?raw";
import volLowSvg from "@phosphor-icons/core/fill/speaker-simple-low-fill.svg?raw";
import volNoneSvg from "@phosphor-icons/core/fill/speaker-simple-none-fill.svg?raw";
import volMuteSvg from "@phosphor-icons/core/fill/speaker-simple-slash-fill.svg?raw";
import spotifySvg from "@phosphor-icons/core/fill/spotify-logo-fill.svg?raw";
import chromeSvg from "@phosphor-icons/core/fill/google-chrome-logo-fill.svg?raw";
import globeSvg from "@phosphor-icons/core/fill/globe-simple-fill.svg?raw";
import notesSvg from "@phosphor-icons/core/fill/music-notes-simple-fill.svg?raw";

const svg = (raw: string, size: number): string =>
  raw.replace("<svg ", `<svg width="${size}" height="${size}" aria-hidden="true" focusable="false" `);

function sourceIcon(s: MediaSource, size: number): string {
  if (s.kind === "spotify") return svg(spotifySvg, size);
  if (s.kind === "chrome") return svg(chromeSvg, size);
  if (s.kind === "other") return svg(notesSvg, size);
  return svg(globeSvg, size);
}

function volumeIcon(v: number, muted: boolean, size: number): string {
  if (muted || v <= 0.001) return svg(muted ? volMuteSvg : volNoneSvg, size);
  return svg(v < 0.5 ? volLowSvg : volHighSvg, size);
}

const reduceMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Apple's "smooth spring": a fast start that settles without wobbling. */
const SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";
const SPRING_POP = "cubic-bezier(0.34, 1.36, 0.5, 1)";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function iconButton(cls: string, label: string): HTMLButtonElement {
  const b = h("button", cls);
  b.type = "button";
  b.tabIndex = -1;
  b.setAttribute("aria-label", label);
  b.title = label;
  return b;
}

const trackKey = (s: MediaSource | null): string => (s ? `${s.id}\u0001${s.title}\u0001${s.artist}` : "");

// ------------------------------------------------------------------ tint

/** The cover's most vivid colour, nudged into a range that reads as a glow on
 *  any theme. Cached per cover. */
const tintCache = new Map<string, string>();

function coverTint(art: string): Promise<string | null> {
  const hit = tintCache.get(art);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const n = 16;
        const c = document.createElement("canvas");
        c.width = c.height = n;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, n, n);
        const px = ctx.getImageData(0, 0, n, n).data;
        let best = { score: -1, h: 0, s: 0, l: 0 };
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
          sumR += r; sumG += g; sumB += b;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const l = (max + min) / 2;
          const d = max - min;
          const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
          let hue = 0;
          if (d) {
            if (max === r) hue = ((g - b) / d) % 6;
            else if (max === g) hue = (b - r) / d + 2;
            else hue = (r - g) / d + 4;
            hue *= 60;
            if (hue < 0) hue += 360;
          }
          const score = s * (1 - Math.abs(l - 0.52) * 1.6);
          if (score > best.score) best = { score, h: hue, s, l };
        }
        let tint: string;
        if (best.score < 0.12) {
          // A grey cover: keep it neutral rather than inventing a hue.
          const n2 = px.length / 4;
          const avg = (sumR + sumG + sumB) / (3 * n2);
          const l = Math.round(58 + (avg - 0.5) * 10);
          tint = `hsl(0 0% ${l}%)`;
        } else {
          const s = Math.round(Math.max(0.5, Math.min(best.s, 0.85)) * 100);
          const l = Math.round(Math.max(0.56, Math.min(best.l, 0.68)) * 100);
          tint = `hsl(${Math.round(best.h)} ${s}% ${l}%)`;
        }
        tintCache.set(art, tint);
        resolve(tint);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = art;
  });
}

// ------------------------------------------------------------------ slider

interface Slider {
  el: HTMLElement;
  set(ratio: number): void;
  dragging(): boolean;
}

/** A capsule slider: a hairline at rest that thickens under the pointer,
 *  dragged with pointer capture so it keeps tracking outside its bounds. */
function slider(cls: string, label: string, onInput: (r: number) => void, onCommit: (r: number) => void): Slider {
  const el = h("div", `np-slider ${cls}`);
  el.setAttribute("role", "slider");
  el.setAttribute("aria-label", label);
  el.tabIndex = 0;
  const track = h("div", "np-slider-track");
  const fill = h("div", "np-slider-fill");
  track.appendChild(fill);
  const knob = h("div", "np-slider-knob");
  el.append(track, knob);
  let drag = false;
  let ratio = 0;
  const paint = (r: number) => {
    ratio = Math.min(1, Math.max(0, r));
    fill.style.transform = `scaleX(${ratio})`;
    el.style.setProperty("--r", String(ratio));
    el.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  };
  const at = (e: PointerEvent) => {
    const r = track.getBoundingClientRect();
    return (e.clientX - r.left) / r.width;
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = true;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
    paint(at(e));
    onInput(ratio);
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    paint(at(e));
    onInput(ratio);
  });
  const end = () => {
    if (!drag) return;
    drag = false;
    el.classList.remove("dragging");
    onCommit(ratio);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.05;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") paint(ratio + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") paint(ratio - step);
    else return;
    e.preventDefault();
    e.stopPropagation();
    onInput(ratio);
    onCommit(ratio);
  });
  return { el, set: (r) => !drag && paint(r), dragging: () => drag };
}

// ------------------------------------------------------------------ widget

export interface NowPlaying {
  /** The title-bar slot; it opens and closes its own width. */
  el: HTMLElement;
  setEnabled(on: boolean): void;
  setOnlyWhilePlaying(on: boolean): void;
  /** Whether the pill is showing right now. */
  shown(): boolean;
  isOpen(): boolean;
  close(): void;
}

export function createNowPlaying(opts: { onShownChange(): void }): NowPlaying {
  let enabled = false;
  let onlyWhilePlaying = false;
  let isShown = false;
  let open = false;
  let src: MediaSource | null = null;
  let shownKey = "";
  let shownArt: string | null | undefined = undefined;

  // ---------------------------------------------------------------- pill
  const slot = h("div", "np-slot");
  slot.hidden = true;
  const pill = h("div", "np-pill");
  pill.setAttribute("role", "button");
  pill.setAttribute("aria-haspopup", "dialog");
  pill.setAttribute("aria-label", "Now playing");
  pill.tabIndex = -1;
  const art = h("span", "np-art");
  const artPh = h("span", "np-art-ph", svg(notesSvg, 10));
  art.appendChild(artPh);
  const text = h("span", "np-text");
  const quick = h("span", "np-quick");
  const quickIn = h("span", "np-quick-in");
  const qPrev = iconButton("np-q", "Previous");
  qPrev.innerHTML = svg(prevSvg, 11);
  const qPlay = iconButton("np-q np-q-play", "Play");
  const qNext = iconButton("np-q", "Next");
  qNext.innerHTML = svg(nextSvg, 11);
  quickIn.append(qPrev, qPlay, qNext);
  quick.appendChild(quickIn);
  const eq = h("span", "np-eq");
  const bars = [0, 1, 2, 3].map(() => eq.appendChild(h("i", "")));
  // The volume readout shares the text's cell, so it swaps in in place.
  const peek = h("span", "np-peek");
  const peekIcon = h("span", "np-peek-icon");
  const peekBar = h("span", "np-peek-bar", `<span class="np-peek-fill"></span>`);
  peek.append(peekIcon, peekBar);
  const prog = h("span", "np-prog");
  text.appendChild(peek);
  pill.append(art, text, quick, eq, prog);
  slot.appendChild(pill);

  // ---------------------------------------------------------------- island
  const island = h("div", "np-island");
  island.hidden = true;
  island.setAttribute("role", "dialog");
  island.setAttribute("aria-label", "Now playing");
  island.tabIndex = -1;
  const ambient = h("div", "np-ambient");
  const body = h("div", "np-body");
  const head = h("div", "np-head");
  const cover = h("div", "np-cover", `<span class="np-cover-ph">${svg(notesSvg, 22)}</span>`);
  const meta = h("div", "np-meta");
  const titleWrap = h("div", "np-title");
  const titleText = h("span", "np-title-text");
  titleWrap.appendChild(titleText);
  // The title (and the cover) take you to where the sound is coming from.
  titleWrap.setAttribute("role", "link");
  titleWrap.tabIndex = -1;
  cover.setAttribute("role", "link");
  const artistEl = h("div", "np-artist");
  const badge = h("div", "np-badge");
  meta.append(titleWrap, artistEl, badge);
  head.append(cover, meta);

  const timeline = h("div", "np-timeline");
  const tCur = h("span", "np-time");
  const tLeft = h("span", "np-time np-time-left");
  let scrubRatio: number | null = null;
  const scrub = slider(
    "np-scrub",
    "Position",
    (r) => {
      scrubRatio = r;
      paintTimeline();
    },
    (r) => {
      if (src && src.durationMs > 0) mediaControl(src, "seek", r * src.durationMs);
      scrubRatio = null;
    }
  );
  const times = h("div", "np-times");
  times.append(tCur, tLeft);
  timeline.append(scrub.el, times);

  const transport = h("div", "np-transport");
  const bShuffle = iconButton("np-t np-t-side", "Shuffle");
  bShuffle.innerHTML = svg(shuffleSvg, 15);
  const bPrev = iconButton("np-t", "Previous");
  bPrev.innerHTML = svg(prevSvg, 22);
  const bPlay = iconButton("np-t np-t-play", "Play");
  const bNext = iconButton("np-t", "Next");
  bNext.innerHTML = svg(nextSvg, 22);
  const bRepeat = iconButton("np-t np-t-side", "Repeat");
  transport.append(bShuffle, bPrev, bPlay, bNext, bRepeat);

  const volRow = h("div", "np-volume");
  const bMute = iconButton("np-v-icon", "Mute");
  let lastVolSend = 0;
  const vol = slider(
    "np-vol",
    "Volume",
    (r) => {
      if (!src) return;
      const now = performance.now();
      if (now - lastVolSend > 40) {
        lastVolSend = now;
        mediaControl(src, "volume", r);
      }
      paintVolumeIcon(r, false);
    },
    (r) => src && mediaControl(src, "volume", r)
  );
  const volScope = h("span", "np-v-scope");
  volRow.append(bMute, vol.el, volScope);

  const sourcesRow = h("div", "np-sources");
  body.append(head, timeline, transport, volRow, sourcesRow);
  island.append(ambient, body);
  document.body.appendChild(island);

  // ---------------------------------------------------------------- paint

  function swapArt(target: HTMLElement, url: string | null, animate: boolean): void {
    const old = target.querySelector<HTMLImageElement>("img");
    if (!url) {
      if (old) fadeOut(old);
      target.classList.remove("has-art");
      return;
    }
    if (old?.src === url) return;
    const img = new Image();
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    img.src = url;
    target.appendChild(img);
    target.classList.add("has-art");
    if (animate && !reduceMotion()) {
      img.animate(
        [
          { opacity: 0, transform: "scale(1.12)", filter: "blur(6px)" },
          { opacity: 1, transform: "none", filter: "none" },
        ],
        { duration: 520, easing: SPRING }
      );
    }
    if (old) fadeOut(old);
  }

  function fadeOut(e: HTMLElement): void {
    if (reduceMotion()) {
      e.remove();
      return;
    }
    const a = e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: "ease", fill: "forwards" });
    a.onfinish = () => e.remove();
  }

  /** Slides the old line up and out while the new one rises in. */
  function swapText(s: MediaSource, animate: boolean): void {
    const line = h("span", "np-line");
    const t = h("span", "np-l-title");
    t.textContent = s.title || s.artist;
    line.appendChild(t);
    if (s.title && s.artist) {
      const a = h("span", "np-l-artist");
      a.textContent = s.artist;
      line.appendChild(a);
    }
    const olds = Array.from(text.querySelectorAll<HTMLElement>(":scope > .np-line"));
    text.appendChild(line);
    pill.title = [s.title, s.artist].filter(Boolean).join(" — ");
    if (!animate || reduceMotion()) {
      olds.forEach((o) => o.remove());
      return;
    }
    line.animate(
      [
        { opacity: 0, transform: "translateY(9px)", filter: "blur(3px)" },
        { opacity: 1, transform: "none", filter: "none" },
      ],
      { duration: 460, easing: SPRING, delay: 70, fill: "backwards" }
    );
    for (const o of olds) {
      o.classList.add("leaving");
      const a = o.animate(
        [
          { opacity: 1, transform: "none", filter: "none" },
          { opacity: 0, transform: "translateY(-9px)", filter: "blur(3px)" },
        ],
        { duration: 280, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }
      );
      a.onfinish = () => o.remove();
    }
  }

  function setPlayIcon(btn: HTMLButtonElement, playing: boolean, size: number): void {
    const want = playing ? "pause" : "play";
    if (btn.dataset.icon === want) return;
    const first = !btn.dataset.icon;
    btn.dataset.icon = want;
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    btn.title = playing ? "Pause" : "Play";
    btn.innerHTML = `<span class="np-glyph">${svg(playing ? pauseSvg : playSvg, size)}</span>`;
    if (!first && !reduceMotion()) {
      btn.firstElementChild!.animate(
        [
          { opacity: 0, transform: "scale(0.55) rotate(-30deg)", filter: "blur(2px)" },
          { opacity: 1, transform: "none", filter: "none" },
        ],
        { duration: 380, easing: SPRING_POP }
      );
    }
  }

  function applyTint(t: string | null): void {
    for (const e of [pill, island]) {
      if (t) e.style.setProperty("--np-tint", t);
      else e.style.removeProperty("--np-tint");
    }
  }

  function paintVolumeIcon(v: number, muted: boolean): void {
    bMute.innerHTML = volumeIcon(v, muted, 15);
    bMute.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    bMute.title = muted ? "Unmute" : "Mute";
  }

  function paintTimeline(): void {
    if (!src) return;
    const d = src.durationMs;
    const p = scrubRatio != null ? scrubRatio * d : positionOf(src);
    if (scrubRatio == null) scrub.set(d > 0 ? p / d : 0);
    tCur.textContent = formatTime(p);
    tLeft.textContent = `−${formatTime(d - p)}`;
  }

  function wantShown(): boolean {
    if (!enabled || !src) return false;
    if (onlyWhilePlaying && src.status !== "playing" && !open) return false;
    return true;
  }

  let hideAnim: Animation | null = null;

  function setShown(on: boolean): void {
    if (on === isShown) return;
    isShown = on;
    hideAnim?.cancel();
    hideAnim = null;
    if (on) {
      slot.hidden = false;
      opts.onShownChange();
      // Next frame, so the 0fr → 1fr width transition has a start to run from.
      requestAnimationFrame(() => requestAnimationFrame(() => slot.classList.add("shown")));
    } else {
      if (open) close();
      slot.classList.remove("shown");
      const done = () => {
        if (isShown) return;
        slot.hidden = true;
        opts.onShownChange();
      };
      if (reduceMotion()) done();
      else setTimeout(done, 420);
    }
    syncMeter();
    loop();
  }

  function syncMeter(): void {
    setMeter(isShown && src?.status === "playing" ? src.id : null);
  }

  // Between two tracks the app briefly reports nothing (no title, or no
  // session at all). Hold on to the last track through that gap and show it
  // as loading, rather than letting the pill and the island vanish.
  const HOLD_MS = 3500;
  let holdTimer = 0;
  let holding = false;
  /** Set by next/prev until a different track arrives. */
  let skipFrom: string | null = null;
  let skipTimer = 0;
  let loading = false;

  function startSkip(): void {
    skipFrom = shownKey;
    clearTimeout(skipTimer);
    skipTimer = window.setTimeout(() => {
      skipFrom = null;
      render();
    }, HOLD_MS);
    render();
  }

  function render(): void {
    const next = enabled ? activeSource() : null;
    if (next) {
      src = next;
      holding = false;
      clearTimeout(holdTimer);
    } else if (enabled && src && isShown) {
      if (!holding) {
        holding = true;
        holdTimer = window.setTimeout(() => {
          holding = false;
          src = null;
          render();
        }, HOLD_MS);
      }
    } else src = null;
    setShown(wantShown());
    if (!src) return;
    const s = src;
    const playing = s.status === "playing";

    const key = trackKey(s);
    if (skipFrom !== null && key !== skipFrom && s.title) {
      skipFrom = null;
      clearTimeout(skipTimer);
    }
    const isLoading = holding || skipFrom !== null || s.status === "changing" || !s.title;
    if (isLoading !== loading) {
      loading = isLoading;
      pill.classList.toggle("loading", loading);
      island.classList.toggle("loading", loading);
    }
    if (key !== shownKey && !holding && s.title) {
      swapText(s, shownKey !== "" && isShown);
      shownKey = key;
    }
    if (s.art !== shownArt && s.title) {
      const animate = shownArt !== undefined;
      shownArt = s.art;
      swapArt(art, s.art, animate);
      swapArt(cover, s.art, animate && open);
      swapArt(ambient, s.art, animate && open);
      if (s.art) {
        const wanted = s.art;
        void coverTint(wanted).then((t) => {
          if (src?.art === wanted) applyTint(t);
        });
      } else applyTint(null);
    }

    pill.classList.toggle("playing", playing);
    island.classList.toggle("playing", playing);
    setPlayIcon(qPlay, playing, 11);
    setPlayIcon(bPlay, playing, 26);
    qPlay.disabled = bPlay.disabled = !s.canPlayPause;
    qPrev.disabled = bPrev.disabled = !s.canPrev;
    qNext.disabled = bNext.disabled = !s.canNext;
    syncMeter();

    if (open && s.title) renderIsland(s);
    loop();
  }

  function renderIsland(s: MediaSource): void {
    if (titleText.textContent !== (s.title || "Unknown title")) {
      titleText.textContent = s.title || "Unknown title";
      requestAnimationFrame(fitTitle);
    }
    artistEl.textContent = [s.artist, s.album].filter(Boolean).join(" — ");
    badge.innerHTML = `${sourceIcon(s, 11)}<span>${escapeHtml(s.app)}</span>`;
    badge.title = `Playing in ${s.app}`;
    const where = s.kind === "spotify" || s.kind === "other" ? `Open ${s.app}` : `Go to the ${s.app} tab`;
    titleWrap.title = where;
    cover.title = where;

    const hasTimeline = s.durationMs > 0;
    timeline.classList.toggle("live", !hasTimeline);
    scrub.el.classList.toggle("disabled", !s.canSeek);
    paintTimeline();

    bShuffle.hidden = !s.canShuffle && s.shuffle == null;
    bRepeat.hidden = !s.canRepeat && s.repeat == null;
    bShuffle.classList.toggle("on", !!s.shuffle);
    bShuffle.disabled = !s.canShuffle;
    const rep = s.repeat ?? "none";
    bRepeat.classList.toggle("on", rep !== "none");
    bRepeat.disabled = !s.canRepeat;
    bRepeat.innerHTML = svg(rep === "track" ? repeatOnceSvg : repeatSvg, 15);
    bRepeat.title = rep === "track" ? "Repeat one" : rep === "list" ? "Repeat all" : "Repeat";
    transport.classList.toggle("sides", !bShuffle.hidden || !bRepeat.hidden);

    const v = volumeOf(s);
    volRow.hidden = !v;
    if (v) {
      if (!vol.dragging()) {
        vol.set(v.muted ? 0 : v.value);
        paintVolumeIcon(v.value, v.muted);
      }
      volScope.textContent = v.scope === "app" ? s.app : "System";
      volScope.title =
        v.scope === "app"
          ? `${s.app}'s own volume${s.kind === "chrome" || s.kind === "edge" || s.kind === "browser" || s.kind === "firefox" ? " — every tab in it" : ""}`
          : "System volume";
    }

    const all = mediaSources();
    sourcesRow.hidden = all.length < 2;
    if (all.length > 1) {
      const sig = all.map((x) => `${x.id}\u0001${x.title}\u0001${x.status}\u0001${x.id === s.id}`).join("\u0002");
      if (sourcesRow.dataset.sig !== sig) {
        sourcesRow.dataset.sig = sig;
        sourcesRow.replaceChildren(
          ...all.map((x) => {
            const chip = h("button", "np-chip");
            chip.type = "button";
            chip.tabIndex = -1;
            chip.classList.toggle("active", x.id === s.id);
            chip.classList.toggle("playing", x.status === "playing");
            chip.innerHTML = `${sourceIcon(x, 12)}<span class="np-chip-text"><b>${escapeHtml(x.app)}</b><span>${escapeHtml(x.title)}</span></span><i class="np-chip-dot"></i>`;
            chip.title = `${x.title}${x.artist ? ` — ${x.artist}` : ""} (${x.app})`;
            chip.addEventListener("click", () => pinSource(x.id));
            return chip;
          })
        );
      }
    }
  }

  /** Long titles drift sideways instead of being cut off, like Music does. */
  function fitTitle(): void {
    const over = titleText.scrollWidth - titleWrap.clientWidth;
    titleWrap.classList.toggle("marquee", over > 4);
    if (over > 4) {
      titleWrap.style.setProperty("--np-shift", `${-over - 24}px`);
      titleWrap.style.setProperty("--np-dur", `${Math.max(6, (over + 24) / 22)}s`);
    }
  }

  // ---------------------------------------------------------------- live loop
  let raf = 0;
  let level = 0;
  let levelTarget = 0;
  let levelAt = 0;
  let realLevel = false;
  const phases = [0.3, 1.9, 3.7, 5.1];
  const speeds = [7.3, 9.1, 6.2, 8.4];
  const gains = [0.85, 1.0, 0.78, 0.66];

  onMediaLevel((id, l) => {
    if (id !== src?.id) return;
    realLevel = l >= 0;
    levelTarget = l < 0 ? 0 : Math.min(1, Math.sqrt(l) * 1.15);
    levelAt = performance.now();
  });

  const live = (): boolean => (isShown && (src?.status === "playing" || loading)) || open || isl.morphing();

  function loop(): void {
    const active = live();
    if (!active) {
      cancelAnimationFrame(raf);
      raf = 0;
      paintBars(performance.now(), true);
      if (src) paintProg();
      return;
    }
    if (raf) return;
    const tick = (t: number) => {
      raf = 0;
      paintBars(t, false);
      paintProg();
      if (open) paintTimeline();
      if (live()) raf = requestAnimationFrame(tick);
      else paintBars(t, true);
    };
    raf = requestAnimationFrame(tick);
  }

  function paintBars(t: number, rest: boolean): void {
    if (loading && !rest) {
      // Waiting for the next track: a soft wave travelling across the bars.
      level += (0 - level) * 0.12;
      bars.forEach((b, i) => {
        const v = 0.5 + 0.5 * Math.sin(t / 140 - i * 0.9);
        b.style.transform = `scaleY(${(0.22 + v * 0.42).toFixed(3)})`;
      });
      return;
    }
    const playing = !rest && src?.status === "playing";
    let target = 0;
    if (playing) {
      const fresh = realLevel && t - levelAt < 600;
      target = fresh ? levelTarget : 0.55 + 0.2 * Math.sin(t / 700);
    }
    level += (target - level) * (target > level ? 0.45 : 0.12);
    const s = t / 1000;
    bars.forEach((b, i) => {
      const wave = 0.55 + 0.45 * Math.sin(s * speeds[i] + phases[i]) * Math.sin(s * speeds[(i + 2) % 4] * 0.37 + phases[i]);
      const v = playing ? Math.min(1, level * gains[i] * (0.45 + wave * 0.75)) : 0;
      b.style.transform = `scaleY(${(0.22 + v * 0.78).toFixed(3)})`;
    });
  }

  function paintProg(): void {
    if (!src || src.durationMs <= 0) {
      prog.style.transform = "scaleX(0)";
      return;
    }
    prog.style.transform = `scaleX(${(positionOf(src) / src.durationMs).toFixed(4)})`;
  }

  // ---------------------------------------------------------------- island open/close
  const isl = createIsland({
    pill,
    island,
    body,
    render(fresh) {
      if (!src) return;
      renderIsland(src);
      if (fresh) {
        swapArt(cover, src.art, false);
        swapArt(ambient, src.art, false);
      }
      requestAnimationFrame(fitTitle);
    },
    onOpenChange(on) {
      open = on;
      loop();
    },
    onClosed: () => render(),
    canMorphClose: () => isShown,
    onFrame: loop,
  });

  function openIsland(): void {
    if (src) isl.open();
  }

  function close(): void {
    isl.close();
  }

  // ---------------------------------------------------------------- input
  function goToSource(): void {
    if (!src) return;
    void invoke("media_focus_source", { id: src.id, title: src.title }).catch(() => {});
    close();
  }
  titleWrap.addEventListener("click", goToSource);
  cover.addEventListener("click", goToSource);

  const act = (a: "toggle" | "next" | "prev") => src && mediaControl(src, a);
  const press = (b: HTMLElement) => {
    if (reduceMotion()) return;
    b.animate([{ transform: "scale(0.84)" }, { transform: "none" }], { duration: 320, easing: SPRING_POP });
  };

  pill.addEventListener("click", (e) => {
    const q = (e.target as HTMLElement).closest<HTMLButtonElement>(".np-q");
    if (q) {
      e.stopPropagation();
      press(q);
      act(q === qPlay ? "toggle" : q === qNext ? "next" : "prev");
      if (q !== qPlay) startSkip();
      return;
    }
    if (open) close();
    else openIsland();
  });

  // Scrolling over the pill rides the volume, with a brief level readout.
  let peekTimer = 0;
  pill.addEventListener(
    "wheel",
    (e) => {
      if (!src) return;
      const v = volumeOf(src);
      if (!v) return;
      e.preventDefault();
      const step = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.1 : 0.04);
      const base = v.muted ? 0 : v.value;
      const nv = Math.min(1, Math.max(0, base + step));
      if (v.muted && nv > 0) mediaControl(src, "mute", 0);
      mediaControl(src, "volume", nv);
      peekIcon.innerHTML = volumeIcon(nv, false, 11);
      peekBar.querySelector<HTMLElement>(".np-peek-fill")!.style.transform = `scaleX(${nv})`;
      pill.classList.add("peek");
      clearTimeout(peekTimer);
      peekTimer = window.setTimeout(() => pill.classList.remove("peek"), 1100);
    },
    { passive: false }
  );

  for (const [b, a] of [
    [bPlay, "toggle"],
    [bNext, "next"],
    [bPrev, "prev"],
  ] as const) {
    b.addEventListener("click", () => {
      press(b);
      act(a);
      if (a !== "toggle") startSkip();
    });
  }
  bShuffle.addEventListener("click", () => {
    if (!src) return;
    press(bShuffle);
    mediaControl(src, "shuffle", src.shuffle ? 0 : 1);
  });
  bRepeat.addEventListener("click", () => {
    if (!src) return;
    press(bRepeat);
    // Off → all → one → off, the order every player cycles in.
    const r = src.repeat ?? "none";
    mediaControl(src, "repeat", r === "none" ? 2 : r === "list" ? 1 : 0);
  });
  bMute.addEventListener("click", () => {
    if (!src) return;
    const v = volumeOf(src);
    if (!v) return;
    press(bMute);
    if (v.muted) mediaControl(src, "mute", 0);
    else if (v.value <= 0.001) mediaControl(src, "volume", 0.3);
    else mediaControl(src, "mute", 1);
  });

  island.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if ((e.target as HTMLElement).closest(".np-slider")) return;
    if (!src) return;
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      e.stopPropagation();
      act("toggle");
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && src.canSeek) {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey) act(e.key === "ArrowRight" ? "next" : "prev");
      else mediaControl(src, "seek", Math.max(0, positionOf(src) + (e.key === "ArrowRight" ? 5000 : -5000)));
    }
  });

  onMediaChange(render);

  return {
    el: slot,
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      render();
    },
    setOnlyWhilePlaying(on) {
      onlyWhilePlaying = on;
      render();
    },
    shown: () => isShown,
    isOpen: () => open,
    close,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
