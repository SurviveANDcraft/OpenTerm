import { fetchGitMap, GitCommitInfo, GitMapData } from "./git";
import { copyText } from "./clipboard";

/** Git Map: a two-pane, read-only view of everything locally known about a
 *  repo. The left pane is a hierarchical explorer — working tree, branches,
 *  remotes, tags, stashes, contributors — where nested names (`feat/foo/bar`)
 *  become real nested groups. The right pane is the commit graph: a lane rail
 *  drawn in SVG next to uniformly sized commit rows, filtered live by whatever
 *  is selected on the left plus the search box.
 *
 *  Everything shown comes from local git plumbing — nothing is fetched from
 *  the network here; remote-tracking refs are only as fresh as the last
 *  background freshness check (see git.ts). */

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

const ICONS = {
  close:
    '<svg viewBox="0 0 14 14"><line x1="3.5" y1="3.5" x2="10.5" y2="10.5" stroke="currentColor"/><line x1="10.5" y1="3.5" x2="3.5" y2="10.5" stroke="currentColor"/></svg>',
  refresh:
    '<svg viewBox="0 0 14 14"><path fill="none" stroke="currentColor" d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 1.5v3h-3"/></svg>',
  chevron: '<svg class="gm-chev" viewBox="0 0 12 12"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor"/></svg>',
};

const ROW_H = 46;
const LANE_W = 18;
const RAIL_PAD = 12;
const MAX_LANES_SHOWN = 8;

const LANE_COLORS = ["#6ea8d8", "#7fb069", "#c78fd6", "#e8b45a", "#e3766b", "#5fc4b8", "#b5b95a", "#9aa0f5"];
const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  const units: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.345, "w"],
    [12, "mo"],
    [Infinity, "y"],
  ];
  let v = s;
  for (const [div, label] of units) {
    if (v < div) return `${Math.max(1, Math.floor(v))}${label}`;
    v /= div;
  }
  return `${Math.floor(v)}y`;
}

function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Simplified git-graph lane assignment: walks commits newest-first (the
 *  order `git log` gives us) and keeps a set of "awaited" parent shas per
 *  lane, assigning each commit to the lane that was expecting it (or a fresh
 *  one for a branch tip), then handing its parents onward — first parent
 *  continues the lane, extra parents (merges) open new ones. */
function assignLanes(commits: GitCommitInfo[]): Map<string, number> {
  const lanes: (string | null)[] = [];
  const laneOf = new Map<string, number>();
  for (const c of commits) {
    let lane = lanes.indexOf(c.sha);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
    }
    laneOf.set(c.sha, lane);
    const [first, ...rest] = c.parents;
    lanes[lane] = first ?? null;
    for (const p of rest) {
      if (lanes.includes(p)) continue;
      const free = lanes.indexOf(null);
      if (free === -1) lanes.push(p);
      else lanes[free] = p;
    }
  }
  return laneOf;
}

// ---------------------------------------------------------------- tree model

type TreeKind = "section" | "group" | "branch" | "remote" | "tag" | "stash" | "contrib" | "dir" | "file";

interface TreeNode {
  id: string;
  label: string;
  kind: TreeKind;
  /** Right-aligned annotation (ahead/behind, counts, status codes). */
  meta?: string;
  metaTone?: "ok" | "warn" | "dim" | "track";
  /** Commit this node points at, used to focus the graph. */
  sha?: string;
  /** Author name this node filters the graph by. */
  author?: string;
  title?: string;
  /** 0..1 — draws a proportional bar behind the row (contributors). */
  bar?: number;
  children?: TreeNode[];
}

/** Splits `feat/ui/panel`-style names into nested groups so a flat ref list
 *  reads as the hierarchy the names already imply. Single-child chains are
 *  left nested (that is the point) but leaves keep their full name as id. */
function nestByPath<T>(
  items: T[],
  idPrefix: string,
  nameOf: (item: T) => string,
  leafOf: (item: T, label: string) => TreeNode
): TreeNode[] {
  const roots: TreeNode[] = [];
  const groups = new Map<string, TreeNode>();
  for (const item of items) {
    const full = nameOf(item);
    const parts = full.split("/");
    const leafLabel = parts.pop() ?? full;
    let level = roots;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      const key = `${idPrefix}:dir:${path}`;
      let group = groups.get(key);
      if (!group) {
        group = { id: key, label: part, kind: "group", children: [] };
        groups.set(key, group);
        level.push(group);
      }
      level = group.children!;
    }
    level.push(leafOf(item, leafLabel));
  }
  const annotate = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (!n.children) continue;
      annotate(n.children);
      const count = countLeaves(n);
      n.meta = String(count);
      n.metaTone = "dim";
    }
  };
  annotate(roots);
  return roots;
}

function countLeaves(node: TreeNode): number {
  if (!node.children?.length) return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

/** Builds a directory tree out of working-tree paths so a wide-ranging dirty
 *  state stays readable instead of collapsing into 80 sibling rows. */
function fileTree(files: { status: string; path: string; untracked: boolean; staged: boolean }[]): TreeNode[] {
  return nestByPath(files, "wt", (f) => f.path, (f, label) => ({
    id: `wt:file:${f.path}`,
    label,
    kind: "file",
    meta: f.status.trim() || "??",
    metaTone: f.untracked ? "dim" : f.staged ? "ok" : "warn",
    title: `${f.path} — ${describeStatus(f.status)}`,
  }));
}

function describeStatus(code: string): string {
  const map: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflicted", "?": "untracked" };
  const [index, work] = [code[0], code[1]];
  const parts: string[] = [];
  if (index && index !== " " && index !== "?") parts.push(`staged: ${map[index] ?? index}`);
  if (work && work !== " " && work !== "?") parts.push(`unstaged: ${map[work] ?? work}`);
  if (code === "??") parts.push("untracked");
  return parts.join(", ") || "changed";
}

// ---------------------------------------------------------------- the panel

export function createGitMapPanel() {
  const el = document.createElement("div");
  el.className = "gitmap";

  const card = document.createElement("div");
  card.className = "gitmap-card";

  // ---- header ----
  const head = document.createElement("div");
  head.className = "gitmap-head";
  const heading = document.createElement("div");
  heading.className = "gitmap-heading";
  const title = document.createElement("h2");
  title.textContent = "Git Map";
  const subtitle = document.createElement("div");
  subtitle.className = "gitmap-subtitle";
  heading.append(title, subtitle);

  const stats = document.createElement("div");
  stats.className = "gitmap-stats";

  const headActions = document.createElement("div");
  headActions.className = "gitmap-head-actions";
  const search = document.createElement("input");
  search.className = "gitmap-search";
  search.type = "search";
  search.placeholder = "Filter commits…";
  search.spellcheck = false;
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "pane-btn gitmap-icon-btn";
  refreshBtn.innerHTML = ICONS.refresh;
  refreshBtn.title = "Refresh";
  const closeBtn = document.createElement("button");
  closeBtn.className = "pane-btn gitmap-icon-btn";
  closeBtn.innerHTML = ICONS.close;
  closeBtn.title = "Close (Esc)";
  headActions.append(search, refreshBtn, closeBtn);
  head.append(heading, stats, headActions);

  // ---- body: explorer | graph ----
  const main = document.createElement("div");
  main.className = "gitmap-main";

  const tree = document.createElement("aside");
  tree.className = "gitmap-tree";

  const graph = document.createElement("section");
  graph.className = "gitmap-graph";
  const graphHead = document.createElement("div");
  graphHead.className = "gitmap-graph-head";
  const scopeEl = document.createElement("div");
  scopeEl.className = "gitmap-scope";
  const graphTools = document.createElement("div");
  graphTools.className = "gitmap-graph-tools";
  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.className = "pane-btn gitmap-icon-btn";
  zoomOutBtn.textContent = "−";
  zoomOutBtn.title = "Zoom out";
  const zoomInBtn = document.createElement("button");
  zoomInBtn.className = "pane-btn gitmap-icon-btn";
  zoomInBtn.textContent = "+";
  zoomInBtn.title = "Zoom in";
  graphTools.append(zoomOutBtn, zoomInBtn);
  graphHead.append(scopeEl, graphTools);

  const scroll = document.createElement("div");
  scroll.className = "gitmap-scroll";
  const rows = document.createElement("div");
  rows.className = "gitmap-rows";
  const rail = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  rail.setAttribute("class", "gitmap-rail");
  const rowList = document.createElement("div");
  rowList.className = "gitmap-rowlist";
  rows.append(rail, rowList);
  scroll.appendChild(rows);

  const detail = document.createElement("div");
  detail.className = "gitmap-detail hidden";

  graph.append(graphHead, scroll, detail);

  const empty = document.createElement("div");
  empty.className = "gitmap-empty hidden";

  // Loading placeholder shaped like the panel itself: a file column on the
  // left, a commit rail on the right. Built once and toggled by `.loading`,
  // so a slow repo scan shows the layout filling in rather than a bare pill.
  const skel = document.createElement("div");
  skel.className = "gitmap-skel";
  skel.setAttribute("aria-hidden", "true");
  const skelFiles = Array.from(
    { length: 9 },
    (_, i) => `<div class="gm-skel-file" style="--i:${i}">
      <span class="skel gm-skel-dot"></span>
      <span class="skel gm-skel-line" style="width:${45 + ((i * 17) % 45)}%"></span>
    </div>`
  ).join("");
  const skelRows = Array.from(
    { length: 8 },
    (_, i) => `<div class="gm-skel-row" style="--i:${i}">
      <span class="skel gm-skel-node"></span>
      <span class="skel gm-skel-line" style="width:${30 + ((i * 23) % 55)}%"></span>
      <span class="skel gm-skel-meta"></span>
    </div>`
  ).join("");
  skel.innerHTML = `
    <div class="gm-skel-tree">${skelFiles}</div>
    <div class="gm-skel-graph">
      <div class="gm-skel-rail"></div>
      ${skelRows}
      <div class="skel-status gm-skel-status">Reading repository<span class="skel-dots"><i></i><i></i><i></i></span></div>
    </div>`;

  main.append(tree, graph, empty, skel);

  const legend = document.createElement("div");
  legend.className = "gitmap-legend";
  legend.innerHTML = `
    <span><i class="gm-swatch gm-sw-head"></i>HEAD</span>
    <span><i class="gm-swatch gm-sw-branch"></i>local branch</span>
    <span><i class="gm-swatch gm-sw-remote"></i>remote</span>
    <span><i class="gm-swatch gm-sw-tag"></i>tag</span>
    <span class="gitmap-legend-hint">click a ref to scope the graph &middot; click a commit for details &middot; click a sha to copy</span>`;

  card.append(head, main, legend);
  el.appendChild(card);
  document.body.appendChild(el);

  // ---- state ----
  let open = false;
  let cwd: string | null = null;
  let data: GitMapData | null = null;
  let zoom = 1;
  let query = "";
  /** Scope the graph to commits reachable from this ref, or all when null. */
  let scope: { label: string; sha: string; kind: string } | null = null;
  let authorFilter: string | null = null;
  let selectedSha: string | null = null;
  const collapsed = new Set<string>();
  let treeRoots: TreeNode[] = [];

  // ------------------------------------------------------------ tree render

  function isOpen(node: TreeNode): boolean {
    return !collapsed.has(node.id);
  }

  function renderTree(): void {
    const out: string[] = [];
    const walk = (nodes: TreeNode[], depth: number): void => {
      for (const n of nodes) {
        const hasKids = !!n.children?.length;
        const expanded = hasKids && isOpen(n);
        const selected =
          (n.sha && scope?.sha === n.sha && scope.label === n.label) || (n.author && authorFilter === n.author);
        const metaCls = n.meta ? `gm-meta gm-meta-${n.metaTone ?? "dim"}` : "";
        out.push(
          `<div class="gm-row gm-row-${n.kind}${selected ? " selected" : ""}" data-id="${esc(n.id)}" data-depth="${depth}"` +
            ` style="--gm-depth:${depth}" ${n.title ? `title="${esc(n.title)}"` : ""}>` +
            (n.bar !== undefined ? `<span class="gm-rowbar" style="width:${Math.round(n.bar * 100)}%"></span>` : "") +
            `<span class="gm-twisty${hasKids ? "" : " gm-twisty-leaf"}${expanded ? " open" : ""}">${hasKids ? ICONS.chevron : ""}</span>` +
            `<span class="gm-dot gm-dot-${n.kind}"></span>` +
            `<span class="gm-label">${esc(n.label)}</span>` +
            (n.meta ? `<span class="${metaCls}">${esc(n.meta)}</span>` : "") +
            `</div>`
        );
        if (expanded) walk(n.children!, depth + 1);
      }
    };
    walk(treeRoots, 0);
    tree.innerHTML = out.join("");
  }

  function findNode(id: string, nodes: TreeNode[] = treeRoots): TreeNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = n.children ? findNode(id, n.children) : null;
      if (hit) return hit;
    }
    return null;
  }

  tree.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".gm-row");
    if (!row) return;
    const node = findNode(row.dataset.id!);
    if (!node) return;
    if (node.children?.length) {
      if (collapsed.has(node.id)) collapsed.delete(node.id);
      else collapsed.add(node.id);
      renderTree();
      return;
    }
    if (node.author) {
      authorFilter = authorFilter === node.author ? null : node.author;
      renderGraph();
      renderTree();
      return;
    }
    if (node.sha) {
      const same = scope?.sha === node.sha && scope.label === node.label;
      scope = same ? null : { label: node.label, sha: node.sha, kind: node.kind };
      renderGraph();
      renderTree();
    }
  });

  // ----------------------------------------------------------- tree building

  function buildTree(d: GitMapData): TreeNode[] {
    const roots: TreeNode[] = [];
    const headBranch = d.branches.find((b) => b.isHead);

    // Working tree
    const wt: TreeNode = {
      id: "sec:worktree",
      label: "Working tree",
      kind: "section",
      meta: d.dirtyCount ? `${d.dirtyCount}` : "clean",
      metaTone: d.dirtyCount ? "warn" : "ok",
      children: d.statusFiles.length ? fileTree(d.statusFiles) : undefined,
    };
    roots.push(wt);
    if (!d.statusFiles.length) collapsed.add(wt.id);

    // Local branches, nested by path segment
    roots.push({
      id: "sec:branches",
      label: "Branches",
      kind: "section",
      meta: String(d.branches.length),
      children: nestByPath(d.branches, "b", (b) => b.name, (b, label) => ({
        id: `b:${b.name}`,
        label: b.isHead ? `${label}  ◉` : label,
        kind: "branch",
        sha: b.sha,
        meta: b.ahead || b.behind ? `${b.ahead ? `↑${b.ahead}` : ""}${b.behind ? `↓${b.behind}` : ""}` : undefined,
        metaTone: "track",
        title: `${b.name}${b.upstream ? ` → ${b.upstream}` : " (no upstream)"}`,
      })),
    });

    // Remote-tracking branches, grouped by remote then path
    if (d.remoteBranches.length) {
      roots.push({
        id: "sec:remotes",
        label: d.remoteUrl ? `Remotes · ${shortRemote(d.remoteUrl)}` : "Remotes",
        kind: "section",
        meta: String(d.remoteBranches.length),
        title: d.remoteUrl ?? undefined,
        children: nestByPath(d.remoteBranches, "r", (r) => r.name, (r, label) => ({
          id: `r:${r.name}`,
          label,
          kind: "remote",
          sha: r.sha,
          title: r.name,
        })),
      });
      collapsed.add("sec:remotes");
    }

    if (d.tags.length) {
      const tags = [...d.tags].reverse();
      roots.push({
        id: "sec:tags",
        label: "Tags",
        kind: "section",
        meta: String(d.tags.length),
        children: nestByPath(tags, "t", (t) => t.name, (t, label) => ({
          id: `t:${t.name}`,
          label,
          kind: "tag",
          sha: t.sha,
          title: t.name,
        })),
      });
      collapsed.add("sec:tags");
    }

    if (d.stashes.length) {
      roots.push({
        id: "sec:stashes",
        label: "Stashes",
        kind: "section",
        meta: String(d.stashes.length),
        children: d.stashes.map((s) => ({
          id: `st:${s.name}`,
          label: s.message || s.name,
          kind: "stash" as const,
          meta: s.name,
          metaTone: "dim" as const,
          title: `${s.name}: ${s.message}`,
        })),
      });
      collapsed.add("sec:stashes");
    }

    if (d.contributors.length) {
      const max = Math.max(...d.contributors.map((c) => c.count), 1);
      roots.push({
        id: "sec:contributors",
        label: "Contributors",
        kind: "section",
        meta: String(d.contributors.length),
        children: d.contributors.slice(0, 40).map((c) => ({
          id: `co:${c.name}`,
          label: c.name,
          kind: "contrib" as const,
          author: c.name,
          meta: String(c.count),
          metaTone: "dim" as const,
          bar: c.count / max,
          title: `${c.name} — ${c.count} commits (click to filter the graph)`,
        })),
      });
      collapsed.add("sec:contributors");
    }

    void headBranch;
    return roots;
  }

  function shortRemote(url: string): string {
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m ? m[1] : url;
  }

  // ------------------------------------------------------------ graph render

  /** Commits reachable from `sha` within the loaded window. */
  function reachable(sha: string, bySha: Map<string, GitCommitInfo>): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      const c = bySha.get(cur);
      if (!c) continue;
      seen.add(cur);
      stack.push(...c.parents);
    }
    return seen;
  }

  /** Nearest visible ancestors of `sha`, so a filtered graph still shows how
   *  the surviving commits connect (dashed when the link skips commits). */
  function nearestVisible(sha: string, bySha: Map<string, GitCommitInfo>, visible: Set<string>): { sha: string; direct: boolean }[] {
    if (visible.has(sha)) return [{ sha, direct: true }];
    const out: { sha: string; direct: boolean }[] = [];
    const seen = new Set<string>([sha]);
    let frontier = bySha.get(sha)?.parents ?? [];
    let depth = 0;
    while (frontier.length && depth < 60) {
      const next: string[] = [];
      for (const p of frontier) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (visible.has(p)) out.push({ sha: p, direct: false });
        else next.push(...(bySha.get(p)?.parents ?? []));
      }
      frontier = next;
      depth += 1;
    }
    return out;
  }

  function renderGraph(): void {
    if (!data) return;
    const bySha = new Map(data.commits.map((c) => [c.sha, c]));
    const scopeSet = scope ? reachable(scope.sha, bySha) : null;
    const q = query.trim().toLowerCase();
    const list = data.commits.filter((c) => {
      if (scopeSet && !scopeSet.has(c.sha)) return false;
      if (authorFilter && c.authorName !== authorFilter) return false;
      if (q && !(`${c.subject} ${c.authorName} ${c.sha}`.toLowerCase().includes(q))) return false;
      return true;
    });

    // ---- scope bar ----
    const pills: string[] = [];
    if (scope)
      pills.push(
        `<button class="gm-pill gm-pill-${esc(scope.kind)}" data-clear="scope">${esc(scope.label)}<span class="gm-pill-x">×</span></button>`
      );
    if (authorFilter)
      pills.push(`<button class="gm-pill gm-pill-contrib" data-clear="author">${esc(authorFilter)}<span class="gm-pill-x">×</span></button>`);
    if (q) pills.push(`<button class="gm-pill" data-clear="query">“${esc(query.trim())}”<span class="gm-pill-x">×</span></button>`);
    scopeEl.innerHTML =
      (pills.length ? `<span class="gm-scope-label">Showing</span>${pills.join("")}` : `<span class="gm-scope-label">All refs</span>`) +
      `<span class="gm-scope-count">${list.length} commit${list.length === 1 ? "" : "s"}</span>`;

    const visible = new Set(list.map((c) => c.sha));
    const laneOf = assignLanes(list);
    const indexOf = new Map(list.map((c, i) => [c.sha, i]));
    const maxLane = Math.min(Math.max(0, ...list.map((c) => laneOf.get(c.sha) ?? 0)), MAX_LANES_SHOWN - 1);
    const railW = RAIL_PAD * 2 + (maxLane + 1) * LANE_W;
    rows.style.setProperty("--gm-rail-w", `${railW}px`);

    // ---- rail ----
    const laneX = (lane: number) => RAIL_PAD + Math.min(lane, MAX_LANES_SHOWN - 1) * LANE_W + LANE_W / 2;
    const rowY = (i: number) => i * ROW_H + ROW_H / 2;
    const paths: string[] = [];
    const dots: string[] = [];
    list.forEach((c, i) => {
      const lane = laneOf.get(c.sha) ?? 0;
      const x1 = laneX(lane);
      const y1 = rowY(i);
      const targets = new Map<string, boolean>();
      for (const p of c.parents) {
        for (const t of nearestVisible(p, bySha, visible)) {
          targets.set(t.sha, (targets.get(t.sha) ?? false) || t.direct);
        }
      }
      for (const [tsha, direct] of targets) {
        const j = indexOf.get(tsha);
        if (j === undefined || j <= i) continue;
        const x2 = laneX(laneOf.get(tsha) ?? 0);
        const y2 = rowY(j);
        const d =
          x1 === x2
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${y1 + ROW_H * 0.6}, ${x2} ${y2 - ROW_H * 0.6}, ${x2} ${y2}`;
        paths.push(
          `<path d="${d}" fill="none" stroke="${laneColor(lane)}" stroke-width="1.8" opacity="0.7"${direct ? "" : ' stroke-dasharray="3 3"'}/>`
        );
      }
      const isMerge = c.parents.length > 1;
      const isHeadCommit = c.refs.some((r) => r.startsWith("HEAD"));
      dots.push(
        `<circle cx="${x1}" cy="${y1}" r="${isMerge ? 5.5 : 4.5}" fill="${
          isMerge ? "var(--bg-raised)" : laneColor(lane)
        }" stroke="${laneColor(lane)}" stroke-width="2" class="gm-node-dot${isHeadCommit ? " gm-node-head" : ""}" data-sha="${c.sha}"/>`
      );
    });
    rail.setAttribute("width", String(railW));
    rail.setAttribute("height", String(Math.max(1, list.length * ROW_H)));
    rail.setAttribute("viewBox", `0 0 ${railW} ${Math.max(1, list.length * ROW_H)}`);
    rail.innerHTML = paths.join("") + dots.join("");

    // ---- rows ----
    const maxChurn = Math.max(1, ...list.map((c) => c.insertions + c.deletions));
    const html = list
      .map((c) => {
        const chips = c.refs
          .map((r) => {
            if (r.startsWith("HEAD -> "))
              return `<span class="gm-chip gm-chip-head" title="HEAD → ${esc(r.slice(8))}">◉ ${esc(r.slice(8))}</span>`;
            if (r === "HEAD") return `<span class="gm-chip gm-chip-head">◉ HEAD</span>`;
            if (r.startsWith("tag: ")) return `<span class="gm-chip gm-chip-tag" title="${esc(r.slice(5))}">⌘ ${esc(r.slice(5))}</span>`;
            const remote = data!.remoteBranches.some((rb) => rb.name === r);
            return `<span class="gm-chip ${remote ? "gm-chip-remote" : "gm-chip-branch"}" title="${esc(r)}">${esc(r)}</span>`;
          })
          .join("");
        const churn = c.insertions + c.deletions;
        const add = churn ? (c.insertions / churn) * 100 : 0;
        const weight = churn ? Math.max(6, Math.round((churn / maxChurn) * 100)) : 0;
        return `
          <div class="gm-crow${selectedSha === c.sha ? " selected" : ""}" data-sha="${c.sha}">
            <span class="gm-sha" data-sha="${c.sha}" title="Copy full sha">${c.sha.slice(0, 7)}</span>
            <span class="gm-subject" title="${esc(c.subject)}">${esc(c.subject) || "<em>(no message)</em>"}</span>
            ${chips ? `<span class="gm-chips">${chips}</span>` : ""}
            <span class="gm-churn" title="${c.filesChanged} file${c.filesChanged === 1 ? "" : "s"}, +${c.insertions} −${c.deletions}">
              ${churn ? `<span class="gm-churn-bar" style="width:${weight}%"><i style="width:${add}%"></i></span>` : `<span class="gm-churn-none">merge</span>`}
            </span>
            <span class="gm-author" title="${esc(c.authorEmail)}">${esc(c.authorName)}</span>
            <span class="gm-date" title="${esc(fullDate(c.date))}">${relTime(c.date)}</span>
          </div>`;
      })
      .join("");
    rowList.innerHTML =
      html ||
      `<div class="gm-noresults">No commits match this view.${
        data.commits.length < data.totalCommits ? " Only the latest " + data.commits.length + " commits are loaded." : ""
      }</div>`;
    if (list.length && data.commits.length < data.totalCommits && !scope && !authorFilter && !q) {
      rowList.insertAdjacentHTML(
        "beforeend",
        `<div class="gm-more">⋯ ${data.totalCommits - data.commits.length} older commits not shown</div>`
      );
    }
    renderDetail();
  }

  // ---------------------------------------------------------- detail drawer

  function renderDetail(): void {
    const c = data?.commits.find((x) => x.sha === selectedSha);
    if (!c) {
      detail.classList.add("hidden");
      detail.innerHTML = "";
      return;
    }
    detail.classList.remove("hidden");
    const parents = c.parents
      .map((p) => `<button class="gm-parent" data-goto="${p}" title="Jump to ${p}">${p.slice(0, 7)}</button>`)
      .join("");
    detail.innerHTML = `
      <div class="gm-detail-head">
        <span class="gm-sha" data-sha="${c.sha}" title="Copy full sha">${c.sha.slice(0, 12)}</span>
        <span class="gm-detail-subject">${esc(c.subject) || "<em>(no message)</em>"}</span>
        <button class="gm-detail-close" data-close-detail title="Close">×</button>
      </div>
      <div class="gm-detail-grid">
        <div><span class="gm-detail-k">Author</span>${esc(c.authorName)}${
          c.authorEmail ? ` <span class="gm-detail-dim">&lt;${esc(c.authorEmail)}&gt;</span>` : ""
        }</div>
        <div><span class="gm-detail-k">Date</span>${esc(fullDate(c.date))} <span class="gm-detail-dim">(${relTime(c.date)} ago)</span></div>
        <div><span class="gm-detail-k">Changes</span>${c.filesChanged} file${c.filesChanged === 1 ? "" : "s"}
          <span class="gm-add">+${c.insertions}</span> <span class="gm-del">−${c.deletions}</span></div>
        <div><span class="gm-detail-k">${c.parents.length > 1 ? "Merge of" : "Parent"}</span>${parents || "<em>root commit</em>"}</div>
        ${c.refs.length ? `<div class="gm-detail-refs"><span class="gm-detail-k">Refs</span>${c.refs.map((r) => `<span class="gm-chip gm-chip-branch">${esc(r)}</span>`).join("")}</div>` : ""}
      </div>`;
  }

  // ------------------------------------------------------------- interaction

  rowList.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const shaEl = target.closest<HTMLElement>(".gm-sha");
    if (shaEl) {
      e.stopPropagation();
      copySha(shaEl);
      return;
    }
    const row = target.closest<HTMLElement>(".gm-crow");
    if (!row) return;
    selectedSha = selectedSha === row.dataset.sha ? null : row.dataset.sha!;
    rowList.querySelectorAll(".gm-crow.selected").forEach((r) => r.classList.remove("selected"));
    if (selectedSha) row.classList.add("selected");
    renderDetail();
  });

  detail.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-close-detail]")) {
      selectedSha = null;
      rowList.querySelectorAll(".gm-crow.selected").forEach((r) => r.classList.remove("selected"));
      renderDetail();
      return;
    }
    const shaEl = target.closest<HTMLElement>(".gm-sha");
    if (shaEl) {
      copySha(shaEl);
      return;
    }
    const goto = target.closest<HTMLElement>("[data-goto]");
    if (goto) selectSha(goto.dataset.goto!);
  });

  scopeEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-clear]");
    if (!btn) return;
    const what = btn.dataset.clear;
    if (what === "scope") scope = null;
    if (what === "author") authorFilter = null;
    if (what === "query") {
      query = "";
      search.value = "";
    }
    renderGraph();
    renderTree();
  });

  function selectSha(sha: string): void {
    selectedSha = sha;
    renderGraph();
    const row = rowList.querySelector<HTMLElement>(`.gm-crow[data-sha="${sha}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function copySha(elm: HTMLElement): void {
    const sha = elm.dataset.sha;
    if (!sha) return;
    void copyText(sha);
    const prev = elm.textContent;
    elm.classList.add("copied");
    elm.textContent = "copied!";
    window.setTimeout(() => {
      elm.classList.remove("copied");
      elm.textContent = prev;
    }, 900);
  }

  search.addEventListener("input", () => {
    query = search.value;
    renderGraph();
  });

  function applyZoom(): void {
    rows.style.setProperty("--gm-zoom", String(zoom));
  }
  zoomInBtn.addEventListener("click", () => {
    zoom = Math.min(1.5, zoom + 0.1);
    applyZoom();
  });
  zoomOutBtn.addEventListener("click", () => {
    zoom = Math.max(0.7, zoom - 0.1);
    applyZoom();
  });
  scroll.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom = Math.min(1.5, Math.max(0.7, zoom + (e.deltaY < 0 ? 0.08 : -0.08)));
      applyZoom();
    },
    { passive: false }
  );

  // ------------------------------------------------------------------- load

  function renderStats(d: GitMapData): void {
    const spark = d.activity.length ? d.activity : [];
    const max = Math.max(1, ...spark);
    const bars = spark
      .map(
        (v, i) =>
          `<i style="height:${Math.max(2, Math.round((v / max) * 20))}px;opacity:${0.35 + (i / Math.max(1, spark.length - 1)) * 0.65}" title="${v} commit${
            v === 1 ? "" : "s"
          }, ${spark.length - i} week${spark.length - i === 1 ? "" : "s"} ago"></i>`
      )
      .join("");
    const headBranch = d.branches.find((b) => b.isHead);
    const sync =
      headBranch && (headBranch.ahead || headBranch.behind)
        ? `<span class="gm-stat gm-stat-track" title="Relative to ${esc(headBranch.upstream ?? "upstream")}">${
            headBranch.ahead ? `↑${headBranch.ahead}` : ""
          }${headBranch.ahead && headBranch.behind ? " " : ""}${headBranch.behind ? `↓${headBranch.behind}` : ""}</span>`
        : headBranch?.upstream
          ? `<span class="gm-stat gm-stat-ok" title="As of the last background freshness check">in sync</span>`
          : "";
    stats.innerHTML = `
      <span class="gm-stat"><b>${d.totalCommits}</b> commits</span>
      <span class="gm-stat"><b>${d.branches.length}</b> branches</span>
      ${d.tags.length ? `<span class="gm-stat"><b>${d.tags.length}</b> tags</span>` : ""}
      <span class="gm-stat"><b>${d.contributors.length}</b> authors</span>
      ${
        d.dirtyCount
          ? `<span class="gm-stat gm-stat-warn">${d.dirtyCount} uncommitted</span>`
          : `<span class="gm-stat gm-stat-ok">clean</span>`
      }
      ${sync}
      <span class="gm-spark" title="Commits per week, last 12 weeks">${bars}</span>`;
  }

  async function load(): Promise<void> {
    if (!cwd) return;
    const target = cwd;
    main.classList.add("loading");
    empty.classList.add("hidden");
    try {
      const result = await fetchGitMap(target);
      if (cwd !== target) return;
      main.classList.remove("loading");
      if (!result) {
        showEmpty(`<p>This session's folder isn't a git repository (or git isn't available).</p>`);
        return;
      }
      data = result;
      empty.classList.add("hidden");
      tree.classList.remove("hidden");
      graph.classList.remove("hidden");
      selectedSha = null;
      scope = null;
      authorFilter = null;
      collapsed.clear();
      const shortRoot = result.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? result.repoRoot;
      title.textContent = shortRoot;
      subtitle.textContent = `${result.headBranch || "detached HEAD"} · ${result.repoRoot}`;
      subtitle.title = result.repoRoot;
      renderStats(result);
      treeRoots = buildTree(result);
      renderTree();
      renderGraph();
      applyZoom();
      scroll.scrollTop = 0;
    } catch (err) {
      if (cwd !== target) return;
      main.classList.remove("loading");
      showEmpty(`<p>Couldn't read this repo.</p><p class="gitmap-dim">${esc(String(err))}</p>`);
    }
  }

  function showEmpty(html: string): void {
    data = null;
    empty.innerHTML = html;
    empty.classList.remove("hidden");
    tree.classList.add("hidden");
    graph.classList.add("hidden");
    stats.innerHTML = "";
  }

  function show(folderCwd: string | null | undefined, sessionName: string): void {
    cwd = folderCwd ?? null;
    open = true;
    title.textContent = "Git Map";
    subtitle.textContent = sessionName;
    search.value = "";
    query = "";
    el.classList.add("visible");
    requestAnimationFrame(() => closeBtn.focus());
    if (!cwd) {
      main.classList.remove("loading");
      showEmpty(`<p>This session has no folder to inspect.</p>`);
      return;
    }
    void load();
  }

  function close(): void {
    if (!open) return;
    open = false;
    cwd = null;
    el.classList.remove("visible");
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) close();
  });
  card.addEventListener("pointerdown", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", () => close());
  refreshBtn.addEventListener("click", () => void load());
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      if (document.activeElement === search && search.value) {
        search.value = "";
        query = "";
        renderGraph();
        return;
      }
      close();
    }
    if (e.key === "/" && document.activeElement !== search) {
      e.preventDefault();
      search.focus();
    }
  });

  return { el, show, close, isOpen: () => open };
}
