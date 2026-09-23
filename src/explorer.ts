import { invoke } from "@tauri-apps/api/core";
import { clearHints, resolveDrop, setHint, type DropRegion } from "./terminals";
import { copyText } from "./clipboard";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Windows paths are case-insensitive with mixed separators; normalize before comparing. */
function normalize(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function baseName(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx < 0 ? norm : norm.slice(idx + 1) || norm;
}

function dirName(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx < 0 ? "" : norm.slice(0, idx);
}

/** Wraps a path in double quotes (escaping embedded quotes) if it needs it to
 *  survive being typed as one argument into PowerShell/cmd — i.e. it contains
 *  whitespace or a shell metacharacter. */
export function quotePathForShell(path: string): string {
  return /[\s"()&|<>^]/.test(path) ? `"${path.replace(/"/g, '""')}"` : path;
}

const CHEVRON_ICON =
  '<svg viewBox="0 0 16 16" width="10" height="10"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M5 2.5 11 8l-6 5.5"/></svg>';
const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.3 1.5H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12v-8.5z"/></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="1.1" d="M4 1.5h5.5L12.5 4.5V14.5H4z"/><path fill="none" stroke="currentColor" stroke-width="1.1" d="M9.5 1.5V4.5H12.5"/></svg>';

/** Per-extension monogram badges, styled after editors that show a colored
 *  glyph in place of a full icon font for each file type. */
const EXT_BADGES: Record<string, { label: string; color: string }> = {
  ts: { label: "TS", color: "#4fa8da" },
  tsx: { label: "TSX", color: "#4fa8da" },
  js: { label: "JS", color: "#e8c268" },
  jsx: { label: "JSX", color: "#e8c268" },
  mjs: { label: "JS", color: "#e8c268" },
  cjs: { label: "JS", color: "#e8c268" },
  json: { label: "{}", color: "#c9a86a" },
  jsonc: { label: "{}", color: "#c9a86a" },
  css: { label: "#", color: "#5aa6e0" },
  scss: { label: "#", color: "#d47fc9" },
  less: { label: "#", color: "#d47fc9" },
  html: { label: "<>", color: "#e0784f" },
  htm: { label: "<>", color: "#e0784f" },
  md: { label: "M↓", color: "#8ba0c9" },
  rs: { label: "RS", color: "#dea584" },
  py: { label: "PY", color: "#5aa6e0" },
  toml: { label: "TML", color: "#9aa5b1" },
  yml: { label: "YML", color: "#9aa5b1" },
  yaml: { label: "YML", color: "#9aa5b1" },
  sh: { label: "SH", color: "#7bc27b" },
  bash: { label: "SH", color: "#7bc27b" },
  ps1: { label: "PS1", color: "#5aa6e0" },
  psm1: { label: "PS1", color: "#5aa6e0" },
  sql: { label: "SQL", color: "#e07f9a" },
  go: { label: "GO", color: "#5ac8c8" },
  java: { label: "JV", color: "#e0784f" },
  c: { label: "C", color: "#5aa6e0" },
  h: { label: "H", color: "#9aa5b1" },
  cpp: { label: "C++", color: "#5aa6e0" },
  hpp: { label: "H++", color: "#9aa5b1" },
  cs: { label: "C#", color: "#8bc272" },
  rb: { label: "RB", color: "#e06c75" },
  php: { label: "PHP", color: "#8ba0c9" },
  xml: { label: "XML", color: "#e0784f" },
  txt: { label: "TXT", color: "#9aa5b1" },
  lock: { label: "LCK", color: "#9aa5b1" },
  env: { label: "ENV", color: "#9aa5b1" },
  vue: { label: "VUE", color: "#7bc27b" },
  svelte: { label: "SV", color: "#e0784f" },
};

function extBadge(name: string): { label: string; color: string } | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_BADGES[name.slice(dot + 1).toLowerCase()] ?? null;
}

function iconMarkup(entry: FileEntry): string {
  if (entry.is_dir) return `<span class="tree-icon">${FOLDER_ICON}</span>`;
  const badge = extBadge(entry.name);
  if (badge) return `<span class="tree-icon tree-badge" style="color:${badge.color}">${badge.label}</span>`;
  return `<span class="tree-icon">${FILE_ICON}</span>`;
}

export interface ExplorerHandlers {
  onOpenFile(path: string, name: string): void;
  /** A file (or folder) row was dragged onto a terminal pane and dropped there. */
  onDropToPane(path: string, name: string, paneId: string): void;
  /** Ctrl+Alt+drag of a file row: open it as a docked file *pane* in the grid,
   *  split off `paneId` along `region`, instead of typing its path into stdin. */
  onDockToPane(
    path: string,
    name: string,
    paneId: string,
    region: DropRegion,
    at: { x: number; y: number }
  ): void;
  /** Ask the user to confirm a delete before it's sent to the Recycle Bin. */
  onConfirmDelete(name: string, isDir: boolean): Promise<boolean>;
}

interface TreeNode {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  /** null = children not fetched yet (fetched lazily the first time it's expanded). */
  children: TreeNode[] | null;
}

function makeNode(entry: FileEntry, depth: number): TreeNode {
  return { entry, depth, expanded: false, loading: false, children: null };
}

/** Pointer-based drag from a tree row onto a terminal pane (HTML5 drag/drop
 *  doesn't fire reliably over the WebView2 + xterm canvas stack — see the pane
 *  move-drag in terminals.ts, which uses the same approach). A plain click
 *  (no pointer movement past the threshold) still runs `activate`. */
function bindDrag(
  row: HTMLElement,
  entry: FileEntry,
  activate: () => void,
  handlers: ExplorerHandlers
): void {
  row.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let targetEl: HTMLElement | null = null;
    let finished = false;
    // Two destinations for the same gesture, told apart by Ctrl+Alt:
    //   drag            -> type the path into that pane's stdin (unchanged)
    //   Ctrl+Alt+drag   -> dock the file itself as a pane in the grid
    // Alt alone deliberately stays path mode, so the existing muscle memory of
    // Alt+dragging a path into an agent is untouched. Folders can't be docked
    // (there is nothing to open), so they ignore the modifier entirely.
    const canDock = !entry.is_dir;
    let dockMode = canDock && e.altKey && e.ctrlKey;
    let region: DropRegion | null = null;
    let lastX = e.clientX;
    let lastY = e.clientY;

    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      try {
        if (row.hasPointerCapture(pointerId)) row.releasePointerCapture(pointerId);
      } catch {
        /* capture may already be gone */
      }
      if (!dragging) {
        if (commit) activate();
        return;
      }
      document.body.classList.remove("dragging-file", "dragging-file-dock");
      window.removeEventListener("keydown", onModifier, true);
      window.removeEventListener("keyup", onModifier, true);
      const ghostRect = ghost?.getBoundingClientRect();
      ghost?.remove();
      ghost = null;
      targetEl?.classList.remove("file-drop-target");
      clearHints();
      if (commit && targetEl?.dataset.paneId) {
        if (dockMode && region) {
          handlers.onDockToPane(entry.path, entry.name, targetEl.dataset.paneId, region, {
            x: ghostRect ? ghostRect.left + ghostRect.width / 2 : lastX,
            y: ghostRect ? ghostRect.top + ghostRect.height / 2 : lastY,
          });
        } else if (!dockMode) {
          handlers.onDropToPane(entry.path, entry.name, targetEl.dataset.paneId);
        }
      }
      targetEl = null;
    };

    /** Alt/Ctrl can be pressed or released mid-drag, so the mode (and the
     *  targeting that goes with it) is re-resolved from the last pointer
     *  position rather than frozen at pointerdown. */
    const onModifier = (ev: KeyboardEvent) => {
      if (!dragging) return;
      // Keep Alt from reaching the webview's menu-focus handling mid-drag —
      // it would steal focus and strand the gesture.
      if (ev.key === "Alt") ev.preventDefault();
      const next = canDock && ev.altKey && ev.ctrlKey;
      if (next === dockMode) return;
      dockMode = next;
      retarget(lastX, lastY);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        try {
          row.setPointerCapture(pointerId);
        } catch {
          /* best-effort; window listeners are the real guarantee */
        }
        document.body.classList.add("dragging-file");
        ghost = document.createElement("div");
        ghost.className = "file-drag-ghost";
        ghost.innerHTML = iconMarkup(entry) + `<span></span>`;
        ghost.querySelector("span:last-child")!.textContent = entry.name;
        document.body.appendChild(ghost);
        window.addEventListener("keydown", onModifier, true);
        window.addEventListener("keyup", onModifier, true);
      }
      ghost!.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
      lastX = ev.clientX;
      lastY = ev.clientY;
      dockMode = canDock && ev.altKey && ev.ctrlKey;
      retarget(ev.clientX, ev.clientY);
    };

    /** Paints the drop feedback for whichever mode is active: a whole-pane
     *  highlight for a path drop (the pane is the target), or the pane-move
     *  edge hints for a dock (the *region* picks where the new pane lands). */
    const retarget = (x: number, y: number): void => {
      if (!ghost) return;
      ghost.classList.toggle("dock", dockMode);
      const label = ghost.querySelector<HTMLElement>("span:last-child");
      if (label) label.textContent = dockMode ? `Open as pane: ${entry.name}` : entry.name;
      document.body.classList.toggle("dragging-file-dock", dockMode);

      if (dockMode) {
        targetEl?.classList.remove("file-drop-target");
        // Any pane can be split against — even a browser or a docked external
        // window, since this only inserts a sibling beside it.
        const hit = resolveDrop(x, y, "", false, (el: HTMLElement) => !!el.dataset.paneId);
        if (targetEl && targetEl !== hit?.el) clearHints();
        if (!hit) clearHints();
        targetEl = hit?.el ?? null;
        region = hit?.region ?? null;
        if (hit) setHint(hit.el, hit.hint);
        ghost.classList.toggle("armed", !!hit);
        return;
      }

      clearHints();
      region = null;
      ghost.classList.remove("armed");
      // Only in-app terminal panes (not embedded external windows) are valid drop
      // targets: an external pane has no PTY here to write the path into.
      const under = document.elementFromPoint(x, y)?.closest<HTMLElement>(".pane");
      const next = under && under.dataset.external !== "1" && under.dataset.paneId ? under : null;
      if (targetEl !== next) {
        targetEl?.classList.remove("file-drop-target");
        next?.classList.add("file-drop-target");
        targetEl = next;
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      finish(ev.type === "pointerup");
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

/** Sidebar file browser: a collapsible tree (in the spirit of VS Code's explorer),
 *  locked to a root folder, with a live filename filter and drag-to-terminal
 *  support. Folders lazy-load their children the first time they're expanded. */
export function createExplorer(handlers: ExplorerHandlers) {
  const el = document.createElement("div");
  el.className = "explorer";

  const head = document.createElement("div");
  head.className = "explorer-head";
  const rootLabel = document.createElement("span");
  rootLabel.className = "explorer-root";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "explorer-refresh";
  refreshBtn.title = "Refresh";
  refreshBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M13 8A5 5 0 1 1 11.3 4.3M13 2v3.3h-3.3"/></svg>';
  head.append(rootLabel, refreshBtn);

  const searchWrap = document.createElement("div");
  searchWrap.className = "explorer-search";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Filter files…";
  searchWrap.appendChild(searchInput);

  const list = document.createElement("div");
  list.className = "explorer-list";

  const status = document.createElement("div");
  status.className = "explorer-status";

  el.append(head, searchWrap, list, status);

  let rootPath: string | null = null;
  let rootNodes: TreeNode[] = [];
  let filter = "";
  let selectedPath: string | null = null;
  let loadError: string | null = null;
  let renamingPath: string | null = null;

  // Right-click menu for a tree row (Open in Explorer / Copy Path / Rename /
  // Delete) — one shared instance, repositioned and re-targeted on open.
  const ctxMenu = document.createElement("div");
  ctxMenu.className = "context-menu";
  const ctxReveal = document.createElement("button");
  ctxReveal.className = "context-menu-item";
  ctxReveal.textContent = "Open in Explorer";
  const ctxCopy = document.createElement("button");
  ctxCopy.className = "context-menu-item";
  ctxCopy.textContent = "Copy Path";
  const ctxRename = document.createElement("button");
  ctxRename.className = "context-menu-item";
  ctxRename.textContent = "Rename";
  const ctxDelete = document.createElement("button");
  ctxDelete.className = "context-menu-item danger";
  ctxDelete.textContent = "Delete";
  ctxMenu.append(ctxReveal, ctxCopy, ctxRename, ctxDelete);
  document.body.appendChild(ctxMenu);

  let ctxNode: TreeNode | null = null;

  function closeCtxMenu(): void {
    ctxNode = null;
    ctxMenu.classList.remove("visible");
  }

  function openCtxMenu(node: TreeNode, x: number, y: number): void {
    ctxNode = node;
    ctxMenu.style.top = `${y}px`;
    ctxMenu.style.left = `${x}px`;
    ctxMenu.classList.add("visible");
    const r = ctxMenu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) ctxMenu.style.left = `${x - r.width}px`;
    if (r.bottom > window.innerHeight - 8) ctxMenu.style.top = `${y - r.height}px`;
  }

  ctxReveal.addEventListener("click", () => {
    const node = ctxNode;
    closeCtxMenu();
    if (node) void invoke("reveal_in_explorer", { path: node.entry.path });
  });
  ctxCopy.addEventListener("click", () => {
    const node = ctxNode;
    closeCtxMenu();
    if (node) void copyText(node.entry.path);
  });
  ctxRename.addEventListener("click", () => {
    const node = ctxNode;
    closeCtxMenu();
    if (node) {
      renamingPath = node.entry.path;
      render();
    }
  });
  ctxDelete.addEventListener("click", () => {
    const node = ctxNode;
    closeCtxMenu();
    if (node) void deletePath(node);
  });
  document.addEventListener("pointerdown", (e) => {
    if (ctxNode && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
  });
  window.addEventListener("resize", closeCtxMenu);
  window.addEventListener("blur", closeCtxMenu);

  /** Finds the array a node lives in (root list, or some ancestor's loaded
   *  children) so it can be spliced out after a delete. */
  function findContainer(nodes: TreeNode[], path: string): { arr: TreeNode[]; index: number } | null {
    for (let i = 0; i < nodes.length; i++) {
      if (normalize(nodes[i].entry.path) === normalize(path)) return { arr: nodes, index: i };
      if (nodes[i].children) {
        const found = findContainer(nodes[i].children!, path);
        if (found) return found;
      }
    }
    return null;
  }

  async function deletePath(node: TreeNode): Promise<void> {
    const ok = await handlers.onConfirmDelete(node.entry.name, node.entry.is_dir);
    if (!ok) return;
    try {
      await invoke("delete_path", { path: node.entry.path });
    } catch (e) {
      loadError = String(e);
      render();
      return;
    }
    const found = findContainer(rootNodes, node.entry.path);
    if (found) found.arr.splice(found.index, 1);
    if (selectedPath && normalize(selectedPath) === normalize(node.entry.path)) selectedPath = null;
    render();
  }

  async function commitRename(node: TreeNode, newName: string): Promise<void> {
    renamingPath = null;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === node.entry.name) {
      render();
      return;
    }
    const dir = dirName(node.entry.path);
    const sep = node.entry.path.includes("\\") ? "\\" : "/";
    const newPath = dir ? `${dir}${sep}${trimmed}` : trimmed;
    try {
      await invoke("rename_path", { from: node.entry.path, to: newPath });
    } catch (e) {
      loadError = String(e);
      render();
      return;
    }
    const wasSelected = selectedPath !== null && normalize(selectedPath) === normalize(node.entry.path);
    node.entry.name = trimmed;
    node.entry.path = newPath;
    if (node.entry.is_dir) {
      // Any loaded children now hold stale paths under the old directory name.
      node.children = null;
      node.expanded = false;
    }
    if (wasSelected) selectedPath = newPath;
    render();
  }

  /** Filters each expanded level independently (same rule the old single-level
   *  browser used) — a non-matching folder simply isn't descended into. */
  function flatten(nodes: TreeNode[], q: string): TreeNode[] {
    const acc: TreeNode[] = [];
    for (const n of nodes) {
      if (q && !n.entry.name.toLowerCase().includes(q)) continue;
      acc.push(n);
      if (n.expanded && n.children) acc.push(...flatten(n.children, q));
    }
    return acc;
  }

  function buildRow(node: TreeNode): HTMLElement {
    const { entry } = node;
    const row = document.createElement("div");
    row.className = "tree-row";
    row.classList.toggle("dir", entry.is_dir);
    row.classList.toggle("expanded", node.expanded);
    row.classList.toggle(
      "selected",
      !entry.is_dir && selectedPath !== null && normalize(entry.path) === normalize(selectedPath)
    );
    row.style.paddingLeft = `${6 + node.depth * 16}px`;
    row.title = entry.path;

    if (renamingPath !== null && normalize(entry.path) === normalize(renamingPath)) {
      row.innerHTML = `<span class="tree-chevron">${entry.is_dir ? CHEVRON_ICON : ""}</span>` + iconMarkup(entry);
      const input = document.createElement("input");
      input.className = "rename-input";
      input.value = entry.name;
      const commit = () => void commitRename(node, input.value);
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          renamingPath = null;
          render();
        }
      });
      input.addEventListener("blur", commit);
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
      row.appendChild(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      return row;
    }

    row.innerHTML =
      `<span class="tree-chevron">${entry.is_dir ? CHEVRON_ICON : ""}</span>` +
      iconMarkup(entry) +
      `<span class="tree-name"></span>` +
      (node.loading ? `<span class="tree-loading">⋯</span>` : "");
    row.querySelector(".tree-name")!.textContent = entry.name;

    const activate = () => {
      if (entry.is_dir) {
        void toggle(node);
      } else {
        selectedPath = entry.path;
        handlers.onOpenFile(entry.path, entry.name);
        render();
      }
    };
    bindDrag(row, entry, activate, handlers);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(node, e.clientX, e.clientY);
    });
    return row;
  }

  function render(): void {
    const q = filter.trim().toLowerCase();
    const rows = flatten(rootNodes, q);
    list.replaceChildren(...rows.map(buildRow));
    if (loadError) status.textContent = loadError;
    else status.textContent = rows.length === 0 ? (q ? "No matches" : rootPath ? "Empty folder" : "") : "";
  }

  async function toggle(node: TreeNode): Promise<void> {
    if (node.expanded) {
      node.expanded = false;
      render();
      return;
    }
    node.expanded = true;
    if (node.children === null) {
      node.loading = true;
      render();
      try {
        const listing = await invoke<{ path: string; entries: FileEntry[] }>("list_dir", {
          path: node.entry.path,
        });
        node.children = listing.entries.map((e) => makeNode(e, node.depth + 1));
      } catch {
        node.children = []; // e.g. permission denied — show it as simply empty
      }
      node.loading = false;
    }
    render();
  }

  async function loadRoot(path: string | null): Promise<void> {
    loadError = null;
    render();
    try {
      const listing = await invoke<{ path: string; entries: FileEntry[] }>("list_dir", { path });
      rootPath = listing.path;
      rootNodes = listing.entries.map((e) => makeNode(e, 0));
      rootLabel.textContent = baseName(rootPath) || rootPath;
      rootLabel.title = rootPath;
    } catch (e) {
      loadError = String(e);
      rootNodes = [];
    }
    render();
  }

  refreshBtn.addEventListener("click", () => void loadRoot(rootPath));

  searchInput.addEventListener("input", () => {
    filter = searchInput.value;
    render();
  });

  /** (Re)opens the browser rooted at the given folder (or the user's home dir),
   *  resetting the navigation boundary and any expanded state. */
  function open(initialPath: string | null): void {
    rootPath = null;
    rootNodes = [];
    selectedPath = null;
    filter = "";
    searchInput.value = "";
    void loadRoot(initialPath);
  }

  return { el, open };
}
