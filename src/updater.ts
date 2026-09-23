import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, Update } from "@tauri-apps/plugin-updater";

/**
 * Auto-update against the GitHub Releases manifest configured in
 * `tauri.conf.json`. One shared state object drives both surfaces: the popup
 * that appears on startup and the Updates section in Settings — so dismissing
 * the popup never loses the update, it stays reachable from Settings.
 */

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "uptodate"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  /** Version offered by the server — only set once `phase` is past "available". */
  newVersion?: string;
  notes?: string;
  /** 0..1 while downloading, when the server sends a content-length. */
  progress?: number;
  error?: string;
}

const state: UpdateState = { phase: "idle", currentVersion: "…" };
const listeners = new Set<(s: UpdateState) => void>();
let pending: Update | null = null;

void getVersion().then((v) => {
  state.currentVersion = v;
  emit();
});

function emit(): void {
  for (const fn of listeners) fn(state);
}

export function onUpdateState(fn: (s: UpdateState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function updateState(): UpdateState {
  return state;
}

/**
 * Ask the server whether a newer release exists. Network failures are surfaced
 * as an "error" phase rather than thrown — a missing internet connection must
 * never break app startup.
 */
export async function checkForUpdate(): Promise<boolean> {
  if (state.phase === "checking" || state.phase === "downloading") return false;
  state.phase = "checking";
  state.error = undefined;
  emit();
  try {
    const update = await check();
    if (update) {
      pending = update;
      state.phase = "available";
      state.newVersion = update.version;
      state.notes = update.body ?? undefined;
    } else {
      pending = null;
      state.phase = "uptodate";
    }
  } catch (e) {
    void invoke("dictation_ensure_agent").catch(() => {});
    state.phase = "error";
    state.error = String(e);
  }
  emit();
  return state.phase === "available";
}

/**
 * Download and install the pending update, then relaunch. On Windows the
 * installer runs in "passive" mode, so the app exits partway through this
 * call — the `relaunch()` is what brings it back on the new version.
 */
export async function installUpdate(): Promise<void> {
  if (!pending || state.phase === "downloading") return;
  state.phase = "downloading";
  state.progress = undefined;
  emit();

  let total = 0;
  let received = 0;
  try {
    // The dictation agent runs from this same exe; the installer can't
    // replace a file that's still running. The new version starts it again.
    await invoke("dictation_quit_agent").catch(() => {});
    await pending.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        if (total > 0) {
          state.progress = received / total;
          emit();
        }
      } else if (event.event === "Finished") {
        state.phase = "ready";
        state.progress = 1;
        emit();
      }
    });
    // Stand down the single-instance guard first, or it would mistake our own
    // replacement process for a duplicate launch and quietly kill it.
    await invoke("release_single_instance_lock").catch(() => {});
    await relaunch();
  } catch (e) {
    void invoke("dictation_ensure_agent").catch(() => {});
    state.phase = "error";
    state.error = String(e);
    emit();
  }
}

/** The startup popup. Mounted once; shows itself only when an update exists. */
export function createUpdatePopup() {
  const el = document.createElement("div");
  el.className = "confirm update-popup";

  const card = document.createElement("div");
  card.className = "confirm-card";

  const title = document.createElement("h2");
  const msg = document.createElement("p");
  msg.className = "confirm-msg";

  const notes = document.createElement("pre");
  notes.className = "update-notes";

  const bar = document.createElement("div");
  bar.className = "update-bar";
  const fill = document.createElement("div");
  fill.className = "update-bar-fill";
  bar.appendChild(fill);

  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const laterBtn = document.createElement("button");
  laterBtn.className = "btn-ghost";
  laterBtn.textContent = "Later";
  const updateBtn = document.createElement("button");
  updateBtn.className = "btn-start";
  updateBtn.textContent = "Update now";
  actions.append(laterBtn, updateBtn);

  card.append(title, msg, notes, bar, actions);
  el.appendChild(card);

  let open = false;

  function close(): void {
    open = false;
    el.classList.remove("visible");
  }

  laterBtn.addEventListener("click", close);
  updateBtn.addEventListener("click", () => void installUpdate());
  el.addEventListener("pointerdown", (e) => {
    // Backdrop dismisses, but not mid-download — cancelling there would leave
    // a half-written installer behind.
    if (e.target === el && state.phase !== "downloading") close();
  });
  card.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && state.phase !== "downloading") close();
  });

  onUpdateState((s) => {
    if (s.phase === "available" && !open) {
      open = true;
      el.classList.add("visible");
      requestAnimationFrame(() => laterBtn.focus());
    }
    if (!open) return;

    const busy = s.phase === "downloading" || s.phase === "ready";
    title.textContent = busy ? "Updating OpenTerm" : "Update available";
    msg.textContent =
      s.phase === "downloading"
        ? "Downloading the new version — the app will restart when it's done."
        : s.phase === "ready"
          ? "Installing — OpenTerm will restart in a moment."
          : s.phase === "error"
            ? `Update failed: ${s.error}`
            : `OpenTerm ${s.newVersion} is available. You're on ${s.currentVersion}.`;

    notes.textContent = s.notes ?? "";
    notes.style.display = s.notes && !busy ? "" : "none";

    bar.style.display = busy ? "" : "none";
    fill.style.width = s.progress != null ? `${Math.round(s.progress * 100)}%` : "35%";
    fill.classList.toggle("indeterminate", busy && s.progress == null);

    laterBtn.disabled = busy;
    updateBtn.disabled = busy;
    updateBtn.textContent = busy ? "Updating…" : "Update now";
  });

  return { el, isOpen: () => open, close };
}
