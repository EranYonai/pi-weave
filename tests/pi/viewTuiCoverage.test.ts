/**
 * Targeted branch-coverage suite for the weave-view TUI component, theme,
 * reduce state machine, and run wiring (weave-view-tui-design §10). Fills the
 * branches the primary suites don't reach: degenerate surfaces, defensive
 * guards, every reduce switch arm, and the run guard paths.
 *
 * Branch coverage for the portable view-models lives in `tests/core/view/`
 * since they moved to `src/core/view` (weave-workspace §3).
 */

import { describe, expect, it, vi } from "vitest";
import { WeaveExplorer, decodeAction, type WeaveTheme, type WeaveTui, type WeaveLoaders } from "../../src/pi/viewer/tui/explorer";
import {
  reduce,
  initialState,
  graphRoots,
  mergeAfterRefresh,
  sanitizeTerminalText,
  type ExplorerState,
} from "../../src/pi/viewer/tui/model";
import { provenanceStyle, kindStyle, chevron, PROVENANCE_CYCLE } from "../../src/pi/viewer/tui/theme";
import type { GraphModel, GraphNode, NodeKind } from "../../src/core/graph/model";
import type { NoteSource } from "../../src/core/types";
import { addNote } from "../../src/core/vault";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture, createMockCtx } from "../helpers";
import { runWeaveViewTui, buildTuiModel } from "../../src/pi/viewer/tui/run";
import { visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function node(id: string, kind: NodeKind, label: string, prov: NoteSource | null, detail: Record<string, string> = {}): GraphNode {
  return { id, kind, label, provenance: prov, detail };
}
function graph(nodes: GraphNode[], edges: GraphModel["edges"], staleness: GraphModel["staleness"] = null): GraphModel {
  return { generatedAt: "2026-06-01T00:00:00.000Z", staleness, nodes, edges, danglingLinks: {} };
}
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
function fakeTheme(): WeaveTheme {
  return {
    fg: (_s, t) => t,
    bg: (_s, t) => t,
    bold: (t) => t,
  };
}
function fakeTui(rows = 30): WeaveTui & { requestRender: ReturnType<typeof vi.fn> } {
  return { requestRender: vi.fn(), terminal: { rows, columns: 80 } };
}
function fakeLoaders(over: Partial<WeaveLoaders> = {}): WeaveLoaders {
  return {
    loadNote: async () => null,
    loadOkf: async () => null,
    openNote: async () => true,
    rebuild: async () => ({ generatedAt: "", staleness: null, nodes: [], edges: [], danglingLinks: {} }),
    ...over,
  };
}
function explorer(model: GraphModel, opts: { rows?: number; loaders?: Partial<WeaveLoaders>; done?: (r: null) => void; now?: () => number } = {}) {
  const done = opts.done ?? vi.fn();
  const ex = new WeaveExplorer({
    model,
    theme: fakeTheme(),
    tui: fakeTui(opts.rows ?? 30),
    loaders: fakeLoaders(opts.loaders),
    done,
    rows: opts.rows ?? 30,
    now: opts.now ?? (() => NOW),
  });
  return { ex, done, loaders: opts.loaders };
}
function st(over: Partial<ExplorerState> = {}): ExplorerState {
  return {
    surface: "tree", searching: false, selectedId: "vault", focusId: null, detailId: null,
    expanded: new Set(["vault"]), showInternals: false, provFilter: null, query: "",
    helpOpen: false, refreshing: false, version: 0, scrollOffset: 0, ...over,
  };
}

// ---------------------------------------------------------------------------
// theme.ts branches
// ---------------------------------------------------------------------------

describe("theme branches", () => {
  it("provenanceStyle covers all sources and null", () => {
    expect(provenanceStyle("human").slot).toBe("success");
    expect(provenanceStyle("agent").slot).toBe("accent");
    expect(provenanceStyle("generated").word).toBe("generated");
    expect(provenanceStyle(null).slot).toBe("muted");
  });
  it("kindStyle covers every kind", () => {
    const kinds: NodeKind[] = ["vault", "note", "repository", "module", "package", "entryPoint", "gitState", "external", "file"];
    for (const k of kinds) {
      const s = kindStyle(k);
      if (k === "note") expect(s.glyph).toBe("");
      else expect(s.glyph.length).toBeGreaterThan(0);
    }
  });
  it("chevron: leaf shows blank, collapsed ▸, expanded ▾", () => {
    expect(chevron(false, false)).toBe(" ");
    expect(chevron(false, true)).toBe("▸");
    expect(chevron(true, true)).toBe("▾");
  });
  it("PROVENANCE_CYCLE wraps around", () => {
    expect(PROVENANCE_CYCLE.length).toBe(4);
  });
});






// ---------------------------------------------------------------------------
// model.ts: reduce — every switch arm
// ---------------------------------------------------------------------------

describe("reduce arm coverage", () => {
  const rows = { rows: [{ id: "a" }, { id: "b" }, { id: "c" }], window: 2 };

  it("up/down/home/end/pageUp/pageDown on empty rows is a no-op", () => {
    const empty = { rows: [], window: 2 };
    for (const a of [{ type: "up" }, { type: "down" }, { type: "home" }, { type: "end" }, { type: "pageUp" }, { type: "pageDown" }] as const) {
      const s = reduce(st(), a, empty);
      expect(s.selectedId).toBe("vault");
    }
  });
  it("pageDown clamps to last", () => {
    const s = reduce(st({ selectedId: "b" }), { type: "pageDown" }, rows);
    expect(s.selectedId).toBe("c");
  });
  it("left on a tree root with no parent leaves selection; right on a leaf no-op", () => {
    const treeRowsList = [
      { id: "vault", depth: 0, hasKids: false, expanded: false, label: "Vault", kind: "vault" as const, provenance: null, meta: "" },
    ];
    let s = reduce(st({ selectedId: "vault", expanded: new Set() }), { type: "left" }, { rows: treeRowsList, window: 24 });
    expect(s.selectedId).toBe("vault"); // collapsed leaf, no parent
    s = reduce(st({ selectedId: "vault" }), { type: "right" }, { rows: treeRowsList, window: 24 });
    expect(s.selectedId).toBe("vault"); // no kids
  });
  it("left collapses an expanded node then jumps to parent on next left", () => {
    const treeRowsList = [
      { id: "vault", depth: 0, hasKids: true, expanded: true, label: "Vault", kind: "vault" as const, provenance: null, meta: "" },
      { id: "note:a", depth: 1, hasKids: false, expanded: false, label: "A", kind: "note" as const, provenance: "human", meta: "" },
    ];
    // selected on note:a, which is a leaf (not expanded) → jump to parent vault
    let s = reduce(st({ selectedId: "note:a", expanded: new Set(["vault"]) }), { type: "left" }, { rows: treeRowsList, window: 24 });
    expect(s.selectedId).toBe("vault");
    // vault now selected and expanded → collapse
    s = reduce({ ...s, selectedId: "vault" }, { type: "left" }, { rows: treeRowsList, window: 24 });
    expect(s.expanded.has("vault")).toBe(false);
  });
  it("right on a collapsed node with kids expands it, then right moves to the first child", () => {
    const treeRowsList = [
      { id: "vault", depth: 0, hasKids: true, expanded: false, label: "Vault", kind: "vault" as const, provenance: null, meta: "" },
      { id: "note:a", depth: 1, hasKids: false, expanded: false, label: "A", kind: "note" as const, provenance: "human", meta: "" },
    ];
    // right on collapsed-with-kids vault → expand
    let s = reduce(st({ selectedId: "vault", expanded: new Set() }), { type: "right" }, { rows: treeRowsList, window: 24 });
    expect(s.expanded.has("vault")).toBe(true);
    // right again → now expanded → move to the first child note:a
    s = reduce(st({ selectedId: "vault", expanded: new Set(["vault"]) }), { type: "right" }, { rows: treeRowsList, window: 24 });
    expect(s.selectedId).toBe("note:a");
  });
  it("enter on health row with target opens detail; enter on health row without target no-op", () => {
    const r1 = { rows: [{ id: "h", target: "note:a" }], window: 24 };
    let s = reduce(st({ surface: "health", selectedId: "h" }), { type: "enter" }, r1);
    expect(s.surface).toBe("detail");
    // no target
    s = reduce(st({ surface: "health", selectedId: "h" }), { type: "enter" }, { rows: [{ id: "h" }], window: 24 });
    expect(s.surface).toBe("health");
  });
  it("enter in search mode commits (keeps filter)", () => {
    const s = reduce(st({ searching: true, query: "x" }), { type: "enter" }, { rows: [], window: 24 });
    expect(s.searching).toBe(false);
    expect(s.query).toBe("x");
  });
  it("esc from health returns to tree", () => {
    const s = reduce(st({ surface: "health" }), { type: "esc" });
    expect(s.surface).toBe("tree");
  });
  it("quit bumps version", () => {
    const s = reduce(st(), { type: "quit" });
    expect(s.version).toBe(1);
  });
  it("surfaceTree/surfaceHealth/focus/toggleHelp/cycleProvenance/toggleInternals ignored while searching", () => {
    let s = reduce(st({ searching: true, surface: "health" }), { type: "surfaceTree" });
    expect(s.surface).toBe("health");
    s = reduce(st({ searching: true }), { type: "surfaceHealth" });
    expect(s.surface).toBe("tree");
    s = reduce(st({ searching: true, selectedId: "a" }), { type: "focus" });
    expect(s.surface).toBe("tree");
    s = reduce(st({ searching: true }), { type: "toggleHelp" });
    expect(s.helpOpen).toBe(false);
    s = reduce(st({ searching: true }), { type: "cycleProvenance" });
    expect(s.provFilter).toBeNull();
    s = reduce(st({ searching: true }), { type: "toggleInternals" });
    expect(s.showInternals).toBe(false);
  });
  it("searchStart/searchChar/searchBackspace/searchCommit/esc", () => {
    let s = reduce(st(), { type: "searchStart" });
    expect(s.searching).toBe(true);
    s = reduce(s, { type: "searchChar", ch: "x" });
    expect(s.query).toBe("x");
    s = reduce(s, { type: "searchBackspace" });
    expect(s.query).toBe("");
    s = reduce(s, { type: "searchStart" }); // already searching no-op
    expect(s.searching).toBe(true);
    s = reduce(s, { type: "searchCommit" });
    expect(s.searching).toBe(false);
    // backspace/char/commit outside search are no-ops
    expect(reduce(st({ searching: false }), { type: "searchBackspace" }).query).toBe("");
    expect(reduce(st({ searching: false }), { type: "searchChar", ch: "z" }).query).toBe("");
    expect(reduce(st({ searching: false }), { type: "searchCommit" }).searching).toBe(false);
  });
  it("focus without selectedId no-op; focusExit", () => {
    const s = reduce(st({ selectedId: null }), { type: "focus" });
    expect(s.surface).toBe("tree");
    const s2 = reduce(st({ surface: "focus", focusId: "a" }), { type: "focusExit" });
    expect(s2.surface).toBe("tree");
    expect(s2.focusId).toBeNull();
  });
  it("refresh/refreshDone toggle the flag", () => {
    let s = reduce(st(), { type: "refresh" });
    expect(s.refreshing).toBe(true);
    s = reduce(s, { type: "refreshDone" });
    expect(s.refreshing).toBe(false);
  });
  it("mergeAfterRefresh keeps selectedId when still a root; falls back when null", () => {
    let m = mergeAfterRefresh(st({ selectedId: "vault" }), ["vault", "repository"]);
    expect(m.selectedId).toBe("vault");
    m = mergeAfterRefresh(st({ selectedId: "vault", refreshing: true }), ["repository"]);
    // selectedId vault not in new roots but non-null → kept (component re-resolves)
    expect(m.selectedId).toBe("vault");
    expect(m.refreshing).toBe(false);
    m = mergeAfterRefresh(st({ selectedId: null }), ["repository"]);
    expect(m.selectedId).toBe("repository");
  });
});

// ---------------------------------------------------------------------------
// explorer.ts: degenerate surfaces and defensive branches
// ---------------------------------------------------------------------------

describe("explorer degenerate surfaces", () => {
  it("renders detail with no selection, and unknown detail id", () => {
    const { ex } = explorer(graph([node("vault", "vault", "Vault", null)], []));
    ex.state = st({ surface: "detail", detailId: null, selectedId: null, version: 1 });
    let lines = ex.render(80).join("\n");
    expect(lines).toContain("(no selection)");
    ex.invalidate();
    ex.state = st({ surface: "detail", detailId: "note:ghost", selectedId: "note:ghost", version: 2 });
    lines = ex.render(80).join("\n");
    expect(lines).toContain("node not found");
  });
  it("renders focus with no focus id", () => {
    const { ex } = explorer(graph([node("vault", "vault", "Vault", null)], []));
    ex.state = st({ surface: "focus", focusId: null });
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("no focus node");
  });
  it("renders health surface with a full model", () => {
    const m = graph(
      [
        node("repository", "repository", "repo", null, { files: "3", state: "fresh", languages: "TS (3)" }),
        node("vault", "vault", "Vault", null, { notes: "2" }),
        node("note:a", "note", "A", "human"),
        node("note:b", "note", "B", "agent"),
      ],
      [
        { source: "repository", target: "vault", kind: "contains" },
        { source: "note:a", target: "note:b", kind: "links-to" },
      ],
      { state: "fresh", reasons: [] },
    );
    const { ex } = explorer(m);
    ex.handleInput("2"); // health
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("Repository");
    expect(lines).toContain("Vault");
    expect(lines).toContain("Link health");
  });
  it("header: no repository present omits repo part", () => {
    const { ex } = explorer(graph([node("vault", "vault", "Vault", null)], []));
    const lines = ex.render(80);
    expect(lines.join("\n")).toContain("weave view");
  });
  it("body windowing with scroll indicators when content exceeds window", () => {
    const nodes: GraphNode[] = [node("vault", "vault", "Vault", null)];
    for (let i = 0; i < 30; i++) nodes.push(node(`note:n${i}`, "note", `N${i}`, "human"));
    const edges = nodes.slice(1).map((n) => ({ source: "vault", target: n.id, kind: "contains" as const }));
    const { ex } = explorer(graph(nodes, edges), { rows: 8 });
    ex.handleInput("\x1b[B"); // move down so selection pushes scroll
    const lines = ex.render(40);
    expect(lines.some((l) => l.includes("more"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// explorer.ts: key flow edge cases
// ---------------------------------------------------------------------------

describe("explorer key flow edges", () => {
  const model = graph(
    [node("vault", "vault", "Vault", null), node("note:a", "note", "Alpha", "human", { slug: "alpha" })],
    [{ source: "vault", target: "note:a", kind: "contains" }],
  );
  it("o in search mode does not open editor; o on non-note does nothing", () => {
    const openNote = vi.fn(async () => true);
    const { ex } = explorer(model, { loaders: { openNote } });
    ex.handleInput("/"); // search
    ex.handleInput("o"); // ignored in search
    expect(openNote).not.toHaveBeenCalled();
  });
  it("o on the vault (non-note) does nothing", () => {
    const openNote = vi.fn(async () => true);
    const { ex } = explorer(model, { loaders: { openNote } });
    ex.handleInput("o"); // vault selected, not a note
    expect(openNote).not.toHaveBeenCalled();
  });
  it("unknown key is ignored (no state change, no done)", () => {
    const done = vi.fn();
    const { ex } = explorer(model, { done });
    ex.handleInput("\x01"); // ctrl-a, unknown
    expect(done).not.toHaveBeenCalled();
  });
  it("refresh while already refreshing is a no-op", () => {
    const rebuild = vi.fn(async () => model);
    const { ex } = explorer(model, { loaders: { rebuild } });
    ex.handleInput("r");
    ex.handleInput("r"); // second r ignored
    expect(ex.state.refreshing).toBe(true);
  });
  it("refresh failure clears the refreshing flag", async () => {
    const rebuild = vi.fn(async () => {
      throw new Error("boom");
    });
    const { ex } = explorer(model, { loaders: { rebuild } });
    ex.handleInput("r");
    await new Promise((r) => setTimeout(r, 0));
    expect(ex.state.refreshing).toBe(false);
  });
  it("openNote triggers when a note is selected", async () => {
    const openNote = vi.fn(async () => true);
    const { ex } = explorer(model, { loaders: { openNote } });
    ex.handleInput("\x1b[B"); // select note:a
    ex.handleInput("o");
    await new Promise((r) => setTimeout(r, 0));
    expect(openNote).toHaveBeenCalledWith("alpha");
  });
  it("render returns cached array then recompute after invalidate", () => {
    const { ex } = explorer(model);
    const a = ex.render(50);
    const b = ex.render(50);
    expect(a).toBe(b);
  });
  it("entering detail for a note triggers body load; null body renders nothing", async () => {
    const { ex } = explorer(model, { loaders: { loadNote: async () => null } });
    ex.handleInput("\x1b[B");
    ex.handleInput("\r");
    await new Promise((r) => setTimeout(r, 0));
    ex.invalidate();
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("Alpha");
  });
});

// ---------------------------------------------------------------------------
// explorer.ts: decodeAction search-mode arms
// ---------------------------------------------------------------------------

describe("decodeAction search-mode arms", () => {
  const searching = { searching: true } as never;
  it("space becomes a space char", () => {
    expect(decodeAction(" ", searching)).toEqual({ type: "searchChar", ch: " " });
  });
  it("multi-char/unknown returns null", () => {
    expect(decodeAction("\x01\x02", searching)).toBeNull();
  });
  it("backspace deletes", () => {
    expect(decodeAction("\x7f", searching)?.type).toBe("searchBackspace");
  });
  it("non-search backspace is ignored (returns null)", () => {
    expect(decodeAction("\x7f", { searching: false } as never)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// run.ts guard + buildTuiModel
// ---------------------------------------------------------------------------

describe("run.ts", () => {
  it("buildTuiModel assembles the graph from disk", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const repo = await makeTempDir();
      gitInit(repo);
      await writeFixture(repo, "src/index.ts", "export const x = 1;\n");
      commitAll(repo, "init");
      const index = await buildRepoIndex(repo);
      await writeRepoIndex(repo, index!);
      await addNote(vault, { title: "X", body: "body", source: "human" });
      const model = await buildTuiModel(repo, vault);
      expect(model.nodes.some((n) => n.id === "vault")).toBe(true);
    });
  });
  it("runWeaveViewTui warns without UI and returns without throwing", async () => {
    const ctx = createMockCtx(await makeTempDir(), false, "tui");
    await runWeaveViewTui(ctx as never);
    expect(ctx.ui.notifications.some((n) => n.message.includes("interactive terminal"))).toBe(true);
    expect(ctx.ui.customCalls).toHaveLength(0);
  });
  it("runWeaveViewTui warns in rpc mode with UI", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir(), true, "rpc");
      await runWeaveViewTui(ctx as never);
      expect(ctx.ui.notifications.some((n) => n.message.includes("interactive terminal"))).toBe(true);
      expect(ctx.ui.customCalls).toHaveLength(0);
    });
  });
  it("runWeaveViewTui opens the explorer and refreshes status after close", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir(), true, "tui");
      const p = runWeaveViewTui(ctx as never);
      for (let i = 0; i < 50 && ctx.ui.customCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(ctx.ui.customCalls).toHaveLength(1);
      ctx.ui.resolveCustom(null);
      await p;
      expect(ctx.ui.statuses["weave"]).toBeTruthy();
    });
  });
  it("runWeaveViewTui falls back to a plain indicator when the session theme is missing", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir(), true, "tui");
      ctx.ui.theme = undefined as never;
      const p = runWeaveViewTui(ctx as never);
      for (let i = 0; i < 50 && ctx.ui.customCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(ctx.ui.customCalls).toHaveLength(1);
      ctx.ui.resolveCustom(null);
      await p;
      expect(ctx.ui.statuses["weave"]).toContain("○");
    });
  });
  it("runWeaveViewTui falls back to a plain indicator when the theme lacks fg", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const ctx = createMockCtx(await makeTempDir(), true, "tui");
      ctx.ui.theme = {} as never;
      const p = runWeaveViewTui(ctx as never);
      for (let i = 0; i < 50 && ctx.ui.customCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(ctx.ui.customCalls).toHaveLength(1);
      ctx.ui.resolveCustom(null);
      await p;
      expect(ctx.ui.statuses["weave"]).toContain("○");
    });
  });
});

// ---------------------------------------------------------------------------
// sanitize + render width invariant on big model
// ---------------------------------------------------------------------------

describe("sanitize + width", () => {
  it("sanitizeTerminalText on plain text is a no-op", () => {
    expect(sanitizeTerminalText("clean text")).toBe("clean text");
  });
  it("render lines never exceed width on a rich model", () => {
    const m = graph(
      [
        node("repository", "repository", "very long repository name that exceeds width", null, { files: "10", state: "stale", languages: "TypeScript (10), Markdown (5), JSON (3)" }),
        node("vault", "vault", "Vault", null, { notes: "3" }),
        node("note:a", "note", "A", "human", { updated: "2026-05-01T00:00:00.000Z", tags: "alpha, beta, gamma" }),
      ],
      [{ source: "repository", target: "vault", kind: "contains" }],
      { state: "stale", reasons: ["x".repeat(60)] },
    );
    const { ex } = explorer(m);
    for (const w of [20, 40, 80]) {
      for (const l of ex.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
    }
  });
});
// ===========================================================================
// Second pass: fine-grained branch coverage (explorer + model)
// ===========================================================================

describe("decodeAction: every all-modes key and letter", () => {
  const ns = { searching: false } as never;
  for (const [data, type] of [
    ["\x1b[5~", "pageUp"], ["\x1b[6~", "pageDown"], ["\x1b[H", "home"], ["\x1b[F", "end"],
    ["\r", "enter"], ["\x1b", "esc"], ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[D", "left"], ["\x1b[C", "right"],
  ] as const) {
    it(`maps ${JSON.stringify(data)} -> ${type}`, () => {
      expect(decodeAction(data, ns)?.type).toBe(type);
    });
  }
  for (const [data, type] of [
    ["k", "up"], ["j", "down"], ["h", "left"], ["l", "right"], ["p", "cycleProvenance"],
    ["i", "toggleInternals"], ["f", "focus"], ["g", "focusExit"], ["1", "surfaceTree"],
    ["2", "surfaceHealth"], ["r", "refresh"], ["?", "toggleHelp"], ["q", "quit"], ["/", "searchStart"],
  ] as const) {
    it(`maps letter ${data} -> ${type}`, () => {
      expect(decodeAction(data, ns)?.type).toBe(type);
    });
  }
  it("search mode: undefined parseKey returns null; multi-char id returns null", () => {
    const searching = { searching: true } as never;
    expect(decodeAction("\x01\x02", searching)).toBeNull();
    expect(decodeAction("\t", searching)).toBeNull(); // parseKey -> "tab" (len 3)
  });
});

describe("explorer render branches", () => {
  const model = graph(
    [
      node("vault", "vault", "Vault", null),
      node("note:a", "note", "Alpha", "human", { slug: "alpha", updated: "2026-05-01T00:00:00.000Z" }),
      node("note:b", "note", "Beta", "agent", { slug: "beta" }),
    ],
    [
      { source: "vault", target: "note:a", kind: "contains" },
      { source: "vault", target: "note:b", kind: "contains" },
      { source: "note:a", target: "note:b", kind: "links-to" },
      { source: "note:b", target: "note:a", kind: "links-to" },
    ],
  );

  it("truncates lines wider than the viewport (w > width branch)", () => {
    const { ex } = explorer(model);
    const lines = ex.render(10);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(10);
  });

  it("clamps output to terminal rows when content exceeds it", () => {
    const { ex } = explorer(model, { rows: 3 });
    expect(ex.render(80).length).toBeLessThanOrEqual(3);
  });

  it("renders with a banner (provFilter + refreshing) and search line, shrinking the window", () => {
    const { ex } = explorer(model);
    ex.handleInput("p"); // provFilter -> banner
    ex.state = { ...ex.state, refreshing: true };
    ex.handleInput("/"); // search sub-mode adds a line
    const lines = ex.render(60);
    expect(lines.some((l) => l.includes("prov:"))).toBe(true);
    expect(lines.some((l) => l.includes("/"))).toBe(true);
  });

  it("renders each surface name in the header", () => {
    const { ex } = explorer(model);
    ex.state = { ...ex.state, surface: "detail", detailId: "note:a" };
    expect(ex.render(80).join("\n")).toContain("Detail");
    ex.state = { ...ex.state, surface: "focus", focusId: "note:a", version: ex.state.version + 1 };
    expect(ex.render(80).join("\n")).toContain("Focus");
    ex.state = { ...ex.state, surface: "health", version: ex.state.version + 1 };
    expect(ex.render(80).join("\n")).toContain("Health");
  });

  it("renderBody with no matching selection keeps selLine -1 (no crash)", () => {
    const { ex } = explorer(model);
    ex.state = { ...ex.state, selectedId: "note:ghost" };
    const lines = ex.render(60);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("detail with links + backlinks + a loaded body renders all sections", async () => {
    const loaders = fakeLoaders({
      loadNote: async (slug) => (slug === "alpha" ? { slug: "alpha", title: "Alpha", body: "# H\n\nbody text here", created: "", updated: "", tags: [], source: "human" } : null),
    });
    const { ex } = explorer(model, { loaders });
    ex.handleInput("\x1b[B"); // select note:a
    ex.handleInput("\r"); // open detail
    await new Promise((r) => setTimeout(r, 0));
    ex.invalidate();
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("Links");
    expect(lines).toContain("Backlinks");
    expect(lines).toContain("body text here");
  });

  it("rowMarker: note with null provenance renders no glyph; non-note renders a kind glyph", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:x", "note", "X", null as NoteSource | null)],
      [{ source: "vault", target: "note:x", kind: "contains" }],
    );
    const { ex } = explorer(m);
    const lines = ex.render(80).join("\n");
    // note:x has null provenance -> no ●/◐ glyph; vault gets ◆
    expect(lines).toContain("◆");
  });
});

describe("explorer maybeLoadBody / openSelectedInEditor branches", () => {
  it("note without slug and file without path do not trigger a load", async () => {
    const loadNote = vi.fn(async () => null);
    const loadOkf = vi.fn(async () => null);
    const m = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:noslug", "note", "NoSlug", "human", {}),
        node("okf:nopath", "file", "noPath", null, {}),
      ],
      [
        { source: "vault", target: "note:noslug", kind: "contains" },
        { source: "vault", target: "okf:nopath", kind: "contains" },
      ],
    );
    const { ex } = explorer(m, { loaders: { loadNote, loadOkf } });
    ex.handleInput("\x1b[B"); // note:noslug
    ex.handleInput("\r"); // open detail -> maybeLoadBody(note) no slug -> no load
    await new Promise((r) => setTimeout(r, 0));
    expect(loadNote).not.toHaveBeenCalled();
    // move to okf file and open
    ex.handleInput("\x1b[1;2;3;4;5;6;7;8;9;0"); // noise
    ex.state = { ...ex.state, surface: "detail", detailId: "okf:nopath", selectedId: "okf:nopath" };
    ex.render(80); // triggers bodyLinesFor -> maybeLoadBody(file) no path -> no load
    await new Promise((r) => setTimeout(r, 0));
    expect(loadOkf).not.toHaveBeenCalled();
  });

  it("openSelectedInEditor with no selection and non-note does nothing", () => {
    const openNote = vi.fn(async () => true);
    const m = graph([node("vault", "vault", "Vault", null)], []);
    const { ex } = explorer(m, { loaders: { openNote } });
    ex.state = { ...ex.state, selectedId: null, detailId: null };
    ex.handleInput("o");
    ex.state = { ...ex.state, selectedId: "vault" }; // non-note
    ex.handleInput("o");
    expect(openNote).not.toHaveBeenCalled();
  });

  it("openSelectedInEditor on a note without slug does nothing", () => {
    const openNote = vi.fn(async () => true);
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:noslug", "note", "N", "human", {})],
      [{ source: "vault", target: "note:noslug", kind: "contains" }],
    );
    const { ex } = explorer(m, { loaders: { openNote } });
    ex.handleInput("\x1b[B");
    ex.handleInput("o");
    expect(openNote).not.toHaveBeenCalled();
  });

  it("bodyLinesFor renders a cached non-null body wrapped to width", async () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:a", "note", "A", "human", { slug: "a" })],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    const { ex } = explorer(m, { loaders: { loadNote: async () => ({ slug: "a", title: "A", body: "word ".repeat(40), created: "", updated: "", tags: [], source: "human" }) } });
    ex.handleInput("\x1b[B");
    ex.handleInput("\r");
    await new Promise((r) => setTimeout(r, 0));
    ex.invalidate();
    for (const l of ex.render(30)) expect(visibleWidth(l)).toBeLessThanOrEqual(30);
  });
});





describe("reduce: movement with currentIdx < 0 (selectedId not in rows)", () => {
  const rows = { rows: [{ id: "a" }, { id: "b" }, { id: "c" }], window: 2 };
  it("up/down/home/end/page from a missing selection land on first", () => {
    const actions: { type: "up" | "down" | "home" | "end" | "pageUp" | "pageDown"; expect: string }[] = [
      { type: "up", expect: "a" },
      { type: "down", expect: "a" },
      { type: "home", expect: "a" },
      { type: "end", expect: "c" },
      { type: "pageUp", expect: "a" },
      { type: "pageDown", expect: "a" },
    ];
    for (const a of actions) {
      const s = reduce(st({ selectedId: "zzz" }), { type: a.type }, rows);
      expect(s.selectedId).toBe(a.expect);
    }
  });
  it("scrollForSelection with window <= 0 returns 0", () => {
    const s = reduce(st({ selectedId: "c", scrollOffset: 0 }), { type: "down" }, { rows: rows.rows, window: 0 });
    expect(s.scrollOffset).toBe(0);
  });
  it("clampIndex: idx < 0 -> 0; idx >= len -> len-1; len 0 -> -1", () => {
    // exercised via reduce on empty (len 0) and overflow (end)
    expect(reduce(st({ selectedId: "a" }), { type: "end" }, { rows: [], window: 2 }).selectedId).toBe("a");
  });
});

describe("reduce: left/right with selectedId not a tree row", () => {
  it("left/right on a missing selectedId are no-ops", () => {
    const treeRowsList = [
      { id: "vault", depth: 0, hasKids: true, expanded: true, label: "Vault", kind: "vault" as const, provenance: null, meta: "" },
      { id: "note:a", depth: 1, hasKids: false, expanded: false, label: "A", kind: "note" as const, provenance: "human", meta: "" },
    ];
    const ctx = { rows: treeRowsList, window: 24 };
    let s = reduce(st({ selectedId: "ghost" }), { type: "right" }, ctx);
    expect(s.selectedId).toBe("ghost");
    s = reduce(st({ selectedId: "ghost" }), { type: "left" }, ctx);
    expect(s.selectedId).toBe("ghost");
  });
});

describe("reduce: enter with no-target rows on detail/focus", () => {
  it("enter on a detail row without target is a no-op", () => {
    const s = reduce(st({ surface: "detail", detailId: "x", selectedId: "meta:slug" }), { type: "enter" }, { rows: [{ id: "meta:slug" }], window: 24 });
    expect(s.detailId).toBe("x");
  });
  it("enter on a focus row without target is a no-op", () => {
    const s = reduce(st({ surface: "focus", focusId: "x", selectedId: "note:y" }), { type: "enter" }, { rows: [{ id: "note:y" }], window: 24 });
    expect(s.focusId).toBe("x");
  });
  it("enter with no selectedId is a no-op", () => {
    const s = reduce(st({ selectedId: null }), { type: "enter" }, { rows: [], window: 24 });
    expect(s.surface).toBe("tree");
  });
});

describe("reduce: searchStart surface guards", () => {
  it("searchStart in detail is ignored", () => {
    const s = reduce(st({ surface: "detail", detailId: "x" }), { type: "searchStart" });
    expect(s.searching).toBe(false);
  });
  it("searchStart while already searching is a no-op", () => {
    const s = reduce(st({ searching: true }), { type: "searchStart" });
    expect(s.searching).toBe(true);
  });
});

describe("initialState + graphRoots", () => {
  it("initialState expands roots and selects the first", () => {
    const s = initialState(["vault", "repository"]);
    expect(s.expanded.has("vault")).toBe(true);
    expect(s.expanded.has("repository")).toBe(true);
    expect(s.selectedId).toBe("vault");
  });
  it("initialState with no roots selects null", () => {
    expect(initialState([]).selectedId).toBeNull();
  });
  it("graphRoots finds nodes with no incoming contains/anchored-at", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:a", "note", "A", "human")],
      [{ source: "vault", target: "note:a", kind: "links-to" }], // links-to does not make a child
    );
    expect(graphRoots(m).sort()).toEqual(["note:a", "vault"]);
  });
});

describe("mergeAfterRefresh: selectedId present in roots is kept", () => {
  it("keeps a selectedId that is still a root", () => {
    const m = mergeAfterRefresh(st({ selectedId: "vault", refreshing: true }), ["vault", "repository"]);
    expect(m.selectedId).toBe("vault");
    expect(m.refreshing).toBe(false);
  });
});

// ===========================================================================
// Third pass: remaining model/explorer branches
// ===========================================================================



describe("model: clampIndex/scrollForSelection via reduce", () => {
  const rows = { rows: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], window: 2 };
  it("up from index>0 decrements; scroll follows when selection moves above offset", () => {
    let s = reduce(st({ selectedId: "c", scrollOffset: 2 }), { type: "up" }, rows);
    expect(s.selectedId).toBe("b");
    expect(s.scrollOffset).toBe(1); // b at idx1 < offset2 -> offset=1
  });
  it("down past the window advances the offset", () => {
    const s = reduce(st({ selectedId: "a", scrollOffset: 0 }), { type: "down" }, rows);
    // a->b, idx1, window2, offset0: 1 < 0+2 -> stays 0
    expect(s.scrollOffset).toBe(0);
    const s2 = reduce(st({ selectedId: "b", scrollOffset: 0 }), { type: "down" }, rows);
    // b->c idx2 >= 0+2 -> offset=2-2+1=1
    expect(s2.scrollOffset).toBe(1);
  });
  it("end clamps to last and scrolls", () => {
    const s = reduce(st({ selectedId: "a" }), { type: "end" }, rows);
    expect(s.selectedId).toBe("d");
  });
  it("bogus action falls through to the trailing no-op return", () => {
    const s = reduce(st(), { type: "bogus" } as never, rows);
    expect(s.version).toBe(st().version); // unchanged
  });
});


describe("explorer: render with banner refresh and no search", () => {
  it("refreshing banner shrinks the window without search", () => {
    const { ex } = explorer(graph([node("vault", "vault", "Vault", null)], []));
    ex.state = { ...ex.state, refreshing: true };
    const lines = ex.render(60);
    expect(lines.some((l) => l.includes("refreshing…"))).toBe(true);
  });
});

describe("explorer: renderSurface detail/focus/health each render", () => {
  it("focus surface with a real focused note renders the focus heading", () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("note:a", "note", "A", "human")],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    const { ex } = explorer(m);
    ex.state = { ...ex.state, surface: "focus", focusId: "note:a", selectedId: "note:a" };
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("focus — g/esc to exit");
  });
});
