/**
 * The shell's pure models (weave-workspace §1.2, §10).
 *
 * `shell.model.ts`, `drag.model.ts`, `cssvars.ts`, `bootstrap.ts` and
 * `workspace.ts` between them hold every decision the shell makes. The `.tsx`
 * files hold none, which is what makes this suite the real coverage of the
 * shell rather than a proxy for it: there is no DOM test environment (§10)
 * and none is needed, because nothing that branches lives in a component.
 */

import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_BOOTSTRAP, readBootstrap } from "../../src/web/client/bootstrap";
import { applyVars } from "../../src/web/client/shell/cssvars";
import type { StyledElement } from "../../src/web/client/shell/cssvars";
import { NUDGE_PX, beginDrag, dividerHandlers, dragChanged, dragTo, nudgeFor } from "../../src/web/client/shell/drag.model";
import { DEFAULT_FRACTIONS, defaultLayout, makeLayout, resolveColumns } from "../../src/web/client/shell/layout.model";
import type { LayoutState } from "../../src/web/client/shell/layout.model";
import type { OverlayId } from "../../src/web/client/shell/shell.model";
import {
  CONTEXT_EMPTY,
  EMPTY_SUMMARY,
  NO_VALUE,
  SEARCH_PLACEHOLDER,
  columnSlots,
  connectionView,
  emptyStateFor,
  looksApple,
  repoLabel,
  searchHint,
  searchShortcut,
  shortStamp,
  statusBarModel,
  summarize,
  summaryParts,
} from "../../src/web/client/shell/shell.model";
import { COLUMNS, breakpointFor } from "../../src/web/client/shell/layout.model";
import { watchViewport } from "../../src/web/client/shell/viewport";
import { connection, graph, noteBody, selectedId } from "../../src/web/client/state";
import type { GraphPayload, WireGraphNode, WireStalenessState } from "../../src/web/shared/wire";

afterEach(() => {
  selectedId.value = null;
  graph.value = null;
  noteBody.value = null;
  connection.value = "live";
});

// --- fixtures ---------------------------------------------------------------------

function node(id: string, kind: WireGraphNode["kind"]): WireGraphNode {
  return { id, kind, label: id, provenance: null, detail: {} };
}

function payload(nodes: WireGraphNode[], staleness: WireStalenessState | null = null): GraphPayload {
  return {
    model: {
      generatedAt: "2026-03-04T09:08:07Z",
      staleness: staleness === null ? null : { state: staleness, reasons: [] },
      nodes,
      edges: [],
      contentDigest: "",
    },
    tags: {},
    dangling: {},
    positions: null,
    stamp: "2026-03-04T09:08:07Z",
  };
}

// --- the header summary --------------------------------------------------------------

describe("summarize", () => {
  it("is all zeroes and unindexed before the first graph", () => {
    expect(summarize(null)).toEqual(EMPTY_SUMMARY);
    expect(summarize(null).repo).toBeNull();
  });

  it("counts note nodes as the vault count, and everything as nodes", () => {
    const p = payload([node("note:a", "note"), node("note:b", "note"), node("repo", "repository"), node("v", "vault")]);
    expect(summarize(p)).toEqual({ notes: 2, repo: null, nodes: 4 });
  });

  it("does not count the vault container node as a note", () => {
    // `vault:1` for an empty vault would read as "one note in there".
    expect(summarize(payload([node("v", "vault")])).notes).toBe(0);
  });

  it("carries the staleness state through", () => {
    expect(summarize(payload([], "fresh")).repo).toBe("fresh");
    expect(summarize(payload([], "stale")).repo).toBe("stale");
  });

  it("handles a graph with no nodes at all", () => {
    expect(summarize(payload([]))).toEqual({ notes: 0, repo: null, nodes: 0 });
  });
});

describe("repoLabel", () => {
  it("calls an unscanned repository unindexed, not missing", () => {
    // "missing" reads as a fault; never-scanned is the ordinary first run.
    expect(repoLabel(null)).toBe("unindexed");
    expect(repoLabel("missing")).toBe("unindexed");
  });

  it("passes real states through", () => {
    expect(repoLabel("fresh")).toBe("fresh");
    expect(repoLabel("stale")).toBe("stale");
  });
});

describe("summaryParts", () => {
  it("renders the §1.2 readout", () => {
    expect(summaryParts({ notes: 34, repo: "fresh", nodes: 127 })).toEqual([
      "vault:34",
      "repo:fresh",
      "127 nodes",
    ]);
  });

  it("is honest about an empty workspace", () => {
    expect(summaryParts(EMPTY_SUMMARY)).toEqual(["vault:0", "repo:unindexed", "0 nodes"]);
  });
});

// --- the connection indicator ------------------------------------------------------

describe("connectionView", () => {
  it("is total over the three states of §1.3", () => {
    for (const state of ["live", "reconnecting", "offline"] as const) {
      const view = connectionView(state);
      expect(view.label).toBe(state);
      expect(view.hint).not.toBe("");
    }
  });

  it("tones escalate ok → warn → bad", () => {
    expect(connectionView("live").tone).toBe("ok");
    expect(connectionView("reconnecting").tone).toBe("warn");
    expect(connectionView("offline").tone).toBe("bad");
  });

  it("tells a reconnecting user the screen will catch up on its own", () => {
    // §6 refetches everything on reopen, so they should not go hunting for a
    // reload button.
    expect(connectionView("reconnecting").hint).toContain("refetch");
  });
});

// --- empty states -------------------------------------------------------------------

describe("empty states", () => {
  it("names a phase for every column, so nothing reads as broken", () => {
    for (const id of COLUMNS) {
      const copy = emptyStateFor(id);
      expect(copy.title).not.toBe("");
      expect(copy.body).not.toBe("");
      expect(copy.phase).toMatch(/^P\d$/);
    }
  });

  it("puts the tree and note in P2 and the graph in P3, matching §11", () => {
    expect(emptyStateFor("tree").phase).toBe("P2");
    expect(emptyStateFor("note").phase).toBe("P2");
    expect(emptyStateFor("graph").phase).toBe("P3");
  });

  it("gives the context rail its own copy", () => {
    expect(CONTEXT_EMPTY.title).toBe("Context");
    expect(CONTEXT_EMPTY.phase).toBe("P2");
  });
});

// --- column / divider pairing ---------------------------------------------------------

describe("columnSlots", () => {
  it("puts a divider after every column but the last", () => {
    const slots = columnSlots(resolveColumns(defaultLayout(1600), 1600, "wide"));
    expect(slots.map((s) => s.column.id)).toEqual(["tree", "note", "graph"]);
    expect(slots.map((s) => s.divider)).toEqual(["tree", "note", null]);
  });

  it("emits exactly one divider at the medium breakpoint", () => {
    // The bug this function exists to prevent: `DIVIDERS` has two entries, but
    // with the graph collapsed there is only one gap to resize.
    const slots = columnSlots(resolveColumns(defaultLayout(900), 900, "medium"));
    expect(slots.map((s) => s.column.id)).toEqual(["tree", "note"]);
    expect(slots.map((s) => s.divider)).toEqual(["tree", null]);
  });

  it("emits no divider when only the note column renders", () => {
    const slots = columnSlots(resolveColumns(defaultLayout(600), 600, "narrow"));
    expect(slots).toHaveLength(1);
    expect(slots[0]?.divider).toBeNull();
  });

  it("returns nothing for no columns", () => {
    expect(columnSlots([])).toEqual([]);
  });
});

// --- the status bar --------------------------------------------------------------------

describe("statusBarModel", () => {
  it("shows the cwd, the selection and the connection", () => {
    const model = statusBarModel("/repo", "note:alpha", "live", "2026-03-04T09:08:07Z");
    expect(model.cwd).toBe("/repo");
    expect(model.selection).toBe("note:alpha");
    expect(model.connection.tone).toBe("ok");
    expect(model.stamp).toBe("2026-03-04T09:08:07Z");
  });

  it("says so when nothing is selected", () => {
    expect(statusBarModel("/repo", null, "live", null).selection).toBe("nothing selected");
  });

  it("falls back to a dash for an absent cwd", () => {
    expect(statusBarModel("", null, "live", null).cwd).toBe(NO_VALUE);
  });
});

describe("shortStamp", () => {
  it("keeps only the time from an ISO stamp", () => {
    expect(shortStamp("2026-03-04T09:08:07Z")).toBe("09:08:07");
    expect(shortStamp("2026-03-04T09:08:07.123Z")).toBe("09:08:07");
  });

  it("is a dash when there is no stamp yet", () => {
    expect(shortStamp(null)).toBe(NO_VALUE);
  });

  it("passes a non-ISO stamp through rather than slicing it blindly", () => {
    // The server derives the stamp and may change how; a mangled substring
    // would be a worse lie than the whole value.
    expect(shortStamp("rev-42")).toBe("rev-42");
  });
});

// --- the search affordance ----------------------------------------------------------------

describe("search affordance", () => {
  it("uses the Apple spelling only on Apple platforms", () => {
    expect(searchShortcut(true)).toBe("⌘K");
    expect(searchShortcut(false)).toBe("Ctrl K");
  });

  it("recognises Apple platform strings", () => {
    for (const platform of ["MacIntel", "iPhone", "iPad", "macOS"]) {
      expect(looksApple(platform)).toBe(true);
    }
  });

  it("defaults everything else to Ctrl, including an empty platform", () => {
    for (const platform of ["Win32", "Linux x86_64", ""]) {
      expect(looksApple(platform)).toBe(false);
    }
  });

  it("names the shortcut in the tooltip, now that the control is live", () => {
    // Was `SEARCH_DISABLED_HINT`, asserting the control admitted to being a
    // placeholder ("search arrives in P4"). P4 arrived, so the honest thing
    // it has to say changed: the hint now teaches the key that opens the
    // palette, which is the same action clicking it performs.
    expect(searchHint("⌘K")).toContain("⌘K");
    expect(searchHint("Ctrl K")).toContain("Ctrl K");
    expect(SEARCH_PLACEHOLDER).not.toBe("");
  });
});

// --- overlays ---------------------------------------------------------------------------

describe("OverlayId", () => {
  it("cannot represent two overlays at once", () => {
    // A type-level assertion, and the point of the design: two booleans could
    // hold `{search:true, help:true}` — two dialogs stacked, each trapping
    // focus against the other. This shape cannot.
    const states: OverlayId[] = ["search", "help", null];
    expect(new Set(states).size).toBe(3);
  });
});

// --- CSS custom properties ---------------------------------------------------------------

describe("applyVars", () => {
  /** A `style` that records what was set. The whole DOM surface, faked. */
  function target(): StyledElement & { readonly seen: Array<[string, string]> } {
    const seen: Array<[string, string]> = [];
    return { style: { setProperty: (name, value) => void seen.push([name, value]) }, seen };
  }

  it("writes every pair through setProperty — the CSSOM path, not an attribute", () => {
    const element = target();
    const written = applyVars(element, [
      ["--weave-col-tree", "352px"],
      ["--weave-col-note", "736px"],
    ]);
    expect(written).toBe(2);
    expect(element.seen).toEqual([
      ["--weave-col-tree", "352px"],
      ["--weave-col-note", "736px"],
    ]);
  });

  it("tolerates a null ref, which is every render before mount", () => {
    expect(applyVars(null, [["--x", "1px"]])).toBe(0);
  });

  it("writes nothing for an empty layout", () => {
    const element = target();
    expect(applyVars(element, [])).toBe(0);
    expect(element.seen).toEqual([]);
  });
});

// --- dragging ------------------------------------------------------------------------------

describe("drag gestures", () => {
  const WIDTH = 1600;

  it("measures from the gesture origin, not frame to frame", () => {
    // The property that keeps the divider under the pointer: dragging out to
    // +200 and back to +40 must land where a single +40 drag would.
    const base = defaultLayout(WIDTH);
    const drag = beginDrag("tree", 500, base, 1);
    dragTo(drag, 700, WIDTH);
    const back = dragTo(drag, 540, WIDTH);
    const direct = dragTo(beginDrag("tree", 500, base, 1), 540, WIDTH);
    expect(back.fractions).toEqual(direct.fractions);
  });

  it("widens the left column when the pointer moves right", () => {
    const base = defaultLayout(WIDTH);
    const moved = dragTo(beginDrag("tree", 400, base, 1), 500, WIDTH);
    expect(moved.fractions.tree).toBeGreaterThan(base.fractions.tree);
    expect(moved.fractions.note).toBeLessThan(base.fractions.note);
  });

  it("leaves the third column untouched — the gesture is local", () => {
    const base = defaultLayout(WIDTH);
    const moved = dragTo(beginDrag("tree", 400, base, 1), 500, WIDTH);
    expect(moved.fractions.graph).toBeCloseTo(base.fractions.graph, 10);
  });

  it("returns the base layout for a zero-distance move", () => {
    const base = defaultLayout(WIDTH);
    expect(dragTo(beginDrag("note", 900, base, 3), 900, WIDTH)).toBe(base);
  });

  it("records the pointer id so the shell can release the right capture", () => {
    expect(beginDrag("note", 10, defaultLayout(WIDTH), 7).pointerId).toBe(7);
  });
});

describe("dragChanged", () => {
  const WIDTH = 1600;

  it("is false for a click with no movement, so nothing is persisted", () => {
    const base = defaultLayout(WIDTH);
    const drag = beginDrag("tree", 300, base, 1);
    expect(dragChanged(drag, dragTo(drag, 300, WIDTH))).toBe(false);
  });

  it("is false for a drag entirely absorbed by the clamp", () => {
    // Pull the tree divider far past the note column's floor.
    const base = makeLayout(DEFAULT_FRACTIONS, WIDTH);
    const wall = beginDrag("tree", 0, dragTo(beginDrag("tree", 0, base, 1), 4000, WIDTH), 1);
    expect(dragChanged(wall, dragTo(wall, 4000, WIDTH))).toBe(false);
  });

  it("is true once a fraction actually moved", () => {
    const base = defaultLayout(WIDTH);
    const drag = beginDrag("tree", 300, base, 1);
    expect(dragChanged(drag, dragTo(drag, 360, WIDTH))).toBe(true);
  });
});

describe("nudgeFor", () => {
  it("maps the arrows to a signed step", () => {
    expect(nudgeFor("ArrowLeft")).toBe(-NUDGE_PX);
    expect(nudgeFor("ArrowRight")).toBe(NUDGE_PX);
  });

  it("is zero for anything else, which resizeAt already treats as a no-op", () => {
    for (const key of ["ArrowUp", "Enter", "a", " ", "Escape"]) {
      expect(nudgeFor(key)).toBe(0);
    }
  });
});

// --- the gesture as a unit -------------------------------------------------------------

describe("dividerHandlers", () => {
  const WIDTH = 1600;

  /** A `DragHost` that behaves like the component: setLayout updates what layout() returns. */
  function host(initial = defaultLayout(WIDTH)) {
    let layout = initial;
    const persisted: LayoutState[] = [];
    return {
      persisted,
      get layout() {
        return layout;
      },
      handlers: dividerHandlers({
        layout: () => layout,
        width: () => WIDTH,
        setLayout: (next) => {
          layout = next;
        },
        persist: (next) => void persisted.push(next),
      }),
    };
  }

  it("moves the layout while dragging", () => {
    const h = host();
    const before = h.layout.fractions.tree;
    h.handlers.onDown("tree", 400, 1);
    h.handlers.onMove(500);
    expect(h.layout.fractions.tree).toBeGreaterThan(before);
  });

  it("ignores a move with no gesture in progress", () => {
    // A plain hover over the divider fires pointermove exactly as a drag does.
    const h = host();
    const before = h.layout;
    h.handlers.onMove(900);
    expect(h.layout).toBe(before);
  });

  it("persists once, on release — never per frame", () => {
    const h = host();
    h.handlers.onDown("tree", 400, 1);
    h.handlers.onMove(430);
    h.handlers.onMove(460);
    h.handlers.onMove(500);
    expect(h.persisted).toEqual([]);

    h.handlers.onUp();
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]?.fractions).toEqual(h.layout.fractions);
  });

  it("persists nothing for a click that did not move", () => {
    const h = host();
    h.handlers.onDown("tree", 400, 1);
    h.handlers.onUp();
    expect(h.persisted).toEqual([]);
  });

  it("tracks the pointer across a drag that reverses direction", () => {
    // The total-offset rule, exercised through the handlers rather than the
    // arithmetic: out and back must land where a direct drag would.
    const a = host();
    a.handlers.onDown("tree", 400, 1);
    a.handlers.onMove(900);
    a.handlers.onMove(450);

    const b = host();
    b.handlers.onDown("tree", 400, 1);
    b.handlers.onMove(450);

    expect(a.layout.fractions).toEqual(b.layout.fractions);
  });

  it("releases the gesture, so a later stray move does nothing", () => {
    const h = host();
    h.handlers.onDown("tree", 400, 1);
    h.handlers.onMove(500);
    h.handlers.onUp();
    const settled = h.layout;

    h.handlers.onMove(1200);

    expect(h.layout).toBe(settled);
  });

  it("nudges from the keyboard and persists immediately", () => {
    // There is no release to wait for.
    const h = host();
    const before = h.layout.fractions.tree;
    h.handlers.onKey("tree", "ArrowRight");
    expect(h.layout.fractions.tree).toBeGreaterThan(before);
    expect(h.persisted).toHaveLength(1);
  });

  it("nudges left as well as right", () => {
    const h = host();
    const before = h.layout.fractions.tree;
    h.handlers.onKey("tree", "ArrowLeft");
    expect(h.layout.fractions.tree).toBeLessThan(before);
  });

  it("does nothing at all for an unhandled key", () => {
    const h = host();
    const before = h.layout;
    for (const key of ["Enter", "Tab", "ArrowUp", "x"]) h.handlers.onKey("tree", key);
    expect(h.layout).toBe(before);
    expect(h.persisted).toEqual([]);
  });

  it("operates the second divider too", () => {
    const h = host();
    const before = h.layout.fractions.graph;
    h.handlers.onKey("note", "ArrowLeft");
    expect(h.layout.fractions.graph).toBeGreaterThan(before);
  });
});

// --- the viewport subscription --------------------------------------------------------------

describe("watchViewport", () => {
  /** A `window` with a settable width and recordable listeners. */
  function host(width = 1600) {
    const listeners: Array<() => void> = [];
    return {
      innerWidth: width,
      addEventListener: (_type: "resize", listener: () => void) => void listeners.push(listener),
      removeEventListener: (_type: "resize", listener: () => void) => {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      },
      get count() {
        return listeners.length;
      },
      resize(next: number) {
        this.innerWidth = next;
        for (const listener of [...listeners]) listener();
      },
    };
  }

  it("reports the new width on resize", () => {
    const window = host(1600);
    const seen: number[] = [];
    watchViewport(window, (w) => seen.push(w));

    window.resize(900);
    window.resize(640);

    expect(seen).toEqual([900, 640]);
  });

  it("does not fire eagerly — the shell already has initialWidth", () => {
    const window = host(1600);
    const seen: number[] = [];
    watchViewport(window, (w) => seen.push(w));
    expect(seen).toEqual([]);
  });

  it("unsubscribes, so an unmounted shell cannot be resized into", () => {
    const window = host(1600);
    const seen: number[] = [];
    const stop = watchViewport(window, (w) => seen.push(w));

    stop();
    window.resize(800);

    expect(seen).toEqual([]);
    expect(window.count).toBe(0);
  });

  it("crosses the breakpoints the layout depends on", () => {
    // The reason this subscription exists at all: the width picks the
    // breakpoint, which decides how many columns and dividers render.
    const window = host(1600);
    const seen: string[] = [];
    watchViewport(window, (w) => seen.push(breakpointFor(w)));

    window.resize(1200);
    window.resize(900);
    window.resize(500);

    expect(seen).toEqual(["wide", "medium", "narrow"]);
  });
});

// --- the bootstrap block ----------------------------------------------------------------------

describe("readBootstrap", () => {
  it("decodes the block page.ts embeds", () => {
    const boot = { cwd: "/repo", vaultRoot: "/home/u/.okf", session: "abc" };
    expect(readBootstrap(JSON.stringify(boot))).toEqual(boot);
  });

  it("falls back rather than throwing when the block is absent or blank", () => {
    // Every field is cosmetic at P1; throwing would turn that into a blank page.
    expect(readBootstrap(null)).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap("")).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap("   ")).toEqual(EMPTY_BOOTSTRAP);
  });

  it("falls back on malformed JSON", () => {
    expect(readBootstrap("{nope")).toEqual(EMPTY_BOOTSTRAP);
  });

  it("falls back on JSON that is valid but not a bootstrap", () => {
    expect(readBootstrap("null")).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap("[]")).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('"a string"')).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('{"cwd":"/r","vaultRoot":"/v"}')).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('{"cwd":1,"vaultRoot":"/v","session":"s"}')).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('{"cwd":"/r","vaultRoot":"/v","session":7}')).toEqual(EMPTY_BOOTSTRAP);
  });
});
