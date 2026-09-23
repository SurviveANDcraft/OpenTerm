import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./usage.css";
import "./searchModal.css";
import "./tasks.css";
import "./gitMap.css";
import { invoke } from "@tauri-apps/api/core";
import { store } from "./store";
import { applyTheme } from "./themes";
import { agentBrand } from "./paneIcons";
import {
  ACTIONS,
  Action,
  AGENT_HARNESS,
  applyResumePreference,
  buildSessionResumeCommand,
  DELEGATION_AGENTS,
  DEFAULT_SETTINGS,
  DelegationAgent,
  DelegationTrigger,
  detectAgentCommand,
  Dir,
  isTaskDone,
  LeafNode,
  PaneNode,
  PANE_KINDS,
  SESSION_COLORS,
  Session,
  sessionTasks,
  stripResumeCommand,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  Task,
  uid,
} from "./types";
import { agentCommand, agentLabel, buildDelegationPrompt, enhancePrompt } from "./delegate";
import {
  collectLeaves,
  findLeaf,
  pruneExternalLeaves,
  removeLeaf,
  resizeLeaf,
  splitLeaf,
  swapLeaves,
} from "./tree";
import {
  clearHints,
  DropRegion,
  dropRegion,
  PaneTerm,
  panes,
  resolveDrop,
  setHint,
  syncPaneThemes,
} from "./terminals";
import {
  embedExternalWindow,
  ExternalPane,
  externalPanes,
  releaseEmbeddedWindow,
  syncAllExternal,
} from "./external";
import {
  browserContextBlock,
  browserPanes,
  initBrowserEvents,
  PaneBrowser,
  pasteIntoTerminal,
  setBrowserOverlaysOpen,
  syncAllBrowsers,
} from "./browserPanes";
import { applyFold, applyZoom, renderSession, setFoldGapHandler, syncSizes } from "./layout";
import { listen } from "@tauri-apps/api/event";
import { onPtyExit, onPtyOutput, paneLastSession, writePty } from "./pty";
import {
  feedPaneOutput,
  isPaneErrored,
  isPaneWaiting,
  isPaneWorking,
  onAttentionChange,
  paneSubagentCount,
  setPaneScreenReader,
} from "./attention";
import { isShellPrompt, notifyPaneOutput, queueCommand } from "./commandQueue";
import { WizardResult, createWizard, navSinks } from "./wizard";
import {
  OnboardingOutcome,
  onboardingForcedByUrl,
  runOnboarding,
  shouldRunOnboarding,
} from "./onboarding";
import { actionForChord, cancelRecording, chordFromEvent, prettyChord, recorder } from "./keybinds";
import { createSidebar, type SessionStatus } from "./sidebar";
import { BackupInfo, createSettingsView } from "./settings";
import { syncDictation } from "./dictation/settingsTab";
import { createSessionSettings } from "./sessionSettings";
import { createConfirm } from "./confirm";
import { checkForUpdate, createUpdatePopup, onUpdateState } from "./updater";
import { createUsagePanel } from "./usagePanel";
import { createGitMapPanel } from "./gitMapPanel";
import { createTasksPanel, OpenPaneInfo } from "./tasksPanel";
import { createInboxPanel } from "./inboxPanel";
import {
  addInboxItem,
  clearGithubInboxItem,
  clearHarnessInboxItem,
  findGithubInboxItem,
  findHarnessInboxItem,
  InboxItem,
  patchInboxItem,
  setInboxKindFilter,
} from "./inbox";
import { HarnessStatus, onHarnessState, runHarnessCheck, updateHarness } from "./harnessUpdates";
import { startInboxAi } from "./inboxAi";
import { trash } from "./trash";
import { createTrashToast } from "./trashToast";
import { buildGithubReviewPrompt, checkGithubStatus, GitStatusResult } from "./git";
import { fetchLivePaneHarnesses, forgetPaneUsage } from "./usage";
import { createFileViewerPanel } from "./editor";
import {
  PaneFile,
  filePanes,
  materializeIn,
  morphSurface,
  rectOf,
  settleIn,
  type Rect,
} from "./filePanes";
import { createSearchModal } from "./searchModal";
import { createTitlebar } from "./titlebar";
import { quotePathForShell } from "./explorer";
import { initExternalFileDrop } from "./externalDrop";
import {
  folderKey,
  folderLabel,
  onOpenFolder,
  syncShellIntegration,
  takeLaunchFolder,
} from "./folderLaunch";

/** Ceiling on how much of a terminal's tail can be handed over on an Alt+drag
 *  context drop. The actual amount used is min(this, the pane's scrollback
 *  setting) — see sendPaneContext() — so a long agent session isn't silently
 *  clipped to a few hundred lines while its scrollback buffer holds far more. */
const CONTEXT_MAX_LINES = 20000;
const AGENT_INSTALLERS: Record<string, { provider: string; command: string }> = {
  grok: {
    provider: "xAI",
    command: "irm https://x.ai/cli/install.ps1 | iex; if ($?) { grok }",
  },
  "cursor-agent": {
    provider: "Cursor",
    command: "irm 'https://cursor.com/install?win32=true' | iex; if ($?) { cursor-agent }",
  },
};

// ---------------------------------------------------------------- DOM shell

const root = document.getElementById("app")!;
root.className = "app";

const titlebar = createTitlebar();

const appBody = document.createElement("div");
appBody.className = "app-body";

const main = document.createElement("main");
main.className = "main";

const viewsEl = document.createElement("div");
viewsEl.className = "views";

const emptyEl = document.createElement("div");
emptyEl.className = "empty-state";

const cheatEl = document.createElement("div");
cheatEl.className = "cheatsheet";

const sidebarResizer = document.createElement("div");
sidebarResizer.className = "sidebar-resizer";

let settingsOpen = false;
let fileViewerOpen = false;
let openFileName = "";
let openFilePath = "";
const sessionViews = new Map<string, HTMLElement>();
const focusedPane = new Map<string, string>(); // sessionId -> paneId
const attentionSessions = new Map<string, SessionStatus>(); // session id -> sidebar dot state
const sessionSubagents = new Map<string, number>(); // session id -> sub-agents in flight under it

// "Finished" inbox items — best-effort detection of a long-running command (or
// agent CLI turn) wrapping up in a pane, based on output going quiet after a
// sustained busy stretch. Not shell-integration-accurate, just a heuristic.
const paneBusySince = new Map<string, number>();
const paneQuietTimers = new Map<string, number>();
const notifiedTaskIds = new Set<string>(); // task ids already surfaced as due/overdue
const FINISH_QUIET_MS = 2500;
const FINISH_MIN_BUSY_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- delegation

/** Delegations waiting on "when a terminal finishes": pane id → callbacks, fired
 *  from the same quiet-after-busy detector that powers "finished" inbox items. */
const paneFinishListeners = new Map<string, Set<() => void>>();
/** Live setTimeout handles for `at`-triggered delegations, keyed by delegation id. */
const delegationTimers = new Map<string, number>();
/** Registered pane-finish callbacks per delegation, so cancel can unhook them. */
const delegationWatchers = new Map<string, { paneId: string; fn: () => void }>();

// ---------------------------------------------------------------- helpers

/** Refreshes the sidebar and the custom titlebar together — both render the
 *  same thing (which session is active, what it's called). */
function updateChrome(): void {
  sidebar.update(settingsOpen, attentionSessions, sessionSubagents);
  titlebar.refresh();
}

function activeSession(): Session | undefined {
  return store.state.sessions.find((s) => s.id === store.state.activeSessionId);
}

function sessionOfPane(paneId: string): Session | undefined {
  return store.state.sessions.find((s) => collectLeaves(s.tree).includes(paneId));
}

function paneAgentName(id: string, session: Session): string | null {
  const leaf = findLeaf(session.tree, id);
  const cmd = leaf && leaf.type === "leaf" ? leaf.lastCommand : undefined;
  return cmd ? detectAgentCommand(cmd) : null;
}

function forgetPaneActivity(id: string): void {
  paneBusySince.delete(id);
  const t = paneQuietTimers.get(id);
  if (t !== undefined) window.clearTimeout(t);
  paneQuietTimers.delete(id);
  cancelPaneFinishWatchers(id);
}

/** A watched terminal went quiet (or was closed before it could finish) — every
 *  delegation waiting on it resolves now. */
function firePaneFinish(paneId: string, cancelled: boolean): void {
  const listeners = paneFinishListeners.get(paneId);
  if (!listeners?.size) return;
  paneFinishListeners.delete(paneId);
  for (const fn of listeners) fn();
  if (!cancelled) return;
  // The watched pane vanished without finishing: surface the delegations as
  // cancelled so the user knows the trigger will never fire.
  for (const s of store.state.sessions) {
    for (const task of sessionTasks(s)) {
      const d = task.delegation;
      if (
        d &&
        d.status === "waiting" &&
        d.trigger.type === "pane-finish" &&
        d.trigger.paneId === paneId
      ) {
        d.status = "cancelled";
        addInboxItem({
          kind: "delegation",
          message: `Delegation cancelled — “${d.trigger.label}” closed before finishing`,
          sessionId: s.id,
          sessionName: s.name,
          taskId: task.id,
        });
      }
    }
  }
  store.save();
  tasksPanel.refresh();
}

/** Registers `fn` to fire once the given pane's output goes quiet. */
function watchPaneFinish(paneId: string, fn: () => void): void {
  let set = paneFinishListeners.get(paneId);
  if (!set) {
    set = new Set();
    paneFinishListeners.set(paneId, set);
  }
  set.add(fn);
}

/** Called when a pane is closed by any means: resolve its watchers as cancelled. */
function cancelPaneFinishWatchers(paneId: string): void {
  if (paneFinishListeners.has(paneId)) firePaneFinish(paneId, true);
}

/** True while a leaf with this id exists in any session's tree. */
function paneExists(paneId: string): boolean {
  return store.state.sessions.some((s) => collectLeaves(s.tree).includes(paneId));
}

/** Drops any armed timer/watcher for a delegation without touching its status. */
function disarmDelegation(task: Task): void {
  const d = task.delegation;
  if (!d) return;
  const timer = delegationTimers.get(d.id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    delegationTimers.delete(d.id);
  }
  const watcher = delegationWatchers.get(d.id);
  if (watcher !== undefined) {
    const set = paneFinishListeners.get(watcher.paneId);
    set?.delete(watcher.fn);
    if (set && set.size === 0) paneFinishListeners.delete(watcher.paneId);
    delegationWatchers.delete(d.id);
  }
}

/** Arms a freshly created delegation according to its trigger. */
function armDelegation(session: Session, task: Task): void {
  const d = task.delegation;
  if (!d) return;
  if (d.trigger.type === "now") {
    // Covers the boot path too: a "start now" delegation the app missed while
    // closed simply fires on the next launch.
    void runDelegation(session, task);
  } else if (d.trigger.type === "at") {
    const ms = Math.max(0, d.trigger.time - Date.now());
    const handle = window.setTimeout(() => {
      delegationTimers.delete(d.id);
      void runDelegation(session, task);
    }, ms);
    delegationTimers.set(d.id, handle);
  } else if (d.trigger.type === "pane-finish") {
    if (!paneExists(d.trigger.paneId)) {
      d.status = "cancelled";
      addInboxItem({
        kind: "delegation",
        message: "Delegation cancelled — the terminal it was waiting on is gone",
        sessionId: session.id,
        sessionName: session.name,
        taskId: task.id,
      });
      store.save();
      tasksPanel.refresh();
      return;
    }
    d.status = "waiting";
    const fn = (): void => {
      delegationWatchers.delete(d.id);
      void runDelegation(session, task);
    };
    delegationWatchers.set(d.id, { paneId: d.trigger.paneId, fn });
    watchPaneFinish(d.trigger.paneId, fn);
  }
}

/** User-initiated cancel from the task panel. */
function cancelDelegation(session: Session, task: Task): void {
  const d = task.delegation;
  if (!d) return;
  disarmDelegation(task);
  d.status = "cancelled";
  store.save();
  tasksPanel.refresh();
}

/** Creates (or replaces) a delegation and arms it. */
function delegateTask(
  session: Session,
  task: Task,
  agent: DelegationAgent,
  trigger: DelegationTrigger
): void {
  disarmDelegation(task);
  task.delegation = {
    id: uid(),
    agent,
    trigger,
    status: "scheduled",
    createdAt: Date.now(),
  };
  armDelegation(session, task);
  store.save();
  tasksPanel.refresh();
}

/** Animated overlay shown on a delegation's pane while the prompt is being
 *  refined and the agent CLI boots — covers the ugly "shell + typed command"
 *  boot sequence so the pane just looks like it's thinking. */
function showDelegationLoading(paneId: string, agentLabel: string, enhancing: boolean): HTMLElement {
  const term = panes.get(paneId);
  if (!term) return document.createElement("div");
  const ov = document.createElement("div");
  ov.className = "deleg-loading";
  ov.innerHTML = `
    <div class="deleg-loading-core">
      <div class="deleg-loading-ring"></div>
      <svg class="deleg-loading-icon" viewBox="0 0 14 14">
        <rect x="2.5" y="4.5" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.1"/>
        <line x1="7" y1="4.5" x2="7" y2="2.4" stroke="currentColor" stroke-width="1.1"/>
        <circle cx="7" cy="1.8" r="1" fill="currentColor"/>
        <circle cx="5.2" cy="7.6" r="0.9" fill="currentColor"/>
        <circle cx="8.8" cy="7.6" r="0.9" fill="currentColor"/>
      </svg>
    </div>
    <div class="deleg-loading-title">${enhancing ? "Refining prompt…" : "Preparing task…"}</div>
    <div class="deleg-loading-sub">${enhancing ? "DeepSeek is clarifying this task" : "Handing off to " + agentLabel}</div>
    <div class="deleg-loading-scan"></div>`;
  term.el.appendChild(ov);
  return ov;
}

/** Resolves once a freshly launched agent CLI looks idle at its composer: some
 *  output has appeared and then stopped changing for a beat. Beats a fixed sleep —
 *  a cold `codex`/`claude` can take many seconds, and pasting into a CLI that
 *  hasn't drawn its input yet drops the text on the floor. Resolves false on
 *  timeout (we paste anyway) or if the pane disappears. */
async function waitForAgentReady(paneId: string, timeoutMs = 20000): Promise<boolean> {
  /** Never paste sooner than this, however quiet the pane looks — the shell's
   *  echo of the typed command counts as "output" and would otherwise pass for
   *  a booted CLI. */
  const minMs = 2500;
  /** How long output must hold still before we call the composer ready. */
  const stableMs = 1200;

  const term = panes.get(paneId);
  if (!term) return false;
  const started = Date.now();
  let last = term.snapshotText(60);
  let stableSince = Date.now();
  // The echo is one change; the CLI drawing its UI is another. Requiring two
  // keeps us from mistaking the echo alone for a ready agent.
  let changes = 0;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    if (!panes.has(paneId)) return false;
    const now = term.snapshotText(60);
    if (now !== last) {
      last = now;
      stableSince = Date.now();
      changes++;
      continue;
    }
    if (changes >= 2 && Date.now() - started >= minMs && Date.now() - stableSince >= stableMs)
      return true;
  }
  return false;
}

/** Kicks off an armed delegation: clarify the prompt via OpenRouter (best-effort),
 *  then spawn a new terminal in the task's own session and type the agent CLI +
 *  the final prompt into it — exactly like a user would have typed them. */
async function runDelegation(session: Session, task: Task): Promise<void> {
  const d = task.delegation;
  if (!d || d.status === "running" || d.status === "done") return;

  const agentDef = DELEGATION_AGENTS.find((a) => a.id === d.agent);
  if (!agentDef) return;
  const rawPrompt = buildDelegationPrompt(task);

  d.status = "running";
  d.startedAt = Date.now();
  store.save();
  tasksPanel.refresh();

  // Spawn the agent pane beside whatever is focused (or the first leaf) right
  // away — the loading overlay covers its boot sequence while the prompt is
  // being refined in parallel, so neither step stalls the other.
  const anchorId = focusedPane.get(session.id) ?? collectLeaves(session.tree)[0];
  if (!anchorId || !sessionTasks(session).includes(task)) {
    d.status = "failed";
    store.save();
    tasksPanel.refresh();
    return;
  }
  const newId = uid();
  createPaneTerm(newId);
  session.tree = splitLeaf(session.tree, anchorId, "row", newId);
  session.zoomed = null;
  // `lastCommand` is deliberately left unset until the command has actually been
  // typed below: rerender()'s spawn pass replays lastCommand into a new pane, so
  // setting it here made the agent CLI launch twice — once from the replay and
  // once from this function — and the second `codex`/`claude` landed inside the
  // first one's composer as a junk first message.
  rerender(session);
  requestAnimationFrame(() => focusPane(newId));

  const key = store.state.settings.openrouterApiKey.trim();
  const loading = showDelegationLoading(newId, agentDef.label, !!key);
  const fail = (): void => {
    loading.remove();
    d.status = "failed";
    store.save();
    tasksPanel.refresh();
  };

  // Prompt enhancement runs alongside the shell boot (~700ms ConPTY delay).
  // The overlay stays up the whole time — through refinement, CLI boot, paste
  // and submit — and only lifts once the refined prompt is actually in.
  let prompt = rawPrompt;
  let enhanced = false;
  /** Shown on the overlay when refinement was attempted and didn't work, so the
   *  failure is visible in the pane instead of only in the inbox. */
  let failureNote = "";
  if (!key) {
    failureNote = "No OpenRouter key — delegating as written";
    addInboxItem({
      kind: "delegation",
      message: "No OpenRouter key set — task delegated as written (add one in Settings → AI sessions)",
      sessionId: session.id,
      sessionName: session.name,
      taskId: task.id,
    });
  } else {
    try {
      try {
        prompt = await enhancePrompt(rawPrompt, key);
      } catch (first) {
        // One retry: a cold connection or a transient OpenRouter 5xx shouldn't
        // cost the user their refined prompt.
        console.warn("Prompt enhancement failed, retrying once:", first);
        await new Promise((r) => setTimeout(r, 800));
        prompt = await enhancePrompt(rawPrompt, key);
      }
      enhanced = true;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("Prompt enhancement failed:", e);
      failureNote = `Refinement failed: ${detail}`;
      addInboxItem({
        kind: "delegation",
        message: `Prompt refinement failed (${detail}) — delegating as-is`,
        sessionId: session.id,
        sessionName: session.name,
        taskId: task.id,
      });
    }
  }
  const titleEl = loading.querySelector<HTMLElement>(".deleg-loading-title");
  const subEl = loading.querySelector<HTMLElement>(".deleg-loading-sub");
  if (titleEl) titleEl.textContent = `Launching ${agentDef.label}…`;
  if (subEl)
    subEl.textContent = enhanced
      ? "Prompt refined — starting the agent"
      : failureNote
        ? failureNote
        : "Starting the agent";

  // Make sure the PTY exists before typing at it. ensureSpawned is idempotent
  // and flips its `spawned` flag synchronously, so awaiting it here also stops
  // any later rerender pass from replaying a command into this pane.
  const term = panes.get(newId);
  if (!term) return fail();
  await term.ensureSpawned(store.state.settings.shell, session.cwd ?? null, null);
  await new Promise((r) => setTimeout(r, 700));
  if (!panes.has(newId)) return fail();
  void writePty(newId, `${agentCommand(d.agent)}\r`);
  // Only now is it safe to remember the launch for restart/resume.
  const leaf = findLeaf(session.tree, newId) as LeafNode | undefined;
  if (leaf) leaf.lastCommand = agentDef.command;
  claimPaneAgent(newId, agentDef.command);

  // Wait for the CLI to actually reach its composer, then paste the task via
  // bracketed paste so multi-line text isn't submitted line-by-line. The Enter
  // goes as a separate write a beat later — same-tick paste+Enter can get merged
  // by ConPTY and arrive before the composer is ready to accept it.
  await waitForAgentReady(newId);
  if (!panes.has(newId)) return fail();
  if (titleEl) titleEl.textContent = "Handing off…";
  if (subEl) subEl.textContent = "Typing the task into the agent";
  void writePty(newId, `\x1b[200~${prompt.replace(/\r/g, "")}\x1b[201~`);
  await new Promise((r) => setTimeout(r, 400));
  if (!panes.has(newId)) return fail();
  void writePty(newId, "\r");

  // Let the submitted prompt visibly land before lifting the overlay, so the
  // first thing the user sees is the agent receiving the refined task.
  await new Promise((r) => setTimeout(r, 700));
  loading.remove();

  d.targetPaneId = newId;
  store.save(true);
  tasksPanel.refresh();
  addInboxItem({
    kind: "delegation",
    message: `${enhanced ? "Refined & d" : "D"}elegated “${task.title || "Untitled task"}” to ${agentLabel(d.agent)} in ${session.name}`,
    sessionId: session.id,
    sessionName: session.name,
    taskId: task.id,
    paneId: newId,
  });
}

// ------------------------------------------------------------- GitHub sync

/** How often each session with a GitHub-linked cwd gets re-checked for
 *  incoming commits it doesn't have yet. */
const GITHUB_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Checks every session's working directory against its GitHub remote and
 *  raises (or clears) a "github-outdated" inbox item per repo. Multiple
 *  sessions pointed at the same repo only produce one item — the first
 *  session found wins and is what "Review with AI" opens a pane in. Runs on
 *  a timer from boot, independent of which session is active, so the
 *  notification shows up in the inbox regardless of what's currently open. */
async function checkAllSessionsGithubStatus(): Promise<void> {
  const seenRepos = new Set<string>();
  for (const session of store.state.sessions) {
    const cwd = session.cwd?.trim();
    if (!cwd) continue;
    const status = await checkGithubStatus(cwd);
    if (!status || seenRepos.has(status.repoRoot)) {
      continue;
    }
    seenRepos.add(status.repoRoot);
    if (status.behind > 0) {
      const existing = findGithubInboxItem(status.repoRoot);
      if (existing) {
        // Update counts in place rather than piling up duplicate items.
        existing.repoAhead = status.ahead;
        existing.repoBehind = status.behind;
        existing.message = `${status.behind} new commit${status.behind === 1 ? "" : "s"} on GitHub (${status.branch}) not pulled yet`;
        existing.summary = existing.message;
        existing.createdAt = Date.now();
      } else {
        addInboxItem({
          kind: "github-outdated",
          message: `${status.behind} new commit${status.behind === 1 ? "" : "s"} on GitHub (${status.branch}) not pulled yet`,
          sessionId: session.id,
          sessionName: session.name,
          repoRoot: status.repoRoot,
          repoBranch: status.branch,
          repoAhead: status.ahead,
          repoBehind: status.behind,
        });
      }
    } else {
      // Caught back up — drop any stale warning for this repo.
      clearGithubInboxItem(status.repoRoot);
    }
  }
}

// -------------------------------------------------- Agent CLI (harness) updates

/** How often the installed agent CLIs are compared against their published
 *  releases. They ship far more often than OpenTerm does, but not so often
 *  that this is worth doing on a tight loop. */
const HARNESS_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Compares every installed agent CLI against its registry and raises (or
 *  refreshes, or clears) one "harness-update" inbox item per CLI.
 *
 *  Wired to `onHarnessState` rather than called directly, so a check the user
 *  kicks off by hand from Settings raises the same items a background one
 *  would — there is only one path from "result" to "notification". */
function applyHarnessResults(results: HarnessStatus[]): void {
  for (const h of results) {
    if (!h.outdated) {
      // Up to date — either it never was behind, or it was updated elsewhere.
      clearHarnessInboxItem(h.id);
      continue;
    }
    const message = `${h.label} ${h.latest} is out — you're running ${h.current}`;
    const existing = findHarnessInboxItem(h.id);
    if (existing) {
      // Refresh in place rather than stacking a second row for the same CLI.
      if (existing.harnessLatest === h.latest && existing.harnessCurrent === h.current) continue;
      patchInboxItem(existing.id, {
        message,
        summary: message,
        harnessCurrent: h.current,
        harnessLatest: h.latest,
        harnessState: undefined,
        createdAt: Date.now(),
      });
      continue;
    }
    addInboxItem({
      kind: "harness-update",
      message,
      title: `${h.label} update`,
      summary: message,
      harnessId: h.id,
      harnessLabel: h.label,
      harnessCurrent: h.current,
      harnessLatest: h.latest,
    });
  }
}

/** "Update now" on a harness-update item: runs the CLI's own updater (falling
 *  back to its package manager), then relaunches that CLI inside every pane
 *  already running it, so they pick up the new binary. Progress lives on the
 *  inbox item itself, so it survives the panel being closed and reopened
 *  mid-update. */
async function updateHarnessFromInbox(item: InboxItem): Promise<void> {
  const id = item.harnessId;
  if (!id || item.harnessState === "updating") return;
  const label = item.harnessLabel ?? id;
  patchInboxItem(item.id, {
    harnessState: "updating",
    summary: `Updating ${label} to ${item.harnessLatest ?? "the latest version"}…`,
  });

  // Close the CLI everywhere *first*. On Windows a running binary can't be
  // replaced — npm fails the whole install with EBUSY — so an update while the
  // agent is open in a pane is guaranteed to fail. This is also why the panes
  // are put back in a `finally`: having quit them, we owe the user a relaunch
  // whether or not the update itself worked.
  const targets = agentPanes(id);
  let stopped: AgentPane[] = [];
  let stuck = 0;
  if (targets.length > 0) {
    patchInboxItem(item.id, {
      summary: `Closing ${label} in ${targets.length} terminal${targets.length === 1 ? "" : "s"}…`,
    });
    const quit = await Promise.all(targets.map((t) => stopAgentInPane(t.paneId)));
    stopped = targets.filter((_, i) => quit[i]);
    stuck = quit.filter((q) => !q).length;
    // Windows holds the file lock a moment longer than the process itself.
    if (stopped.length > 0) await new Promise((r) => setTimeout(r, 800));
  }

  try {
    patchInboxItem(item.id, { summary: `Updating ${label}…` });
    const res = await updateHarness(id);
    if (!res.success) {
      patchInboxItem(item.id, {
        harnessState: "failed",
        summary: `${label} update failed (${res.command}): ${failureLine(res.output)}`,
      });
      return;
    }
    clearHarnessInboxItem(id);
    const version = res.version ?? item.harnessLatest ?? "the latest version";
    const parts: string[] = [];
    if (stopped.length > 0)
      parts.push(`restarted it in ${stopped.length} terminal${stopped.length === 1 ? "" : "s"}`);
    if (stuck > 0)
      parts.push(
        `${stuck} terminal${stuck === 1 ? " wouldn't" : "s wouldn't"} quit — restart there by hand`
      );
    const note = parts.length ? ` — ${parts.join("; ")}` : "";
    // Refresh the shared state so Settings stops showing the old version.
    void runHarnessCheck();
    addInboxItem({
      kind: "harness-update",
      title: `${label} updated`,
      message: `${label} is now on ${version}${note}`,
      summary: `${label} is now on ${version}${note}`,
    });
  } catch (e) {
    patchInboxItem(item.id, {
      harnessState: "failed",
      summary: `${label} update failed: ${String(e)}`,
    });
  } finally {
    // Put every agent we closed back, even on failure — otherwise a failed
    // update silently leaves the user's sessions sitting at a bare shell.
    await Promise.all(stopped.map((t) => relaunchAgentInPane(t.paneId, t.command)));
  }
}

/** The line of a failed command's output actually worth showing.
 *
 *  Not simply the last line: npm always ends with "A complete log of this run
 *  can be found in: …", which tells the user nothing. Skipping npm's
 *  field-by-field preamble (`npm error path/dest/errno/syscall/code`) leaves
 *  the sentence that names the real problem. Long paths get trimmed off the
 *  end — the code and the description are at the front. */
function failureLine(output: string): string {
  const noise = /^npm (error|warn) (path|dest|errno|syscall|code|A complete log)\b|complete log of this run/i;
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !noise.test(l));
  const line = lines[lines.length - 1] ?? "no output";
  const hint = /EBUSY|EPERM|resource busy or locked/i.test(output)
    ? " (the CLI was still running — close it everywhere, including outside OpenTerm, and retry)"
    : "";
  return (line.length > 220 ? `${line.slice(0, 220)}…` : line) + hint;
}

interface AgentPane {
  paneId: string;
  /** The line that launched the agent, replayed (with resume flags) to bring
   *  the same conversation back. */
  command: string;
}

/** Every live pane currently running this agent CLI. */
function agentPanes(harnessId: string): AgentPane[] {
  const out: AgentPane[] = [];
  for (const session of store.state.sessions) {
    for (const paneId of collectLeaves(session.tree)) {
      const leaf = findLeaf(session.tree, paneId) as LeafNode | undefined;
      if (!leaf || leaf.external || leaf.kind === "browser" || !leaf.lastCommand) continue;
      if (detectAgentCommand(leaf.lastCommand) !== harnessId) continue;
      if (!panes.get(paneId)?.started) continue;
      out.push({ paneId, command: leaf.lastCommand });
    }
  }
  return out;
}

/** Quits the agent CLI running in a pane, leaving the pane itself at its shell
 *  prompt. Returns false if it wouldn't quit inside the timeout.
 *
 *  Deliberately not a pane teardown. Killing the PTY and rebuilding the leaf
 *  loses the scrollback, fires a "process exited" notification for every pane,
 *  and leaves the user staring at panes that vanished — the terminal is not
 *  what's out of date, only the program running in it. */
async function stopAgentInPane(paneId: string): Promise<boolean> {
  if (!panes.get(paneId)?.started) return false;

  // Two interrupts, spaced out: agent CLIs read the first as "cancel what
  // you're doing" and only a second one as "quit".
  void writePty(paneId, "\x03");
  await new Promise((r) => setTimeout(r, 600));
  if (!panes.has(paneId)) return false;
  if (!isShellPrompt(paneId)) {
    void writePty(paneId, "\x03");
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!panes.has(paneId)) return false;
    if (isShellPrompt(paneId)) return true;
  }
  return false;
}

/** Types the agent's launch command back into a pane that's sitting at its
 *  shell prompt, resuming the conversation it was in. */
async function relaunchAgentInPane(paneId: string, launchCommand: string): Promise<void> {
  if (!panes.has(paneId)) return;
  const cmd = (await resumeCommandFor(paneId, launchCommand)) ?? launchCommand;
  if (!panes.has(paneId)) return;
  // Newline separately, same reason as the command queue: a burst read in one
  // tick can swallow the submit.
  void writePty(paneId, cmd);
  await new Promise((r) => setTimeout(r, 80));
  void writePty(paneId, "\r");
}

/** "Review with AI" on a github-outdated inbox item: opens `agent` in a new
 *  pane of the item's session and hands it a prompt describing exactly what
 *  was found, instructing it to explain the situation and get the user's
 *  explicit go-ahead before running anything beyond read-only inspection. */
async function reviewGithubWithAgent(item: InboxItem, agent: DelegationAgent): Promise<void> {
  const session = item.sessionId ? store.state.sessions.find((s) => s.id === item.sessionId) : undefined;
  if (!session || !item.repoRoot) return;

  const agentDef = DELEGATION_AGENTS.find((a) => a.id === agent);
  if (!agentDef) return;

  // Re-check right before handing off — counts can be minutes stale by the
  // time the user actually clicks the button. Falls back to the item's
  // snapshot if the recheck fails (e.g. offline).
  const fresh = await checkGithubStatus(session.cwd ?? item.repoRoot);
  const status: GitStatusResult =
    fresh ??
    ({
      repoRoot: item.repoRoot,
      branch: item.repoBranch ?? "",
      remoteUrl: "",
      ahead: item.repoAhead ?? 0,
      behind: item.repoBehind ?? 0,
      dirty: false,
    } satisfies GitStatusResult);
  const prompt = buildGithubReviewPrompt(status);

  const anchorId = focusedPane.get(session.id) ?? collectLeaves(session.tree)[0];
  if (!anchorId) return;
  const newId = uid();
  createPaneTerm(newId);
  session.tree = splitLeaf(session.tree, anchorId, "row", newId);
  session.zoomed = null;
  rerender(session);
  requestAnimationFrame(() => focusPane(newId));

  const loading = showDelegationLoading(newId, agentDef.label, false);
  const fail = (): void => loading.remove();

  const term = panes.get(newId);
  if (!term) return fail();
  await term.ensureSpawned(store.state.settings.shell, session.cwd ?? null, null);
  await new Promise((r) => setTimeout(r, 700));
  if (!panes.has(newId)) return fail();
  void writePty(newId, `${agentCommand(agent)}\r`);
  const leaf = findLeaf(session.tree, newId) as LeafNode | undefined;
  if (leaf) leaf.lastCommand = agentDef.command;
  claimPaneAgent(newId, agentDef.command);

  await waitForAgentReady(newId);
  if (!panes.has(newId)) return fail();
  void writePty(newId, `\x1b[200~${prompt.replace(/\r/g, "")}\x1b[201~`);
  await new Promise((r) => setTimeout(r, 400));
  if (!panes.has(newId)) return fail();
  void writePty(newId, "\r");

  await new Promise((r) => setTimeout(r, 700));
  loading.remove();
  store.save(true);
}

/** Feeds fresh PTY output into the busy/quiet tracker: a pane counts as "busy"
 *  from its first byte until output stops for FINISH_QUIET_MS. If that busy
 *  stretch was long enough and didn't already end in a prompt/error (which
 *  attention.ts covers with its own inbox item), surface a "finished" item. */
function trackPaneActivity(id: string): void {
  if (!paneBusySince.has(id)) paneBusySince.set(id, Date.now());
  const pending = paneQuietTimers.get(id);
  if (pending !== undefined) window.clearTimeout(pending);
  paneQuietTimers.set(
    id,
    window.setTimeout(() => {
      paneQuietTimers.delete(id);
      const since = paneBusySince.get(id);
      paneBusySince.delete(id);
      // Delegation watchers resolve on any quiet stretch — the 15-minute
      // "finished" bar below is deliberately stricter than this.
      if (paneFinishListeners.has(id)) firePaneFinish(id, false);
      if (since === undefined || Date.now() - since < FINISH_MIN_BUSY_MS) return;
      if (isPaneWaiting(id)) return; // already covered by an approval/error item
      const session = sessionOfPane(id);
      if (!session) return;
      const agent = paneAgentName(id, session);
      addInboxItem({
        kind: "finished",
        message: agent ? `${agent} finished responding` : "A long-running command finished",
        sessionId: session.id,
        sessionName: session.name,
        paneId: id,
      });
    }, FINISH_QUIET_MS)
  );
}

/** Scans every session's tasks for ones due today or overdue, surfacing each
 *  only once per app session (tracked in notifiedTaskIds) so it doesn't spam
 *  on every periodic re-check. */
function scanTaskDueDates(): void {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const s of store.state.sessions) {
    for (const t of sessionTasks(s)) {
      if (!t.dueDate || isTaskDone(s, t) || notifiedTaskIds.has(t.id)) continue;
      const [y, m, d] = t.dueDate.split("-").map(Number);
      const due = new Date(y, (m || 1) - 1, d || 1).getTime();
      if (due > today.getTime()) continue;
      notifiedTaskIds.add(t.id);
      addInboxItem({
        kind: "task-due",
        message:
          due < today.getTime()
            ? `"${t.title || "Untitled task"}" is overdue`
            : `"${t.title || "Untitled task"}" is due today`,
        sessionId: s.id,
        sessionName: s.name,
        taskId: t.id,
      });
    }
  }
}

function paneHandlers() {
  return {
    onFocus: (id: string) => {
      const s = sessionOfPane(id);
      if (!s) return;
      focusedPane.set(s.id, id);
      updateFocusRing();
    },
    onSplit: (id: string, dir: Dir, duplicate?: boolean) => splitPane(id, dir, duplicate),
    onClose: (id: string) => closePane(id),
    onMove: (src: string, target: string, region: DropRegion) => movePane(src, target, region),
    onSendContext: (src: string, target: string) => sendPaneContext(src, target),
    onToggleZoom: (id: string) => zoomPaneById(id),
    onToggleFold: (id: string) => foldPaneById(id),
    onCommandEntered: (id: string, line: string) => rememberAgentCommand(id, line),
    onShowUsage: (id: string, title: string) => void usagePanel.show(id, title),
    onQueueCommand: (id: string, command: string) => queueCommand(id, command),
    onOpenBrowser: (id: string, url: string) => openLinkInBrowserPane(id, url),
    onRename: (id: string, name: string) => renamePane(id, name),
    onCwdChange: (id: string, cwd: string) => rememberPaneCwd(id, cwd),
  };
}

/** Persists the folder a pane's shell is in, so a restart reopens it there. */
function rememberPaneCwd(paneId: string, cwd: string): void {
  const session = sessionOfPane(paneId);
  if (!session) return;
  const leaf = findLeaf(session.tree, paneId);
  if (!leaf || leaf.cwd === cwd) return;
  leaf.cwd = cwd;
  store.save();
}

/** For a restored pane whose shell never reported a folder (a shell that
 *  doesn't emit OSC 9;9/7): the folder its agent conversation was running in,
 *  when the backend linked it exactly. Resuming by id only works from there. */
async function agentCwdFor(paneId: string, lastCommand: string): Promise<string | null> {
  const agent = detectAgentCommand(lastCommand);
  const harness = agent ? AGENT_HARNESS[agent] : undefined;
  if (!harness) return null;
  const link = await paneLastSession(paneId, harness).catch(() => null);
  return link?.exact ? (link.cwd ?? null) : null;
}

/** Persists a pane's user-set custom name so it survives rerenders/restarts. */
function renamePane(paneId: string, name: string): void {
  const session = sessionOfPane(paneId);
  if (!session) return;
  const leaf = findLeaf(session.tree, paneId);
  if (!leaf) return;
  leaf.customName = name.trim() || undefined;
  store.save();
}

/** Alt+click on a link in a terminal: show it in an embedded browser pane.
 *  Reuses a browser pane already open in the session (the focused one when it
 *  is a browser, otherwise the first) so repeated clicks don't stack panes, and
 *  only splits off a new pane when the session has none. */
function openLinkInBrowserPane(paneId: string, url: string): void {
  const session = sessionOfPane(paneId);
  if (!session) return;

  const focused = focusedPane.get(session.id);
  const existing =
    focused && browserPanes.has(focused)
      ? focused
      : collectLeaves(session.tree).find((id) => browserPanes.has(id));
  if (existing) {
    browserPanes.get(existing)!.navigate(url);
    focusPane(existing);
    store.save(true);
    return;
  }

  const newId = uid();
  createPaneBrowser(newId, "", "");
  session.tree = splitLeaf(session.tree, paneId, "row", newId);
  session.zoomed = null;
  // Tag the leaf the tree actually inserted (splitLeaf makes its own object).
  const leaf = findLeaf(session.tree, newId) as LeafNode | undefined;
  if (leaf) leaf.kind = "browser";
  rerender(session);
  // Navigate only once the pane has real geometry — the child webview is
  // created at the pane's current rect.
  requestAnimationFrame(() => {
    browserPanes.get(newId)?.navigate(url);
    focusPane(newId);
  });
  store.save(true);
}

/** pane id → harness the Rust poller can currently see running in that pane,
 *  refreshed by pollLiveHarnesses(). */
let liveHarnesses: Record<string, string> = {};

/** Agent CLIs whose paste chord dictation knows about. */
const DICTATION_AGENTS = ["claude-code", "codex", "opencode"];

/** Syncs the two per-pane agent indicators from whichever agent is running in
 *  it: the brand mark in the title bar (every agent we ship a logo for) and the
 *  rate-limit pill (only Claude Code and Codex — the only harnesses with a usage
 *  endpoint wired up). A plain shell gets neither.
 *
 *  The live process tree is the primary signal, with the remembered launch
 *  command as a fallback for the gap between typing the command and the poller
 *  next sweeping. Going by the remembered command alone used to mean the pill
 *  never appeared at all unless the user hand-typed `claude` character by
 *  character: trackInput() drops its buffer on any control byte, so recalling
 *  the command with ↑, accepting a PSReadLine prediction with →/Tab, or pasting
 *  it (bracketed paste opens with ESC) all left lastCommand unset. */
function syncPaneAgentBadge(paneId: string, lastCommand: string | null | undefined): void {
  const pane = panes.get(paneId);
  if (!pane) return;
  const live = liveHarnesses[paneId] ?? null;
  // The typed command is only a *claim*, good until the poller can confirm or
  // deny it from the process tree. Past the grace window an unconfirmed claim
  // is dropped, so a pane whose agent exited (Ctrl+C, /exit, a crash) — or
  // whose command never started one — falls back to the shell mark instead of
  // wearing the agent's logo for the rest of the pane's life.
  const claimed = lastCommand ? detectAgentCommand(lastCommand) : null;
  const claimedAt = agentClaimAt.get(paneId);
  const agent = claimed && claimedAt != null && Date.now() - claimedAt < AGENT_CLAIM_GRACE_MS ? claimed : null;
  const harness = live ?? (agent ? AGENT_HARNESS[agent] : null);
  pane.setAgentHarness(harness === "claude-code" || harness === "codex" ? harness : null);
  // Dictation also knows opencode's paste chord, even where the badge doesn't
  // carry a mark for it.
  paneHarness.set(paneId, DICTATION_AGENTS.includes(harness ?? "") ? (harness as string) : "");
  publishFocusedAgent();
  // The mark resolves from the live harness id or, before the poller has seen
  // the process, from the typed command — agentBrand() accepts either spelling.
  pane.setAgentBrand(agentBrand(live) ?? agentBrand(agent));
}

/** pane id → when an agent-launching command was last typed or replayed there.
 *  Only these moments open the grace window above; a plain rerender re-syncs
 *  the badge without extending it. */
const agentClaimAt = new Map<string, number>();

/** How long a typed command is trusted before the process tree has to back it
 *  up. Two poller sweeps plus room for a slow agent start. */
const AGENT_CLAIM_GRACE_MS = 10_000;

/** Records that `command` was just launched in the pane and repaints its
 *  badges, so the mark appears immediately rather than at the next sweep. */
function claimPaneAgent(paneId: string, command: string | null | undefined): void {
  agentClaimAt.set(paneId, Date.now());
  syncPaneAgentBadge(paneId, command);
}

/** Matches the Rust poller's own 3s sweep — there is nothing fresher to read. */
const LIVE_HARNESS_POLL_MS = 3000;

async function pollLiveHarnesses(): Promise<void> {
  let live: Record<string, string>;
  try {
    live = await fetchLivePaneHarnesses();
  } catch {
    return; // transient; the next tick will pick it up
  }
  const keys = new Set([...Object.keys(live), ...Object.keys(liveHarnesses)]);
  const changed = new Set([...keys].filter((id) => live[id] !== liveHarnesses[id]));
  // A claim that just ran out needs a repaint too, even when the process tree
  // itself didn't move: nothing else would take the agent mark back off a pane
  // whose command was typed but never produced a process.
  const now = Date.now();
  for (const [id, at] of agentClaimAt) {
    if (live[id]) {
      // Confirmed by the process tree — the claim has done its job, and from
      // here on the poller alone decides what this pane is running.
      agentClaimAt.delete(id);
    } else if (now - at >= AGENT_CLAIM_GRACE_MS) {
      agentClaimAt.delete(id);
      changed.add(id);
    }
  }
  if (changed.size === 0) return;
  liveHarnesses = live;
  for (const id of changed) {
    const session = sessionOfPane(id);
    const leaf = session ? findLeaf(session.tree, id) : null;
    syncPaneAgentBadge(id, leaf?.type === "leaf" ? leaf.lastCommand : null);
  }
}

/** Recomputes every session's sidebar dot from its panes, repainting only if
 *  something actually moved.
 *
 *  "running" comes from attention.ts's mid-turn detection, NOT from the
 *  busy/quiet tracker that feeds the "finished" inbox items. That tracker flips
 *  on any byte at all, so keying the dot on it lit the spinner for every echoed
 *  keystroke and prompt redraw — work was never happening, the terminal was
 *  just drawing.
 *
 *  Precedence is worst-first: an error outranks a question, which outranks work
 *  in progress, so a session never reports "running" while something in it is
 *  actually stuck or broken.
 *
 *  Sub-agents sit just above plain "running": a harness with background agents
 *  in flight is usually mid-turn itself as well, and the fanned-out work is the
 *  more informative of the two — so the blue dot wins over the green one while
 *  any pane in the session has sub-agents. It still loses to a question or a
 *  failure, which are the states that actually want you. */
function refreshSessionStatus(): void {
  let changed = false;
  const seen = new Set<string>();

  for (const s of store.state.sessions) {
    const panes = collectLeaves(s.tree);
    let subs = 0;
    for (const id of panes) subs += paneSubagentCount(id);

    let next: SessionStatus | undefined;
    if (panes.some((id) => isPaneErrored(id))) next = "error";
    else if (panes.some((id) => isPaneWaiting(id))) next = "waiting";
    else if (subs > 0) next = "subagents";
    else if (panes.some((id) => isPaneWorking(id))) next = "running";

    // The count only rides along for the tooltip, so a change in it repaints
    // only while the blue dot is the one actually showing.
    if (subs > 0) {
      if (sessionSubagents.get(s.id) !== subs) {
        sessionSubagents.set(s.id, subs);
        if (next === "subagents") changed = true;
      }
    } else if (sessionSubagents.delete(s.id)) {
      changed = true;
    }

    if (next) {
      seen.add(s.id);
      if (attentionSessions.get(s.id) !== next) {
        attentionSessions.set(s.id, next);
        changed = true;
      }
    }
  }

  for (const id of [...attentionSessions.keys()]) {
    if (!seen.has(id)) {
      attentionSessions.delete(id);
      changed = true;
    }
  }

  if (changed) updateChrome();
}

/** Remembers a typed command as the pane's resume command if it launches a
 *  known AI agent CLI, so relaunching the app can replay it in that pane. The
 *  raw line is stored as-typed; whether to resume or start fresh is decided at
 *  replay time from the "Resume agent sessions" setting. */
function rememberAgentCommand(paneId: string, line: string): void {
  const agent = detectAgentCommand(line);
  if (!agent) return;
  const session = sessionOfPane(paneId);
  if (!session) return;
  const leaf = findLeaf(session.tree, paneId);
  if (!leaf) return;
  leaf.lastCommand = line.trim();
  claimPaneAgent(paneId, leaf.lastCommand);
  store.save();
}

/** Builds the line to replay in a restored pane. With "Resume conversations on
 *  restart" on, we first ask the backend which conversation this exact pane was
 *  last attached to and reopen *that* one by id (`claude --resume <id>`); only
 *  when no session was ever linked do we fall back to the generic `--continue`,
 *  which would otherwise hand every pane the same most-recent conversation. */
async function resumeCommandFor(paneId: string, lastCommand: string): Promise<string | null> {
  const resume = store.state.settings.resumeAgentSessions;
  const agent = detectAgentCommand(lastCommand);
  if (resume && agent) {
    const harness = AGENT_HARNESS[agent];
    if (harness) {
      const link = await paneLastSession(paneId, harness).catch(() => null);
      const exact = link && buildSessionResumeCommand(lastCommand, agent, link.sessionId);
      if (exact) return exact;
    }
  }
  return applyResumePreference(lastCommand, resume);
}

function createPaneTerm(id: string, customName?: string): PaneTerm {
  const p = new PaneTerm(id, store.state.settings, paneHandlers());
  if (customName) p.setCustomName(customName);
  panes.set(id, p);
  return p;
}

function createPaneBrowser(
  id: string,
  url: string,
  title: string,
  device?: string,
  landscape?: boolean
): PaneBrowser {
  const p = new PaneBrowser(id, url ?? "", title ?? "", browserHandlers(), device, landscape);
  browserPanes.set(id, p);
  return p;
}

function browserHandlers() {
  return {
    onFocus: (id: string) => {
      const s = sessionOfPane(id);
      if (!s) return;
      focusedPane.set(s.id, id);
      updateFocusRing();
    },
    onSplit: (id: string, dir: Dir, duplicate?: boolean) => splitPane(id, dir, duplicate),
    onClose: (id: string) => closePane(id),
    onMove: (src: string, target: string, region: DropRegion) => movePane(src, target, region),
    onSendContext: (src: string, target: string, mode: "report" | "screenshot") =>
      void sendBrowserContext(src, target, mode),
    onToggleZoom: (id: string) => zoomPaneById(id),
    onToggleFold: (id: string) => foldPaneById(id),
    onUrlChanged: (id: string, url: string, title: string) => rememberBrowserState(id, url, title),
    onDeviceChanged: (id: string, device: string, landscape: boolean) =>
      rememberBrowserDevice(id, device, landscape),
  };
}

/** Persists a browser pane's current URL + title so the session restores it. */
function rememberBrowserState(paneId: string, url: string, title: string): void {
  const session = sessionOfPane(paneId);
  if (!session) return;
  const leaf = findLeaf(session.tree, paneId);
  if (!leaf) return;
  if (url) leaf.url = url;
  leaf.pageTitle = title;
  store.save();
}

/** Persists a browser pane's emulated device so the session restores it. */
function rememberBrowserDevice(paneId: string, device: string, landscape: boolean): void {
  const session = sessionOfPane(paneId);
  if (!session) return;
  const leaf = findLeaf(session.tree, paneId);
  if (!leaf) return;
  leaf.device = device;
  leaf.landscape = landscape;
  store.save();
}

/** Alt+drag from a browser pane onto a terminal: paste the captured console +
 *  network report, or (with Shift held too) a screenshot file reference. */
async function sendBrowserContext(
  srcId: string,
  targetId: string,
  mode: "report" | "screenshot"
): Promise<void> {
  const block = await browserContextBlock(srcId, mode);
  if (!block) return;
  pasteIntoTerminal(targetId, block);
  panes.get(targetId)?.focus();
  // The source browser pane is a separate child webview that still holds real
  // OS keyboard focus after the drop — DOM focus alone leaves the terminal
  // looking selected but deaf to the next keystroke until clicked.
  void invoke("focus_main_window");
}

function createExternalPane(id: string, hwnd: string, title: string): ExternalPane {
  const p = new ExternalPane(id, hwnd, title, {
    onFocus: (pid) => {
      const s = sessionOfPane(pid);
      if (!s) return;
      focusedPane.set(s.id, pid);
      updateFocusRing();
    },
    onEject: (pid) => ejectExternal(pid),
    onMove: (src, target, region) => movePane(src, target, region),
  });
  externalPanes.set(id, p);
  return p;
}

/** Tear down whatever currently occupies a leaf id (an in-app PTY *or* an
 *  already-docked external window), leaving the id free to be reused. */
function vacateLeaf(id: string): void {
  const term = panes.get(id);
  if (term) {
    term.dispose();
    panes.delete(id);
  }
  const browser = browserPanes.get(id);
  if (browser) {
    browser.dispose();
    browserPanes.delete(id);
  }
  const file = filePanes.get(id);
  if (file) {
    file.dispose();
    filePanes.delete(id);
  }
  const ext = externalPanes.get(id);
  if (ext) {
    void releaseEmbeddedWindow(id);
    ext.dispose();
    externalPanes.delete(id);
  }
}

/** Dock a dragged-in external terminal (identified by its HWND) into the tree at
 *  the given target pane + drop region, then reparent the OS window over it. */
function embedExternal(hwnd: string, title: string, targetId: string, region: DropRegion): void {
  const session = sessionOfPane(targetId);
  if (!session) return;
  session.zoomed = null;

  let hostId: string;
  if (region === "c") {
    // Replace the target pane in place, reusing its id.
    const leaf = findLeaf(session.tree, targetId);
    if (!leaf) return;
    vacateLeaf(targetId);
    leaf.external = true;
    leaf.externalTitle = title;
    delete leaf.lastCommand;
    hostId = targetId;
  } else {
    // Split the target and dock into the fresh leaf.
    const newId = uid();
    const dir: Dir = region === "e" || region === "w" ? "row" : "col";
    const before = region === "w" || region === "n";
    session.tree = splitLeaf(session.tree, targetId, dir, newId, before);
    const leaf = findLeaf(session.tree, newId);
    if (!leaf) return;
    leaf.external = true;
    leaf.externalTitle = title;
    hostId = newId;
  }

  createExternalPane(hostId, hwnd, title);
  rerender(session);
  focusedPane.set(session.id, hostId);
  requestAnimationFrame(() => {
    const ext = externalPanes.get(hostId);
    if (!ext) return;
    void embedExternalWindow(hostId, hwnd, ext.hostRect()).then(() => ext.syncNow());
    updateFocusRing();
    store.save(true);
  });
}

/** Pop a docked external window back out to a free-floating window and remove
 *  its pane from the session. */
function ejectExternal(id: string): void {
  const session = sessionOfPane(id);
  if (!session) return;
  void releaseEmbeddedWindow(id);
  externalPanes.get(id)?.dispose();
  externalPanes.delete(id);
  const next = removeLeaf(session.tree, id);
  if (!next) {
    closeSession(session.id);
    return;
  }
  session.tree = next;
  if (session.zoomed === id) session.zoomed = null;
  rerender(session);
  if (focusedPane.get(session.id) === id) {
    requestAnimationFrame(() => focusPane(collectLeaves(session.tree)[0]));
  }
  store.save(true);
}

function fitSessionSoon(session: Session): void {
  collectLeaves(session.tree).forEach((id) => {
    panes.get(id)?.fitSoon();
    browserPanes.get(id)?.fitSoon();
  });
}

function viewOf(session: Session): HTMLElement {
  let v = sessionViews.get(session.id);
  if (!v) {
    v = document.createElement("div");
    v.className = "session-view";
    sessionViews.set(session.id, v);
    viewsEl.appendChild(v);
  }
  return v;
}

function rerender(session: Session): void {
  // Something is putting panes into an archived session (a delegation firing,
  // "Review with AI") — bring it back instead of rendering into nowhere.
  // restoreArchivedSession clears the flag before re-entering here.
  if (session.archived) return restoreArchivedSession(session);
  renderSession(session, viewOf(session), () => store.save());
  requestAnimationFrame(() => {
    for (const id of collectLeaves(session.tree)) {
      const leaf = findLeaf(session.tree, id);
      if (leaf?.external) {
        // Docked external window: no PTY, just re-glue it to its new host rect.
        externalPanes.get(id)?.syncNow();
        continue;
      }
      if (leaf?.kind === "file") {
        // Docked file pane: its surface element is reused across rerenders, so
        // there is nothing to re-glue — only to create on first sight.
        if (!filePanes.has(id) && leaf.filePath) {
          const p = createPaneFile(id, leaf.filePath, leaf.fileName ?? leaf.filePath);
          void p.open();
        }
        continue;
      }
      if (leaf?.kind === "browser") {
        // Browser pane: make sure its PaneBrowser exists (it survives rerenders
        // since the DOM element is reused), then re-glue the webview.
        if (!browserPanes.has(id))
          createPaneBrowser(id, leaf.url ?? "", leaf.pageTitle ?? "", leaf.device, leaf.landscape);
        browserPanes.get(id)?.syncSoon();
        continue;
      }
      const p = panes.get(id);
      if (!p) continue;
      p.fitSoon();
      syncPaneAgentBadge(id, leaf?.lastCommand);
      if (p.started) continue; // already running — nothing to replay
      // About to replay the remembered command into a fresh PTY, so the claim
      // window opens here too — the agent is starting now, not when it was
      // first typed in some earlier run of the app.
      if (leaf?.lastCommand) claimPaneAgent(id, leaf.lastCommand);
      // A duplicated pane starts its agent fresh — its remembered command is
      // already stripped of resume flags, so replay it verbatim.
      const fresh = freshAgentPanes.delete(id);
      const replay = leaf?.lastCommand
        ? fresh
          ? Promise.resolve(leaf.lastCommand)
          : resumeCommandFor(id, leaf.lastCommand)
        : null;
      const shell = store.state.settings.shell;
      const sessionCwd = session.cwd ?? null;
      // Reopen the pane in the folder it was last in, not the session's.
      if (leaf?.cwd || !leaf?.lastCommand) {
        void p.ensureSpawned(shell, leaf?.cwd ?? sessionCwd, replay, sessionCwd);
      } else {
        const cmd = leaf.lastCommand;
        void agentCwdFor(id, cmd).then((c) => p.ensureSpawned(shell, c ?? sessionCwd, replay, sessionCwd));
      }
    }
    syncAllBrowsers();
  });
  updateFocusRing();
  updateChrome();
}

/** pane id → "claude-code" | "codex" | "opencode" | "" (anything else). */
const paneHarness = new Map<string, string>();
let publishedAgent: string | null = null;

/** Tells the dictation agent which CLI owns the focused pane and which pane it
 *  is, as "<agent>\t<pane id>": the agent CLIs take a paste on Ctrl+Shift+V
 *  rather than Ctrl+V, and the pane id lets dictation notice when a transcript
 *  would land somewhere other than where it was dictated. Written on change. */
function publishFocusedAgent(): void {
  const s = activeSession();
  const focused = s ? focusedPane.get(s.id) : undefined;
  const agent = (focused && paneHarness.get(focused)) || "";
  const payload = `${agent}\t${focused ?? ""}`;
  if (payload === publishedAgent) return;
  publishedAgent = payload;
  void invoke("dictation_set_focused_agent", { agent: payload }).catch(() => {});
}

function updateFocusRing(): void {
  const s = activeSession();
  const focused = s ? focusedPane.get(s.id) : undefined;
  publishFocusedAgent();
  document.querySelectorAll<HTMLElement>(".pane").forEach((p) => {
    p.classList.toggle("focused", p.dataset.paneId === focused);
  });
}

function focusPane(id: string | undefined): void {
  if (!id) return;
  const s = sessionOfPane(id);
  if (s) focusedPane.set(s.id, id);
  panes.get(id)?.focus();
  browserPanes.get(id)?.focus();
  filePanes.get(id)?.focus();
  updateFocusRing();
}

// ---------------------------------------------------------------- sessions

function makeTreeN(count: number): { tree: PaneNode; ids: string[] } {
  const ids = Array.from({ length: count }, () => uid());
  const rowOf = (rids: string[]): PaneNode =>
    rids.length === 1
      ? { type: "leaf", id: rids[0] }
      : {
          type: "split",
          dir: "row",
          children: rids.map((id) => ({ type: "leaf", id }) as PaneNode),
          sizes: rids.map(() => 1 / rids.length),
        };
  if (count <= 4) return { tree: rowOf(ids), ids };
  const top = ids.slice(0, Math.ceil(count / 2));
  const bottom = ids.slice(top.length);
  return {
    tree: { type: "split", dir: "col", children: [rowOf(top), rowOf(bottom)], sizes: [0.5, 0.5] },
    ids,
  };
}

function openWizard(): void {
  wizard.open(`Session ${store.state.sessions.length + 1}`);
}

function newSession(opts: Partial<WizardResult> = {}): void {
  const { tree, ids } = makeTreeN(opts.count ?? 3);
  const n = store.state.sessions.length;
  const session: Session = {
    id: uid(),
    name: opts.name || `Session ${n + 1}`,
    color: SESSION_COLORS[n % SESSION_COLORS.length],
    tree,
    zoomed: null,
    cwd: opts.cwd ?? null,
    command: opts.command ?? null,
  };
  ids.forEach((id) => createPaneTerm(id));
  store.state.sessions.push(session);
  setActiveSession(session.id);
  rerender(session);
  focusPane(ids[0]);
  if (opts.command) {
    const cmd = opts.command;
    // ConPTY buffers stdin, so this lands as soon as the shell starts reading.
    setTimeout(() => ids.forEach((id) => void writePty(id, cmd + "\r")), 700);
  }
  store.save(true);
}

function setActiveSession(id: string): void {
  // Anything that navigates to an archived session (inbox item, folder launch,
  // undo) brings it back rather than activating a view that isn't there.
  const target = store.state.sessions.find((s) => s.id === id);
  if (target?.archived) restoreArchivedSession(target);
  closeSettings();
  store.state.activeSessionId = id;
  for (const s of store.state.sessions) {
    viewOf(s).classList.toggle("active", s.id === id);
  }
  const s = activeSession();
  if (s) {
    requestAnimationFrame(() => {
      fitSessionSoon(s);
      syncAllBrowsers();
      focusPane(focusedPane.get(s.id) ?? collectLeaves(s.tree)[0]);
    });
  }
  // Hide docked windows of the session we just left; show/reposition the new one.
  syncAllExternal();
  requestAnimationFrame(syncAllExternal);
  updateEmptyState();
  updateChrome();
  store.save();
}

/** Handles a folder handed to us from Explorer — the `OpenTerm` address-bar
 *  launch, or the folder context menu.
 *
 *  Same request, three situations: if a session is already rooted at that folder
 *  we just bring it forward (no duplicate), otherwise we start one there. The app
 *  not having been running at all is handled upstream, by the single-instance
 *  plugin deciding whether to hand the folder over or let a new process boot. */
function openFolderSession(folder: string): void {
  const key = folderKey(folder);
  if (!key) return;

  if (wizard.isOpen()) wizard.close(); // the folder answers what the wizard was asking

  const existing = store.state.sessions.find((s) => folderKey(s.cwd) === key);
  if (existing) {
    setActiveSession(existing.id);
  } else {
    newSession({ name: folderLabel(folder), count: 1, cwd: folder, command: null });
  }
  updateChrome();
}

/** User-initiated session delete: ask first, since this kills every terminal in it.
 *  A snapshot is kept in the trash ring, so this is undoable for a few minutes
 *  even though the confirm dialog says otherwise (that copy still stands for
 *  the live terminal output, which is genuinely gone). */
async function confirmCloseSession(id: string): Promise<void> {
  const s = store.state.sessions.find((x) => x.id === id);
  if (!s) return;
  const n = collectLeaves(s.tree).length;
  const ok = await confirm.ask({
    title: `Close “${s.name}”?`,
    message: `This closes the session and its ${n} terminal${n === 1 ? "" : "s"}.\nThis can't be undone.`,
    confirmLabel: "Close session",
    cancelLabel: "Cancel",
    danger: true,
  });
  if (!ok) return;

  const idx = store.state.sessions.findIndex((x) => x.id === id);
  const snapshot = structuredClone(s);
  closeSession(id);

  trash.push({
    label: `Session “${snapshot.name || "Untitled"}” closed`,
    restore: () => {
      if (store.state.sessions.some((x) => x.id === snapshot.id)) return;
      const restored: Session = structuredClone(snapshot);
      restored.tree = pruneExternalLeaves(restored.tree) ?? { type: "leaf", id: uid() };
      const insertAt = Math.min(idx, store.state.sessions.length);
      store.state.sessions.splice(insertAt, 0, restored);
      spawnMissingPanes(restored);
      rerender(restored);
      setActiveSession(restored.id);
      updateEmptyState();
      updateChrome();
      store.save(true);
    },
  });
}

/** Creates panes for any leaf in a (re-inserted) tree that doesn't have a live
 *  one yet — used both at boot and when restoring a session/pane from the
 *  trash ring. External leaves can't be resurrected (their HWND is gone). */
function spawnMissingPanes(session: Session): void {
  for (const id of collectLeaves(session.tree)) {
    const leaf = findLeaf(session.tree, id);
    if (!leaf || leaf.external) continue;
    if (leaf.kind === "file") {
      if (!filePanes.has(id) && leaf.filePath) {
        const p = createPaneFile(id, leaf.filePath, leaf.fileName ?? leaf.filePath);
        void p.open();
      }
    } else if (leaf.kind === "browser") {
      if (!browserPanes.has(id))
        createPaneBrowser(id, leaf.url ?? "", leaf.pageTitle ?? "", leaf.device, leaf.landscape);
    } else if (!panes.has(id)) {
      createPaneTerm(id, leaf.customName);
    }
  }
}

/** Disposes every live pane of a session and drops its view. The session's
 *  data (tree, tasks, remembered commands) is left untouched. */
function stopSessionPanes(session: Session): void {
  for (const pid of collectLeaves(session.tree)) {
    if (externalPanes.has(pid)) {
      // Free the reparented window back to the desktop; don't kill it.
      void releaseEmbeddedWindow(pid);
      externalPanes.get(pid)?.dispose();
      externalPanes.delete(pid);
    }
    browserPanes.get(pid)?.dispose();
    browserPanes.delete(pid);
    filePanes.get(pid)?.dispose();
    filePanes.delete(pid);
    panes.get(pid)?.dispose();
    panes.delete(pid);
  }
  sessionViews.get(session.id)?.remove();
  sessionViews.delete(session.id);
  focusedPane.delete(session.id);
}

/** Sessions shown in the sidebar and reachable by switching — not archived. */
function visibleSessions(): Session[] {
  return store.state.sessions.filter((s) => !s.archived);
}

/** Where focus goes when the active session at `idx` goes away: the next
 *  visible session after it, else the nearest one before it. */
function fallbackSession(idx: number, excludeId: string): Session | undefined {
  const ok = (s: Session) => !s.archived && s.id !== excludeId;
  const { sessions } = store.state;
  return sessions.slice(idx).find(ok) ?? sessions.slice(0, idx).reverse().find(ok);
}

function closeSession(id: string): void {
  const idx = store.state.sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  stopSessionPanes(store.state.sessions[idx]);
  store.state.sessions.splice(idx, 1);

  if (store.state.activeSessionId === id) {
    const next = fallbackSession(idx, id);
    store.state.activeSessionId = next?.id ?? null;
    if (next) setActiveSession(next.id);
  }
  updateEmptyState();
  updateChrome();
  store.save(true);
}

/** Hides a session from the sidebar and stops its terminals, keeping everything
 *  needed to bring it back from Settings → Archived sessions. */
function archiveSession(id: string): void {
  const idx = store.state.sessions.findIndex((s) => s.id === id);
  const session = store.state.sessions[idx];
  if (!session || session.archived) return;
  stopSessionPanes(session);
  session.archived = true;
  session.archivedAt = Date.now();
  attentionSessions.delete(id);
  sessionSubagents.delete(id);

  if (store.state.activeSessionId === id) {
    const next = fallbackSession(idx, id);
    store.state.activeSessionId = next?.id ?? null;
    if (next) setActiveSession(next.id);
  }
  updateEmptyState();
  updateChrome();
  if (settingsOpen) settingsView.render();
  store.save(true);
}

/** Un-archives a session in place without switching to it: panes are respawned
 *  and remembered agent commands replayed, exactly like an app restart. */
function restoreArchivedSession(session: Session): void {
  if (!session.archived) return;
  delete session.archived;
  delete session.archivedAt;
  spawnMissingPanes(session);
  rerender(session);
  updateEmptyState();
  updateChrome();
  store.save(true);
}

function switchSession(offset: number): void {
  const sessions = visibleSessions();
  if (sessions.length < 2) return;
  const idx = sessions.findIndex((s) => s.id === store.state.activeSessionId);
  const next = sessions[(idx + offset + sessions.length) % sessions.length];
  setActiveSession(next.id);
}

function updateEmptyState(): void {
  const none = visibleSessions().length === 0;
  emptyEl.classList.toggle("visible", none);
  if (none) renderEmptyState();
}

// ---------------------------------------------------------------- panes

/** Panes that must launch their agent as a *brand-new* conversation on their
 *  first spawn, overriding the "resume agent sessions" preference. Set by an
 *  Alt+split duplicate: the clone inherits the source's agent CLI but not its
 *  chat. Consumed (and cleared) by the replay in `rerender`. */
const freshAgentPanes = new Set<string>();

function splitPane(paneId: string, dir: Dir, duplicate = false): void {
  const session = sessionOfPane(paneId);
  if (!session) return;
  const newId = uid();
  createPaneTerm(newId);
  session.tree = splitLeaf(session.tree, paneId, dir, newId);
  if (duplicate) duplicateInto(session, paneId, newId);
  session.zoomed = null;
  rerender(session);
  requestAnimationFrame(() => focusPane(newId));
  store.save(true);
}

/** Alt+split: make the freshly inserted leaf a copy of the pane it split off
 *  from — same working directory (wherever that pane has `cd`-ed to, not the
 *  session's folder) and same agent CLI, launched as a new conversation. */
function duplicateInto(session: Session, srcId: string, newId: string): void {
  const src = findLeaf(session.tree, srcId);
  const dst = findLeaf(session.tree, newId);
  if (!src || !dst || src.kind === "browser" || src.external) return;
  if (src.cwd) dst.cwd = src.cwd;
  if (src.lastCommand) {
    const agent = detectAgentCommand(src.lastCommand);
    // A fresh harness, not the same chat: drop any --resume/--continue flags
    // the source line carried, and flag the pane so the restart-resume path
    // doesn't add them back.
    dst.lastCommand = agent ? stripResumeCommand(src.lastCommand, agent) : src.lastCommand;
    if (agent) freshAgentPanes.add(newId);
  }
}

/** Sidebar "+" menu: drop a specific pane (agent CLI, plain shell or embedded
 *  browser) into the active session — splitting the focused pane so the new
 *  one appears right beside it. With no session open, starts one.
 *
 *  Agent entries are ordinary terminals whose launch command is remembered as
 *  the leaf's lastCommand before first spawn, so the existing resume/replay
 *  machinery types it once the shell is up (and resumes the previous
 *  conversation on app restarts, per settings). */
async function addPaneOfKind(kindId: string): Promise<void> {
  const def = PANE_KINDS.find((k) => k.id === kindId);
  if (!def) return;

  let launchCommand = def.command;
  const installer = AGENT_INSTALLERS[def.id];
  if (installer && def.command) {
    // Checking before the pane exists avoids leaving behind a dead terminal with
    // "command is not recognized" as its first and only output.
    const installed = await invoke<boolean>("command_exists", { command: def.command }).catch(
      () => true
    );
    if (!installed) {
      const install = await confirm.ask({
        title: `Install ${def.label}?`,
        message:
          `${def.label} isn't installed yet. OpenTerm can run ${installer.provider}'s official ` +
          "PowerShell installer in a new terminal, where you can follow its progress.",
        cancelLabel: "Not now",
        confirmLabel: "Install",
      });
      if (!install) return;
      launchCommand = installer.command;
    }
  }

  let session = activeSession();
  if (!session) {
    newSession({ count: 1 });
    session = activeSession();
    if (!session) return;
  }
  const anchorId = focusedPane.get(session.id) ?? collectLeaves(session.tree)[0];
  if (!anchorId) return;

  const newId = uid();
  if (def.kind === "browser") createPaneBrowser(newId, "", "");
  else createPaneTerm(newId);

  session.tree = splitLeaf(session.tree, anchorId, "row", newId);
  session.zoomed = null;

  // Tag the leaf the tree actually inserted (splitLeaf makes its own object).
  const leaf = findLeaf(session.tree, newId) as LeafNode | undefined;
  if (leaf && def.kind === "browser") leaf.kind = "browser";

  rerender(session);

  // Agent commands start a NEW conversation when explicitly added here (no
  // resume flag) — but they're remembered as the pane's launch command, so
  // restarting the app replays them with the user's resume preference applied.
  if (launchCommand) {
    // Remember the actual agent rather than its one-time installer. The official
    // installer updates this PowerShell session's PATH before `grok` starts.
    if (leaf) leaf.lastCommand = def.command;
    claimPaneAgent(newId, def.command);
    store.save();
    setTimeout(() => void writePty(newId, `${launchCommand}\r`), 700);
  }
  requestAnimationFrame(() => focusPane(newId));
  store.save(true);
}

async function closePane(paneId: string): Promise<void> {
  const session = sessionOfPane(paneId);
  if (!session) return;
  // A docked file with unsaved edits gets the same guard the viewer gives it.
  const file = filePanes.get(paneId);
  if (file?.isDirty()) {
    const ok = await confirm.ask({
      title: `Discard changes to “${file.name}”?`,
      message: "Unsaved edits will be lost.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    });
    if (!ok) return;
  }
  // Last pane in a session: closing it takes the whole session down with it,
  // so ask before pulling the rug (covers UI closes AND natural pty exits).
  if (collectLeaves(session.tree).length === 1) {
    const ok = await confirm.ask({
      title: `Close “${session.name}”?`,
      message:
        "This is the last pane in this session.\nClosing it will also close the session.",
      confirmLabel: "Close session",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
  }
  // Closing a docked external terminal just pops it back out — never kills it.
  if (externalPanes.has(paneId)) {
    ejectExternal(paneId);
    return;
  }
  const leaf = findLeaf(session.tree, paneId);
  const label =
    leaf?.customName ||
    (leaf?.kind === "browser"
      ? "Browser pane"
      : leaf?.kind === "file"
        ? `File “${leaf.fileName ?? "untitled"}”`
        : "Terminal");
  const sessionId = session.id;
  const treeSnapshot = structuredClone(session.tree);
  const zoomedSnapshot = session.zoomed;

  browserPanes.get(paneId)?.dispose();
  browserPanes.delete(paneId);
  filePanes.get(paneId)?.dispose();
  filePanes.delete(paneId);
  panes.get(paneId)?.dispose();
  panes.delete(paneId);
  // Drop the pane's recorded usage links: pane ids are generated per-pane, and
  // leaving orphaned links behind would attribute this terminal's spend to a
  // future pane that happened to reuse the id.
  agentClaimAt.delete(paneId);
  void forgetPaneUsage(paneId);
  forgetPaneActivity(paneId);
  const next = removeLeaf(session.tree, paneId);
  if (!next) {
    closeSession(session.id);
    return;
  }
  session.tree = next;
  if (session.zoomed === paneId) session.zoomed = null;
  rerender(session);
  if (focusedPane.get(session.id) === paneId) {
    requestAnimationFrame(() => focusPane(collectLeaves(session.tree)[0]));
  }
  store.save(true);

  trash.push({
    label: `“${label}” closed`,
    restore: () => {
      const s = store.state.sessions.find((x) => x.id === sessionId);
      if (!s) return; // the owning session is gone too — nothing to reattach to
      s.tree = structuredClone(treeSnapshot);
      s.zoomed = zoomedSnapshot;
      spawnMissingPanes(s);
      rerender(s);
      store.save(true);
    },
  });
}

function movePane(srcId: string, targetId: string, region: DropRegion): void {
  const session = sessionOfPane(srcId);
  if (!session || sessionOfPane(targetId)?.id !== session.id) return;
  const ext = externalPanes.get(srcId);
  if (region === "c" && !ext) {
    swapLeaves(session.tree, srcId, targetId);
  } else {
    const without = removeLeaf(session.tree, srcId);
    if (!without) return;
    const dir: Dir = region === "e" || region === "w" ? "row" : "col";
    const before = region === "w" || region === "n";
    session.tree = splitLeaf(without, targetId, dir, srcId, before);
    // splitLeaf makes a plain leaf, so a moved pane that isn't a plain terminal
    // has to have its identity written back onto the new leaf.
    const file = filePanes.get(srcId);
    if (file) {
      const leaf = findLeaf(session.tree, srcId);
      if (leaf) {
        leaf.kind = "file";
        leaf.filePath = file.path;
        leaf.fileName = file.name;
      }
    }
    const browser = browserPanes.get(srcId);
    if (browser) {
      const leaf = findLeaf(session.tree, srcId);
      if (leaf) {
        leaf.kind = "browser";
        leaf.url = browser.currentUrl;
        leaf.pageTitle = browser.pageTitle;
      }
    }
    if (ext) {
      const leaf = findLeaf(session.tree, srcId);
      if (leaf) {
        leaf.external = true;
        leaf.externalTitle = ext.el.querySelector(".pane-title")?.textContent ?? undefined;
      }
    }
  }
  session.zoomed = null;
  rerender(session);
  requestAnimationFrame(() => {
    focusPane(srcId);
    externalPanes.get(srcId)?.syncNow();
  });
  store.save(true);
}

function focusDirection(dx: number, dy: number): void {
  const session = activeSession();
  if (!session) return;
  const currentId = focusedPane.get(session.id) ?? collectLeaves(session.tree)[0];
  const cur = paneElement(currentId)?.getBoundingClientRect();
  if (!cur) return;
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;

  let best: { id: string; score: number } | null = null;
  for (const id of collectLeaves(session.tree)) {
    if (id === currentId) continue;
    const r = paneElement(id)?.getBoundingClientRect();
    if (!r) continue;
    const ox = r.left + r.width / 2 - cx;
    const oy = r.top + r.height / 2 - cy;
    const along = ox * dx + oy * dy;
    if (along <= 1) continue; // must be in the requested direction
    const ortho = Math.abs(ox * dy) + Math.abs(oy * dx);
    const score = along + ortho * 2.5;
    if (!best || score < best.score) best = { id, score };
  }
  if (!best) return;
  // A folded pane is still a stop on the way through: unfold it so the keyboard
  // lands somewhere the user can actually see (foldPane focuses it for us).
  if (findLeaf(session.tree, best.id)?.folded) foldPane(session, best.id);
  else focusPane(best.id);
}

function resizeFocused(dir: Dir, delta: number): void {
  const session = activeSession();
  if (!session) return;
  const id = focusedPane.get(session.id);
  if (!id) return;
  if (resizeLeaf(session.tree, id, dir, delta)) {
    const rootEl = viewOf(session).firstElementChild as HTMLElement | null;
    if (rootEl) syncSizes(session.tree, rootEl);
    fitSessionSoon(session);
    store.save();
  }
}

/** How long a fold/unfold takes; matches the `.session-view.folding` transition. */
const FOLD_ANIM_MS = 260;
/** Per-session timer that disarms the fold transition once it has played. */
const foldAnimTimers = new Map<string, number>();

/** Expand a pane to fill the whole view, or restore it if it's already expanded. */
function zoomPane(session: Session, id: string): void {
  // Zooming a folded pane unfolds it — you can't expand what's collapsed.
  const leaf = findLeaf(session.tree, id);
  if (leaf?.folded) {
    leaf.folded = false;
    applyFold(session, viewOf(session));
  }
  session.zoomed = session.zoomed === id ? null : id;
  applyZoom(session, viewOf(session));
  requestAnimationFrame(() => {
    fitSessionSoon(session);
    syncAllExternal();
    focusPane(id);
  });
  store.save();
}

/** Collapse a pane to just its title bar, or unfold it again. The terminal
 *  keeps running underneath — this only takes its space back for its siblings. */
function foldPane(session: Session, id: string): void {
  const leaf = findLeaf(session.tree, id);
  if (!leaf) return;
  // Folding and zooming are contradictory states; the newer gesture wins.
  if (session.zoomed === id) {
    session.zoomed = null;
    applyZoom(session, viewOf(session));
  }
  leaf.folded = !leaf.folded;

  const view = viewOf(session);
  // The flex transition is armed only for the duration of this toggle, so
  // divider drags and keyboard resizes stay instant instead of rubber-banding.
  view.classList.add("folding");
  window.clearTimeout(foldAnimTimers.get(session.id));
  foldAnimTimers.set(
    session.id,
    window.setTimeout(() => {
      view.classList.remove("folding");
      fitSessionSoon(session);
      syncAllExternal();
    }, FOLD_ANIM_MS)
  );

  applyFold(session, view);
  if (leaf.folded) {
    // Don't leave the keyboard pointed at a pane the user can no longer see.
    if (focusedPane.get(session.id) === id) {
      const next = collectLeaves(session.tree).find((x) => x !== id && !findLeaf(session.tree, x)?.folded);
      if (next) focusPane(next);
    }
  } else {
    requestAnimationFrame(() => focusPane(id));
  }
  fitSessionSoon(session);
  syncAllExternal();
  store.save();
}

function toggleFold(): void {
  const session = activeSession();
  if (!session) return;
  const id = focusedPane.get(session.id);
  if (id) foldPane(session, id);
}

function foldPaneById(id: string): void {
  const session = sessionOfPane(id);
  if (session) foldPane(session, id);
}

function toggleZoom(): void {
  const session = activeSession();
  if (!session) return;
  const id = focusedPane.get(session.id);
  if (id) zoomPane(session, id);
}

function zoomPaneById(id: string): void {
  const session = sessionOfPane(id);
  if (session) zoomPane(session, id);
}

// ---------------------------------------------------------------- settings & overlays

function applySettingsLive(): void {
  const s = store.state.settings;
  applyTheme(s.theme);
  syncPaneThemes();
  document.documentElement.style.setProperty("--pane-pad", `${s.padding}px`);
  document.documentElement.style.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  s.sidebarWidth = Math.max(s.sidebarWidth, sidebarMinWidth());
  document.documentElement.style.setProperty("--sidebar-width", `${s.sidebarWidth}px`);
  root.classList.toggle("sidebar-hidden", !s.sidebarVisible);
  panes.forEach((p) => p.applySettings(s));
  syncAllExternal();
  updateChrome();
  store.save();
}

function openSettings(): void {
  settingsOpen = true;
  settingsView.reset(); // discard any unsaved edits from a previous visit, sync from live settings
  main.classList.add("settings-open");
  syncAllExternal(); // hide docked windows behind the settings page
  updateChrome();
}

function closeSettings(): void {
  if (!settingsOpen) return;
  cancelRecording(); // don't leave a stray keydown listener if closed mid-recording
  settingsOpen = false;
  main.classList.remove("settings-open");
  updateChrome();
  const s = activeSession();
  if (s) requestAnimationFrame(() => fitSessionSoon(s));
  requestAnimationFrame(syncAllExternal);
}

function openDictationSettings(): void {
  openSettings();
  settingsView.openCategory("dictation");
}

void listen("open-dictation-settings", () => openDictationSettings());

function toggleSettings(): void {
  settingsOpen ? closeSettings() : openSettings();
}

function toggleTasks(): void {
  if (tasksPanel.isOpen()) {
    tasksPanel.close();
    return;
  }
  const s = activeSession();
  if (s) tasksPanel.show(s);
}

function toggleInbox(): void {
  inboxPanel.toggle(sidebar.inboxAnchor);
}

/** A file (or folder) was dragged from the sidebar's Files view and dropped onto
 *  a terminal pane — type its path into that pane's stdin, quoted if needed, as
 *  if the user had typed it (e.g. to hand it to an AI agent CLI running there). */
function dropFileIntoPane(path: string, _name: string, paneId: string): void {
  typePathsIntoPane(paneId, quotePathForShell(path));
}

/** Writes already-quoted path text into a pane's stdin and focuses it — shared by
 *  the sidebar's Files view and by files dragged in from outside the app. */
function typePathsIntoPane(paneId: string, text: string): void {
  const term = panes.get(paneId);
  if (!term) return;
  void writePty(paneId, text);
  term.focus();
}

/** Alt+drag of one terminal onto another: paste the source terminal's recent
 *  output into the target's stdin as a labelled context block (typically dropped
 *  onto an AI agent CLI so it can see what happened in the other terminal).
 *
 *  The block is wrapped in bracketed-paste markers so line-oriented REPLs and
 *  agent CLIs take it as a single multi-line paste instead of submitting — and
 *  running one command per — every embedded newline. */
function sendPaneContext(srcId: string, targetId: string): void {
  const src = panes.get(srcId);
  const target = panes.get(targetId);
  if (!src || !target || srcId === targetId) return;

  const maxLines = Math.min(CONTEXT_MAX_LINES, store.state.settings.scrollback);
  const body = src.snapshotText(maxLines);
  if (!body) return;

  const block =
    `--- context: terminal "${src.title}" (last ${body.split("\n").length} lines) ---\n` +
    body +
    `\n--- end context ---\n`;
  // \r would submit inside the paste on some shells; PTYs accept \n in a paste.
  void writePty(targetId, `\x1b[200~${block.replace(/\r/g, "")}\x1b[201~`);
  target.focus();
}

function openFile(path: string, name: string, pending?: string): void {
  openFileName = name;
  openFilePath = path;
  fileViewerOpen = true;
  main.classList.add("file-viewer-open");
  syncAllExternal(); // hide docked windows behind the file viewer
  void fileViewer.open(path, name, pending);
}

function closeFile(): void {
  if (!fileViewerOpen) return;
  fileViewerOpen = false;
  main.classList.remove("file-viewer-open");
  fileViewer.close();
  const s = activeSession();
  if (s) requestAnimationFrame(() => fitSessionSoon(s));
  requestAnimationFrame(syncAllExternal);
}

/** Closes the file viewer, prompting first if there are unsaved edits. */
async function requestCloseFile(): Promise<void> {
  if (!fileViewerOpen) return;
  if (fileViewer.isDirty()) {
    const ok = await confirm.ask({
      title: `Discard changes to "${openFileName}"?`,
      message: "Unsaved edits will be lost.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    });
    if (!ok) return;
  }
  closeFile();
}

function renderEmptyState(): void {
  const kb = store.state.settings.keybinds;
  emptyEl.innerHTML = `
    <div class="empty-inner">
      <div class="empty-logo"><span class="wordmark-lg">OPEN<b>TERM</b></span></div>
      <h1>Welcome to OpenTerm</h1>
      <p>A session is a named workspace of terminals.<br>Create your first one to get started.</p>
      <button class="btn-start empty-cta" type="button">New session</button>
      <div class="empty-hints">
        <div><kbd>${prettyChord(kb.splitRight)}</kbd><span>Split right</span></div>
        <div><kbd>${prettyChord(kb.splitDown)}</kbd><span>Split down</span></div>
        <div><kbd>${prettyChord(kb.cheatSheet)}</kbd><span>All shortcuts</span></div>
      </div>
    </div>`;
  emptyEl.querySelector<HTMLButtonElement>(".empty-cta")?.addEventListener("click", () => {
    emptyEl.classList.remove("visible");
    openWizard();
  });
}

function toggleCheatSheet(): void {
  if (cheatEl.classList.contains("visible")) {
    cheatEl.classList.remove("visible");
    return;
  }
  const kb = store.state.settings.keybinds;
  const rows = (Object.entries(ACTIONS) as [Action, string][])
    .filter(([a]) => kb[a])
    .map(
      ([a, label]) =>
        `<div class="cheat-row"><span>${label}</span><kbd>${prettyChord(kb[a])}</kbd></div>`
    )
    .join("");
  cheatEl.innerHTML = `
    <div class="cheat-card">
      <header><h2>Shortcuts</h2><span>Esc or ${prettyChord(kb.cheatSheet)} to close</span></header>
      <div class="cheat-grid">${rows}
        <div class="cheat-row"><span>Jump to session 1–9</span><kbd>Alt+1…9</kbd></div>
        <div class="cheat-row"><span>Duplicate a terminal (same folder + agent)</span><kbd>Hold Alt while splitting</kbd></div>
        <div class="cheat-row"><span>Move a terminal</span><kbd>Drag its title bar</kbd></div>
        <div class="cheat-row"><span>Give a terminal as context</span><kbd>Alt+drag onto another</kbd></div>
        <div class="cheat-row"><span>Share a browser's console & network log</span><kbd>Alt+drag it onto a terminal</kbd></div>
        <div class="cheat-row"><span>Share a browser screenshot</span><kbd>Alt+Shift+drag onto a terminal</kbd></div>
        <div class="cheat-row"><span>Open a terminal link in a browser pane</span><kbd>Alt+click the link</kbd></div>
      </div>
    </div>`;
  cheatEl.classList.add("visible");
}

async function resetAllData(): Promise<void> {
  for (const s of [...store.state.sessions]) closeSession(s.id);
  store.state.settings = structuredClone(DEFAULT_SETTINGS);
  applySettingsLive();
  await invoke("save_state", { json: JSON.stringify(store.state) });
  closeSettings();
  openWizard();
}

/** Swaps state.json for a backup and reboots the UI on top of it. Returns false
 *  when the user cancelled (the settings row re-enables itself in that case). */
async function restoreBackup(backup: BackupInfo): Promise<boolean> {
  const when = new Date(backup.createdAt).toLocaleString();
  const sessions = backup.sessionNames.length
    ? backup.sessionNames.join(", ")
    : "no sessions";
  const ok = await confirm.ask({
    title: "Restore this backup?",
    message:
      `Your layout will be replaced with the snapshot from ${when} (${sessions}). ` +
      `Sessions and panes created since then will disappear, and all running ` +
      `terminals will be closed. A copy of your current state is saved first, ` +
      `so you can restore back to it from this same list.`,
    confirmLabel: "Restore",
    danger: true,
  });
  if (!ok) return false;

  // Order matters: stop persisting *before* tearing anything down, or the
  // teardown's own saves would overwrite the file we're about to restore.
  store.suspend();
  try {
    await invoke("restore_backup", { filename: backup.filename });
  } catch (e) {
    addInboxItem({
      kind: "error",
      message: `Couldn't restore that backup: ${e instanceof Error ? e.message : String(e)}`,
    });
    // Nothing was written, but saves are dead for this run — a reload puts the
    // app back on its (untouched) current state rather than leaving it silent.
    window.location.reload();
    return true;
  }
  // Kill PTYs and release embedded windows so the reload doesn't inherit
  // orphaned processes for panes the restored state may not contain.
  for (const s of [...store.state.sessions]) closeSession(s.id);
  window.location.reload();
  return true;
}

// ---------------------------------------------------------------- actions

/** True while the thing the user is reading is a file, not a terminal: the
 *  full-screen viewer, or a docked file pane that holds focus (or is simply
 *  the selected pane). Ctrl+± follows that, so the zoom always lands on the
 *  text in front of you. */
function fileSurfaceInFocus(): boolean {
  if (fileViewerOpen) return true;
  if (!filePanes.size) return false;
  if ([...filePanes.values()].some((p) => p.containsFocus(document.activeElement))) return true;
  const s = activeSession();
  const focused = s ? focusedPane.get(s.id) : undefined;
  return !!focused && filePanes.has(focused);
}

/** Applies a font-size step to the file editor, when that's what's in front of
 *  the user. `step` of 0 resets. Returns false if the keystroke belongs to the
 *  terminal instead, so the caller can fall back to the terminal font. */
function bumpEditorFont(step: number): boolean {
  if (!fileSurfaceInFocus()) return false;
  const s = store.state.settings;
  s.editorFontSize =
    step === 0
      ? DEFAULT_SETTINGS.editorFontSize
      : Math.max(9, Math.min(28, s.editorFontSize + step));
  applySettingsLive();
  return true;
}


/** Holding Alt while splitting duplicates the source pane instead of opening a
 *  blank one. For the keyboard path that only counts when Alt isn't already
 *  part of the shortcut itself — otherwise a user-bound Alt chord could never
 *  split normally. */
function altDuplicate(action: Action, e?: KeyboardEvent): boolean {
  if (!e?.altKey) return false;
  return !(store.state.settings.keybinds[action] ?? "").includes("Alt");
}

function runAction(action: Action, e?: KeyboardEvent): void {
  const session = activeSession();
  const focused = session ? focusedPane.get(session.id) : undefined;
  switch (action) {
    case "newSession":
      openWizard();
      break;
    case "closeSession":
      if (session) void confirmCloseSession(session.id);
      break;
    case "renameSession":
      if (session) {
        sidebar.startRename(session.id);
        updateChrome();
      }
      break;
    case "nextSession":
      switchSession(1);
      break;
    case "prevSession":
      switchSession(-1);
      break;
    case "newTerminal":
      if (focused) splitPane(focused, "row", altDuplicate(action, e));
      break;
    case "splitRight":
      if (focused) splitPane(focused, "row", altDuplicate(action, e));
      break;
    case "splitDown":
      if (focused) splitPane(focused, "col", altDuplicate(action, e));
      break;
    case "closePane":
      if (focused) closePane(focused);
      break;
    case "focusLeft":
      focusDirection(-1, 0);
      break;
    case "focusRight":
      focusDirection(1, 0);
      break;
    case "focusUp":
      focusDirection(0, -1);
      break;
    case "focusDown":
      focusDirection(0, 1);
      break;
    case "resizeLeft":
      resizeFocused("row", -0.04);
      break;
    case "resizeRight":
      resizeFocused("row", 0.04);
      break;
    case "resizeUp":
      resizeFocused("col", -0.04);
      break;
    case "resizeDown":
      resizeFocused("col", 0.04);
      break;
    case "zoomPane":
      toggleZoom();
      break;
    case "foldPane":
      toggleFold();
      break;
    case "toggleSidebar":
      store.state.settings.sidebarVisible = !store.state.settings.sidebarVisible;
      applySettingsLive();
      break;
    case "toggleSidebarView":
      // A hidden sidebar comes back already on the other view, so one press
      // always shows you something new.
      if (!store.state.settings.sidebarVisible) {
        store.state.settings.sidebarVisible = true;
        applySettingsLive();
      }
      sidebar.toggleMode();
      break;
    case "fontInc":
      if (!bumpEditorFont(+1)) {
        store.state.settings.fontSize = Math.min(24, store.state.settings.fontSize + 1);
        applySettingsLive();
      }
      break;
    case "fontDec":
      if (!bumpEditorFont(-1)) {
        store.state.settings.fontSize = Math.max(9, store.state.settings.fontSize - 1);
        applySettingsLive();
      }
      break;
    case "fontReset":
      if (!bumpEditorFont(0)) {
        store.state.settings.fontSize = DEFAULT_SETTINGS.fontSize;
        applySettingsLive();
      }
      break;
    case "search":
      if (focused) panes.get(focused)?.showSearch();
      break;
    case "highlightSearch":
      searchModal.open();
      break;
    case "queueCommand":
      if (focused) panes.get(focused)?.showQueueInput();
      break;
    case "cheatSheet":
      toggleCheatSheet();
      break;
    case "openSettings":
      toggleSettings();
      break;
    case "openTasks":
      toggleTasks();
      break;
    case "openInbox":
      toggleInbox();
      break;
    case "restoreLast":
      trash.restore();
      break;
  }
}

/** Narrowest sidebar where the "New session <kbd>" + "+" row still fits on one
 *  line — measured, since the shortcut label and font vary. */
function sidebarMinWidth(): number {
  const row = document.querySelector<HTMLElement>(".sidebar-add-row");
  const sidebarEl = row?.closest<HTMLElement>(".sidebar");
  const btn = row?.querySelector<HTMLElement>(".new-session");
  const addBtn = row?.querySelector<HTMLElement>(".add-pane-btn");
  if (!row || !sidebarEl || !btn || !addBtn || !row.offsetWidth) return SIDEBAR_WIDTH_MIN;
  const num = (cs: CSSStyleDeclaration, ...props: string[]): number =>
    props.reduce((n, p) => n + (parseFloat(cs.getPropertyValue(p)) || 0), 0);
  const btnCs = getComputedStyle(btn);
  const children = Array.from(btn.children) as HTMLElement[];
  const btnWidth =
    children.reduce((n, c) => n + c.offsetWidth, 0) +
    num(btnCs, "column-gap") * Math.max(0, children.length - 1) +
    num(btnCs, "padding-left", "padding-right", "border-left-width", "border-right-width");
  const rowWidth = btnWidth + num(getComputedStyle(row), "column-gap") + addBtn.offsetWidth;
  const overhead = sidebarEl.offsetWidth - row.offsetWidth;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.ceil(rowWidth + overhead + 2)));
}

function setupSidebarResize(): void {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  sidebarResizer.addEventListener("pointerdown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = store.state.settings.sidebarWidth;
    sidebarResizer.classList.add("dragging");
    document.body.classList.add("resizing-sidebar");
    sidebarResizer.setPointerCapture(e.pointerId);
  });

  sidebarResizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const next = Math.min(
      SIDEBAR_WIDTH_MAX,
      Math.max(sidebarMinWidth(), startWidth + (e.clientX - startX))
    );
    store.state.settings.sidebarWidth = next;
    document.documentElement.style.setProperty("--sidebar-width", `${next}px`);
    syncAllExternal();
  });

  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    sidebarResizer.classList.remove("dragging");
    document.body.classList.remove("resizing-sidebar");
    const s = activeSession();
    if (s) requestAnimationFrame(() => fitSessionSoon(s));
    store.save();
  };
  sidebarResizer.addEventListener("pointerup", stop);
  sidebarResizer.addEventListener("pointercancel", stop);
}

// ---------------------------------------------------------------- wiring

const sidebar = createSidebar({
  onNewSession: () => openWizard(),
  onAddPane: (kindId) => void addPaneOfKind(kindId),
  onSelect: setActiveSession,
  onCloseSession: (id) => void confirmCloseSession(id),
  onArchiveSession: archiveSession,
  onRename: (id, name) => {
    const s = store.state.sessions.find((x) => x.id === id);
    if (s) s.name = name;
    updateChrome();
    store.save();
  },
  onReorder: (fromId, toId) => {
    const { sessions } = store.state;
    const from = sessions.findIndex((s) => s.id === fromId);
    const to = sessions.findIndex((s) => s.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = sessions.splice(from, 1);
    sessions.splice(to, 0, moved);
    updateChrome();
    store.save();
  },
  onOpenSettings: toggleSettings,
  onOpenSessionSettings: (id) => {
    const s = store.state.sessions.find((x) => x.id === id);
    if (s) sessionSettings.open(s);
  },
  onOpenSessionStats: (id) => {
    const s = store.state.sessions.find((x) => x.id === id);
    if (s) void usagePanel.show(collectLeaves(s.tree), s.name, s.cwd);
  },
  onOpenGitMap: (id) => {
    const s = store.state.sessions.find((x) => x.id === id);
    if (s) gitMapPanel.show(s.cwd, s.name);
  },
  onOpenTasks: (id) => {
    const s = store.state.sessions.find((x) => x.id === id);
    if (s) tasksPanel.show(s);
  },
  onOpenInbox: toggleInbox,
  onOpenFile: openFile,
  onDropFileToPane: dropFileIntoPane,
  onDockFileToPane: dockFileFromSidebar,
  onConfirmDeleteFile: (name, isDir) =>
    confirm.ask({
      title: isDir ? "Delete folder?" : "Delete file?",
      message: `"${name}" will be moved to the Recycle Bin.`,
      confirmLabel: "Delete",
      danger: true,
    }),
});

const settingsView = createSettingsView({
  onSave: (draft) => {
    const shellChanged = draft.shellIntegration !== store.state.settings.shellIntegration;
    store.state.settings = draft;
    applySettingsLive();
    // Explicit toggle, so register even from a dev build (unlike the boot refresh).
    if (shellChanged) void syncShellIntegration(draft.shellIntegration);
    // Settings, key and theme tokens all feed the dictation agent's config.
    void syncDictation(draft);
  },
  onResetData: () => void resetAllData(),
  onReplayWelcome: () => {
    closeSettings();
    void runOnboarding({ applySettings: applySettingsLive, replay: true }).then((out) => {
      if (out.createSession) newSession({ ...out.createSession, count: 3 });
    });
  },
  onRestoreBackup: (backup) => restoreBackup(backup),
  onRestoreArchived: (id) => {
    const s = store.state.sessions.find((x) => x.id === id);
    if (!s?.archived) return;
    restoreArchivedSession(s);
    // Nothing else is open (everything was archived) — jump straight into it.
    if (!store.state.activeSessionId) setActiveSession(s.id);
  },
  onDeleteArchived: (id) => confirmCloseSession(id),
  onClose: closeSettings,
  onConfirm: (opts) => confirm.ask(opts),
});

const sessionSettings = createSessionSettings({
  onSave: (id, patch) => {
    const s = store.state.sessions.find((x) => x.id === id);
    if (!s) return;
    s.name = patch.name;
    s.color = patch.color;
    s.cwd = patch.cwd;
    updateChrome();
    store.save();
  },
});

const wizard = createWizard((r) => newSession(r));

const confirm = createConfirm();
const trashToast = createTrashToast();

const updatePopup = createUpdatePopup();

const usagePanel = createUsagePanel();

const gitMapPanel = createGitMapPanel();

const tasksPanel = createTasksPanel({
  onOpenFile: openFile,
  confirmDelete: (taskTitle) =>
    confirm.ask({
      title: "Delete task?",
      message: `“${taskTitle}” and its subtasks will be deleted. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    }),
  onChanged: () => updateChrome(),
  listOpenPanes: (): OpenPaneInfo[] => {
    const out: OpenPaneInfo[] = [];
    for (const s of store.state.sessions) {
      for (const id of collectLeaves(s.tree)) {
        const p = panes.get(id);
        if (!p) continue; // browser/external panes can't "finish"
        out.push({
          sessionId: s.id,
          sessionName: s.name,
          sessionColor: s.color,
          paneId: id,
          title: p.title,
          lastLine: p.snapshotText(1).trim(),
        });
      }
    }
    return out;
  },
  onDelegate: (session, task, agent, trigger) => delegateTask(session, task, agent, trigger),
  onCancelDelegate: (session, task) => cancelDelegation(session, task),
});

const inboxPanel = createInboxPanel({
  onGoToPane: (sessionId, paneId) => {
    setActiveSession(sessionId);
    if (paneId) requestAnimationFrame(() => focusPane(paneId));
  },
  onGoToTask: (sessionId, taskId) => {
    const s = store.state.sessions.find((x) => x.id === sessionId);
    if (s) tasksPanel.show(s, taskId);
  },
  onGoToSettings: () => openSettings(),
  onUpdateHarness: (item) => void updateHarnessFromInbox(item),
  onReviewGithub: (item, agent) => void reviewGithubWithAgent(item, agent),
});

const fileViewer = createFileViewerPanel({ onRequestClose: () => void requestCloseFile() });

// ------------------------------------------------- docked file panes
//
// A file lives in one of two spaces: the full-screen viewer, or a tiled pane
// beside the terminals. Alt+drag the viewer's title bar to dock it; the pane's
// expand button (or Alt+drag its bar) lifts it back. Both directions run the
// same morph: a still of the surface flies between the two rects while the real
// surface is rebuilt underneath it, so the file reads as one object being
// moved rather than two panels swapping.

/** Whichever live element currently hosts `id` -- terminal, browser or file. */
function paneElement(id: string): HTMLElement | undefined {
  return (panes.get(id) ?? browserPanes.get(id) ?? filePanes.get(id))?.el;
}

function createPaneFile(id: string, path: string, name: string): PaneFile {
  const p = new PaneFile(id, path, name, {
    onFocus: (pid) => {
      const s = sessionOfPane(pid);
      if (!s) return;
      focusedPane.set(s.id, pid);
      updateFocusRing();
    },
    onSplit: (pid, dir) => splitPane(pid, dir),
    onClose: (pid) => closePane(pid),
    onMove: (src, target, region) => movePane(src, target, region),
    onToggleZoom: (pid) => zoomPaneById(pid),
    onToggleFold: (pid) => foldPaneById(pid),
    onExpand: (pid) => expandFilePane(pid),
  });
  filePanes.set(id, p);
  return p;
}

/** Unsaved text a surface is holding, if any -- handed to the surface on the
 *  other side so a dock/expand never costs the user an edit. */
function pendingTextOf(surface: {
  isPreview(): boolean;
  flush(): boolean;
  isDirty(): boolean;
  text(): string;
}): string | undefined {
  if (surface.isPreview()) return undefined;
  if (!surface.flush()) return undefined;
  return surface.isDirty() ? surface.text() : undefined;
}

/** Commits the dock: inserts a file leaf next to `targetId` and hands it the
 *  viewer's file (plus any unsaved text). Returns the new pane, still hidden,
 *  for the drag card to land on. */
function insertFilePane(
  session: Session,
  targetId: string,
  region: DropRegion,
  path: string,
  name: string
): PaneFile | null {
  const newId = uid();
  // Centre-drop has no "swap" meaning for a pane that isn't in the tree yet,
  // so it lands as a plain split to the right -- the least surprising default.
  const dir: Dir = region === "e" || region === "w" || region === "c" ? "row" : "col";
  const before = region === "w" || region === "n";
  session.tree = splitLeaf(session.tree, targetId, dir, newId, before);
  const leaf = findLeaf(session.tree, newId);
  if (!leaf) return null;
  leaf.kind = "file";
  leaf.filePath = path;
  leaf.fileName = name;
  session.zoomed = null;
  return createPaneFile(newId, path, name);
}

function dockFileHere(targetId: string, region: DropRegion): PaneFile | null {
  const session = activeSession();
  if (!session || !openFilePath) return null;
  const pending = pendingTextOf(fileViewer);
  const pane = insertFilePane(session, targetId, region, openFilePath, openFileName);
  if (!pane) return null;
  pane.el.classList.add("file-morph-arriving");
  closeFile();
  rerender(session);
  void pane.open(pending);
  store.save(true);
  return pane;
}

/** Ctrl+Alt+drag of a row in the sidebar's Files view: the file skips the
 *  full-screen viewer entirely and lands straight in the grid as a pane. Plain
 *  (and Alt-only) drags still type the path into a terminal -- see
 *  dropFileIntoPane -- so the existing gesture is untouched. */
function dockFileFromSidebar(
  path: string,
  name: string,
  targetId: string,
  region: DropRegion,
  at: { x: number; y: number }
): void {
  const session = sessionOfPane(targetId);
  if (!session) return;
  const pane = insertFilePane(session, targetId, region, path, name);
  if (!pane) return;
  rerender(session);
  void pane.open();
  requestAnimationFrame(() => {
    materializeIn(pane.el, at);
    focusPane(pane.id);
  });
  store.save(true);
}

/** Lifts a docked file pane back into the full-screen viewer. */
function expandFilePane(id: string): void {
  const pane = filePanes.get(id);
  const session = sessionOfPane(id);
  if (!pane || !session || fileViewerOpen) return;

  const from = rectOf(pane.el);
  const source = pane.el;
  const pending = pendingTextOf(pane.surface);
  const { path, name } = pane;

  // Take the leaf out; a session must never be left with no panes at all, so a
  // lone file pane hands its slot to a fresh terminal.
  const without = removeLeaf(session.tree, id);
  vacateLeaf(id);
  if (without) {
    session.tree = without;
  } else {
    const fresh = uid();
    createPaneTerm(fresh);
    session.tree = { type: "leaf", id: fresh };
  }
  session.zoomed = null;

  // The still is taken before the source leaves the DOM; the viewer opens
  // invisibly beneath the flight and is revealed on landing.
  openFile(path, name, pending);
  main.classList.add("file-morph-arriving-view");
  rerender(session);

  requestAnimationFrame(() => {
    const to = rectOf(fileViewer.el);
    morphSurface(source, from, to, {
      duration: 460,
      onDone: () => {
        main.classList.remove("file-morph-arriving-view");
        settleIn(fileViewer.el, 0);
        fileViewer.focus();
      },
    });
  });
  store.save(true);
}

// ---- Alt+drag the viewer's title bar: eject into the pane grid ----

/** The card flown by the eject drag: a still of the viewer, so the real editor
 *  is never re-laid-out mid-gesture. */
function makeDragCard(source: HTMLElement, from: Rect): HTMLElement {
  const card = document.createElement("div");
  card.className = "file-drag-card";
  card.style.width = from.w + "px";
  card.style.height = from.h + "px";
  const clone = source.cloneNode(true) as HTMLElement;
  clone.classList.add("file-morph-inner");
  clone.removeAttribute("data-pane-id");
  card.appendChild(clone);
  document.body.appendChild(card);
  return card;
}

function bindFileEject(bar: HTMLElement): void {
  // Alt over the bar pre-announces the gesture, so the affordance is
  // discoverable without a tooltip hunt.
  const syncAffordance = (alt: boolean) => bar.classList.toggle("liftable", alt && fileViewerOpen);
  window.addEventListener("keydown", (e) => syncAffordance(e.altKey));
  window.addEventListener("keyup", (e) => syncAffordance(e.altKey));
  window.addEventListener("blur", () => syncAffordance(false));

  bar.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0 || !e.altKey || !fileViewerOpen) return;
    if ((e.target as HTMLElement).closest("button")) return;
    if (!activeSession()) return;

    e.preventDefault();
    const pointerId = e.pointerId;
    const from = rectOf(fileViewer.el);
    const startX = e.clientX;
    const startY = e.clientY;
    // Where inside the panel the grab happened, so the card hangs off the
    // cursor at the same relative spot -- it feels picked up, not teleported.
    const grabU = (startX - from.x) / Math.max(1, from.w);
    const grabV = (startY - from.y) / Math.max(1, from.h);

    let card: HTMLElement | null = null;
    let dragging = false;
    let scale = 1;
    let targetEl: HTMLElement | null = null;
    let region: DropRegion | null = null;
    let raf = 0;
    let px = from.x;
    let py = from.y;
    let tx = from.x;
    let ty = from.y;
    let tilt = 0;
    let finished = false;

    const CARD_W = 380; // on-screen width of the picked-up card

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!card) return;
      // The card trails the cursor slightly and banks into the direction of
      // travel; instant snapping is what makes a drag read as cheap.
      const dx = tx - px;
      px += dx * 0.24;
      py += (ty - py) * 0.24;
      tilt += (Math.max(-5, Math.min(5, dx * 0.12)) - tilt) * 0.18;
      card.style.transform =
        "translate3d(" + px + "px, " + py + "px, 0) scale(" + scale + ") rotate(" + tilt + "deg)";
    };

    const place = (x: number, y: number) => {
      tx = x - grabU * from.w * scale;
      ty = y - grabV * from.h * scale;
    };

    const cleanup = () => {
      cancelAnimationFrame(raf);
      document.body.classList.remove("dragging-pane", "dragging-file-dock");
      main.classList.remove("file-ejecting");
      clearHints();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };

    /** Flies the card back into the full-screen viewer and restores it. */
    const abort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!card) return;
      const c = card;
      main.classList.add("file-morph-arriving-view");
      const back = c.animate(
        [
          { transform: c.style.transform },
          { transform: "translate3d(" + from.x + "px, " + from.y + "px, 0) scale(1) rotate(0deg)" },
        ],
        { duration: 340, easing: "cubic-bezier(0.22, 0.9, 0.24, 1)", fill: "forwards" }
      );
      const land = () => {
        c.remove();
        main.classList.remove("file-morph-arriving-view");
      };
      back.addEventListener("finish", land);
      back.addEventListener("cancel", land);
    };

    const commit = () => {
      if (finished) return;
      const target = targetEl?.isConnected ? targetEl.dataset.paneId : null;
      if (!target || !region || !card) return abort();
      finished = true;
      const held = card.style.transform;
      cleanup();
      const pane = dockFileHere(target, region);
      if (!pane) return abort();
      const c = card;
      requestAnimationFrame(() => {
        const to = rectOf(pane.el);
        const landed =
          "translate3d(" + to.x + "px, " + to.y + "px, 0) scale(" +
          to.w / from.w + ", " + to.h / from.h + ") rotate(0deg)";
        const fly = c.animate(
          [
            { transform: held, opacity: 1 },
            { transform: landed, opacity: 1, offset: 0.85 },
            { transform: landed, opacity: 0 },
          ],
          { duration: 440, easing: "cubic-bezier(0.22, 0.9, 0.24, 1)", fill: "forwards" }
        );
        const land = () => {
          c.remove();
          pane.el.classList.remove("file-morph-arriving");
          settleIn(pane.el, 0);
          focusPane(pane.id);
        };
        fly.addEventListener("finish", land);
        fly.addEventListener("cancel", land);
      });
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      abort();
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        dragging = true;
        scale = Math.min(0.5, CARD_W / Math.max(1, from.w));
        card = makeDragCard(fileViewer.el, from);
        card.style.transform = "translate3d(" + from.x + "px, " + from.y + "px, 0) scale(1)";
        // Reveal the grid behind the viewer so there is something to drop onto.
        main.classList.add("file-ejecting");
        document.body.classList.add("dragging-pane", "dragging-file-dock");
        // One frame at full size, then the shrink -- the panel visibly becomes
        // a card in the hand instead of appearing as one.
        card.getBoundingClientRect();
        px = from.x;
        py = from.y;
        raf = requestAnimationFrame(tick);
      }
      place(ev.clientX, ev.clientY);

      const hit = resolveDrop(ev.clientX, ev.clientY, "", false, (el: HTMLElement) => !!el.dataset.paneId);
      if (targetEl && targetEl !== hit?.el) clearHints();
      targetEl = hit?.el ?? null;
      region = hit?.region ?? null;
      if (hit) setHint(hit.el, hit.hint);
      card?.classList.toggle("armed", !!hit);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) return cleanup();
      commit();
    };
    const onCancel = () => abort();

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  });
}

bindFileEject(fileViewer.header);

const searchModal = createSearchModal({
  getFocusedPane: () => {
    const session = activeSession();
    const focused = session ? focusedPane.get(session.id) : undefined;
    return focused ? panes.get(focused) ?? null : null;
  },
});

/** Chords a focused code editor keeps for itself even when they're also bound
 *  to an app action: the clipboard/undo essentials, where taking them away
 *  would break editing outright. Everything else the user has bound (fold,
 *  expand, split, focus, sidebar...) wins over CodeMirror's own defaults, so a
 *  docked file pane answers the same shortcuts as any other pane. */
const EDITOR_OWNED_CHORDS = new Set([
  "Ctrl+C",
  "Ctrl+X",
  "Ctrl+V",
  "Ctrl+A",
  "Ctrl+Z",
  "Ctrl+Y",
  "Meta+C",
  "Meta+X",
  "Meta+V",
  "Meta+A",
  "Meta+Z",
  "Meta+Y",
]);

/** Runs a bound app action from inside a focused editor, if this keystroke is
 *  one the editor shouldn't swallow. Plain typing (and Shift+typing) always
 *  stays with the editor; only modified chords and F-keys can escape. */
function runEditorEscapeHatch(e: KeyboardEvent): void {
  const isChordLike = e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key);
  if (!isChordLike) return;
  const chord = chordFromEvent(e);
  if (!chord || EDITOR_OWNED_CHORDS.has(chord)) return;
  const action = actionForChord(store.state.settings.keybinds, chord);
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  runAction(action, e);
}

window.addEventListener(
  "keydown",
  (e) => {
    if (recorder.active) return;
    if (updatePopup.isOpen()) return; // modal handles its own keys
    if (confirm.isOpen()) return; // modal handles its own keys
    if (usagePanel.isOpen()) return; // panel handles its own keys
    if (gitMapPanel.isOpen()) return; // panel handles its own keys
    if (inboxPanel.isOpen()) return; // panel handles its own keys
    // tasksPanel is intentionally not blanket-guarded here (unlike the modals above) —
    // its own Escape handling still runs (nothing here is bound to bare Escape), and
    // this lets its own open/close chord (openTasks) toggle it shut, matching settings.
    if (wizard.isOpen()) return; // wizard handles its own keys
    if (sessionSettings.isOpen()) return; // modal handles its own keys
    if (searchModal.isOpen()) return; // popup handles its own keys
    // Esc leaves an active highlight-search preview (popup already closed —
    // see searchModal.ts) without letting the Esc keystroke reach the pane.
    if (searchModal.hasActivePreview() && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      searchModal.clearActivePreview();
      return;
    }
    if (fileViewerOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        void requestCloseFile();
        return;
      }
      const isSaveChord = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s";
      if (isSaveChord) {
        e.preventDefault();
        e.stopPropagation();
        void fileViewer.save();
        return;
      }
      // While the editor has focus it owns typing and its own editing chords,
      // but app-level shortcuts still get their turn (see runEditorEscapeHatch).
      if (fileViewer.containsFocus(document.activeElement)) {
        runEditorEscapeHatch(e);
        return;
      }
    }
    // A docked file pane behaves like the viewer for the keys that matter:
    // Ctrl+S saves it, and while its editor has focus it owns typing — but not
    // the app-level chords (fold, expand, split, focus...), which must keep
    // working on a file pane exactly as they do on a terminal pane.
    if (!fileViewerOpen && filePanes.size) {
      const focusedFile = [...filePanes.values()].find((p) =>
        p.containsFocus(document.activeElement)
      );
      if (focusedFile) {
        const isSaveChord = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s";
        if (isSaveChord) {
          e.preventDefault();
          e.stopPropagation();
          void focusedFile.save();
          return;
        }
        // The pane the chord should act on is the one being typed in, even if
        // the click that focused it never ran (a fresh Ctrl+Alt drop focuses
        // the editor directly).
        const s = sessionOfPane(focusedFile.id);
        if (s && focusedPane.get(s.id) !== focusedFile.id) {
          focusedPane.set(s.id, focusedFile.id);
          updateFocusRing();
        }
        runEditorEscapeHatch(e);
        return;
      }
    }
    if (settingsOpen && e.key === "Escape") {
      e.preventDefault();
      closeSettings();
      return;
    }
    // Alt+1..9 → jump to session
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      const s = visibleSessions()[Number(e.key) - 1];
      if (s) {
        e.preventDefault();
        e.stopPropagation();
        setActiveSession(s.id);
      }
      return;
    }
    if (e.key === "Escape" && cheatEl.classList.contains("visible")) {
      cheatEl.classList.remove("visible");
      return;
    }
    // ---- revive: any keystroke that lands on nothing goes back to the pane.
    //
    // DOM focus can end up on <body>: coming back from another app, or after a
    // click on inert chrome (a divider, a panel background). The selected pane
    // is still the logical target, so *every* key in that state first restores
    // focus to it, and then does its normal job — a bound chord runs its action
    // below, and a typed character is forwarded to the PTY by hand, since xterm
    // never saw this event (it wasn't focused when the key fired).
    const chordNow = chordFromEvent(e);
    const boundAction = chordNow
      ? actionForChord(store.state.settings.keybinds, chordNow)
      : null;
    if (
      // Anything genuinely focusable (a field, a button, a menu item) keeps
      // its keys — this is only for focus sitting on nothing.
      !document.activeElement?.closest(
        ".xterm-helper-textarea, input, textarea, select, button, a[href], [tabindex], [contenteditable='true'], .cm-content"
      ) &&
      !anyOverlayOpen()
    ) {
      const s = activeSession();
      const focused = s ? focusedPane.get(s.id) : undefined;
      if (focused && (panes.has(focused) || browserPanes.has(focused) || filePanes.has(focused))) {
        focusPane(focused);
        // A bound chord falls through to the dispatcher below so the action
        // still runs on this very keypress.
        if (!boundAction) {
          const printable =
            e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
          if (printable && panes.has(focused)) {
            void writePty(focused, e.key);
            e.preventDefault();
            e.stopPropagation();
          }
          // Enter (and everything else unbound) just lands you back in the
          // pane without typing anything — matching what a click would do.
          return;
        }
      }
    }
    if (!boundAction) return;
    const action = boundAction;
    // Don't hijack plain unmodified keys (except F-keys) while typing in inputs
    const inInput =
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLSelectElement;
    if (inInput && !e.ctrlKey && !e.altKey && !e.metaKey && !/^F\d+$/.test(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    runAction(action, e);
  },
  true
);

cheatEl.addEventListener("click", (e) => {
  if (e.target === cheatEl) cheatEl.classList.remove("visible");
});

// Self-heal: if the mouse is released outside the OS window during a pane drag,
// the webview never sees pointerup. Losing focus clears the stranded drag state
// (grabbing cursor + drop overlays that would otherwise swallow all input).
window.addEventListener("blur", () => {
  document.body.classList.remove("dragging-pane");
  document.querySelectorAll<HTMLElement>(".drag-ghost").forEach((g) => g.remove());
});

/** Puts DOM focus back on the selected pane. Switching to another app and back
 *  used to leave the webview with focus on nothing: keystrokes went nowhere,
 *  not even the keybind handler ran, and only a mouse click revived the pane.
 *  The Rust side hands keyboard focus back to the webview on activation
 *  (`focus_main_webview`); this puts it back on the right terminal inside it.
 *  Skipped while an overlay or a text field owns focus so we never steal from
 *  settings, the editor or a search box. */
function restorePaneFocus(): void {
  if (anyOverlayOpen()) return;
  if (
    document.activeElement?.closest(
      "input, textarea, select, [contenteditable='true'], .cm-content"
    )
  )
    return;
  const s = activeSession();
  const id = s ? focusedPane.get(s.id) : undefined;
  if (id && (panes.has(id) || browserPanes.has(id))) focusPane(id);
}

window.addEventListener("focus", () => requestAnimationFrame(restorePaneFocus));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) requestAnimationFrame(restorePaneFocus);
});
// Emitted after the backend re-points Windows keyboard focus at our webview,
// which is the case a plain "focus" event can miss (the DOM never saw focus
// leave, because the webview child never had it to begin with).
void listen("window-focused", () => requestAnimationFrame(restorePaneFocus));

/** Dictation finished a recording that was started in another pane and wants
 *  the transcript to land there. The window is already back in front (the
 *  dictation process does that); we switch session and pane, then let the
 *  focused-pane publish tell it that it can type. */
void listen<string>("dictation-focus-pane", (e) => {
  const paneId = e.payload;
  const session = sessionOfPane(paneId);
  if (!session) return;
  if (store.state.activeSessionId !== session.id) setActiveSession(session.id);
  focusPane(paneId);
  requestAnimationFrame(() => focusPane(paneId));
});

window.addEventListener("resize", () => {
  const s = activeSession();
  if (s) fitSessionSoon(s);
  syncAllExternal();
  syncAllBrowsers();
});

// Child browser webviews always sit ABOVE the main webview's DOM, so while any
// overlay covers the session area they must be hidden. Poll rather than chase
// every toggle point — cheap, and immune to future panels forgetting to notify.
function anyOverlayOpen(): boolean {
  return (
    settingsOpen ||
    fileViewerOpen ||
    wizard.isOpen() ||
    sessionSettings.isOpen() ||
    searchModal.isOpen() ||
    confirm.isOpen() ||
    updatePopup.isOpen() ||
    usagePanel.isOpen() ||
    gitMapPanel.isOpen() ||
    inboxPanel.isOpen() ||
    tasksPanel.isOpen() ||
    sidebar.isAddMenuOpen()
  );
}

function refreshBrowserSuppression(): void {
  setBrowserOverlaysOpen(anyOverlayOpen());
}
window.setInterval(refreshBrowserSuppression, 200);

// Suppress the WebView's native context menu (Inspect Element, Reload, etc.)
// everywhere except editable text (inputs, the rename fields, the file
// editor's CodeMirror content) where the OS's cut/copy/paste menu is useful.
// Custom menus we build ourselves (session ⋮, file-tree row) call
// preventDefault()+stopPropagation() on their own "contextmenu" listener, so
// this only ever fires for the rest of the app's chrome — including terminal
// panes, which have none of their own.
window.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  const editable = target?.closest('input, textarea, [contenteditable="true"], .cm-content');
  if (!editable) e.preventDefault();
});

onPtyOutput((id, data) => {
  const p = panes.get(id);
  if (p) {
    p.write(data);
    feedPaneOutput(id, data);
    notifyPaneOutput(id);
    trackPaneActivity(id);
  } else {
    navSinks.get(id)?.(data);
  }
});
onPtyExit((id) => {
  // Only auto-close if the pane still exists (user typed `exit` / process died) —
  // an app-initiated close already removes it from `panes` before this fires.
  const session = sessionOfPane(id);
  if (panes.has(id) && session) {
    addInboxItem({
      kind: "process-exited",
      message: "A terminal process exited",
      sessionId: session.id,
      sessionName: session.name,
      paneId: id,
    });
    closePane(id);
  }
});

// Aggregate per-pane state up to the owning session, so a session tucked away
// in the sidebar shows its dot even while a different one is active.
onAttentionChange(refreshSessionStatus);

// Mid-turn detection reads what a pane is actually painting, not the bytes that
// flowed through it — main.ts owns the pane registry, so it supplies the reader.
setPaneScreenReader((id, count) => panes.get(id)?.screenTail(count) ?? null);

// ---------------------------------------------------- external terminal drag
//
// A terminal window the user never opened from OpenTerm can be dragged in from
// the OS and docked into a pane. Windows gives no cross-process notification of
// such a drag, so the Rust backend runs a low-level mouse hook that detects a
// foreign terminal window being dragged over our window and streams these
// events. All state below is driven purely by those events — during the drag
// the pointer belongs to the other process, so our webview sees nothing itself.

interface ExtDragMove {
  x: number; // cursor, physical px, relative to our window's client area
  y: number;
  title: string;
}
interface ExtDragDrop extends ExtDragMove {
  hwnd: string;
}

let extDragging = false;
let extTargetEl: HTMLElement | null = null;

const extGhost = document.createElement("div");
extGhost.className = "ext-drag-ghost";

/** Resolve the pane + drop region under a client-physical cursor point. */
function extResolve(px: number, py: number): { el: HTMLElement | null; region: DropRegion | null } {
  const dpr = window.devicePixelRatio || 1;
  const cx = px / dpr;
  const cy = py / dpr;
  const el = document.elementFromPoint(cx, cy)?.closest<HTMLElement>(".pane") ?? null;
  if (!el || !el.dataset.paneId) return { el: null, region: null };
  const r = el.getBoundingClientRect();
  return { el, region: dropRegion((cx - r.left) / r.width, (cy - r.top) / r.height) };
}

function extPlaceGhost(px: number, py: number, title: string): void {
  const dpr = window.devicePixelRatio || 1;
  extGhost.textContent = `⤵  Dock “${title || "terminal"}”`;
  extGhost.style.transform = `translate(${px / dpr + 16}px, ${py / dpr + 18}px)`;
}

function extEnter(): void {
  if (extDragging) return;
  extDragging = true;
  document.body.classList.add("ext-dragging");
  if (!extGhost.isConnected) document.body.appendChild(extGhost);
}

function extClearHint(): void {
  if (extTargetEl) setHint(extTargetEl, null);
  extTargetEl = null;
}

function extEnd(): void {
  extDragging = false;
  document.body.classList.remove("ext-dragging");
  extGhost.remove();
  clearHints();
  extTargetEl = null;
}

function onExtDragMove(p: ExtDragMove): void {
  // Only react while there's a visible session to drop into.
  if (!store.state.settings.externalTerminalDrag || !activeSession() || settingsOpen || fileViewerOpen) {
    if (extDragging) extEnd();
    return;
  }
  extEnter();
  extPlaceGhost(p.x, p.y, p.title);
  const { el, region } = extResolve(p.x, p.y);
  if (extTargetEl && extTargetEl !== el) setHint(extTargetEl, null);
  extTargetEl = el;
  if (el && region) setHint(el, region);
}

function onExtDragDrop(p: ExtDragDrop): void {
  const active =
    store.state.settings.externalTerminalDrag && activeSession() && !settingsOpen && !fileViewerOpen;
  const { el, region } = active ? extResolve(p.x, p.y) : { el: null, region: null };
  extEnd();
  if (el?.dataset.paneId && region) embedExternal(p.hwnd, p.title, el.dataset.paneId, region);
}

void listen<ExtDragMove>("ext-drag-move", (e) => onExtDragMove(e.payload));
void listen("ext-drag-leave", () => extClearHint());
void listen<ExtDragDrop>("ext-drag-drop", (e) => onExtDragDrop(e.payload));
void listen("ext-drag-cancel", () => extEnd());

// Surface an available update in the inbox too — the startup popup can be
// dismissed with "Later" and the update stays reachable only from Settings
// otherwise. `announcedUpdate` keeps this to one inbox item per app run.
let announcedUpdate = false;
onUpdateState((s) => {
  if (s.phase === "available" && !announcedUpdate) {
    announcedUpdate = true;
    addInboxItem({ kind: "update-available", message: `OpenTerm ${s.newVersion} is available` });
  }
});

// ---------------------------------------------------------------- boot

async function boot(): Promise<void> {
  // Clicking the space a fully folded group left behind fills it with a fresh
  // terminal, in that group's own direction.
  setFoldGapHandler((targetId, dir, duplicate) => splitPane(targetId, dir, duplicate));
  setInboxKindFilter((kind) => store.state.settings.inboxNotifications[kind] !== false);
  // Before load(): recovering from a backup raises an inbox item during it, and
  // that item should get a name like every other.
  startInboxAi();
  await store.load();
  scanTaskDueDates();
  window.setInterval(scanTaskDueDates, 5 * 60 * 1000);
  window.setInterval(() => void pollLiveHarnesses(), LIVE_HARNESS_POLL_MS);

  // First check shortly after boot (let startup settle), then on a timer —
  // covers sessions the user never even switches to this run.
  window.setTimeout(() => void checkAllSessionsGithubStatus(), 8000);
  window.setInterval(() => void checkAllSessionsGithubStatus(), GITHUB_CHECK_INTERVAL_MS);

  // Same idea for the agent CLIs themselves: a first pass shortly after boot,
  // then a slow heartbeat.
  onHarnessState((st) => {
    if (st.phase === "done") applyHarnessResults(st.results);
  });
  window.setTimeout(() => void runHarnessCheck(), 12000);
  window.setInterval(() => void runHarnessCheck(), HARNESS_CHECK_INTERVAL_MS);

  // Grab this before anything renders: it decides whether an empty app shows the
  // new-session wizard or goes straight to the folder Explorer handed us.
  let launchFolder = await takeLaunchFolder();
  onOpenFolder(openFolderSession);

  main.append(viewsEl, emptyEl, settingsView.el, fileViewer.el);
  appBody.append(sidebar.el, sidebarResizer, main);
  root.append(
    titlebar.el,
    appBody,
    cheatEl,
    wizard.el,
    sessionSettings.el,
    usagePanel.el,
    tasksPanel.el,
    confirm.el,
    updatePopup.el,
    searchModal.el,
    trashToast.el
  );
  setupSidebarResize();

  applySettingsLive();
  // Re-check the minimum once the kbd label is rendered and fonts have loaded.
  void document.fonts.ready.then(() =>
    requestAnimationFrame(() => {
      const min = sidebarMinWidth();
      if (store.state.settings.sidebarWidth < min) applySettingsLive();
    })
  );
  initExternalFileDrop(typePathsIntoPane);
  initBrowserEvents();

  // Blocks the rest of boot on purpose: a first-run user should meet the
  // welcome, not a half-built workspace behind it. Theme and font picks inside
  // it are applied live, so nothing needs re-applying afterwards.
  let onboarding: OnboardingOutcome | null = null;
  if (shouldRunOnboarding() || onboardingForcedByUrl()) {
    onboarding = await runOnboarding({
      applySettings: applySettingsLive,
      folder: launchFolder,
    });
    // The welcome already asked which folder to open, so don't ask again.
    if (onboarding.createSession) launchFolder = null;
  }

  const bootVisible = visibleSessions();
  if (bootVisible.length === 0) {
    store.state.activeSessionId = null; // may point at an archived session
    if (onboarding?.createSession) newSession({ ...onboarding.createSession, count: 3 });
    else if (!launchFolder) openWizard();
  } else {
    for (const session of bootVisible) {
      for (const id of collectLeaves(session.tree)) {
        const leaf = findLeaf(session.tree, id);
        // Browser panes come back too (their URL is persisted in the leaf);
        // external windows were pruned at load, so they can't appear here.
        if (leaf?.kind === "file") {
          if (leaf.filePath) {
            const fp = createPaneFile(id, leaf.filePath, leaf.fileName ?? leaf.filePath);
            void fp.open();
          }
        } else if (leaf?.kind === "browser")
          createPaneBrowser(id, leaf.url ?? "", leaf.pageTitle ?? "", leaf.device, leaf.landscape);
        else createPaneTerm(id, leaf?.customName);
      }
      rerender(session);
    }
    const active =
      bootVisible.find((s) => s.id === store.state.activeSessionId) ?? bootVisible[0];
    setActiveSession(active.id);
  }

  // Re-arm delegations that outlived a restart: timers for scheduled ones,
  // watcher registration for waiting ones. A delegation that was mid-run when
  // the app closed can't be trusted as done — mark it failed so the user sees it.
  let rearmDirty = false;
  for (const s of store.state.sessions) {
    for (const t of sessionTasks(s)) {
      const d = t.delegation;
      if (!d) continue;
      if (d.status === "running") {
        d.status = "failed";
        rearmDirty = true;
      } else if (d.status === "scheduled" || d.status === "waiting") {
        armDelegation(s, t);
        rearmDirty = true;
      }
    }
  }
  if (rearmDirty) store.save();
  // After restoring, so a folder that already has a session focuses it rather
  // than creating a second one for the same path.
  if (launchFolder) openFolderSession(launchFolder);

  updateEmptyState();
  updateChrome();

  // Keep the registry pointing at the current binary — the path moves on update.
  void syncShellIntegration(store.state.settings.shellIntegration, true);

  // Start (or stop) the dictation agent to match settings, and honor a launch
  // from its tray menu's "Dictation settings…".
  void syncDictation(store.state.settings);
  if (await invoke<boolean>("dictation_take_open_settings").catch(() => false)) openDictationSettings();

  // Fire-and-forget: a failed check must never block or delay startup.
  void checkForUpdate();
}

void boot();
