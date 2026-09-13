import type { GraphModel } from "../../../core/graph/model";
import { graphRoots } from "./model";

export type SurfaceKind = "explore" | "detail" | "focus" | "health";

export interface PaneNode {
  id: string;
  surface: SurfaceKind;
  nodeId: string | null;
}

export interface Workspace {
  name: string;
  panes: PaneNode[];
  activePaneId: string;
}

function pane(surface: SurfaceKind, nodeId: string | null = null): PaneNode {
  return { id: surface, surface, nodeId };
}

export function workspacePanes(ws: Workspace): PaneNode[] {
  return ws.panes;
}

export function findPane(panes: PaneNode[], id: string): PaneNode | null {
  return panes.find((item) => item.id === id) ?? null;
}

export function focusNext(ws: Workspace, dir: 1 | -1): Workspace {
  if (ws.panes.length <= 1) return ws;
  const index = ws.panes.findIndex((item) => item.id === ws.activePaneId);
  const next = ws.panes[(index + dir + ws.panes.length) % ws.panes.length];
  return next ? { ...ws, activePaneId: next.id } : ws;
}

/** The only layout: four equal-width read-only surfaces. */
export function defaultWorkspace(model: GraphModel): Workspace {
  const panes = [
    pane("explore", graphRoots(model)[0] ?? null),
    pane("detail"),
    pane("focus"),
    pane("health"),
  ];
  return { name: "Explore", panes, activePaneId: panes[0]!.id };
}

/** Hide inactive panes in a narrow terminal. */
export function collapseForWidth(ws: Workspace, width: number): Workspace {
  if (width >= 80) return ws;
  const active = findPane(ws.panes, ws.activePaneId);
  return active ? { ...ws, panes: [active] } : ws;
}
