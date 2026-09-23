/** Shared close-animation plumbing for anchored popups (inbox panel, session
 *  "⋯" menu, delegate popover).
 *
 *  They all open with a keyframe and are hidden by `display: none`, which gives
 *  them no way to animate *out* — dropping `.visible` makes them vanish on the
 *  frame. So closing swaps `.visible` for `.closing`, which keeps the box
 *  displayed while a short reverse keyframe plays, and the class comes off when
 *  the animation ends (with a timer as backstop, since `animationend` never
 *  fires if the element is display:none or the animation is overridden away).
 */

/** Matches the .closing animations in styles.css / tasks.css, plus slack. */
const FALLBACK_MS = 260;

const pending = new WeakMap<HTMLElement, () => void>();

/** Plays `el`'s closing animation, then runs `after` (hide it, remove it, …).
 *  Calling it again — or `cancelCollapse` — supersedes any collapse in flight. */
export function collapse(el: HTMLElement, after: () => void): void {
  cancelCollapse(el);
  el.classList.remove("visible");
  el.classList.add("closing");

  const finish = (): void => {
    clearTimeout(timer);
    el.removeEventListener("animationend", onEnd);
    pending.delete(el);
    el.classList.remove("closing");
    after();
  };
  // Ignore animationend bubbling up from anything inside the popup.
  const onEnd = (e: AnimationEvent): void => {
    if (e.target === el) finish();
  };

  const timer = setTimeout(finish, FALLBACK_MS);
  el.addEventListener("animationend", onEnd);
  pending.set(el, finish);
}

/** Ends an in-flight collapse immediately, running its `after`. Call before
 *  reopening so a popup reopened mid-animation starts from a clean state. */
export function cancelCollapse(el: HTMLElement): void {
  pending.get(el)?.();
}
