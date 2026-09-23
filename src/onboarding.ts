/** First-run onboarding.
 *
 *  Shown exactly once, on the very first launch (no state.json on disk and no
 *  `onboardedAt` stamp in settings). Four steps, none of them mandatory: the
 *  welcome, a live theme pick, a short "how this app is shaped" page, and the
 *  first session. Esc or "Skip" leaves at any point and still stamps settings,
 *  so it never comes back uninvited.
 *
 *  Everything is drawn with the app's own tokens, and the theme step applies
 *  its pick immediately to `:root` — the overlay itself recolors as you choose,
 *  which is both the nicest moment in the flow and an honest preview.
 *
 *  Replay it from Settings → About & Data → "Replay welcome", or in the dev
 *  server with `?onboarding=1` (see `onboardingForcedByUrl`). */

import "./onboarding.css";
import appIcon from "../app-icon.png";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { store } from "./store";
import { applyTheme, THEMES } from "./themes";
import { prettyChord } from "./keybinds";
import { openExternalUrl } from "./terminals";
import { Action } from "./types";

export interface OnboardingOutcome {
  /** False when the user left early. Settings picked before leaving are kept. */
  completed: boolean;
  /** Set only when the user asked for a first session on the last step. */
  createSession: { name: string; cwd: string | null; command: string | null } | null;
}

export interface OnboardingOptions {
  /** Re-apply live settings (theme, font) to already-running panes. */
  applySettings: () => void;
  /** Replay from Settings. Same four steps (so the flow can be reviewed whole),
   *  only the last one is framed as opening another session rather than a first. */
  replay?: boolean;
  /** Folder Explorer handed us at launch — preselected on the session step so
   *  the user isn't asked for something they already answered. */
  folder?: string | null;
}

/** A curated nine rather than all 22 themes. The full set is one click away in
 *  Settings, and a first-run grid of 22 is a decision, not a delight. */
const FEATURED_THEMES = [
  "openterm",
  "tokyonight",
  "nord",
  "gruvbox",
  "dracula",
  "rosepine",
  "onedark",
  "cyberpunk",
  "paper",
];

const TEXT_SIZES: { label: string; size: number }[] = [
  { label: "Compact", size: 12 },
  { label: "Default", size: 14 },
  { label: "Large", size: 16 },
];

/** Every feature the app has, written out in full. The welcome only covers the
 *  three shapes everything else is built from, so the rest lives here. */
const DOCS_URL = "https://openterm.app/documentation";

const AGENTS: { label: string; command: string | null }[] = [
  { label: "Nothing", command: null },
  { label: "claude", command: "claude" },
  { label: "codex", command: "codex" },
  { label: "opencode", command: "opencode" },
  { label: "gemini", command: "gemini" },
];

/** True on a genuinely fresh install: no state file, no backups, no stamp. */
export function shouldRunOnboarding(): boolean {
  return store.isFirstRun() && !store.state.settings.onboardedAt;
}

/** `?onboarding=1` on the dev server (or any build) forces the flow to run so
 *  it can be reviewed without wiping %APPDATA%. */
export function onboardingForcedByUrl(): boolean {
  try {
    const v = new URLSearchParams(location.search).get("onboarding");
    return v !== null && v !== "0" && v !== "false";
  } catch {
    return false;
  }
}

const svg = (body: string, size = 44) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 44 44" fill="none" stroke="currentColor" ` +
  `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

function chord(action: Action): string {
  return prettyChord(store.state.settings.keybinds[action]);
}

function kbd(text: string): HTMLElement {
  const k = document.createElement("kbd");
  k.textContent = text;
  return k;
}

export function runOnboarding(opts: OnboardingOptions): Promise<OnboardingOutcome> {
  const stepCount = 4;
  let step = 0;
  let folder: string | null = opts.folder ?? null;
  let command: string | null = null;
  let done = false;

  // The theme is applied live, so a user who backs out mid-flow keeps what they
  // saw rather than snapping back. Their original stays only until first pick.
  const settings = store.state.settings;

  const el = document.createElement("div");
  el.className = "ob";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Welcome to OpenTerm");

  const card = document.createElement("div");
  card.className = "ob-card";
  el.appendChild(card);

  // ------------------------------------------------------------------ chrome
  const head = document.createElement("header");
  head.className = "ob-head";
  const rail = document.createElement("div");
  rail.className = "ob-rail";
  const railSegs: HTMLElement[] = [];
  for (let i = 0; i < stepCount; i++) {
    const seg = document.createElement("span");
    seg.className = "ob-rail-seg";
    rail.appendChild(seg);
    railSegs.push(seg);
  }
  const counter = document.createElement("span");
  counter.className = "ob-counter";
  head.append(rail, counter);

  const body = document.createElement("div");
  body.className = "ob-body";

  const foot = document.createElement("footer");
  foot.className = "ob-foot";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "ob-back";
  back.textContent = "Back";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "ob-skip";
  const spacer = document.createElement("div");
  spacer.className = "ob-spacer";
  const next = document.createElement("button");
  next.type = "button";
  next.className = "btn-primary ob-next";
  const nextHint = document.createElement("kbd");
  nextHint.className = "ob-next-hint";
  nextHint.textContent = "Enter";
  const nextWrap = document.createElement("div");
  nextWrap.className = "ob-next-wrap";
  nextWrap.append(next, nextHint);
  foot.append(back, skip, spacer, nextWrap);

  card.append(head, body, foot);

  // ------------------------------------------------------------------- steps
  function stepWelcome(): HTMLElement {
    const s = document.createElement("div");
    s.className = "ob-step ob-step-welcome";

    const mark = document.createElement("img");
    mark.className = "ob-mark";
    mark.src = appIcon;
    mark.alt = "";

    const h = document.createElement("h1");
    h.textContent = "Welcome to OpenTerm";

    const p = document.createElement("p");
    p.className = "ob-lede";
    p.textContent =
      "A home for the terminals you keep open all day. Three questions, about twenty seconds, and nothing you can't change later.";

    s.append(mark, h, p);
    return s;
  }

  function stepTheme(): HTMLElement {
    const s = document.createElement("div");
    s.className = "ob-step";
    s.append(title("Pick a look", "Applied as you click. Nineteen more live in Settings."));

    const grid = document.createElement("div");
    grid.className = "ob-themes";
    const cards: { id: string; el: HTMLButtonElement }[] = [];

    for (const id of FEATURED_THEMES) {
      const theme = THEMES.find((t) => t.id === id);
      if (!theme) continue;
      const c = document.createElement("button");
      c.type = "button";
      c.className = "ob-theme";
      c.setAttribute("aria-pressed", String(settings.theme === id));

      // An abstract chip of the palette: sidebar column, pane, accent bar.
      const chip = document.createElement("span");
      chip.className = "ob-theme-chip";
      chip.style.background = theme.vars["--bg-app"];
      chip.style.borderColor = theme.vars["--border"];
      const side = document.createElement("span");
      side.className = "ob-chip-side";
      side.style.background = theme.vars["--bg-sidebar"];
      const pane = document.createElement("span");
      pane.className = "ob-chip-pane";
      pane.style.background = theme.vars["--bg-pane"];
      const bar = document.createElement("span");
      bar.className = "ob-chip-bar";
      bar.style.background = theme.vars["--accent"];
      const line = document.createElement("span");
      line.className = "ob-chip-line";
      line.style.background = theme.vars["--text-dim"];
      chip.append(side, pane, bar, line);

      const name = document.createElement("span");
      name.className = "ob-theme-name";
      name.textContent = theme.name.replace(" (Default)", "");

      c.append(chip, name);
      c.addEventListener("click", () => {
        settings.theme = id;
        applyTheme(id);
        opts.applySettings();
        for (const other of cards) {
          other.el.classList.toggle("selected", other.id === id);
          other.el.setAttribute("aria-pressed", String(other.id === id));
        }
      });
      c.classList.toggle("selected", settings.theme === id);
      cards.push({ id, el: c });
      grid.appendChild(c);
    }
    s.appendChild(grid);

    // ---- text size, with a live terminal line to judge it by
    const preview = document.createElement("div");
    preview.className = "ob-preview";
    preview.setAttribute("aria-hidden", "true");
    preview.innerHTML =
      `<div><span class="ob-pv-prompt">PS C:\\dev\\openterm&gt;</span> npm run tauri dev</div>` +
      `<div class="ob-pv-dim">VITE ready in 412 ms · listening on 1420</div>` +
      `<div><span class="ob-pv-prompt">PS C:\\dev\\openterm&gt;</span> <span class="ob-pv-caret"></span></div>`;
    const syncPreview = () => preview.style.setProperty("--ob-pv-size", `${settings.fontSize}px`);
    syncPreview();

    const seg = document.createElement("div");
    seg.className = "ob-seg";
    const segBtns: { size: number; el: HTMLButtonElement }[] = [];
    for (const { label, size } of TEXT_SIZES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.classList.toggle("selected", settings.fontSize === size);
      b.addEventListener("click", () => {
        settings.fontSize = size;
        opts.applySettings();
        syncPreview();
        for (const o of segBtns) o.el.classList.toggle("selected", o.size === size);
      });
      segBtns.push({ size, el: b });
      seg.appendChild(b);
    }

    const sizeRow = document.createElement("div");
    sizeRow.className = "ob-size-row";
    const sizeLabel = document.createElement("span");
    sizeLabel.className = "ob-size-label";
    sizeLabel.textContent = "Terminal text";
    sizeRow.append(sizeLabel, seg);

    s.append(preview, sizeRow);
    return s;
  }

  function stepTour(): HTMLElement {
    const s = document.createElement("div");
    s.className = "ob-step";
    s.append(
      title("Three things worth knowing", "The whole app is built out of these. Nothing else to learn.")
    );

    const list = document.createElement("div");
    list.className = "ob-tour";

    const items: { art: string; name: string; text: string; keys: string[] }[] = [
      {
        // Sidebar with named rows: the session list.
        art: svg(
          '<rect x="3" y="6" width="13" height="32" rx="2.5"/>' +
            '<path d="M6.5 12.5h6M6.5 18h6.5M6.5 23.5h5"/>' +
            '<rect x="5" y="27.5" width="9" height="4" rx="1.2" fill="currentColor" stroke="none" opacity=".55"/>' +
            '<rect x="19" y="6" width="22" height="32" rx="2.5"/>'
        ),
        name: "Sessions",
        text: "One named workspace per project, stacked in the sidebar. They come back exactly as you left them.",
        keys: [chord("newSession"), "Alt+1…9"],
      },
      {
        // A pane split into a grid.
        art: svg(
          '<rect x="3" y="6" width="38" height="32" rx="2.5"/>' +
            '<path d="M22 6v32M22 22h19"/>' +
            '<path d="M7 11.5h10" opacity=".55"/>' +
            '<path d="M26.5 11.5h9M26.5 27.5h9" opacity=".55"/>'
        ),
        name: "Panes",
        text: "Split any terminal into a grid. Drag a pane's title bar onto another to move it, or onto its centre to swap.",
        keys: [chord("splitRight"), chord("splitDown")],
      },
      {
        // Stacked notices rising out of a pane.
        art: svg(
          '<rect x="3" y="14" width="24" height="24" rx="2.5"/>' +
            '<rect x="19" y="6" width="22" height="7" rx="2"/>' +
            '<rect x="22" y="15" width="19" height="7" rx="2" opacity=".6"/>' +
            '<path d="M7 20.5h9M7 26h6" opacity=".55"/>'
        ),
        name: "The inbox",
        text: "An agent in a pane you weren't watching asks for approval, or dies. It reaches the bell instead of the void.",
        keys: [chord("openInbox")],
      },
    ];

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "ob-tour-row";

      const art = document.createElement("div");
      art.className = "ob-tour-art";
      art.innerHTML = item.art;

      const text = document.createElement("div");
      text.className = "ob-tour-text";
      const h = document.createElement("h3");
      h.textContent = item.name;
      const p = document.createElement("p");
      p.textContent = item.text;
      const keys = document.createElement("div");
      keys.className = "ob-tour-keys";
      for (const k of item.keys) keys.appendChild(kbd(k));
      text.append(h, p, keys);

      row.append(art, text);
      list.appendChild(row);
    }

    const foot2 = document.createElement("p");
    foot2.className = "ob-note";
    foot2.append("Every shortcut is on one sheet, and every one of them is rebindable. Press ");
    foot2.appendChild(kbd(chord("cheatSheet")));
    foot2.append(" any time.");

    const docs = document.createElement("button");
    docs.type = "button";
    docs.className = "ob-docs";
    docs.append("Read the documentation");
    docs.insertAdjacentHTML(
      "beforeend",
      '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M4.5 1.8h5.7v5.7M10.2 1.8L5 7"/><path d="M8.6 7.4v2.4a.9.9 0 0 1-.9.9H2.5a.9.9 0 0 1-.9-.9V4.6a.9.9 0 0 1 .9-.9h2.3"/>' +
        "</svg>"
    );
    docs.title = DOCS_URL;
    docs.addEventListener("click", () => openExternalUrl(DOCS_URL));

    const footRow = document.createElement("div");
    footRow.className = "ob-tour-foot";
    footRow.append(foot2, docs);

    s.append(list, footRow);
    return s;
  }

  function stepSession(): HTMLElement {
    const s = document.createElement("div");
    s.className = "ob-step";
    s.append(
      title(
        opts.replay ? "Open a session" : "Open your first session",
        "A folder to work in, and what each terminal should start."
      )
    );

    // ---- folder
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "ob-folder";
    const pickIcon = document.createElement("span");
    pickIcon.className = "ob-folder-icon";
    pickIcon.innerHTML = svg(
      '<path d="M4 12.5a2 2 0 0 1 2-2h10l3.5 4H38a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
      22
    );
    const pickText = document.createElement("span");
    pickText.className = "ob-folder-text";
    const pickAction = document.createElement("span");
    pickAction.className = "ob-folder-action";
    pick.append(pickIcon, pickText, pickAction);

    const syncFolder = () => {
      pick.classList.toggle("chosen", folder !== null);
      pickText.textContent = folder ?? "Choose a folder";
      pickAction.textContent = folder ? "Change" : "Browse";
      next.textContent = folder ? "Open session" : "Start empty";
    };

    pick.addEventListener("click", () => {
      void openFolderDialog({ directory: true, multiple: false }).then((res) => {
        if (typeof res === "string") {
          folder = res;
          syncFolder();
        }
      });
    });

    // ---- launch command
    const agentLabel = document.createElement("span");
    agentLabel.className = "ob-size-label";
    agentLabel.textContent = "Each terminal starts";

    const chips = document.createElement("div");
    chips.className = "ob-chips";
    const chipEls: { cmd: string | null; el: HTMLButtonElement }[] = [];
    for (const a of AGENTS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ob-chip";
      b.textContent = a.label;
      b.classList.toggle("selected", command === a.command);
      b.addEventListener("click", () => {
        command = a.command;
        for (const o of chipEls) o.el.classList.toggle("selected", o.cmd === command);
      });
      chipEls.push({ cmd: a.command, el: b });
      chips.appendChild(b);
    }

    const agentRow = document.createElement("div");
    agentRow.className = "ob-size-row ob-agent-row";
    agentRow.append(agentLabel, chips);

    const note = document.createElement("p");
    note.className = "ob-note";
    note.textContent = opts.replay
      ? "Skip both and nothing happens. Choosing a folder opens it as a new session with three terminals."
      : "Skip either one. A session opens with three terminals and you can point them anywhere afterwards.";

    s.append(pick, agentRow, note);
    syncFolder();
    return s;
  }

  function title(heading: string, sub: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ob-title";
    const h = document.createElement("h2");
    h.textContent = heading;
    const p = document.createElement("p");
    p.textContent = sub;
    wrap.append(h, p);
    return wrap;
  }

  const builders = [stepWelcome, stepTheme, stepTour, stepSession];

  // ------------------------------------------------------------------ render
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function render(direction: 1 | -1): void {
    const incoming = builders[step]();
    if (direction === -1) incoming.classList.add("from-back");

    const outgoing = body.firstElementChild as HTMLElement | null;
    if (outgoing && !reduced) {
      outgoing.classList.add(direction === 1 ? "leaving" : "leaving-back");
      outgoing.addEventListener("animationend", () => outgoing.remove(), { once: true });
      body.appendChild(incoming);
    } else {
      body.replaceChildren(incoming);
    }

    railSegs.forEach((seg, i) => seg.classList.toggle("done", i <= step));
    counter.textContent = `${step + 1} / ${stepCount}`;
    back.hidden = step === 0;
    const last = step === builders.length - 1;
    skip.hidden = last;
    skip.textContent = step === 0 ? "Skip setup" : "Skip the rest";
    next.textContent = step === 0
      ? "Get started"
      : !last
        ? "Continue"
        : folder
          ? "Open session"
          : opts.replay
            ? "Done"
            : "Start empty";

    // Focus the primary action so Enter and Tab both land somewhere sensible,
    // without stealing focus into the middle of the step's controls.
    requestAnimationFrame(() => next.focus({ preventScroll: true }));
  }

  // ------------------------------------------------------------------ finish
  let settle!: (o: OnboardingOutcome) => void;
  const promise = new Promise<OnboardingOutcome>((res) => (settle = res));

  function close(outcome: OnboardingOutcome): void {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onKey, true);
    settings.onboardedAt = Date.now();
    store.save(true);
    el.classList.add("closing");
    const finish = () => {
      el.remove();
      settle(outcome);
    };
    if (reduced) finish();
    else el.addEventListener("animationend", finish, { once: true });
  }

  function advance(): void {
    if (step < builders.length - 1) {
      step++;
      render(1);
      return;
    }
    close({
      completed: true,
      // A replay only creates a session when the user actually chose a folder;
      // a first run also honours a bare agent pick with an empty session.
      createSession:
        folder || (command && !opts.replay)
          ? { name: folder ? folderLabel(folder) : "Session 1", cwd: folder, command }
          : null,
    });
  }

  function goBack(): void {
    if (step === 0) return;
    step--;
    render(-1);
  }

  next.addEventListener("click", advance);
  back.addEventListener("click", goBack);
  skip.addEventListener("click", () => close({ completed: false, createSession: null }));

  function onKey(e: KeyboardEvent): void {
    if (!el.isConnected) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close({ completed: false, createSession: null });
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement && e.target !== next)) {
      e.preventDefault();
      e.stopPropagation();
      advance();
    } else if (e.key === "Tab") {
      trapTab(e);
    }
  }

  /** The overlay owns the whole window while it's up, so Tab stays inside it. */
  function trapTab(e: KeyboardEvent): void {
    const focusable = [...card.querySelectorAll<HTMLElement>("button:not([hidden])")].filter(
      (b) => b.offsetParent !== null
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !card.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(el);
  render(1);

  return promise;
}

function folderLabel(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
