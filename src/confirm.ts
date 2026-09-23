export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** In-app confirmation modal styled to match the app (replaces the OS dialog). */
export function createConfirm() {
  const el = document.createElement("div");
  el.className = "confirm";

  const card = document.createElement("div");
  card.className = "confirm-card";

  const title = document.createElement("h2");
  const msg = document.createElement("p");
  msg.className = "confirm-msg";

  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-ghost";
  cancelBtn.title = "Esc";
  const okBtn = document.createElement("button");
  okBtn.title = "Enter";
  actions.append(cancelBtn, okBtn);

  card.append(title, msg, actions);
  el.appendChild(card);

  let resolver: ((ok: boolean) => void) | null = null;

  function close(result: boolean): void {
    if (!resolver) return;
    const done = resolver;
    resolver = null;
    el.classList.remove("visible");
    done(result);
  }

  // Backdrop click cancels; clicks inside the card are swallowed.
  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) close(false);
  });
  card.addEventListener("pointerdown", (e) => e.stopPropagation());
  cancelBtn.addEventListener("click", () => close(false));
  okBtn.addEventListener("click", () => close(true));
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close(false);
    else if (e.key === "Enter") {
      e.preventDefault();
      close(true);
    }
  });

  function ask(opts: ConfirmOptions): Promise<boolean> {
    // Resolve any dialog already on screen as cancelled before opening a new one.
    close(false);
    title.textContent = opts.title;
    msg.textContent = opts.message;
    cancelBtn.textContent = opts.cancelLabel ?? "Cancel";
    okBtn.textContent = opts.confirmLabel ?? "Confirm";
    okBtn.className = opts.danger ? "btn-danger" : "btn-start";
    el.classList.add("visible");
    // Focus Cancel by default — safer for a destructive action; Enter still confirms.
    requestAnimationFrame(() => cancelBtn.focus());
    return new Promise((resolve) => {
      resolver = resolve;
    });
  }

  return { el, ask, isOpen: () => resolver !== null };
}
