import { invoke } from "@tauri-apps/api/core";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { EditorState, Extension, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
  LanguageSupport,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { createFilePreview, previewKindFor, isMarkdown, type PreviewKind } from "./preview";
import { createMarkdownWysiwyg, type ToolbarCommand } from "./mdWysiwyg";
import { saveProblem } from "./mdSerialize";

import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";

import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { go as goMode } from "@codemirror/legacy-modes/mode/go";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { perl } from "@codemirror/legacy-modes/mode/perl";

/** The editor is themed entirely through the app's CSS custom properties, so it
 *  follows whatever theme is active (light themes included) without rebuilding
 *  the CodeMirror theme. Syntax hues come from the `--syn-*` vars, which light
 *  themes override with darker, higher-contrast variants. */
const palette = {
  bg: "var(--bg-app)",
  gutterBg: "var(--bg-app)",
  raised: "var(--bg-raised)",
  border: "var(--border-soft)",
  text: "var(--text)",
  dim: "var(--text-dim)",
  faint: "var(--text-faint)",
  accent: "var(--accent)",
  accentDim: "var(--accent-dim)",
  selection: "color-mix(in srgb, var(--info) 25%, transparent)",
  activeLine: "color-mix(in srgb, var(--text) 3.5%, transparent)",
  searchMatch: "color-mix(in srgb, var(--accent) 20%, transparent)",
};

const appTheme = EditorView.theme(
  {
    "&": {
      color: palette.text,
      backgroundColor: palette.bg,
      height: "100%",
      // Driven by Settings → Editor text size (and Ctrl+±); the literal is the
      // fallback for the split second before applySettingsLive() first runs.
      fontSize: "var(--editor-font-size, 13px)",
    },
    ".cm-content": {
      fontFamily: "var(--mono)",
      caretColor: palette.accent,
      padding: "14px 0",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "var(--mono)",
    },
    "&.cm-focused .cm-cursor": {
      borderLeftColor: palette.accent,
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: palette.selection + " !important",
    },
    ".cm-activeLine": {
      backgroundColor: palette.activeLine,
    },
    ".cm-activeLineGutter": {
      backgroundColor: palette.activeLine,
      color: palette.text,
    },
    ".cm-gutters": {
      backgroundColor: palette.gutterBg,
      color: palette.faint,
      border: "none",
      borderRight: `1px solid ${palette.border}`,
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 12px 0 14px",
    },
    ".cm-foldGutter .cm-gutterElement": {
      color: palette.faint,
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: palette.accentDim,
      outline: `1px solid ${palette.accent}`,
    },
    ".cm-searchMatch": {
      backgroundColor: palette.searchMatch,
      outline: `1px solid ${palette.accent}`,
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: palette.accentDim,
    },
    ".cm-tooltip": {
      backgroundColor: palette.raised,
      border: `1px solid ${palette.border}`,
      color: palette.text,
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: palette.accentDim,
      color: palette.text,
    },
    ".cm-panels": {
      backgroundColor: palette.raised,
      color: palette.text,
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: `1px solid ${palette.border}`,
    },
  },
  { dark: true }
);

/** Syntax colors matched to the app's warm-accent dark palette (in place of
 *  a stock theme like One Dark, whose background never matched --bg-app). */
const appHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: palette.text },
  { tag: [t.propertyName], color: "var(--syn-func)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--syn-func)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--syn-const)" },
  { tag: [t.definition(t.name), t.separator], color: palette.text },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "var(--syn-const)" },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "var(--syn-op)" },
  { tag: [t.meta, t.comment], color: palette.faint, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--syn-link)", textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "var(--syn-const)" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--syn-atom)" },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "var(--syn-string)" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
]);

function legacy(parser: any): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

/** Maps a filename's extension to a CodeMirror language extension. */
function languageFor(name: string): Extension[] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "py":
    case "pyw":
      return [python()];
    case "json":
    case "jsonc":
      return [json()];
    case "css":
      return [css()];
    case "scss":
    case "less":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "xml":
    case "svg":
    case "vue":
      return [xml()];
    case "md":
    case "markdown":
      // markdownLanguage is the GFM dialect (strikethrough, tables, tasks),
      // which the in-place rendered view styles.
      return [markdown({ base: markdownLanguage })];
    case "c":
    case "h":
      return [cpp()];
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
      return [cpp()];
    case "java":
      return [java()];
    case "kt":
    case "kts":
      return [legacy(kotlin)];
    case "cs":
      return [legacy(csharp)];
    case "php":
      return [php()];
    case "rs":
      return [rust()];
    case "sql":
      return [sql()];
    case "yml":
    case "yaml":
      return [yaml()];
    case "sh":
    case "bash":
    case "zsh":
      return [legacy(shell)];
    case "ps1":
    case "psm1":
      return [legacy(powerShell)];
    case "go":
      return [legacy(goMode)];
    case "rb":
      return [legacy(ruby)];
    case "lua":
      return [legacy(lua)];
    case "dockerfile":
      return [legacy(dockerFile)];
    case "swift":
      return [legacy(swift)];
    case "toml":
      return [legacy(toml)];
    case "pl":
    case "pm":
      return [legacy(perl)];
    default:
      return name.toLowerCase() === "dockerfile" ? [legacy(dockerFile)] : [];
  }
}

export interface FileEditorHandlers {
  /** Fired whenever the dirty (unsaved changes) state flips. */
  onDirtyChange(dirty: boolean): void;
}

/** IDE-style code editor for the main area, replacing the terminal panes while
 *  a file is open. Supports editing with syntax highlighting and saving to disk. */
export function createFileEditor(handlers: FileEditorHandlers) {
  const el = document.createElement("div");
  el.className = "file-editor";

  const languageConf = new Compartment();

  let view: EditorView | null = null;
  let currentPath: string | null = null;
  let savedContent = "";
  let dirty = false;

  function setDirty(next: boolean): void {
    if (dirty === next) return;
    dirty = next;
    handlers.onDirtyChange(dirty);
  }

  function buildState(content: string, lang: Extension[]): EditorState {
    return EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        syntaxHighlighting(appHighlight, { fallback: true }),
        languageConf.of(lang),
        appTheme,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) setDirty(view!.state.doc.toString() !== savedContent);
        }),
      ],
    });
  }

  async function open(path: string, name: string): Promise<void> {
    currentPath = path;
    view?.destroy();
    view = null;
    el.replaceChildren();

    let content: string;
    try {
      content = await invoke<string>("read_text_file", { path });
    } catch (e) {
      const err = document.createElement("div");
      err.className = "file-editor-error";
      err.textContent = String(e);
      el.appendChild(err);
      setDirty(false);
      return;
    }

    savedContent = content;
    view = new EditorView({
      state: buildState(content, languageFor(name)),
      parent: el,
    });
    setDirty(false);
    requestAnimationFrame(() => view?.focus());
  }

  async function save(): Promise<boolean> {
    if (!view || !currentPath || !dirty) return true;
    const content = view.state.doc.toString();
    try {
      await invoke("write_text_file", { path: currentPath, content });
      savedContent = content;
      setDirty(false);
      return true;
    } catch (e) {
      console.error("Failed to save file:", e);
      return false;
    }
  }

  function isDirty(): boolean {
    return dirty;
  }

  function focus(): void {
    view?.focus();
  }

  function containsFocus(node: Node | null): boolean {
    return !!node && el.contains(node);
  }

  function content(): string {
    return view ? view.state.doc.toString() : savedContent;
  }

  /** Replaces the whole document, e.g. with Markdown serialized back out of
   *  the rendered editor. Callers are responsible for validating `next`. */
  function setContent(next: string): void {
    if (!view || next === content()) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
  }

  return { el, open, save, isDirty, focus, containsFocus, content, setContent };
}

export interface FileViewerHandlers {
  onRequestClose(): void;
}

/** Main-area file panel shown in place of the terminal panes: header with the
 *  filename, a dirty indicator, Save, and a close button, wrapping the editor. */
export function createFileViewerPanel(
  handlers: FileViewerHandlers,
  opts: { mode?: "overlay" | "pane" } = {}
) {
  // "pane" mode reuses the whole surface (editor, Markdown modes, preview)
  // inside a tiled pane; only the chrome differs, so the two spaces a file can
  // live in stay byte-for-byte the same editor.
  const inPane = opts.mode === "pane";

  const el = document.createElement("div");
  el.className = inPane ? "pane file-pane" : "file-viewer";

  const header = document.createElement("div");
  header.className = inPane ? "pane-bar file-pane-bar" : "file-viewer-header";

  const dot = document.createElement("span");
  dot.className = "file-viewer-dirty-dot";
  dot.title = "Unsaved changes";

  const title = document.createElement("span");
  title.className = "file-viewer-title";

  const saveBtn = document.createElement("button");
  saveBtn.className = "file-viewer-save";
  saveBtn.title = "Save file (Ctrl+S)";
  saveBtn.textContent = "Save";
  saveBtn.disabled = true;

  /** Markdown-only: flips the body between the raw editor and rendered HTML. */
  const mdToggle = document.createElement("button");
  mdToggle.className = "file-viewer-md-toggle";
  mdToggle.hidden = true;

  const closeBtn = document.createElement("button");
  closeBtn.className = "file-viewer-close";
  closeBtn.title = "Close file";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => handlers.onRequestClose());

  header.append(dot, title, mdToggle, saveBtn);
  // A tiled file pane gets the standard pane buttons instead (split/fold/…),
  // appended by its host — see filePanes.ts.
  if (!inPane) header.appendChild(closeBtn);

  const editor = createFileEditor({
    onDirtyChange: (dirty) => {
      dot.classList.toggle("visible", dirty);
      saveBtn.disabled = !dirty;
    },
  });

  saveBtn.addEventListener("click", () => {
    void (async () => {
      if (!flushWysiwyg()) return;
      await editor.save();
    })();
  });

  const preview = createFilePreview();

  const wysiwyg = createMarkdownWysiwyg({
    onEdit: () => {
      dot.classList.add("visible");
      saveBtn.disabled = false;
    },
  });

  /** Formatting toolbar for the rendered Markdown editor. */
  const mdToolbar = document.createElement("div");
  mdToolbar.className = "md-toolbar";
  mdToolbar.hidden = true;

  const toolbarActions: [string, string, ToolbarCommand][] = [
    ["B", "Bold", "bold"],
    ["I", "Italic", "italic"],
    ["S", "Strikethrough", "strike"],
    ["H1", "Heading 1", "h1"],
    ["H2", "Heading 2", "h2"],
    ["H3", "Heading 3", "h3"],
    ["¶", "Plain paragraph", "paragraph"],
    ["• List", "Bullet list", "bullet"],
    ["1. List", "Numbered list", "ordered"],
    ["❝❞", "Quote", "quote"],
    ["</>", "Inline code", "code"],
    ["Table", "Insert table", "table"],
    ["Link", "Insert link", "link"],
    ["―", "Horizontal rule", "hr"],
  ];

  toolbarActions.forEach(([label, hint, command]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-toolbar-btn";
    btn.textContent = label;
    btn.title = hint;
    // mousedown (not click) so the editor selection survives the press.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      wysiwyg.run(command);
    });
    mdToolbar.appendChild(btn);
  });

  /** Explains why a file fell back to the raw editor, or that a serialization
   *  was refused. Never shown during normal editing. */
  const mdNotice = document.createElement("div");
  mdNotice.className = "md-notice";
  mdNotice.hidden = true;

  const mdColumn = document.createElement("div");
  mdColumn.className = "md-editor-wrap";
  mdColumn.append(mdToolbar, mdNotice, editor.el, wysiwyg.el);

  const body = document.createElement("div");
  body.className = "file-viewer-body";
  body.append(mdColumn, preview.el);

  el.append(header, body);

  /** Non-null while a read-only (non-text) file is being previewed. */
  let previewing: PreviewKind | null = null;
  let markdown = false;
  let mdRendered = false;

  function showNotice(text: string): void {
    mdNotice.textContent = text;
    mdNotice.hidden = false;
  }

  function syncMdView(): void {
    mdToggle.textContent = mdRendered ? "Raw" : "Rendered";
    mdToggle.title = mdRendered
      ? "Edit the raw Markdown source"
      : "Edit the Markdown as a formatted document";
    mdToolbar.hidden = !mdRendered;
    wysiwyg.el.hidden = !mdRendered;
    editor.el.hidden = mdRendered;
  }

  /** Copies the rendered editor's Markdown into the CodeMirror document, which
   *  is the only thing ever written to disk. Does nothing unless the user
   *  actually edited in the rendered view, so merely looking at a file can
   *  never rewrite a single byte of it. Returns false if the serialization was
   *  refused, in which case the caller must not save. */
  function flushWysiwyg(): boolean {
    if (!mdRendered || !wysiwyg.edited()) return true;
    const next = wysiwyg.markdown();
    const problem = saveProblem(next);
    if (problem) {
      showNotice(`Not saving: ${problem}. Switch to Raw to recover your text.`);
      return false;
    }
    mdNotice.hidden = true;
    editor.setContent(next);
    return true;
  }

  async function enterRendered(): Promise<void> {
    const problem = await wysiwyg.load(editor.content());
    if (problem) {
      mdRendered = false;
      syncMdView();
      showNotice(`Editing this file as a formatted document isn't safe — ${problem}. Using the raw editor instead.`);
      editor.focus();
      return;
    }
    mdNotice.hidden = true;
    mdRendered = true;
    syncMdView();
    wysiwyg.focus();
  }

  async function leaveRendered(): Promise<void> {
    flushWysiwyg();
    mdRendered = false;
    syncMdView();
    await wysiwyg.destroy();
    editor.focus();
  }

  mdToggle.addEventListener("click", () => {
    void (mdRendered ? leaveRendered() : enterRendered());
  });

  let openPath = "";

  /** `pending` carries unsaved text across a dock/expand morph: the file is
   *  still read from disk (so language, preview kind and the saved baseline are
   *  right), then the in-flight edits are laid back over it, leaving the new
   *  surface dirty exactly as the old one was. */
  async function open(path: string, name: string, pending?: string): Promise<void> {
    openPath = path;
    title.textContent = name;
    title.title = path;

    previewing = previewKindFor(name);
    markdown = !previewing && isMarkdown(name);
    mdRendered = false;
    mdNotice.hidden = true;
    await wysiwyg.destroy();

    mdToggle.hidden = !markdown;
    saveBtn.hidden = !!previewing;
    dot.hidden = !!previewing;
    preview.el.hidden = !previewing;
    mdColumn.hidden = !!previewing;

    if (previewing) {
      syncMdView();
      preview.reset();
      await preview.open(path, name, previewing);
      return;
    }

    // Keep both editor surfaces hidden until we know which one a Markdown
    // file is landing on, so opening one doesn't flash the raw editor before
    // enterRendered() switches it to the rendered view a moment later.
    editor.el.hidden = true;
    wysiwyg.el.hidden = true;
    mdToolbar.hidden = true;

    await editor.open(path, name);
    if (pending != null) editor.setContent(pending);
    if (markdown) {
      await enterRendered();
    } else {
      syncMdView();
    }
  }

  /** Called when the viewer is dismissed, so previewed media stops playing. */
  function close(): void {
    preview.reset();
    void wysiwyg.destroy();
  }

  return {
    el,
    header,
    open,
    close,
    /** Absolute path of whatever is currently open ("" before the first open). */
    path: () => openPath,
    /** True for read-only previews (images, PDFs…) — no text to hand over. */
    isPreview: () => !!previewing,
    /** Folds any pending rendered-Markdown edits into the raw document so
     *  `text()` is authoritative. False when serialization was refused. */
    flush: () => flushWysiwyg(),
    text: () => editor.content(),
    setText: (next: string) => editor.setContent(next),
    save: async () => {
      if (previewing) return true;
      if (!flushWysiwyg()) return false;
      return editor.save();
    },
    isDirty: () => !previewing && (editor.isDirty() || (mdRendered && wysiwyg.edited())),
    focus: () => {
      if (previewing) return;
      if (mdRendered) wysiwyg.focus();
      else editor.focus();
    },
    containsFocus: (node: Node | null) => {
      if (previewing) return false;
      return !!node && mdColumn.contains(node);
    },
  };
}

export type FileSurface = ReturnType<typeof createFileViewerPanel>;
