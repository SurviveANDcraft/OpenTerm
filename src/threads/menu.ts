/** Popovers anchored to a button: a keyboard-friendly menu and a free-form
 *  panel. One at a time. Clicking the anchor of the open popover closes it. */
import { ic, type IconName } from "./icons";

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  iconHtml?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  kbd?: string;
  sep?: boolean;
}

export interface PopoverOpts {
  title?: string;
  place?: "above" | "below";
  align?: "start" | "end";
  width?: number;
  className?: string;
}

let current: { el: HTMLElement; anchor: HTMLElement; close: () => void } | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function closeMenu(): void {
  current?.close();
}

export function isMenuOpen(): boolean {
  return !!current;
}

/** Mounts `build()` as the popover of `anchor`, or closes it when that
 *  anchor's popover is already open (the second click on a toggle). */
export function openPopover(
  anchor: HTMLElement,
  build: () => HTMLElement,
  opts: PopoverOpts = {},
  onKey?: (e: KeyboardEvent) => boolean
): { el: HTMLElement; close: () => void; place: () => void } | null {
  if (current?.anchor === anchor) {
    closeMenu();
    return null;
  }
  closeMenu();
  const el = build();
  el.classList.add("th-menu");
  if (opts.className) el.classList.add(...opts.className.split(" "));
  if (opts.width) el.style.width = `${opts.width}px`;
  document.body.appendChild(el);
  let where: "above" | "below" | null = null;
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    where ??= opts.place ?? (r.bottom + m.height + 8 > window.innerHeight ? "above" : "below");
    let left = opts.align === "end" ? r.right - m.width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8));
    const top = where === "above" ? r.top - m.height - 6 : r.bottom + 6;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(8, top)}px`;
    el.classList.toggle("from-below", where === "above");
    el.classList.toggle("from-above", where !== "above");
  };
  place();
  anchor.classList.add("menu-open");
  anchor.setAttribute("aria-expanded", "true");

  const close = () => {
    if (current?.el !== el) return;
    current = null;
    anchor.classList.remove("menu-open");
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys, true);
    window.removeEventListener("resize", close);
    el.classList.add("closing");
    window.setTimeout(() => el.remove(), 120);
  };
  // The anchor is excluded so its own click can toggle the popover shut.
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const keys = (e: KeyboardEvent) => {
    if (onKey?.(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus();
    } else if (e.key === "Tab") close();
  };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keys, true);
  window.addEventListener("resize", close);
  current = { el, anchor, close };
  return { el, close, place };
}

export function menuItemsHtml(items: MenuItem[]): string {
  return items
    .map((it) =>
      it.sep
        ? `<div class="th-menu-sep"></div>`
        : `<button class="th-menu-item ${it.danger ? "danger" : ""} ${it.checked ? "checked" : ""}" data-id="${esc(it.id)}" role="menuitem" type="button" ${it.disabled ? "disabled" : ""}>
            ${it.iconHtml ? `<span class="th-menu-icon">${it.iconHtml}</span>` : it.icon ? `<span class="th-menu-icon">${ic(it.icon, 14)}</span>` : ""}
            <span class="th-menu-text"><span class="th-menu-label">${esc(it.label)}</span>${it.hint ? `<span class="th-menu-hint">${esc(it.hint)}</span>` : ""}</span>
            ${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ""}
            ${it.checked ? `<span class="th-menu-check">${ic("check", 11)}</span>` : ""}
          </button>`
    )
    .join("");
}

/** Arrow-key focus movement over the visible, enabled items of a popover. */
export function arrowNav(el: HTMLElement, e: KeyboardEvent, selector = ".th-menu-item:not([disabled])"): boolean {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return false;
  const list = Array.from(el.querySelectorAll<HTMLButtonElement>(selector)).filter((b) => b.offsetParent !== null);
  if (!list.length) return false;
  e.preventDefault();
  e.stopPropagation();
  const i = list.indexOf(document.activeElement as HTMLButtonElement);
  const n = i < 0 ? (e.key === "ArrowDown" ? 0 : list.length - 1) : e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
  list[n]?.focus();
  list[n]?.scrollIntoView({ block: "nearest" });
  return true;
}

export function openMenu(anchor: HTMLElement, items: MenuItem[], onPick: (id: string) => void, opts: PopoverOpts = {}): void {
  let host: HTMLElement | null = null;
  const pop = openPopover(
    anchor,
    () => {
      host = document.createElement("div");
      host.setAttribute("role", "menu");
      host.innerHTML = (opts.title ? `<div class="th-menu-title">${esc(opts.title)}</div>` : "") + menuItemsHtml(items);
      return host;
    },
    opts,
    (e) => (host ? arrowNav(host, e) : false)
  );
  if (!pop) return;
  const { el, close } = pop;
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".th-menu-item");
    if (!b || b.disabled) return;
    close();
    onPick(b.dataset.id!);
  });
  const checked = el.querySelector<HTMLButtonElement>(".th-menu-item.checked") ?? el.querySelector<HTMLButtonElement>(".th-menu-item:not([disabled])");
  requestAnimationFrame(() => checked?.focus({ preventScroll: true }));
}
