import { fetchClaudeUsageLimit, fetchCodexUsageLimit, UsageLimit, UsageWindow } from "./usage";

/** Per-pane usage indicator: the 5-hour rate-limit window remaining for
 *  whichever agent (Claude Code / Codex) is currently running in that
 *  terminal — hidden entirely for plain shells and for agents we don't track. */

const POLL_MS = 30_000;

const HARNESS_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function fmtResetsIn(ms: number | null): string {
  if (!ms) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "resets soon";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

/** Codex reports its own window length (5h on a paid plan, but weekly or even
 *  monthly on a free one); Claude Code doesn't send one at all, so `fallback`
 *  (its known five_hour/seven_day split) is used instead. */
function windowLabel(w: UsageWindow, fallback: string): string {
  if (w.window_minutes == null) return fallback;
  const m = w.window_minutes;
  if (m % 1440 === 0) return `${m / 1440}-day window`;
  if (m % 60 === 0) return `${m / 60}h window`;
  return `${m}m window`;
}

function describeWindow(fallbackLabel: string, w: UsageWindow | null): string | null {
  if (!w) return null;
  const reset = fmtResetsIn(w.resets_at);
  return `${windowLabel(w, fallbackLabel)}: ${Math.round(w.used_percent)}% used${reset ? `, ${reset}` : ""}`;
}

function buildTooltip(name: string, u: UsageLimit): string {
  if (!u.available) return u.error ? `${name}: ${u.error}` : `${name}: usage unavailable`;
  const lines = [name, describeWindow("5-hour window", u.primary), describeWindow("Weekly window", u.secondary)];
  return lines.filter((l): l is string => !!l).join("\n");
}

/** Continuous green→amber→red hue for "% of the window still left". Driven by
 *  the value itself rather than the theme accent, so the pill always signals how
 *  close the pane is to its limit — and never renders as plain white (some
 *  themes define `--accent` as #ffffff, which used to blank the mid-range band). */
function remainingColor(remaining: number): string {
  const r = Math.max(0, Math.min(100, remaining));
  const hue = r * 1.4; // 0% → 0 (red), 100% → 140 (green)
  return `hsl(${Math.round(hue)}, 78%, 62%)`;
}

function applyLevel(el: HTMLElement, remaining: number | null): void {
  // Coarse class kept for the tooltip/state hooks; color comes from the var.
  el.classList.remove("ul-ok", "ul-warn", "ul-crit", "ul-unknown");
  if (remaining == null) {
    el.classList.add("ul-unknown");
    el.style.removeProperty("--ul-color");
    return;
  }
  if (remaining <= 15) el.classList.add("ul-crit");
  else if (remaining <= 40) el.classList.add("ul-warn");
  else el.classList.add("ul-ok");
  el.style.setProperty("--ul-color", remainingColor(remaining));
}

export type AgentHarness = "claude-code" | "codex";

const FETCHERS: Record<AgentHarness, () => Promise<UsageLimit>> = {
  "claude-code": fetchClaudeUsageLimit,
  codex: fetchCodexUsageLimit,
};

export interface PaneUsagePill {
  el: HTMLElement;
  /** Shows/hides and (re)starts polling for the given harness. Pass null to
   *  hide — used whenever the pane isn't currently running claude/codex. */
  setHarness(h: AgentHarness | null): void;
  dispose(): void;
}

export function createPaneUsagePill(): PaneUsagePill {
  const el = document.createElement("span");
  el.className = "pane-usage-pill hidden";
  el.title = "";
  const valueEl = document.createElement("span");
  valueEl.className = "ul-value";
  valueEl.textContent = "--";
  el.appendChild(valueEl);

  let harness: AgentHarness | null = null;
  let timer: number | null = null;
  // Guards against a slow response from a harness landing after the pane
  // already switched to (or away from) another one.
  let generation = 0;

  async function poll(): Promise<void> {
    const h = harness;
    const gen = generation;
    if (!h) return;
    const name = HARNESS_LABEL[h];
    try {
      const u = await FETCHERS[h]();
      if (gen !== generation) return;
      const w = u.available ? u.primary : null;
      if (!w) {
        valueEl.textContent = "—";
        applyLevel(el, null);
        el.title = buildTooltip(name, u);
        return;
      }
      const remaining = Math.max(0, Math.min(100, Math.round(100 - w.used_percent)));
      valueEl.textContent = `${remaining}%`;
      applyLevel(el, remaining);
      el.title = buildTooltip(name, u);
    } catch (e) {
      if (gen !== generation) return;
      valueEl.textContent = "—";
      applyLevel(el, null);
      el.title = `${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function stopTimer(): void {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function setHarness(h: AgentHarness | null): void {
    if (h === harness) return;
    harness = h;
    generation++;
    stopTimer();
    if (!h) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    valueEl.textContent = "--";
    applyLevel(el, null);
    void poll();
    timer = window.setInterval(poll, POLL_MS);
  }

  return { el, setHarness, dispose: stopTimer };
}
