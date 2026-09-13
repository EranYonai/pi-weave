import { describe, expect, it } from "vitest";
import {
  collapseForWidth,
  defaultWorkspace,
  findPane,
  focusNext,
  workspacePanes,
} from "../../src/pi/viewer/tui/workspace";
import type { GraphModel } from "../../src/core/graph/model";

const graph = (): GraphModel => ({ generatedAt: "", staleness: null, nodes: [], edges: [], danglingLinks: {}, contentDigest: "" });

describe("fixed TUI workspace", () => {
  it("contains all read-only surfaces in a stable layout", () => {
    const ws = defaultWorkspace(graph());
    expect(ws.name).toBe("Explore");
    expect(workspacePanes(ws).map((pane) => pane.surface)).toEqual(["explore", "detail", "focus", "health"]);
    expect(ws.panes).toHaveLength(4);
    expect(ws.activePaneId).toBe(workspacePanes(ws)[0]!.id);
  });

  it("cycles focus in layout order", () => {
    let ws = defaultWorkspace(graph());
    const panes = workspacePanes(ws);
    ws = focusNext(ws, 1);
    expect(ws.activePaneId).toBe(panes[1]!.id);
    ws = focusNext(ws, -1);
    expect(ws.activePaneId).toBe(panes[0]!.id);
  });

  it("collapses to the active pane below 80 columns", () => {
    const ws = defaultWorkspace(graph());
    const narrow = collapseForWidth(ws, 79);
    expect(workspacePanes(narrow).map((pane) => pane.surface)).toEqual(["explore"]);
    expect(collapseForWidth(ws, 80)).toBe(ws);
  });

  it("collects and finds panes", () => {
    const ws = defaultWorkspace(graph());
    expect(findPane(ws.panes, ws.activePaneId)?.surface).toBe("explore");
    expect(findPane(ws.panes, "missing")).toBeNull();
  });
});
