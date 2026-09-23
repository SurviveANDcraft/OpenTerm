/** Serialization safety layer for the WYSIWYG Markdown editor.
 *
 *  Everything here is pure text-in/text-out so `scripts/md-roundtrip-test.mjs`
 *  exercises the exact code the app runs — the round-trip guarantees are only
 *  worth anything if the test and the editor share one implementation. */

/** remark-stringify settings chosen to match how Markdown is normally written
 *  in this repo, so a round trip churns as few bytes as possible. */
export const stringifyOptions = {
  bullet: "-" as const,
  emphasis: "*" as const,
  strong: "*" as const,
  fence: "`" as const,
  fences: true,
  rule: "-" as const,
  ruleRepetition: 3,
  listItemIndent: "one" as const,
  tightDefinitions: true,
};

/** Milkdown's table cells always hold a paragraph, and remark serializes an
 *  empty one as a literal `<br />`. Left alone that silently injects markup
 *  into every blank cell of every table the user touches. */
export function normalizeSerialized(markdown: string): string {
  return markdown.replace(/^\s*\|.*\|\s*$/gm, (row) =>
    row.replace(/(\|\s*)<br\s*\/?>(\s*\|)/g, "$1$2").replace(/(\|\s*)<br\s*\/?>(\s*\|)/g, "$1$2")
  );
}

const fencedBodies = (md: string) =>
  [...md.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1].replace(/\s+$/, ""));

const tableRows = (md: string) => md.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;

const headings = (md: string) => md.split("\n").filter((l) => /^#{1,6}\s/.test(l)).length;

/** Raw HTML embedded in Markdown is where a document-model round trip is
 *  weakest (a trailing `<br>` is silently dropped, for one), so count the tags
 *  outside code and refuse the file if any went missing. */
const htmlTags = (md: string) =>
  (
    md
      .replace(/^```[\s\S]*?^```/gm, "")
      .replace(/`[^`\n]*`/g, "")
      // A real tag name, then only whitespace-led attributes — this deliberately
      // does not match autolinks like <https://x> or <a@b.com>.
      .match(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>\n]*)?\/?>/g) ?? []
  ).length;

/** Compares the Markdown a file was loaded from against what the WYSIWYG
 *  serializer produces for the *unmodified* document. A mismatch here means
 *  this file doesn't survive the round trip, so it must not be edited in the
 *  rendered view at all. Returns a human-readable reason, or null when safe. */
export function fidelityProblem(original: string, roundTripped: string): string | null {
  if (original.trim() && !roundTripped.trim()) return "the rendered view produced an empty document";

  const ratio = roundTripped.length / Math.max(1, original.length);
  if (ratio < 0.75 || ratio > 1.5)
    return `the rendered view changed the document size by ${Math.round(Math.abs(1 - ratio) * 100)}%`;

  const a = fencedBodies(original);
  const b = fencedBodies(roundTripped);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) return "code blocks don't survive the round trip";

  if (tableRows(original) !== tableRows(roundTripped)) return "tables don't survive the round trip";
  if (headings(original) !== headings(roundTripped)) return "headings don't survive the round trip";
  if (htmlTags(original) !== htmlTags(roundTripped)) return "embedded HTML doesn't survive the round trip";

  return null;
}

/** Last-ditch check before anything reaches disk. */
export function saveProblem(markdown: string): string | null {
  return markdown.trim() ? null : "the editor produced an empty document";
}
