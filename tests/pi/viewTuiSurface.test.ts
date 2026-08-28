import { describe, expect, it, vi } from "vitest";
import { Pane, windowLines } from "../../src/pi/viewer/tui/surface/base";
import { ExploreSurface } from "../../src/pi/viewer/tui/surface/explore";
import { bindDetail, DetailSurface, markdownTheme } from "../../src/pi/viewer/tui/surface/detail";
import { FocusSurface } from "../../src/pi/viewer/tui/surface/focus";
import { HealthSurface } from "../../src/pi/viewer/tui/surface/health";
import type { SurfaceContext, SurfaceEventHandler, SurfaceInit } from "../../src/pi/viewer/tui/surface/base";
import { BodyStore } from "../../src/pi/viewer/tui/bodyStore";
import type { WeaveTheme, WeaveLoaders } from "../../src/pi/viewer/tui/explorer";
import type { GraphModel, GraphNode } from "../../src/core/graph/model";
import type { NoteSource } from "../../src/core/types";
import { visibleWidth } from "@earendil-works/pi-tui";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
function theme(): WeaveTheme {
  return {
    fg: (_s, t) => t,
    bg: (_s, t) => t,
    bold: (t) => t,
  };
}
function node(id: string, kind: GraphNode["kind"], label: string, prov: NoteSource | null, detail: Record<string, string> = {}): GraphNode {
  return { id, kind, label, provenance: prov, detail };
}
function graph(nodes: GraphNode[], edges: GraphModel["edges"]): GraphModel {
  return { generatedAt: "2026-06-01T00:00:00.000Z", staleness: null, nodes, edges, danglingLinks: {}, contentDigest: "" };
}
function ctx(model: GraphModel): SurfaceContext {
  return {
    model,
    theme: theme(),
    loaders: {
      loadNote: async () => null,
      loadOkf: async () => null,
      openNote: async () => true,
      rebuild: async () => model,
    } as WeaveLoaders,
    bodies: new BodyStore({ loaders: { loadNote: async () => null, loadOkf: async () => null } }),
    now: () => NOW,
  };
}

describe("windowLines", () => {
  it("windows lines around a selection, adding the marker to the selected line", () => {
    const lines = ["a", "b", "c", "d"];
    const out = windowLines(lines, 2, 0, 2, (t) => `>${t}`);
    expect(out).toEqual(["  b", ">c"]);
  });
  it("clamps offset beyond content back to a valid range", () => {
    expect(windowLines(["x"], -1, 5, 2, (t) => t)).toEqual(["  x"]);
  });
  it("scrolls the window up when the selection is above the current offset", () => {
    const out = windowLines(["a", "b", "c", "d", "e"], 0, 3, 3, (t) => `>${t}`);
    expect(out).toEqual([">a", "  b", "  c"]);
  });
});

describe("ExploreSurface", () => {
  const model = graph(
    [node("vault", "vault", "Vault", null), node("note:a", "note", "Alpha", "human", { slug: "alpha" }), node("note:b", "note", "Beta", "agent", { slug: "beta" })],
    [
      { source: "vault", target: "note:a", kind: "contains" },
      { source: "vault", target: "note:b", kind: "contains" },
    ],
  );
  it("renders tree rows within width and selects the first root", () => {
    const s = new ExploreSurface({ context: ctx(model) });
    for (const l of s.render(60)) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
    expect(s.render(60).join("\n")).toContain("Alpha");
    expect(s.state.selectedId).toBe("vault");
  });
  it("navigates down and emits openDetail on enter", () => {
    const seen: string[] = [];
    const onEvent: SurfaceEventHandler = (e) => seen.push(JSON.stringify(e));
    const s = new ExploreSurface({ context: ctx(model), onEvent });
    s.handleInput("\x1b[B"); // down -> note:a
    expect(s.state.selectedId).toBe("note:a");
    s.handleInput("\r"); // enter -> openDetail
    expect(seen).toContain(JSON.stringify({ type: "openDetail", id: "note:a" }));
  });
  it("emits focusNode on f", () => {
    const seen: string[] = [];
    const onEvent: SurfaceEventHandler = (e) => seen.push(JSON.stringify(e));
    const s = new ExploreSurface({ context: ctx(model), onEvent });
    s.handleInput("\x1b[B");
    s.handleInput("f");
    expect(seen).toContain(JSON.stringify({ type: "focusNode", id: "note:a" }));
  });
  it("supports search sub-mode and provenance cycling", () => {
    const s = new ExploreSurface({ context: ctx(model) });
    s.handleInput("/");
    expect(s.state.searching).toBe(true);
    s.handleInput("b");
    expect(s.state.query).toBe("b");
    s.handleInput("\r"); // commit search
    expect(s.state.searching).toBe(false);
    s.handleInput("p");
    expect(s.state.provFilter).toBe("human");
  });
  it("renders an empty model without crashing", () => {
    const s = new ExploreSurface({ context: ctx(graph([], [])) });
    expect(s.render(40)).toEqual([]);
  });
  it("renders the empty-hint when filtering empties the tree", () => {
    const m = graph([node("vault", "vault", "Vault", null, { notes: "0" })], []);
    const s = new ExploreSurface({ context: ctx(m) });
    // filter to a provenance the structural vault (null) does not match
    s.state.provFilter = "human";
    expect(s.render(60).join("\n")).toContain("no notes yet");
  });
  it("ignores an unmapped key (no action to apply)", () => {
    const s = new ExploreSurface({ context: ctx(model) });
    const before = s.state.selectedId;
    s.handleInput("\t"); // tab is not a tree action
    expect(s.state.selectedId).toBe(before);
  });
  it("renders the search prompt line while searching", () => {
    const s = new ExploreSurface({ context: ctx(model) });
    s.handleInput("/");
    s.handleInput("a");
    expect(s.render(60).join("\n")).toContain("/a");
  });
});

describe("DetailSurface", () => {
  const model = graph(
    [
      node("vault", "vault", "Vault", null),
      node("note:a", "note", "Alpha", "human", { slug: "alpha" }),
      node("note:b", "note", "Beta", "agent", { slug: "beta" }),
    ],
    [
      { source: "vault", target: "note:a", kind: "contains" },
      { source: "note:a", target: "note:b", kind: "links-to" },
    ],
  );
  it("shows the detail of its bound node and renders body through Markdown", () => {
    const c = ctx(model);
    const loaders: WeaveLoaders = {
      loadNote: async () => ({ slug: "alpha", title: "Alpha", body: "# Hello\n\nSome **body** text.", created: "", updated: "", tags: [], source: "human" as const }),
      loadOkf: async () => null,
      openNote: async () => true,
      rebuild: async () => model,
    };
    const surfaceCtx: SurfaceContext = { ...c, loaders, bodies: new BodyStore({ loaders }) };
    const s = bindDetail({ context: surfaceCtx }, "note:a");
    const lines = s.render(60).join("\n");
    expect(lines).toContain("Alpha");
    expect(lines).toContain("Links");
  });
  it("renders meta rows and navigates (enter on the active link rebinds the pane)", () => {
    const s = bindDetail({ context: ctx(model) }, "note:a");
    const d = s.render(60).join("\n");
    expect(d).toContain("Links");
    // The link row is the selectable row nearest the viewport center, so Enter
    // rebinds the pane to note:b (arrows scroll; with a short note the content
    // fits the viewport so down is a no-op, but the active row is still the link).
    s.handleInput("\x1b[B");
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    expect(s.state.nodeId).toBe("note:b");
  });
  it("arrow keys scroll a long note body and clamp at top/bottom", async () => {
    const longBody = "# Title\n\n" + Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const loaders: WeaveLoaders = {
      loadNote: async () => ({ slug: "alpha", title: "Alpha", body: longBody, created: "", updated: "", tags: [], source: "human" as const }),
      loadOkf: async () => null,
      openNote: async () => true,
      rebuild: async () => model,
    };
    const bodies = new BodyStore({ loaders });
    const surfaceCtx: SurfaceContext = { ...ctx(model), loaders, bodies };
    const s = bindDetail({ context: surfaceCtx }, "note:a");
    s.paneRows = 8;
    s.render(60); // trigger the async body load
    await new Promise((r) => setTimeout(r, 0)); // let loadNote resolve
    s.render(60); // rebuild the cached line layout with the real body
    expect(s.state.scrollOffset).toBe(0);
    s.handleInput("\x1b[B"); // down one
    expect(s.state.scrollOffset).toBe(1);
    s.handleInput("\x1b[6~"); // pageDown (paneRows = 8) -> 1 + 8
    expect(s.state.scrollOffset).toBe(9);
    s.handleInput("\x1b[F"); // end -> bottom
    const bottom = s.state.scrollOffset;
    expect(bottom).toBeGreaterThan(8);
    s.handleInput("\x1b[B"); // down past bottom -> clamp
    expect(s.state.scrollOffset).toBe(bottom);
    s.handleInput("\x1b[H"); // home -> top
    expect(s.state.scrollOffset).toBe(0);
    s.handleInput("\x1b[A"); // up past top -> clamp
    expect(s.state.scrollOffset).toBe(0);
  });
  it("/ enters goto-line mode; digits + Enter jump; Esc cancels", async () => {
    const longBody = "# Title\n\n" + Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const loaders: WeaveLoaders = {
      loadNote: async () => ({ slug: "alpha", title: "Alpha", body: longBody, created: "", updated: "", tags: [], source: "human" as const }),
      loadOkf: async () => null,
      openNote: async () => true,
      rebuild: async () => model,
    };
    const bodies = new BodyStore({ loaders });
    const surfaceCtx: SurfaceContext = { ...ctx(model), loaders, bodies };
    const s = bindDetail({ context: surfaceCtx }, "note:a");
    s.paneRows = 8;
    s.render(60);
    await new Promise((r) => setTimeout(r, 0));
    s.render(60);
    s.handleInput("/"); // enter goto mode
    expect(s.state.gotoBuf).toBe("");
    expect(s.render(60).join("\n")).toContain("/");
    s.handleInput("1");
    s.handleInput("2");
    expect(s.state.gotoBuf).toBe("12");
    s.handleInput("\r"); // Enter -> jump to line 12 (1-indexed -> offset 11)
    expect(s.state.scrollOffset).toBe(11);
    expect(s.state.gotoBuf).toBeNull();
    // Esc cancels without changing the offset.
    s.handleInput("/");
    s.handleInput("5");
    expect(s.state.gotoBuf).toBe("5");
    s.handleInput("\x1b"); // escape
    expect(s.state.gotoBuf).toBeNull();
    expect(s.state.scrollOffset).toBe(11);
  });
  it("goto-line mode: backspace deletes and unmapped keys are ignored", async () => {
    const longBody = "# Title\n\n" + Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const loaders: WeaveLoaders = {
      loadNote: async () => ({ slug: "alpha", title: "Alpha", body: longBody, created: "", updated: "", tags: [], source: "human" as const }),
      loadOkf: async () => null,
      openNote: async () => true,
      rebuild: async () => model,
    };
    const bodies = new BodyStore({ loaders });
    const surfaceCtx: SurfaceContext = { ...ctx(model), loaders, bodies };
    const s = bindDetail({ context: surfaceCtx }, "note:a");
    s.paneRows = 8;
    s.render(60);
    await new Promise((r) => setTimeout(r, 0));
    s.render(60);
    s.handleInput("/");
    s.handleInput("1");
    s.handleInput("2");
    expect(s.state.gotoBuf).toBe("12");
    s.handleInput("\x7f"); // backspace -> drop last digit
    expect(s.state.gotoBuf).toBe("1");
    s.handleInput("x"); // unmapped key -> ignored, still in goto mode
    expect(s.state.gotoBuf).toBe("1");
    s.handleInput("\x7f"); // backspace on single digit -> exit goto mode
    expect(s.state.gotoBuf).toBeNull();
  });
  it("render clamps an out-of-range scrollOffset back into the viewport", async () => {
    const longBody = "# Title\n\n" + Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const loaders: WeaveLoaders = {
      loadNote: async () => ({ slug: "alpha", title: "Alpha", body: longBody, created: "", updated: "", tags: [], source: "human" as const }),
      loadOkf: async () => null,
      openNote: async () => true,
      rebuild: async () => model,
    };
    const bodies = new BodyStore({ loaders });
    const surfaceCtx: SurfaceContext = { ...ctx(model), loaders, bodies };
    const s = bindDetail({ context: surfaceCtx }, "note:a");
    s.paneRows = 8;
    s.render(60);
    await new Promise((r) => setTimeout(r, 0));
    s.render(60);
    s.state = { ...s.state, scrollOffset: 99999 };
    s.render(60);
    expect(s.state.scrollOffset).toBeGreaterThan(0);
    expect(s.state.scrollOffset).toBeLessThan(99999); // clamped down to the bottom
    s.state = { ...s.state, scrollOffset: -5 };
    s.render(60);
    expect(s.state.scrollOffset).toBe(0); // clamped up to the top
  });
  it("renders '(no selection)' / '(node not found)' states", () => {
    const s = new DetailSurface({ context: ctx(model) });
    s.state = { nodeId: null, selectedId: null, scrollOffset: 0 };
    expect(s.render(40).join("\n")).toContain("no selection");
    s.state = { nodeId: "note:ghost", selectedId: null, scrollOffset: 0 };
    expect(s.render(40).join("\n")).toContain("node not found");
  });
  it("markdownTheme maps every slot", () => {
    const t = markdownTheme({ fg: (_s, x) => x, bold: (x) => x });
    expect(t.heading("x")).toBe("x");
    expect(t.listBullet("•")).toBe("•");
    expect(t.bold("y")).toBe("y");
  });
});

describe("FocusSurface", () => {
  const model = graph(
    [
      node("vault", "vault", "Vault", null),
      node("note:a", "note", "Alpha", "human"),
      node("note:b", "note", "Beta", "agent"),
    ],
    [
      { source: "vault", target: "note:a", kind: "contains" },
      { source: "note:a", target: "note:b", kind: "links-to" },
    ],
  );
  it("renders the neighborhood and re-centers on enter", () => {
    const s = new FocusSurface({ context: ctx(model) });
    s.setFocus("note:a");
    const lines = s.render(60).join("\n");
    expect(lines).toContain("Alpha");
    expect(lines).toContain("links to");
    s.handleInput("\x1b[B"); // down to neighbor
    s.handleInput("\r"); // re-center on note:b
    expect(s.state.focusId).toBe("note:b");
  });
  it("renders the '(no focus node)' state", () => {
    const s = new FocusSurface({ context: ctx(model) });
    expect(s.render(40).join("\n")).toContain("no focus node");
  });
  it("renders with a focus set but no selected row (selId null branch)", () => {
    const s = new FocusSurface({ context: ctx(model) });
    s.setFocus("note:a");
    s.state = { focusId: "note:a", selectedId: null, scrollOffset: 0 };
    expect(s.render(60).join("\n")).toContain("Alpha");
  });
  it("renders a center with no target for an unknown focus id", () => {
    const s = new FocusSurface({ context: ctx(model) });
    s.setFocus("ghost");
    expect(s.render(60).join("\n")).toContain("ghost");
  });
  it("emits focusNode on g", () => {
    const seen: string[] = [];
    const onEvent: SurfaceEventHandler = (e) => seen.push(JSON.stringify(e));
    const s = new FocusSurface({ context: ctx(model), onEvent });
    s.setFocus("note:a");
    s.handleInput("g");
    expect(seen).toContain(JSON.stringify({ type: "focusNode", id: "note:a" }));
  });
});

describe("HealthSurface", () => {
  const model = graph(
    [
      node("repository", "repository", "repo", null, { files: "2", state: "stale" }),
      node("vault", "vault", "Vault", null, { notes: "1" }),
      node("note:a", "note", "Alpha", "human"),
    ],
    [{ source: "repository", target: "vault", kind: "contains" }],
  );
  it("renders health sections", () => {
    const s = new HealthSurface({ context: ctx(model) });
    const lines = s.render(60).join("\n");
    expect(lines).toContain("Repository");
    expect(lines).toContain("Link health");
  });
  it("emits openDetail when entering a targeted health row", () => {
    const seen: string[] = [];
    const onEvent: SurfaceEventHandler = (e) => seen.push(JSON.stringify(e));
    const s = new HealthSurface({ context: ctx(model), onEvent });
    // move down to a targeted row (orphans list includes note:a)
    s.handleInput("\x1b[B");
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    expect(seen.length).toBeGreaterThan(0);
  });
  it("enter on a targeted row with no onEvent callback does not throw", () => {
    const s = new HealthSurface({ context: ctx(model) });
    s.handleInput("\x1b[B");
    s.handleInput("\x1b[B");
    s.handleInput("\r");
    expect(s.state.selectedId).not.toBeNull();
  });
});

describe("Pane", () => {
  const model = graph([node("vault", "vault", "Vault", null), node("note:a", "note", "Alpha", "human")], [{ source: "vault", target: "note:a", kind: "contains" }]);
  it("wraps a surface in a bordered box with a title and focus ring", () => {
    const s = new ExploreSurface({ context: ctx(model) });
    const p = new Pane(s, theme());
    p.setFocused(true);
    const lines = p.render(40);
    expect(lines[0]).toContain("┌");
    expect(lines[1]).toContain("Explore");
    expect(lines[1]).toContain("◆");
    expect(lines[lines.length - 1]).toContain("└");
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
  });
  it("inactive pane uses a dim ring (no ◆)", () => {
    const s = new ExploreSurface({ context: ctx(model) });
    const p = new Pane(s, theme());
    p.setFocused(false);
    expect(p.render(40)[1]).not.toContain("◆");
  });
  it("truncates a title wider than the pane (overflow branch)", () => {
    const s = new ExploreSurface({ context: ctx(model) });
    const p = new Pane(s, theme());
    p.setFocused(true);
    const lines = p.render(4);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[1]!.length).toBeGreaterThan(0);
  });
  it("invalidate re-renders", () => {
    const s = new ExploreSurface({ context: ctx(model) });
    const p = new Pane(s, theme());
    const a = p.render(40);
    p.invalidate();
    const b = p.render(40);
    expect(a).not.toBe(b);
  });

  // Regression guard: the real pi Theme stores `fg` as a METHOD that reads
  // `this.fgColors.get(slot)`. Pane's default `borderFn` must keep the theme
  // binding — a bare `theme.fg` default detaches `this` and crashes at runtime
  // ("Cannot read properties of undefined (reading 'get')"), which the
  // arrow-based fake theme above does NOT catch. This test uses a method-based
  // theme and constructs Pane WITHOUT a custom borderFn.
  it("default borderFn preserves the theme `this` binding (no detached-method crash)", () => {
    class RealishTheme {
      private readonly colors: Record<string, string> = {
        accent: "\x1b[35m",
        dim: "\x1b[2m",
        muted: "\x1b[2m",
      };
      fg(slot: string, text: string): string {
        const ansi = this.colors[slot] ?? "";
        return `${ansi}${text}\x1b[39m`;
      }
      bold(text: string): string {
        return `\x1b[1m${text}\x1b[22m`;
      }
    }
    const s = new ExploreSurface({ context: ctx(model) });
    // No custom borderFn -> exercises the default that must bind through theme.
    const p = new Pane(s, new RealishTheme() as unknown as import("../../src/pi/viewer/tui/surface/base").PaneTheme);
    p.setFocused(true);
    const lines = p.render(40);
    expect(lines.length).toBeGreaterThan(0);
    // The active border uses the accent color from the theme's own map (proves
    // `this` was bound, not the Pane).
    expect(lines[0]).toContain("\x1b[35m");
    expect(lines[0]).toContain("┌");
  });
});
