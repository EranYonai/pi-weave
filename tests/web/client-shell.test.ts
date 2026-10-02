/**
 * The shell's pure models (weave-workspace §1.2, §10).
 *
 * `shell.model.ts`, `bootstrap.ts` and
 * `workspace.ts` between them hold every decision the shell makes. The `.tsx`
 * files hold none, which is what makes this suite the real coverage of the
 * shell rather than a proxy for it: there is no DOM test environment (§10)
 * and none is needed, because nothing that branches lives in a component.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_BOOTSTRAP, readBootstrap } from "../../src/web/client/bootstrap";
import type { OverlayId } from "../../src/web/client/shell/shell.model";
import {
  CONTEXT_EMPTY,
  EMPTY_SUMMARY,
  NO_VALUE,
  SEARCH_PLACEHOLDER,
  looksApple,
  graphClickOpensTab,
  recentEntries,
  repoLabel,
  recordVisit,
  searchHint,
  searchShortcut,
  shortStamp,
  statusBarModel,
  summarize,
  summaryParts,
} from "../../src/web/client/shell/shell.model";
import { COLUMNS } from "../../src/web/client/shell/shell.model";
import type { GraphPayload, WireGraphNode, WireStalenessState } from "../../src/web/shared/wire";

// --- fixtures ---------------------------------------------------------------------

it("opens a graph node only after selecting the same preview, never on first click or clear", () => {
  expect(graphClickOpensTab(null, "note:a")).toBe(false);
  expect(graphClickOpensTab("note:a", "note:b")).toBe(false);
  expect(graphClickOpensTab("note:a", "note:a")).toBe(true);
  expect(graphClickOpensTab("note:a", null)).toBe(false);
  expect(graphClickOpensTab(null, null)).toBe(false);
});

it("records recent visits in last-visit order without depending on open tabs", () => {
  let visits: readonly string[] = [];
  for (const id of ["note:a", "note:b", "note:c", "note:a"]) visits = recordVisit(visits, id);
  expect(visits).toEqual(["note:a", "note:c", "note:b"]);
  expect(recordVisit(visits, null)).toBe(visits);
  for (let index = 0; index < 110; index++) visits = recordVisit(visits, `note:${index}`);
  expect(visits).toHaveLength(100);
  expect(visits[0]).toBe("note:109");
});

it("keeps a Recent browsing snapshot ordered while selection moves, then reflects MRU on reentry", () => {
  const snapshot = ["note:a", "vfolder:Project", "artifact:Test Results.html"];
  const graph = payload([
    node("note:a", "note"),
    node("vfolder:Project", "module"),
    node("artifact:Test Results.html", "file"),
  ]);
  const updatedVisits = recordVisit(snapshot, "artifact:Test Results.html");
  expect(recentEntries(snapshot, graph, "artifact:Test Results.html").map((entry) => entry.id)).toEqual(snapshot);
  expect(recentEntries(snapshot, graph, "artifact:Test Results.html").map((entry) => entry.selected)).toEqual([false, false, true]);
  expect(recentEntries(updatedVisits, graph, "artifact:Test Results.html").map((entry) => entry.id)).toEqual(["artifact:Test Results.html", "note:a", "vfolder:Project"]);
});

it("presents note, folder, and HTML artifact rows with their own icons and labels", () => {
  const ids = ["note:a", "vfolder:Project", "artifact:Test Results.html"];
  const graph = payload([
    { ...node("note:a", "note"), label: "A note" },
    { ...node("vfolder:Project", "module"), label: "Project" },
    { ...node("artifact:Test Results.html", "file"), label: "Test Results" },
  ]);
  expect(recentEntries(ids, graph, null)).toEqual([
    { id: "note:a", label: "A note", icon: "note", selected: false },
    { id: "vfolder:Project", label: "Project", icon: "module", selected: false },
    { id: "artifact:Test Results.html", label: "Test Results", icon: "file", selected: false },
  ]);
  expect(recentEntries(ids, null, null).map((entry) => [entry.label, entry.icon])).toEqual([
    ["a", "note"], ["Project", "module"], ["Test Results.html", "file"],
  ]);
});

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

// --- empty states -------------------------------------------------------------------

describe("empty states", () => {
  it("gives the context rail its own copy", () => {
    expect(CONTEXT_EMPTY.title).toBe("Context");
  });
});

// --- the status bar --------------------------------------------------------------------

describe("statusBarModel", () => {
  it("shows the cwd, the selection and the stamp", () => {
    const model = statusBarModel("/repo", "note:alpha", "2026-03-04T09:08:07Z");
    expect(model.cwd).toBe("/repo");
    expect(model.selection).toBe("note:alpha");
    expect(model.stamp).toBe("2026-03-04T09:08:07Z");
  });

  it("says so when nothing is selected", () => {
    expect(statusBarModel("/repo", null, null).selection).toBe("nothing selected");
  });

  it("falls back to a dash for an absent cwd", () => {
    expect(statusBarModel("", null, null).cwd).toBe(NO_VALUE);
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

// --- the bootstrap block ----------------------------------------------------------------------

describe("readBootstrap", () => {
  it("decodes the block page.ts embeds", () => {
    const boot = { cwd: "/repo" };
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
    expect(readBootstrap('{"vaultRoot":"/v"}')).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('{"cwd":1}')).toEqual(EMPTY_BOOTSTRAP);
    expect(readBootstrap('{"cwd":null}')).toEqual(EMPTY_BOOTSTRAP);
  });
});
