/**
 * The three-column layout model (weave-workspace §1.2).
 *
 * This is the largest pure surface in the browser client and there is no DOM
 * test environment in this repository — §10 keeps `.tsx` files down to
 * props-in/JSX-out precisely so that everything worth asserting can be
 * asserted here, in Node, with no jsdom. So this suite is exhaustive on
 * purpose: the drag arithmetic, both breakpoints, and every way a stored
 * value can be wrong.
 *
 * The invariant under most of it is the one from `normalizeFractions`: three
 * shares that sum to 1 with nobody under their floor. {@link expectValid}
 * asserts it, and is called after every operation that produces a state —
 * because a layout bug that only appears after two drags and a reload is a
 * bug that ships.
 */

import { describe, expect, it } from "vitest";
import {
  BREAKPOINT_MEDIUM,
  BREAKPOINT_NARROW,
  COLUMNS,
  DEFAULT_FRACTIONS,
  DIVIDERS,
  LAYOUT_STORAGE_KEY,
  MIN_WIDTHS,
  breakpointFor,
  columnValue,
  columnVar,
  columnVars,
  columnsAt,
  defaultLayout,
  deserializeLayout,
  dividerPair,
  isCollapsed,
  loadLayout,
  makeLayout,
  minShares,
  normalizeFractions,
  resizeAt,
  resolveColumns,
  saveLayout,
  serializeLayout,
} from "../../src/web/client/shell/layout.model";
import type { ColumnId, Columns, LayoutState, LayoutStorage } from "../../src/web/client/shell/layout.model";

/** A typical desktop, comfortably above both breakpoints. */
const WIDE = 1600;

function sum(fractions: Columns<number>): number {
  return fractions.tree + fractions.note + fractions.graph;
}

/** The load-bearing invariant. */
function expectValid(state: LayoutState, available = WIDE): void {
  expect(sum(state.fractions)).toBeCloseTo(1, 9);
  const floors = minShares(available);
  for (const id of COLUMNS) {
    expect(state.fractions[id]).toBeGreaterThanOrEqual(floors[id] - 1e-9);
  }
}

/** An in-memory {@link LayoutStorage}, optionally rigged to fail. */
function fakeStorage(seed: Record<string, string> = {}): LayoutStorage & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

// --- breakpoints --------------------------------------------------------------

describe("breakpointFor (§1.2)", () => {
  it.each([
    [2560, "wide"],
    [1600, "wide"],
    [BREAKPOINT_MEDIUM, "wide"],
    [BREAKPOINT_MEDIUM - 1, "medium"],
    [900, "medium"],
    [BREAKPOINT_NARROW, "medium"],
    [BREAKPOINT_NARROW - 1, "narrow"],
    [375, "narrow"],
    [0, "narrow"],
  ])("classifies %ipx as %s", (viewport, expected) => {
    expect(breakpointFor(viewport)).toBe(expected);
  });

  it("degrades to narrow rather than throwing on a nonsense width", () => {
    // A detached iframe or a test double can produce these; rendering the
    // single-column layout is a better failure than rendering nothing.
    expect(breakpointFor(Number.NaN)).toBe("narrow");
    expect(breakpointFor(Number.POSITIVE_INFINITY)).toBe("narrow");
    expect(breakpointFor(-100)).toBe("narrow");
  });

  it("puts the documented boundaries exactly where §1.2 says", () => {
    // "Below 1100 px the graph column collapses" — so 1100 itself is wide.
    expect(breakpointFor(1100)).toBe("wide");
    expect(breakpointFor(1099)).toBe("medium");
    expect(breakpointFor(800)).toBe("medium");
    expect(breakpointFor(799)).toBe("narrow");
  });
});

describe("columnsAt", () => {
  it("shows all three when wide", () => {
    expect(columnsAt("wide")).toEqual(["tree", "note", "graph"]);
  });

  it("collapses the graph first, keeping tree and note", () => {
    expect(columnsAt("medium")).toEqual(["tree", "note"]);
  });

  it("keeps the note column alone when narrow — notes are the product", () => {
    expect(columnsAt("narrow")).toEqual(["note"]);
  });

  it("never collapses the note column", () => {
    for (const breakpoint of ["wide", "medium", "narrow"] as const) {
      expect(columnsAt(breakpoint)).toContain("note");
    }
  });
});

describe("isCollapsed", () => {
  it.each([
    ["wide", "tree", false],
    ["wide", "graph", false],
    ["medium", "graph", true],
    ["medium", "tree", false],
    ["narrow", "tree", true],
    ["narrow", "graph", true],
    ["narrow", "note", false],
  ] as const)("%s / %s → %s", (breakpoint, column, expected) => {
    expect(isCollapsed(breakpoint, column)).toBe(expected);
  });
});

// --- normalisation ---------------------------------------------------------------

describe("normalizeFractions", () => {
  const floors = minShares(WIDE);

  it("leaves an already-valid split alone", () => {
    const result = normalizeFractions(DEFAULT_FRACTIONS, floors);
    expect(result.tree).toBeCloseTo(DEFAULT_FRACTIONS.tree, 9);
    expect(result.note).toBeCloseTo(DEFAULT_FRACTIONS.note, 9);
    expect(result.graph).toBeCloseTo(DEFAULT_FRACTIONS.graph, 9);
  });

  it("scales shares that do not sum to 1", () => {
    const result = normalizeFractions({ tree: 2, note: 4, graph: 2 }, floors);
    expect(sum(result)).toBeCloseTo(1, 9);
    expect(result.note).toBeCloseTo(0.5, 9);
  });

  it("scales shares that sum to less than 1", () => {
    const result = normalizeFractions({ tree: 0.1, note: 0.2, graph: 0.1 }, floors);
    expect(sum(result)).toBeCloseTo(1, 9);
  });

  it("is idempotent — normalising twice changes nothing", () => {
    const once = normalizeFractions({ tree: 0.9, note: 0.05, graph: 0.05 }, floors);
    const twice = normalizeFractions(once, floors);
    for (const id of COLUMNS) expect(twice[id]).toBeCloseTo(once[id], 12);
  });

  it("replaces NaN with the default rather than poisoning the sum", () => {
    // The important one: NaN propagates through every later addition, so one
    // corrupt share would otherwise break all three columns.
    const result = normalizeFractions({ tree: Number.NaN, note: 0.5, graph: 0.3 }, floors);
    expect(sum(result)).toBeCloseTo(1, 9);
    for (const id of COLUMNS) expect(Number.isFinite(result[id])).toBe(true);
  });

  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -0.4],
  ])("replaces a %s share with the default", (_label, bad) => {
    const result = normalizeFractions({ tree: 0.3, note: 0.4, graph: bad }, floors);
    expect(sum(result)).toBeCloseTo(1, 9);
    expect(result.graph).toBeGreaterThan(0);
  });

  it("lifts a starved column to its floor", () => {
    const result = normalizeFractions({ tree: 0.001, note: 0.5, graph: 0.499 }, floors);
    expect(result.tree).toBeCloseTo(floors.tree, 9);
    expect(sum(result)).toBeCloseTo(1, 9);
  });

  it("takes the deficit from the column with the most slack", () => {
    // note has far more room above its floor than graph, so it should give up
    // more of the width tree needs.
    const before = { tree: 0.02, note: 0.7, graph: 0.28 };
    const after = normalizeFractions(before, floors);
    const noteGave = before.note - after.note;
    const graphGave = before.graph - after.graph;
    expect(noteGave).toBeGreaterThan(graphGave);
    expect(sum(after)).toBeCloseTo(1, 9);
  });

  it("never pushes a donor below its own floor", () => {
    const result = normalizeFractions({ tree: 0.001, note: 0.001, graph: 0.998 }, floors);
    for (const id of COLUMNS) expect(result[id]).toBeGreaterThanOrEqual(floors[id] - 1e-9);
  });

  it("honours the floors over the sum when they cannot all fit", () => {
    // Deliberately impossible: three floors of 0.4 cannot coexist. The
    // documented resolution is that minimums win and the container scrolls.
    const impossible: Columns<number> = { tree: 0.4, note: 0.4, graph: 0.4 };
    const result = normalizeFractions({ tree: 0.1, note: 0.8, graph: 0.1 }, impossible);
    for (const id of COLUMNS) expect(result[id]).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(sum(result)).toBeGreaterThan(1);
  });

  it("needs no redistribution when every column already clears its floor", () => {
    const result = normalizeFractions({ tree: 0.33, note: 0.34, graph: 0.33 }, { tree: 0.1, note: 0.1, graph: 0.1 });
    expect(sum(result)).toBeCloseTo(1, 9);
  });
});

describe("minShares", () => {
  it("converts pixel minimums to fractions of the available width", () => {
    const shares = minShares(1000);
    expect(shares.tree).toBeCloseTo(MIN_WIDTHS.tree / 1000, 9);
    expect(shares.note).toBeCloseTo(MIN_WIDTHS.note / 1000, 9);
  });

  it("scales the floors down when they cannot all fit", () => {
    // 180 + 320 + 260 = 760, which is more than 90% of 700.
    const shares = minShares(700);
    expect(shares.tree + shares.note + shares.graph).toBeCloseTo(0.9, 9);
  });

  it("keeps the floors proportional when it scales them", () => {
    const shares = minShares(500);
    expect(shares.note / shares.tree).toBeCloseTo(MIN_WIDTHS.note / MIN_WIDTHS.tree, 9);
  });

  it("does not scale when there is room to spare", () => {
    const shares = minShares(2000);
    expect(shares.tree + shares.note + shares.graph).toBeLessThan(0.9);
  });

  it("survives a zero or nonsense width", () => {
    for (const width of [0, -50, Number.NaN]) {
      const shares = minShares(width);
      for (const id of COLUMNS) expect(Number.isFinite(shares[id])).toBe(true);
    }
  });
});

// --- construction ----------------------------------------------------------------

describe("makeLayout / defaultLayout", () => {
  it("produces a valid state from the §1.2 defaults", () => {
    expectValid(defaultLayout(WIDE));
  });

  it("defaults note-heavy, because notes are the product", () => {
    const state = defaultLayout(WIDE);
    expect(state.fractions.note).toBeGreaterThan(state.fractions.tree);
    expect(state.fractions.note).toBeGreaterThan(state.fractions.graph);
  });

  it("normalises whatever it is handed", () => {
    expectValid(makeLayout({ tree: 5, note: 1, graph: 1 }, WIDE));
  });
});

// --- resolution ------------------------------------------------------------------

describe("resolveColumns", () => {
  it("returns three pixel widths that fill the container when wide", () => {
    const resolved = resolveColumns(defaultLayout(WIDE), WIDE, "wide");
    expect(resolved.map((c) => c.id)).toEqual(["tree", "note", "graph"]);
    const total = resolved.reduce((acc, c) => acc + c.width, 0);
    expect(total).toBeCloseTo(WIDE, 6);
  });

  it("drops the graph and redistributes its width at medium", () => {
    const resolved = resolveColumns(defaultLayout(1000), 1000, "medium");
    expect(resolved.map((c) => c.id)).toEqual(["tree", "note"]);
    expect(resolved.reduce((acc, c) => acc + c.width, 0)).toBeCloseTo(1000, 6);
  });

  it("gives the whole container to the note column when narrow", () => {
    const resolved = resolveColumns(defaultLayout(600), 600, "narrow");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.id).toBe("note");
    expect(resolved[0]?.width).toBeCloseTo(600, 6);
  });

  it("does not let a collapsed column claw back width as invisible padding", () => {
    // The bug `restrictShares` exists to prevent: the graph's 260px floor
    // applying even though the graph is not rendered.
    const resolved = resolveColumns(defaultLayout(900), 900, "medium");
    expect(resolved.reduce((acc, c) => acc + c.width, 0)).toBeCloseTo(900, 6);
  });

  it("respects the pixel minimums of the columns it does render", () => {
    const skewed = makeLayout({ tree: 0.01, note: 0.5, graph: 0.49 }, WIDE);
    const resolved = resolveColumns(skewed, WIDE, "wide");
    const tree = resolved.find((c) => c.id === "tree");
    expect(tree?.width).toBeGreaterThanOrEqual(MIN_WIDTHS.tree - 1);
  });

  it("returns zero widths rather than NaN for a zero-width container", () => {
    // Happens for one frame before the first layout measurement lands.
    const resolved = resolveColumns(defaultLayout(WIDE), 0, "wide");
    for (const column of resolved) expect(column.width).toBe(0);
  });

  it("treats a nonsense container width as zero", () => {
    const resolved = resolveColumns(defaultLayout(WIDE), Number.NaN, "wide");
    for (const column of resolved) expect(column.width).toBe(0);
  });
});

// --- dragging --------------------------------------------------------------------

describe("dividerPair", () => {
  it("names the two columns each divider sits between", () => {
    expect(dividerPair("tree")).toEqual(["tree", "note"]);
    expect(dividerPair("note")).toEqual(["note", "graph"]);
  });

  it("exposes both dividers, left to right", () => {
    expect(DIVIDERS).toEqual(["tree", "note"]);
  });
});

describe("resizeAt", () => {
  it("moves width from the right column to the left on a positive delta", () => {
    const before = defaultLayout(WIDE);
    const after = resizeAt(before, "tree", 160, WIDE);
    expect(after.fractions.tree).toBeGreaterThan(before.fractions.tree);
    expect(after.fractions.note).toBeLessThan(before.fractions.note);
    expectValid(after);
  });

  it("moves width the other way on a negative delta", () => {
    const before = defaultLayout(WIDE);
    const after = resizeAt(before, "tree", -80, WIDE);
    expect(after.fractions.tree).toBeLessThan(before.fractions.tree);
    expect(after.fractions.note).toBeGreaterThan(before.fractions.note);
    expectValid(after);
  });

  it("leaves the third column untouched — the gesture is local", () => {
    const before = defaultLayout(WIDE);
    const after = resizeAt(before, "tree", 120, WIDE);
    expect(after.fractions.graph).toBeCloseTo(before.fractions.graph, 9);
  });

  it("moves width between note and graph across the second divider", () => {
    const before = defaultLayout(WIDE);
    const after = resizeAt(before, "note", 100, WIDE);
    expect(after.fractions.note).toBeGreaterThan(before.fractions.note);
    expect(after.fractions.graph).toBeLessThan(before.fractions.graph);
    expect(after.fractions.tree).toBeCloseTo(before.fractions.tree, 9);
  });

  it("translates pixels to fractions against the container width", () => {
    const before = defaultLayout(WIDE);
    const after = resizeAt(before, "tree", WIDE * 0.05, WIDE);
    expect(after.fractions.tree - before.fractions.tree).toBeCloseTo(0.05, 6);
  });

  it("stops at the wall instead of starving a column", () => {
    const before = defaultLayout(WIDE);
    const after = resizeAt(before, "tree", 100000, WIDE);
    expectValid(after);
    const floors = minShares(WIDE);
    expect(after.fractions.note).toBeCloseTo(floors.note, 6);
  });

  it("is stable once clamped — a mousemove storm at the wall is a no-op", () => {
    // The property that keeps signal subscribers from churning every frame
    // while the pointer keeps travelling past a stopped divider.
    const clamped = resizeAt(defaultLayout(WIDE), "tree", 100000, WIDE);
    expect(resizeAt(clamped, "tree", 500, WIDE)).toBe(clamped);
  });

  it("returns the identical object for a zero delta", () => {
    const before = defaultLayout(WIDE);
    expect(resizeAt(before, "tree", 0, WIDE)).toBe(before);
  });

  it.each([
    ["a nonsense delta", Number.NaN, WIDE],
    ["a zero container", 50, 0],
    ["a nonsense container", 50, Number.NaN],
  ])("returns the identical object for %s", (_label, delta, available) => {
    const before = defaultLayout(WIDE);
    expect(resizeAt(before, "tree", delta, available)).toBe(before);
  });

  it("round-trips: dragging out and back lands where it started", () => {
    const before = defaultLayout(WIDE);
    const after = resizeAt(resizeAt(before, "tree", 90, WIDE), "tree", -90, WIDE);
    for (const id of COLUMNS) expect(after.fractions[id]).toBeCloseTo(before.fractions[id], 9);
  });

  it("stays valid across a long sequence of drags", () => {
    let state = defaultLayout(WIDE);
    for (let i = 0; i < 60; i += 1) {
      const divider = DIVIDERS[i % DIVIDERS.length]!;
      state = resizeAt(state, divider, ((i % 7) - 3) * 45, WIDE);
      expectValid(state);
    }
  });
});

// --- collapsing ------------------------------------------------------------------

describe("isCollapsed", () => {
  it("hides the graph at medium and everything but the note when narrow", () => {
    expect(isCollapsed("medium", "graph")).toBe(true);
    expect(isCollapsed("medium", "tree")).toBe(false);
    expect(isCollapsed("narrow", "tree")).toBe(true);
    expect(isCollapsed("wide", "graph")).toBe(false);
  });
});

// --- persistence --------------------------------------------------------------------

describe("serializeLayout / deserializeLayout", () => {
  it("round-trips a layout", () => {
    const before = resizeAt(defaultLayout(WIDE), "tree", 130, WIDE);
    const after = deserializeLayout(serializeLayout(before), WIDE);
    expect(after).not.toBeNull();
    for (const id of COLUMNS) expect(after!.fractions[id]).toBeCloseTo(before.fractions[id], 3);
  });

  it("ignores a stored revealed set from the toggle era", () => {
    // The toggle never rendered, so every stored entry carries the key. The
    // reader must not choke on it — and must not resurrect it.
    const legacy = '{"v":1,"tree":0.33,"note":0.34,"graph":0.33,"revealed":["graph"]}';
    const after = deserializeLayout(legacy, WIDE);
    expect(after).not.toBeNull();
    expect(Object.keys(JSON.parse(serializeLayout(after!)) as Record<string, unknown>).sort()).toEqual([
      "graph",
      "note",
      "tree",
      "v",
    ]);
  });

  it("writes a versioned, human-readable object", () => {
    const parsed = JSON.parse(serializeLayout(defaultLayout(WIDE))) as Record<string, unknown>;
    expect(parsed["v"]).toBe(1);
    expect(Object.keys(parsed).sort()).toEqual(["graph", "note", "tree", "v"]);
  });

  it("rounds fractions to four decimals so a stored entry is readable", () => {
    const state = makeLayout({ tree: 1 / 3, note: 1 / 3, graph: 1 / 3 }, WIDE);
    expect(serializeLayout(state)).toContain("0.3333");
  });

  it("returns null for an absent entry", () => {
    expect(deserializeLayout(null, WIDE)).toBeNull();
  });

  it.each([
    ["not JSON", "{{{"],
    ["a bare string", '"hello"'],
    ["a number", "42"],
    ["null", "null"],
    ["an array — arrays are objects, and that is the trap", "[1,2,3]"],
    ["the wrong version", '{"v":2,"tree":0.2,"note":0.5,"graph":0.3}'],
    ["a missing version", '{"tree":0.2,"note":0.5,"graph":0.3}'],
    ["a missing column", '{"v":1,"tree":0.2,"note":0.5}'],
    ["a string column", '{"v":1,"tree":"0.2","note":0.5,"graph":0.3}'],
    ["a NaN column", '{"v":1,"tree":null,"note":0.5,"graph":0.3}'],
    ["a zero column", '{"v":1,"tree":0,"note":0.5,"graph":0.3}'],
    ["a negative column", '{"v":1,"tree":-0.2,"note":0.5,"graph":0.3}'],
  ])("rejects %s", (_label, raw) => {
    expect(deserializeLayout(raw, WIDE)).toBeNull();
  });

  it("accepts fractions that do not sum to 1 and repairs them", () => {
    // Not structural nonsense: `normalizeFractions` is total, so this is a
    // repair rather than a rejection.
    const state = deserializeLayout('{"v":1,"tree":9,"note":9,"graph":9}', WIDE);
    expect(state).not.toBeNull();
    expectValid(state!);
  });

  it("ignores a stored revealed field from the toggle era", () => {
    // Both the junk the old reader filtered and the string a hand-editor
    // would produce: unknown keys carry no meaning now.
    expect(deserializeLayout('{"v":1,"tree":0.2,"note":0.5,"graph":0.3,"revealed":"graph"}', WIDE)).not.toBeNull();
    expect(
      deserializeLayout('{"v":1,"tree":0.2,"note":0.5,"graph":0.3,"revealed":["graph","../etc/passwd",7]}', WIDE),
    ).not.toBeNull();
  });

  it("survives a hand-edited entry that a user typed into devtools", () => {
    // The realistic corruption: someone opens the storage pane, edits a
    // number, and leaves a trailing comma.
    expect(deserializeLayout('{"v":1,"tree":0.2,"note":0.5,"graph":0.3,}', WIDE)).toBeNull();
  });
});

describe("loadLayout", () => {
  it("reads a stored layout", () => {
    const stored = resizeAt(defaultLayout(WIDE), "tree", 130, WIDE);
    const storage = fakeStorage({ [LAYOUT_STORAGE_KEY]: serializeLayout(stored) });
    const loaded = loadLayout(storage, WIDE);
    for (const id of COLUMNS) expect(loaded.fractions[id]).toBeCloseTo(stored.fractions[id], 3);
  });

  it("falls back to the default when storage is empty", () => {
    expect(loadLayout(fakeStorage(), WIDE).fractions.note).toBeCloseTo(DEFAULT_FRACTIONS.note, 6);
  });

  it("falls back to the default when the stored value is corrupt", () => {
    const storage = fakeStorage({ [LAYOUT_STORAGE_KEY]: "not json at all" });
    expectValid(loadLayout(storage, WIDE));
  });

  it("falls back to the default when getItem throws", () => {
    // Safari private browsing, partitioned storage: the access itself throws.
    const hostile: LayoutStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    };
    expectValid(loadLayout(hostile, WIDE));
  });

  it("uses the namespaced key and nothing else", () => {
    const storage = fakeStorage({ layout: serializeLayout(defaultLayout(WIDE)) });
    expect(loadLayout(storage, WIDE)).toEqual(defaultLayout(WIDE));
  });
});

describe("saveLayout", () => {
  it("writes under the namespaced key and reports success", () => {
    const storage = fakeStorage();
    expect(saveLayout(storage, defaultLayout(WIDE))).toBe(true);
    expect(storage.map.get(LAYOUT_STORAGE_KEY)).toContain('"v":1');
  });

  it("reports failure instead of throwing when the quota is gone", () => {
    // A drag that has already been applied must not be undone by a storage
    // failure — the columns move, they just do not survive a reload.
    const full: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(saveLayout(full, defaultLayout(WIDE))).toBe(false);
  });

  it("round-trips through a real storage-shaped object", () => {
    const storage = fakeStorage();
    const state = resizeAt(defaultLayout(WIDE), "note", -70, WIDE);
    saveLayout(storage, state);
    const loaded = loadLayout(storage, WIDE);
    for (const id of COLUMNS) expect(loaded.fractions[id]).toBeCloseTo(state.fractions[id], 3);
  });
});

// --- CSS custom properties -------------------------------------------------------

describe("columnVar / columnValue / columnVars (CSP, §5.2)", () => {
  it("names a custom property per column", () => {
    expect(columnVar("tree")).toBe("--weave-col-tree");
    expect(columnVar("graph")).toBe("--weave-col-graph");
  });

  it("emits custom properties, not a style attribute — the CSP forbids inline styles", () => {
    // `style-src 'nonce-…'` with no 'unsafe-inline' blocks a literal style
    // attribute. These pairs are destined for `el.style.setProperty`, which is
    // CSSOM and therefore not subject to style-src.
    for (const id of COLUMNS) expect(columnVar(id).startsWith("--")).toBe(true);
  });

  it("rounds widths to whole pixels, because subpixel columns blur text", () => {
    expect(columnValue(340.4)).toBe("340px");
    expect(columnValue(340.6)).toBe("341px");
  });

  it("produces one pair per resolved column", () => {
    const resolved = resolveColumns(defaultLayout(WIDE), WIDE, "wide");
    const vars = columnVars(resolved);
    expect(vars).toHaveLength(3);
    expect(vars[0]).toEqual(["--weave-col-tree", columnValue(resolved[0]!.width)]);
  });

  it("emits only the visible columns at a breakpoint", () => {
    const vars = columnVars(resolveColumns(defaultLayout(900), 900, "medium"));
    expect(vars.map(([name]) => name)).toEqual(["--weave-col-tree", "--weave-col-note"]);
  });
});
