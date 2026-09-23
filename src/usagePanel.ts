import {
  fetchFolderUsage,
  fetchPaneUsage,
  fmtCost,
  fmtDuration,
  fmtInt,
  fmtTokens,
  fmtWhen,
  harnessLabel,
  mergePaneUsages,
  pricingFilePath,
  shortPath,
  type ModelUsage,
  type PaneUsage,
  type Tokens,
} from "./usage";

/** The token classes, in billing order, with the colour each is drawn in.
 *  Cache reads are deliberately the muted one: they dominate the token count
 *  on any long agent run while costing a tenth of the input rate, so giving
 *  them a loud colour would make every chart read as "mostly cache". */
const TOKEN_PARTS: { key: keyof Tokens; label: string; color: string; note: string }[] = [
  { key: "input", label: "Input", color: "#6ea8d8", note: "fresh prompt tokens" },
  { key: "output", label: "Output", color: "#7fb069", note: "generated tokens" },
  { key: "cache_write", label: "Cache write", color: "#e8b45a", note: "1.25–2× input rate" },
  { key: "cache_read", label: "Cache read", color: "#5a6373", note: "0.1× input rate" },
  { key: "reasoning", label: "Reasoning", color: "#c78fd6", note: "thinking tokens" },
];

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

const ICONS = {
  close:
    '<svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke="currentColor"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke="currentColor"/></svg>',
  refresh:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 1.5v3h-3"/></svg>',
};

export function createUsagePanel() {
  const el = document.createElement("div");
  el.className = "usage";

  const card = document.createElement("div");
  card.className = "usage-card";

  // ---- header ----
  const head = document.createElement("div");
  head.className = "usage-head";
  const heading = document.createElement("div");
  heading.className = "usage-heading";
  const title = document.createElement("h2");
  title.textContent = "Terminal usage";
  const subtitle = document.createElement("div");
  subtitle.className = "usage-subtitle";
  heading.append(title, subtitle);

  const headActions = document.createElement("div");
  headActions.className = "usage-head-actions";
  const folderBtn = document.createElement("button");
  folderBtn.className = "pane-btn usage-folder-btn hidden";
  folderBtn.textContent = "Whole folder";
  folderBtn.title = "Include every session ever recorded in this folder, not just this session's panes";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "pane-btn usage-icon-btn";
  refreshBtn.innerHTML = ICONS.refresh;
  refreshBtn.title = "Refresh";
  const closeBtn = document.createElement("button");
  closeBtn.className = "pane-btn usage-icon-btn";
  closeBtn.innerHTML = ICONS.close;
  closeBtn.title = "Close (Esc)";
  headActions.append(folderBtn, refreshBtn, closeBtn);
  head.append(heading, headActions);

  // ---- body ----
  const body = document.createElement("div");
  body.className = "usage-body";

  card.append(head, body);
  el.appendChild(card);

  let open = false;
  let paneIds: string[] | null = null;
  let paneTitle = "";
  let pricingPath = "";
  let folderCwd: string | null = null;
  let folderMode = false;

  void pricingFilePath()
    .then((p) => (pricingPath = p))
    .catch(() => {});

  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) close();
  });
  card.addEventListener("pointerdown", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", () => close());
  refreshBtn.addEventListener("click", () => void load());
  folderBtn.addEventListener("click", () => {
    folderMode = !folderMode;
    folderBtn.classList.toggle("active", folderMode);
    void load();
  });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  });

  function close(): void {
    if (!open) return;
    open = false;
    paneIds = null;
    folderCwd = null;
    folderMode = false;
    folderBtn.classList.remove("active");
    el.classList.remove("visible");
  }

  async function load(): Promise<void> {
    if (!paneIds) return;
    const ids = paneIds;
    const useFolder = folderMode;
    body.innerHTML = skeleton();
    try {
      const page =
        useFolder && folderCwd
          ? await fetchFolderUsage(folderCwd)
          : mergePaneUsages(ids[0], await Promise.all(ids.map(fetchPaneUsage)));
      // A refresh that lands after the user closed or switched panes/sessions
      // must not paint stale numbers over the current view.
      if (paneIds !== ids || folderMode !== useFolder) return;
      render(page);
    } catch (err) {
      if (paneIds !== ids || folderMode !== useFolder) return;
      body.innerHTML = `<div class="usage-empty"><p>Couldn't read usage data.</p><p class="usage-dim">${esc(
        String(err)
      )}</p></div>`;
    }
  }

  /** Shows usage for a single pane, or — passing an array — the combined
   *  usage across every pane in a session (the sidebar's "Stats" entry).
   *  `cwd`, when given, unlocks the "Whole folder" toggle: every session ever
   *  recorded against that working directory, not just this session's panes. */
  async function show(id: string | string[], name: string, cwd?: string | null): Promise<void> {
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) return;
    paneIds = ids;
    paneTitle = name;
    folderCwd = cwd ?? null;
    folderMode = false;
    folderBtn.classList.remove("active");
    folderBtn.classList.toggle("hidden", !folderCwd);
    open = true;
    subtitle.textContent = name;
    body.innerHTML = skeleton();
    el.classList.add("visible");
    requestAnimationFrame(() => closeBtn.focus());
    await load();
  }

  /** Placeholder shaped like the real report — four hero tiles, the substat
   *  rows, then the section blocks — so the panel doesn't resize under the
   *  user when the numbers arrive. */
  function skeleton(): string {
    const tiles = [0, 1, 2, 3]
      .map(
        (i) => `<div class="usage-tile usage-skel-tile">
          <div class="skel skel-d${i} usage-skel-value"></div>
          <div class="skel skel-d${i} usage-skel-label"></div>
          <div class="skel skel-d${i} usage-skel-note"></div>
        </div>`
      )
      .join("");
    const subs = [0, 1, 2, 3, 4]
      .map(
        (i) => `<div class="usage-sub usage-skel-sub">
          <span class="skel skel-d${i % 5} usage-skel-subkey"></span>
          <span class="skel skel-d${i % 5} usage-skel-subval"></span>
        </div>`
      )
      .join("");
    return `<div class="usage-skel" aria-busy="true">
      <div class="skel-status">Reading harness logs<span class="skel-dots"><i></i><i></i><i></i></span></div>
      <section class="usage-hero">${tiles}</section>
      <section class="usage-substats">${subs}</section>
      <div class="skel usage-skel-bar"></div>
      <div class="skel skel-d1 usage-skel-block"></div>
      <div class="skel skel-d2 usage-skel-block usage-skel-block-short"></div>
    </div>`;
  }

  // ================= rendering =================

  function render(u: PaneUsage): void {
    if (u.session_count === 0) {
      body.innerHTML = emptyState();
      return;
    }
    const live = u.live.length
      ? `<span class="usage-live"><span class="usage-live-dot"></span>${u.live
          .map((l) => esc(harnessLabel(l.harness)))
          .join(", ")} running</span>`
      : "";
    const scope = folderMode ? " · whole folder history" : "";
    subtitle.innerHTML = `${esc(paneTitle)}${esc(scope)}${live}`;

    body.innerHTML = [
      heroSection(u),
      tokenSection(u.tokens),
      breakdownSection("By harness", u.by_harness, true),
      breakdownSection("By model", u.by_model, false),
      timelineSection(u),
      toolsSection(u),
      sessionsSection(u),
      footerSection(u),
    ].join("");
  }

  function emptyState(): string {
    return `
      <div class="usage-empty">
        <p>No AI harness usage recorded for this terminal yet.</p>
        <p class="usage-dim">Run an agent CLI here — <code>claude</code>, <code>opencode</code>,
        or <code>codex</code> — and its token spend will be tracked against this
        terminal automatically.</p>
      </div>`;
  }

  function heroSection(u: PaneUsage): string {
    // A total built from partially-unpriced models is a floor, not a figure —
    // label it so nobody reads it as the real number.
    const costNote = u.cost_complete
      ? "across all sessions"
      : `<span class="usage-warn">partial — ${u.unpriced_models.length} model${
          u.unpriced_models.length === 1 ? "" : "s"
        } unpriced</span>`;
    const span =
      u.first_activity && u.last_activity
        ? `${fmtWhen(u.first_activity)} → ${fmtWhen(u.last_activity)}`
        : "—";

    return `
      <section class="usage-hero">
        ${tile(u.cost_complete ? fmtCost(u.cost_usd) : `≥ ${fmtCost(u.cost_usd)}`, "Total cost", costNote, "accent")}
        ${tile(fmtTokens(u.tokens.total), "Tokens", `${fmtInt(u.tokens.total)} total`, "")}
        ${tile(fmtInt(u.messages), "Model replies", `${fmtInt(u.tool_calls)} tool calls`, "")}
        ${tile(fmtInt(u.session_count), "Sessions", span, "")}
      </section>
      <section class="usage-substats">
        ${sub("Agent time", fmtDuration(u.active_ms))}
        ${sub("Avg / reply", u.messages ? fmtCost(u.cost_usd / u.messages) : "—")}
        ${sub("Avg tokens / reply", u.messages ? fmtTokens(Math.round(u.tokens.total / u.messages)) : "—")}
        ${sub("Web searches", fmtInt(u.web_searches))}
        ${sub("Cache hit rate", cacheRate(u.tokens))}
      </section>`;
  }

  function tile(value: string, label: string, note: string, mod: string): string {
    return `
      <div class="usage-tile ${mod ? `usage-tile-${mod}` : ""}">
        <div class="usage-tile-value">${value}</div>
        <div class="usage-tile-label">${esc(label)}</div>
        <div class="usage-tile-note">${note}</div>
      </div>`;
  }

  function sub(label: string, value: string): string {
    return `<div class="usage-sub"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  /** Share of all prompt-side tokens that were served from cache — the single
   *  best indicator of whether a long session is being billed efficiently. */
  function cacheRate(t: Tokens): string {
    const promptSide = t.input + t.cache_read + t.cache_write;
    if (promptSide === 0) return "—";
    return `${Math.round((t.cache_read / promptSide) * 100)}%`;
  }

  function tokenSection(t: Tokens): string {
    if (t.total === 0) return "";
    const parts = TOKEN_PARTS.map((p) => ({ ...p, value: t[p.key] as number })).filter(
      (p) => p.value > 0
    );
    const sum = parts.reduce((a, p) => a + p.value, 0) || 1;

    const bar = parts
      .map(
        (p) =>
          `<span class="usage-bar-seg" style="width:${(p.value / sum) * 100}%;background:${
            p.color
          }" title="${esc(p.label)}: ${fmtInt(p.value)}"></span>`
      )
      .join("");

    const legend = parts
      .map(
        (p) => `
        <div class="usage-legend-row">
          <span class="usage-swatch" style="background:${p.color}"></span>
          <span class="usage-legend-label">${esc(p.label)}</span>
          <span class="usage-legend-note">${esc(p.note)}</span>
          <span class="usage-legend-val">${fmtTokens(p.value)}</span>
          <span class="usage-legend-pct">${((p.value / sum) * 100).toFixed(1)}%</span>
        </div>`
      )
      .join("");

    return `
      <section class="usage-section">
        <h3>Token composition</h3>
        <div class="usage-bar">${bar}</div>
        <div class="usage-legend">${legend}</div>
      </section>`;
  }

  function breakdownSection(heading: string, rows: ModelUsage[], isHarness: boolean): string {
    if (rows.length === 0) return "";
    const maxTok = Math.max(...rows.map((r) => r.tokens.total), 1);
    const body = rows
      .map((r) => {
        const name = isHarness ? harnessLabel(r.harness) : r.model;
        const badge = r.priced
          ? ""
          : `<span class="usage-badge usage-badge-warn" title="No price configured for this model — tokens are exact, cost is not counted.">unpriced</span>`;
        const tag = isHarness ? "" : `<span class="usage-badge">${esc(harnessLabel(r.harness))}</span>`;
        return `
        <div class="usage-row">
          <div class="usage-row-main">
            <div class="usage-row-name">${esc(name)}${tag}${badge}</div>
            <div class="usage-row-track"><span style="width:${(r.tokens.total / maxTok) * 100}%"></span></div>
          </div>
          <div class="usage-row-num">${fmtTokens(r.tokens.total)}</div>
          <div class="usage-row-num">${fmtInt(r.messages)}</div>
          <div class="usage-row-num usage-row-cost">${r.priced ? fmtCost(r.cost_usd) : "—"}</div>
        </div>`;
      })
      .join("");

    return `
      <section class="usage-section">
        <h3>${esc(heading)}</h3>
        <div class="usage-row usage-row-head">
          <div class="usage-row-main">Name</div>
          <div class="usage-row-num">Tokens</div>
          <div class="usage-row-num">Replies</div>
          <div class="usage-row-num">Cost</div>
        </div>
        ${body}
      </section>`;
  }

  function timelineSection(u: PaneUsage): string {
    if (u.by_day.length < 2) return "";
    // Fall back to token volume when nothing is priced, so the chart still
    // carries information instead of rendering as a flat row of zeros.
    const priced = u.by_day.some((d) => d.cost_usd > 0);
    const value = (d: (typeof u.by_day)[number]) => (priced ? d.cost_usd : d.tokens.total);
    const max = Math.max(...u.by_day.map(value), priced ? 0.0001 : 1);

    const bars = u.by_day
      .map((d) => {
        const v = value(d);
        const label = priced ? fmtCost(d.cost_usd) : fmtTokens(d.tokens.total);
        return `
        <div class="usage-daybar" title="${esc(d.day)} · ${label} · ${fmtInt(d.messages)} replies">
          <div class="usage-daybar-track">
            <span style="height:${Math.max((v / max) * 100, 2)}%"></span>
          </div>
          <div class="usage-daybar-label">${esc(d.day.slice(5))}</div>
        </div>`;
      })
      .join("");

    return `
      <section class="usage-section">
        <h3>${priced ? "Spend" : "Tokens"} by day</h3>
        <div class="usage-daychart">${bars}</div>
      </section>`;
  }

  function toolsSection(u: PaneUsage): string {
    if (u.top_tools.length === 0) return "";
    const max = Math.max(...u.top_tools.map((t) => t.calls), 1);
    const chips = u.top_tools
      .map(
        (t) => `
        <div class="usage-tool">
          <div class="usage-tool-track"><span style="width:${(t.calls / max) * 100}%"></span></div>
          <span class="usage-tool-name">${esc(t.name)}</span>
          <span class="usage-tool-count">${fmtInt(t.calls)}</span>
        </div>`
      )
      .join("");
    return `
      <section class="usage-section">
        <h3>Most-used tools</h3>
        <div class="usage-tools">${chips}</div>
      </section>`;
  }

  function sessionsSection(u: PaneUsage): string {
    const rows = u.sessions
      .map((s) => {
        // Harnesses other than Claude Code don't name their sessions, so the
        // working directory stands in as the heading — in which case repeating
        // it in the meta line below would just be noise.
        const name = s.title || shortPath(s.cwd) || s.session_id.slice(0, 8);
        const showCwd = Boolean(s.cwd) && Boolean(s.title);
        const conf = s.exact
          ? ""
          : `<span class="usage-badge usage-badge-soft" title="Matched by the window during which the agent process was alive in this terminal, not by an exact session id.">inferred</span>`;
        const branch = s.git_branch
          ? `<span class="usage-badge usage-badge-soft">${esc(s.git_branch)}</span>`
          : "";
        return `
        <div class="usage-session">
          <div class="usage-session-main">
            <div class="usage-session-name">${esc(name)}${conf}${branch}</div>
            <div class="usage-session-meta">
              <span class="usage-badge">${esc(harnessLabel(s.harness))}</span>
              <span>${esc(s.models.join(", ") || "—")}</span>
              <span>·</span>
              <span>${fmtWhen(s.ended_at)}</span>
              ${showCwd ? `<span>·</span><span title="${esc(s.cwd!)}">${esc(shortPath(s.cwd))}</span>` : ""}
            </div>
          </div>
          <div class="usage-session-nums">
            <div><strong>${fmtTokens(s.tokens.total)}</strong><span>tokens</span></div>
            <div><strong>${fmtInt(s.messages)}</strong><span>replies</span></div>
            <div><strong>${fmtInt(s.tool_calls)}</strong><span>tools</span></div>
            <div class="usage-session-cost"><strong>${
              s.priced ? fmtCost(s.cost_usd) : "—"
            }</strong><span>cost</span></div>
          </div>
        </div>`;
      })
      .join("");

    return `
      <section class="usage-section">
        <h3>Sessions <span class="usage-count">${u.sessions.length}</span></h3>
        <div class="usage-sessions">${rows}</div>
      </section>`;
  }

  function footerSection(u: PaneUsage): string {
    const unpriced = u.unpriced_models.length
      ? `<p><strong>Unpriced models:</strong> ${u.unpriced_models
          .map((m) => `<code>${esc(m)}</code>`)
          .join(", ")}. Their tokens are counted exactly but excluded from the
          cost total. Add rates in <code>${esc(pricingPath || "pricing.json")}</code>
          to include them.</p>`
      : "";
    const inferred = u.sessions.some((s) => !s.exact);
    const attribution = inferred
      ? `<p><strong>Attribution:</strong> sessions marked <em>inferred</em> were matched
         by the window during which the agent process was running in this terminal.
         Running the same harness in two terminals at once can blur that match.</p>`
      : `<p><strong>Attribution:</strong> every session here was linked to this
         terminal by process id, so the numbers are exact.</p>`;

    return `
      <section class="usage-section usage-foot">
        ${attribution}
        ${unpriced}
        <p class="usage-dim">Read from the harnesses' own local logs. Anthropic costs are
        computed from published list prices, including cache-write and cache-read
        multipliers; OpenCode reports its cost directly.</p>
      </section>`;
  }

  return { el, show, close, isOpen: () => open };
}
