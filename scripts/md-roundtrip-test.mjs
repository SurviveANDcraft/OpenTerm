// Round-trip safety harness for the Milkdown WYSIWYG Markdown editor.
// Parses real Markdown through Milkdown's remark pipeline and serializes it
// back, then asserts that everything load-bearing survived: code block bodies,
// link targets, table cell text, heading text and the full word stream.
// Run: node scripts/md-roundtrip-test.mjs [extra files...]

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.NodeList = dom.window.NodeList;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Range = dom.window.Range;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
// Mirror every remaining window global (dispatchEvent, MutationObserver, DOM
// classes…) onto globalThis so ProseMirror's DOM code runs unmodified.
const windowKeys = new Set(Object.getOwnPropertyNames(dom.window));
for (let proto = Object.getPrototypeOf(dom.window); proto; proto = Object.getPrototypeOf(proto))
  for (const k of Object.getOwnPropertyNames(proto)) windowKeys.add(k);

// Node predefines its own Event/EventTarget classes; jsdom rejects those as
// foreign, so these must be overridden rather than skipped.
const FORCE = new Set(["Event", "CustomEvent", "EventTarget", "DOMException", "Blob", "File", "FormData"]);

for (const key of windowKeys) {
  if ((key in globalThis && !FORCE.has(key)) || key === "constructor") continue;
  try {
    const value = dom.window[key];
    Object.defineProperty(globalThis, key, {
      value: typeof value === "function" && !value.prototype ? value.bind(dom.window) : value,
      configurable: true,
      writable: true,
    });
  } catch {
    /* read-only window props */
  }
}

const {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  serializerCtx,
  remarkStringifyOptionsCtx,
  editorViewOptionsCtx,
} = await import("@milkdown/kit/core");
const { commonmark } = await import("@milkdown/kit/preset/commonmark");
const { gfm } = await import("@milkdown/kit/preset/gfm");
// The app's own serializer settings and sanitizer, so this tests the real thing.
const { stringifyOptions, normalizeSerialized, fidelityProblem } = await import("../src/mdSerialize.ts");

async function roundTrip(markdown) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...stringifyOptions }));
    })
    .use(commonmark)
    .use(gfm)
    .create();
  const out = editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return ctx.get(serializerCtx)(view.state.doc);
  });
  await editor.destroy();
  root.remove();
  return normalizeSerialized(out);
}

// Serializer normalizations that change bytes but not meaning: backslash
// escapes before punctuation, and the three interchangeable link spellings
// (bare autolink literal, <angle> autolink, [x](x)). Everything else must match.
const semantic = (md) =>
  md
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, target) => (text === target ? target : m))
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!<>&~|])/g, "$1");

const codeBlocks = (md) => [...md.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1].trimEnd());
const linkTargets = (md) => [...md.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]).sort();
const tableCells = (md) =>
  md
    .split("\n")
    .filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|?\s*$/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .join("\u0001")
    );
const headings = (md) =>
  md
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, "").trim());
// Word stream, ignoring markdown punctuation and escaping differences.
const words = (md) =>
  md
    .replace(/[\\*_~`>#|-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function diffFirst(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return `  #${i}\n    orig: ${JSON.stringify(a[i])}\n    trip: ${JSON.stringify(b[i])}`;
  return "";
}

function check(name, orig, trip, failures) {
  // Code block bodies are compared on the raw text: nothing may touch them.
  const checks = {
    "code blocks": [codeBlocks, false],
    "link targets": [linkTargets, true],
    "table cells": [tableCells, true],
    headings: [headings, true],
    words: [words, true],
  };
  for (const [label, [fn, normalize]] of Object.entries(checks)) {
    const a = fn(normalize ? semantic(orig) : orig);
    const b = fn(normalize ? semantic(trip) : trip);
    if (a.length !== b.length || a.some((v, i) => v !== b[i]))
      failures.push(`${name}: ${label} differ (${a.length} vs ${b.length})\n${diffFirst(a, b)}`);
  }
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (/^(node_modules|\.git|venv|site-packages|dist|target)$/.test(e)) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (e.endsWith(".md") && st.size > 400 && st.size < 400_000) out.push(p);
  }
  return out;
}

const SYNTHETIC = `# Heading one

Intro with **bold**, *italic*, ~~struck~~, \`inline code\` and a [link](https://example.com/a?b=1&c=2).

## Table

| Layer | Real state  | Note |
| ----- | ----------- | ---- |
| Alpha | **done**    | ok   |
| Beta  | pending     | see [ref](./x.md) |

> A blockquote with **bold** text
> spanning two lines.

1. First item
2. Second item
   - nested bullet
   - another

\`\`\`js
const a = { x: 1, y: "two" };
if (a.x > 0) console.log(\`\${a.y}\`);
\`\`\`

---

Final paragraph with a trailing_underscore_word and 100% literal text.
`;

const roots = process.argv.slice(2);
const files = roots.length
  ? roots
  : walk(process.cwd())
      .filter((p) => {
        const t = readFileSync(p, "utf8");
        return /^\s*\|/m.test(t) || /^>/m.test(t) || /^```/m.test(t);
      })
      .slice(0, 60);

const failures = [];
const rejected = [];
let idempotent = 0;
let byteIdentical = 0;

const cases = [["<synthetic>", SYNTHETIC], ...files.map((f) => [f, readFileSync(f, "utf8")])];

for (const [name, orig] of cases) {
  let a, b;
  try {
    a = await roundTrip(orig);
    b = await roundTrip(a);
  } catch (e) {
    failures.push(`${name}: THREW ${e}`);
    continue;
  }
  if (!a.trim() && orig.trim()) {
    failures.push(`${name}: empty output for non-empty input`);
    continue;
  }
  if (a === b) idempotent++;
  else failures.push(`${name}: not idempotent (second pass differs)`);
  if (a.trim() === orig.trim()) byteIdentical++;
  // The gate the app itself applies at open time.
  const gated = fidelityProblem(orig, a);
  if (gated) rejected.push(`${name}: ${gated}`);
  else check(name, orig, a, failures);
}

// Structural check: the WYSIWYG surface must be a real rendered document
// (actual table/blockquote/heading elements), not styled source text.
{
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, SYNTHETIC);
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...stringifyOptions }));
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: { class: "milkdown-doc preview-doc", spellcheck: "false" },
      }));
    })
    .use(commonmark)
    .use(gfm)
    .create();

  const doc = root.querySelector(".milkdown-doc");
  const need = { h1: 1, h2: 1, table: 1, th: 3, td: 6, blockquote: 1, ul: 1, ol: 1, pre: 1, code: 2, strong: 2, em: 1, a: 2, hr: 1 };
  const got = {};
  for (const tag of Object.keys(need)) got[tag] = doc ? doc.querySelectorAll(tag).length : 0;
  const missing = Object.entries(need).filter(([tag, n]) => got[tag] < n);
  console.log(`rendered surface classes: ${doc ? doc.className : "MISSING"}`);
  console.log(`rendered elements: ${Object.entries(got).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (missing.length) {
    failures.push(`render structure: missing ${missing.map(([t, n]) => `${t}(>=${n})`).join(", ")}`);
  }
  await editor.destroy();
  root.remove();
}

console.log(`files tested: ${cases.length}`);
console.log(`byte-identical round trips: ${byteIdentical}/${cases.length}`);
console.log(`idempotent (pass2 === pass1): ${idempotent}/${cases.length}`);
console.log(`rejected by the app's fidelity gate (fall back to Raw): ${rejected.length}`);
console.log(`content failures among accepted files: ${failures.length}`);
for (const r of rejected) console.log("  gated: " + r);
for (const f of failures.slice(0, 12)) console.log("\n" + f);
process.exit(failures.length ? 1 : 0);
