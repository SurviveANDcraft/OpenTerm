/** Agent prose as HTML: GitHub-flavoured markdown through marked, sanitised
 *  by DOMPurify (agent output is untrusted), code blocks wrapped with a
 *  language label and a copy button. */
import { Marked } from "marked";
import DOMPurify from "dompurify";

const md = new Marked({ gfm: true, breaks: false, async: false });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

md.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0];
      return `<div class="th-code"><div class="th-code-bar"><span>${esc(language || "text")}</span><button class="th-code-copy" type="button" data-copy>Copy</button></div><pre><code>${esc(text)}</code></pre></div>`;
    },
    link({ href, text }) {
      return `<a href="${esc(href)}" data-ext title="${esc(href)}">${text}</a>`;
    },
    table(token) {
      const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("");
      const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("");
      return `<div class="th-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },
  },
});

const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(md.parse(text) as string, {
    ADD_ATTR: ["data-copy", "data-ext"],
    FORBID_TAGS: ["style", "iframe", "form", "input"],
  });
  if (text.length < 40_000) {
    cache.set(text, html);
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
  }
  return html;
}

/** Streaming text: an unclosed fence would swallow the rest of the message as
 *  code until it closes, which reads fine; an unclosed `**` would not render
 *  bold at all until closed, also fine. So the raw partial is good as is. */
export function renderStreaming(text: string): string {
  return renderMarkdown(text);
}
