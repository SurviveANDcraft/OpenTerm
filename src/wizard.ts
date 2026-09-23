import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { killPty, resizePty, spawnPty, writePty } from "./pty";
import { getTermTheme } from "./themes";
import { store } from "./store";
import { uid } from "./types";

export interface WizardResult {
  name: string;
  count: number;
  cwd: string | null;
  command: string | null;
}

/** Output routing for the wizard's navigator terminal (fed from main's pty-output listener). */
export const navSinks = new Map<string, (data: Uint8Array) => void>();

/** PowerShell prompt that reports the cwd via OSC 9;9 after every command. */
const NAV_PROMPT =
  "function prompt { Write-Host -NoNewline ([char]27+']9;9;'+$PWD.Path+[char]7); 'PS '+$PWD.Path+'> ' }";

const PRESETS: { label: string; cmd: string | null }[] = [
  { label: "None", cmd: null },
  { label: "claude", cmd: "claude" },
  { label: "codex", cmd: "codex" },
  { label: "opencode", cmd: "opencode" },
  { label: "n8n", cmd: "n8n" },
  { label: "Custom…", cmd: "__custom__" },
];

export function createWizard(onCreate: (r: WizardResult) => void) {
  const el = document.createElement("div");
  el.className = "wizard";

  let openState = false;
  let navId: string | null = null;
  let navTerm: Terminal | null = null;
  let count = 3;
  let preset = 0;

  // ---- build static skeleton ----
  const card = document.createElement("div");
  card.className = "wizard-card";
  el.appendChild(card);

  const header = document.createElement("header");
  header.innerHTML = `<h2>New session</h2><span>Enter to start · Esc to cancel</span>`;

  // name
  const nameInput = document.createElement("input");
  nameInput.className = "wizard-name";
  nameInput.type = "text";
  nameInput.spellcheck = false;

  // count stepper
  const countRow = row("Terminals");
  const stepper = document.createElement("div");
  stepper.className = "stepper";
  stepper.tabIndex = 0; // focusable so ← / → can adjust the count
  const minus = document.createElement("button");
  minus.textContent = "−";
  minus.title = "Fewer terminals";
  const countVal = document.createElement("span");
  const plus = document.createElement("button");
  plus.textContent = "+";
  plus.title = "More terminals";
  stepper.append(minus, countVal, plus);
  countRow.appendChild(stepper);
  const setCount = (n: number) => {
    count = Math.max(1, Math.min(12, n));
    countVal.textContent = String(count);
    minus.disabled = count <= 1;
    plus.disabled = count >= 12;
  };
  minus.addEventListener("click", () => setCount(count - 1));
  plus.addEventListener("click", () => setCount(count + 1));

  // path
  const pathRow = row("Start in");
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
  pathRow.appendChild(pathWrap);

  // navigator terminal
  const navLabel = document.createElement("div");
  navLabel.className = "wizard-nav-label";
  navLabel.textContent = "…or cd around below — the path above follows you";
  const navHost = document.createElement("div");
  navHost.className = "wizard-nav";

  // command
  const cmdRow = row("Run on start");
  const chips = document.createElement("div");
  chips.className = "chips";
  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.className = "custom-cmd";
  customInput.placeholder = "e.g.  npm run dev";
  customInput.spellcheck = false;
  const chipEls: HTMLButtonElement[] = PRESETS.map((p, i) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p.label;
    b.addEventListener("click", () => {
      preset = i;
      chipEls.forEach((c, j) => c.classList.toggle("selected", j === i));
      customInput.classList.toggle("visible", p.cmd === "__custom__");
      if (p.cmd === "__custom__") customInput.focus();
    });
    chips.appendChild(b);
    return b;
  });
  cmdRow.append(chips);

  // footer
  const footer = document.createElement("footer");
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-secondary";
  cancelBtn.textContent = "Cancel";
  const startBtn = document.createElement("button");
  startBtn.className = "btn-start";
  startBtn.textContent = "Start session";
  footer.append(cancelBtn, startBtn);

  card.append(header, nameInput, countRow, pathRow, navLabel, navHost, cmdRow, customInput, footer);

  function row(label: string): HTMLElement {
    const r = document.createElement("div");
    r.className = "wizard-row";
    const l = document.createElement("label");
    l.textContent = label;
    r.appendChild(l);
    return r;
  }

  // ---- navigator lifecycle ----
  async function startNav(): Promise<void> {
    stopNav();
    navId = `nav-${uid()}`;
    navTerm = new Terminal({
      fontSize: 12,
      fontFamily: store.state.settings.fontFamily,
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: 500,
      allowProposedApi: true,
      theme: getTermTheme(),
    });
    const fit = new FitAddon();
    navTerm.loadAddon(fit);
    navTerm.open(navHost);
    navTerm.parser.registerOscHandler(9, (data) => {
      if (data.startsWith("9;")) pathInput.value = data.slice(2);
      return true;
    });
    const id = navId;
    navTerm.onData((d) => void writePty(id, d));
    navTerm.onResize(({ cols, rows }) => void resizePty(id, cols, rows));
    navSinks.set(id, (data) => navTerm?.write(data));

    requestAnimationFrame(async () => {
      try {
        fit.fit();
      } catch {
        /* not visible yet */
      }
      const shellSetting = store.state.settings.shell.toLowerCase();
      const shell = shellSetting.includes("pwsh") ? store.state.settings.shell : "powershell.exe";
      try {
        await spawnPty(id, navTerm?.cols || 80, navTerm?.rows || 12, shell, pathInput.value || null, [
          "-NoLogo",
          "-NoExit",
          "-Command",
          NAV_PROMPT,
        ]);
      } catch (e) {
        navTerm?.write(`\x1b[31mNavigator failed to start: ${e}\x1b[0m\r\n`);
      }
    });
  }

  function stopNav(): void {
    if (navId) {
      navSinks.delete(navId);
      void killPty(navId);
      navId = null;
    }
    navTerm?.dispose();
    navTerm = null;
    navHost.replaceChildren();
  }

  // ---- open/close/start ----
  function open(defaultName: string): void {
    openState = true;
    nameInput.value = "";
    nameInput.placeholder = defaultName;
    pathInput.value = "";
    setCount(3);
    preset = 0;
    chipEls.forEach((c, j) => c.classList.toggle("selected", j === 0));
    customInput.classList.remove("visible");
    customInput.value = "";
    el.classList.add("visible");
    void startNav();
    requestAnimationFrame(() => nameInput.focus());
  }

  function close(): void {
    if (!openState) return;
    openState = false;
    el.classList.remove("visible");
    stopNav();
  }

  function start(): void {
    const p = PRESETS[preset];
    const command = p.cmd === "__custom__" ? customInput.value.trim() || null : p.cmd;
    const result: WizardResult = {
      name: nameInput.value.trim() || nameInput.placeholder,
      count,
      cwd: pathInput.value.trim() || null,
      command,
    };
    close();
    onCreate(result);
  }

  cancelBtn.addEventListener("click", close);
  startBtn.addEventListener("click", start);
  el.addEventListener("click", (e) => {
    if (e.target === el) close();
  });

  // ---- keyboard navigation ----
  // The vertical (↑/↓) traversal order through every focusable control.
  // The selected chip stands in for the whole chip group; the custom-command
  // input only participates while it is visible.
  function vertStops(): HTMLElement[] {
    const list: HTMLElement[] = [nameInput, stepper, pathInput, browseBtn, chipEls[preset]];
    if (customInput.classList.contains("visible")) list.push(customInput);
    list.push(cancelBtn, startBtn);
    return list;
  }

  function focusStop(elm: HTMLElement): void {
    elm.focus();
    if (elm instanceof HTMLInputElement) elm.select();
  }

  function moveVert(dir: 1 | -1): void {
    const list = vertStops();
    const active = document.activeElement as HTMLElement | null;
    let idx = active ? list.indexOf(active) : -1;
    // A focused chip that isn't the selected one still maps onto the chip stop.
    if (idx === -1 && active?.classList.contains("chip")) idx = list.indexOf(chipEls[preset]);
    if (idx === -1) idx = 0;
    idx = Math.max(0, Math.min(list.length - 1, idx + dir));
    focusStop(list[idx]);
  }

  function selectChip(i: number): void {
    preset = ((i % chipEls.length) + chipEls.length) % chipEls.length;
    chipEls.forEach((c, j) => c.classList.toggle("selected", j === preset));
    const p = PRESETS[preset];
    customInput.classList.toggle("visible", p.cmd === "__custom__");
    chipEls[preset].focus();
  }

  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      close();
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    const inNav = navHost.contains(active);

    // Inside the navigator terminal, let it own every key; Ctrl+Enter still starts.
    if (inNav) {
      if (e.key === "Enter" && e.ctrlKey) start();
      return;
    }

    // Vertical movement between every field/button.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveVert(e.key === "ArrowDown" ? 1 : -1);
      return;
    }

    // Horizontal movement acts within the focused control.
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const dir = e.key === "ArrowRight" ? 1 : -1;
      if (active === stepper) {
        e.preventDefault();
        setCount(count + dir);
        return;
      }
      if (active?.classList.contains("chip")) {
        e.preventDefault();
        selectChip(preset + dir);
        return;
      }
      if (active === cancelBtn || active === startBtn) {
        e.preventDefault();
        focusStop(active === cancelBtn ? startBtn : cancelBtn);
        return;
      }
      // Text inputs keep native caret editing.
      return;
    }

    if (e.key === "Enter") {
      // Action buttons run their own click; everything else starts the session.
      if (active === cancelBtn) {
        close();
        return;
      }
      if (active === browseBtn) {
        browseBtn.click();
        return;
      }
      start();
    }
  });

  return { el, open, close, isOpen: () => openState };
}
