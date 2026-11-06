/** Timers: countdowns toward a goal ("Write the intro", 25 min).
 *
 *  This module owns the timers and their states; src-tauri/src/timers.rs owns
 *  the clock — it fires each one on time even while the window is minimised
 *  (the webview's own timers are throttled then), plays the last-seconds
 *  ticking and the alarm, and reports back with `timer-fired`. Timers are kept
 *  in localStorage, so a reload or restart picks them back up. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { addInboxItem } from "./inbox";
import { store } from "./store";

export type TimerState = "running" | "paused" | "ringing" | "done";

export interface Timer {
  id: string;
  /** What it's for. May be empty. */
  goal: string;
  /** The length it was set to (grows with "+1 min"). */
  durationMs: number;
  /** Epoch ms it ends at, while running. */
  endsAt: number | null;
  /** Time left, while paused. */
  remainingMs: number;
  state: TimerState;
  createdAt: number;
  finishedAt: number | null;
}

const KEY = "openterm.timers.v1";
export const MAX_TIMERS = 8;
export const MAX_DURATION_MS = 24 * 3600_000;

let list: Timer[] = load();
const listeners = new Set<() => void>();
const firedListeners = new Set<(t: Timer) => void>();

function load(): Timer[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Timer[]) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.id === "string") : [];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: timers still work for this run.
  }
}

function changed(): void {
  save();
  listeners.forEach((f) => f());
}

export function onTimersChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** A timer just reached zero (for the finish animation). */
export function onTimerFired(f: (t: Timer) => void): () => void {
  firedListeners.add(f);
  return () => firedListeners.delete(f);
}

export function allTimers(): Timer[] {
  return list;
}

export function remainingOf(t: Timer): number {
  if (t.state === "running" && t.endsAt != null) return Math.max(0, t.endsAt - Date.now());
  if (t.state === "paused") return t.remainingMs;
  return 0;
}

/** 0 at the start, 1 at the end. */
export function progressOf(t: Timer): number {
  if (t.state === "ringing" || t.state === "done") return 1;
  return t.durationMs > 0 ? 1 - remainingOf(t) / t.durationMs : 1;
}

/** The timer the title bar features: ringing first, then the one ending
 *  soonest, then paused, then finished. */
export function featuredTimer(): Timer | null {
  const rank = (t: Timer) => (t.state === "ringing" ? 0 : t.state === "running" ? 1 : t.state === "paused" ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || remainingOf(a) - remainingOf(b))[0] ?? null;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function arm(t: Timer): void {
  if (t.state !== "running" || t.endsAt == null) return;
  const s = store.state.settings;
  void invoke("timer_schedule", {
    id: t.id,
    endsAtMs: t.endsAt,
    tick: s.timerTickSound,
    ring: s.timerRingSound,
    duck: s.timerDuckAudio,
  }).catch(() => {});
}

function disarm(t: Timer): void {
  void invoke("timer_cancel", { id: t.id }).catch(() => {});
}

export function findTimer(ref: string): Timer | null {
  const want = ref.trim().toLowerCase();
  if (!want) return null;
  return (
    list.find((t) => t.id === want) ??
    list.find((t) => t.goal.toLowerCase() === want) ??
    (list.filter((t) => t.goal.toLowerCase().includes(want)).length === 1
      ? list.find((t) => t.goal.toLowerCase().includes(want))!
      : null)
  );
}

export function startTimer(durationMs: number, goal: string): Timer {
  const ms = Math.round(Math.min(MAX_DURATION_MS, Math.max(1000, durationMs)));
  // Finished timers make room first; then the oldest goes.
  while (list.length >= MAX_TIMERS) {
    const old = list.findIndex((t) => t.state === "done");
    const drop = list.splice(old >= 0 ? old : 0, 1)[0];
    disarm(drop);
  }
  const t: Timer = {
    id: uid(),
    goal: goal.trim().slice(0, 80),
    durationMs: ms,
    endsAt: Date.now() + ms,
    remainingMs: ms,
    state: "running",
    createdAt: Date.now(),
    finishedAt: null,
  };
  list.push(t);
  arm(t);
  changed();
  return t;
}

export function pauseTimer(t: Timer): void {
  if (t.state !== "running") return;
  t.remainingMs = remainingOf(t);
  t.endsAt = null;
  t.state = "paused";
  disarm(t);
  changed();
}

export function resumeTimer(t: Timer): void {
  if (t.state !== "paused") return;
  t.endsAt = Date.now() + t.remainingMs;
  t.state = "running";
  arm(t);
  changed();
}

/** Adds time; on a finished timer it starts a new countdown of that length
 *  (snooze). */
export function addTime(t: Timer, ms: number): void {
  if (t.state === "ringing" || t.state === "done") {
    if (t.state === "ringing") stopRinging();
    t.state = "running";
    t.durationMs = ms;
    t.endsAt = Date.now() + ms;
    t.finishedAt = null;
    arm(t);
  } else if (t.state === "running" && t.endsAt != null) {
    t.endsAt = Math.min(t.endsAt + ms, Date.now() + MAX_DURATION_MS);
    t.durationMs += ms;
    arm(t);
  } else {
    t.remainingMs = Math.min(t.remainingMs + ms, MAX_DURATION_MS);
    t.durationMs += ms;
  }
  changed();
}

export function restartTimer(t: Timer): void {
  if (t.state === "ringing") stopRinging();
  t.state = "running";
  t.endsAt = Date.now() + t.durationMs;
  t.remainingMs = t.durationMs;
  t.finishedAt = null;
  arm(t);
  changed();
}

/** Removes a timer, whatever its state. */
export function cancelTimer(t: Timer): void {
  if (t.state === "ringing" && !list.some((x) => x !== t && x.state === "ringing")) stopRinging();
  disarm(t);
  list = list.filter((x) => x !== t);
  changed();
}

/** Silences the alarm. The finished timers stay, as "done", until dismissed. */
export function stopRinging(): void {
  void invoke("timer_stop_ring").catch(() => {});
  let any = false;
  for (const t of list)
    if (t.state === "ringing") {
      t.state = "done";
      any = true;
    }
  if (any) changed();
}

/** Clears every finished timer. */
export function dismissDone(): void {
  const before = list.length;
  list = list.filter((t) => t.state !== "done" && t.state !== "ringing");
  if (list.length !== before) {
    void invoke("timer_stop_ring").catch(() => {});
    changed();
  }
}

/** Re-arms every running timer, e.g. after the sound settings changed. */
export function rearmTimers(): void {
  list.forEach(arm);
}

function finished(t: Timer, ringing: boolean, whileClosed = false): void {
  t.state = ringing ? "ringing" : "done";
  t.endsAt = null;
  t.remainingMs = 0;
  t.finishedAt = Date.now();
  addInboxItem({
    kind: "timer",
    title: t.goal ? `Time's up: ${t.goal}` : "Time's up",
    message: `${formatDuration(t.durationMs)} timer${whileClosed ? " (finished while OpenTerm was closed)" : ""}`,
  });
  changed();
  if (!whileClosed) firedListeners.forEach((f) => f(t));
}

/** Hooks up the Rust side and picks up timers from the last run. */
export async function initTimers(): Promise<void> {
  await listen<{ id: string; ringing: boolean }>("timer-fired", (e) => {
    const t = list.find((x) => x.id === e.payload.id);
    if (!t || t.state !== "running") return;
    // With the alarm sound off, the ringing look still plays (if animations
    // are on) for as long as the alarm would have.
    const silentRing = !e.payload.ringing && store.state.settings.timerAnimation;
    finished(t, e.payload.ringing || silentRing);
    if (silentRing)
      setTimeout(() => {
        if (t.state === "ringing") {
          t.state = "done";
          changed();
        }
      }, 45_000);
  });
  await listen("timer-ring-ended", () => {
    let any = false;
    for (const t of list)
      if (t.state === "ringing") {
        t.state = "done";
        any = true;
      }
    if (any) changed();
  });
  const now = Date.now();
  for (const t of list) {
    if (t.state === "ringing") t.state = "done";
    if (t.state === "running" && t.endsAt != null && t.endsAt <= now) finished(t, false, true);
    else arm(t);
  }
  changed();
}

// ---------------------------------------------------------------- durations

/** Reads "25", "25m", "1h30", "1h 30m", "90s", "1:30" (m:ss) or "1:00:00".
 *  A bare number is minutes. Returns ms, or null. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, ".");
  if (!s) return null;
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
    const parts = s.split(":").map(Number);
    const [h, m, sec] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    return valid(((h * 60 + m) * 60 + sec) * 1000);
  }
  if (/^\d+(\.\d+)?$/.test(s)) return valid(Number(s) * 60_000);
  const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b/g;
  let total = 0;
  let matched = "";
  for (const m of s.matchAll(re)) {
    const n = Number(m[1]);
    const u = m[2][0];
    total += u === "h" ? n * 3600_000 : u === "m" ? n * 60_000 : n * 1000;
    matched += m[0];
  }
  // "1h30" — trailing minutes without a unit.
  const tail = /h(?:r|rs|ours?)?\s*(\d+)$/.exec(s);
  if (tail) total += Number(tail[1]) * 60_000;
  if (!matched) return null;
  return valid(total);
}

function valid(ms: number): number | null {
  return Number.isFinite(ms) && ms >= 1000 && ms <= MAX_DURATION_MS ? Math.round(ms) : null;
}

/** "24:13", or "1:02:03" past an hour. */
export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** "25 min", "1 h 30 min", "45 s". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s && !h) parts.push(`${s} s`);
  return parts.join(" ") || "0 s";
}
