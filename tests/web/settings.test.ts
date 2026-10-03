import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, FORCE_SLIDERS, parsePreferences } from "../../src/web/shared/preferences";
import { initialLayout, openWithPreferences, openDocument, openGraph, parseWorkspaceLayout, restoreWorkspace, splitPane } from "../../src/web/shared/workspace";
import { FORCE_DEFAULTS, setForces } from "../../src/web/shared/layout";
import { graphShapeKey, resolveLayout } from "../../src/web/client/graph/positions";
import { shellKey, runShellAction } from "../../src/web/client/shell/keys.model";

const preferences = () => structuredClone(DEFAULT_PREFERENCES);
afterEach(() => setForces(FORCE_DEFAULTS));

describe("settings validation and snapshot migration", () => {
  it("accepts defaults and every supported preference", () => {
    expect(parsePreferences(preferences())).toEqual(DEFAULT_PREFERENCES);
    const p = { ...preferences(), accent: "rose", fontSize: 22, readable: false, spellcheck: false, defaultEdit: true, startup: "empty", focusNewTabs: false, groupColors: false };
    expect(parsePreferences(p)).toEqual(p);
    for (const spec of FORCE_SLIDERS) for (const value of [spec.min, spec.max]) {
      expect(parsePreferences({ ...p, forces: { ...p.forces, [spec.key]: value } })).not.toBeNull();
    }
  });
  it("rejects malformed or unsupported preferences without accepting unknown fields", () => {
    for (const bad of [null, [], true, {}, { ...preferences(), extra: true }]) expect(parsePreferences(bad)).toBeNull();
    for (const accent of [null, 1, "__proto__", "unknown"]) expect(parsePreferences({ ...preferences(), accent })).toBeNull();
    for (const fontSize of ["14", NaN, 14.5, 11, 23]) expect(parsePreferences({ ...preferences(), fontSize })).toBeNull();
    for (const key of ["readable", "spellcheck", "defaultEdit", "focusNewTabs", "groupColors", "startup"]) expect(parsePreferences({ ...preferences(), [key]: "unknown" })).toBeNull();
    for (const forces of [null, [], {}, { ...FORCE_DEFAULTS, extra: 1 }]) expect(parsePreferences({ ...preferences(), forces })).toBeNull();
    for (const spec of FORCE_SLIDERS) for (const value of [null, "0", NaN, Infinity, spec.min - 1, spec.max + 1]) {
      expect(parsePreferences({ ...preferences(), forces: { ...FORCE_DEFAULTS, [spec.key]: value } })).toBeNull();
    }
  });
  it("migrates old layouts and round-trips settings with themes", () => {
    const original = initialLayout();
    const { preferences: _, ...legacy } = original;
    expect(parseWorkspaceLayout(legacy)?.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(parseWorkspaceLayout({ ...original, preferences: null })).toBeNull();
    expect(parseWorkspaceLayout({ ...original, preferences: { ...preferences(), accent: "blue" }, theme: "forest-teal" })?.theme).toBe("forest-teal");
    expect(parseWorkspaceLayout(original)).toEqual(original);
  });
});

describe("startup and new tab preferences", () => {
  it("restores navigation or clears it while keeping appearance and sidebar choices", () => {
    const layout = splitPane(openDocument(initialLayout(), "note:one"), "right");
    expect(restoreWorkspace(layout)).toBe(layout);
    const empty = restoreWorkspace({ ...layout, theme: "mocha-lavender", treeVisible: false, preferences: { ...preferences(), startup: "empty" } });
    expect(empty.panes).toEqual(initialLayout().panes);
    expect(empty.theme).toBe("mocha-lavender");
    expect(empty.treeVisible).toBe(false);
  });
  it("preserves active tabs in both panes when opening a background tab", () => {
    const layout = { ...splitPane(openDocument(initialLayout(), "note:one"), "right"), preferences: { ...preferences(), focusNewTabs: false } };
    const other = layout.panes.find((pane) => pane.id !== layout.activePane)!;
    const next = openWithPreferences(layout, "note:two", { newTab: true, paneId: other.id });
    expect(next.activePane).toBe(layout.activePane);
    expect(next.panes.map((pane) => pane.activeTab)).toEqual(layout.panes.map((pane) => pane.activeTab));
    expect(next.panes.find((pane) => pane.id === other.id)?.tabs.at(-1)?.history.at(-1)).toBe("note:two");
    expect(openWithPreferences(layout, "note:three").panes).toEqual(openDocument(layout, "note:three").panes);
    const focused = { ...layout, preferences: preferences() };
    expect(openWithPreferences(focused, "note:two", { newTab: true, paneId: other.id })).toEqual(openDocument(focused, "note:two", { newTab: true, paneId: other.id }));
    const graph = openGraph({ ...initialLayout(), preferences: layout.preferences });
    expect(openWithPreferences(graph, "note:two", { newTab: true }).panes[0]?.activeTab).toBe(graph.panes[0]?.activeTab);
  });
});

it("invalidates cached geometry when force settings change", () => {
  const nodes = [{ id: "note:one", kind: "note" as const, label: "One", title: "One", path: "one", tags: [], provenance: null, detail: {} }];
  const cache = new Map<string, string>();
  const storage = { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => void cache.set(key, value) };
  const key = graphShapeKey(nodes, []);
  resolveLayout(storage, nodes, []);
  expect(resolveLayout(storage, nodes, []).cached).toBe(true);
  setForces({ charge: -600 });
  expect(graphShapeKey(nodes, [])).not.toBe(key);
  expect(resolveLayout(storage, nodes, []).cached).toBe(false);
});

it("opens settings with Command or Control comma and closes with Escape", () => {
  const event = { key: ",", ctrl: false, meta: true, shift: false, alt: false, typing: true };
  expect(shellKey(event, { overlay: null, hasSelection: false })).toEqual({ type: "openSettings" });
  expect(shellKey({ ...event, ctrl: true, meta: false }, { overlay: null, hasSelection: false })).toEqual({ type: "openSettings" });
  expect(shellKey({ ...event, key: "Escape" }, { overlay: "settings", hasSelection: false })).toEqual({ type: "closeOverlay" });
  const events: unknown[] = [];
  runShellAction({ type: "openSettings" }, { setOverlay: (overlay) => events.push(overlay), focusSelector: () => false, fitGraph: () => {}, clearSelection: () => {}, closeTab: () => {}, toggleTheme: () => {} });
  expect(events).toEqual(["settings"]);
});

describe("selected light/dark theme pair", () => {
  it("persists both palettes with the independent accent", () => {
    const layout = { ...initialLayout(), theme: "system" as const, preferences: { ...preferences(), lightTheme: "paper-blue" as const, darkTheme: "frappe-teal" as const, accent: "rose" as const } };
    expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });
  it("migrates previous settings and retains the currently selected palette", () => {
    const { lightTheme: _light, darkTheme: _dark, ...old } = preferences();
    expect(parsePreferences(old)).toEqual(preferences());
    const dark = parseWorkspaceLayout({ ...initialLayout(), theme: "frappe-teal", preferences: old });
    expect(dark?.preferences.darkTheme).toBe("frappe-teal");
    expect(dark?.preferences.lightTheme).toBe("light");
    expect(dark?.theme).toBe("frappe-teal");
    const { preferences: _preferences, ...oldLayout } = initialLayout();
    const light = parseWorkspaceLayout({ ...oldLayout, theme: "latte-blue" });
    expect(light?.preferences.lightTheme).toBe("latte-blue");
    expect(light?.preferences.darkTheme).toBe("dark");
  });
  it("rejects incomplete pairs, foreign palettes and palettes of the wrong scheme", () => {
    const { lightTheme: _light, ...missingLight } = preferences();
    const { darkTheme: _dark, ...missingDark } = preferences();
    expect(parsePreferences(missingLight)).toBeNull();
    expect(parsePreferences(missingDark)).toBeNull();
    for (const key of ["lightTheme", "darkTheme"]) for (const value of [null, "unknown", "system"]) {
      expect(parsePreferences({ ...preferences(), [key]: value })).toBeNull();
    }
    expect(parsePreferences({ ...preferences(), lightTheme: "mocha-lavender" })).toBeNull();
    expect(parsePreferences({ ...preferences(), darkTheme: "paper-blue" })).toBeNull();
  });
});
