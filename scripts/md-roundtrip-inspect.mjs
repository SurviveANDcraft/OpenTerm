// Prints a unified-ish diff of one file's Milkdown round trip. Debug aid for
// scripts/md-roundtrip-test.mjs. Run: node scripts/md-roundtrip-inspect.mjs <file>
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
const windowKeys = new Set(Object.getOwnPropertyNames(dom.window));
for (let p = Object.getPrototypeOf(dom.window); p; p = Object.getPrototypeOf(p))
  for (const k of Object.getOwnPropertyNames(p)) windowKeys.add(k);
const FORCE = new Set(["Event", "CustomEvent", "EventTarget", "DOMException", "Blob", "File", "FormData"]);
for (const key of windowKeys) {
  if ((key in globalThis && !FORCE.has(key)) || key === "constructor") continue;
  try {
    const v = dom.window[key];
    Object.defineProperty(globalThis, key, {
      value: typeof v === "function" && !v.prototype ? v.bind(dom.window) : v,
      configurable: true,
      writable: true,
    });
  } catch {
    /* read-only */
  }
}

const { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } = await import("@milkdown/kit/core");
const { commonmark } = await import("@milkdown/kit/preset/commonmark");
const { gfm } = await import("@milkdown/kit/preset/gfm");

const src = readFileSync(process.argv[2], "utf8");
const root = document.createElement("div");
document.body.appendChild(root);
const editor = await Editor.make()
  .config((ctx) => {
    ctx.set(rootCtx, root);
    ctx.set(defaultValueCtx, src);
  })
  .use(commonmark)
  .use(gfm)
  .create();
const out = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));

const a = src.replace(/\r\n/g, "\n").split("\n");
const b = out.replace(/\r\n/g, "\n").split("\n");
let shown = 0;
for (let i = 0; i < Math.max(a.length, b.length) && shown < 25; i++) {
  if (a[i] !== b[i]) {
    console.log(`@${i + 1}\n- ${JSON.stringify(a[i])}\n+ ${JSON.stringify(b[i])}`);
    shown++;
  }
}
if (!shown) console.log("identical");
process.exit(0);
