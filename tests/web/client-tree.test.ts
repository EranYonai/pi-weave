/**
 * The tree column's pure model (weave-workspace §1.2, §3, §10, P2.3).
 *
 * `Tree.tsx` is a `useState`, a `map` and four handlers; every decision it
 * appears to make is one of the functions below. So this suite *is* the tree
 * column's coverage rather than a proxy for it, which is the whole point of
 * §10's split: there is no DOM test environment and none is needed.
 *
 * The fixtures are real `GraphPayload`s built the way the server builds them
 * — `vault`/`repository` roots, `contains` edges, `note:` ids — because a
 * hand-shaped row list would test this module against a graph that cannot
 * occur and would pass while the real one broke.
 */

import { describe, expect, it } from "vitest";
import { treeRows } from "../../src/web/shared/view";
import type { TreeRow } from "../../src/web/shared/view";
import type { GraphPayload, WireGraphEdge, WireGraphNode, WireNodeKind, WireNoteSource } from "../../src/web/shared/wire";
import { ICONS } from "../../src/web/client/shell/icons.model";
import {
  FILTER_HINT,
  FILTER_LABEL,
  FILTER_PLACEHOLDER,
  PROVENANCE_CYCLE,
  SESSION_DIR,
  TREE_LABEL,
  collapse,
  cycleProvenance,
  depthVar,
  expand,
  idAt,
  indexOfRow,
  initialTreeView,
  internalsHint,
  internalsLabel,
  isMuted,
  isSessionNote,
  kindIcon,
  moveSelection,
  parentOf,
  provenanceGlyph,
  provenanceHint,
  provenanceLabel,
  provenanceTitle,
  rowCountLabel,
  rowDomId,
  rowView,
  rowViews,
  rowsFor,
  setQuery,
  toggleExpanded,
  toggleInternals,
  treeActiveDescendant,
  treeEmptyMessage,
  treeKey,
  treePositions,
  viewModel,
} from "../../src/web/client/tree/tree.model";
import type { TreeViewState } from "../../src/web/client/tree/tree.model";

// --- fixtures -----------------------------------------------------------------------

function node(
  id: string,
  kind: WireNodeKind,
  label: string,
  provenance: WireNoteSource | null = null,
  detail: Record<string, string> = {},
): WireGraphNode {
  return { id, kind, label, provenance, detail };
}

function payloadOf(nodes: WireGraphNode[], edges: WireGraphEdge[], dangling: Record<string, string[]> = {}): GraphPayload {
  return {
    model: { generatedAt: "2026-03-04T09:00:00Z", staleness: null, nodes, edges, contentDigest: "" },
    tags: {},
    dangling,
    positions: null,
    stamp: "2026-03-04T09:00:00Z",
  };
}

/**
 * A vault of three notes and a repository of two modules.
 *
 * Shaped to exercise every branch the model has: mixed provenance for the
 * filter, a nested module for depth and parent-climbing, and a `package` node
 * for the internals toggle.
 */
const GRAPH: GraphPayload = payloadOf(
  [
    node("vault", "vault", "Vault"),
    node("note:alpha", "note", "Alpha", "human", { updated: "2026-03-04T08:00:00Z" }),
    node("note:beta", "note", "Beta", "agent"),
    node("note:gamma", "note", "Gamma", "generated"),
    node("repository", "repository", "pi-weave", null, { files: "42" }),
    node("module:src/core", "module", "src/core", null, { path: "src/core", files: "12" }),
    node("module:src/web", "module", "src/web", null, { path: "src/web" }),
    node("package:package.json", "package", "pi-weave", null, { manifest: "package.json", kind: "npm" }),
  ],
  [
    { source: "vault", target: "note:alpha", kind: "contains" },
    { source: "vault", target: "note:beta", kind: "contains" },
    { source: "vault", target: "note:gamma", kind: "contains" },
    { source: "repository", target: "module:src/core", kind: "contains" },
    { source: "repository", target: "module:src/web", kind: "contains" },
    { source: "repository", target: "package:package.json", kind: "contains" },
  ],
  { alpha: ["missing-note"] },
);

/** Epoch ms matching the fixture's `generatedAt`, for stable relative times. */
const NOW = Date.parse("2026-03-04T09:00:00Z");

/**
 * A hand-built row for the presentation functions.
 *
 * `rowView` and its helpers never touch the graph — they read one flattened
 * `TreeRow` — so a literal is a more honest fixture for them than `rowsFor(...)`
 * on the whole payload: it names exactly the fields the presentation reads.
 */
const ALPHA_ROW: TreeRow = {
  id: "note:alpha",
  depth: 1,
  hasKids: false,
  expanded: false,
  label: "Alpha",
  kind: "note",
  provenance: "human",
  meta: null,
};

function ids(payload: GraphPayload, state: TreeViewState): string[] {
  return rowsFor(payload, state).map((row) => row.id);
}

// --- the initial state ----------------------------------------------------------------

describe("initialTreeView", () => {
  it("opens the roots, so the column is not two collapsed words", () => {
    const state = initialTreeView();
    expect([...state.expanded].sort()).toEqual(["repository", "vault"]);
    expect(state.showInternals).toBe(false);
    expect(state.provFilter).toBeNull();
    expect(state.query).toBe("");
  });

  it("takes the roots it should open, for a graph with different ones", () => {
    expect([...initialTreeView(["vault"]).expanded]).toEqual(["vault"]);
  });

  it("returns a fresh Set each call, so two mounts cannot alias one default", () => {
    // `expanded` is typed `ReadonlySet`, so the mutation has to be forced to
    // be written at all — which is the point: a shared default would only be
    // corruptible by something that had already gone around the type system,
    // and this asserts even that cannot reach the other mount.
    const a = initialTreeView();
    const b = initialTreeView();
    expect(a.expanded).not.toBe(b.expanded);
    (a.expanded as Set<string>).add("intruder");
    expect(b.expanded.has("intruder")).toBe(false);
  });
});

// --- the wire → view reassembly ---------------------------------------------------------

describe("viewModel", () => {
  it("puts danglingLinks back, which is the one field the wire splits out", () => {
    // §4.2: `WireGraphModel` is `Omit<GraphModel, "danglingLinks">` because
    // the payload hoists the map to its own top level. Every view-model call
    // in the client goes through here so that reassembly has one spelling.
    const model = viewModel(GRAPH);
    expect(model.danglingLinks).toEqual({ alpha: ["missing-note"] });
    expect(model.nodes).toBe(GRAPH.model.nodes);
    expect(model.generatedAt).toBe("2026-03-04T09:00:00Z");
  });

  it("produces something treeRows accepts without a cast", () => {
    expect(treeRows(viewModel(GRAPH), initialTreeView()).length).toBeGreaterThan(0);
  });
});

describe("rowsFor", () => {
  it("is empty before the first graph arrives, rather than throwing", () => {
    expect(rowsFor(null, initialTreeView())).toEqual([]);
  });

  it("flattens the expanded tree, roots first", () => {
    expect(ids(GRAPH, initialTreeView())).toEqual([
      "vault",
      "note:alpha",
      "note:beta",
      "note:gamma",
      "repository",
      "module:src/core",
      "module:src/web",
    ]);
  });

  it("hides repo plumbing until internals are shown", () => {
    const shown = ids(GRAPH, toggleInternals(initialTreeView()));
    expect(ids(GRAPH, initialTreeView())).not.toContain("package:package.json");
    expect(shown).toContain("package:package.json");
  });
});

// --- expansion reducers -----------------------------------------------------------------

describe("toggleExpanded", () => {
  it("closes an open row and opens a closed one", () => {
    const open = initialTreeView();
    const closed = toggleExpanded(open, "vault");
    expect(closed.expanded.has("vault")).toBe(false);
    expect(toggleExpanded(closed, "vault").expanded.has("vault")).toBe(true);
  });

  it("returns a new Set — a mutation would render nothing", () => {
    // Preact's useState bails on Object.is, so an in-place `expanded.add(id)`
    // produces a correct model and a frozen screen. This is that guard.
    const before = initialTreeView();
    const after = toggleExpanded(before, "vault");
    expect(after).not.toBe(before);
    expect(after.expanded).not.toBe(before.expanded);
    expect(before.expanded.has("vault")).toBe(true);
  });

  it("actually removes the collapsed subtree from the rows", () => {
    const collapsed = toggleExpanded(initialTreeView(), "vault");
    expect(ids(GRAPH, collapsed)).toEqual(["vault", "repository", "module:src/core", "module:src/web"]);
  });
});

describe("expand and collapse", () => {
  it("are idempotent, and return the same object when nothing changes", () => {
    // Identity, not just equality: a new object would re-render the column on
    // a key press that did nothing.
    const state = initialTreeView();
    expect(expand(state, "vault")).toBe(state);
    expect(collapse(state, "note:alpha")).toBe(state);
  });

  it("open and close when there is something to do", () => {
    const closed = collapse(initialTreeView(), "vault");
    expect(closed.expanded.has("vault")).toBe(false);
    expect(expand(closed, "vault").expanded.has("vault")).toBe(true);
  });
});

// --- filtering ---------------------------------------------------------------------------

describe("setQuery", () => {
  it("stores the text and keeps the rest of the state", () => {
    const next = setQuery(initialTreeView(), "alph");
    expect(next.query).toBe("alph");
    expect(next.showInternals).toBe(false);
  });

  it("returns the same object for an unchanged query", () => {
    const state = initialTreeView();
    expect(setQuery(state, "")).toBe(state);
  });

  it("prunes to matches and their ancestors, auto-expanding the path", () => {
    // The filter semantics belong to core's `treeRows`; what is asserted here
    // is that the client hands it the query in the shape it expects.
    expect(ids(GRAPH, setQuery(initialTreeView(), "alpha"))).toEqual(["vault", "note:alpha"]);
  });

  it("filters case-insensitively", () => {
    expect(ids(GRAPH, setQuery(initialTreeView(), "ALPHA"))).toEqual(["vault", "note:alpha"]);
  });

  it("finds nothing for a query that matches nothing", () => {
    expect(ids(GRAPH, setQuery(initialTreeView(), "zzz"))).toEqual([]);
  });
});

describe("cycleProvenance", () => {
  it("declares the same cycle the TUI's `p` key walks", () => {
    expect(PROVENANCE_CYCLE).toEqual([null, "human", "agent", "generated"]);
  });

  it("walks all → human → agent → generated → all", () => {
    let state = initialTreeView();
    const seen: (WireNoteSource | null)[] = [state.provFilter];
    for (let i = 0; i < 4; i++) {
      state = cycleProvenance(state);
      seen.push(state.provFilter);
    }
    expect(seen).toEqual([null, "human", "agent", "generated", null]);
  });

  it("recovers to `all` from a filter outside the cycle", () => {
    // `indexOf` gives -1 and `(-1 + 1) % 4` is 0. A state that somehow held a
    // stale provenance therefore un-sticks on the next press.
    const rogue = { ...initialTreeView(), provFilter: "ancient" as unknown as WireNoteSource };
    expect(cycleProvenance(rogue).provFilter).toBeNull();
  });

  it("prunes the tree to one provenance", () => {
    const human = cycleProvenance(initialTreeView());
    expect(ids(GRAPH, human)).toEqual(["vault", "note:alpha"]);
    expect(ids(GRAPH, cycleProvenance(human))).toEqual(["vault", "note:beta"]);
  });
});

describe("toggleInternals", () => {
  it("flips the flag and preserves everything else", () => {
    const on = toggleInternals(setQuery(initialTreeView(), "x"));
    expect(on.showInternals).toBe(true);
    expect(on.query).toBe("x");
    expect(toggleInternals(on).showInternals).toBe(false);
  });
});

// --- keyboard navigation -------------------------------------------------------------------

describe("indexOfRow", () => {
  const rows = rowsFor(GRAPH, initialTreeView());

  it("finds a row by id", () => {
    expect(indexOfRow(rows, "note:beta")).toBe(2);
  });

  it("is -1 for nothing selected and for a row that is not visible", () => {
    expect(indexOfRow(rows, null)).toBe(-1);
    expect(indexOfRow(rows, "package:package.json")).toBe(-1);
  });
});

describe("idAt", () => {
  const rows = rowsFor(GRAPH, initialTreeView());

  it("reads the id at an index", () => {
    expect(idAt(rows, 0)).toBe("vault");
    expect(idAt(rows, rows.length - 1)).toBe("module:src/web");
  });

  it("is null outside the list, which is what makes the guard reachable", () => {
    // The reason this is a function rather than an inline `?? null` at four
    // call sites: with `noUncheckedIndexedAccess`, an inline guard behind
    // already-clamped arithmetic is a branch no test can take, and a
    // permanently-uncovered branch makes the 95 % gate mean less.
    expect(idAt(rows, -1)).toBeNull();
    expect(idAt(rows, rows.length)).toBeNull();
    expect(idAt([], 0)).toBeNull();
  });
});

describe("moveSelection", () => {
  const rows = rowsFor(GRAPH, initialTreeView());

  it("steps down and up through the visible rows", () => {
    expect(moveSelection(rows, "vault", 1)).toBe("note:alpha");
    expect(moveSelection(rows, "note:alpha", -1)).toBe("vault");
  });

  it("clamps at both ends rather than wrapping", () => {
    // Position carries meaning in a tree; wrapping from the last note back to
    // `vault` reads as a glitch.
    expect(moveSelection(rows, "vault", -1)).toBe("vault");
    expect(moveSelection(rows, "module:src/web", 1)).toBe("module:src/web");
  });

  it("starts at the top going down and the bottom going up, with no selection", () => {
    expect(moveSelection(rows, null, 1)).toBe("vault");
    expect(moveSelection(rows, null, -1)).toBe("module:src/web");
  });

  it("is null when there are no rows at all", () => {
    expect(moveSelection([], null, 1)).toBeNull();
  });

  it("treats an off-screen selection as no selection", () => {
    expect(moveSelection(rows, "package:package.json", 1)).toBe("vault");
  });
});

describe("parentOf", () => {
  const rows = rowsFor(GRAPH, initialTreeView());

  it("finds the containing row by scanning up for a shallower depth", () => {
    expect(parentOf(rows, "note:beta")).toBe("vault");
    expect(parentOf(rows, "module:src/core")).toBe("repository");
  });

  it("is null for a root and for the very first row", () => {
    expect(parentOf(rows, "vault")).toBeNull();
    expect(parentOf(rows, "repository")).toBeNull();
  });

  it("is null for a row that is not visible", () => {
    expect(parentOf(rows, "package:package.json")).toBeNull();
  });
});

describe("treeKey", () => {
  const state = initialTreeView();
  const rows = rowsFor(GRAPH, state);

  it("moves the selection with the arrows", () => {
    expect(treeKey(rows, state, "vault", "ArrowDown")).toMatchObject({ selectedId: "note:alpha", handled: true });
    expect(treeKey(rows, state, "note:alpha", "ArrowUp")).toMatchObject({ selectedId: "vault", handled: true });
  });

  it("refuses every key while the user is typing into the filter", () => {
    // The filter box sits inside the listened element, so `j` in a query like
    // "jack" once arrived here as an alias and moved the cursor instead of
    // entering the character. While typing, nothing is tree navigation.
    for (const raw of ["j", "k", "ArrowDown", "Home"]) {
      expect(treeKey(rows, state, "vault", raw, true), raw).toMatchObject({ handled: false });
    }
  });

  it("jumps to the ends with Home and End", () => {
    expect(treeKey(rows, state, "note:beta", "Home").selectedId).toBe("vault");
    expect(treeKey(rows, state, "note:beta", "End").selectedId).toBe("module:src/web");
  });

  it("gives null ends for an empty tree rather than crashing", () => {
    expect(treeKey([], state, null, "Home").selectedId).toBeNull();
    expect(treeKey([], state, null, "End").selectedId).toBeNull();
  });

  it("leaves unrelated keys alone, so Tab still escapes the column", () => {
    const result = treeKey(rows, state, "vault", "Tab");
    expect(result.handled).toBe(false);
    expect(result.state).toBe(state);
    expect(result.selectedId).toBe("vault");
  });

  it("ignores the arrows when nothing, or nothing visible, is selected", () => {
    expect(treeKey(rows, state, null, "ArrowRight").handled).toBe(false);
    expect(treeKey(rows, state, "package:package.json", "ArrowLeft").handled).toBe(false);
  });

  describe("ArrowRight", () => {
    it("opens a closed row", () => {
      const closed = toggleExpanded(state, "vault");
      const closedRows = rowsFor(GRAPH, closed);
      const result = treeKey(closedRows, closed, "vault", "ArrowRight");
      expect(result.handled).toBe(true);
      expect(result.state.expanded.has("vault")).toBe(true);
      expect(result.selectedId).toBe("vault");
    });

    it("steps into the first child of an already-open row", () => {
      expect(treeKey(rows, state, "vault", "ArrowRight").selectedId).toBe("note:alpha");
    });

    it("does nothing on a leaf", () => {
      expect(treeKey(rows, state, "note:alpha", "ArrowRight").handled).toBe(false);
    });
  });

  describe("ArrowLeft", () => {
    it("closes an open row", () => {
      const result = treeKey(rows, state, "vault", "ArrowLeft");
      expect(result.handled).toBe(true);
      expect(result.state.expanded.has("vault")).toBe(false);
      expect(result.selectedId).toBe("vault");
    });

    it("climbs to the parent from a leaf — the gesture nobody implements", () => {
      expect(treeKey(rows, state, "note:beta", "ArrowLeft").selectedId).toBe("vault");
    });

    it("climbs from a closed row with children", () => {
      const closed = toggleExpanded(state, "module:src/core");
      const closedRows = rowsFor(GRAPH, closed);
      expect(treeKey(closedRows, closed, "module:src/core", "ArrowLeft").selectedId).toBe("repository");
    });

    it("does nothing at a closed root, which has nowhere to climb", () => {
      const closed = toggleExpanded(state, "vault");
      const closedRows = rowsFor(GRAPH, closed);
      expect(treeKey(closedRows, closed, "vault", "ArrowLeft").handled).toBe(false);
    });
  });
});

// --- presentation -----------------------------------------------------------------------------

describe("kindIcon", () => {
  it("has a distinct sprite glyph for every node kind", () => {
    const kinds: WireNodeKind[] = ["vault", "note", "repository", "module", "package", "entryPoint", "gitState", "external", "file"];
    const icons = kinds.map(kindIcon);
    expect(new Set(icons).size).toBe(kinds.length);
    // And every name is one the sprite can actually draw — a kind added to
    // core and not to icons.model.ts is a missing glyph, not an `undefined`
    // reaching the .tsx.
    for (const icon of icons) expect(ICONS[icon], icon).toBeDefined();
  });

  it("keeps the solid/hollow pair the TUI uses for the two roots", () => {
    // `vault` ◆ against `gitState` ◇ is the one filled/outline distinction the
    // old text glyphs carried; losing it would cost a real distinction.
    expect(ICONS[kindIcon("vault")].filled).toBe(true);
    expect(ICONS[kindIcon("gitState")].filled).toBe(false);
   });
});

describe("session rows (the synthesized sessions fold)", () => {
  it("recognises a session note by path, not by kind — core reuses the module kind", () => {
    expect(isSessionNote("note:sessions/2026-08-29")).toBe(true);
    expect(isSessionNote("note:sessions/deep/note")).toBe(true);
    expect(isSessionNote("note:alpha")).toBe(false);
    expect(isSessionNote("module:sessions")).toBe(false);
    expect(isSessionNote("note:sessions")).toBe(false);
  });

  it("names the folder the same spelling core's graph builder uses", () => {
    // The id format is a cross-tier contract; a typo here would mute nothing
    // and nobody would notice without this pin.
    expect(SESSION_DIR).toBe("sessions");
  });

  it("mutes session notes so forty near-duplicates stop competing with notes", () => {
    expect(isMuted({ ...ALPHA_ROW, id: "note:sessions/2026-08-29" }, null)).toBe(true);
  });

  it("never mutes the selected row, wherever the selection came from", () => {
    // `selectedId` is §1.3's bus: the graph's stage click can select a session
    // row while the tree is scrolled elsewhere. Dimming a row the user just
    // chose would read as "the click did nothing".
    const session = { ...ALPHA_ROW, id: "note:sessions/2026-08-29" };
    expect(isMuted(session, "note:sessions/2026-08-29")).toBe(false);
    expect(isMuted(ALPHA_ROW, "note:alpha")).toBe(false);
  });
});

describe("provenanceGlyph", () => {
  it("marks agent and generated content distinctly from human — AGENTS.md rule 4", () => {
    // Shape, not colour: the marker must survive greyscale and colour
    // blindness, because "agent content never masquerades as human" is a
    // correctness property, not a styling preference.
    expect(provenanceGlyph("human")).toBe("●");
    expect(provenanceGlyph("agent")).toBe("◐");
    expect(provenanceGlyph("generated")).toBe("○");
    expect(new Set(["human", "agent", "generated"].map((p) => provenanceGlyph(p as WireNoteSource))).size).toBe(3);
  });

  it("shows nothing for a structural node, which has no provenance to claim", () => {
    expect(provenanceGlyph(null)).toBe("");
    expect(provenanceTitle(null)).toBe("");
  });

  it("spells the provenance out in the tooltip", () => {
    expect(provenanceTitle("agent")).toBe("agent-authored");
  });
});

describe("rowView", () => {
  const rows = rowsFor(GRAPH, initialTreeView());
  const vault = rows[0]!;
  const alpha = rows[1]!;

  it("resolves an expanded parent to an open twisty", () => {
    const view = rowView(vault, null, NOW);
    expect(view.twisty).toBe("open");
    expect(view.hasKids).toBe(true);
  });

  it("resolves a collapsed parent to a closed twisty", () => {
    const collapsed = rowsFor(GRAPH, toggleExpanded(initialTreeView(), "vault"))[0]!;
    expect(rowView(collapsed, null, NOW).twisty).toBe("closed");
  });

  it("resolves a leaf to no twisty at all", () => {
    const view = rowView(alpha, null, NOW);
    expect(view.twisty).toBe("leaf");
    // The leaf still carries the slot — the .tsx renders the `<span>`, the
    // model just says there is nothing in it.
    expect(view.hasKids).toBe(false);
  });

  it("marks the selected row and only that row", () => {
    expect(rowView(alpha, "note:alpha", NOW).selected).toBe(true);
    expect(rowView(vault, "note:alpha", NOW).selected).toBe(false);
  });

  it("formats the meta against the injected clock, never the wall clock", () => {
    // The note's `updated` is an hour before NOW.
    expect(rowView(alpha, null, NOW).meta).toBe("1h ago");
    expect(rowView(alpha, null, NOW + 86_400_000).meta).toBe("1d ago");
  });

  it("renders a count meta as the TUI phrases it", () => {
    const core = rowsFor(GRAPH, initialTreeView()).find((row) => row.id === "module:src/core")!;
    expect(rowView(core, null, NOW).meta).toBe("files=12");
  });

  it("carries a 1-based aria level over the 0-based depth", () => {
    expect(rowView(vault, null, NOW).level).toBe(1);
    expect(rowView(alpha, null, NOW).level).toBe(2);
    expect(rowView(alpha, null, NOW).depth).toBe(1);
  });

  it("carries the kind icon and provenance glyph the list item renders", () => {
    const view = rowView(alpha, null, NOW);
    expect(view.kindIcon).toBe("note");
    expect(view.provenanceGlyph).toBe("●");
    expect(view.label).toBe("Alpha");
  });

  it("mutes a session note and unmutes it when selected — via the view, not a .tsx branch", () => {
    const session: TreeRow = { ...ALPHA_ROW, id: "note:sessions/2026-08-29" };
    expect(rowView(session, null, NOW).muted).toBe(true);
    expect(rowView(session, "note:sessions/2026-08-29", NOW).muted).toBe(false);
    expect(rowView(ALPHA_ROW, null, NOW).muted).toBe(false);
  });
});

describe("rowViews", () => {
  it("resolves the whole list, so the component holds one map", () => {
    const views = rowViews(rowsFor(GRAPH, initialTreeView()), "note:beta", NOW);
    expect(views).toHaveLength(7);
    expect(views.filter((v) => v.selected).map((v) => v.id)).toEqual(["note:beta"]);
  });

  it("carries the set positions, so no caller has to remember to ask", () => {
    const views = rowViews(rowsFor(GRAPH, initialTreeView()), null, NOW);
    // The two roots are siblings even though three notes sit between them.
    expect(views.filter((v) => v.depth === 0).map((v) => [v.posinset, v.setsize])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

// --- ARIA (P4) ------------------------------------------------------------------------------

describe("treePositions", () => {
  const rows = rowsFor(GRAPH, initialTreeView());

  it("counts siblings that are not adjacent — the roots", () => {
    // The bug a run-based implementation has: `vault` and `repository` are
    // siblings with three of vault's children between them, and a
    // consecutive-run pass reports both as "1 of 1". Confidently wrong beats
    // missing only in the sense that it is worse.
    const positions = treePositions(rows);
    const roots = rows.map((row, i) => [row, positions[i]!] as const).filter(([row]) => row.depth === 0);
    expect(roots.map(([, p]) => p)).toEqual([
      { posinset: 1, setsize: 2 },
      { posinset: 2, setsize: 2 },
    ]);
  });

  it("numbers each level's children within their own parent", () => {
    const positions = treePositions(rows);
    const byId = new Map(rows.map((row, i) => [row.id, positions[i]!]));
    // Three notes under `vault`…
    expect(byId.get("note:alpha")).toEqual({ posinset: 1, setsize: 3 });
    expect(byId.get("note:gamma")).toEqual({ posinset: 3, setsize: 3 });
    // …and two modules under `repository`, restarting at 1 rather than
    // continuing the vault's count.
    expect(byId.get("module:src/core")).toEqual({ posinset: 1, setsize: 2 });
    expect(byId.get("module:src/web")).toEqual({ posinset: 2, setsize: 2 });
  });

  it("returns one position per row, in order", () => {
    expect(treePositions(rows)).toHaveLength(rows.length);
    expect(treePositions([])).toEqual([]);
  });

  it("survives a depth gap a truncated payload could produce", () => {
    // `treeRows` never emits one (a child is exactly one deeper than its
    // parent), but an undefined slot would silently drop the row from every
    // set, and a silent drop in an ARIA attribute is invisible until someone
    // uses a screen reader.
    const jagged = [
      { id: "a", kind: "vault" as const, label: "a", depth: 0, hasKids: true, expanded: true, provenance: null, meta: null },
      { id: "b", kind: "note" as const, label: "b", depth: 3, hasKids: false, expanded: false, provenance: null, meta: null },
    ];
    expect(treePositions(jagged)).toEqual([
      { posinset: 1, setsize: 1 },
      { posinset: 1, setsize: 1 },
    ]);
  });
});

describe("rowDomId", () => {
  it("is a valid CSS selector fragment, unlike the graph ids themselves", () => {
    // `module:src/web/client` is a legal HTML id and an illegal selector, and
    // `aria-activedescendant` is an id *reference* an implementation may build
    // a selector from.
    expect(rowDomId("module:src/web/client")).toBe("weave-row-module-src-web-client");
    for (const row of rowsFor(GRAPH, initialTreeView())) {
      expect(rowDomId(row.id), row.id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("is what the row view carries, so the two cannot disagree", () => {
    const view = rowViews(rowsFor(GRAPH, initialTreeView()), null, NOW)[1]!;
    expect(view.domId).toBe(rowDomId(view.id));
  });
});

describe("treeActiveDescendant", () => {
  const rows = rowsFor(GRAPH, initialTreeView());

  it("names the selected row", () => {
    expect(treeActiveDescendant(rows, "note:beta")).toBe(rowDomId("note:beta"));
  });

  it("is null when nothing is selected", () => {
    expect(treeActiveDescendant(rows, null)).toBeNull();
  });

  it("is null when the selection is not a visible row", () => {
    // The selection is §1.3's bus and can name a node the tree has filtered
    // away or collapsed under a closed parent. Pointing the attribute at an
    // id that is not in the DOM is worse than omitting it: it is a promise
    // that the element exists, and a reader following a dangling one
    // announces nothing while the user is certain something is selected.
    expect(treeActiveDescendant(rows, "package:package.json")).toBeNull();
    const filtered = rowsFor(GRAPH, { ...initialTreeView(), query: "alpha" });
    expect(treeActiveDescendant(filtered, "note:beta")).toBeNull();
  });
});

describe("the tree's accessible names", () => {
  it("names what is in the column rather than repeating the widget type", () => {
    // "Tree" is already the column heading and `role="tree"` announces the
    // type; a third "tree" would be read three times.
    expect(TREE_LABEL.toLowerCase()).not.toContain("tree");
    expect(TREE_LABEL).toBe("Vault and repository");
  });

  it("teaches the key that focuses the filter box", () => {
    expect(FILTER_HINT).toContain("/");
    expect(FILTER_LABEL).not.toBe("");
  });
});

describe("depthVar", () => {
  it("emits the depth as a custom property, not a pixel width", () => {
    // The stylesheet multiplies by an indent step it owns, so density stays a
    // CSS decision. It reaches the DOM through the CSSOM, which `style-src`
    // does not govern (see cssvars.ts).
    expect(depthVar(2)).toEqual({ "--weave-depth": "2" });
  });

  it("floors at zero, so a negative depth cannot produce a negative indent", () => {
    expect(depthVar(-3)).toEqual({ "--weave-depth": "0" });
  });
});

// --- the control strip ---------------------------------------------------------------------

describe("the control strip's copy", () => {
  it("labels the unfiltered provenance state honestly", () => {
    expect(provenanceLabel(null)).toBe("all");
    expect(provenanceLabel("generated")).toBe("generated");
  });

  it("names what the next press will do, rather than what the state is", () => {
    expect(provenanceHint(null)).toContain("click for human");
    expect(provenanceHint("generated")).toContain("click for all");
  });

  it("names the internals toggle by what is on screen", () => {
    expect(internalsLabel(false)).toBe("knowledge");
    expect(internalsLabel(true)).toBe("internals");
    expect(internalsHint(false)).toContain("click to show");
    expect(internalsHint(true)).toContain("click to hide");
  });

  it("has a filter placeholder", () => {
    expect(FILTER_PLACEHOLDER).toBe("filter…");
  });
});

// --- empty states ------------------------------------------------------------------------------

describe("treeEmptyMessage", () => {
  it("says loading before the first graph, not `empty`", () => {
    expect(treeEmptyMessage(null, [], initialTreeView())).toBe("loading…");
  });

  it("is null when there are rows to render", () => {
    const state = initialTreeView();
    expect(treeEmptyMessage(GRAPH, rowsFor(GRAPH, state), state)).toBeNull();
  });

  it("blames the filter when a filter is what emptied the list", () => {
    // The failure this prevents: telling a user their vault is empty because
    // they typed a typo into the filter box.
    const query = setQuery(initialTreeView(), "zzz");
    expect(treeEmptyMessage(GRAPH, rowsFor(GRAPH, query), query)).toBe("nothing matches this filter — clear it to see the whole vault");
    // Same for a provenance filter that matches no note in a populated vault.
    const onlyHuman = payloadOf(
      [node("vault", "vault", "Vault"), node("note:beta", "note", "Beta", "agent")],
      [{ source: "vault", target: "note:beta", kind: "contains" }],
    );
    const prov = cycleProvenance(initialTreeView());
    expect(treeEmptyMessage(onlyHuman, rowsFor(onlyHuman, prov), prov)).toBe("nothing matches this filter — clear it to see the whole vault");
  });

  it("uses core's own hint for a genuinely empty vault, so TUI and web agree", () => {
    // And it outranks the row count, deliberately: an empty vault is *not* a
    // graph with no rows — `treeRows` still emits the `vault` root — so a
    // naive "no rows? explain why" order says nothing at all on a user's very
    // first session, which is the one time the hint is worth having.
    const empty = payloadOf([node("vault", "vault", "Vault")], []);
    const state = initialTreeView();
    expect(rowsFor(empty, state)).toHaveLength(1);
    expect(treeEmptyMessage(empty, rowsFor(empty, state), state)).toBe("no notes yet — add one with the weave_note tool");
  });

  it("keeps saying it even under a filter — `no matches` in an empty vault is useless", () => {
    const empty = payloadOf([node("vault", "vault", "Vault")], []);
    const query = setQuery(initialTreeView(), "zzz");
    expect(treeEmptyMessage(empty, rowsFor(empty, query), query)).toBe("no notes yet — add one with the weave_note tool");
  });

  it("falls back when core has no hint for the shape of graph it was given", () => {
    // A graph with no `vault` node at all: `treeEmptyHint` returns null
    // because it cannot tell whether that is an empty vault or a partial
    // payload, and the column still has to say something.
    const odd = payloadOf([], []);
    expect(treeEmptyMessage(odd, [], initialTreeView())).toBe("nothing to show");
  });
});

describe("rowCountLabel", () => {
  it("pluralises", () => {
    expect(rowCountLabel([])).toBe("0 rows");
    expect(rowCountLabel(rowsFor(GRAPH, setQuery(initialTreeView(), "alpha")))).toBe("2 rows");
  });

  it("says `1 row` for one", () => {
    const one = payloadOf([node("vault", "vault", "Vault")], []);
    expect(rowCountLabel(rowsFor(one, initialTreeView()))).toBe("1 row");
  });
});
