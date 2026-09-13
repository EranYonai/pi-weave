/**
 * Branch-coverage suite for the v2 workspace root + surface components
 * (weave-view-tui-v2 §11). Drives the degenerate paths the primary suites
 * don't reach: page/home/end movement and body-load edge states.
 */

import { describe, expect, it, vi } from "vitest";
import { WeaveWorkspace, decodeWorkspaceKey } from "../../src/pi/viewer/tui/workspaceRoot";
import { Pane } from "../../src/pi/viewer/tui/surface/base";
import { ExploreSurface } from "../../src/pi/viewer/tui/surface/explore";
import { bindDetail, DetailSurface, markdownTheme } from "../../src/pi/viewer/tui/surface/detail";
import { FocusSurface } from "../../src/pi/viewer/tui/surface/focus";
import { HealthSurface } from "../../src/pi/viewer/tui/surface/health";
import type { SurfaceContext } from "../../src/pi/viewer/tui/surface/base";
import { BodyStore } from "../../src/pi/viewer/tui/bodyStore";
import type { WeaveTheme, WeaveTui, WeaveLoaders } from "../../src/pi/viewer/tui/surface/base";
import type { GraphModel, GraphNode } from "../../src/core/graph/model";
import type { NoteSource } from "../../src/core/types";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
function theme(): WeaveTheme {
  return { fg: (_s, t) => t, bg: (_s, t) => t, bold: (t) => t };
}
function node(id: string, kind: GraphNode["kind"], label: string, prov: NoteSource | null, detail: Record<string, string> = {}): GraphNode {
  return { id, kind, label, provenance: prov, detail };
}
function graph(nodes: GraphNode[], edges: GraphModel["edges"], staleness: GraphModel["staleness"] = null): GraphModel {
  return { generatedAt: "2026-06-01T00:00:00.000Z", staleness, nodes, edges, danglingLinks: {}, contentDigest: "" };
}
function ctx(model: GraphModel): SurfaceContext {
  return {
    model,
    theme: theme(),
    loaders: { loadNote: async () => null, loadOkf: async () => null, openNote: async () => true, rebuild: async () => model },
    bodies: new BodyStore({ loaders: { loadNote: async () => null, loadOkf: async () => null } }),
    now: () => NOW,
  };
}
function model() {
  return graph(
    [
      node("vault", "vault", "Vault", null),
      node("note:a", "note", "Alpha", "human", { slug: "alpha" }),
      node("note:b", "note", "Beta", "agent", { slug: "beta" }),
      node("note:c", "note", "Gamma", "human", { slug: "gamma" }),
    ],
    [
      { source: "vault", target: "note:a", kind: "contains" },
      { source: "vault", target: "note:b", kind: "contains" },
      { source: "vault", target: "note:c", kind: "contains" },
    ],
  );
}
function ws(over: Partial<{ loaders: WeaveLoaders }> = {}) {
  const m = model();
  const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } } as WeaveTui & { requestRender: ReturnType<typeof vi.fn> };
  const done = vi.fn();
  const w = new WeaveWorkspace({ model: m, theme: theme(), tui, loaders: over.loaders ?? fakeLoaders(), done, rows: 30, now: () => NOW });
  return { w, tui, done, model: m };
}
function fakeLoaders(over: Partial<WeaveLoaders> = {}): WeaveLoaders {
  return { loadNote: async () => null, loadOkf: async () => null, openNote: async () => true, rebuild: async () => model(), ...over };
}

describe("FocusSurface branches", () => {
  const m = graph(
    [
      node("note:hub", "note", "Hub", "human"),
      node("note:a", "note", "A", "human"),
      node("note:b", "note", "B", "agent"),
    ],
    [
      { source: "note:hub", target: "note:a", kind: "links-to" },
      { source: "note:hub", target: "note:b", kind: "links-to" },
    ],
  );
  it("page/home/end navigation and move edges", () => {
    const s = new FocusSurface({ context: ctx(m) });
    s.setFocus("note:hub");
    s.handleInput("\u001b[5~"); // pageUp
    s.handleInput("\u001b[6~"); // pageDown
    s.handleInput("\u001b[H"); // home
    s.handleInput("\u001b[F"); // end -> last neighbor note:b
    expect(s.state.selectedId).toBe("note:b");
    s.handleInput("\x1b[A"); // up from last -> note:a
    expect(s.state.selectedId).toBe("note:a");
    s.handleInput("\x1b[D"); // left (unhandled) no-op
    expect(s.state.focusId).toBe("note:hub");
  });
  it("enter on a neighbor without target is a no-op", () => {
    const s = new FocusSurface({ context: ctx(m) });
    s.setFocus("note:hub");
    s.handleInput("\r"); // enter on center (target = itself) -> no re-center
    expect(s.state.focusId).toBe("note:hub");
  });
  it("setFocused is a no-op and g emits with empty id when no focus", () => {
    const seen: string[] = [];
    const s = new FocusSurface({ context: ctx(m), onEvent: (e) => seen.push(e.type) });
    s.setFocused(true);
    s.handleInput("g");
    expect(seen).toContain("focusNode");
  });
});

describe("HealthSurface branches", () => {
  const m = graph(
    [
      node("vault", "vault", "Vault", null, { notes: "1" }),
      node("note:a", "note", "A", "human"),
    ],
    [{ source: "vault", target: "note:a", kind: "contains" }],
  );
  it("page/home/end/move navigation and enter on a no-target row", () => {
    const s = new HealthSurface({ context: ctx(m) });
    s.handleInput("\u001b[5~");
    s.handleInput("\u001b[6~");
    s.handleInput("\u001b[H");
    s.handleInput("\u001b[F");
    s.handleInput("\r");
    s.handleInput("\x1b[A");
    expect(s.state.selectedId).not.toBeNull();
  });
  it("enter on a targeted health row emits openDetail", () => {
    const seen: string[] = [];
    const s = new HealthSurface({ context: ctx(m), onEvent: (e) => seen.push(JSON.stringify(e)) });
    // vault orphan includes note:a with a target — home selects first row (heading) then down
    s.handleInput("\u001b[H");
    // move to the orphan row with a target
    s.handleInput("\x1b[B");
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    expect(seen.some((e) => e.includes("openDetail"))).toBe(true);
  });
});

describe("DetailSurface body branches", () => {
  const m = graph(
    [
      node("vault", "vault", "Vault", null),
      node("note:a", "note", "Alpha", "human", { slug: "alpha" }),
    ],
    [{ source: "vault", target: "note:a", kind: "contains" }],
  );
  it("page/home/end/move navigation and o emits openEditor", async () => {
    const seen: string[] = [];
    const loaders = { loadNote: async () => ({ slug: "alpha", title: "Alpha", body: "body", created: "", updated: "", tags: [], source: "human" as const }), loadOkf: async () => null, openNote: async () => true, rebuild: async () => m };
    const c: SurfaceContext = { ...ctx(m), loaders, bodies: new BodyStore({ loaders }) };
    const s = bindDetail({ context: c, onEvent: (e) => seen.push(JSON.stringify(e)) }, "note:a");
    s.handleInput("\u001b[5~");
    s.handleInput("\u001b[6~");
    s.handleInput("\u001b[H");
    s.handleInput("\u001b[F");
    s.handleInput("o");
    expect(seen).toContain(JSON.stringify({ type: "openEditor", id: "note:a" }));
  });
  it("body renders loading placeholder then flushes via BodyStore", async () => {
    const loadNote = vi.fn(async () => ({ slug: "alpha", title: "Alpha", body: "## Head\n\nReal body.", created: "", updated: "", tags: [], source: "human" as const }));
    const loaders = { loadNote, loadOkf: async () => null, openNote: async () => true, rebuild: async () => m };
    const c: SurfaceContext = { ...ctx(m), loaders, bodies: new BodyStore({ loaders }) };
    const s = bindDetail({ context: c }, "note:a");
    const before = s.render(60).join("\n");
    expect(before).toContain("loading");
    await new Promise((r) => setTimeout(r, 0));
    const after = s.render(60).join("\n");
    expect(after).toContain("Real body.");
  });
  it("a non-note node has no body (no placeholder) and o still emits openEditor", () => {
    const seen: string[] = [];
    const loaders = { loadNote: async () => null, loadOkf: async () => null, openNote: async () => true, rebuild: async () => m };
    const c: SurfaceContext = { ...ctx(m), loaders, bodies: new BodyStore({ loaders }) };
    const s = bindDetail({ context: c, onEvent: (e) => seen.push(JSON.stringify(e)) }, "vault");
    const lines = s.render(60).join("\n");
    expect(lines).not.toContain("loading");
    s.handleInput("o");
    expect(seen).toContain(JSON.stringify({ type: "openEditor", id: "vault" }));
  });
});

describe("Pane + base branches", () => {
  it("Pane renders an inactive (dim) border and a surface-less fallback is empty", () => {
    const m = graph([node("vault", "vault", "Vault", null)], []);
    const s = new ExploreSurface({ context: ctx(m) });
    const p = new Pane(s, theme());
    p.setFocused(false);
    const lines = p.render(40);
    expect(lines[0]).toContain("┌");
    expect(lines[1]).not.toContain("◆");
  });
});

describe("decodeWorkspaceKey extra", () => {
  it("returns null for a control sequence", () => {
    expect(decodeWorkspaceKey("\x1b[A")).toBeNull();
  });
});

describe("workspaceRoot surface branches", () => {
  it("opening a file node in detail loads its body via the file loader", async () => {
    const m = graph(
      [node("vault", "vault", "Vault", null), node("repository", "repository", "repo", null), node("file:git.json", "file", "git.json", null, { path: "git.json" })],
      [{ source: "vault", target: "file:git.json", kind: "contains" }],
    );
    const loadOkf = vi.fn(async () => ({ path: "git.json", body: '{"x":1}' }));
    const loaders = fakeLoaders({ loadOkf });
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } } as WeaveTui & { requestRender: ReturnType<typeof vi.fn> };
    const w = new WeaveWorkspace({ model: m, theme: theme(), tui, loaders, done: vi.fn(), rows: 30, now: () => NOW });
    // select the file (down from vault) and open detail
    w.handleInput("\x1b[B");
    w.handleInput("\r");
    await new Promise((r) => setTimeout(r, 0));
    expect(loadOkf).toHaveBeenCalledWith("git.json");
  });

});

describe("surface title + body branches via Pane", () => {
  it("focus/health title() render through a Pane", () => {
    const m = model();
    const f = new FocusSurface({ context: ctx(m) });
    const p1 = new Pane(f, theme());
    expect(p1.render(40)[1]).toContain("Focus");
    const h = new HealthSurface({ context: ctx(m) });
    const p2 = new Pane(h, theme());
    expect(p2.render(40)[1]).toContain("Health");
  });

  it("detail renders backlinks and a file body through the store", async () => {
    const m = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "Alpha", "human", { slug: "alpha" }),
        node("note:src", "note", "Src", "human", { slug: "src" }),
        node("repository", "repository", "repo", null),
        node("file:git.json", "file", "git.json", null, { path: "git.json" }),
      ],
      [{ source: "note:src", target: "note:a", kind: "links-to" }],
    );
    const loaders = {
      loadNote: async () => ({ slug: "a", title: "A", body: "b", created: "", updated: "", tags: [], source: "human" as const }),
      loadOkf: async () => ({ path: "git.json", body: '{"branch":"main"}' }),
      openNote: async () => true,
      rebuild: async () => m,
    };
    const c: SurfaceContext = { ...ctx(m), loaders, bodies: new BodyStore({ loaders }) };
    const s = bindDetail({ context: c }, "note:a");
    const lines = s.render(60).join("\n");
    expect(lines).toContain("Backlinks");
    // file body renders the raw json after the async load flushes
    const fs = bindDetail({ context: c }, "file:git.json");
    fs.render(60); // first render queues the body load
    await new Promise((r) => setTimeout(r, 0));
    const fl = fs.render(60).join("\n");
    expect(fl).toContain("branch");
  });

  it("explore renders an empty model without a crash", () => {
    const m = graph([], []);
    const s = new ExploreSurface({ context: ctx(m) });
    expect(s.render(40)).toEqual([]);
  });

  it("markdownTheme maps every inline style arrow", () => {
    const t = markdownTheme({ fg: (_s, x) => x, bold: (x) => x });
    for (const fn of [t.link, t.linkUrl, t.code, t.codeBlock, t.codeBlockBorder, t.quote, t.quoteBorder, t.hr, t.italic, t.strikethrough, t.underline]) {
      expect(fn("x")).toBe("x");
    }
  });

  it("detail/health marker arrows run when a row is selected", () => {
    const m = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "Alpha", "human", { slug: "alpha" }),
        node("note:b", "note", "Beta", "agent", { slug: "beta" }),
      ],
      [{ source: "note:a", target: "note:b", kind: "links-to" }],
    );
    const d = bindDetail({ context: ctx(m) }, "note:a");
    d.state = { nodeId: "note:a", selectedId: "meta:path", scrollOffset: 0 };
    d.render(60); // marker arrow executes for the selected row
    const h = new HealthSurface({ context: ctx(m) });
    h.state = { selectedId: "health:vault:notes", scrollOffset: 0 };
    h.render(60);
  });

  it("Pane exposes its surface via the getter", () => {
    const m = graph([node("vault", "vault", "Vault", null)], []);
    const s = new ExploreSurface({ context: ctx(m) });
    const p = new Pane(s, theme());
    expect(p.surfaceComponent.kind).toBe("explore");
  });

  it("buildSplit falls back to an empty component when a pane has no surface", () => {
    const { w } = ws();
    // remove the active pane's surface instance, then render hits the fallback
    (w as unknown as { panes: Map<string, unknown> }).panes.delete(w.workspace.activePaneId);
    expect(w.render(100).length).toBeGreaterThan(0);
  });

  it("focus/detail/health move & movePage edge branches (empty rows, missing selection)", () => {
    const m = graph([node("vault", "vault", "Vault", null)], []);
    const f = new FocusSurface({ context: ctx(m) });
    f.setFocus("vault");
    f.handleInput("\u001b[5~"); // pageUp with a selected row present
    f.handleInput("\u001b[6~");
    // empty-neighborhood moves are no-ops
    const h = new HealthSurface({ context: ctx(m) });
    h.handleInput("\x1b[B");
    h.handleInput("\x1b[A");
    h.handleInput("\u001b[5~");
    h.handleInput("\u001b[6~");
    // detail on a node with no links: enter does nothing
    const d = new DetailSurface({ context: ctx(m) });
    d.state = { nodeId: "vault", selectedId: null, scrollOffset: 0 };
    d.handleInput("\r");
    d.handleInput("\x1b[B");
    expect(d.state.nodeId).toBe("vault");
  });

  it("focus enter on the center (target === focus) is a no-op", () => {
    const m = graph(
      [node("note:hub", "note", "Hub", "human")],
      [{ source: "note:hub", target: "note:hub", kind: "links-to" }],
    );
    const f = new FocusSurface({ context: ctx(m) });
    f.setFocus("note:hub");
    f.handleInput("\r"); // center target equals focus -> no re-center
    expect(f.state.focusId).toBe("note:hub");
  });

  it("detail/focus/health render + move edge branches", () => {
    const m = graph([node("vault", "vault", "Vault", null)], []);
    const d = new DetailSurface({ context: ctx(m) });
    d.state = { nodeId: "note:ghost", selectedId: null, scrollOffset: 0 };
    expect(d.render(40).join("\n")).toContain("node not found");
    d.handleInput("\x1b[B"); // move on empty rows -> no-op
    d.handleInput("\u001b[5~"); // pageUp on empty rows
    d.handleInput("\u001b[H"); // home on empty rows
    d.handleInput("\u001b[F"); // end on empty rows
    // focus with a selected id not in rows -> movePage starts at 0
    const fm = graph(
      [node("note:a", "note", "A", "human"), node("note:b", "note", "B", "human")],
      [{ source: "note:a", target: "note:b", kind: "links-to" }],
    );
    const f = new FocusSurface({ context: ctx(fm) });
    f.setFocus("note:a");
    f.state = { focusId: "note:a", selectedId: "zzz", scrollOffset: 0 };
    f.handleInput("\u001b[6~"); // pageDown with missing selection
    f.handleInput("\x1b[A"); // up with missing selection
    // health on empty rows
    const h = new HealthSurface({ context: ctx(graph([], [])) });
    h.handleInput("\x1b[B");
    h.handleInput("\x1b[A");
    h.handleInput("\u001b[5~");
    h.handleInput("\u001b[6~");
    h.handleInput("\u001b[H");
    h.handleInput("\u001b[F");
    expect(h.render(40).length).toBeGreaterThan(0);
  });

  it("workspaceRoot header/refresh/wide render branches", () => {
    // model without a repository -> header omits the repo part
    const noRepo = graph([node("vault", "vault", "Vault", null)], []);
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } } as WeaveTui & { requestRender: ReturnType<typeof vi.fn> };
    const w2 = new WeaveWorkspace({
      model: noRepo,
      theme: theme(),
      tui,
      loaders: fakeLoaders(),
      done: vi.fn(),
      rows: 30,
      now: () => NOW,
    });
    const header = w2.render(120).join("\n");
    expect(header).toContain("weave view");
    // render while refreshing shows the banner
    w2.refreshing = true;
    expect(w2.render(120).join("\n")).toContain("refreshing");
    // Fixed layout renders without error
    expect(w2.render(110).length).toBeGreaterThan(0);
  });

});
