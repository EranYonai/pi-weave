import { describe, expect, it, vi } from "vitest";
import { WeaveExplorer, decodeAction, type WeaveTheme, type WeaveTui, type WeaveLoaders } from "../../src/pi/viewer/tui/explorer";
import type { GraphModel, GraphNode } from "../../src/core/graph/model";
import type { NoteSource } from "../../src/core/types";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildCurrentGraph, readNoteForView, readOkfFileForView } from "../../src/core";
import { addNote } from "../../src/core/vault";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Identity theme: tags lines with the slot name so tests can assert slots,
 *  and otherwise returns the text unchanged (visibleWidth-friendly). */
function fakeTheme(): WeaveTheme {
  return {
    fg: (slot, text) => `{${slot}}${text}{/}`,
    bg: (_slot, text) => `{bg}${text}{/}`,
    bold: (text) => `{b}${text}{/b}`,
    dim: (text) => `{dim}${text}{/}`,
  };
}

function fakeTui(rows = 30, columns = 80): WeaveTui & { requestRender: ReturnType<typeof vi.fn> } {
  return {
    requestRender: vi.fn(),
    terminal: { rows, columns },
  };
}

function fakeLoaders(over: Partial<WeaveLoaders> = {}): WeaveLoaders & { openNoteCalls: string[] } {
  const openNoteCalls: string[] = [];
  return {
    loadNote: async () => null,
    loadOkf: async () => null,
    openNote: async (slug: string) => {
      openNoteCalls.push(slug);
      return true;
    },
    rebuild: async () => ({ generatedAt: "", staleness: null, nodes: [], edges: [] }),
    openNoteCalls,
    ...over,
  } as WeaveLoaders & { openNoteCalls: string[] };
}

function node(id: string, kind: GraphNode["kind"], label: string, prov: NoteSource | null, detail: Record<string, string> = {}): GraphNode {
  return { id, kind, label, provenance: prov, detail };
}

function graph(nodes: GraphNode[], edges: GraphModel["edges"], staleness: GraphModel["staleness"] = null): GraphModel {
  return { generatedAt: "2026-06-01T00:00:00.000Z", staleness, nodes, edges };
}

function explorer(model: GraphModel, opts: { rows?: number; loaders?: Partial<WeaveLoaders>; done?: (r: null) => void } = {}) {
  const tui = fakeTui(opts.rows ?? 30);
  const loaders = fakeLoaders(opts.loaders);
  const done = opts.done ?? vi.fn();
  const ex = new WeaveExplorer({ model, theme: fakeTheme(), tui, loaders, done, rows: opts.rows ?? 30 });
  return { ex, tui, loaders, done };
}

// ---------------------------------------------------------------------------
// decodeAction
// ---------------------------------------------------------------------------

describe("decodeAction", () => {
  const st = { searching: false } as never;
  it("maps arrow/enter/esc byte sequences", () => {
    expect(decodeAction("\x1b[A", st)?.type).toBe("up");
    expect(decodeAction("\x1b[B", st)?.type).toBe("down");
    expect(decodeAction("\x1b[D", st)?.type).toBe("left");
    expect(decodeAction("\x1b[C", st)?.type).toBe("right");
    expect(decodeAction("\r", st)?.type).toBe("enter");
    expect(decodeAction("\x1b", st)?.type).toBe("esc");
  });

  it("maps vim hjkl and command letters", () => {
    expect(decodeAction("k", st)?.type).toBe("up");
    expect(decodeAction("j", st)?.type).toBe("down");
    expect(decodeAction("h", st)?.type).toBe("left");
    expect(decodeAction("l", st)?.type).toBe("right");
    expect(decodeAction("p", st)?.type).toBe("cycleProvenance");
    expect(decodeAction("i", st)?.type).toBe("toggleInternals");
    expect(decodeAction("f", st)?.type).toBe("focus");
    expect(decodeAction("g", st)?.type).toBe("focusExit");
    expect(decodeAction("1", st)?.type).toBe("surfaceTree");
    expect(decodeAction("2", st)?.type).toBe("surfaceHealth");
    expect(decodeAction("r", st)?.type).toBe("refresh");
    expect(decodeAction("?", st)?.type).toBe("toggleHelp");
    expect(decodeAction("q", st)?.type).toBe("quit");
    expect(decodeAction("/", st)?.type).toBe("searchStart");
  });

  it("in search mode, printable chars become searchChar and letters stop navigating", () => {
    const searching = { searching: true } as never;
    expect(decodeAction("j", searching)).toEqual({ type: "searchChar", ch: "j" });
    expect(decodeAction("a", searching)).toEqual({ type: "searchChar", ch: "a" });
    expect(decodeAction("\x7f", searching)?.type).toBe("searchBackspace"); // backspace
    expect(decodeAction("\r", searching)?.type).toBe("enter"); // commit
    // arrow keys still navigate even in search
    expect(decodeAction("\x1b[A", searching)?.type).toBe("up");
  });

  it("returns null for unknown keys", () => {
    expect(decodeAction("\x01", st)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// render invariants
// ---------------------------------------------------------------------------

describe("WeaveExplorer.render invariants", () => {
  const model = graph(
    [
      node("vault", "vault", "Vault", null),
      node("note:a", "note", "Alpha", "human", { updated: "2026-05-01T00:00:00.000Z" }),
      node("note:b", "note", "Beta", "agent", { updated: "2026-05-02T00:00:00.000Z" }),
    ],
    [
      { source: "vault", target: "note:a", kind: "contains" },
      { source: "vault", target: "note:b", kind: "contains" },
    ],
  );

  it("lines never exceed the requested width", () => {
    const { ex } = explorer(model);
    const lines = ex.render(40);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });

  it("labels and provenance glyphs appear in the tree", () => {
    const { ex } = explorer(model);
    ex.handleInput("1"); // ensure tree
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("Alpha");
    expect(lines).toContain("Beta");
    expect(lines).toContain("●"); // human glyph
    expect(lines).toContain("◐"); // agent glyph
  });

  it("two renders at the same version are referentially identical (cache)", () => {
    const { ex } = explorer(model);
    const a = ex.render(60);
    const b = ex.render(60);
    expect(a).toBe(b); // same array reference
  });

  it("invalidate forces a recompute", () => {
    const { ex } = explorer(model);
    const a = ex.render(60);
    ex.invalidate();
    const b = ex.render(60);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("expand flips the chevron for a node with kids", () => {
    const m = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human"),
      ],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    const { ex } = explorer(m);
    // default: vault expanded (initialState expands roots)
    let lines = ex.render(80).join("\n");
    expect(lines).toContain("▾");
    // collapse vault with left
    ex.handleInput("\x1b[D"); // left
    lines = ex.render(80).join("\n");
    expect(lines).toContain("▸");
  });

  it("windowing clamps output length when rows are small and nodes many", () => {
    const nodes: GraphNode[] = [node("vault", "vault", "Vault", null)];
    for (let i = 0; i < 40; i++) nodes.push(node(`note:n${i}`, "note", `Note ${i}`, "human"));
    const edges = nodes.slice(1).map((n) => ({ source: "vault", target: n.id, kind: "contains" as const }));
    const m = graph(nodes, edges);
    const { ex } = explorer(m, { rows: 12 });
    const lines = ex.render(80);
    // header (2) + footer (1) + a scroll indicator <= 12
    expect(lines.length).toBeLessThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------
// input flow
// ---------------------------------------------------------------------------

describe("WeaveExplorer input flow", () => {
  const model = graph(
    [
      node("vault", "vault", "Vault", null),
      node("note:a", "note", "Alpha", "human", { slug: "alpha" }),
      node("note:b", "note", "Beta", "agent", { slug: "beta" }),
    ],
    [
      { source: "vault", target: "note:a", kind: "contains" },
      { source: "vault", target: "note:b", kind: "contains" },
      { source: "note:a", target: "note:b", kind: "links-to" },
    ],
  );

  it("down moves selection; enter opens detail; esc returns to tree", () => {
    const { ex, done } = explorer(model);
    ex.handleInput("\x1b[B"); // down -> note:a (after vault)
    expect(ex.state.selectedId).toBe("note:a");
    ex.handleInput("\r"); // enter -> detail
    expect(ex.state.surface).toBe("detail");
    expect(ex.state.detailId).toBe("note:a");
    ex.handleInput("\x1b"); // esc -> tree
    expect(ex.state.surface).toBe("tree");
  });

  it("esc precedence: search clears before tree-quit; quit calls done once", () => {
    const done = vi.fn();
    const { ex } = explorer(model, { done });
    ex.handleInput("/"); // enter search
    expect(ex.state.searching).toBe(true);
    ex.handleInput("\x1b"); // esc clears search, does not quit
    expect(ex.state.searching).toBe(false);
    expect(done).not.toHaveBeenCalled();
    ex.handleInput("q"); // quit
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(null);
  });

  it("tree esc quits (done(null) exactly once)", () => {
    const done = vi.fn();
    const { ex } = explorer(model, { done });
    ex.handleInput("\x1b"); // tree esc -> quit
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("enter in search mode commits and keeps the filter", () => {
    const { ex } = explorer(model);
    ex.handleInput("/");
    ex.handleInput("a");
    ex.handleInput("\r"); // commit
    expect(ex.state.searching).toBe(false);
    expect(ex.state.query).toBe("a");
  });

  it("f enters focus; enter on a neighbor re-centers; g exits", () => {
    const { ex } = explorer(model);
    ex.handleInput("\x1b[B"); // select note:a
    ex.handleInput("f");
    expect(ex.state.surface).toBe("focus");
    expect(ex.state.focusId).toBe("note:a");
    // focus rows include note:b neighbor; down then enter re-centers
    ex.handleInput("\x1b[B"); // down into focus rows
    ex.handleInput("\r"); // enter on neighbor
    expect(ex.state.focusId).not.toBe("note:a");
    ex.handleInput("g"); // exit focus
    expect(ex.state.surface).toBe("tree");
  });

  it("o opens the selected note in the editor", () => {
    const { ex, loaders } = explorer(model);
    ex.handleInput("\x1b[B"); // select note:a
    ex.handleInput("o");
    expect(loaders.openNoteCalls).toEqual(["alpha"]);
  });

  it("r triggers the injected rebuilder and clears refreshing", async () => {
    const rebuilt = graph([node("vault", "vault", "Vault", null)], []);
    const rebuild = vi.fn(async () => rebuilt);
    const { ex, tui } = explorer(model, { loaders: { rebuild } });
    ex.handleInput("r");
    expect(ex.state.refreshing).toBe(true);
    // wait microtasks for the rebuild promise
    await new Promise((r) => setTimeout(r, 0));
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(ex.state.refreshing).toBe(false);
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it("p cycles provenance and filters the tree", () => {
    const { ex } = explorer(model);
    ex.handleInput("p"); // human
    expect(ex.state.provFilter).toBe("human");
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("Alpha"); // human note shown
    expect(lines).not.toContain("Beta"); // agent note filtered out
  });

  it("? toggles the expanded help block", () => {
    const { ex } = explorer(model);
    ex.handleInput("?");
    expect(ex.state.helpOpen).toBe(true);
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("move");
    ex.handleInput("?");
    expect(ex.state.helpOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// async body load
// ---------------------------------------------------------------------------

describe("WeaveExplorer async body load", () => {
  it("shows placeholder then flushed body lines for a note", async () => {
    const model = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "Alpha", "human", { slug: "alpha" }),
      ],
      [{ source: "vault", target: "note:a", kind: "contains" }],
    );
    const loaders = fakeLoaders({
      loadNote: async (slug) => (slug === "alpha" ? { slug: "alpha", title: "Alpha", body: "The body text.", created: "", updated: "", tags: [], source: "human" } : null),
    });
    const { ex } = explorer(model, { loaders });
    ex.handleInput("\x1b[B"); // select note:a
    ex.handleInput("\r"); // open detail -> triggers load
    let lines = ex.render(80).join("\n");
    expect(lines).toContain("(loading…)");
    await new Promise((r) => setTimeout(r, 0));
    ex.invalidate();
    lines = ex.render(80).join("\n");
    expect(lines).toContain("The body text.");
  });

  it("loads an .okf file body via loadOkf", async () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("okf:repository/git.json", "file", "git.json", null, { path: "repository/git.json" }),
      ],
      [{ source: "repository", target: "okf:repository/git.json", kind: "contains" }],
    );
    const loaders = fakeLoaders({
      loadOkf: async (rel) => (rel === "repository/git.json" ? { path: rel, body: '{"branch":"main"}' } : null),
    });
    const { ex } = explorer(model, { loaders });
    ex.handleInput("\x1b[B"); // select the file row (after repository)
    ex.handleInput("\r"); // open detail
    await new Promise((r) => setTimeout(r, 0));
    ex.invalidate();
    const lines = ex.render(80).join("\n");
    expect(lines).toContain("branch");
  });
});

// ---------------------------------------------------------------------------
// real readers against temp fixtures
// ---------------------------------------------------------------------------

describe("WeaveExplorer with real readers", () => {
  it("binds readNoteForView/readOkfFileForView against temp fixtures", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const repo = await makeTempDir();
      gitInit(repo);
      writeFixture(repo, "src/index.ts", "export const x = 1;\n");
      commitAll(repo, "init");
      const index = await buildRepoIndex(repo);
      expect(index).not.toBeNull();
      await writeRepoIndex(repo, index!);

      await addNote(vault, { title: "Real Note", body: "real body content", source: "human" });
      const model = await buildCurrentGraph(repo, vault);

      const loaders = fakeLoaders({
        loadNote: (slug) => readNoteForView(vault, slug),
        loadOkf: (rel) => readOkfFileForView(repo, rel),
      });
      const { ex } = explorer(model, { loaders });
      const lines = ex.render(80).join("\n");
      expect(lines).toContain("Real Note");
      // open detail for the note
      ex.handleInput("\x1b[B");
      ex.handleInput("\r");
      await new Promise((r) => setTimeout(r, 0));
      ex.invalidate();
      expect(ex.render(80).join("\n")).toContain("real body content");
    });
  });
});