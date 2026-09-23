// Real xterm buffers, with controllable layout and frame timing (no native PTY).
// Run: node --experimental-strip-types --test scripts/terminal-scroll-test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { fitTerminalToViewport, syncTerminalViewport } from "../src/terminalViewport.ts";

const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");
// Exercise PaneTerm's actual methods without starting unrelated UI services.
const source = ts.createSourceFile("terminals.ts", readFileSync(new URL("../src/terminals.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === "PaneTerm");
const compiled = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function fixture(t) {
  const term = new Terminal({ cols: 80, rows: 20, scrollback: 1000, allowProposedApi: true, windowsPty: { backend: "conpty" } });
  t.after(() => term.dispose());
  await new Promise(resolve => term.write(Array.from({ length: 250 }, (_, i) => `chat line ${i}\r\n`).join(""), resolve));
  const viewport = { clientHeight: 400, scrollTop: term.buffer.active.viewportY * 20 };
  // Deliberately stale: a paused renderer still has its OLD canvas height.
  const screen = { offsetHeight: 400 };
  term._core.element = { querySelector: selector => selector === ".xterm-viewport" ? viewport : screen };
  term._core._renderService = { dimensions: { css: { cell: { height: 20 } } }, refreshRows() {} };
  // Model the xterm 5.5 cached-scrollTop no-op, independently of DOM scrollTop.
  term._core.viewport = { syncScrollArea() {}, scrollLines: amount => term._core._bufferService.scrollLines(amount) };
  const frames = new Map();
  const timers = new Map();
  let serial = 0;
  const schedule = (queue, fn) => { const id = ++serial; queue.set(id, fn); return id; };
  const window = {
    requestAnimationFrame: fn => schedule(frames, fn), cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => schedule(timers, fn), clearTimeout: id => timers.delete(id),
  };
  const ptySizes = [];
  const context = { exports: {}, window, requestAnimationFrame: window.requestAnimationFrame,
    fitTerminalToViewport, syncTerminalViewport, resizePty: async (...args) => { ptySizes.push(args); } };
  vm.runInNewContext(compiled, context);
  const pane = Object.create(context.exports.PaneTerm.prototype);
  const state = { folded: false, folding: false, width: 800, height: 400 };
  const fit = { proposeDimensions: () => ({ cols: 80, rows: Math.floor(viewport.clientHeight / 20) + 1 }) };
  Object.assign(pane, { id: "test", term, fit, disposed: false, hidden: false, spawned: true,
    fitRaf: null, fitTimer: null, ptyResizeTimer: null, lastPtyResizeAt: 0,
    lastSentCols: 80, lastSentRows: 20,
    termHost: { getBoundingClientRect: () => ({ width: state.width, height: state.height }) },
    el: { classList: { contains: () => state.folded }, closest: () => state.folding ? {} : null },
  });
  term.onResize(({ cols, rows }) => pane.scheduleResizePty(cols, rows));
  const flush = queue => { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(fn => fn()); };
  return { term, pane, viewport, fit, state, ptySizes, flush: () => { flush(frames); flush(timers); } };
}

test("focus repairs a pending zero scrollbar without changing the chat position", async t => {
  const { term, pane, viewport, ptySizes } = await fixture(t);
  for (const position of [term.buffer.active.baseY, 75, 0]) {
    term.scrollToLine(position);
    viewport.scrollTop = 0;
    let focused = false;
    term._core.textarea = { focus() { focused = true; assert.equal(viewport.scrollTop, position * 20); } };
    pane.focus();
    // A pending browser scroll now resolves to the original row, not row zero.
    term.scrollToLine(Math.round(viewport.scrollTop / 20));
    assert.equal(term.buffer.active.viewportY, position);
    assert.ok(focused);
  }
  assert.equal(ptySizes.length, 0);
});

test("paused renderer cannot amplify the row count after expansion", async t => {
  const { term, pane, viewport, state, ptySizes } = await fixture(t);
  viewport.clientHeight = state.height = 800;
  pane.hidden = true;
  pane.fitNow();
  assert.equal(term.rows, 40); // Old clamp inferred 10px cells and requested 80+ rows.
  assert.equal(term.buffer.active.viewportY, term.buffer.active.baseY);
  assert.equal(viewport.scrollTop, term.buffer.active.viewportY * 20);
  assert.deepEqual(ptySizes, [["test", 80, 40]]);
});

test("folded and animating panes retain their usable terminal geometry", async t => {
  const { pane, term, state, viewport, ptySizes } = await fixture(t);
  for (const mode of ["folded", "folding"]) {
    state[mode] = true;
    viewport.clientHeight = state.height = 40;
    pane.fitNow();
    assert.equal(term.rows, 20);
    assert.equal(ptySizes.length, 0);
    state[mode] = false;
  }
});

test("a zero-sized host is never sent to the running PTY", async t => {
  const { pane, term, state, ptySizes } = await fixture(t);
  state.width = state.height = 0;
  pane.fitNow();
  assert.equal(term.rows, 20);
  assert.equal(ptySizes.length, 0);
});

test("restoring scrollback preserves the reading position through delayed fits", async t => {
  const { pane, term, viewport, state, ptySizes, flush } = await fixture(t);
  term.scrollToLine(75);
  pane.hidden = true;
  viewport.clientHeight = state.height = 800;
  pane.fitNow();
  flush();
  assert.equal(term.buffer.active.viewportY, 75);
  assert.equal(viewport.scrollTop, 1500);
  assert.deepEqual(ptySizes, [["test", 80, 40]]); // No artificial rows-1 repaint.
});

test("user scrolling after expansion wins over pending recovery callbacks", async t => {
  const { pane, term, viewport, state, flush } = await fixture(t);
  pane.hidden = true;
  viewport.clientHeight = state.height = 800;
  pane.fitNow();
  term.scrollToLine(60);
  flush();
  assert.equal(term.buffer.active.viewportY, 60);
  assert.equal(viewport.scrollTop, 1200);
});

test("repeated expand/collapse fits stay bounded and keep the live end visible", async t => {
  const { pane, term, viewport, state, flush } = await fixture(t);
  for (let i = 0; i < 12; i++) {
    state.folding = true;
    viewport.clientHeight = state.height = 40;
    pane.fitNow();
    state.folding = false;
    viewport.clientHeight = state.height = i % 2 ? 400 : 800;
    pane.fitNow();
    flush();
    assert.equal(term.rows, viewport.clientHeight / 20);
    assert.equal(term.buffer.active.viewportY, term.buffer.active.baseY);
  }
});

test("fractional cell heights use the viewport and unchanged fits do not resize", async t => {
  const { term, viewport, fit } = await fixture(t);
  term._core._renderService.dimensions.css.cell.height = 19.2;
  viewport.clientHeight = 401;
  const sizes = [];
  term.onResize(size => sizes.push(size));
  fitTerminalToViewport(term, fit);
  fitTerminalToViewport(term, fit);
  assert.equal(term.rows, 20);
  assert.equal(sizes.length, 0);
});
