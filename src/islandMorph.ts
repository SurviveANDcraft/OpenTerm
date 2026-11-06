/** The "island" behaviour shared by the title-bar widgets (Now playing,
 *  Timer): a panel that grows out of its pill and shrinks back into it.
 *
 *  The morph is driven per frame rather than by a keyframe animation: the pill
 *  is measured on every frame, so the panel lands on its real outline even
 *  while the pill is still resizing (hover controls folding away as the
 *  pointer leaves). It runs on a critically damped spring, so reversing
 *  mid-way carries on from the current shape instead of restarting. */

const SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";

const reduceMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface IslandOptions {
  pill: HTMLElement;
  island: HTMLElement;
  /** The panel's content, faded and blurred in and out. */
  body: HTMLElement;
  /** Fills the panel before it's measured. `fresh` is false when it was
   *  re-opened mid-close and still shows its content. */
  render(fresh: boolean): void;
  /** Open state changed (at the start of an open or a close). */
  onOpenChange(open: boolean): void;
  /** The close has finished and the panel is hidden. */
  onClosed?(): void;
  /** False skips the close animation (the pill itself is going away). */
  canMorphClose?(): boolean;
  /** Called on every morph frame. */
  onFrame?(): void;
  /** Take keyboard focus on open. Default true. */
  focus?: boolean;
  /** Corner radius of the open panel. */
  radius?: number;
}

export interface Island {
  isOpen(): boolean;
  /** True while the morph is running. */
  morphing(): boolean;
  open(opts?: { focus?: boolean }): void;
  close(): void;
  toggle(): void;
}

export function createIsland(o: IslandOptions): Island {
  const { pill, island, body } = o;
  const radius = o.radius ?? 22;
  let open = false;
  /** How far the island is between the pill (0) and fully open (1). */
  let k = 0;
  let raf = 0;
  let running = false;
  /** The close's content fade. It holds its end state (fill: forwards) until
   *  the island hides, so it must be cancelled before the next open — left in
   *  place it re-blanks the content the moment the open animation ends. */
  let fade: Animation | null = null;

  /** The shadow and glow, drawn on their own layer so the clip can't cut
   *  them (see .island-glow). */
  const glow = document.createElement("div");
  glow.className = "island-glow";
  glow.hidden = true;
  island.before(glow);

  /** Puts the glow on the island's visible outline, at `strength` 0–1. */
  function paintGlow(left: number, top: number, width: number, height: number, r: number, strength: number): void {
    glow.style.left = `${left.toFixed(2)}px`;
    glow.style.top = `${top.toFixed(2)}px`;
    glow.style.width = `${Math.max(0, width).toFixed(2)}px`;
    glow.style.height = `${Math.max(0, height).toFixed(2)}px`;
    glow.style.borderRadius = `${r.toFixed(2)}px`;
    // Eased so the glow arrives with the panel's body, not ahead of it.
    glow.style.opacity = String(Math.max(0, Math.min(1, strength)) ** 1.6);
    // Follow the cover tint the island was given.
    const tint = island.style.getPropertyValue("--np-tint");
    if (tint) glow.style.setProperty("--np-tint", tint);
    else glow.style.removeProperty("--np-tint");
  }

  /** The glow on the fully open island; also tracks it growing or shrinking
   *  while open (a composer folding open, a list changing). */
  function settleGlow(): void {
    if (island.hidden) return;
    paintGlow(island.offsetLeft, island.offsetTop, island.offsetWidth, island.offsetHeight, radius, 1);
  }
  const resizeWatch = new ResizeObserver(() => {
    if (open && !running) settleGlow();
  });
  resizeWatch.observe(island);
  // A new cover tint while open (the next song) recolours the glow too.
  new MutationObserver(() => {
    if (open && !running) settleGlow();
  }).observe(island, { attributes: true, attributeFilter: ["style"] });

  function place(): void {
    const p = pill.getBoundingClientRect();
    const tb = pill.closest(".titlebar")?.getBoundingClientRect();
    const w = island.offsetWidth;
    const cx = p.left + p.width / 2;
    const left = Math.round(Math.min(Math.max(cx - w / 2, 8), window.innerWidth - w - 8));
    island.style.left = `${left}px`;
    island.style.top = `${Math.round((tb?.bottom ?? p.bottom) + 6)}px`;
  }

  function paint(at: number): void {
    const p = pill.getBoundingClientRect();
    const L = island.offsetLeft;
    const T = island.offsetTop;
    const W = island.offsetWidth;
    const H = island.offsetHeight;
    const q = 1 - at;
    const r = p.height / 2 + (radius - p.height / 2) * at;
    const dy = (p.top - T) * q;
    const insetL = (p.left - L) * q;
    const insetR = (L + W - p.right) * q;
    const insetB = (H - p.height) * q;
    island.style.transform = `translateY(${dy.toFixed(2)}px)`;
    island.style.clipPath = `inset(0px ${insetR.toFixed(2)}px ${insetB.toFixed(2)}px ${insetL.toFixed(2)}px round ${r.toFixed(2)}px)`;
    paintGlow(L + insetL, T + dy, W - insetL - insetR, H - insetB, r, at);
    // The last stretch of a close dissolves into the pill instead of
    // swapping for it on one frame.
    island.style.opacity = String(Math.min(1, at / 0.22));
  }

  function clear(): void {
    island.style.transform = "";
    island.style.clipPath = "";
    island.style.opacity = "";
    if (open) settleGlow();
  }

  function morphTo(target: 0 | 1, done: () => void): void {
    cancelAnimationFrame(raf);
    const from = k;
    const omega = target ? 13 : 16;
    const t0 = performance.now();
    running = true;
    const step = (now: number) => {
      const t = (now - t0) / 1000;
      let e = 1 - (1 + omega * t) * Math.exp(-omega * t);
      if (e > 0.9985) e = 1;
      k = from + (target - from) * e;
      paint(k);
      o.onFrame?.();
      if (e < 1) raf = requestAnimationFrame(step);
      else {
        raf = 0;
        running = false;
        done();
      }
    };
    raf = requestAnimationFrame(step);
  }

  function onOutside(e: PointerEvent): void {
    const t = e.target as Node;
    if (island.contains(t) || pill.contains(t)) return;
    close();
  }

  // A click into a child webview (browser pane) never reaches our document.
  function onWindowBlur(): void {
    setTimeout(() => {
      if (!document.hasFocus()) close();
    }, 0);
  }

  function openIsland(opts: { focus?: boolean } = {}): void {
    if (open) return;
    open = true;
    fade?.cancel();
    fade = null;
    const fresh = island.hidden;
    island.hidden = false;
    glow.hidden = false;
    island.classList.remove("closing");
    pill.classList.add("open");
    o.onOpenChange(true);
    o.render(fresh);
    if (fresh) k = 0;
    place();
    if (reduceMotion()) {
      k = 1;
      clear();
    } else {
      paint(k);
      morphTo(1, clear);
      body.animate(
        [
          { opacity: 0, transform: "translateY(-10px) scale(0.96)", filter: "blur(6px)" },
          { opacity: 1, transform: "none", filter: "none" },
        ],
        { duration: 480, delay: fresh ? 90 : 0, easing: SPRING, fill: "backwards" }
      );
      if (fresh)
        Array.from(body.children).forEach((c, idx) =>
          (c as HTMLElement).animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
            duration: 420,
            delay: 120 + idx * 35,
            easing: SPRING,
            fill: "backwards",
          })
        );
    }
    if (opts.focus ?? o.focus ?? true) island.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", onWindowBlur);
  }

  function close(): void {
    if (!open) return;
    open = false;
    pill.classList.remove("open");
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("blur", onWindowBlur);
    o.onOpenChange(false);
    const finish = () => {
      if (open) return;
      island.hidden = true;
      glow.hidden = true;
      glow.style.opacity = "0";
      island.classList.remove("closing");
      fade?.cancel();
      fade = null;
      k = 0;
      clear();
      o.onClosed?.();
    };
    if (reduceMotion() || o.canMorphClose?.() === false) {
      cancelAnimationFrame(raf);
      running = false;
      finish();
      return;
    }
    island.classList.add("closing");
    fade?.cancel();
    fade = body.animate([{ opacity: 1, filter: "none" }, { opacity: 0, filter: "blur(4px)" }], {
      duration: 150,
      easing: "ease-in",
      fill: "forwards",
    });
    morphTo(0, finish);
  }

  return {
    isOpen: () => open,
    morphing: () => running,
    open: openIsland,
    close,
    toggle: () => (open ? close() : openIsland()),
  };
}
