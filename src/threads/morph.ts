/** Patches `target`'s children to match `html` in place, element by element,
 *  so live re-renders don't restart CSS animations, drop hover states or
 *  reset scroll positions. Children are matched by `data-key` when present,
 *  else by position and tag. */
export function morphInner(target: Element, html: string): void {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  morphChildren(target, tpl.content);
}

function keyOf(n: Node): string | null {
  return n.nodeType === 1 ? (n as Element).getAttribute("data-key") : null;
}

function morphChildren(from: Node, to: Node): void {
  const want = Array.from(to.childNodes);
  const keyed = new Map<string, Node>();
  for (const c of Array.from(from.childNodes)) {
    const k = keyOf(c);
    if (k) keyed.set(k, c);
  }
  let cursor = from.firstChild;
  for (const next of want) {
    const k = keyOf(next);
    let match: Node | null = null;
    if (k) {
      match = keyed.get(k) ?? null;
      if (match) keyed.delete(k);
    } else if (cursor && !keyOf(cursor) && sameKind(cursor, next)) match = cursor;
    if (match) {
      if (match !== cursor) from.insertBefore(match, cursor);
      else cursor = cursor.nextSibling;
      patch(match, next);
    } else {
      from.insertBefore(next, cursor);
    }
  }
  while (cursor) {
    const n = cursor.nextSibling;
    from.removeChild(cursor);
    cursor = n;
  }
}

function sameKind(a: Node, b: Node): boolean {
  return a.nodeType === b.nodeType && (a.nodeType !== 1 || (a as Element).tagName === (b as Element).tagName);
}

function patch(a: Node, b: Node): void {
  if (a.nodeType === 3 || a.nodeType === 8) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  if (a.nodeType !== 1) return;
  const ea = a as Element;
  const eb = b as Element;
  for (const attr of Array.from(ea.attributes)) if (!eb.hasAttribute(attr.name)) ea.removeAttribute(attr.name);
  for (const attr of Array.from(eb.attributes)) if (ea.getAttribute(attr.name) !== attr.value) ea.setAttribute(attr.name, attr.value);
  // Inline SVG markup is static per icon; skip deep diffing it.
  if (ea.tagName.toLowerCase() === "svg") {
    if (ea.innerHTML !== eb.innerHTML) ea.innerHTML = eb.innerHTML;
    return;
  }
  morphChildren(ea, eb);
}
