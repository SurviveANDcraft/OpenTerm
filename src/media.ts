/** Now playing, client side: what Windows' media controls report (see
 *  src-tauri/src/media.rs), which source the title bar follows, and commands
 *  back to it. Commands update the local copy at once so the UI answers on the
 *  click; the next snapshot from Rust confirms or corrects it. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface MediaSource {
  id: string;
  app: string;
  kind: "spotify" | "chrome" | "edge" | "firefox" | "browser" | "other";
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped" | "changing" | "closed";
  positionMs: number;
  durationMs: number;
  rate: number;
  canPlayPause: boolean;
  canNext: boolean;
  canPrev: boolean;
  canSeek: boolean;
  shuffle: boolean | null;
  repeat: "none" | "track" | "list" | null;
  canShuffle: boolean;
  canRepeat: boolean;
  art: string | null;
  volume: number | null;
  muted: boolean | null;
}

interface MediaState {
  sources: MediaSource[];
  current: string | null;
  systemVolume: number | null;
  systemMuted: boolean | null;
  atMs: number;
}

let state: MediaState = { sources: [], current: null, systemVolume: null, systemMuted: null, atMs: Date.now() };
/** Chosen by hand in the expanded view; wins while that source exists. */
let pinned: string | null = null;
/** The last source shown, so a pause doesn't flip the view to another app. */
let lastShown: string | null = null;
let watching = false;
let meterFor: string | null = null;

const listeners = new Set<() => void>();
const levelListeners = new Set<(id: string, level: number) => void>();

let unlisten: (() => void)[] = [];

function emit(): void {
  listeners.forEach((f) => f());
}

export function onMediaChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Live output peak (0–1) of the metered source, about 20× a second;
 *  -1 when its audio session can't be found. */
export function onMediaLevel(f: (id: string, level: number) => void): () => void {
  levelListeners.add(f);
  return () => levelListeners.delete(f);
}

/** The title-bar widget wants media. */
let widgetWants = false;
/** The assistant asked about media recently; keep following until then. */
let agentUntil = 0;
let agentTimer = 0;
let stateSeq = 0;

export function setMediaWatching(on: boolean): Promise<void> {
  widgetWants = on;
  return syncWatching();
}

/** For the assistant's tools: makes sure media is being followed (even with
 *  the widget off) and returns once a fresh snapshot has arrived. */
export async function ensureMediaFresh(): Promise<void> {
  agentUntil = Date.now() + 120_000;
  clearTimeout(agentTimer);
  agentTimer = window.setTimeout(() => void syncWatching(), 121_000);
  const seq = stateSeq;
  const was = watching;
  await syncWatching();
  if (was && seq > 0) return;
  const t0 = Date.now();
  while (stateSeq === seq && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 50));
}

async function syncWatching(): Promise<void> {
  const on = widgetWants || Date.now() < agentUntil;
  if (on === watching) return;
  watching = on;
  if (on) {
    unlisten.push(
      await listen<MediaState>("media-state", (e) => {
        state = e.payload;
        stateSeq++;
        emit();
      }),
      await listen<{ id: string; level: number }>("media-level", (e) => {
        levelListeners.forEach((f) => f(e.payload.id, e.payload.level));
      })
    );
  } else {
    unlisten.forEach((u) => u());
    unlisten = [];
    state = { ...state, sources: [] };
    emit();
  }
  void invoke("media_watch", { on, meter: on ? meterFor : null }).catch(() => {});
}

/** Stream the level of this source (null stops the meter). */
export function setMeter(id: string | null): void {
  if (id === meterFor) return;
  meterFor = id;
  if (watching) void invoke("media_watch", { on: true, meter: id }).catch(() => {});
}

export function mediaSources(): MediaSource[] {
  return state.sources.filter((s) => s.title || s.artist);
}

/** Which source the title bar shows: the pinned one, else whatever is
 *  playing (Windows' own pick first), else the one shown last. */
export function activeSource(): MediaSource | null {
  const list = mediaSources();
  // Mid track change the shown source can go blank for a moment. Stay on it
  // (the widget shows it as loading) unless something else is really playing.
  if (lastShown && !pinned && !list.some((s) => s.id === lastShown)) {
    const blank = state.sources.find((s) => s.id === lastShown);
    if (blank && !list.some((s) => s.status === "playing")) return blank;
  }
  if (!list.length) return null;
  const by = (id: string | null) => (id ? list.find((s) => s.id === id) : undefined);
  const playing = list.filter((s) => s.status === "playing");
  const pick =
    by(pinned) ??
    (playing.length ? (playing.find((s) => s.id === state.current) ?? playing.find((s) => s.id === lastShown) ?? playing[0]) : undefined) ??
    by(lastShown) ??
    by(state.current) ??
    list[0];
  lastShown = pick.id;
  return pick;
}

export function pinSource(id: string): void {
  pinned = id;
  lastShown = id;
  emit();
}

/** Where playback is right now, in ms. */
export function positionOf(s: MediaSource): number {
  let p = s.positionMs;
  if (s.status === "playing") p += (Date.now() - state.atMs) * s.rate;
  return s.durationMs > 0 ? Math.min(Math.max(p, 0), s.durationMs) : Math.max(p, 0);
}

/** The volume the widget controls: the app's own, or the system's when the
 *  app has no audio session of its own. */
export function volumeOf(s: MediaSource): { value: number; muted: boolean; scope: "app" | "system" } | null {
  if (s.volume != null) return { value: s.volume, muted: !!s.muted, scope: "app" };
  if (state.systemVolume != null) return { value: state.systemVolume, muted: !!state.systemMuted, scope: "system" };
  return null;
}

type Action = "toggle" | "next" | "prev" | "seek" | "shuffle" | "repeat" | "volume" | "mute";

export function mediaControl(s: MediaSource, action: Action, value?: number): void {
  // Optimistic: reflect the change before the app confirms it.
  const now = Date.now();
  const rebase = () => {
    // Fold elapsed play time into positionMs so atMs can move to now.
    for (const x of state.sources) x.positionMs = positionOf(x);
    state.atMs = now;
  };
  let id = s.id;
  if (action === "toggle") {
    rebase();
    s.status = s.status === "playing" ? "paused" : "playing";
  } else if (action === "seek" && value != null) {
    rebase();
    s.positionMs = value;
  } else if (action === "volume" || action === "mute") {
    const v = volumeOf(s);
    if (v?.scope === "system") {
      id = "";
      if (action === "volume") state.systemVolume = value ?? 0;
      else state.systemMuted = !!value;
    } else if (action === "volume") s.volume = value ?? 0;
    else s.muted = !!value;
  } else if (action === "shuffle") s.shuffle = !!value;
  else if (action === "repeat") s.repeat = value === 1 ? "track" : value === 2 ? "list" : "none";
  emit();
  void invoke("media_control", { id, action, value: value ?? null }).catch(() => {});
}

export function formatTime(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
