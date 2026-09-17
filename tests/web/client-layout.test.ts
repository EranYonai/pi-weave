import { describe, expect, it, vi } from "vitest";
import {
  BREAKPOINT_MEDIUM, BREAKPOINT_NARROW, COLUMNS, DEFAULT_FRACTIONS, DIVIDERS, LAYOUT_STORAGE_KEY,
  MIN_WIDTHS, breakpointFor, columnsAt, defaultLayout,
  deserializeLayout, dividerPair, isCollapsed, loadLayout, makeLayout, minShares, normalizeFractions,
  resolveColumns, resizeAt, saveLayout, serializeLayout,
} from "../../src/web/client/shell/layout.model";
import type { LayoutState, LayoutStorage } from "../../src/web/client/shell/layout.model";
import { beginDrag, dividerHandlers, dragChanged, dragTo, nudgeFor } from "../../src/web/client/shell/drag.model";

const WIDE = 1600;
const sum = (state: LayoutState) => Object.values(state.fractions).reduce((a, b) => a + b, 0);
const storage = (seed: Record<string, string> = {}): LayoutStorage & { map: Map<string, string> } => {
  const map = new Map(Object.entries(seed));
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
};

describe("layout breakpoints and construction", () => {
  it("keeps documented boundaries and degrades bad widths", () => {
    expect(breakpointFor(BREAKPOINT_MEDIUM)).toBe("wide");
    expect(breakpointFor(BREAKPOINT_MEDIUM - 1)).toBe("medium");
    expect(breakpointFor(BREAKPOINT_NARROW)).toBe("medium");
    expect(breakpointFor(BREAKPOINT_NARROW - 1)).toBe("narrow");
    expect(breakpointFor(Number.NaN)).toBe("narrow");
    expect(breakpointFor(Number.POSITIVE_INFINITY)).toBe("narrow");
  });

  it("maps visible columns and collapse state", () => {
    expect(columnsAt("wide")).toEqual(COLUMNS);
    expect(columnsAt("medium")).toEqual(["tree", "note"]);
    expect(columnsAt("narrow")).toEqual(["note"]);
    expect(isCollapsed("medium", "graph")).toBe(true);
    expect(isCollapsed("wide", "graph")).toBe(false);
  });

  it("normalizes bad and undersized fractions", () => {
    const floors = minShares(WIDE);
    const result = normalizeFractions({ tree: Number.NaN, note: 0.001, graph: -1 }, floors);
    expect(sum({ fractions: result })).toBeCloseTo(1);
    expect(result.tree).toBeGreaterThanOrEqual(floors.tree);
    expect(result.note).toBeGreaterThanOrEqual(floors.note);
    expect(result.graph).toBeGreaterThanOrEqual(floors.graph);
    expect(normalizeFractions({ tree: 0.3, note: 0.4, graph: 0.3 }, { tree: 0.1, note: 0.1, graph: 0.1 })).toEqual({ tree: 0.3, note: 0.4, graph: 0.3 });
    expect(normalizeFractions({ tree: 0.1, note: 0.8, graph: 0.1 }, { tree: 0.4, note: 0.4, graph: 0.4 }).tree).toBe(0.4);
  });

  it("scales minimums only when the viewport cannot fit them", () => {
    expect(minShares(2000).tree).toBe(MIN_WIDTHS.tree / 2000);
    expect(minShares(500).tree + minShares(500).note + minShares(500).graph).toBeCloseTo(0.9);
    expect(minShares(Number.NaN).note).toBeGreaterThan(0);
  });

  it("resolves visible columns to pixels and redistributes hidden shares", () => {
    const state = defaultLayout(1000);
    expect(resolveColumns(state, 1000, "wide")).toHaveLength(3);
    expect(resolveColumns(state, 1000, "medium")).toHaveLength(2);
    expect(resolveColumns(state, 600, "narrow")[0]?.width).toBeCloseTo(600);
    expect(resolveColumns(state, Number.NaN, "wide").every((column) => column.width === 0)).toBe(true);
    expect(defaultLayout(WIDE).fractions.note).toBeGreaterThan(DEFAULT_FRACTIONS.tree);
    expect(makeLayout({ tree: 5, note: 1, graph: 1 }, WIDE).fractions.tree).toBeLessThan(1);
  });
});

describe("divider arithmetic", () => {
  it("moves only its neighboring columns and clamps at floors", () => {
    const before = defaultLayout(WIDE);
    const after = resizeAt(before, "tree", 160, WIDE);
    expect(after.fractions.tree).toBeGreaterThan(before.fractions.tree);
    expect(after.fractions.note).toBeLessThan(before.fractions.note);
    expect(after.fractions.graph).toBeCloseTo(before.fractions.graph);
    expect(resizeAt(before, "tree", 0, WIDE)).toBe(before);
    expect(resizeAt(before, "tree", Number.NaN, WIDE)).toBe(before);
    expect(resizeAt(before, "tree", 50, 0)).toBe(before);
    const clamped = resizeAt(before, "tree", 100000, WIDE);
    expect(clamped.fractions.note).toBeCloseTo(minShares(WIDE).note);
    expect(resizeAt(clamped, "tree", 500, WIDE)).toBe(clamped);
    expect(dividerPair("tree")).toEqual(["tree", "note"]);
    expect(dividerPair("note")).toEqual(["note", "graph"]);
    expect(DIVIDERS).toEqual(["tree", "note"]);
  });
});

describe("layout persistence and CSS ports", () => {
  it("round-trips and rejects malformed storage", () => {
    const state = resizeAt(defaultLayout(WIDE), "note", -70, WIDE);
    const raw = serializeLayout(state);
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    expect(deserializeLayout(raw, WIDE)?.fractions.note).toBeCloseTo(state.fractions.note, 3);
    expect(deserializeLayout(null, WIDE)).toBeNull();
    for (const value of ["{", "null", "[]", '{"v":2}', '{"v":1,"tree":0.2,"note":0.5}', '{"v":1,"tree":0,"note":0.5,"graph":0.5}']) {
      expect(deserializeLayout(value, WIDE)).toBeNull();
    }
    expect(deserializeLayout('{"v":1,"tree":9,"note":9,"graph":9}', WIDE)).not.toBeNull();
    const loaded = loadLayout(storage({ [LAYOUT_STORAGE_KEY]: raw }), WIDE);
    expect(loaded.fractions.note).toBeCloseTo(state.fractions.note, 3);
    expect(loadLayout({ getItem: () => { throw new Error(); }, setItem: vi.fn() }, WIDE).fractions.note).toBeCloseTo(DEFAULT_FRACTIONS.note, 2);
  });

  it("best-effort saves and writes custom properties", () => {
    const target = storage();
    expect(saveLayout(target, defaultLayout(WIDE))).toBe(true);
    expect(target.map.has(LAYOUT_STORAGE_KEY)).toBe(true);
    expect(saveLayout({ getItem: () => null, setItem: () => { throw new Error(); } }, defaultLayout(WIDE))).toBe(false);
  });
});

describe("drag handlers", () => {
  it("tracks from the pointer origin and persists only changes", () => {
    let state = defaultLayout(WIDE);
    const persist = vi.fn();
    const host = { layout: () => state, width: () => WIDE, setLayout: (next: LayoutState) => { state = next; }, persist };
    const drag = beginDrag("tree", 10, state);
    expect(dragTo(drag, 10, WIDE)).toBe(state);
    expect(dragChanged(drag, state)).toBe(false);
    const handlers = dividerHandlers(host);
    handlers.onMove(100);
    handlers.onUp();
    handlers.onDown("tree", 10);
    handlers.onMove(100);
    handlers.onUp();
    expect(persist).toHaveBeenCalledTimes(1);
    handlers.onKey("tree", "ArrowLeft");
    handlers.onKey("tree", "Tab");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(nudgeFor("ArrowRight")).toBe(24);
    expect(nudgeFor("ArrowLeft")).toBe(-24);
    expect(nudgeFor("Tab")).toBe(0);
  });
});
