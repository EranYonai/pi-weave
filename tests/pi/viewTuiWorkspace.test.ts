import { beforeEach, describe, expect, it } from "vitest";
import {
  close,
  collapseForWidth,
  collapseNestedColumns,
  collectPanes,
  defaultWorkspace,
  defaultWorkspaces,
  deserialize,
  findPane,
  focusNext,
  movePane,
  newPaneId,
  resize,
  resetWorkspaceIds,
  serialize,
  split,
  tripleWorkspace,
  wideWorkspace,
  workspacePanes,
  type Workspace,
} from "../../src/pi/viewer/tui/workspace";
import type { GraphModel } from "../../src/core/graph/model";
import type { WorkspaceNode } from "../../src/pi/viewer/tui/workspace";

function bindNodeId(node: WorkspaceNode, paneId: string | undefined, nodeId: string): WorkspaceNode {
  if (node.type === "pane") return node.id === paneId ? { ...node, nodeId } : node;
  return { ...node, children: node.children.map((c) => bindNodeId(c, paneId, nodeId)) };
}

function graph(): GraphModel {
  return { generatedAt: "2026-06-01T00:00:00.000Z", staleness: null, nodes: [], edges: [] };
}

beforeEach(() => resetWorkspaceIds());

describe("default workspaces", () => {
  it("defaultWorkspace builds the Explore 40/60 split with the first root selected", () => {
    const ws = defaultWorkspace(graph());
    expect(ws.name).toBe("Explore");
    expect(ws.root.type).toBe("split");
    if (ws.root.type === "split") {
      expect(ws.root.direction).toBe("row");
      expect(ws.root.sizes).toEqual([40, 60]);
      expect(ws.root.children).toHaveLength(2);
    }
    expect(ws.activePaneId).toBe(workspacePanes(ws)[0]?.id);
  });
  it("triple/wide build the expected shapes", () => {
    const t = tripleWorkspace();
    expect(workspacePanes(t).map((p) => p.surface)).toEqual(["explore", "detail", "focus"]);
    const w = wideWorkspace();
    expect(workspacePanes(w).map((p) => p.surface)).toEqual(["explore", "health", "detail"]);
  });
  it("defaultWorkspaces returns Explore, Triple, Wide", () => {
    expect(defaultWorkspaces(graph()).map((w) => w.name)).toEqual(["Explore", "Triple", "Wide"]);
  });
});

describe("split", () => {
  it("horizontal split puts a new pane to the right and makes it active", () => {
    let ws = defaultWorkspace(graph());
    const first = workspacePanes(ws)[0]!.id;
    const firstActive = ws.activePaneId;
    ws = split(ws, firstActive, "horizontal");
    const panes = workspacePanes(ws);
    expect(panes).toHaveLength(3);
    expect(ws.activePaneId).not.toBe(firstActive);
    const root = ws.root;
    if (root.type === "split") {
      expect(root.direction).toBe("row");
      expect(root.children).toHaveLength(2);
      // the first child is now a row split containing the original pane + new pane
      const firstChild = root.children[0];
      if (firstChild && firstChild.type === "split") {
        expect(firstChild.direction).toBe("row");
        expect(collectPanes(firstChild).map((p) => p.id)).toContain(first);
      }
    }
  });
  it("vertical split stacks a new pane below", () => {
    let ws = defaultWorkspace(graph());
    const id = ws.activePaneId;
    ws = split(ws, id, "vertical");
    const root = ws.root;
    if (root.type === "split") {
      const firstChild = root.children[0];
      if (firstChild && firstChild.type === "split") {
        expect(firstChild.direction).toBe("column");
      }
    }
  });
  it("split on a non-existent pane returns the workspace unchanged", () => {
    const ws = defaultWorkspace(graph());
    const next = split(ws, "nope", "horizontal");
    expect(next).toBe(ws);
  });
});

describe("close", () => {
  it("closing a pane in a 2-pane split leaves one pane", () => {
    let ws = defaultWorkspace(graph());
    const active = ws.activePaneId;
    ws = close(ws, active);
    expect(workspacePanes(ws)).toHaveLength(1);
    expect(ws.root.type).toBe("pane");
  });
  it("closing the only pane keeps one empty pane (doesn't quit)", () => {
    const ws: Workspace = { name: "x", root: { type: "pane", id: "p1", surface: "explore", nodeId: null }, activePaneId: "p1" };
    const next = close(ws, "p1");
    expect(workspacePanes(next)).toHaveLength(1);
  });
  it("closing a non-existent pane is a no-op", () => {
    const ws = defaultWorkspace(graph());
    expect(close(ws, "nope")).toBe(ws);
  });
});

describe("focusNext", () => {
  it("cycles active pane in layout order", () => {
    let ws = tripleWorkspace();
    const [a, b, c] = workspacePanes(ws).map((p) => p.id);
    expect(ws.activePaneId).toBe(a);
    ws = focusNext(ws, 1);
    expect(ws.activePaneId).toBe(b);
    ws = focusNext(ws, 1);
    expect(ws.activePaneId).toBe(c);
    ws = focusNext(ws, 1);
    expect(ws.activePaneId).toBe(a);
    ws = focusNext(ws, -1);
    expect(ws.activePaneId).toBe(c);
  });
  it("single pane does not change focus", () => {
    const ws: Workspace = { name: "x", root: { type: "pane", id: "p1", surface: "explore", nodeId: null }, activePaneId: "p1" };
    expect(focusNext(ws, 1)).toBe(ws);
  });
});

describe("movePane", () => {
  it("swaps surfaces between adjacent panes on the matching axis", () => {
    let ws = tripleWorkspace();
    const [a, b] = workspacePanes(ws);
    ws = movePane(ws, a!.id, "row");
    const panes = workspacePanes(ws);
    expect(panes[0]!.surface).toBe(b!.surface);
    expect(panes[1]!.surface).toBe(a!.surface);
  });
  it("no-op when the axis doesn't match the split", () => {
    let ws = tripleWorkspace();
    const id = ws.activePaneId;
    ws = movePane(ws, id, "column");
    expect(workspacePanes(ws)[0]!.surface).toBe("explore");
  });
});

describe("resize", () => {
  it("adjusts adjacent weights within a row split", () => {
    let ws = defaultWorkspace(graph());
    const active = ws.activePaneId;
    ws = resize(ws, active, "row", 2);
    const root = ws.root;
    if (root.type === "split") {
      expect(root.sizes[0]).toBe(42);
      expect(root.sizes[1]).toBe(58);
    }
  });
  it("clamps weights to the [1,100] floor/ceiling", () => {
    let ws = defaultWorkspace(graph());
    // each resize caps at ±3; loop until clamped to the ceiling
    for (let i = 0; i < 30; i++) ws = resize(ws, ws.activePaneId, "row", 1000);
    const root = ws.root;
    if (root.type === "split") {
      expect(root.sizes[0]).toBe(100);
      expect(root.sizes[1]).toBe(1);
    }
  });
  it("no-op when the axis doesn't match the split direction", () => {
    const ws = defaultWorkspace(graph());
    expect(resize(ws, ws.activePaneId, "column", 2)).toBe(ws);
  });
});

describe("collapseForWidth", () => {
  it("keeps the full layout at >= 110 cols", () => {
    const ws = tripleWorkspace();
    expect(collapseForWidth(ws, 110)).toBe(ws);
    expect(workspacePanes(collapseForWidth(ws, 140))).toHaveLength(3);
  });
  it("single pane below 80 cols", () => {
    const ws = tripleWorkspace();
    const collapsed = collapseForWidth(ws, 79);
    expect(workspacePanes(collapsed)).toHaveLength(1);
    expect(collapsed.activePaneId).toBe(ws.activePaneId);
  });
  it("collapses nested column splits at 80–109", () => {
    const ws = wideWorkspace();
    const collapsed = collapseForWidth(ws, 100);
    const panes = workspacePanes(collapsed);
    expect(panes).toHaveLength(3);
    // a single (top-level) column split is allowed: [HStack, Detail]
    if (collapsed.root.type === "split") {
      expect(collapsed.root.direction).toBe("column");
      expect(collapsed.root.children[0]?.type).toBe("split");
    }
  });
  it("collapseNestedColumns collapses a column nested under a column", () => {
    const inner = collapseNestedColumns(wideWorkspace().root, true);
    expect(collectPanes(inner)).toHaveLength(2);
  });
  it("collapseNestedColumns keeps rows intact", () => {
    const ws = tripleWorkspace();
    const out = collapseNestedColumns(ws.root);
    expect(collectPanes(out)).toHaveLength(3);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips structure + surface + bound node, dropping nothing structural", () => {
    let ws = defaultWorkspace(graph());
    // bind a node id to the first pane (the detail pane would be set on open)
    const panes = workspacePanes(ws);
    ws = { ...ws, activePaneId: panes[1]?.id ?? ws.activePaneId, root: bindNodeId(ws.root, panes[1]?.id, "note:a") };
    const json = serialize(ws);
    const back = deserialize(json, defaultWorkspace(graph()));
    expect(back.name).toBe(ws.name);
    expect(workspacePanes(back).map((p) => ({ surface: p.surface, nodeId: p.nodeId }))).toEqual(
      workspacePanes(ws).map((p) => ({ surface: p.surface, nodeId: p.nodeId })),
    );
    expect(back.activePaneId).toBe(ws.activePaneId);
  });
  it("deserialize with null/bad input falls back", () => {
    const fb = defaultWorkspace(graph());
    expect(deserialize(null, fb)).toBe(fb);
    expect(deserialize({ name: "x", activePaneId: "", root: undefined as never }, fb)).toBe(fb);
    expect(deserialize({ name: "x", activePaneId: "nope", root: { t: "split", d: "row", sizes: [], c: [] } }, fb)).toBe(fb);
  });
});

describe("collectPanes / findPane / newPaneId", () => {
  it("collectPanes returns layout order", () => {
    const ws = wideWorkspace();
    expect(collectPanes(ws.root).map((p) => p.surface)).toEqual(["explore", "health", "detail"]);
  });
  it("findPane locates a pane by id or returns null", () => {
    const ws = defaultWorkspace(graph());
    const id = workspacePanes(ws)[0]!.id;
    expect(findPane(ws.root, id)?.surface).toBe("explore");
    expect(findPane(ws.root, "nope")).toBeNull();
  });
  it("newPaneId produces unique ids", () => {
    expect(newPaneId()).not.toBe(newPaneId());
  });
  it("workspacePanes delegates to collectPanes", () => {
    expect(workspacePanes(tripleWorkspace())).toHaveLength(3);
  });
});
