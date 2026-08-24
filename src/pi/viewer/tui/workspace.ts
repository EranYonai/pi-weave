/**
 * workspace.ts — the pure split-tree workspace model (weave-view-tui-v2 §4).
 *
 * A workspace is a recursive tree of splits (HStack rows / VStack columns)
 * and panes. Each pane is a surface instance with its own selection/scroll/
 * filter state (held by the pane component, not here); this module models the
 * *structure* only: the split tree, pane ids, per-pane surface + bound node,
 * focus (active pane), resize weights, and responsive collapse.
 *
 * This layer is harness-free (imports only core types) so every operation is
 * unit-tested without a terminal — mirroring v1's model.ts posture (§11).
 */

import type { GraphModel } from "../../../core/graph/model";
import { graphRoots } from "./model";

/** The four surface kinds a pane can host. */
export type SurfaceKind = "explore" | "detail" | "focus" | "health";

export interface PaneNode {
  type: "pane";
  /** Stable pane id. */
  id: string;
  surface: SurfaceKind;
  /** Node id bound for detail/focus panes; null until opened. */
  nodeId: string | null;
}

/** Split direction. `row` → HStack (side-by-side); `column` → VStack (stacked). */
export type SplitDir = "row" | "column";

export interface SplitNode {
  type: "split";
  direction: SplitDir;
  /** Flex weights per child (drives the pi-tui Stack grow values). */
  sizes: number[];
  children: WorkspaceNode[];
}

export type WorkspaceNode = PaneNode | SplitNode;

export interface Workspace {
  name: string;
  root: WorkspaceNode;
  /** The single active (focus-owning) pane id. */
  activePaneId: string;
}

/** Axis a resize/move direction acts on. */
export type Axis = "row" | "column";

/** Split direction a `\`/`|` command produces. */
export type SplitRequest = "vertical" | "horizontal";

let nextPaneId = 1;
/** Fresh, collision-free pane id (test seam resets via resetWorkspaceIds). */
export function newPaneId(): string {
  return `pane${nextPaneId++}`;
}
export function resetWorkspaceIds(): void {
  nextPaneId = 1;
}

export function paneNode(surface: SurfaceKind, nodeId: string | null = null): PaneNode {
  return { type: "pane", id: newPaneId(), surface, nodeId };
}

export function splitNode(direction: SplitDir, children: WorkspaceNode[], sizes?: number[]): SplitNode {
  const s = sizes ?? children.map(() => 1);
  return { type: "split", direction, children, sizes: s.length === children.length ? s : children.map(() => 1) };
}

// ---------------------------------------------------------------------------
// Navigation / collection
// ---------------------------------------------------------------------------

/** All panes in layout (render) order — the focus-cycle order. */
export function collectPanes(node: WorkspaceNode): PaneNode[] {
  if (node.type === "pane") return [node];
  const out: PaneNode[] = [];
  for (const c of node.children) out.push(...collectPanes(c));
  return out;
}

export function workspacePanes(ws: Workspace): PaneNode[] {
  return collectPanes(ws.root);
}

export function findPane(node: WorkspaceNode, id: string): PaneNode | null {
  if (node.type === "pane") return node.id === id ? node : null;
  for (const c of node.children) {
    const found = findPane(c, id);
    if (found) return found;
  }
  return null;
}

export function countPanes(ws: Workspace): number {
  return workspacePanes(ws).length;
}

/** Cycle the active pane in layout order; `dir` is +1 (next) or -1 (prev). */
export function focusNext(ws: Workspace, dir: 1 | -1): Workspace {
  const panes = workspacePanes(ws);
  if (panes.length <= 1) return ws;
  const idx = panes.findIndex((p) => p.id === ws.activePaneId);
  const next = panes[(idx + dir + panes.length) % panes.length];
  if (!next) return ws;
  return { ...ws, activePaneId: next.id };
}

// ---------------------------------------------------------------------------
// Split / close / swap
// ---------------------------------------------------------------------------

/**
 * Split a pane in place, producing `dir`:
 * - "vertical" → a column split (new pane below the original).
 * - "horizontal" → a row split (new pane to the right of the original).
 * The new pane is created with the same surface and empty selection, and
 * becomes active. Returns the new workspace.
 */
export function split(ws: Workspace, id: string, dir: SplitRequest, surface: SurfaceKind = "explore"): Workspace {
  const parent = findParent(ws.root, id);
  const holder = parent?.children ?? [ws.root];
  const idx = holder.findIndex((c) => c.type === "pane" && c.id === id);
  if (idx < 0) return ws;
  const target = holder[idx] as PaneNode;

  const fresh = paneNode(surface);
  const newSplit = splitNode(
    dir === "vertical" ? "column" : "row",
    [target, fresh],
    [1, 1],
  );

  if (!parent) {
    return { ...ws, root: newSplit, activePaneId: fresh.id };
  }
  const children = parent.children.slice();
  children[idx] = newSplit;
  const nextRoot = replaceChild(ws.root, parent, children);
  return { ...ws, root: nextRoot, activePaneId: fresh.id };
}

/** Swap two panes' surface + bound node within a split (the `move` command). */
export function movePane(ws: Workspace, id: string, dir: Axis): Workspace {
  const parent = findParent(ws.root, id);
  if (!parent || parent.direction !== dir) return ws;
  const idx = parent.children.findIndex((c) => c.type === "pane" && c.id === id);
  if (idx < 0) return ws;
  // swap with the adjacent pane (right sibling if present, else left)
  const neighborIdx = parent.children[idx + 1] ? idx + 1 : idx - 1;
  const neighbor = neighborIdx !== undefined ? parent.children[neighborIdx] : undefined;
  if (neighbor === undefined || neighbor.type !== "pane") return ws;
  const children = parent.children.slice();
  const a = children[idx] as PaneNode;
  const b = neighbor;
  children[idx] = { ...a, surface: b.surface, nodeId: b.nodeId };
  children[neighborIdx] = { ...b, surface: a.surface, nodeId: a.nodeId };
  return { ...ws, root: replaceChild(ws.root, parent, children) };
}

/**
 * Close the active pane. If it was the last pane, keep one empty pane (don't
 * quit). The focus moves to the pane that replaced it (nearest neighbor).
 */
export function close(ws: Workspace, id: string): Workspace {
  const parent = findParent(ws.root, id);
  if (!parent) {
    // single-pane root or id not present: keep one empty pane (don't quit)
    if (ws.root.type === "pane") {
      return {
        ...ws,
        root: paneNode("explore"),
        activePaneId: newPaneId(),
      };
    }
    return ws; // id not found
  }
  const idx = parent.children.findIndex((c) => c.type === "pane" && c.id === id);
  if (idx < 0) return ws;
  const children = parent.children.slice();
  children.splice(idx, 1);
  const nextRoot = collapseEmptySplits(replaceChild(ws.root, parent, children));
  const panes = collectPanes(nextRoot);
  const nextActive = panes[Math.min(idx, panes.length - 1)]?.id ?? newPaneId();
  return { ...ws, root: nextRoot, activePaneId: nextActive };
}

/** Remove a split node that has a single child, unwrapping it (fixes close). */
export function collapseEmptySplits(node: WorkspaceNode): WorkspaceNode {
  if (node.type === "pane") return node;
  const children = node.children.map(collapseEmptySplits);
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

/** Set a pane's surface in place (the e/d/f/h surface swap). */
export function setPaneSurface(ws: Workspace, id: string, surface: SurfaceKind): Workspace {
  return { ...ws, root: setPaneNodeSurface(ws.root, id, surface) };
}

function setPaneNodeSurface(node: WorkspaceNode, id: string, surface: SurfaceKind): WorkspaceNode {
  if (node.type === "pane") return node.id === id ? { ...node, surface } : node;
  return { ...node, children: node.children.map((c) => setPaneNodeSurface(c, id, surface)) };
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

/**
 * Resize the active pane along `axis` by `delta` weight units, adjusting it
 * against its sibling within the nearest split on that axis. Weights are
 * clamped to [1, 100]. Returns the same workspace when there is no sibling on
 * the axis.
 */
export function resize(ws: Workspace, id: string, axis: Axis, delta: number): Workspace {
  const parent = findParent(ws.root, id);
  if (!parent || parent.direction !== axis) return ws;
  const idx = parent.children.findIndex((c) => c.type === "pane" && c.id === id);
  if (idx < 0) return ws;
  // neighbor to adjust: shrink/grow against the next sibling if present, else prev
  const neighborIdx: number | undefined = parent.children[idx + 1] ? idx + 1 : parent.children[idx - 1] ? idx - 1 : undefined;
  if (neighborIdx === undefined) return ws;
  const sizes = parent.sizes.slice();
  const cur = sizes[idx] ?? 1;
  const nbr = sizes[neighborIdx] ?? 1;
  const d = Math.sign(delta) * Math.min(3, Math.abs(delta));
  const nextCur = Math.max(1, Math.min(100, cur + d));
  const nextNbr = Math.max(1, Math.min(100, nbr - d));
  sizes[idx] = nextCur;
  sizes[neighborIdx] = nextNbr;
  const next: SplitNode = { ...parent, sizes };
  return { ...ws, root: replaceNode(ws.root, parent, next) };
}

// ---------------------------------------------------------------------------
// Default workspaces (ship 3, decision 6: Explore is the first-run default)
// ---------------------------------------------------------------------------

/** The default first-run workspace: Explore 40/60. */
export function defaultWorkspace(model: GraphModel, name = "Explore"): Workspace {
  const roots = graphRoots(model);
  const explore = paneNode("explore", roots[0] ?? null);
  const detail = paneNode("detail", null);
  const root = splitNode("row", [explore, detail], [40, 60]);
  return { name, root, activePaneId: explore.id };
}

/** Triple: Explore 30 / Detail 40 / Focus 30 — walk the graph while reading. */
export function tripleWorkspace(name = "Triple"): Workspace {
  const explore = paneNode("explore");
  const detail = paneNode("detail");
  const focus = paneNode("focus");
  const root = splitNode("row", [explore, detail, focus], [30, 40, 30]);
  return { name, root, activePaneId: explore.id };
}

/** Wide: dashboard on top, reading below. */
export function wideWorkspace(name = "Wide"): Workspace {
  const explore = paneNode("explore");
  const health = paneNode("health");
  const detail = paneNode("detail");
  const top = splitNode("row", [explore, health], [50, 50]);
  const root = splitNode("column", [top, detail], [40, 60]);
  return { name, root, activePaneId: explore.id };
}

/** All three named defaults. */
export function defaultWorkspaces(model: GraphModel): Workspace[] {
  return [defaultWorkspace(model), tripleWorkspace(), wideWorkspace()];
}

// ---------------------------------------------------------------------------
// Responsive collapse (design §9.2)
// ---------------------------------------------------------------------------

/**
 * Collapse the workspace to fit a terminal width:
 * - ≥ 110: unchanged.
 * - 80–109: at most one column split — collapse any column split nested inside
 *   another split down to its first child pane.
 * - < 80: single visible pane (the active one); the component shows the others
 *   as a one-line tab bar (decision 5).
 */
export function collapseForWidth(ws: Workspace, width: number): Workspace {
  if (width >= 110) return ws;
  if (width < 80) {
    const active = findPane(ws.root, ws.activePaneId);
    const single = active ? { ...active, nodeId: active.nodeId } : paneNode("explore");
    return { ...ws, root: single, activePaneId: single.id };
  }
  return { ...ws, root: collapseNestedColumns(ws.root) };
}

/** Flatten a column split nested directly under another column split to its first pane. */
export function collapseNestedColumns(node: WorkspaceNode, insideColumn = false): WorkspaceNode {
  if (node.type === "pane") return node;
  const wasColumn = node.direction === "column";
  const children = node.children.map((c) => collapseNestedColumns(c, wasColumn));
  if (node.direction === "column" && insideColumn && children.length > 1) {
    return children[0] ?? node;
  }
  return { ...node, children };
}

// ---------------------------------------------------------------------------
// Serialize / deserialize (persistence shape; the component adds the vault IO)
// ---------------------------------------------------------------------------

export interface SerializedWorkspace {
  name: string;
  activePaneId: string;
  root: SerializedNode;
}
export type SerializedNode = { t: "pane"; id: string; s: SurfaceKind; n: string | null } | { t: "split"; d: SplitDir; sizes: number[]; c: SerializedNode[] };

export function serialize(ws: Workspace): SerializedWorkspace {
  return { name: ws.name, activePaneId: ws.activePaneId, root: serializeNode(ws.root) };
}

function serializeNode(node: WorkspaceNode): SerializedNode {
  if (node.type === "pane") return { t: "pane", id: node.id, s: node.surface, n: node.nodeId };
  return { t: "split", d: node.direction, sizes: node.sizes, c: node.children.map(serializeNode) };
}

/** Deserialize a serialized workspace; degrades to a fresh Explore on bad shape. */
export function deserialize(json: SerializedWorkspace | null, fallback: Workspace): Workspace {
  if (!json || typeof json.name !== "string") return fallback;
  const root = deserializeNode(json.root);
  if (!root) return fallback;
  const active = findPane(root, json.activePaneId);
  return {
    name: json.name,
    root,
    activePaneId: active ? active.id : workspacePanes({ name: json.name, root, activePaneId: json.activePaneId })[0]?.id ?? newPaneId(),
  };
}

function deserializeNode(node: SerializedNode | undefined): WorkspaceNode | null {
  if (!node) return null;
  if (node.t === "pane") return { type: "pane", id: node.id || newPaneId(), surface: node.s, nodeId: node.n ?? null };
  if (node.t === "split") {
    const children = (node.c ?? []).map(deserializeNode).filter((c): c is WorkspaceNode => c !== null);
    if (children.length === 0) return null;
    return { type: "split", direction: node.d, sizes: node.sizes ?? children.map(() => 1), children };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the split node directly containing pane `id`, or null if root. */
function findParent(node: WorkspaceNode, id: string): SplitNode | null {
  if (node.type === "pane") return null;
  for (const c of node.children) {
    if (c.type === "pane" && c.id === id) return node;
  }
  for (const c of node.children) {
    const found = c.type === "split" ? findParent(c, id) : null;
    if (found) return found;
  }
  return null;
}

/** Replace `parent` (by reference identity within a node tree) with a new split. */
function replaceChild(root: WorkspaceNode, parent: SplitNode, children: WorkspaceNode[]): WorkspaceNode {
  const next: SplitNode = { ...parent, children };
  return replaceNode(root, parent, next);
}

/** Swap one node reference for another within a tree (structural copy). */
function replaceNode(root: WorkspaceNode, target: SplitNode, replacement: SplitNode): WorkspaceNode {
  if (root === target) return replacement;
  if (root.type === "pane") return root;
  return { ...root, children: root.children.map((c) => replaceNode(c, target, replacement)) };
}
