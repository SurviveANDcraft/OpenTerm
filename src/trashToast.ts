import { trash, TrashEntry } from "./trash";

const VISIBLE_MS = 8000;

/** Floating "Undo" toasts for the trash ring — one appears each time a
 *  session/pane/task is closed, offering an immediate way back. The
 *  underlying trash entry stays restorable for longer (see trash.ts) even
 *  after the toast itself fades, via the restoreLast keybind. */
export function createTrashToast() {
  const el = document.createElement("div");
  el.className = "trash-toast-stack";

  function show(entry: TrashEntry): void {
    const card = document.createElement("div");
    card.className = "trash-toast";

    const msg = document.createElement("span");
    msg.textContent = entry.label;

    const undoBtn = document.createElement("button");
    undoBtn.className = "trash-toast-undo";
    undoBtn.textContent = "Undo";

    card.append(msg, undoBtn);
    el.appendChild(card);
    requestAnimationFrame(() => card.classList.add("visible"));

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      card.classList.remove("visible");
      window.setTimeout(() => card.remove(), 200);
    };

    undoBtn.addEventListener("click", () => {
      trash.restore(entry.id);
      dismiss();
    });

    window.setTimeout(dismiss, VISIBLE_MS);
  }

  trash.onPush(show);

  return { el };
}
