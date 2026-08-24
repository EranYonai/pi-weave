import { describe, expect, it, vi, afterEach } from "vitest";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { WeaveWorkspace, decodeWorkspaceKey } from "../../src/pi/viewer/tui/workspaceRoot";
import type { WeaveTheme, WeaveTui, WeaveLoaders } from "../../src/pi/viewer/tui/explorer";
import { collectPanes, paneNode, resetWorkspaceIds, splitNode, workspacePanes } from "../../src/pi/viewer/tui/workspace";
import type { GraphModel, GraphNode } from "../../src/core/graph/model";
import type { NoteSource } from "../../src/core/types";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bundledLogoImage } from "../../src/pi/viewer/tui/branding";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
function theme(): WeaveTheme {
  return {
    fg: (_s, t) => t,
    bg: (_s, t) => t,
    bold: (t) => t,
  };
}
function fakeTui(rows = 30): WeaveTui & { requestRender: ReturnType<typeof vi.fn> } {
  return { requestRender: vi.fn(), terminal: { rows, columns: 100 } };
}
function fakeLoaders(over: Partial<WeaveLoaders> = {}): WeaveLoaders {
  return {
    loadNote: async () => null,
    loadOkf: async () => null,
    openNote: async () => true,
    rebuild: async () => ({ generatedAt: "", staleness: null, nodes: [], edges: [] }),
    ...over,
  };
}
function node(id: string, kind: GraphNode["kind"], label: string, prov: NoteSource | null, detail: Record<string, string> = {}): GraphNode {
  return { id, kind, label, provenance: prov, detail };
}
function graph(nodes: GraphNode[], edges: GraphModel["edges"]): GraphModel {
  return { generatedAt: "2026-06-01T00:00:00.000Z", staleness: null, nodes, edges };
}
function model() {
  return graph(
    [
      node("vault", "vault", "Vault", null),
      node("repository", "repository", "pi-weave", null, { files: "2" }),
      node("note:a", "note", "Alpha", "human", { slug: "alpha" }),
      node("note:b", "note", "Beta", "agent", { slug: "beta" }),
    ],
    [
      { source: "vault", target: "note:a", kind: "contains" },
      { source: "vault", target: "note:b", kind: "contains" },
    ],
  );
}
function ws(over: Partial<ConstructorParameters<typeof WeaveWorkspace>[0]> = {}) {
  const m = model();
  const tui = fakeTui();
  const loaders = fakeLoaders();
  const done = vi.fn();
  const w = new WeaveWorkspace({ model: m, theme: theme(), tui, loaders, done, rows: 30, now: () => NOW, logo: "◈", ...over });
  return { w, tui, loaders, done, model: m };
}

describe("decodeWorkspaceKey", () => {
  it("maps workspace keys and null for pane keys", () => {
    expect(decodeWorkspaceKey("\\")).toBe("splitV");
    expect(decodeWorkspaceKey("|")).toBe("splitH");
    expect(decodeWorkspaceKey("x")).toBe("close");
    expect(decodeWorkspaceKey("w")).toBe("workspace");
    expect(decodeWorkspaceKey("?")).toBe("help");
    expect(decodeWorkspaceKey("q")).toBe("quit");
    expect(decodeWorkspaceKey("r")).toBe("refresh");
    expect(decodeWorkspaceKey("j")).toBeNull();
  });
});

describe("WeaveWorkspace render", () => {
  it("renders header, body, footer within width and stays cached", () => {
    const { w } = ws();
    const lines = w.render(100);
    expect(lines.join("\n")).toContain("weave view");
    expect(lines.join("\n")).toContain("Explore");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
    expect(w.render(100)).toBe(lines);
  });
  it("shows a tab bar below 80 cols and collapses to the active pane", () => {
    const { w } = ws();
    const narrow = w.render(70);
    expect(narrow.join("\n")).toContain("[");
    const wide = w.render(120);
    expect(wide.join("\n")).not.toContain("] explore");
  });
  it("renders help when the help overlay is open", () => {
    const { w } = ws();
    w.handleInput("?");
    const lines = w.render(100).join("\n");
    expect(lines).toContain("focus");
  });
  it("keeps the one-line glyph header without the kitty image", () => {
    const { w } = ws();
    const lines = w.render(100);
    expect(lines.join("\n")).toContain("◈");
    expect(lines.join("\n")).not.toContain("\x1b_G");
  });
  it("splices the kitty raster logo onto its own row(s) above the wordmark", () => {
    // Simulate Kitty graphics so the bundled Image emits the Kitty sequence.
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const { w } = ws({ logo: "◈", logoImage: bundledLogoImage(theme()) });
    const lines = w.render(100).join("\n");
    expect(lines).toContain("\x1b_G"); // the Image's kitty line is present
    expect(lines).toContain("weave view");
    // The raster replaces the glyph in the text strip (no inline ◈ + image).
    expect(lines).not.toContain("◈");
  });
  it("falls back to the glyph header when the kitty image render throws", () => {
    const throwing = { render: () => { throw new Error("boom"); }, invalidate: () => {} };
    const { w } = ws({ logo: "◈", logoImage: throwing });
    expect(w.render(100).join("\n")).toContain("◈");
  });
  it("falls back to the glyph header when the kitty image renders no lines", () => {
    const empty = { render: () => [], invalidate: () => {} };
    const { w } = ws({ logo: "◈", logoImage: empty });
    expect(w.render(100).join("\n")).toContain("◈");
  });
});

describe("WeaveWorkspace keys", () => {
  it("Tab cycles focus to the next pane", () => {
    const { w } = ws();
    const first = w.workspace.activePaneId;
    w.handleInput("\t");
    expect(w.workspace.activePaneId).not.toBe(first);
    w.handleInput("\t");
    expect(w.workspace.activePaneId).toBe(first);
  });
  it("backslash splits the active pane and adds a pane", () => {
    const { w } = ws();
    const before = workspacePanes(w.workspace).length;
    w.handleInput("\\");
    expect(workspacePanes(w.workspace).length).toBe(before + 1);
  });
  it("x closes the active pane but keeps one pane (never quits)", () => {
    const { w, done } = ws();
    const before = workspacePanes(w.workspace).length;
    w.handleInput("x");
    expect(workspacePanes(w.workspace).length).toBeLessThan(before);
    expect(done).not.toHaveBeenCalled();
  });
  it("q quits exactly once", () => {
    const { w, done } = ws();
    w.handleInput("q");
    w.handleInput("q");
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(null);
  });
  it("w toggles the (placeholder) workspace switcher/help", () => {
    const { w } = ws();
    w.handleInput("w");
    expect(w.render(100).join("\n")).toContain("focus");
  });
  it("Ctrl-h resizes the row split weights", () => {
    const { w } = ws();
    const before = w.workspace.root.type === "split" ? [...(w.workspace.root.sizes)] : [];
    w.handleInput("\u0008"); // Ctrl-h
    const after = w.workspace.root.type === "split" ? w.workspace.root.sizes : [];
    expect(after[0]).not.toBe(before[0]);
  });
  it("e swaps the active surface in place", () => {
    const { w } = ws();
    w.handleInput("e");
    const active = workspacePanes(w.workspace).find((p) => p.id === w.workspace.activePaneId);
    expect(active?.surface).toBe("explore");
    w.handleInput("h");
    const active2 = workspacePanes(w.workspace).find((p) => p.id === w.workspace.activePaneId);
    expect(active2?.surface).toBe("health");
  });
  it("r triggers rebuild and clears refreshing", async () => {
    const m = model();
    const rebuild = vi.fn(async () => m);
    const { w } = ws({ loaders: fakeLoaders({ rebuild }) });
    w.handleInput("r");
    expect(w.refreshing).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(w.refreshing).toBe(false);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
  it("refresh failure clears refreshing", async () => {
    const rebuild = vi.fn(async () => {
      throw new Error("boom");
    });
    const { w } = ws({ loaders: fakeLoaders({ rebuild }) });
    w.handleInput("r");
    await new Promise((r) => setTimeout(r, 0));
    expect(w.refreshing).toBe(false);
  });
});

describe("WeaveWorkspace cross-pane navigation", () => {
  it("enter in explore opens detail in the nearest detail pane to the right", () => {
    const { w } = ws();
    // default workspace: [explore | detail]; explore is active with vault selected
    w.handleInput("\x1b[B"); // down to note:a
    w.handleInput("\r"); // enter -> openDetail(note:a)
    const active = workspacePanes(w.workspace).find((p) => p.id === w.workspace.activePaneId);
    expect(active?.surface).toBe("detail");
  });
  it("o in a detail pane calls openNote", async () => {
    const openNote = vi.fn(async () => true);
    const loaders = fakeLoaders({ openNote, loadNote: async () => ({ slug: "alpha", title: "Alpha", body: "body", created: "", updated: "", tags: [], source: "human" as const }) });
    const { w } = ws({ loaders });
    // rows: vault, note:a, note:b, repository — down once to note:a, open detail
    w.handleInput("\x1b[B");
    w.handleInput("\r"); // open detail on note:a
    w.handleInput("o"); // open editor on the detail's bound note
    await new Promise((r) => setTimeout(r, 0));
    expect(openNote).toHaveBeenCalledWith("alpha");
  });
  it("o in an explore pane opens the selected note in the editor", async () => {
    const openNote = vi.fn(async () => true);
    const { w } = ws({ loaders: fakeLoaders({ openNote }) });
    w.handleInput("\x1b[B"); // down to note:a (the default root is vault)
    w.handleInput("o");
    await new Promise((r) => setTimeout(r, 0));
    expect(openNote).toHaveBeenCalledWith("alpha");
  });
  it("Esc cancels a Detail pane's goto-line mode instead of quitting", async () => {
    const { w, done } = ws({
      loaders: fakeLoaders({ loadNote: async () => ({ slug: "alpha", title: "Alpha", body: "x".repeat(200), created: "", updated: "", tags: [], source: "human" as const }) }),
    });
    w.handleInput("\x1b[B"); // down to note:a
    w.handleInput("\r"); // open detail (active pane -> detail)
    w.handleInput("/"); // enter goto-line mode in the detail pane
    const active = workspacePanes(w.workspace).find((p) => p.id === w.workspace.activePaneId);
    expect(active?.surface).toBe("detail");
    w.handleInput("\x1b"); // Esc -> should cancel goto, NOT quit
    expect(done).not.toHaveBeenCalled();
    // A second Esc, now that no sub-mode is active, quits.
    w.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("WeaveWorkspace split rendering", () => {
  it("a vertical split renders both panes (rows are partitioned, not overflowed)", () => {
    resetWorkspaceIds();
    // A workspace that is JUST a vertical (column) split of two panes.
    const root = splitNode("column", [paneNode("explore"), paneNode("explore")]);
    const panes = collectPanes(root);
    const { w } = ws({ workspace: { name: "test", root, activePaneId: panes[0]!.id } });
    expect(workspacePanes(w.workspace).length).toBe(2);
    const lines = w.render(100).join("\n");
    // Each Pane draws one bottom-left corner char; both must be present. The
    // pre-fix VStack gave every child full body height, the stack overflowed,
    // and the row clamp left only the first pane visible (one corner).
    const corners = lines.split("└").length - 1;
    expect(corners).toBe(2);
  });
});

describe("WeaveWorkspace setModel", () => {
  it("setModel clears the body cache and re-renders", () => {
    const { w } = ws();
    w.setModel(model());
    expect(w.model.nodes.length).toBeGreaterThan(0);
  });
  it("setModel propagates the model to the shared context so open panes re-render the new graph", () => {
    const { w } = ws();
    // Open a detail pane bound to note:a (label "Alpha").
    w.handleInput("\x1b[B"); // down to note:a
    w.handleInput("\r"); // open detail on note:a
    expect(w.render(100).join("\n")).toContain("Alpha");
    // Rebuild the model with note:a renamed. Before the fix, setModel only
    // swapped this.model and left this.ctx.model (what every surface reads)
    // pointing at the old graph — so the panes kept rendering "Alpha".
    const m2 = graph(
      [
        node("vault", "vault", "Vault", null),
        node("repository", "repository", "pi-weave", null, { files: "2" }),
        node("note:a", "note", "Alpha-NEW", "human", { slug: "alpha" }),
        node("note:b", "note", "Beta", "agent", { slug: "beta" }),
      ],
      [
        { source: "vault", target: "note:a", kind: "contains" },
        { source: "vault", target: "note:b", kind: "contains" },
      ],
    );
    w.setModel(m2);
    expect(w.render(100).join("\n")).toContain("Alpha-NEW");
  });
});

afterEach(() => {
  resetCapabilitiesCache();
});
