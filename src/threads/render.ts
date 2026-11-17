/** HTML for the conversation: turns, prose, work timelines, step details.
 *  Pure functions of the runtime; the view patches the result in with
 *  morphInner so live updates never rebuild what didn't change. */
import type { Runtime } from "./runtime";
import type { Item, ThinkingItem, ToolItem, TurnItem, UserItem } from "./model";
import { ic } from "./icons";
import { renderMarkdown } from "./markdown";
import { baseName, isAgentTool, lookOf, relPath } from "./tools";
import { diffCounts, lineCount } from "./runtime";
import { convertFileSrc } from "@tauri-apps/api/core";

export const SHOW_IMAGE_TOOL = "mcp__openterm__show_image";

/** An image the agent put into the chat with show_image. */
function figureHtml(t: ToolItem, st: RenderState): string {
  const path = String(t.input?.path ?? "");
  const caption = String(t.input?.caption ?? "").trim();
  const name = caption || baseName(path) || "Image";
  const hidden = st.closed.has("fig:" + t.id);
  const ready = !!path && t.status !== "streaming";
  const src = ready ? convertFileSrc(path) : "";
  const body = !ready
    ? '<div class="tv-figure-wait"><span class="tv-shimmer">Preparing an image…</span></div>'
    : hidden
      ? ""
      : '<button class="tv-figure-img" data-act="fig-open" data-src="' + esc(src) + '" data-path="' + esc(path) + '" data-caption="' + esc(caption) + '" type="button" title="Click to enlarge"><img src="' + esc(src) + '" alt="' + esc(name) + '" draggable="false" /></button>' +
        '<span class="tv-figure-missing">' + ic("warning", 13) + "<span>Couldn't open " + esc(baseName(path)) + "</span></span>";
  return (
    '<figure class="tv-figure ' + (hidden ? "is-hidden" : "") + '" data-key="' + esc(t.id) + '" data-step="' + esc(t.id) + '">' +
    '<figcaption class="tv-figure-bar">' +
    '<span class="tv-figure-icon">' + ic("image", 13) + "</span>" +
    '<span class="tv-figure-name" title="' + esc(path) + '">' + esc(name) + "</span>" +
    (ready
      ? '<button class="tv-figure-btn" data-act="fig-toggle" data-id="' + esc(t.id) + '" type="button" title="' + (hidden ? "Show the image" : "Hide the image") + '">' + ic(hidden ? "eye" : "eyeSlash", 13) + "</button>" +
        '<button class="tv-figure-btn" data-act="fig-open" data-src="' + esc(src) + '" data-path="' + esc(path) + '" data-caption="' + esc(caption) + '" type="button" title="Enlarge">' + ic("arrowsOut", 13) + "</button>"
      : "") +
    "</figcaption>" +
    body +
    "</figure>"
  );
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const NL = "\n";
const ANSI =/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

function clip(text: string, max = 12000): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
}

/** UI state the renderer needs (what's expanded), owned by the view. */
export interface RenderState {
  open: Set<string>;
  closed: Set<string>;
  flash: string | null;
}

interface Segment {
  key: string;
  user: UserItem | null;
  items: Item[];
}

/** Splits the conversation into turns, each led by the prompt that started it. */
export function segments(rt: Runtime): Segment[] {
  const out: Segment[] = [];
  let cur: Segment = { key: "pre", user: null, items: [] };
  for (const id of rt.order) {
    const it = rt.items.get(id);
    if (!it) continue;
    if (it.kind === "user") {
      if (it.queued) continue;
      if (cur.user || cur.items.length) out.push(cur);
      cur = { key: it.id, user: it, items: [] };
    } else cur.items.push(it);
  }
  if (cur.user || cur.items.length) out.push(cur);
  return out;
}

// ------------------------------------------------------------ prompt

/** Colour family of an attached file, from its extension. */
export function fileKind(name: string): { ext: string; kind: string } {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const kind = /^(pdf)$/.test(ext)
    ? "pdf"
    : /^(docx?|odt|rtf|txt|md|markdown|pages|tex)$/.test(ext)
      ? "doc"
      : /^(xlsx?|xlsm|ods|csv|tsv|numbers|json|ya?ml|xml|toml|sql|db|sqlite)$/.test(ext)
        ? "data"
        : /^(zip|7z|rar|gz|tgz|tar|bz2|xz)$/.test(ext)
          ? "archive"
          : /^(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|tiff?|mp4|mov|mkv|webm|avi|mp3|wav|ogg|flac|m4a|psd|fig)$/.test(ext)
            ? "media"
            : /^(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|bat|lua|dart|vue|svelte|html|css|scss)$/.test(ext)
              ? "code"
              : "other";
  return { ext: ext.slice(0, 4) || "file", kind };
}

/** A sent message with its @file and @[thread] mentions as quiet pills. */
function mentionsHtml(text: string): string {
  return esc(text).replace(/(^|[\s(])@(\[[^\]\n]+\]|&quot;[^\n]*?&quot;|[^\s@]+)/g, (_m, pre, tag: string) => {
    if (tag.startsWith("[")) return `${pre}<span class="tv-mtag t">${tag.slice(1, -1)}</span>`;
    const path = tag.replace(/^&quot;|&quot;$/g, "");
    if (!/[./]/.test(path)) return `${pre}@${tag}`; // a plain @handle, not a path
    const name = path.replace(/\/$/, "").split("/").pop() ?? path;
    return `${pre}<span class="tv-mtag f" title="${path}">${name}${path.endsWith("/") ? "/" : ""}</span>`;
  });
}

function promptFilesHtml(files: string[]): string {
  return `<div class="tv-prompt-files">${files
    .map((p) => {
      const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
      const k = fileKind(name);
      return `<button class="tv-pfile" data-act="open-file" data-path="${esc(p)}" type="button" title="${esc(p)}"><span class="tv-fext k-${k.kind}">${esc(k.ext)}</span><span class="tv-pfile-name">${esc(name)}</span></button>`;
    })
    .join("")}</div>`;
}

function promptHtml(u: UserItem, st: RenderState): string {
  const long = u.text.length > 420 || u.text.split("\n").length > 6;
  const open = st.open.has(`p:${u.id}`);
  const imgs = u.images.length
    ? `<div class="tv-prompt-imgs">${u.images.map((src) => `<img src="${esc(src)}" alt="" />`).join("")}</div>`
    : "";
  return `
    <div class="tv-prompt ${long ? "is-long" : ""} ${open ? "is-open" : ""}" data-key="p">
      <div class="tv-prompt-card">
        ${imgs}
        ${u.files?.length ? promptFilesHtml(u.files) : ""}
        ${u.text ? `<div class="tv-prompt-text">${mentionsHtml(u.text)}</div>` : ""}
        ${long ? `<button class="tv-prompt-more" data-act="prompt" data-id="${esc(u.id)}" type="button">${open ? "Show less" : "Show all"}</button>` : ""}
      </div>
      <span class="tv-prompt-time">${fmtClock(u.at)}</span>
    </div>`;
}

// ------------------------------------------------------------ steps

function statusNode(t: ToolItem): string {
  switch (t.status) {
    case "streaming":
    case "running":
      return `<span class="tv-node is-run"></span>`;
    case "waiting":
      return `<span class="tv-node is-wait">${ic("hand", 10)}</span>`;
    case "error":
      return `<span class="tv-node is-err">${ic("x", 10)}</span>`;
    case "denied":
      return `<span class="tv-node is-denied">${ic("x", 10)}</span>`;
    case "stopped":
      return `<span class="tv-node is-stop"></span>`;
    default:
      return `<span class="tv-node is-done"></span>`;
  }
}

function counts(added: number, removed: number): string {
  return `${added ? `<span class="tv-add">+${added}</span>` : ""}${removed ? `<span class="tv-del">−${removed}</span>` : ""}`;
}

/** Line counts of the trimmed change between two strings (what the diff shows). */
export function naiveCounts(oldS: string, newS: string): { added: number; removed: number } {
  const o = oldS ? oldS.split(NL) : [];
  const n = newS ? newS.split(NL) : [];
  let s = 0;
  while (s < o.length && s < n.length && o[s] === n[s]) s++;
  let e = 0;
  while (e < o.length - s && e < n.length - s && o[o.length - 1 - e] === n[n.length - 1 - e]) e++;
  return { added: n.length - s - e, removed: o.length - s - e };
}

function stepMeta(t: ToolItem): string {
  const i = t.input ?? {};
  const bits: string[] = [];
  if (t.name === "Edit" || t.name === "MultiEdit") {
    let { added, removed } = diffCounts(t.result?.structuredPatch);
    if (!added && !removed) {
      const edits = t.name === "MultiEdit" ? i.edits ?? [] : [i];
      for (const e of edits) {
        const c = naiveCounts(String(e.old_string ?? ""), String(e.new_string ?? ""));
        removed += c.removed;
        added += c.added;
      }
    }
    bits.push(counts(added, removed));
  } else if (t.name === "Write") {
    bits.push(`<span class="tv-add">+${lineCount(i.content)}</span>`);
  } else if (t.name === "Patch") {
    let a = 0;
    let r = 0;
    for (const c of i.changes ?? []) {
      const d = diffCounts(c.diff);
      a += d.added;
      r += d.removed;
    }
    bits.push(counts(a, r));
  } else if ((t.name === "Bash" || t.name === "PowerShell") && t.result?.exitCode != null && t.result.exitCode !== 0) {
    bits.push(`<span class="tv-del">exit ${esc(t.result.exitCode)}</span>`);
  } else if (isAgentTool(t.name)) {
    const n = Math.max(t.children.filter((id) => !id.includes(":")).length, Number(t.result?.toolUses ?? 0));
    if ((t.status === "running" || t.status === "streaming") && t.result?.progress)
      bits.push(`<span class="tv-agent-now">${esc(t.result.progress)}</span>`);
    if (n) bits.push(`<span>${n} step${n === 1 ? "" : "s"}</span>`);
  }
  if (t.status === "waiting") bits.push(`<span class="tv-wait-tag">Needs approval</span>`);
  else if (t.status === "denied") bits.push(`<span class="tv-muted-tag">Declined</span>`);
  else if (t.status === "stopped") bits.push(`<span class="tv-muted-tag">Stopped</span>`);
  if (t.endAt && t.endAt - t.at >= 2000 && t.status !== "waiting") bits.push(`<span>${fmtDuration(t.endAt - t.at)}</span>`);
  return bits.join("");
}

function diffHtml(lines: { kind: " " | "+" | "-" | "@"; text: string; a?: number; b?: number }[]): string {
  const max = 600;
  const rows = lines.slice(0, max).map((l) => {
    const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : l.kind === "@" ? "hunk" : "ctx";
    return `<div class="tv-dl ${cls}"><span class="tv-dn">${l.a ?? ""}</span><span class="tv-dn">${l.b ?? ""}</span><span class="tv-dt">${esc(l.text) || " "}</span></div>`;
  });
  if (lines.length > max) rows.push(`<div class="tv-dl hunk"><span class="tv-dn"></span><span class="tv-dn"></span><span class="tv-dt">… ${lines.length - max} more lines</span></div>`);
  return `<div class="tv-diff">${rows.join("")}</div>`;
}

function patchLines(hunks: any[]): ReturnType<typeof parseUnified> {
  const out: ReturnType<typeof parseUnified> = [];
  for (const h of hunks) {
    let a = h.oldStart ?? 0;
    let b = h.newStart ?? 0;
    if (out.length) out.push({ kind: "@", text: "⋯" });
    for (const raw of h.lines ?? []) {
      const line = String(raw);
      const k = line[0];
      if (k === "+") out.push({ kind: "+", text: line.slice(1), b: b++ });
      else if (k === "-") out.push({ kind: "-", text: line.slice(1), a: a++ });
      else if (k === "\\") continue;
      else out.push({ kind: " ", text: line.slice(1), a: a++, b: b++ });
    }
  }
  return out;
}

function parseUnified(diff: string): { kind: " " | "+" | "-" | "@"; text: string; a?: number; b?: number }[] {
  const out: { kind: " " | "+" | "-" | "@"; text: string; a?: number; b?: number }[] = [];
  let a = 0;
  let b = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      if (out.length) out.push({ kind: "@", text: "⋯" });
      continue;
    }
    if (line.startsWith("+")) out.push({ kind: "+", text: line.slice(1), b: b++ });
    else if (line.startsWith("-")) out.push({ kind: "-", text: line.slice(1), a: a++ });
    else if (line.startsWith("\\")) continue;
    else if (line || out.length) out.push({ kind: " ", text: line.slice(1), a: a++, b: b++ });
  }
  return out;
}

function naiveDiff(oldS: string, newS: string): ReturnType<typeof parseUnified> {
  const o = oldS ? oldS.split("\n") : [];
  const n = newS ? newS.split("\n") : [];
  // Trim the shared head and tail so only the real change shows.
  let s = 0;
  while (s < o.length && s < n.length && o[s] === n[s]) s++;
  let e = 0;
  while (e < o.length - s && e < n.length - s && o[o.length - 1 - e] === n[n.length - 1 - e]) e++;
  const out: ReturnType<typeof parseUnified> = [];
  const ctx = (line: string) => out.push({ kind: " ", text: line });
  o.slice(Math.max(0, s - 2), s).forEach(ctx);
  o.slice(s, o.length - e).forEach((l) => out.push({ kind: "-", text: l }));
  n.slice(s, n.length - e).forEach((l) => out.push({ kind: "+", text: l }));
  o.slice(o.length - e, Math.min(o.length, o.length - e + 2)).forEach(ctx);
  return out;
}

export function editDiffHtml(t: Pick<ToolItem, "name" | "input" | "result">): string {
  const i = t.input ?? {};
  if (t.name === "Write") {
    const { text, cut } = clip(String(i.content ?? ""), 20000);
    const lines = text.split("\n").map((l, n) => ({ kind: "+" as const, text: l, b: n + 1 }));
    return diffHtml(lines) + (cut ? `<div class="tv-clip">Showing the start of the file</div>` : "");
  }
  if (t.name === "Patch") {
    return (i.changes ?? [])
      .map((c: any) => `<div class="tv-file-head">${ic("fileText", 12)}<span>${esc(relPath(c.path))}</span></div>${diffHtml(parseUnified(String(c.diff ?? "")))}`)
      .join("");
  }
  const hunks = t.result?.structuredPatch;
  if (Array.isArray(hunks) && hunks.length) return diffHtml(patchLines(hunks));
  if (t.name === "MultiEdit")
    return (i.edits ?? []).map((e: any) => diffHtml(naiveDiff(String(e.old_string ?? ""), String(e.new_string ?? "")))).join("");
  return diffHtml(naiveDiff(String(i.old_string ?? ""), String(i.new_string ?? "")));
}

function outputHtml(t: ToolItem): string {
  const i = t.input ?? {};
  const parts: string[] = [];
  if (t.name === "Bash" || t.name === "PowerShell" || t.name === "Monitor") {
    parts.push(`<div class="tv-cmd"><span class="tv-cmd-sigil">${t.name === "PowerShell" ? "PS" : "$"}</span><code>${esc(i.command ?? "")}</code><button class="tv-copy" data-copy-text="${esc(i.command ?? "")}" type="button" title="Copy command">${ic("copy", 12)}</button></div>`);
  }
  const raw = (t.output ?? (t.result?.stdout as string) ?? "").replace(ANSI, "");
  if (raw.trim()) {
    const { text, cut } = clip(raw);
    parts.push(`<pre class="tv-out ${t.status === "error" ? "is-err" : ""}">${esc(text)}</pre>${cut ? `<div class="tv-clip">Output trimmed</div>` : ""}`);
  } else if (t.status === "running") parts.push(`<div class="tv-out-wait">Waiting for output…</div>`);
  else if (t.status === "done") parts.push(`<div class="tv-out-wait">No output</div>`);
  return parts.join("");
}

function jsonHtml(t: ToolItem): string {
  const input = JSON.stringify(t.input ?? {}, null, 2);
  const out = (t.output ?? "").trim();
  return `<div class="tv-kv-label">Input</div><pre class="tv-out">${esc(clip(input, 6000).text)}</pre>${
    out ? `<div class="tv-kv-label">Result</div><pre class="tv-out ${t.status === "error" ? "is-err" : ""}">${esc(clip(out, 8000).text)}</pre>` : ""
  }`;
}

/** A sub-agent's final report without the harness framing around it. */
export function agentReport(t: ToolItem): string {
  const blocks = t.result?.content;
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter((b: any) => b?.type === "text" && !/^\s*<[\w-]+>[\s\S]*<\/[\w-]+>\s*$/.test(b.text ?? ""))
      .map((b: any) => String(b.text))
      .join(NL + NL)
      .trim();
    if (text) return text;
  }
  let out = String(t.output ?? "");
  out = out.replace(/^[\s\S]*?The report follows:\s*\n?/, "");
  out = out.replace(/\n?agentId:[\s\S]*$/, "").replace(/<usage>[\s\S]*?<\/usage>/g, "");
  out = out.replace(/<[\w-]+>[\s\S]*?<\/[\w-]+>/g, "");
  // The harness indents every report line by two spaces.
  const lines = out.split(NL);
  if (lines.filter((l) => l.trim()).every((l) => l.startsWith("  "))) out = lines.map((l) => l.slice(2)).join(NL);
  return out.trim();
}

function agentHtml(rt: Runtime, t: ToolItem, st: RenderState): string {
  const i = t.input ?? {};
  const children = t.children.map((id) => rt.items.get(id)).filter((x): x is Item => !!x);
  const steps = children.filter((c) => c.kind === "tool" || c.kind === "thinking");
  const last = [...children].reverse().find((c) => c.kind === "text");
  const report = t.status === "done" ? agentReport(t) || (last?.kind === "text" ? last.text : "") : last?.kind === "text" ? last.text : "";
  return `
    <div class="tv-agent">
      <div class="tv-agent-brief">
        ${i.subagent_type ? `<span class="tv-agent-type">${esc(i.subagent_type)}</span>` : ""}
        <div class="tv-agent-prompt">${esc(clip(String(i.prompt ?? ""), 1200).text)}</div>
      </div>
      ${steps.length ? `<div class="tv-steps nested">${steps.map((c) => (c.kind === "tool" ? stepHtml(rt, c, st, true) : quietThought(c as ThinkingItem) ? "" : thinkHtml(c as ThinkingItem, st))).join("")}</div>` : ""}
      ${report ? `<div class="tv-agent-report"><div class="tv-kv-label">Report</div><div class="tv-prose">${renderMarkdown(clip(report, 20000).text)}</div></div>` : ""}
    </div>`;
}

export function stepHtml(rt: Runtime, t: ToolItem, st: RenderState, nested = false): string {
  const look = lookOf(t);
  const agent = isAgentTool(t.name);
  const running = t.status === "running" || t.status === "streaming" || t.status === "waiting";
  const hasDetail = look.detail !== "none" || (t.status === "error" && !!t.output);
  // Sub-agents stay open while they work so you can watch them; everything
  // else opens on demand.
  const open = hasDetail && (st.open.has(t.id) || (agent && running && !st.closed.has(t.id)) || st.flash === t.id);
  let detail = "";
  if (open) {
    if (look.detail === "diff" || look.detail === "write") detail = editDiffHtml(t);
    else if (look.detail === "agent") detail = agentHtml(rt, t, st);
    else if (look.detail === "json") detail = jsonHtml(t);
    else detail = outputHtml(t);
  }
  const target = look.target
    ? look.mono
      ? `<code class="tv-target" title="${esc(look.target)}">${esc(look.target)}</code>`
      : `<span class="tv-target plain">${esc(look.target)}</span>`
    : "";
  const fileAttr =
    (t.name === "Read" || t.name === "Edit" || t.name === "Write" || t.name === "MultiEdit") && t.input?.file_path
      ? ` data-path="${esc(t.input.file_path)}"`
      : "";
  return `
    <div class="tv-step st-${t.status} ${agent ? "is-agent" : ""} ${open ? "is-open" : ""} ${st.flash === t.id ? "is-flash" : ""}" data-key="${esc(t.id)}" data-step="${esc(t.id)}">
      <div class="tv-step-row" ${hasDetail ? `data-act="step" data-id="${esc(t.id)}" role="button" tabindex="0"` : ""}>
        ${statusNode(t)}
        <span class="tv-step-icon">${ic(look.icon, 13)}</span>
        <span class="tv-verb">${esc(running ? look.active : look.verb)}</span>
        ${target}
        <span class="tv-step-meta">${stepMeta(t)}</span>
        ${fileAttr ? `<span class="tv-step-open" data-act="open-file"${fileAttr} title="Open ${esc(baseName(String(t.input.file_path)))}">${ic("external", 12)}</span>` : ""}
        ${hasDetail ? `<span class="tv-chev">${ic("caretRight", 9)}</span>` : ""}
      </div>
      ${open ? `<div class="tv-step-detail${nested ? " nested" : ""}">${detail}</div>` : ""}
    </div>`;
}

/** Thinking with nothing to show and no real duration is noise. */
export function quietThought(t: ThinkingItem): boolean {
  const done = t.done || !!t.endAt;
  return done && !t.text.trim() && (!t.endAt || t.endAt - t.at < 1500);
}

function thinkHtml(t: ThinkingItem, st: RenderState): string {
  const live = !t.done && !t.endAt;
  const secs = t.endAt ? fmtDuration(t.endAt - t.at) : "";
  const text = t.text.trim();
  const open = !!text && st.open.has(t.id);
  return `
    <div class="tv-step tv-think ${live ? "is-live" : ""} ${open ? "is-open" : ""}" data-key="${esc(t.id)}">
      <div class="tv-step-row" ${text ? `data-act="step" data-id="${esc(t.id)}" role="button" tabindex="0"` : ""}>
        <span class="tv-node ${live ? "is-think" : "is-done"}"></span>
        <span class="tv-step-icon">${ic("brain", 13)}</span>
        <span class="tv-verb">${live ? `<span class="tv-shimmer">Thinking</span>` : secs ? `Thought for ${secs}` : "Thought"}</span>
        ${text ? `<span class="tv-chev">${ic("caretRight", 9)}</span>` : ""}
      </div>
      ${open ? `<div class="tv-step-detail"><div class="tv-thought">${renderMarkdown(text)}</div></div>` : ""}
    </div>`;
}

/** "Read 4 files · Edited 2 · Ran 3 commands", for a folded work group. */
function groupSummary(items: Item[]): string {
  const c = { read: 0, edit: 0, run: 0, search: 0, agent: 0, web: 0, other: 0, think: 0 };
  for (const it of items) {
    if (it.kind === "thinking") {
      c.think++;
      continue;
    }
    if (it.kind !== "tool") continue;
    const n = it.name;
    if (n === "Read") c.read++;
    else if (n === "Edit" || n === "MultiEdit" || n === "Write" || n === "Patch" || n === "NotebookEdit") c.edit++;
    else if (n === "Bash" || n === "PowerShell" || n === "Monitor") c.run++;
    else if (n === "Grep" || n === "Glob" || n === "LS") c.search++;
    else if (isAgentTool(n)) c.agent++;
    else if (n === "WebFetch" || n === "WebSearch") c.web++;
    else if (n !== "TodoWrite") c.other++;
  }
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (c.read) parts.push(`Read ${plural(c.read, "file", "files")}`);
  if (c.search) parts.push(`${plural(c.search, "search", "searches")}`);
  if (c.edit) parts.push(`Edited ${plural(c.edit, "file", "files")}`);
  if (c.run) parts.push(`Ran ${plural(c.run, "command", "commands")}`);
  if (c.agent) parts.push(`${plural(c.agent, "sub-agent", "sub-agents")}`);
  if (c.web) parts.push(`${plural(c.web, "web lookup", "web lookups")}`);
  if (c.other) parts.push(`${plural(c.other, "other step", "other steps")}`);
  if (!parts.length && c.think) parts.push("Thought it through");
  return parts.join(" · ");
}

function groupIcons(items: Item[]): string {
  const seen: string[] = [];
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const icon = lookOf(it).icon;
    if (!seen.includes(icon)) seen.push(icon);
    if (seen.length === 4) break;
  }
  return seen.map((n) => `<span>${ic(n as any, 11)}</span>`).join("");
}

function workHtml(rt: Runtime, items: Item[], live: boolean, st: RenderState): string {
  const steps = items.filter((it) => it.kind === "tool" || (it.kind === "thinking" && !quietThought(it))) as (ToolItem | ThinkingItem)[];
  if (!steps.length) return "";
  const key = `w:${items[0].id}`;
  const hasLive = steps.some((it) => (it.kind === "tool" ? ["running", "streaming", "waiting"].includes(it.status) : !it.done && !it.endAt));
  const attention = steps.some((it) => it.kind === "tool" && (it.status === "waiting" || it.status === "error"));
  const foldable = steps.length > 3;
  const folded = foldable && !live && !hasLive && !attention && !st.open.has(key) && !steps.some((s) => s.id === st.flash);
  const first = steps[0]?.at ?? 0;
  const lastEnd = Math.max(...steps.map((s) => (s.kind === "tool" ? s.endAt ?? s.at : s.endAt ?? s.at)));
  const span = lastEnd - first;
  const head = foldable
    ? `<button class="tv-work-head" data-act="group" data-key="${esc(key)}" type="button">
        <span class="tv-work-icons">${groupIcons(steps)}</span>
        <span class="tv-work-sum">${esc(groupSummary(steps))}</span>
        ${span > 1500 ? `<span class="tv-work-time">${fmtDuration(span)}</span>` : ""}
        <span class="tv-chev">${ic("caretRight", 9)}</span>
      </button>`
    : "";
  const body = folded
    ? ""
    : `<div class="tv-steps">${steps.map((it) => (it.kind === "tool" ? stepHtml(rt, it, st) : thinkHtml(it as ThinkingItem, st))).join("")}</div>`;
  return `<div class="tv-work ${folded ? "is-folded" : "is-open"} ${foldable ? "foldable" : ""}" data-key="${esc(key)}">${head}${body}</div>`;
}

function turnFoot(t: TurnItem): string {
  if (t.outcome === "error")
    return `<div class="tv-foot is-err" data-key="${esc(t.id)}">
      <span class="tv-foot-icon">${ic("warning", 13)}</span>
      <span class="tv-foot-err">${esc(t.error ?? "Something went wrong")}</span>
      <button class="tv-foot-btn" data-act="retry" type="button">${ic("refresh", 12)}Retry</button>
    </div>`;
  const bits = [
    t.outcome === "interrupted" ? `Stopped after ${fmtDuration(t.ms)}` : fmtDuration(t.ms),
    t.tools ? `${t.tools} step${t.tools === 1 ? "" : "s"}` : "",
    t.tokensOut ? `${fmtTokens(t.tokensIn)} in · ${fmtTokens(t.tokensOut)} out` : "",
  ].filter(Boolean);
  return `<div class="tv-foot ${t.outcome === "interrupted" ? "is-stop" : ""}" data-key="${esc(t.id)}">
    <span class="tv-foot-icon">${t.outcome === "interrupted" ? ic("stop", 11) : ic("check", 11)}</span>
    <span>${bits.map(esc).join(`<i class="tv-dot"></i>`)}</span>
    <button class="tv-foot-copy" data-act="copy-turn" data-id="${esc(t.id)}" type="button" title="Copy the answer">${ic("copy", 12)}</button>
  </div>`;
}

/** One turn: the prompt, then prose and work groups in order, then its footer. */
export function turnHtml(rt: Runtime, seg: Segment, isLast: boolean, st: RenderState): string {
  const out: string[] = [];
  if (seg.user) out.push(promptHtml(seg.user, st));
  const body: string[] = [];
  let work: Item[] = [];
  const live = isLast && rt.busy;
  const flush = (atEnd: boolean) => {
    if (!work.length) return;
    const html = workHtml(rt, work, live && atEnd, st);
    if (html) body.push(html);
    work = [];
  };
  for (const it of seg.items) {
    if (it.kind === "tool" && it.name === SHOW_IMAGE_TOOL) {
      flush(false);
      body.push(figureHtml(it, st));
      continue;
    }
    if (it.kind === "tool" || it.kind === "thinking") {
      if (it.kind === "tool" && it.name === "TodoWrite" && work.length === 0 && seg.items.length > 1) {
        // Plan updates live in the plan strip; keep them as a quiet marker.
      }
      work.push(it);
      continue;
    }
    flush(false);
    if (it.kind === "text") {
      if (!it.text.trim()) continue;
      body.push(
        `<div class="tv-prose ${it.done ? "" : "is-streaming"}" data-key="${esc(it.id)}">${renderMarkdown(it.text)}${it.done ? "" : `<span class="tv-caret"></span>`}</div>`
      );
    } else if (it.kind === "notice") {
      body.push(`<div class="tv-notice tone-${it.tone}" data-key="${esc(it.id)}">${ic(it.tone === "error" ? "warning" : "sparkle", 12)}<span>${esc(it.text)}</span></div>`);
    } else if (it.kind === "turn") {
      body.push(turnFoot(it));
    }
  }
  flush(true);
  if (live) {
    body.push(`<div class="tv-live" data-key="live"><span class="tv-live-orb"></span><span class="tv-live-text tv-shimmer">${esc(rt.waiting ? "Waiting for you" : rt.meta.activity || "Working")}</span><span class="tv-live-time" data-elapsed="${rt.turnStart}">${fmtDuration(Date.now() - rt.turnStart)}</span><span class="tv-live-hint"><kbd>Esc</kbd> to stop</span></div>`);
  }
  out.push(`<div class="tv-answer" data-key="a">${body.join("")}</div>`);
  return out.join("");
}
