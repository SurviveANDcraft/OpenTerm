import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { Session, SESSION_COLORS } from "./types";

export interface SessionSettingsPatch {
  name: string;
  color: string;
  cwd: string | null;
}

export interface SessionSettingsHandlers {
  onSave(id: string, patch: SessionSettingsPatch): void;
}

/** Small modal for editing one session's own properties (name, color, start directory) —
 *  distinct from the global app settings page. */
export function createSessionSettings(handlers: SessionSettingsHandlers) {
  const el = document.createElement("div");
  el.className = "confirm session-settings";

  const card = document.createElement("div");
  card.className = "confirm-card";

  const title = document.createElement("h2");
  title.textContent = "Session settings";

  const nameRow = document.createElement("div");
  nameRow.className = "wizard-row";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "wizard-name";
  nameInput.spellcheck = false;
  nameRow.append(nameLabel, nameInput);

  const colorRow = document.createElement("div");
  colorRow.className = "wizard-row";
  const colorLabel = document.createElement("label");
  colorLabel.textContent = "Color";
  const swatches = document.createElement("div");
  swatches.className = "color-swatches";
  let color = SESSION_COLORS[0];
  const swatchEls = SESSION_COLORS.map((c) => {
    const b = document.createElement("button");
    b.className = "color-swatch";
    b.style.background = c;
    b.title = c;
    b.addEventListener("click", () => {
      color = c;
      swatchEls.forEach((s) => s.classList.toggle("selected", s === b));
    });
    swatches.appendChild(b);
    return b;
  });
  colorRow.append(colorLabel, swatches);

  const pathRow = document.createElement("div");
  pathRow.className = "wizard-row";
  const pathLabel = document.createElement("label");
  pathLabel.textContent = "Start in";
  const pathWrap = document.createElement("div");
  pathWrap.className = "path-wrap";
  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.spellcheck = false;
  pathInput.placeholder = "Home directory";
  const browseBtn = document.createElement("button");
  browseBtn.className = "btn-secondary";
  browseBtn.textContent = "Browse…";
  browseBtn.addEventListener("click", async () => {
    const dir = await openFolderDialog({ directory: true, title: "Session starting folder" });
    if (typeof dir === "string") pathInput.value = dir;
  });
  pathWrap.append(pathInput, browseBtn);
  pathRow.append(pathLabel, pathWrap);

  const hint = document.createElement("span");
  hint.className = "field-hint";
  hint.textContent = "Applies to new terminals opened in this session.";

  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-ghost";
  cancelBtn.textContent = "Cancel";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  actions.append(cancelBtn, saveBtn);

  card.append(title, nameRow, colorRow, pathRow, hint, actions);
  el.appendChild(card);

  let sessionId: string | null = null;

  function close(): void {
    sessionId = null;
    el.classList.remove("visible");
  }

  function save(): void {
    if (!sessionId) return;
    handlers.onSave(sessionId, {
      name: nameInput.value.trim() || nameInput.placeholder,
      color,
      cwd: pathInput.value.trim() || null,
    });
    close();
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) close();
  });
  card.addEventListener("pointerdown", (e) => e.stopPropagation());
  cancelBtn.addEventListener("click", close);
  saveBtn.addEventListener("click", save);
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
      e.preventDefault();
      save();
    }
  });

  function open(session: Session): void {
    sessionId = session.id;
    nameInput.value = session.name;
    nameInput.placeholder = session.name;
    color = session.color;
    swatchEls.forEach((s, i) => s.classList.toggle("selected", SESSION_COLORS[i] === color));
    pathInput.value = session.cwd ?? "";
    el.classList.add("visible");
    requestAnimationFrame(() => {
      nameInput.focus();
      nameInput.select();
    });
  }

  return { el, open, close, isOpen: () => sessionId !== null };
}
