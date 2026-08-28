/**
 * TUI-specific view-model tests: `sanitizeTerminalText`, the
 * `ExplorerState`/`reduce` state machine, and the theme maps.
 *
 * The portable projections (treeRows/detailModel/focusModel/healthModel/…)
 * moved to `src/core/view` and are tested in `tests/core/view/`
 * (weave-workspace §3). A re-export smoke test below pins that TUI files can
 * still reach them through `./model`.
 */

import { describe, expect, it } from "vitest";
import type { NoteSource } from "../../src/core/types";
import {
  countProvenance,
  degreeOf,
  deriveBacklinks,
  detailModel,
  focusModel,
  focusNeighborhood,
  formatTreeMeta,
  graphRoots,
  healthModel,
  initialState,
  listLabel,
  mergeAfterRefresh,
  reduce,
  relTime,
  sanitizeTerminalText,
  treeEmptyHint,
  treeRows,
  type ExplorerState,
  type ReduceCtx,
} from "../../src/pi/viewer/tui/model";
import { provenanceStyle, kindStyle, PROVENANCE_CYCLE } from "../../src/pi/viewer/tui/theme";

// ---------------------------------------------------------------------------
// sanitizeTerminalText
// ---------------------------------------------------------------------------

describe("sanitizeTerminalText", () => {
  it("strips ANSI/OSC/BEL and C0 controls, keeps newlines and tabs", () => {
    const hostile = "title\x1b[31mred\x1b[0m\x07\x9b\x00\x01\x0bnormal";
    const out = sanitizeTerminalText(hostile);
    expect(out).toBe("title[31mred[0mnormal");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x9b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\x0b");
    // newlines/tabs preserved
    expect(sanitizeTerminalText("a\nb\tc")).toBe("a\nb\tc");
  });
});

// ---------------------------------------------------------------------------
// reduce — key→state transitions
// ---------------------------------------------------------------------------

function st(over: Partial<ExplorerState> = {}): ExplorerState {
  return {
    surface: "tree",
    searching: false,
    selectedId: "vault",
    focusId: null,
    detailId: null,
    expanded: new Set(["vault"]),
    showInternals: false,
    provFilter: null,
    query: "",
    helpOpen: false,
    refreshing: false,
    version: 0,
    scrollOffset: 0,
    ...over,
  };
}

function ctxRows(ids: string[]): ReduceCtx {
  return { rows: ids.map((id) => ({ id })), window: 24 };
}

describe("reduce", () => {
  it("down moves selection and clamps to last row", () => {
    const rows = ctxRows(["vault", "note:a", "note:b"]);
    let s = reduce(st(), { type: "down" }, rows);
    expect(s.selectedId).toBe("note:a");
    s = reduce(s, { type: "down" }, rows);
    expect(s.selectedId).toBe("note:b");
    s = reduce(s, { type: "down" }, rows);
    expect(s.selectedId).toBe("note:b"); // clamped
  });

  it("up moves selection and clamps to first row", () => {
    const rows = ctxRows(["vault", "note:a", "note:b"]);
    let s = st({ selectedId: "note:b" });
    s = reduce(s, { type: "up" }, rows);
    expect(s.selectedId).toBe("note:a");
    s = reduce(st({ selectedId: "vault" }), { type: "up" }, rows);
    expect(s.selectedId).toBe("vault"); // clamped
  });

  it("home/end jump to first/last; pageUp/pageDown page", () => {
    const rows = ctxRows(["a", "b", "c", "d", "e"]);
    expect(reduce(st({ selectedId: "c" }), { type: "home" }, rows).selectedId).toBe("a");
    expect(reduce(st({ selectedId: "c" }), { type: "end" }, rows).selectedId).toBe("e");
    const s = reduce(st({ selectedId: "a" }), { type: "pageDown" }, { rows: rows.rows, window: 2 });
    expect(s.selectedId).toBe("c"); // a + 2 = index 2
  });

  it("right expands a collapsed node, then moves to first child", () => {
    const rows: ReduceCtx = {
      rows: [
        { id: "vault" },
        { id: "note:a" },
      ],
      window: 24,
    };
    // simulate tree row metadata by giving the selected row hasKids+expanded via state
    // reduce's right-branch reads TreeRow fields off the row; cast for the test
    const treeRows = [
      { id: "vault", depth: 0, hasKids: true, expanded: false, label: "Vault", kind: "vault" as const, provenance: null, meta: "" },
      { id: "note:a", depth: 1, hasKids: false, expanded: false, label: "A", kind: "note" as const, provenance: "human", meta: "" },
    ];
    let s = reduce(st({ selectedId: "vault" }), { type: "right" }, { rows: treeRows, window: 24 });
    expect(s.expanded.has("vault")).toBe(true);
    // right again on an expanded node moves to first child
    s = reduce({ ...s, selectedId: "vault" }, { type: "right" }, { rows: treeRows, window: 24 });
    expect(s.selectedId).toBe("note:a");
  });

  it("left collapses an expanded node, or jumps to parent", () => {
    const treeRows = [
      { id: "vault", depth: 0, hasKids: true, expanded: true, label: "Vault", kind: "vault" as const, provenance: null, meta: "" },
      { id: "note:a", depth: 1, hasKids: false, expanded: false, label: "A", kind: "note" as const, provenance: "human", meta: "" },
    ];
    const s = reduce(st({ selectedId: "note:a", expanded: new Set(["vault"]) }), { type: "left" }, { rows: treeRows, window: 24 });
    expect(s.selectedId).toBe("vault"); // jumped to parent
  });

  it("enter on a tree row opens detail for the selection", () => {
    const s = reduce(st({ selectedId: "note:a" }), { type: "enter" }, ctxRows(["note:a"]));
    expect(s.surface).toBe("detail");
    expect(s.detailId).toBe("note:a");
  });

  it("enter on a detail link jumps to its target", () => {
    const rows: ReduceCtx = { rows: [{ id: "link:note:b", target: "note:b" }], window: 24 };
    const s = reduce(st({ surface: "detail", detailId: "note:a", selectedId: "link:note:b" }), { type: "enter" }, rows);
    expect(s.detailId).toBe("note:b");
    expect(s.selectedId).toBe("note:b");
  });

  it("enter on a focus neighbor re-centers focus", () => {
    const rows: ReduceCtx = { rows: [{ id: "note:b", target: "note:b" }], window: 24 };
    const s = reduce(st({ surface: "focus", focusId: "note:a", selectedId: "note:b" }), { type: "enter" }, rows);
    expect(s.focusId).toBe("note:b");
  });

  it("esc precedence: search > detail > focus > tree-quit", () => {
    // search clears filter
    let s = reduce(st({ searching: true, query: "x" }), { type: "esc" });
    expect(s.searching).toBe(false);
    expect(s.query).toBe("");
    // detail → tree
    s = reduce(st({ surface: "detail", detailId: "x" }), { type: "esc" });
    expect(s.surface).toBe("tree");
    // focus → tree
    s = reduce(st({ surface: "focus", focusId: "x" }), { type: "esc" });
    expect(s.surface).toBe("tree");
    expect(s.focusId).toBeNull();
    // health → tree
    s = reduce(st({ surface: "health" }), { type: "esc" });
    expect(s.surface).toBe("tree");
    // tree → quit signal (component resolves done)
    s = reduce(st({ surface: "tree" }), { type: "esc" });
    expect(s.surface).toBe("tree");
  });

  it("searchChar appends, backspace deletes, commit keeps filter", () => {
    let s = reduce(st({ searching: true }), { type: "searchChar", ch: "a" });
    s = reduce(s, { type: "searchChar", ch: "b" });
    expect(s.query).toBe("ab");
    s = reduce(s, { type: "searchBackspace" });
    expect(s.query).toBe("a");
    s = reduce(s, { type: "searchCommit" });
    expect(s.searching).toBe(false);
    expect(s.query).toBe("a"); // kept
  });

  it("searchChar is capped at MAX_FILTER_LEN", () => {
    let s = st({ searching: true, query: "x".repeat(200) });
    s = reduce(s, { type: "searchChar", ch: "y" });
    expect(s.query.length).toBe(200);
  });

  it("p cycles provenance filter all → human → agent → generated → all", () => {
    let s = reduce(st(), { type: "cycleProvenance" });
    expect(s.provFilter).toBe("human");
    s = reduce(s, { type: "cycleProvenance" });
    expect(s.provFilter).toBe("agent");
    s = reduce(s, { type: "cycleProvenance" });
    expect(s.provFilter).toBe("generated");
    s = reduce(s, { type: "cycleProvenance" });
    expect(s.provFilter).toBeNull();
  });

  it("i toggles internals; f enters focus; g/esc exits focus", () => {
    let s = reduce(st(), { type: "toggleInternals" });
    expect(s.showInternals).toBe(true);
    s = reduce(s, { type: "toggleInternals" });
    expect(s.showInternals).toBe(false);
    s = reduce(st({ selectedId: "note:a" }), { type: "focus" });
    expect(s.surface).toBe("focus");
    expect(s.focusId).toBe("note:a");
    s = reduce(s, { type: "focusExit" });
    expect(s.surface).toBe("tree");
    expect(s.focusId).toBeNull();
  });

  it("1/2 switch surfaces; r refreshes then done clears", () => {
    let s = reduce(st({ surface: "health" }), { type: "surfaceTree" });
    expect(s.surface).toBe("tree");
    s = reduce(st(), { type: "surfaceHealth" });
    expect(s.surface).toBe("health");
    s = reduce(st(), { type: "refresh" });
    expect(s.refreshing).toBe(true);
    s = reduce(s, { type: "refreshDone" });
    expect(s.refreshing).toBe(false);
  });

  it("? toggles help; ignores keys while searching where appropriate", () => {
    let s = reduce(st(), { type: "toggleHelp" });
    expect(s.helpOpen).toBe(true);
    // provenance cycle ignored during search
    s = reduce(st({ searching: true }), { type: "cycleProvenance" });
    expect(s.provFilter).toBeNull();
  });

  it("selection clamp after shrink falls back to first root", () => {
    // simulate refresh dropping the selected id from roots
    const merged = mergeAfterRefresh(st({ selectedId: null }), ["vault", "repository"]);
    expect(merged.selectedId).toBe("vault");
  });

  it("scroll offset keeps the selection within the window", () => {
    const rows = ctxRows(["a", "b", "c", "d", "e"]).rows;
    const s = reduce(st({ selectedId: "a", scrollOffset: 0 }), { type: "down" }, { rows, window: 2 });
    // selection b at index 1, window 2, offset 0 → 0 <= 1 < 2, stays 0
    expect(s.scrollOffset).toBe(0);
    const s2 = reduce(st({ selectedId: "c", scrollOffset: 0 }), { type: "down" }, { rows, window: 2 });
    // selection d at index 3, offset 0 → 3 >= 0+2 → offset = 3-2+1 = 2
    expect(s2.scrollOffset).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// theme maps
// ---------------------------------------------------------------------------

describe("theme maps", () => {
  it("provenanceStyle maps each source to glyph+dim+slot", () => {
    expect(provenanceStyle("human").glyph).toBe("●");
    expect(provenanceStyle("human").dim).toBe(false);
    expect(provenanceStyle("agent").glyph).toBe("◐");
    expect(provenanceStyle("generated").dim).toBe(true);
    expect(provenanceStyle(null).glyph).toBe("");
  });

  it("kindStyle maps each kind to a glyph+slot", () => {
    expect(kindStyle("vault").glyph).toBe("◆");
    expect(kindStyle("repository").glyph).toBe("■");
    expect(kindStyle("gitState").glyph).toBe("⎇");
    expect(kindStyle("file").glyph).toBe("·");
    // notes defer to provenance glyph
    expect(kindStyle("note").glyph).toBe("");
  });

  it("PROVENANCE_CYCLE starts at null (all)", () => {
    expect(PROVENANCE_CYCLE[0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// re-export surface — TUI files import the portable view-models from ./model
// ---------------------------------------------------------------------------

describe("model re-exports the portable view-models", () => {
  it("every promoted symbol is reachable through ./model", () => {
    const model = {
      generatedAt: "",
      staleness: null,
      nodes: [
        { id: "vault", kind: "vault" as const, label: "Vault", provenance: null, detail: {} },
        { id: "note:a", kind: "note" as const, label: "A", provenance: "human" as NoteSource, detail: { updated: "2026-05-01T00:00:00.000Z" } },
      ],
      edges: [{ source: "vault", target: "note:a", kind: "contains" as const }],
      danglingLinks: {},
    };
    const rows = treeRows(model, { expanded: new Set(["vault"]), showInternals: false, provFilter: null, query: "" });
    expect(rows.map((r) => r.id)).toEqual(["vault", "note:a"]);
    expect(formatTreeMeta(rows[1]!.meta, Date.parse("2026-06-01T00:00:00.000Z"))).toBe("1mo ago");
    expect(treeEmptyHint(model)).toBeNull();
    expect(listLabel(model.nodes[0]!)).toBe("Vault");
    expect(graphRoots(model)).toEqual(["vault"]);
    expect(detailModel(model, "note:a")?.label).toBe("A");
    expect(focusModel(model, "note:a").center.id).toBe("note:a");
    expect(focusNeighborhood("note:a", model.edges).has("vault")).toBe(true);
    expect(degreeOf("note:a", model.edges)).toBe(1);
    expect(deriveBacklinks(model.edges).size).toBe(0);
    expect(healthModel(model).sections.some((s) => s.heading === "Vault")).toBe(true);
    expect(countProvenance(model.nodes).human).toBe(1);
    expect(relTime("2026-05-01T00:00:00.000Z", Date.parse("2026-06-01T00:00:00.000Z"))).toBe("1mo ago");
  });
});
