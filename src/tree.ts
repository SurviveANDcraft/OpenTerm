import type { Dir, LeafNode, PaneNode, SplitNode } from "./types";

export function collectLeaves(node: PaneNode, out: string[] = []): string[] {
  if (node.type === "leaf") out.push(node.id);
  else node.children.forEach((c) => collectLeaves(c, out));
  return out;
}

/** Split the target leaf in `dir`, inserting a new leaf with `newId`.
 *  Returns the (possibly new) root. Mutates internal nodes. */
export function splitLeaf(
  node: PaneNode,
  targetId: string,
  dir: Dir,
  newId: string,
  before = false
): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    const fresh: LeafNode = { type: "leaf", id: newId };
    return {
      type: "split",
      dir,
      children: before ? [fresh, node] : [node, fresh],
      sizes: [0.5, 0.5],
    };
  }
  const idx = node.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
  if (idx >= 0 && node.dir === dir) {
    const half = node.sizes[idx] / 2;
    node.sizes[idx] = half;
    const at = before ? idx : idx + 1;
    node.children.splice(at, 0, { type: "leaf", id: newId });
    node.sizes.splice(at, 0, half);
    return node;
  }
  node.children = node.children.map((c) => splitLeaf(c, targetId, dir, newId, before));
  return node;
}

/** Drop every leaf that hosts an embedded external window (their HWNDs die with
 *  the app), collapsing single-child splits. Returns the pruned root, or null if
 *  the whole tree was external. Used when loading persisted state. */
export function pruneExternalLeaves(node: PaneNode): PaneNode | null {
  if (node.type === "leaf") return node.external ? null : node;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = pruneExternalLeaves(c);
    if (r) {
      children.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  node.children = children;
  node.sizes = sizes.map((s) => s / total);
  return node;
}

/** Remove a leaf; collapses single-child splits. Returns new root or null if empty. */
export function removeLeaf(node: PaneNode, id: string): PaneNode | null {
  if (node.type === "leaf") return node.id === id ? null : node;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removeLeaf(c, id);
    if (r) {
      children.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  node.children = children;
  node.sizes = sizes.map((s) => s / total);
  return node;
}

export function findLeaf(node: PaneNode, id: string): LeafNode | undefined {
  if (node.type === "leaf") return node.id === id ? node : undefined;
  for (const c of node.children) {
    const r = findLeaf(c, id);
    if (r) return r;
  }
  return undefined;
}

export function swapLeaves(node: PaneNode, a: string, b: string): void {
  const leaves: LeafNode[] = [];
  const walk = (n: PaneNode) => {
    if (n.type === "leaf") leaves.push(n);
    else n.children.forEach(walk);
  };
  walk(node);
  const la = leaves.find((l) => l.id === a);
  const lb = leaves.find((l) => l.id === b);
  if (la && lb) {
    // Swap the whole leaf *contents*, not just the ids: everything that
    // describes what a pane is (kind, the browser's url, a docked file's path,
    // the remembered command) has to travel with its id, or the tree ends up
    // describing pane A with pane B's metadata.
    const copy = { ...la } as LeafNode;
    Object.keys(la).forEach((k) => delete (la as Record<string, unknown>)[k]);
    Object.assign(la, lb);
    Object.keys(lb).forEach((k) => delete (lb as Record<string, unknown>)[k]);
    Object.assign(lb, copy);
  }
}

type PathEntry = { node: SplitNode; index: number };

export function pathTo(node: PaneNode, id: string, acc: PathEntry[] = []): PathEntry[] | null {
  if (node.type === "leaf") return node.id === id ? acc : null;
  for (let i = 0; i < node.children.length; i++) {
    const r = pathTo(node.children[i], id, [...acc, { node, index: i }]);
    if (r) return r;
  }
  return null;
}

const MIN_SIZE = 0.08;

/** Grow (delta>0) or shrink (delta<0) the leaf's share along `dir`. Returns true if changed. */
export function resizeLeaf(root: PaneNode, leafId: string, dir: Dir, delta: number): boolean {
  const path = pathTo(root, leafId);
  if (!path) return false;
  for (let i = path.length - 1; i >= 0; i--) {
    const { node, index } = path[i];
    if (node.dir !== dir || node.children.length < 2) continue;
    const other = index < node.children.length - 1 ? index + 1 : index - 1;
    const a = node.sizes[index] + delta;
    const b = node.sizes[other] - delta;
    if (a < MIN_SIZE || b < MIN_SIZE) return false;
    node.sizes[index] = a;
    node.sizes[other] = b;
    return true;
  }
  return false;
}
