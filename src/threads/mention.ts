/** @-mentions in the Threads composer: files of the thread's folder (the
 *  app's gitignore-aware fuzzy index in search.rs, cached per root, so every
 *  keystroke is one fast in-memory scan) and other threads.
 *
 *  Empty `@` guesses: files you mentioned here before, files this thread
 *  changed, and the threads you were in last. Typing ranks by the fuzzy
 *  score, with those same signals as a nudge. A file goes in as `@rel/path`
 *  (the agent opens it); a thread as `@[Title]`, which the send step expands
 *  into a short brief of that conversation. */
import { invoke } from "@tauri-apps/api/core";
import { engine, type Runtime } from "./engine";
import { ic } from "./icons";
import { markSvg } from "../paneIcons";
import { esc, fileKind } from "./render";
import { ago } from "./sidebar";
import { HARNESS_LABEL } from "./model";

interface FileHit {
  root: string;
  rel: string;
  positions: number[];
}

type Option =
  | { kind: "thread"; id: string; title: string; rt: Runtime }
  | { kind: "file"; rel: string; positions: number[]; reason?: string }
  | { kind: "folder"; rel: string };

const MRU_KEY = "openterm.threads.mentions.";
const MRU_MAX = 24;

function mru(cwd: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MRU_KEY + cwd.toLowerCase()) ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function remember(cwd: string, rel: string): void {
  try {
    const list = [rel, ...mru(cwd).filter((x) => x !== rel)].slice(0, MRU_MAX);
    localStorage.setItem(MRU_KEY + cwd.toLowerCase(), JSON.stringify(list));
  } catch {
    /* convenience only */
  }
}

/** Highlights matched character indices of `text` (offset by `from`). */
function marked(text: string, positions: number[], from: number): string {
  if (!positions.length) return esc(text);
  const set = new Set(positions.map((p) => p - from));
  let out = "";
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const on = set.has(i);
    if (on !== open) {
      out += on ? "<mark>" : "</mark>";
      open = on;
    }
    out += esc(text[i]);
  }
  return out + (open ? "</mark>" : "");
}

function relOf(cwd: string, abs: string): string {
  const a = abs.replace(/\\/g, "/");
  const c = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  return a.toLowerCase().startsWith(c.toLowerCase() + "/") ? a.slice(c.length + 1) : a;
}

export function mentionToken(rel: string): string {
  return /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
}

/** Thread mentions in a message, by title. */
export const THREAD_MENTION = /@\[([^\]\n]{1,120})\]/g;

/** Expands `@[Title]` mentions into briefs of those conversations, so the
 *  agent knows what the other thread did without the user pasting it. */
export async function threadBriefs(text: string, self: Runtime): Promise<string> {
  const titles = [...new Set([...text.matchAll(THREAD_MENTION)].map((m) => m[1]))];
  if (!titles.length) return "";
  const out: string[] = [];
  for (const title of titles) {
    const rt = engine.list().find((r) => r !== self && r.meta.title === title);
    if (!rt) continue;
    await engine.ensureLoaded(rt);
    const lines: string[] = [];
    for (const id of rt.order) {
      const it = rt.items.get(id);
      if (!it || ("parent" in it && it.parent)) continue;
      if (it.kind === "user" && it.text) lines.push(`User: ${it.text.slice(0, 500)}`);
      else if (it.kind === "text" && it.text) lines.push(`Agent: ${it.text.slice(0, 900)}`);
    }
    const files = [...rt.files.values()].map((f) => f.path).slice(0, 20);
    let brief = lines.slice(-8).join("\n\n");
    if (brief.length > 5000) brief = "…" + brief.slice(-5000);
    out.push(
      `<thread title="${title.replace(/"/g, "'")}" agent="${HARNESS_LABEL[rt.meta.harness]}" folder="${rt.meta.cwd}"${rt.meta.sessionId ? ` session="${rt.meta.sessionId}"` : ""}>\n${
        brief || "(no messages yet)"
      }${files.length ? `\n\nFiles it changed:\n${files.map((f) => `- ${f}`).join("\n")}` : ""}\n</thread>`
    );
  }
  return out.length ? `\n\nReferenced conversation${out.length > 1 ? "s" : ""} (other OpenTerm threads the user tagged with @):\n${out.join("\n\n")}` : "";
}

export function createMention(opts: {
  input: HTMLTextAreaElement;
  host: HTMLElement;
  current: () => Runtime | null;
  changed: () => void;
}) {
  const { input, host } = opts;
  const el = document.createElement("div");
  el.className = "tv-mention";
  el.hidden = true;
  el.setAttribute("role", "listbox");
  host.appendChild(el);

  let options: Option[] = [];
  let index = 0;
  let token: { start: number; end: number; q: string } | null = null;
  let seq = 0;
  let warmed = "";
  let lastKey = "";

  /** The `@word` the caret sits in, if any. */
  function tokenAtCaret(): { start: number; end: number; q: string } | null {
    if (input.selectionStart !== input.selectionEnd) return null;
    const caret = input.selectionStart ?? 0;
    const before = input.value.slice(0, caret);
    const m = /(^|[\s(])@("[^"\n]*|\[[^\]\n]*|[^\s@]*)$/.exec(before);
    if (!m) return null;
    const start = caret - m[2].length - 1;
    let end = caret;
    while (end < input.value.length && !/\s/.test(input.value[end])) end++;
    return { start, end, q: m[2].replace(/^["[]/, "") };
  }

  function warm(rt: Runtime): void {
    if (warmed === rt.meta.cwd) return;
    warmed = rt.meta.cwd;
    void invoke("search_warm", { roots: [rt.meta.cwd] }).catch(() => {});
  }

  function threadOptions(rt: Runtime, q: string): Option[] {
    const ql = q.toLowerCase();
    return engine
      .list()
      .filter((r) => r !== rt && !r.meta.archived && r.meta.stats.turns > 0)
      .map((r) => {
        const t = r.meta.title.toLowerCase();
        let s = r.meta.updatedAt / 1e12; // recency as a tie-break
        if (ql) {
          const i = t.indexOf(ql);
          if (i < 0 && !ql.split(/\s+/).every((w) => t.includes(w))) return null;
          s += i === 0 ? 30 : i > 0 ? 20 : 10;
        }
        if (r.meta.cwd.toLowerCase() === rt.meta.cwd.toLowerCase()) s += 5;
        if (r.busy || r.approvals.length) s += 3;
        return { s, o: { kind: "thread", id: r.meta.id, title: r.meta.title, rt: r } as Option };
      })
      .filter((x): x is { s: number; o: Option } => !!x)
      .sort((a, b) => b.s - a.s)
      .slice(0, ql ? 3 : 3)
      .map((x) => x.o);
  }

  async function refresh(): Promise<void> {
    const rt = opts.current();
    token = rt ? tokenAtCaret() : null;
    if (!rt || !token) return close();
    warm(rt);
    const q = token.q.trim();
    const key = `${rt.meta.id}|${q}`;
    if (key === lastKey && !el.hidden) return;
    lastKey = key;
    const my = ++seq;
    const recent = mru(rt.meta.cwd);
    const touched = [...rt.files.values()].map((f) => relOf(rt.meta.cwd, f.path));
    const threads = threadOptions(rt, q);
    let files: Option[] = [];
    let folders: Option[] = [];
    if (!q) {
      const seen = new Set<string>();
      for (const r of recent) if (!seen.has(r) && seen.add(r)) files.push({ kind: "file", rel: r, positions: [], reason: "Recent" });
      for (const r of touched) if (!seen.has(r) && seen.add(r)) files.push({ kind: "file", rel: r, positions: [], reason: "Changed here" });
      files = files.slice(0, 7);
    } else {
      // Render threads at once; files land a moment later on a cold index.
      if (my === seq) paint(rt, threads, [], [], true);
      let hits: FileHit[] = [];
      try {
        hits = await invoke<FileHit[]>("search_file_names", { query: q, roots: [rt.meta.cwd], limit: 40 });
      } catch {
        hits = [];
      }
      if (my !== seq) return;
      const boost = new Map<string, number>();
      recent.forEach((r, i) => boost.set(r, 3 - Math.min(2, i / 8)));
      for (const r of touched) boost.set(r, Math.max(boost.get(r) ?? 0, 2));
      // Keep the engine's order but pull familiar files up past strangers.
      const ranked = hits.map((h, i) => ({ h, s: -i + (boost.get(h.rel) ?? 0) * 4 })).sort((a, b) => b.s - a.s);
      files = ranked.slice(0, 8).map(({ h }) => ({ kind: "file", rel: h.rel, positions: h.positions, reason: boost.has(h.rel) ? (recent.includes(h.rel) ? "Recent" : "Changed here") : undefined }));
      // Folders whose own name matches the query.
      const ql = q.toLowerCase().replace(/[\\/]+$/, "");
      const dirs = new Set<string>();
      for (const h of hits) {
        const parts = h.rel.split("/");
        for (let i = parts.length - 1; i > 0; i--) {
          const dir = parts.slice(0, i).join("/");
          if (parts[i - 1].toLowerCase().includes(ql)) dirs.add(dir);
        }
      }
      folders = [...dirs]
        .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)
        .slice(0, 2)
        .map((rel) => ({ kind: "folder", rel }));
    }
    if (my !== seq) return;
    paint(rt, threads, folders, files, false);
  }

  function paint(rt: Runtime, threads: Option[], folders: Option[], files: Option[], loading: boolean): void {
    const prevKey = optKey(options[index]);
    options = [...files, ...folders, ...threads];
    // Files first when typing a path-like query, threads first otherwise.
    const q = token?.q ?? "";
    if (!/[./\\]/.test(q) && threads.length && q && !files.length) options = [...threads, ...files, ...folders];
    const keep = options.findIndex((o) => optKey(o) === prevKey);
    index = keep >= 0 ? keep : 0;
    if (!options.length && !loading) {
      el.hidden = false;
      el.innerHTML = `<div class="tv-mention-empty">${ic("search", 14)}<span>${q ? `Nothing matches <b>${esc(q)}</b> in ${esc(rt.meta.cwd.split(/[\\/]/).pop() ?? "")}` : "Type to search files and threads"}</span></div>${foot()}`;
      return;
    }
    if (!options.length) return;
    const sec = (title: string, list: Option[], extra = "") =>
      list.length ? `<div class="tv-mention-sec"><div class="tv-mention-label">${title}${extra}</div>${list.map((o) => row(o, options.indexOf(o))).join("")}</div>` : "";
    const order = options[0]?.kind === "thread" ? ["thread", "file"] : ["file", "thread"];
    const blocks: Record<string, string> = {
      file: sec(q ? "Files" : "Suggested", [...files, ...folders], loading ? `<span class="tv-mention-spin"></span>` : ""),
      thread: sec("Threads", threads),
    };
    el.innerHTML = `<div class="tv-mention-list">${order.map((k) => blocks[k]).join("")}</div>${foot()}`;
    el.hidden = false;
    el.querySelector<HTMLElement>(".tv-mention-row.on")?.scrollIntoView({ block: "nearest" });
  }

  function foot(): string {
    return `<div class="tv-mention-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> insert</span><span><kbd>Esc</kbd> close</span></div>`;
  }

  function optKey(o?: Option): string {
    return !o ? "" : o.kind === "thread" ? `t:${o.id}` : `${o.kind}:${o.rel}`;
  }

  function row(o: Option, i: number): string {
    const on = i === index ? "on" : "";
    if (o.kind === "thread") {
      const r = o.rt;
      const st = r.approvals.length ? `<span class="tv-mention-st wait">Needs you</span>` : r.busy ? `<span class="tv-mention-st run">Working</span>` : `<span class="tv-mention-st">${ago(r.meta.updatedAt)}</span>`;
      return `<button class="tv-mention-row ${on}" data-i="${i}" type="button" role="option" aria-selected="${!!on}">
        <span class="tv-mention-icon thread">${markSvg(r.meta.harness)}</span>
        <span class="tv-mention-text"><span class="tv-mention-name">${esc(o.title)}</span><span class="tv-mention-dir">${esc(r.meta.activity || r.meta.cwd.split(/[\\/]/).pop() || "")}</span></span>
        ${st}
      </button>`;
    }
    if (o.kind === "folder") {
      const name = o.rel.split("/").pop() ?? o.rel;
      const dir = o.rel.slice(0, o.rel.length - name.length).replace(/\/$/, "");
      return `<button class="tv-mention-row ${on}" data-i="${i}" type="button" role="option" aria-selected="${!!on}">
        <span class="tv-mention-icon folder">${ic("folder", 14)}</span>
        <span class="tv-mention-text"><span class="tv-mention-name">${esc(name)}/</span>${dir ? `<span class="tv-mention-dir">${esc(dir)}</span>` : ""}</span>
        <span class="tv-mention-st">Folder</span>
      </button>`;
    }
    const nameAt = o.rel.lastIndexOf("/") + 1;
    const name = o.rel.slice(nameAt);
    const dir = o.rel.slice(0, Math.max(0, nameAt - 1));
    const k = fileKind(name);
    return `<button class="tv-mention-row ${on}" data-i="${i}" type="button" role="option" aria-selected="${!!on}" title="${esc(o.rel)}">
      <span class="tv-fext k-${k.kind}">${esc(k.ext)}</span>
      <span class="tv-mention-text"><span class="tv-mention-name">${marked(name, o.positions, nameAt)}</span>${dir ? `<span class="tv-mention-dir">${marked(dir, o.positions, 0)}</span>` : ""}</span>
      ${o.reason ? `<span class="tv-mention-st">${o.reason}</span>` : ""}
    </button>`;
  }

  function pick(i: number): void {
    const o = options[i];
    const rt = opts.current();
    if (!o || !token || !rt) return;
    const ins = o.kind === "thread" ? `@[${o.title}]` : o.kind === "folder" ? mentionToken(o.rel + "/") : mentionToken(o.rel);
    if (o.kind !== "thread") remember(rt.meta.cwd, o.kind === "folder" ? o.rel + "/" : o.rel);
    const v = input.value;
    const after = v.slice(token.end);
    const pad = after.startsWith(" ") ? "" : " ";
    input.value = v.slice(0, token.start) + ins + pad + after;
    const caret = token.start + ins.length + pad.length;
    input.setSelectionRange(caret, caret);
    close();
    input.focus();
    opts.changed();
  }

  function close(): void {
    seq++;
    lastKey = "";
    token = null;
    options = [];
    el.hidden = true;
    el.innerHTML = "";
  }

  function move(d: number): void {
    if (!options.length) return;
    index = (index + d + options.length) % options.length;
    for (const b of el.querySelectorAll<HTMLElement>(".tv-mention-row")) {
      const on = Number(b.dataset.i) === index;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      if (on) b.scrollIntoView({ block: "nearest" });
    }
  }

  el.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the caret
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tv-mention-row");
    if (b) pick(Number(b.dataset.i));
  });
  el.addEventListener("pointermove", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".tv-mention-row");
    if (b && Number(b.dataset.i) !== index) move(Number(b.dataset.i) - index);
  });
  input.addEventListener("blur", () => window.setTimeout(() => document.activeElement !== input && close(), 120));
  input.addEventListener("click", () => void refresh());
  input.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") void refresh();
  });

  return {
    isOpen: () => !el.hidden,
    refresh: () => void refresh(),
    close,
    /** Returns true when the popup consumed the key. */
    key(e: KeyboardEvent): boolean {
      if (el.hidden) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        move(e.key === "ArrowDown" ? 1 : -1);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        if (!options.length) return false;
        e.preventDefault();
        pick(index);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
    /** Opens the picker from the @ button. */
    start(): void {
      const at = input.selectionStart ?? input.value.length;
      const v = input.value;
      const lead = at > 0 && !/\s/.test(v[at - 1]) ? " " : "";
      input.value = v.slice(0, at) + lead + "@" + v.slice(input.selectionEnd ?? at);
      const c = at + lead.length + 1;
      input.focus();
      input.setSelectionRange(c, c);
      opts.changed();
      void refresh();
    },
  };
}
