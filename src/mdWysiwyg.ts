import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
import type { Editor } from "@milkdown/kit/core";
import type { CmdKey } from "@milkdown/kit/core";
import { stringifyOptions, normalizeSerialized, fidelityProblem } from "./mdSerialize";

/** Milkdown (ProseMirror + remark) WYSIWYG surface for Markdown files.
 *
 *  Markdown text goes in, Markdown text comes out — the intermediate model is
 *  a Markdown AST, never HTML. Callers must still treat the output as
 *  untrusted: `load()` refuses any file that doesn't survive a round trip, and
 *  the result of `markdown()` is only meaningful once `edited()` is true. */

export type ToolbarCommand =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "h1"
  | "h2"
  | "h3"
  | "paragraph"
  | "bullet"
  | "ordered"
  | "quote"
  | "link"
  | "hr"
  | "table";

export interface MarkdownWysiwygHandlers {
  /** Fired the first time the user changes the document. */
  onEdit(): void;
}

export function createMarkdownWysiwyg(handlers: MarkdownWysiwygHandlers) {
  const el = document.createElement("div");
  el.className = "md-wysiwyg";

  let editor: Editor | null = null;
  let ready = false;
  let edited = false;

  async function destroy(): Promise<void> {
    ready = false;
    edited = false;
    const current = editor;
    editor = null;
    if (current) await current.destroy();
    el.replaceChildren();
  }

  function markdown(): string {
    if (!editor) return "";
    const { editorViewCtx, serializerCtx } = ctxKeys!;
    return normalizeSerialized(
      editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))
    );
  }

  let ctxKeys: typeof import("@milkdown/kit/core") | null = null;
  // CmdKey is invariant in its payload type, so the heterogeneous table below
  // can only be held loosely.
  let commandKeys: Record<ToolbarCommand, { key: CmdKey<any>; payload?: unknown }> | null = null;
  let commandsCtxKey: (typeof import("@milkdown/kit/core"))["commandsCtx"] | null = null;

  /** Loads Markdown into the rendered editor. Returns null on success, or the
   *  reason this file must stay in the raw editor instead. */
  async function load(source: string): Promise<string | null> {
    await destroy();

    const core = await import("@milkdown/kit/core");
    const commonmark = await import("@milkdown/kit/preset/commonmark");
    const gfmPreset = await import("@milkdown/kit/preset/gfm");
    const { history } = await import("@milkdown/kit/plugin/history");
    const { listener, listenerCtx } = await import("@milkdown/kit/plugin/listener");
    ctxKeys = core;
    commandsCtxKey = core.commandsCtx;

    commandKeys = {
      bold: { key: commonmark.toggleStrongCommand.key },
      italic: { key: commonmark.toggleEmphasisCommand.key },
      strike: { key: gfmPreset.toggleStrikethroughCommand.key },
      code: { key: commonmark.toggleInlineCodeCommand.key },
      h1: { key: commonmark.wrapInHeadingCommand.key, payload: 1 },
      h2: { key: commonmark.wrapInHeadingCommand.key, payload: 2 },
      h3: { key: commonmark.wrapInHeadingCommand.key, payload: 3 },
      paragraph: { key: commonmark.turnIntoTextCommand.key },
      bullet: { key: commonmark.wrapInBulletListCommand.key },
      ordered: { key: commonmark.wrapInOrderedListCommand.key },
      quote: { key: commonmark.wrapInBlockquoteCommand.key },
      link: { key: commonmark.toggleLinkCommand.key },
      hr: { key: commonmark.insertHrCommand.key },
      table: { key: gfmPreset.insertTableCommand.key },
    };

    const instance = await core.Editor.make()
      .config((ctx) => {
        ctx.set(core.rootCtx, el);
        ctx.set(core.defaultValueCtx, source);
        ctx.update(core.remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...stringifyOptions }));
        ctx.update(core.editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: { class: "milkdown-doc preview-doc", spellcheck: "false" },
        }));
        ctx.get(listenerCtx).updated(() => {
          if (!ready || edited) return;
          edited = true;
          handlers.onEdit();
        });
      })
      .use(commonmark.commonmark)
      .use(gfmPreset.gfm)
      .use(history)
      .use(listener)
      .create();

    editor = instance;

    // Fidelity gate: serialize the untouched document and make sure it still
    // matches the file on disk. Files that fail this are never editable here.
    const problem = fidelityProblem(source, markdown());
    if (problem) {
      await destroy();
      return problem;
    }

    ready = true;
    return null;
  }

  function run(command: ToolbarCommand): void {
    if (!editor || !commandKeys || !commandsCtxKey) return;
    const entry = commandKeys[command];
    let payload = entry.payload;
    if (command === "link") {
      const href = window.prompt("Link URL:", "https://");
      if (!href) return;
      payload = { href };
    }
    editor.action((ctx) => {
      ctx.get(commandsCtxKey!).call(entry.key, payload);
    });
    focus();
  }

  function focus(): void {
    if (!editor || !ctxKeys) return;
    const { editorViewCtx } = ctxKeys;
    editor.action((ctx) => ctx.get(editorViewCtx).focus());
  }

  return {
    el,
    load,
    destroy,
    run,
    focus,
    markdown,
    edited: () => edited,
    containsFocus: (node: Node | null) => !!node && el.contains(node),
  };
}
