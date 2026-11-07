import { invoke } from "@tauri-apps/api/core";
import type { PaneTerm } from "./terminals";

/** One pane as the search sees it. `term` is set for terminal panes only. */
export interface SearchPane {
  id: string;
  title: string;
  kind: "term" | "browser" | "file";
  term?: PaneTerm;
}

export interface SearchSession {
  id: string;
  name: string;
  color: string;
  cwd: string | null;
  panes: SearchPane[];
}

export interface SearchContext {
  /** Visible sessions, the active one first. */
  sessions: SearchSession[];
  activeSessionId: string | null;
  focusedPaneId: string | null;
}

export interface SearchModalHandlers {
  context(): SearchContext;
  goToSession(sessionId: string): void;
  /** Switches to the pane's session and focuses it. Returns its terminal, if any. */
  goToPane(paneId: string): PaneTerm | null;
  openFile(path: string, name: string, line?: number): void;
  /** Types a (shell-quoted) path into the focused terminal. */
  insertPath(path: string): void;
  resumeChat(agent: string, sessionId: string, cwd: string): void;
  openSiteInApp(url: string): void;
}

type Filter = "file" | "chat" | "term" | "site";

const FILTERS: { id: Filter; label: string; hint: string; aliases: string[] }[] = [
  { id: "file", label: "Files", hint: "Find files by name and by what's inside them", aliases: ["files", "f"] },
  { id: "chat", label: "Past chats", hint: "Search your Claude Code and Codex conversations", aliases: ["chats", "c"] },
  { id: "term", label: "Terminals", hint: "Search every open terminal, in every session", aliases: ["terms", "terminal", "t"] },
  { id: "site", label: "Website", hint: "Open a website in OpenTerm or in any browser", aliases: ["web", "url", "s"] },
];

interface ChatHit {
  agent: string;
  sessionId: string;
  cwd: string;
  title: string;
  at: number | null;
  fromUser: boolean;
  snippet: string;
  hits: number;
}
interface FileHit {
  root: string;
  rel: string;
  positions: number[];
}
interface ContentHit {
  root: string;
  rel: string;
  lines: { line: number; text: string }[];
  total: number;
}
interface Browser {
  id: string;
  name: string;
}

interface SubAction {
  label: string;
  run(): void;
}

interface Item {
  key: string;
  section: string;
  html: string;
  meta?: string;
  badge?: string;
  run(alt: boolean): void;
  /** Extra ways to open it, shown in a menu that unfolds on hover or →. */
  sub?: SubAction[];
}

const ICON_SEARCH =
  '<svg id="search-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="10.5" cy="10.5" r="6" stroke="currentColor" stroke-width="1.8"/>' +
  '<line x1="15.1" y1="15.1" x2="20.5" y2="20.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  "</svg>";
const CHEVRON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------- text helpers

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function wordsOf(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Escapes `text` and wraps every occurrence of each word in <mark>. */
function markWords(text: string, words: string[]): string {
  if (!words.length) return esc(text);
  const lower = text.toLowerCase();
  const hit = new Uint8Array(text.length);
  for (const w of words) {
    for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + w.length)) {
      hit.fill(1, i, i + w.length);
    }
  }
  return markRuns(text, hit);
}

function markRuns(text: string, hit: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const on = hit[i];
    let j = i;
    while (j < text.length && hit[j] === on) j++;
    const part = esc(text.slice(i, j));
    out += on ? `<mark>${part}</mark>` : part;
    i = j;
  }
  return out;
}

/** A window of `text` around the first word, so long lines show the match. */
function around(text: string, words: string[], width = 140): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= width) return t;
  const at = Math.max(0, t.toLowerCase().indexOf(words[0] ?? ""));
  const start = Math.max(0, Math.min(at - 40, t.length - width));
  return (start > 0 ? "…" : "") + t.slice(start, start + width) + (start + width < t.length ? "…" : "");
}

/** Substring-first fuzzy score of `q` in `s` (both lower-case); null = no match. */
function fuzzy(s: string, q: string): number | null {
  if (!q) return null;
  const i = s.indexOf(q);
  if (i !== -1) return 100 - i + (i === 0 ? 50 : 0) + (s.length === q.length ? 80 : 0);
  let si = 0;
  let score = 0;
  for (const c of q) {
    const f = s.indexOf(c, si);
    if (f === -1) return null;
    score += f === si ? 3 : 1;
    si = f + 1;
  }
  return score > q.length * 1.5 ? score : null;
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}`;
}

function sameDir(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return n(a) === n(b);
}

function ago(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const TLDS = new Set(
  "com org net io dev app ai co ro uk de fr es it nl eu me sh so gg xyz info edu gov tv us ca au in jp br ch se no pl cz at be dk fi pt ie site tech page cloud vercel".split(" ")
);

/** The query as a web address, or null when it doesn't look like one. Loose
 *  (anything goes) under `site:`, strict otherwise so `main.ts` stays a file. */
function asUrl(q: string, loose: boolean): string | null {
  const t = q.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return t;
  const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(:\d+)?(\/.*)?$/i.exec(t);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const local = host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (local) return `http://${t}`;
  if (!host.includes(".")) return loose ? `https://${t}.com` : null;
  const tld = host.split(".").pop()!;
  if (loose || host.startsWith("www.") || TLDS.has(tld)) return `https://${t}`;
  return null;
}

// ---------------------------------------------------------------- the popup

/** Universal search (Ctrl+S). One box over everything you'd look for while
 *  working: open terminals (the focused one first, then its session, then the
 *  rest), panes and sessions by name, files by name and by content, past agent
 *  conversations, and websites. `file:`, `chat:`, `term:` and `site:` narrow it
 *  to one kind.
 *
 *  Terminals are searched synchronously from xterm's buffers, so they show up
 *  on the first frame; the disk-backed kinds (search.rs) stream in after and
 *  slot into their own sections, so nothing that's already on screen moves.
 *
 *  Opening a terminal hit lights up the match in that pane and leaves it lit
 *  until Esc, the same way the old single-terminal search did. */
export function createSearchModal(handlers: SearchModalHandlers) {
  const el = document.createElement("div");
  el.className = "search-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "search-modal";

  // ---- the glowing "portal" input ----
  const container = document.createElement("div");
  container.className = "search-container";
  container.id = "poda";
  for (const cls of ["glow", "darkBorderBg", "white", "border"]) {
    const d = document.createElement("div");
    d.className = cls;
    container.appendChild(d);
  }
  const main = document.createElement("div");
  main.id = "main";
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "search-chip";
  chip.hidden = true;
  chip.title = "Remove filter (Backspace)";
  const input = document.createElement("input");
  input.className = "search-input";
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  const inputMask = document.createElement("div");
  inputMask.id = "input-mask";
  const pinkMask = document.createElement("div");
  pinkMask.id = "pink-mask";
  const icon = document.createElement("div");
  icon.innerHTML = ICON_SEARCH;
  main.append(input, inputMask, pinkMask, icon.firstElementChild!, chip);
  container.appendChild(main);

  const results = document.createElement("div");
  results.className = "search-results";
  results.setAttribute("role", "listbox");

  const footer = document.createElement("div");
  footer.className = "search-footer";

  modal.append(container, results, footer);
  el.appendChild(modal);

  let open = false;
  let filter: Filter | null = null;
  let query = "";
  let token = 0;
  let items: Item[] = [];
  let selected = 0;
  /** Index into the selected item's `sub` menu while it's unfolded, else -1. */
  let subSel = -1;
  let subOpenFor: string | null = null;
  let ctx: SearchContext = { sessions: [], activeSessionId: null, focusedPaneId: null };

  // Async sections, filled as their requests come back.
  let chats: ChatHit[] | null = null;
  let names: FileHit[] | null = null;
  let contents: ContentHit[] | null = null;
  let browsers: Browser[] | null = null;
  const timers: number[] = [];

  /** Pane holding a committed highlight: set when a terminal hit is opened,
   *  cleared on Esc (main.ts routes that here while the popup is closed). */
  let activePane: PaneTerm | null = null;

  function clearActivePreview(): void {
    activePane?.clearHighlight();
    activePane = null;
  }

  // ---------------------------------------------------------------- filters

  function setFilter(f: Filter | null): void {
    filter = f;
    const def = FILTERS.find((x) => x.id === f);
    chip.hidden = !def;
    chip.textContent = def ? def.label : "";
    container.classList.toggle("has-chip", !!def);
    if (def) requestAnimationFrame(() => container.style.setProperty("--chip-w", `${chip.offsetWidth + 8}px`));
    input.placeholder = def
      ? def.id === "site"
        ? "Type a web address…"
        : `Search ${def.label.toLowerCase()}…`
      : "Search terminals, files, past chats…  (file:  chat:  term:  site:)";
  }

  /** `file:` / `chat:` … typed at the start of the box become the chip. */
  function absorbPrefix(): void {
    const m = /^([a-z]+):\s*/i.exec(input.value);
    if (!m) return;
    const name = m[1].toLowerCase();
    const def = FILTERS.find((f) => f.id === name || f.aliases.includes(name));
    // Single letters only count once you've typed the space after them, so
    // `c:\path` or `s:` mid-thought don't snap into a filter.
    if (!def || (name.length === 1 && !/\s$/.test(m[0]))) return;
    input.value = input.value.slice(m[0].length);
    setFilter(def.id);
  }

  chip.addEventListener("click", () => {
    setFilter(null);
    input.focus();
    schedule();
  });

  // ---------------------------------------------------------------- searching

  function roots(): string[] {
    const out: string[] = [];
    for (const s of ctx.sessions) {
      if (s.cwd && !out.some((r) => sameDir(r, s.cwd))) out.push(s.cwd);
    }
    return out;
  }

  function loadBrowsers(): void {
    browsers = [];
    void invoke<Browser[]>("list_browsers")
      .then((b) => {
        browsers = b;
        if (open) render();
      })
      .catch(() => {});
  }

  function clearTimers(): void {
    while (timers.length) window.clearTimeout(timers.pop());
  }

  function later(ms: number, fn: () => void): void {
    timers.push(window.setTimeout(fn, ms));
  }

  /** Re-runs the search for the current box. Terminal hits render on the next
   *  frame; each disk-backed kind fires after its own short pause so fast
   *  typing doesn't send a request per key. */
  function schedule(): void {
    query = input.value.trim();
    const my = ++token;
    clearTimers();
    chats = names = contents = null;
    const q = query;
    const want = (f: Filter) => filter === null || filter === f;
    if (q && filter !== "site") {
      const rs = roots();
      if (want("file") && rs.length) {
        later(40, () => {
          void invoke<FileHit[]>("search_file_names", { query: q, roots: rs, limit: filter ? 40 : 6 })
            .then((r) => {
              if (my === token) ((names = r), render());
            })
            .catch(() => {});
        });
        // Content scans are the expensive one; wait until typing settles.
        if (q.length >= 3) {
          later(filter ? 140 : 220, () => {
            const scope = filter ? rs : rs.slice(0, 1);
            void invoke<ContentHit[]>("search_file_contents", { query: q, roots: scope, limit: filter ? 60 : 6 })
              .then((r) => {
                if (my === token) ((contents = r), render());
              })
              .catch(() => {});
          });
        }
      }
      if (want("chat")) {
        later(90, () => {
          void invoke<ChatHit[]>("search_chats", { query: q, limit: filter ? 60 : 5 })
            .then((r) => {
              if (my === token) ((chats = r), render());
            })
            .catch(() => {});
        });
      }
    }
    render();
  }

  // ---------------------------------------------------------------- building results

  function paneLabel(sessionId: string, paneId: string): string {
    const s = ctx.sessions.find((x) => x.id === sessionId);
    const p = s?.panes.find((x) => x.id === paneId);
    return [s?.name, p?.title].filter(Boolean).join(" · ");
  }

  function terminalItems(words: string[]): Item[] {
    const out: Item[] = [];
    const all = filter === "term";
    // Focused pane, then the rest of its session, then every other session.
    const order: { session: SearchSession; pane: SearchPane; tier: 0 | 1 | 2 }[] = [];
    for (const s of ctx.sessions) {
      for (const p of s.panes) {
        if (!p.term) continue;
        const tier = p.id === ctx.focusedPaneId ? 0 : s.id === ctx.activeSessionId ? 1 : 2;
        order.push({ session: s, pane: p, tier });
      }
    }
    order.sort((a, b) => a.tier - b.tier);
    const section = ["This terminal", "This session", "Other sessions"];
    const perPane = all ? 12 : [5, 3, 2];
    const perTier = all ? 400 : [5, 6, 6];
    const used = [0, 0, 0];
    const phrase = words.join(" ");
    for (const { session, pane, tier } of order) {
      const cap = typeof perTier === "number" ? perTier : perTier[tier];
      if (used[tier] >= cap) continue;
      const max = typeof perPane === "number" ? perPane : perPane[tier];
      const { hits, total } = pane.term!.searchLines(words, Math.min(max, cap - used[tier]));
      hits.forEach((h, i) => {
        used[tier]++;
        const needle = h.text.toLowerCase().includes(phrase) ? phrase : [...words].sort((a, b) => b.length - a.length)[0];
        out.push({
          key: `t:${pane.id}:${h.row}`,
          section: section[tier],
          html: markWords(around(h.text, words), words),
          meta: tier === 0 ? pane.title : paneLabel(session.id, pane.id),
          badge: i === 0 && total > hits.length ? `${total} matches` : undefined,
          run: () => {
            const term = handlers.goToPane(pane.id);
            if (!term) return;
            clearActivePreview();
            term.revealMatch(needle, h.row);
            activePane = term;
          },
        });
      });
    }
    return out;
  }

  function goToItems(q: string): Item[] {
    const lq = q.toLowerCase();
    const scored: { score: number; item: Item }[] = [];
    for (const s of ctx.sessions) {
      const sc = fuzzy(s.name.toLowerCase(), lq);
      if (sc !== null) {
        scored.push({
          score: sc + 20,
          item: {
            key: `s:${s.id}`,
            section: "Go to",
            html: `<span class="search-dot" style="background:${esc(s.color)}"></span>${esc(s.name)}`,
            meta: "Session",
            run: () => handlers.goToSession(s.id),
          },
        });
      }
      for (const p of s.panes) {
        const pc = fuzzy(p.title.toLowerCase(), lq);
        if (pc === null) continue;
        scored.push({
          score: pc,
          item: {
            key: `p:${p.id}`,
            section: "Go to",
            html: esc(p.title),
            meta: `${p.kind === "browser" ? "Browser" : p.kind === "file" ? "File" : "Terminal"} in ${s.name}`,
            run: () => void handlers.goToPane(p.id),
          },
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 4).map((x) => x.item);
  }

  function siteItem(url: string): Item {
    const sub: SubAction[] = [
      { label: "OpenTerm browser pane", run: () => handlers.openSiteInApp(url) },
      { label: "Default browser", run: () => void invoke("open_url", { url }).catch(() => {}) },
      ...(browsers ?? []).map((b) => ({
        label: b.name,
        run: () => void invoke("open_url_with", { browserId: b.id, url }).catch(() => {}),
      })),
    ];
    return {
      key: `w:${url}`,
      section: "Website",
      html: `Open <strong>${esc(url.replace(/^https?:\/\//, ""))}</strong>`,
      meta: "in OpenTerm",
      run: (alt) => (alt ? sub[1].run() : handlers.openSiteInApp(url)),
      sub,
    };
  }

  function fileItems(words: string[]): Item[] {
    const out: Item[] = [];
    const current = ctx.sessions[0]?.cwd;
    for (const f of names ?? []) {
      const name = baseName(f.rel);
      const dirLen = f.rel.length - name.length;
      const hit = new Uint8Array(f.rel.length);
      for (const p of f.positions) if (p < hit.length) hit[p] = 1;
      const path = joinPath(f.root, f.rel);
      const dir = f.rel.slice(0, Math.max(0, dirLen - 1));
      out.push({
        key: `f:${path}`,
        section: "Files",
        html: markRuns(name, hit.subarray(dirLen)),
        meta: (sameDir(f.root, current) ? "" : baseName(f.root) + (dir ? "/" : "")) + dir,
        run: (alt) => (alt ? handlers.insertPath(path) : handlers.openFile(path, name)),
      });
    }
    for (const c of contents ?? []) {
      const name = baseName(c.rel);
      const path = joinPath(c.root, c.rel);
      const lines = filter === "file" ? c.lines : c.lines.slice(0, 1);
      for (const l of lines) {
        out.push({
          key: `c:${path}:${l.line}`,
          section: "In files",
          html: markWords(around(l.text, words), words),
          meta: `${sameDir(c.root, current) ? "" : baseName(c.root) + "/"}${c.rel}:${l.line}`,
          badge: l === lines[0] && c.total > lines.length ? `${c.total} lines` : undefined,
          run: (alt) => (alt ? handlers.insertPath(path) : handlers.openFile(path, name, l.line)),
        });
      }
    }
    return out;
  }

  function chatItems(words: string[]): Item[] {
    return (chats ?? []).map((c) => ({
      key: `h:${c.agent}:${c.sessionId}`,
      section: "Past chats",
      html: markWords(c.snippet, words),
      meta: [
        c.agent === "codex" ? "Codex" : "Claude Code",
        c.cwd ? baseName(c.cwd) : "",
        ago(c.at),
        c.title && c.title !== c.snippet ? `“${c.title}”` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      badge: c.fromUser ? "You" : "Agent",
      run: () => handlers.resumeChat(c.agent, c.sessionId, c.cwd),
    }));
  }

  function filterItems(): Item[] {
    return FILTERS.map((f) => ({
      key: `x:${f.id}`,
      section: "Search in",
      html: `<span class="search-kbd-like">${f.id}:</span> ${esc(f.label)}`,
      meta: f.hint,
      run: () => {
        setFilter(f.id);
        input.focus();
        schedule();
      },
    }));
  }

  function build(): { items: Item[]; pending: string[] } {
    const q = query;
    const words = wordsOf(q);
    const pending: string[] = [];
    if (!q) return { items: filter ? [] : filterItems(), pending };
    const out: Item[] = [];
    const url = asUrl(q, filter === "site");
    if (url && (filter === null || filter === "site")) {
      if (browsers === null) loadBrowsers();
      out.push(siteItem(url));
    }
    if (filter === "site") return { items: out, pending };
    if (filter === null) out.push(...goToItems(q));
    if (filter === null || filter === "term") out.push(...terminalItems(words));
    if (filter === null || filter === "file") {
      if (ctx.sessions.some((s) => s.cwd)) {
        out.push(...fileItems(words));
        if (names === null || (contents === null && q.length >= 3)) pending.push("files");
      }
    }
    if (filter === null || filter === "chat") {
      out.push(...chatItems(words));
      if (chats === null) pending.push("past chats");
    }
    // Keep sections contiguous in a fixed order whatever arrived first.
    const rank = ["Website", "Go to", "This terminal", "This session", "Other sessions", "Files", "In files", "Past chats"];
    out.sort((a, b) => rank.indexOf(a.section) - rank.indexOf(b.section));
    return { items: out, pending };
  }

  // ---------------------------------------------------------------- rendering

  function render(): void {
    const prevKey = items[selected]?.key;
    const { items: next, pending } = build();
    items = next;
    const keep = prevKey ? items.findIndex((i) => i.key === prevKey) : -1;
    // A result arriving above the selection doesn't steal it; otherwise the
    // top result is selected so Enter always does the obvious thing.
    selected = keep >= 0 ? keep : 0;
    if (subOpenFor !== items[selected]?.key) {
      subOpenFor = null;
      subSel = -1;
    }

    const frag = document.createDocumentFragment();
    let lastSection = "";
    items.forEach((it, i) => {
      if (it.section !== lastSection) {
        lastSection = it.section;
        const h = document.createElement("div");
        h.className = "search-section";
        h.textContent = it.section;
        frag.appendChild(h);
      }
      const row = document.createElement("div");
      row.className = "search-row" + (i === selected ? " selected" : "");
      row.setAttribute("role", "option");
      row.dataset.index = String(i);
      row.innerHTML =
        `<div class="search-row-main"><div class="search-row-text">${it.html}</div>` +
        (it.meta ? `<div class="search-row-meta">${esc(it.meta)}</div>` : "") +
        `</div>` +
        (it.badge ? `<span class="search-badge">${esc(it.badge)}</span>` : "") +
        (it.sub ? `<span class="search-more" title="More ways to open">${CHEVRON}</span>` : "");
      if (it.sub && subOpenFor === it.key) row.appendChild(subMenu(it));
      frag.appendChild(row);
    });
    if (query && !items.length && !pending.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = filter === "site" ? "That doesn't look like a web address." : "No results";
      frag.appendChild(empty);
    }
    if (pending.length) {
      const p = document.createElement("div");
      p.className = "search-pending";
      p.textContent = `Searching ${pending.join(" and ")}…`;
      frag.appendChild(p);
    }
    results.replaceChildren(frag);
    results.hidden = !results.childElementCount;
    scrollSelectedIntoView();
    renderFooter();
  }

  function subMenu(it: Item): HTMLElement {
    const menu = document.createElement("div");
    menu.className = "search-submenu";
    it.sub!.forEach((s, i) => {
      const b = document.createElement("div");
      b.className = "search-subitem" + (i === subSel ? " selected" : "");
      b.textContent = s.label;
      b.addEventListener("pointerenter", () => {
        subSel = i;
        menu.querySelectorAll(".search-subitem").forEach((x, j) => x.classList.toggle("selected", j === i));
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        s.run();
      });
      menu.appendChild(b);
    });
    return menu;
  }

  function renderFooter(): void {
    const it = items[selected];
    const hints: string[] = ["<kbd>↑↓</kbd> Move", "<kbd>Enter</kbd> Open"];
    if (it?.sub) hints.push("<kbd>→</kbd> Open with…");
    else if (it && (it.key.startsWith("f:") || it.key.startsWith("c:"))) hints.push("<kbd>Ctrl+Enter</kbd> Insert path");
    hints.push("<kbd>Tab</kbd> Filter", "<kbd>Esc</kbd> Close");
    footer.innerHTML = hints.map((h) => `<span class="search-hint">${h}</span>`).join("");
  }

  function scrollSelectedIntoView(): void {
    results.querySelector(".search-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  function select(i: number): void {
    if (!items.length) return;
    selected = (i + items.length) % items.length;
    subOpenFor = null;
    subSel = -1;
    results.querySelectorAll<HTMLElement>(".search-row").forEach((r) => {
      r.classList.toggle("selected", Number(r.dataset.index) === selected);
      r.querySelector(".search-submenu")?.remove();
    });
    scrollSelectedIntoView();
    renderFooter();
  }

  function openSub(i: number): void {
    const it = items[i];
    if (!it?.sub) return;
    selected = i;
    subOpenFor = it.key;
    if (subSel < 0) subSel = 0;
    const row = results.querySelector<HTMLElement>(`.search-row[data-index="${i}"]`);
    if (row && !row.querySelector(".search-submenu")) row.appendChild(subMenu(it));
    results.querySelectorAll<HTMLElement>(".search-row").forEach((r) =>
      r.classList.toggle("selected", Number(r.dataset.index) === selected)
    );
    renderFooter();
  }

  function closeSub(): void {
    subOpenFor = null;
    subSel = -1;
    results.querySelectorAll(".search-submenu").forEach((m) => m.remove());
  }

  function activate(alt: boolean): void {
    const it = items[selected];
    if (!it) return;
    if (subOpenFor === it.key && subSel >= 0 && it.sub) {
      const s = it.sub[subSel];
      close();
      s.run();
      return;
    }
    // Choosing a filter keeps the popup open; everything else closes it.
    if (it.key.startsWith("x:")) return it.run(alt);
    close();
    it.run(alt);
  }

  results.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".search-row");
    if (!row) return;
    selected = Number(row.dataset.index);
    if ((e.target as HTMLElement).closest(".search-more")) return openSub(selected);
    activate(e.ctrlKey);
  });
  results.addEventListener("pointerover", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".search-row");
    if (!row) return;
    const i = Number(row.dataset.index);
    // Hovering a row with more ways to open unfolds them, as asked of the
    // website row; plain rows just follow the pointer.
    if (items[i]?.sub) {
      if (subOpenFor !== items[i].key) openSub(i);
    } else if (i !== selected) {
      select(i);
    }
  });

  input.addEventListener("input", () => {
    absorbPrefix();
    subSel = -1;
    subOpenFor = null;
    schedule();
  });

  input.addEventListener("keydown", (e) => {
    // Owns every key while open — the app's global shortcut handler stands
    // down for it (see main.ts), so this is the only place these fire.
    e.stopPropagation();
    const it = items[selected];
    const subOpen = !!it && subOpenFor === it.key;
    if (e.key === "Enter") {
      e.preventDefault();
      activate(e.ctrlKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (subOpen) closeSub();
      else close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      if (subOpen && it.sub) {
        subSel = (subSel + d + it.sub.length) % it.sub.length;
        results
          .querySelectorAll(".search-subitem")
          .forEach((x, j) => x.classList.toggle("selected", j === subSel));
      } else {
        select(selected + d);
      }
    } else if (e.key === "ArrowRight" && it?.sub && input.selectionStart === input.value.length) {
      e.preventDefault();
      openSub(selected);
    } else if (e.key === "ArrowLeft" && subOpen) {
      e.preventDefault();
      closeSub();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const ids: (Filter | null)[] = [null, ...FILTERS.map((f) => f.id)];
      const at = ids.indexOf(filter);
      setFilter(ids[(at + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
      schedule();
    } else if (e.key === "Backspace" && filter && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      setFilter(null);
      schedule();
    }
  });

  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) close();
  });
  modal.addEventListener("pointerdown", (e) => e.stopPropagation());

  function close(): void {
    if (!open) return;
    open = false;
    token++;
    clearTimers();
    el.classList.remove("visible");
  }

  function openModal(): void {
    clearActivePreview(); // starting a new search retires the previous one
    ctx = handlers.context();
    open = true;
    input.value = "";
    setFilter(null);
    items = [];
    selected = 0;
    subOpenFor = null;
    subSel = -1;
    browsers = null;
    schedule();
    el.classList.add("visible");
    requestAnimationFrame(() => input.focus());
    // Get the chat index and file lists building while the first word is typed.
    void invoke("search_warm", { roots: roots() }).catch(() => {});
  }

  return {
    el,
    open: openModal,
    close,
    isOpen: () => open,
    hasActivePreview: () => activePane !== null,
    clearActivePreview,
  };
}
