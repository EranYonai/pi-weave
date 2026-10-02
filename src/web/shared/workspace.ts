/** Serializable tab and pane state shared by the browser and persistence API. */

export interface WorkspaceTab {
  readonly id: string;
  readonly kind: "document" | "graph";
  readonly history: readonly (string | null)[];
  readonly cursor: number;
  readonly scroll: number;
}

export interface Pane {
  readonly id: string;
  readonly tabs: readonly WorkspaceTab[];
  readonly activeTab: string;
  readonly lastDocumentTab?: string;
}

export interface WorkspaceLayout {
  readonly version: 1;
  readonly panes: readonly Pane[];
  readonly activePane: string;
  readonly split: "right" | "down";
  readonly ratio: number;
  readonly treeVisible: boolean;
  readonly contextVisible: boolean;
  readonly treeWidth: number;
  readonly contextWidth: number;
  readonly theme: "system" | "light" | "dark";
}

const MAX_TABS = 40;
const MAX_HISTORY = 100;
const MAX_SCROLL = 1_000_000_000;

const emptyDocument = (id: string): WorkspaceTab => ({ id, kind: "document", history: [null], cursor: 0, scroll: 0 });

export function initialLayout(): WorkspaceLayout {
  return {
    version: 1,
    panes: [{ id: "pane-1", tabs: [emptyDocument("tab-1")], activeTab: "tab-1" }],
    activePane: "pane-1",
    split: "right",
    ratio: 0.5,
    treeVisible: true,
    contextVisible: true,
    treeWidth: 240,
    contextWidth: 240,
    theme: "system",
  };
}

export function activePane(layout: WorkspaceLayout): Pane {
  return layout.panes.find((pane) => pane.id === layout.activePane)!;
}

export function activeTab(layout: WorkspaceLayout): WorkspaceTab {
  const pane = activePane(layout);
  return pane.tabs.find((tab) => tab.id === pane.activeTab)!;
}

export function tabSelection(tab: WorkspaceTab): string | null {
  return tab.kind === "document" ? tab.history[tab.cursor] ?? null : null;
}

function nextId(layout: WorkspaceLayout, prefix: "pane" | "tab"): string {
  const ids = new Set(layout.panes.flatMap((pane) => [pane.id, ...pane.tabs.map((tab) => tab.id)]));
  let n = 1;
  while (ids.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function setActive(layout: WorkspaceLayout, pane: Pane, tab: WorkspaceTab): WorkspaceLayout {
  return {
    ...layout,
    activePane: pane.id,
    panes: layout.panes.map((item) => item.id === pane.id
      ? rememberDocument({ ...pane, activeTab: tab.id, tabs: pane.tabs.map((current) => current.id === tab.id ? tab : current) })
      : item),
  };
}

function documentTab(pane: Pane): WorkspaceTab | undefined {
  return pane.tabs.find((tab) => tab.id === pane.lastDocumentTab && tab.kind === "document")
    ?? [...pane.tabs].reverse().find((tab) => tab.kind === "document");
}

function rememberDocument(pane: Pane): Pane {
  const { lastDocumentTab: _previous, ...rest } = pane;
  const tab = pane.tabs.find((tab) => tab.id === pane.activeTab && tab.kind === "document") ?? documentTab(pane);
  return tab ? { ...rest, lastDocumentTab: tab.id } : rest;
}

/** Focus reading/editing without navigating away from the active document. */
export function focusDocument(layout: WorkspaceLayout): WorkspaceLayout {
  if (activeTab(layout).kind === "document") return layout;
  const pane = activePane(layout);
  const tab = documentTab(pane);
  return tab ? setActive(layout, pane, tab) : openDocument(layout, null, { newTab: true });
}

function findTab(layout: WorkspaceLayout, paneId: string, tabId: string): { pane: Pane; tab: WorkspaceTab } | null {
  const pane = layout.panes.find((item) => item.id === paneId);
  const tab = pane?.tabs.find((item) => item.id === tabId);
  return pane && tab ? { pane, tab } : null;
}

function appendTab(layout: WorkspaceLayout, pane: Pane, tab: WorkspaceTab): WorkspaceLayout {
  if (layout.panes.reduce((count, item) => count + item.tabs.length, 0) >= MAX_TABS) return layout;
  return setActive(layout, { ...pane, tabs: [...pane.tabs, tab] }, tab);
}

function navigate(tab: WorkspaceTab, id: string | null): WorkspaceTab {
  const history = tab.history.slice(0, tab.cursor + 1);
  if (history.at(-1) === id) return tab;
  history.push(id);
  if (history.length > MAX_HISTORY) history.shift();
  return { ...tab, history, cursor: history.length - 1, scroll: 0 };
}

export function openDocument(layout: WorkspaceLayout, id: string | null, options: { newTab?: boolean; paneId?: string } = {}): WorkspaceLayout {
  let pane = layout.panes.find((item) => item.id === (options.paneId ?? layout.activePane));
  if (!pane) return layout;
  const activeTabId = pane.activeTab;
  let tab = pane.tabs.find((item) => item.id === activeTabId);
  if (tab?.kind === "graph") {
    tab = documentTab(pane);
    if (tab) pane = { ...pane, activeTab: tab.id };
    else if (!options.newTab) options = { ...options, newTab: true };
  }
  if (options.newTab) return appendTab(layout, pane, navigate(emptyDocument(nextId(layout, "tab")), id));
  if (!tab) return appendTab(layout, pane, navigate(emptyDocument(nextId(layout, "tab")), id));
  const next = navigate(tab, id);
  if (next === tab && pane.id === layout.activePane && activeTabId === tab.id) return layout;
  return setActive(layout, pane, next);
}

export function openGraph(layout: WorkspaceLayout): WorkspaceLayout {
  const located = layout.panes.flatMap((pane) => pane.tabs.filter((tab) => tab.kind === "graph").map((tab) => ({ pane, tab })))[0];
  if (located) return located.pane.id === layout.activePane && located.pane.activeTab === located.tab.id
    ? layout
    : setActive(layout, located.pane, located.tab);
  const pane = activePane(layout);
  return appendTab(layout, pane, { id: nextId(layout, "tab"), kind: "graph", history: [null], cursor: 0, scroll: 0 });
}

export function activateTab(layout: WorkspaceLayout, paneId: string, tabId: string): WorkspaceLayout {
  const found = findTab(layout, paneId, tabId);
  return !found || (layout.activePane === paneId && found.pane.activeTab === tabId)
    ? layout
    : setActive(layout, found.pane, found.tab);
}

export function closeTab(layout: WorkspaceLayout, paneId: string, tabId: string): WorkspaceLayout {
  const found = findTab(layout, paneId, tabId);
  if (!found) return layout;
  const { pane } = found;
  if (pane.tabs.length === 1) {
    const tab = emptyDocument(nextId(layout, "tab"));
    return setActive(layout, { ...pane, tabs: [tab] }, tab);
  }
  const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
  const wasActive = pane.activeTab === tabId;
  const neighbor = tabs[Math.max(0, pane.tabs.findIndex((tab) => tab.id === tabId) - 1)]!;
  const updated = rememberDocument({ ...pane, tabs, activeTab: wasActive ? neighbor.id : pane.activeTab });
  return { ...layout, activePane: wasActive ? paneId : layout.activePane, panes: layout.panes.map((item) => item.id === paneId ? updated : item) };
}

export function navigateTab(layout: WorkspaceLayout, paneId: string, delta: -1 | 1): WorkspaceLayout {
  const pane = layout.panes.find((item) => item.id === paneId);
  const tab = pane?.tabs.find((item) => item.id === pane.activeTab);
  if (!pane || !tab || tab.kind !== "document") return layout;
  const cursor = tab.cursor + delta;
  if (cursor < 0 || cursor >= tab.history.length) return layout;
  return setActive(layout, pane, { ...tab, cursor, scroll: 0 });
}

export function splitPane(layout: WorkspaceLayout, direction: "right" | "down"): WorkspaceLayout {
  if (layout.panes.length === 2) return layout.split === direction ? layout : { ...layout, split: direction };
  if (layout.panes.reduce((count, pane) => count + pane.tabs.length, 0) >= MAX_TABS) return layout;
  const current = activeTab(layout);
  const id = nextId(layout, "pane");
  let tab = emptyDocument(nextId(layout, "tab"));
  if (current.kind === "document") tab = { ...current, id: tab.id, history: [...current.history], scroll: current.scroll };
  return { ...layout, panes: [...layout.panes, { id, tabs: [tab], activeTab: tab.id }], activePane: id, split: direction };
}

export function closePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  if (layout.panes.length !== 2 || !layout.panes.some((pane) => pane.id === paneId)) return layout;
  const closed = layout.panes.find((pane) => pane.id === paneId)!;
  const kept = layout.panes.find((pane) => pane.id !== paneId)!;
  return { ...layout, panes: [{ ...kept, tabs: [...kept.tabs, ...closed.tabs] }], activePane: kept.id };
}

export function moveTab(layout: WorkspaceLayout, paneId: string, tabId: string): WorkspaceLayout {
  const found = findTab(layout, paneId, tabId);
  if (!found) return layout;
  const target = layout.panes.find((pane) => pane.id !== paneId) ?? { id: nextId(layout, "pane"), tabs: [], activeTab: "" };
  const sourceTabs = found.pane.tabs.filter((tab) => tab.id !== tabId);
  if (!sourceTabs.length && layout.panes.reduce((count, pane) => count + pane.tabs.length, 0) >= MAX_TABS) return layout;
  const moved = found.tab;
  const placeholder = sourceTabs.length ? null : emptyDocument(nextId(layout, "tab"));
  const remaining = sourceTabs.length ? sourceTabs : [placeholder!];
  const source = rememberDocument({ ...found.pane, tabs: remaining, activeTab: found.pane.activeTab === tabId ? remaining[Math.max(0, found.pane.tabs.findIndex((tab) => tab.id === tabId) - 1)]!.id : found.pane.activeTab });
  const destination = rememberDocument({ ...target, tabs: [...target.tabs, moved], activeTab: moved.id });
  return { ...layout, activePane: target.id, panes: layout.panes.length === 1
    ? [source, destination]
    : layout.panes.map((pane) => pane.id === source.id ? source : destination) };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedId(value: unknown, prefix?: "pane" | "tab"): value is string {
  return typeof value === "string" && value.length <= 2048 && (prefix === undefined
    ? value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
    : new RegExp(`^${prefix}-[1-9][0-9]{0,8}$`).test(value));
}

export function parseWorkspaceLayout(value: unknown): WorkspaceLayout | null {
  if (!record(value) || !exactKeys(value, ["version", "panes", "activePane", "split", "ratio", "treeVisible", "contextVisible", "treeWidth", "contextWidth", "theme"])) return null;
  if (value["version"] !== 1 || !Array.isArray(value["panes"]) || value["panes"].length < 1 || value["panes"].length > 2 || !boundedId(value["activePane"], "pane")) return null;
  if (value["split"] !== "right" && value["split"] !== "down") return null;
  if (typeof value["ratio"] !== "number" || !Number.isFinite(value["ratio"]) || value["ratio"] < 0.1 || value["ratio"] > 0.9) return null;
  if (typeof value["treeVisible"] !== "boolean" || typeof value["contextVisible"] !== "boolean") return null;
  if (typeof value["treeWidth"] !== "number" || !Number.isFinite(value["treeWidth"]) || value["treeWidth"] < 120 || value["treeWidth"] > 800) return null;
  if (typeof value["contextWidth"] !== "number" || !Number.isFinite(value["contextWidth"]) || value["contextWidth"] < 120 || value["contextWidth"] > 800) return null;
  if (value["theme"] !== "system" && value["theme"] !== "light" && value["theme"] !== "dark") return null;
  const ids = new Set<string>();
  let count = 0;
  let graphs = 0;
  const panes: Pane[] = [];
  for (const rawPane of value["panes"]) {
    if (!record(rawPane) || !exactKeys(rawPane, Object.hasOwn(rawPane, "lastDocumentTab") ? ["id", "tabs", "activeTab", "lastDocumentTab"] : ["id", "tabs", "activeTab"]) || !boundedId(rawPane["id"], "pane") || !Array.isArray(rawPane["tabs"]) || rawPane["tabs"].length < 1 || !boundedId(rawPane["activeTab"], "tab") || ids.has(rawPane["id"])) return null;
    ids.add(rawPane["id"]);
    const tabs: WorkspaceTab[] = [];
    let activeFound = false;
    for (const rawTab of rawPane["tabs"]) {
      if (!record(rawTab) || !exactKeys(rawTab, ["id", "kind", "history", "cursor", "scroll"]) || !boundedId(rawTab["id"], "tab") || ids.has(rawTab["id"])) return null;
      ids.add(rawTab["id"]);
      if (rawTab["kind"] !== "document" && rawTab["kind"] !== "graph") return null;
      const kind = rawTab["kind"] as WorkspaceTab["kind"];
      if (!Array.isArray(rawTab["history"]) || rawTab["history"].length < 1 || rawTab["history"].length > MAX_HISTORY || !Number.isInteger(rawTab["cursor"]) || (rawTab["cursor"] as number) < 0 || (rawTab["cursor"] as number) >= rawTab["history"].length) return null;
      if (rawTab["history"].some((id) => id !== null && !boundedId(id))) return null;
      if (typeof rawTab["scroll"] !== "number" || !Number.isFinite(rawTab["scroll"]) || rawTab["scroll"] < 0 || rawTab["scroll"] > MAX_SCROLL) return null;
      if (kind === "graph") graphs++;
      count++;
      if (rawTab["id"] === rawPane["activeTab"]) activeFound = true;
      tabs.push({ id: rawTab["id"], kind, history: rawTab["history"] as (string | null)[], cursor: rawTab["cursor"] as number, scroll: rawTab["scroll"] });
    }
    if (!activeFound) return null;
    const lastDocumentTab = rawPane["lastDocumentTab"];
    if (Object.hasOwn(rawPane, "lastDocumentTab") && (!boundedId(lastDocumentTab, "tab") || !tabs.some((tab) => tab.id === lastDocumentTab && tab.kind === "document"))) return null;
    panes.push({ id: rawPane["id"], tabs, activeTab: rawPane["activeTab"], ...(typeof lastDocumentTab === "string" ? { lastDocumentTab } : {}) });
  }
  if (count > MAX_TABS || graphs > 1 || !panes.some((pane) => pane.id === value["activePane"])) return null;
  return { version: 1, panes, activePane: value["activePane"], split: value["split"], ratio: value["ratio"], treeVisible: value["treeVisible"], contextVisible: value["contextVisible"], treeWidth: value["treeWidth"], contextWidth: value["contextWidth"], theme: value["theme"] };
}
