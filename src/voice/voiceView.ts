/** Voice mode for the Agents panel: a live, spoken conversation with the
 *  assistant that takes over the whole panel while it runs.
 *
 *  It is the same assistant as the typed chat. Tool calls go through
 *  Conversation.runExternal, so the mode, permissions, approval cards and
 *  watches all behave as they do for a typed question. What was said is kept
 *  as ordinary chat messages; when the session ends they move into the chat
 *  thread and its history, and the user carries on by typing. */

import { store } from "../store";
import { icon, type IconName } from "../agentsIcons";
import type { ActionHost, ActionPlan } from "../agentsActions";
import { terminalsSnapshot, toolDefsFor, type ActionStep, type Conversation } from "../agentsAssistant";
import type { ModeDef } from "../agentsModes";
import type { Scope } from "../agentsData";
import type { AssistantPerm } from "../types";
import { VoiceAudio } from "./audio";
import { DEFAULT_LIVE_MODEL, DEFAULT_VOICE, LiveSession, type LiveState, type LiveToolCall } from "./liveSession";
import { LIST_TOOL, voiceSystemPrompt, voiceTools } from "./prompt";

export interface VoiceDeps {
  conversation: Conversation;
  host: ActionHost;
  scope(): Scope;
  mode(): ModeDef;
  openAiSettings(): void;
  /** The chat's own renderers, so a voice message looks like a typed one. */
  renderAnswer(text: string): string;
  toolIcon(tool: string): IconName;
  watch(paneId: string, note: string): string | null;
  requestApproval(plan: ActionPlan, signal: AbortSignal, container: HTMLElement): Promise<boolean>;
  showAction(plan: ActionPlan | null, step: ActionStep, container: HTMLElement): void;
  /** The session is over: these messages now belong to the chat thread. */
  onEnd(messages: HTMLElement[]): void;
}

type Phase = "connecting" | "listening" | "speaking" | "working" | "approval" | "muted" | "reconnecting" | "error";

const PHASE_LABEL: Record<Phase, string> = {
  connecting: "Connecting",
  listening: "Listening",
  speaking: "Speaking",
  working: "Working",
  approval: "Needs your OK",
  muted: "Muted",
  reconnecting: "Reconnecting",
  error: "Voice stopped",
};

/** Conversation handed to a reconnect that couldn't resume on the server. */
const RECAP_TURNS = 24;
const RECAP_MAX_CHARS = 6000;
const LEAVE_MS = 200;

/** The two things voice mode can show. Both are driven by the same inputs,
 *  the phase on the root and --lvl on this element; voice.css does the rest. */
/** Depth for the character avatars: copies of a shape stacked back along Z
 *  (voice.css spaces and tapers them by --i), which reads as a solid body
 *  once the avatar turns. */
const slabs = (cls: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `<span class="${cls}" style="--i:${i + 1}"></span>`).join("");
const ORB_HTML = `<i class="vo-halo"></i><i class="vo-ring"></i><i class="vo-core"></i>`;
const BUDDY_HTML = `<i class="vo-halo"></i>
  <div class="vb">
    <span class="vb-ant"></span>
    <div class="vb-body">
      ${slabs("vb-s", 8)}
      <div class="vb-face">
        <span class="vb-brow l"></span><span class="vb-brow r"></span>
        <span class="vb-eye l"><b></b></span><span class="vb-eye r"><b></b></span>
        <span class="vb-cheek l"></span><span class="vb-cheek r"></span>
        <span class="vb-mouth"></span>
      </div>
    </div>
    <span class="vb-z">z</span><span class="vb-z two">z</span>
  </div>`;
const BYTE_HTML = `<i class="vo-halo"></i>
  <div class="vt">
    <span class="vt-ant"></span><span class="vt-ant r"></span>
    <span class="vt-foot l"></span><span class="vt-foot r"></span>
    <div class="vt-case">
      ${slabs("vt-slab", 8)}
      <div class="vt-screen">
        <span class="vt-eye l"></span><span class="vt-eye r"></span>
        <div class="vt-eq"><b></b><b></b><b></b><b></b><b></b><b></b><b></b></div>
        <span class="vt-msg"></span>
      </div>
      <span class="vt-led"></span>
    </div>
  </div>`;
const AVATAR_HTML = { orb: ORB_HTML, buddy: BUDDY_HTML, byte: BYTE_HTML };

interface Turn {
  role: "user" | "assistant";
  text: string;
  el: HTMLElement;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "OpenTerm isn't allowed to use the microphone. Allow it when asked, or in Windows Settings under Privacy, Microphone.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Plug one in and try again.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `Couldn't start the microphone. ${err instanceof Error ? err.message : String(err)}`;
}

export function createVoiceView(deps: VoiceDeps) {
  const el = document.createElement("section");
  el.className = "ap-voice";
  el.hidden = true;
  el.tabIndex = -1;
  el.setAttribute("aria-label", "Voice conversation");
  el.innerHTML = `
    <header class="vo-head">
      <span class="vo-status" role="status"><i></i><span class="vo-status-text"></span></span>
      <span class="vo-time"></span>
      <span class="vo-mode"></span>
    </header>
    <div class="vo-stage">
      <div class="vo-orb" aria-hidden="true"></div>
      <p class="vo-hint"></p>
    </div>
    <div class="vo-feed"></div>
    <footer class="vo-controls">
      <button class="vo-btn vo-mute" aria-pressed="false"></button>
      <button class="vo-btn vo-end">${icon("chat", 15)}<span>End, continue in chat</span></button>
    </footer>
  `;
  const $ = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
  const statusText = $(".vo-status-text");
  const timeEl = $(".vo-time");
  const modeEl = $(".vo-mode");
  const orb = $(".vo-orb");
  const hint = $(".vo-hint");
  const feed = $(".vo-feed");
  const muteBtn = $<HTMLButtonElement>(".vo-mute");
  const endBtn = $<HTMLButtonElement>(".vo-end");
  const endLabel = $(".vo-end span");

  let live: LiveSession | null = null;
  let audio: VoiceAudio | null = null;
  let abort: AbortController | null = null;
  /** Aborts the tool batch in flight when the model cancels it. */
  let batch: AbortController | null = null;
  let active = false;
  let liveState: LiveState = "closed";
  let errorMsg = "";
  let mode: ModeDef = deps.mode();
  let scope: Scope = "all";
  let allowed = new Set<string>();
  let turns: Turn[] = [];
  let curUser: Turn | null = null;
  let curAi: Turn | null = null;
  let working = 0;
  let approvals = 0;
  let startedAt = 0;
  let frame = 0;
  let level = 0;
  let shownPhase: Phase | null = null;
  let shownClock = "";
  let leaveTimer: number | null = null;
  // A character avatar's eyes (Buddy or Byte): where it wants to look, where
  // it is looking, and when it next glances away or blinks.
  let isBuddy = false;
  let lookX = 0;
  let lookY = 0;
  let gazeX = 0;
  let gazeY = 0;
  let lookUntil = 0;
  let nextGlance = 0;
  let nextBlink = 0;

  // ------------------------------------------------------------ transcript

  function pin(): void {
    feed.scrollTop = feed.scrollHeight;
  }

  function addTurn(role: Turn["role"]): Turn {
    const msg = document.createElement("div");
    msg.className = `ap-msg ${role === "user" ? "user" : "ai"}`;
    msg.innerHTML =
      role === "user"
        ? `<div class="ap-bubble"></div>`
        : `<div class="ap-steps"></div><div class="ap-answer"></div><div class="ap-msg-meta"></div>`;
    feed.append(msg);
    const turn: Turn = { role, text: "", el: msg };
    turns.push(turn);
    return turn;
  }

  function aiTurn(): Turn {
    return (curAi ??= addTurn("assistant"));
  }

  function stepsOf(turn: Turn): HTMLElement {
    return turn.el.querySelector<HTMLElement>(".ap-steps")!;
  }

  function addStep(glyph: IconName, label: string): void {
    const step = document.createElement("div");
    step.className = "ap-step";
    step.innerHTML = `${icon(glyph, 12)}<span>${esc(label)}</span>`;
    stepsOf(aiTurn()).append(step);
    pin();
  }

  function heard(text: string): void {
    if (!curUser) {
      // The user is talking again: whatever the assistant was saying is over.
      curAi = null;
      curUser = addTurn("user");
    }
    curUser.text += text;
    curUser.el.querySelector(".ap-bubble")!.textContent = curUser.text.trim();
    pin();
  }

  function said(text: string): void {
    const turn = aiTurn();
    curUser = null;
    turn.text += text;
    turn.el.querySelector(".ap-answer")!.innerHTML = deps.renderAnswer(turn.text.trim());
    pin();
  }

  function recap(): string {
    const lines = turns
      .filter((t) => t.text.trim())
      .slice(-RECAP_TURNS)
      .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text.trim()}`)
      .join("\n");
    return lines.length > RECAP_MAX_CHARS ? "…" + lines.slice(-RECAP_MAX_CHARS) : lines;
  }

  // ------------------------------------------------------------ tools

  const can = (perm: AssistantPerm): boolean => store.state.settings.assistantPerms[perm] !== false;

  async function runTools(calls: LiveToolCall[]): Promise<void> {
    const session = live;
    if (!session || !abort) return;
    curUser = null;
    const turn = aiTurn();
    const steps = stepsOf(turn);
    const own = new AbortController();
    const onEnd = (): void => own.abort();
    abort.signal.addEventListener("abort", onEnd);
    batch = own;
    working++;
    try {
      const app = calls.filter((c) => c.name !== LIST_TOOL);
      const ran = app.length
        ? await deps.conversation.runExternal(
            app,
            { scope, mode: mode.id, host: deps.host, allowed, signal: own.signal },
            {
              onText: () => {},
              onTool: (label, _paneIds, tool) => {
                const step = document.createElement("div");
                step.className = "ap-step";
                step.innerHTML = `${icon(deps.toolIcon(tool), 12)}<span>${esc(label)}</span>`;
                steps.append(step);
                pin();
              },
              watch: deps.watch,
              requestApproval: async (plan, signal) => {
                approvals++;
                try {
                  const ok = deps.requestApproval(plan, signal, steps);
                  pin();
                  return await ok;
                } finally {
                  approvals--;
                }
              },
              onAction: (plan, step) => {
                deps.showAction(plan, step, steps);
                pin();
              },
            }
          )
        : [];
      // The model moved on (the user talked over it) or the session ended:
      // nobody is waiting for these results.
      if (own.signal.aborted || live !== session) return;
      const byId = new Map(ran.map((r) => [r.id, r.content]));
      session.sendToolResults(
        calls.map((c) => {
          if (c.name === LIST_TOOL) {
            addStep("terminal", "Checked the terminals");
            return { id: c.id, name: c.name, content: terminalsSnapshot(scope) };
          }
          return { id: c.id, name: c.name, content: byId.get(c.id) ?? "Error: the call did not run." };
        })
      );
    } catch (err) {
      if (live === session && !own.signal.aborted)
        session.sendToolResults(
          calls.map((c) => ({ id: c.id, name: c.name, content: `Error: ${err instanceof Error ? err.message : String(err)}` }))
        );
    } finally {
      abort?.signal.removeEventListener("abort", onEnd);
      if (batch === own) batch = null;
      working--;
    }
  }

  // ------------------------------------------------------------ status

  function phase(): Phase {
    if (errorMsg) return "error";
    if (liveState === "connecting" || liveState === "closed") return "connecting";
    if (liveState === "reconnecting") return "reconnecting";
    if (approvals > 0) return "approval";
    if (audio?.speaking) return "speaking";
    if (working > 0) return "working";
    return audio?.muted ? "muted" : "listening";
  }

  function hintFor(p: Phase): string {
    if (p === "error") return errorMsg;
    if (p === "approval") return "Approve or deny below.";
    if (p === "listening" && !turns.length) return "Go ahead, I'm listening.";
    return "";
  }

  /** One frame: the orb follows whoever is talking, and the status line
   *  follows the phase. DOM writes happen only when something changed. */
  function paint(): void {
    frame = requestAnimationFrame(paint);
    const p = phase();
    if (p !== shownPhase) {
      shownPhase = p;
      el.dataset.phase = p;
      statusText.textContent = PHASE_LABEL[p];
    }
    const h = hintFor(p);
    if (hint.textContent !== h) hint.textContent = h;
    const lv = audio?.levels() ?? { mic: 0, out: 0 };
    const target = Math.min(1, (p === "speaking" ? lv.out : p === "listening" ? lv.mic : 0) * 4.5);
    // Fast attack, slow release: it jumps with a syllable and settles after.
    level += (target - level) * (target > level ? 0.45 : 0.1);
    orb.style.setProperty("--lvl", level.toFixed(3));
    if (isBuddy) animateBuddy();
    const t = p === "error" ? shownClock : clock(Date.now() - startedAt);
    if (t !== shownClock) {
      shownClock = t;
      timeEl.textContent = t;
    }
  }

  /** Eyes that behave like eyes: they ease towards the pointer, wander when
   *  there's nothing to look at, and blink at uneven intervals (sometimes
   *  twice), which is what stops a face from reading as a loop. */
  function animateBuddy(): void {
    const now = performance.now();
    if (now > lookUntil && now > nextGlance) {
      const away = Math.random() < 0.6;
      lookX = away ? (Math.random() * 2 - 1) * 0.7 : 0;
      lookY = away ? (Math.random() * 2 - 1) * 0.4 : 0;
      nextGlance = now + 900 + Math.random() * 2600;
    }
    gazeX += (lookX - gazeX) * 0.16;
    gazeY += (lookY - gazeY) * 0.16;
    orb.style.setProperty("--px", gazeX.toFixed(3));
    orb.style.setProperty("--py", gazeY.toFixed(3));
    if (now > nextBlink) {
      orb.classList.add("blink");
      window.setTimeout(() => orb.classList.remove("blink"), 120);
      nextBlink = now + (Math.random() < 0.18 ? 300 : 1800 + Math.random() * 4000);
    }
  }

  function renderMute(): void {
    const muted = audio?.muted ?? false;
    muteBtn.innerHTML = `${icon(muted ? "micOff" : "mic", 16)}<span>${muted ? "Unmute" : "Mute"}</span>`;
    muteBtn.title = muted ? "Unmute microphone (M)" : "Mute microphone (M)";
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.classList.toggle("on", muted);
  }

  function toggleMute(): void {
    if (!audio || errorMsg) return;
    audio.setMuted(!audio.muted);
    if (audio.muted) live?.endAudioStream();
    renderMute();
  }

  // ------------------------------------------------------------ lifecycle

  /** Stops the mic, the speaker and the connection; the transcript stays. */
  function release(): void {
    abort?.abort(); // collapses any approval card still waiting
    if (working) deps.conversation.stop();
    live?.close();
    audio?.close();
    live = null;
    audio = null;
    abort = batch = null;
    liveState = "closed";
  }

  function fail(message: string): void {
    if (!active || errorMsg) return;
    release();
    errorMsg = message;
    el.classList.add("failed");
    endLabel.textContent = "Back to chat";
  }

  function start(): void {
    if (active) return;
    const s = store.state.settings;
    const apiKey = s.geminiApiKey.trim();
    if (!apiKey) {
      deps.openAiSettings();
      return;
    }
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
    active = true;
    errorMsg = "";
    turns = [];
    curUser = curAi = null;
    working = approvals = 0;
    allowed = new Set();
    level = 0;
    shownPhase = null;
    shownClock = "";
    startedAt = Date.now();
    mode = deps.mode();
    scope = deps.scope();
    feed.innerHTML = "";
    modeEl.innerHTML = `${icon(mode.icon, 12)}${esc(mode.label)}`;
    modeEl.title = mode.hint;
    endLabel.textContent = "End, continue in chat";
    const avatar = s.voiceAvatar in AVATAR_HTML ? s.voiceAvatar : "orb";
    isBuddy = avatar !== "orb";
    orb.className = `vo-orb ${avatar}`;
    orb.innerHTML = AVATAR_HTML[avatar];
    lookX = lookY = gazeX = gazeY = lookUntil = 0;
    nextBlink = performance.now() + 1500;
    el.classList.remove("failed", "leaving");
    el.hidden = false;

    abort = new AbortController();
    const mic = new VoiceAudio();
    audio = mic;
    const session = new LiveSession(
      {
        apiKey,
        model: s.voiceModel.trim() || DEFAULT_LIVE_MODEL,
        voice: s.voiceName || DEFAULT_VOICE,
        setup: (fresh) => ({
          system: voiceSystemPrompt(mode, terminalsSnapshot(scope), fresh ? recap() : ""),
          tools: voiceTools(toolDefsFor(mode, can)),
        }),
      },
      {
        onState: (state) => {
          liveState = state;
        },
        onAudio: (pcm) => mic.play(pcm),
        onInputText: heard,
        onOutputText: said,
        onInterrupted: () => {
          mic.flush();
          curAi = null;
        },
        onTurnComplete: () => {
          curUser = curAi = null;
          deps.conversation.endExternalTurn();
        },
        onToolCalls: (calls) => void runTools(calls),
        onToolCancel: () => {
          batch?.abort();
          deps.conversation.stop(); // also skips the calls that needed no approval
        },
        onError: fail,
      }
    );
    live = session;
    renderMute();
    paint();
    el.focus();
    session.connect();
    mic.start((pcm) => session.sendAudio(pcm)).catch((err: unknown) => {
      if (audio === mic) fail(micError(err));
    });
  }

  function end(): void {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    release();
    const spoken = turns.filter((t) => t.text.trim() || hasSteps(t));
    for (const t of turns) if (!spoken.includes(t)) t.el.remove();
    const messages: HTMLElement[] = [];
    if (spoken.length) {
      const mark = document.createElement("div");
      mark.className = "ap-voice-mark";
      mark.innerHTML = `${icon("waveform", 12)}<span>Voice conversation, ${clock(Date.now() - startedAt)}</span>`;
      messages.push(mark, ...spoken.map((t) => t.el));
      deps.conversation.adopt(spoken.map((t) => ({ role: t.role, content: t.text })));
    }
    turns = [];
    curUser = curAi = null;
    el.classList.add("leaving");
    leaveTimer = window.setTimeout(() => {
      leaveTimer = null;
      el.hidden = true;
      el.classList.remove("leaving");
    }, LEAVE_MS);
    deps.onEnd(messages);
  }

  /** Whether a turn left any step lines behind (an action with no words). */
  function hasSteps(t: Turn): boolean {
    return t.role === "assistant" && stepsOf(t).childElementCount > 0;
  }

  // Buddy's eyes follow the pointer, and a click pokes it.
  el.addEventListener("pointermove", (e) => {
    if (!isBuddy) return;
    const r = orb.getBoundingClientRect();
    const look = (d: number): number => Math.max(-1, Math.min(1, d / 140));
    lookX = look(e.clientX - (r.left + r.width / 2));
    lookY = look(e.clientY - (r.top + r.height / 2));
    // Keeps watching a still pointer for a moment before its eyes wander off.
    lookUntil = performance.now() + 3000;
  });
  el.addEventListener("pointerleave", () => {
    lookUntil = 0;
  });
  orb.addEventListener("click", () => {
    if (!isBuddy) return;
    orb.classList.remove("boop");
    void orb.offsetWidth; // restart the animation on a second poke
    orb.classList.add("boop");
  });
  orb.addEventListener("animationend", (e) => {
    if (e.animationName === "vb-boop" || e.animationName === "vt-boop") orb.classList.remove("boop");
  });

  muteBtn.addEventListener("click", toggleMute);
  endBtn.addEventListener("click", end);
  el.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key.toLowerCase() !== "m" || e.ctrlKey || e.altKey || e.metaKey || t.closest("input, textarea")) return;
    e.preventDefault();
    toggleMute();
  });

  return {
    el,
    isActive: () => active,
    start,
    end,
    /** Says something to the assistant on the app's behalf (a watched
     *  terminal finished). False when it couldn't be delivered right now. */
    notify(text: string, label: string): boolean {
      if (!active || !live?.ready) return false;
      curUser = curAi = null;
      addStep("bell", label);
      live.sendText(text);
      return true;
    },
  };
}

export type VoiceView = ReturnType<typeof createVoiceView>;
