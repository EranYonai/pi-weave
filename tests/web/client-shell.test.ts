/**
 * The shell's pure models (weave-workspace §1.2, §10).
 *
 * `shell.model.ts`, `bootstrap.ts` and
 * `workspace.ts` between them hold every decision the shell makes. The `.tsx`
 * files hold none, which is what makes this suite the real coverage of the
 * shell rather than a proxy for it: there is no DOM test environment (§10)
 * and none is needed, because nothing that branches lives in a component.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_BOOTSTRAP, readBootstrap } from "../../src/web/client/bootstrap";
import type { OverlayId } from "../../src/web/client/shell/shell.model";
import {
  CONTEXT_EMPTY,
  NO_VALUE,
  looksApple,
  graphClickOpensTab,
  noteDropId,
  recentEntries,
  recordVisit,
  searchHint,
  searchShortcut,
  statusBarModel,
} from "../../src/web/client/shell/shell.model";
import { COLUMNS, openInSplit } from "../../src/web/client/shell/shell.model";
import type { GraphPayload, WireGraphNode } from "../../src/web/shared/wire";
import { activeTab, initialLayout, openDocument, openGraph, splitPane, tabSelection } from "../../src/web/shared/workspace";
import type { WorkspaceLayout } from "../../src/web/shared/workspace";

// --- fixtures ---------------------------------------------------------------------

it("opens a graph node only after selecting the same preview, never on first click or clear", () => {
  expect(graphClickOpensTab(null, "note:a")).toBe(false);
  expect(graphClickOpensTab("note:a", "note:b")).toBe(false);
  expect(graphClickOpensTab("note:a", "note:a")).toBe(true);
  expect(graphClickOpensTab("note:a", null)).toBe(false);
  expect(graphClickOpensTab(null, null)).toBe(false);
});

describe("openInSplit — the graph sheet's Open in split", () => {
  /** The graph tab's pane, as the shell finds it: the pane whose active tab is the graph. */
  const graphPaneOf = (layout: WorkspaceLayout) => layout.panes.find((pane) => pane.tabs.some((tab) => tab.id === pane.activeTab && tab.kind === "graph"));

  it("splits a single pane, keeping the graph in front of its own pane", () => {
    const layout = openGraph(openDocument(initialLayout(), "note:a"));
    const graph = graphPaneOf(layout)!;
    const next = openInSplit(layout, "note:b", graph.id);
    expect(next.panes).toHaveLength(2);
    // The graph's pane still shows the graph — the whole point of "beside".
    const kept = next.panes.find((pane) => pane.id === graph.id)!;
    expect(kept.tabs.find((tab) => tab.id === kept.activeTab)?.kind).toBe("graph");
    expect(kept.lastDocumentTab).toBe(graph.lastDocumentTab);
    // The note is alone in the new pane, which takes focus by default.
    const opened = next.panes.find((pane) => pane.id !== graph.id)!;
    expect(opened.tabs.map(tabSelection)).toEqual(["note:b"]);
    expect(next.activePane).toBe(opened.id);
    expect(tabSelection(activeTab(next))).toBe("note:b");
    expect(next.split).toBe(layout.split);
  });

  it("splits a graph that is the pane's only tab", () => {
    const layout = openGraph(initialLayout());
    const alone = { ...layout, panes: layout.panes.map((pane) => ({ ...pane, tabs: pane.tabs.filter((tab) => tab.kind === "graph") })) };
    const { lastDocumentTab: _dropped, ...pane } = alone.panes[0]!;
    const graphOnly: WorkspaceLayout = { ...alone, panes: [pane] };
    const next = openInSplit(graphOnly, "note:b", pane.id);
    expect(next.panes.map((entry) => entry.tabs.map((tab) => tab.kind))).toEqual([["graph"], ["document"]]);
    expect(next.panes[0]!.lastDocumentTab).toBeUndefined();
  });

  it("opens in the other pane when there already are two", () => {
    const layout = splitPane(openGraph(openDocument(initialLayout(), "note:a")), "down");
    const graph = graphPaneOf(layout)!;
    const next = openInSplit(layout, "note:c", graph.id);
    expect(next.panes).toHaveLength(2);
    const other = next.panes.find((pane) => pane.id !== graph.id)!;
    expect(other.tabs.map(tabSelection)).toContain("note:c");
    expect(next.split).toBe("down");
  });

  it("keeps focus on the graph when new tabs are not focused", () => {
    const base = openGraph(openDocument(initialLayout(), "note:a"));
    const layout = { ...base, preferences: { ...base.preferences, focusNewTabs: false } };
    const graph = graphPaneOf(layout)!;
    expect(openInSplit(layout, "note:b", graph.id).activePane).toBe(graph.id);
  });

  it("falls back to the active pane when the graph pane is unknown", () => {
    const layout = openGraph(openDocument(initialLayout(), "note:a"));
    expect(openInSplit(layout, "note:b", undefined).panes).toHaveLength(2);
  });

  it("changes nothing when the tab budget is spent", () => {
    let layout = openGraph(initialLayout());
    for (let index = 0; index < 60; index++) layout = openDocument(layout, `note:${index}`, { newTab: true });
    const full = openGraph(layout);
    expect(openInSplit(full, "note:extra", graphPaneOf(full)!.id)).toBe(full);
  });
});

it("accepts pane drops only for existing workspace notes", () => {
  const graph = payload([node("note:a", "note"), node("artifact:a", "file"), node("note:wrong-kind", "module")]);
  expect(noteDropId(graph, "note:a")).toBe("note:a");
  expect(noteDropId(graph, "note:missing")).toBeNull();
  expect(noteDropId(graph, "artifact:a")).toBeNull();
  expect(noteDropId(graph, "note:wrong-kind")).toBeNull();
  expect(noteDropId(null, "note:a")).toBeNull();
  expect(noteDropId(graph, "")).toBeNull();
});

it("records recent visits in last-visit order without depending on open tabs", () => {
  let visits: readonly string[] = [];
  for (const id of ["note:a", "note:b", "note:c", "note:a"]) visits = recordVisit(visits, id);
  expect(visits).toEqual(["note:a", "note:c", "note:b"]);
  expect(recordVisit(visits, null)).toBe(visits);
  for (let index = 0; index < 110; index++) visits = recordVisit(visits, `note:${index}`);
  expect(visits).toHaveLength(100);
  expect(visits[0]).toBe("note:109");
});

it("keeps a Recent browsing snapshot ordered while selection moves, then reflects MRU on reentry", () => {
  const snapshot = ["note:a", "vfolder:Project", "artifact:Test Results.html"];
  const graph = payload([
    node("note:a", "note"),
    node("vfolder:Project", "module"),
    node("artifact:Test Results.html", "file"),
  ]);
  const updatedVisits = recordVisit(snapshot, "artifact:Test Results.html");
  expect(recentEntries(snapshot, graph, "artifact:Test Results.html").map((entry) => entry.id)).toEqual(snapshot);
  expect(recentEntries(snapshot, graph, "artifact:Test Results.html").map((entry) => entry.selected)).toEqual([false, false, true]);
  expect(recentEntries(updatedVisits, graph, "artifact:Test Results.html").map((entry) => entry.id)).toEqual(["artifact:Test Results.html", "note:a", "vfolder:Project"]);
});

it("presents note, folder, and HTML artifact rows with their own icons and labels", () => {
  const ids = ["note:a", "vfolder:Project", "artifact:Test Results.html"];
  const graph = payload([
    { ...node("note:a", "note"), label: "A note" },
    { ...node("vfolder:Project", "module"), label: "Project" },
    { ...node("artifact:Test Results.html", "file"), label: "Test Results" },
  ]);
  expect(recentEntries(ids, graph, null)).toEqual([
    { id: "note:a", label: "A note", icon: "note", selected: false },
    { id: "vfolder:Project", label: "Project", icon: "module", selected: false },
    { id: "artifact:Test Results.html", label: "Test Results", icon: "file", selected: false },
  ]);
  expect(recentEntries(ids, null, null).map((entry) => [entry.label, entry.icon])).toEqual([
    ["a", "note"], ["Project", "module"], ["Test Results.html", "file"],
  ]);
});

function node(id: string, kind: WireGraphNode["kind"]): WireGraphNode {
  return { id, kind, label: id, provenance: null, detail: {} };
}

function payload(nodes: WireGraphNode[]): GraphPayload {
  return {
    model: {
      generatedAt: "2026-03-04T09:08:07Z",
      staleness: null,
      nodes,
      edges: [],
      contentDigest: "",
    },
    tags: {},
    dangling: {},
    positions: null,
    stamp: "2026-03-04T09:08:07Z",
  };
}

// --- empty states -------------------------------------------------------------------

describe("empty states", () => {
  it("gives the context rail its own copy", () => {
    expect(CONTEXT_EMPTY.title).toBe("Context");
  });
});

// --- the status bar --------------------------------------------------------------------

describe("statusBarModel", () => {
  it("shows the cwd and the selection", () => {
    const model = statusBarModel("/repo", "note:alpha");
    expect(model.cwd).toBe("/repo");
    expect(model.selection).toBe("alpha.md");
    expect(model.hint).toBe("");
  });

  it("names a note by its file and leaves other selections as they are", () => {
    expect(statusBarModel("/repo", "note:projects/launch").selection).toBe("projects/launch.md");
    expect(statusBarModel("/repo", "note:").selection).toBe("note:");
    expect(statusBarModel("/repo", "artifact:docs/a.html").selection).toBe("artifact:docs/a.html");
  });

  it("ends with the search shortcut when one is given", () => {
    expect(statusBarModel("/repo", null, "⌘K").hint).toBe("⌘K search");
  });

  it("says so when nothing is selected", () => {
    expect(statusBarModel("/repo", null).selection).toBe("nothing selected");
  });

  it("falls back to a dash for an absent cwd", () => {
    expect(statusBarModel("", null).cwd).toBe(NO_VALUE);
  });
});

// --- the search affordance ----------------------------------------------------------------

describe("search affordance", () => {
  it("uses the Apple spelling only on Apple platforms", () => {
    expect(searchShortcut(true)).toBe("⌘K");
    expect(searchShortcut(false)).toBe("Ctrl K");
  });

  it("recognises Apple platform strings", () => {
    for (const platform of ["MacIntel", "iPhone", "iPad", "macOS"]) {
      expect(looksApple(platform)).toBe(true);
    }
  });

  it("defaults everything else to Ctrl, including an empty platform", () => {
    for (const platform of ["Win32", "Linux x86_64", ""]) {
      expect(looksApple(platform)).toBe(false);
    }
  });

  it("names the shortcut in the tooltip, now that the control is live", () => {
    // The ribbon action and the shortcut share this one palette.
    expect(searchHint("⌘K")).toContain("⌘K");
    expect(searchHint("Ctrl K")).toContain("Ctrl K");
  });
});

// --- overlays ---------------------------------------------------------------------------

describe("OverlayId", () => {
  it("cannot represent two overlays at once", () => {
    // A type-level assertion, and the point of the design: two booleans could
    // hold `{search:true, help:true}` — two dialogs stacked, each trapping
    // focus against the other. This shape cannot.
    const states: OverlayId[] = ["search", "help", null];
    expect(new Set(states).size).toBe(3);
  });
});

// --- the bootstrap block ----------------------------------------------------------------------

describe("readBootstrap", () => {
  it("decodes the block page.ts embeds", () => {
    const boot = { cwd: "/repo" };
    expect(readBootstrap(JSON.stringify(boot))).toEqual(boot);
  });

  it("falls back rather than throwing when the block is absent or blank", () => {
    // Every field is cosmetic at P1; throwing would turn that into a blank page.
    expect(readBootstrap(null)).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap("")).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap("   ")).toEqual(EMPTY_BOOTSTRAP);
  });

  it("falls back on malformed JSON", () => {
    expect(readBootstrap("{nope")).toEqual(EMPTY_BOOTSTRAP);
  });

  it("falls back on JSON that is valid but not a bootstrap", () => {
    expect(readBootstrap("null")).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap("[]")).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('"a string"')).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('{"vaultRoot":"/v"}')).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('{"cwd":1}')).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('{"cwd":null}')).toEqual(EMPTY_BOOTSTRAP);
  });
});
