import { describe, expect, it } from "vitest";
import {
  activateTab,
  activePane,
  activeTab,
  closePane,
  closeTab,
  initialLayout,
  moveTab,
  navigateTab,
  openDocument,
  openGraph,
  parseWorkspaceLayout,
  splitPane,
  tabSelection,
} from "../../src/web/shared/workspace";

describe("workspace tab model", () => {
  it("starts with one empty document tab and preserves identical no-ops", () => {
    const layout = initialLayout();
    expect(layout.panes).toHaveLength(1);
    expect(activeTab(layout)).toMatchObject({ kind: "document", history: [null], cursor: 0 });
    expect(tabSelection(activeTab(layout))).toBeNull();
    expect(openDocument(layout, null)).toBe(layout);
    expect(tabSelection({ id: "tab-1", kind: "document", history: [], cursor: 0, scroll: 0 })).toBeNull();
    const noTabs = { ...layout, panes: [{ ...layout.panes[0]!, tabs: [] }] };
    expect(activeTab(openDocument(noTabs, "note:repair"))).toMatchObject({ history: [null, "note:repair"] });
    expect(navigateTab(layout, layout.activePane, -1)).toBe(layout);
    expect(openDocument(layout, "note:x", { paneId: "pane-404" })).toBe(layout);
    expect(navigateTab(layout, "pane-404", 1)).toBe(layout);
    expect(closeTab(layout, layout.activePane, "missing")).toBe(layout);
    expect(closePane(layout, layout.activePane)).toBe(layout);
    expect(closePane(layout, "pane-404")).toBe(layout);
    expect(moveTab(layout, "pane-404", "tab-404")).toBe(layout);
  });

  it("navigates within a tab, truncates forward history, and opens explicit tabs", () => {
    let layout = openDocument(initialLayout(), "note:one");
    layout = openDocument(layout, "note:two");
    layout = navigateTab(layout, layout.activePane, -1);
    expect(tabSelection(activeTab(layout))).toBe("note:one");
    layout = openDocument(layout, "note:three");
    expect(activeTab(layout).history).toEqual([null, "note:one", "note:three"]);
    const oldTab = activeTab(layout).id;
    layout = openDocument(layout, "note:three", { newTab: true });
    expect(activePane(layout).tabs).toHaveLength(2);
    expect(activeTab(layout).id).not.toBe(oldTab);
    expect(tabSelection(activeTab(layout))).toBe("note:three");
    for (let index = 0; index < 100; index++) layout = openDocument(layout, `note:${index}`);
    expect(activeTab(layout).history).toHaveLength(100);
  });

  it("keeps one graph tab and opens notes beside it", () => {
    let layout = openGraph(initialLayout());
    const graphId = activeTab(layout).id;
    layout = openDocument(layout, "note:a");
    expect(activeTab(layout).kind).toBe("document");
    expect(layout.panes[0]?.tabs.find((tab) => tab.id === graphId)?.kind).toBe("graph");
    layout = openGraph(layout);
    expect(activeTab(layout).id).toBe(graphId);
    expect(openGraph(layout)).toBe(layout);
    layout = openDocument(layout, "note:a");
    expect(activeTab(layout).kind).toBe("document");
  });

  it("opens a document from a graph-only pane and keeps the graph available", () => {
    const opened = openGraph(initialLayout());
    const graph = activeTab(opened);
    const graphOnly = { ...opened, panes: [{ ...opened.panes[0]!, tabs: [graph], activeTab: graph.id }] };
    const layout = openDocument(graphOnly, "note:first");
    expect(activeTab(layout)).toMatchObject({ kind: "document", history: [null, "note:first"] });
    expect(activePane(layout).tabs.some((tab) => tab.id === graph.id && tab.kind === "graph")).toBe(true);
    expect(activeTab(openDocument(graphOnly, "note:second", { newTab: true })).kind).toBe("document");
  });

  it("duplicates document view on split and merges tabs when closing a pane", () => {
    let layout = openDocument(initialLayout(), "note:a");
    layout = openDocument(layout, "note:b");
    layout = { ...layout, panes: layout.panes.map((pane) => ({ ...pane, tabs: pane.tabs.map((tab) => ({ ...tab, scroll: 250 })) })) };
    layout = splitPane(layout, "down");
    expect(layout.split).toBe("down");
    expect(layout.panes).toHaveLength(2);
    expect(tabSelection(activeTab(layout))).toBe("note:b");
    expect(activeTab(layout).id).not.toBe(layout.panes[0]?.tabs[0]?.id);
    expect(activeTab(layout).history).toEqual(layout.panes[0]?.tabs[0]?.history);
    expect(activeTab(layout).scroll).toBe(250);
    layout = closePane(layout, layout.activePane);
    expect(layout.panes).toHaveLength(1);
    expect(layout.panes[0]?.tabs).toHaveLength(2);
    expect(activePane(layout).id).toBe(layout.panes[0]?.id);
  });

  it("starts an empty document beside graph and preserves tab IDs through moves", () => {
    let layout = openGraph(initialLayout());
    layout = splitPane(layout, "right");
    expect(activeTab(layout)).toMatchObject({ kind: "document", history: [null] });
    const targetTabId = activeTab(layout).id;
    const targetPane = layout.activePane;
    layout = openDocument(layout, "note:two");
    const sourcePane = layout.panes.find((pane) => pane.id !== targetPane)!;
    const moving = sourcePane.tabs.find((tab) => tab.kind === "graph")!;
    layout = moveTab(layout, sourcePane.id, moving.id);
    expect(layout.activePane).toBe(targetPane);
    expect(activeTab(layout).id).toBe(moving.id);
    expect(layout.panes.flatMap((pane) => pane.tabs).some((tab) => tab.id === targetTabId)).toBe(true);
  });

  it("moves the sole tab into a new pane while leaving an empty source tab", () => {
    let layout = openDocument(initialLayout(), "note:only");
    const sourceId = layout.activePane;
    const movingId = activeTab(layout).id;
    layout = moveTab(layout, sourceId, movingId);
    expect(layout.panes).toHaveLength(2);
    expect(activeTab(layout).id).toBe(movingId);
    expect(tabSelection(activeTab(layout))).toBe("note:only");
    expect(layout.panes.find((pane) => pane.id === sourceId)?.tabs[0]).toMatchObject({ kind: "document", history: [null] });
  });

  it("enforces the 40-tab cap for new tabs and splits", () => {
    const initial = initialLayout();
    const pane = initial.panes[0]!;
    const tabs = Array.from({ length: 39 }, (_, index) => ({ ...pane.tabs[0]!, id: `tab-${index + 1}` }));
    const thirtyNine = { ...initial, panes: [{ ...pane, tabs, activeTab: "tab-1" }] };
    const split = splitPane(thirtyNine, "right");
    expect(split.panes.flatMap((group) => group.tabs)).toHaveLength(40);
    const forty = { ...thirtyNine, panes: [{ ...pane, tabs: [...tabs, { ...tabs[0]!, id: "tab-40" }], activeTab: "tab-1" }] };
    expect(splitPane(forty, "right")).toBe(forty);
    expect(openDocument(forty, "note:extra", { newTab: true })).toBe(forty);
    // Moving the last tab would need a new empty source tab, exceeding the cap.
    expect(moveTab(split, split.activePane, activeTab(split).id)).toBe(split);
    const moved = moveTab(split, split.panes[0]!.id, "tab-1");
    expect(moved.panes.flatMap(group => group.tabs)).toHaveLength(40);
    expect(parseWorkspaceLayout(moved)).not.toBeNull();
  });

  it("closes tabs without leaving a pane empty", () => {
    let layout = openDocument(initialLayout(), "note:a", { newTab: true });
    const oldId = activeTab(layout).id;
    layout = closeTab(layout, layout.activePane, oldId);
    expect(activePane(layout).tabs).toHaveLength(1);
    expect(activeTab(layout).kind).toBe("document");
    expect(closeTab(layout, "missing", "missing")).toBe(layout);
    layout = activateTab(layout, layout.activePane, activeTab(layout).id);
    expect(layout.activePane).toBe("pane-1");
  });

  it("activates tabs and closes background and active tabs in each pane", () => {
    let layout = openDocument(initialLayout(), "note:a", { newTab: true });
    const firstPane = layout.panes[0]!;
    const firstTabId = firstPane.tabs[0]!.id;
    layout = activateTab(layout, firstPane.id, firstTabId);
    expect(activeTab(layout).id).toBe(firstTabId);
    expect(activateTab(layout, "missing", firstTabId)).toBe(layout);
    layout = activateTab(layout, firstPane.id, firstPane.tabs[1]!.id);
    layout = splitPane(layout, "right");
    const other = layout.panes[1]!;
    const original = layout.panes[0]!;
    layout = closeTab(layout, original.id, firstTabId);
    expect(layout.panes[0]?.activeTab).toBe(firstPane.tabs[1]!.id);
    layout = activateTab(layout, other.id, other.activeTab);
    expect(layout.activePane).toBe(other.id);
    layout = activateTab(layout, original.id, original.activeTab);
    expect(layout.activePane).toBe(original.id);
    layout = activateTab(layout, other.id, other.activeTab);
    layout = closeTab(layout, other.id, other.activeTab);
    expect(activePane(layout).id).toBe(other.id);
  });

  it("keeps graph history inert and preserves split direction no-ops", () => {
    let layout = openGraph(initialLayout());
    expect(navigateTab(layout, layout.activePane, 1)).toBe(layout);
    layout = splitPane(layout, "right");
    expect(splitPane(layout, "right")).toBe(layout);
    expect(splitPane(layout, "down").split).toBe("down");
  });

  it("moves background tabs from a two-pane layout without changing source focus", () => {
    let layout = openDocument(initialLayout(), "note:a", { newTab: true });
    layout = splitPane(layout, "right");
    const source = layout.panes[0]!;
    const background = source.tabs[0]!;
    layout = moveTab(layout, source.id, background.id);
    expect(layout.panes.flatMap((pane) => pane.tabs).some((tab) => tab.id === background.id)).toBe(true);
    expect(activeTab(layout).id).toBe(background.id);
  });

  it("trims the oldest history entry when navigation exceeds the cap", () => {
    let layout = initialLayout();
    for (let index = 0; index < 101; index++) layout = openDocument(layout, `note:${index}`);
    expect(activeTab(layout).history).toHaveLength(100);
    expect(activeTab(layout).history[0]).toBe("note:1");
  });
});

describe("workspace layout validation", () => {
  it("round-trips valid state and rejects unsafe shape, limits, and references", () => {
    const layout = initialLayout();
    expect(parseWorkspaceLayout(layout)).toEqual(layout);
    expect(parseWorkspaceLayout({ ...layout, extra: true })).toBeNull();
    expect(parseWorkspaceLayout({ ...layout, activePane: "pane-2" })).toBeNull();
    expect(parseWorkspaceLayout({ ...layout, ratio: Number.NaN })).toBeNull();
    expect(parseWorkspaceLayout({ ...layout, treeWidth: 801 })).toBeNull();
    expect(parseWorkspaceLayout({ ...layout, panes: [{ ...layout.panes[0], tabs: [{ ...layout.panes[0]?.tabs[0], history: ["../secret"] }] }] })).not.toBeNull();
  });

  it("rejects duplicate IDs, invalid history cursors, excessive panes, and duplicate graph tabs", () => {
    const layout = initialLayout();
    const pane = layout.panes[0]!;
    const tab = pane.tabs[0]!;
    expect(parseWorkspaceLayout({ ...layout, panes: [{ ...pane, tabs: [tab, { ...tab }] }] })).toBeNull();
    expect(parseWorkspaceLayout({ ...layout, panes: [{ ...pane, tabs: [{ ...tab, cursor: 1 }] }] })).toBeNull();
    expect(parseWorkspaceLayout({ ...layout, panes: [pane, { id: "pane-2", tabs: [tab], activeTab: tab.id }, { id: "pane-3", tabs: [tab], activeTab: tab.id }] })).toBeNull();
    const graph = { ...tab, id: "tab-2", kind: "graph" as const };
    expect(parseWorkspaceLayout({ ...layout, panes: [{ ...pane, tabs: [graph, { ...graph, id: "tab-3" }] }] })).toBeNull();
  });

  it("enforces bounded tabs and history while preserving opaque graph IDs", () => {
    const layout = initialLayout();
    const pane = layout.panes[0]!;
    const tabs = Array.from({ length: 40 }, (_, index) => ({ ...pane.tabs[0]!, id: `tab-${index + 1}` }));
    expect(parseWorkspaceLayout({ ...layout, panes: [{ ...pane, tabs, activeTab: "tab-1" }] })).not.toBeNull();
    expect(parseWorkspaceLayout({ ...layout, panes: [{ ...pane, tabs: [...tabs, { ...tabs[0]!, id: "tab-41" }] }] })).toBeNull();
    const history = Array.from({ length: 100 }, (_, index) => `file:src/module-${index}.ts`);
    const bounded = { ...layout, panes: [{ ...pane, tabs: [{ ...pane.tabs[0]!, history, cursor: 99 }] }] };
    expect(parseWorkspaceLayout(bounded)?.panes[0]?.tabs[0]?.history).toEqual(history);
    expect(parseWorkspaceLayout({ ...layout, panes: [{ ...pane, tabs: [{ ...pane.tabs[0]!, history: [...history, "note:extra"], cursor: 100 }] }] })).toBeNull();
  });

  it("rejects malformed layout, pane, tab, and scalar fields", () => {
    const layout = initialLayout();
    const pane = layout.panes[0]!;
    const tab = pane.tabs[0]!;
    const withTab = (changes: Record<string, unknown>): unknown => ({ ...layout, panes: [{ ...pane, tabs: [{ ...tab, ...changes }] }] });
    const invalid: unknown[] = [
      null,
      [],
      { ...layout, version: 2 },
      { ...layout, panes: [] },
      { ...layout, panes: "pane" },
      { ...layout, panes: [pane, { id: "pane-2", tabs: [tab], activeTab: tab.id }, { id: "pane-3", tabs: [tab], activeTab: tab.id }] },
      { ...layout, split: "left" },
      { ...layout, ratio: "0.5" },
      { ...layout, ratio: 0.09 },
      { ...layout, ratio: 0.91 },
      { ...layout, treeVisible: 1 },
      { ...layout, contextVisible: null },
      { ...layout, treeWidth: Infinity },
      { ...layout, treeWidth: 119 },
      { ...layout, contextWidth: 801 },
      { ...layout, theme: "auto" },
      { ...layout, activePane: "pane-0" },
      { ...layout, activePane: "pane-2" },
      { ...layout, panes: ["pane"] },
      { ...layout, panes: [{ ...pane, id: "pane-0" }] },
      { ...layout, panes: [{ ...pane, tabs: [] }] },
      { ...layout, panes: [{ ...pane, tabs: null }] },
      { ...layout, panes: [{ ...pane, activeTab: "tab-2" }] },
      { ...layout, panes: [{ ...pane, activeTab: "tab-0" }] },
      { ...layout, panes: [{ ...pane, tabs: [null] }] },
      withTab({ id: "tab-0" }),
      withTab({ kind: "artifact" }),
      withTab({ history: null }),
      withTab({ history: [] }),
      withTab({ cursor: -1 }),
      withTab({ cursor: 0.5 }),
      withTab({ history: ["bad\u0000id"] }),
      withTab({ scroll: "0" }),
      withTab({ scroll: Number.NaN }),
      withTab({ scroll: -1 }),
      withTab({ scroll: 1_000_000_001 }),
    ];
    for (const value of invalid) expect(parseWorkspaceLayout(value)).toBeNull();
    const { version: _version, ...withoutVersion } = layout;
    expect(parseWorkspaceLayout({ ...withoutVersion, unrelated: true })).toBeNull();
  });
});
