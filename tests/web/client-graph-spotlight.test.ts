/**
 * The graph spotlight (UI refresh, G1): which nodes a query lights, why, how
 * the lit set is drawn, and what the side sheet says.
 *
 * Covered the way the rest of the graph column is (§10): the decisions live
 * in `spotlight.model.ts`, `column.model.ts` and `graph.model.ts`, and the
 * renderer is driven through its injected sigma port, so no canvas is needed.
 */

import { describe, expect, it } from "vitest";
import type { Point } from "../../src/web/shared/layout";
import type { GraphPayload, WireGraphEdge, WireGraphNode, WireNodeKind } from "../../src/web/shared/wire";
import {
  EMPTY_COLUMN,
  graphColumnModel,
  graphPicture,
  hoverPicture,
  initialGraphView,
} from "../../src/web/client/graph/column.model";
import type { GraphPicture, GraphViewState } from "../../src/web/client/graph/column.model";
import {
  EDGE_PRESENCE,
  GRAPH_PALETTE,
  HIGHLIGHT_Z_LIFT,
  LABEL_DROP_AT,
  RECESS_STRENGTH,
  SPOTLIGHT_EDGE_SLOT,
  SPOTLIGHT_GROWTH,
  SPOTLIGHT_LABEL_LIMIT,
  SPOTLIGHT_RECESS,
  SPOTLIGHT_SELECTED_GROWTH,
  SPOTLIGHT_SHRINK,
  blendHex,
  edgeReducer,
  nodeReducer,
  recessColor,
  renderGraph,
} from "../../src/web/client/graph/graph.model";
import type { EdgeDisplayOverride, NodeDisplayOverride, RenderEdge, RenderNode } from "../../src/web/client/graph/graph.model";
import type { PositionStorage } from "../../src/web/client/graph/positions";
import { sigmaRenderer } from "../../src/web/client/graph/renderer";
import type { FrameClock, SigmaLike } from "../../src/web/client/graph/renderer";
import {
  CONNECTED_LIMIT,
  CRUMB_DEPTH,
  SHEET_TEXT_LIMIT,
  SEARCH_REASON,
  SPOTLIGHT_LEGEND,
  SPOTLIGHT_PLACEHOLDER,
  connectedMore,
  connectionsOf,
  crumbOf,
  graphSheet,
  litBecause,
  litLabel,
  litOnCanvas,
  markParts,
  matchReasons,
  nodePath,
  sheetText,
  spotlightEscapes,
  spotlightOf,
  spotlightTerms,
  tagsByNode,
  tldrOf,
} from "../../src/web/client/graph/spotlight.model";
import { viewModel } from "../../src/web/client/tree/tree.model";
import { clusterAggregate } from "../../src/web/shared/view";

// --- fixtures ------------------------------------------------------------------------------

function node(id: string, kind: WireNodeKind, label = id, detail: Record<string, string> = {}, provenance: WireGraphNode["provenance"] = null): WireGraphNode {
  return { id, kind, label, provenance, detail };
}

function edge(source: string, target: string, kind: WireGraphEdge["kind"] = "contains"): WireGraphEdge {
  return { source, target, kind };
}

function payloadOf(nodes: WireGraphNode[], edges: WireGraphEdge[], tags: Record<string, string[]> = {}): GraphPayload {
  return {
    model: { generatedAt: "2026-10-12T09:00:00Z", staleness: null, nodes, edges, contentDigest: "" },
    tags,
    dangling: {},
    positions: null,
    stamp: "digest",
  };
}

const NOW = Date.parse("2026-10-12T12:00:00Z");

/** The mock's vault, in miniature: a projects folder, a meeting, an inbox note and some code. */
const VAULT = payloadOf(
  [
    node("vault", "vault", "Vault"),
    node("vfolder:projects", "module", "projects", { path: "projects", notes: "3" }),
    node("vfolder:projects/2026", "module", "2026", { path: "projects/2026", notes: "1" }),
    node("note:projects/launch-checklist", "note", "Launch checklist", {
      slug: "projects/launch-checklist",
      source: "human",
      updated: "2026-10-12T10:00:00Z",
      tags: "launch, release",
      preview: "**TLDR:** README demo is done; the launch posts are still open. - [ ] Write the launch post - [x] Record the demo ## Steps See the roadmap.",
    }, "human"),
    node("note:projects/launch-post-draft", "note", "Launch post draft", {
      slug: "projects/launch-post-draft",
      source: "agent",
      updated: "2026-10-12T07:00:00Z",
      preview: "One paragraph, a GIF and the install line.",
    }, "agent"),
    node("note:projects/roadmap", "note", "Pi-weave roadmap", { slug: "projects/roadmap", source: "human", updated: "2026-10-11T10:00:00Z", preview: "" }, "human"),
    node("note:projects/2026/q4", "note", "Q4 goals", { slug: "projects/2026/q4", source: "generated", preview: "Plan." }, "generated"),
    node("note:meetings-testers", "note", "Meeting with testers", { slug: "meetings-testers", source: "human", preview: "Testers before launch." }, "human"),
    node("note:inbox", "note", "Inbox scratch", { slug: "inbox", source: "human", preview: "Random thoughts." }, "human"),
    node("repository", "repository", "pi-weave"),
    node("module:scripts", "module", "scripts", { path: "scripts", files: "1" }),
    node("entryPoint:scripts/build-web.mjs", "entryPoint", "scripts/build-web.mjs", { path: "scripts/build-web.mjs", summary: "Bundles the client before a launch." }),
  ],
  [
    edge("vault", "vfolder:projects"),
    edge("vfolder:projects", "vfolder:projects/2026"),
    edge("vfolder:projects", "note:projects/launch-checklist"),
    edge("vfolder:projects", "note:projects/launch-post-draft"),
    edge("vfolder:projects", "note:projects/roadmap"),
    edge("vfolder:projects/2026", "note:projects/2026/q4"),
    edge("vault", "note:meetings-testers"),
    edge("vault", "note:inbox"),
    edge("repository", "module:scripts"),
    edge("module:scripts", "entryPoint:scripts/build-web.mjs"),
    edge("note:projects/launch-checklist", "note:projects/launch-post-draft", "links-to"),
    edge("note:projects/launch-checklist", "note:projects/roadmap", "links-to"),
    edge("note:projects/launch-checklist", "note:meetings-testers", "links-to"),
    edge("note:inbox", "note:projects/launch-checklist", "links-to"),
    edge("note:projects/launch-checklist", "entryPoint:scripts/build-web.mjs", "mentions"),
  ],
  { launch: ["projects/launch-checklist", "meetings-testers"], release: ["projects/launch-checklist"], planning: ["projects/roadmap"] },
);

function storage(): PositionStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

// --- copy ------------------------------------------------------------------------------------

describe("spotlight copy", () => {
  it("says what the field finds and counts what lit", () => {
    expect(SPOTLIGHT_PLACEHOLDER).toBe("Light up notes, tags or code");
    expect(litLabel(5)).toBe("5 lit");
    expect(litLabel(1)).toBe("1 lit");
    // Zero is a sentence, not "0 lit": the canvas has just gone dark and the
    // chip is what says why.
    expect(litLabel(0)).toBe("no matches");
    expect(SPOTLIGHT_LEGEND).toEqual({ lit: "lit", dimmed: "not lit" });
  });

  it("names the overflow of the Connected list only when there is one", () => {
    expect(connectedMore(6, 6)).toBeNull();
    expect(connectedMore(6, 9)).toBe("+3 more");
  });
});

// --- the query -------------------------------------------------------------------------------

describe("spotlightTerms", () => {
  it("splits on whitespace and lower-cases", () => {
    expect(spotlightTerms("  Launch   DRAFT ")).toEqual([
      { text: "launch", tagOnly: false },
      { text: "draft", tagOnly: false },
    ]);
  });

  it("makes a #word tag-only and drops a bare #", () => {
    expect(spotlightTerms("#Launch # ##release")).toEqual([
      { text: "launch", tagOnly: true },
      { text: "release", tagOnly: true },
    ]);
  });

  it("has no terms for an empty or blank query", () => {
    expect(spotlightTerms("")).toEqual([]);
    expect(spotlightTerms("   \t ")).toEqual([]);
  });
});

// --- matching -------------------------------------------------------------------------------

describe("nodePath", () => {
  it("prefers the detail path, then the slug, then the id after its kind", () => {
    expect(nodePath(node("module:src", "module", "src", { path: "src/web" }))).toBe("src/web");
    expect(nodePath(node("note:a/b", "note", "B", { slug: "a/b" }))).toBe("a/b");
    expect(nodePath(node("file:x/y.ts", "file"))).toBe("x/y.ts");
    expect(nodePath(node("external:https://example.com/r", "external", "r", { path: "" }))).toBe("https://example.com/r");
  });

  it("is empty for an id with no kind prefix", () => {
    expect(nodePath(node("vault", "vault", "Vault"))).toBe("");
  });
});

describe("tagsByNode", () => {
  it("indexes the structured tag map by note id, in the index's order, without duplicates", () => {
    const tags = tagsByNode(payloadOf([], [], { b: ["x", "y"], a: ["x", "x"] }));
    expect(tags.get("note:x")).toEqual(["b", "a"]);
    expect(tags.get("note:y")).toEqual(["b"]);
    expect(tags.has("note:z")).toBe(false);
  });
});

describe("matchReasons", () => {
  const n = node("note:projects/launch-checklist", "note", "Launch checklist", { slug: "projects/launch-checklist" });

  it("names the title when the title holds the word", () => {
    expect(matchReasons(n, [], spotlightTerms("CHECK"))).toEqual(["title"]);
  });

  it("names every tag that holds the word", () => {
    expect(matchReasons(n, ["launch", "relaunch", "other"], spotlightTerms("#launch"))).toEqual(["tag #launch", "tag #relaunch"]);
  });

  it("names the path only when nothing better explains the word", () => {
    // "launch" is in the slug as well, but the title already says so.
    expect(matchReasons(n, [], spotlightTerms("launch"))).toEqual(["title"]);
    expect(matchReasons(n, [], spotlightTerms("projects"))).toEqual(["path"]);
  });

  it("needs every word to match somewhere, and reads title, tags, path in that order", () => {
    expect(matchReasons(n, ["release"], spotlightTerms("projects release checklist"))).toEqual(["title", "tag #release", "path"]);
    expect(matchReasons(n, ["release"], spotlightTerms("launch nowhere"))).toBeNull();
  });

  it("keeps a tag-only word away from the title and the path", () => {
    expect(matchReasons(n, [], spotlightTerms("#launch"))).toBeNull();
    expect(matchReasons(n, [], spotlightTerms("#projects"))).toBeNull();
  });

  it("names a tag once however many words it matched", () => {
    expect(matchReasons(n, ["launch"], spotlightTerms("#lau #unch"))).toEqual(["tag #launch"]);
  });
});

describe("spotlightOf", () => {
  it("is null when there is nothing to look for", () => {
    expect(spotlightOf(VAULT, "")).toBeNull();
    expect(spotlightOf(VAULT, "  #  ")).toBeNull();
  });

  it("lights titles, tags and paths across the whole payload", () => {
    const spot = spotlightOf(VAULT, "launch")!;
    expect([...spot.lit].sort()).toEqual([
      "note:meetings-testers",
      "note:projects/launch-checklist",
      "note:projects/launch-post-draft",
    ]);
    expect(spot.count).toBe(3);
    expect(spot.reasons.get("note:projects/launch-checklist")).toEqual(["title", "tag #launch"]);
    expect(spot.reasons.get("note:meetings-testers")).toEqual(["tag #launch"]);
    expect(spot.reasons.get("note:projects/launch-post-draft")).toEqual(["title"]);
  });

  it("finds code by path", () => {
    const spot = spotlightOf(VAULT, "build-web")!;
    expect([...spot.lit]).toEqual(["entryPoint:scripts/build-web.mjs"]);
    expect(spotlightOf(VAULT, "scripts")!.reasons.get("module:scripts")).toEqual(["title"]);
  });

  it("answers a query that matches nothing with an empty set, not null", () => {
    // The difference is the picture: null is the ordinary graph, the empty set
    // dims everything — the honest answer to "nothing is called that".
    const spot = spotlightOf(VAULT, "zzz")!;
    expect(spot.lit.size).toBe(0);
    expect(spot.count).toBe(0);
  });

  it("has terms but no matches before the payload arrives", () => {
    const spot = spotlightOf(null, "launch")!;
    expect(spot.count).toBe(0);
    expect(spot.terms).toEqual([{ text: "launch", tagOnly: false }]);
  });

  it("counts a duplicated node id once", () => {
    const twice = payloadOf([node("note:a", "note", "Alpha"), node("note:a", "note", "Alpha")], []);
    expect(spotlightOf(twice, "alpha")!.count).toBe(1);
  });

  it("also lights what search found by a note's text, the same set the palette showed", () => {
    // "demo" is only in the checklist's body: the payload alone finds nothing.
    expect(spotlightOf(VAULT, "demo")!.count).toBe(0);
    const spot = spotlightOf(VAULT, "demo", ["note:projects/launch-checklist", "note:gone"])!;
    expect([...spot.lit]).toEqual(["note:projects/launch-checklist"]);
    expect(spot.count).toBe(1);
    expect(litBecause(spot, "note:projects/launch-checklist")).toBe(SEARCH_REASON);
    // A node the spotlight matched on its own keeps the better reason.
    const both = spotlightOf(VAULT, "launch", ["note:projects/launch-post-draft", "note:inbox"])!;
    expect(both.count).toBe(4);
    expect(both.reasons.get("note:projects/launch-post-draft")).toEqual(["title"]);
    expect(both.reasons.get("note:inbox")).toEqual(["search match"]);
  });
});

describe("litOnCanvas", () => {
  it("is null without a spotlight", () => {
    expect(litOnCanvas(null, new Map())).toBeNull();
  });

  it("retargets a hidden lit node onto the cluster standing in for it", () => {
    const spot = spotlightOf(VAULT, "q4")!;
    const collapsed = clusterAggregate(viewModel(VAULT), new Set(["vault", "repository", "module:scripts", "vfolder:projects"]));
    expect([...litOnCanvas(spot, collapsed.representative)!]).toEqual(["vfolder:projects/2026"]);
    // Expanded, it lights itself.
    expect([...litOnCanvas(spot, new Map())!]).toEqual(["note:projects/2026/q4"]);
  });
});

describe("litBecause", () => {
  it("joins the reasons, or says nothing for an unlit node or no spotlight", () => {
    const spot = spotlightOf(VAULT, "launch release")!;
    expect(litBecause(spot, "note:projects/launch-checklist")).toBe("title, tag #launch, tag #release");
    expect(litBecause(spot, "note:inbox")).toBeNull();
    expect(litBecause(null, "note:inbox")).toBeNull();
    const empty = { terms: [], lit: new Set(["x"]), reasons: new Map([["x", []]]), count: 1 };
    expect(litBecause(empty, "x")).toBeNull();
  });
});

describe("spotlightEscapes", () => {
  it("clears the query from the field, whatever else is open", () => {
    expect(spotlightEscapes("launch", true, true)).toBe(true);
    expect(spotlightEscapes("launch", true, false)).toBe(true);
  });

  it("leaves Esc to close an open sheet first when it comes from the canvas", () => {
    expect(spotlightEscapes("launch", false, true)).toBe(false);
    expect(spotlightEscapes("launch", false, false)).toBe(true);
  });

  it("never claims Esc without a query — today's behaviour is untouched", () => {
    expect(spotlightEscapes("", true, false)).toBe(false);
    expect(spotlightEscapes("", false, true)).toBe(false);
  });
});

// --- marking the words -----------------------------------------------------------------------

describe("markParts", () => {
  it("marks every occurrence, case-insensitively, keeping the original text", () => {
    expect(markParts("Launch the launch post", spotlightTerms("LAUNCH"))).toEqual([
      { text: "Launch", hit: true },
      { text: " the ", hit: false },
      { text: "launch", hit: true },
      { text: " post", hit: false },
    ]);
  });

  it("prefers the longest word at a position and never overlaps", () => {
    expect(markParts("relaunches", spotlightTerms("launch relaunch"))).toEqual([
      { text: "relaunch", hit: true },
      { text: "es", hit: false },
    ]);
  });

  it("marks tag-only words too, and returns plain text untouched", () => {
    expect(markParts("a launch", spotlightTerms("#launch"))).toEqual([
      { text: "a ", hit: false },
      { text: "launch", hit: true },
    ]);
    expect(markParts("nothing here", spotlightTerms("zzz"))).toEqual([{ text: "nothing here", hit: false }]);
    expect(markParts("plain", [])).toEqual([{ text: "plain", hit: false }]);
    expect(markParts("", spotlightTerms("x"))).toEqual([]);
  });
});

// --- the side sheet ---------------------------------------------------------------------------

describe("crumbOf", () => {
  it("names the folder a note lives in, leaving the root off", () => {
    expect(crumbOf(VAULT, "note:projects/launch-checklist")).toBe("projects");
    expect(crumbOf(VAULT, "note:projects/2026/q4")).toBe("projects / 2026");
  });

  it("names the root when it is the only ancestor, and nothing for a root", () => {
    expect(crumbOf(VAULT, "note:inbox")).toBe("Vault");
    expect(crumbOf(VAULT, "module:scripts")).toBe("pi-weave");
    expect(crumbOf(VAULT, "vault")).toBe("");
  });

  it("keeps the deepest folders behind an ellipsis", () => {
    const ids = ["root", "a", "b", "c", "d", "e"];
    const deep = payloadOf(
      [...ids.map((id) => node(id, "module", id.toUpperCase())), node("leaf", "note", "Leaf")],
      [...ids.slice(1).map((id, i) => edge(ids[i]!, id)), edge("e", "leaf")],
    );
    expect(CRUMB_DEPTH).toBe(3);
    expect(crumbOf(deep, "leaf")).toBe("… / C / D / E");
  });

  it("survives a containment cycle and an ancestor missing from the nodes", () => {
    const cyclic = payloadOf([node("a", "module", "A"), node("b", "module", "B")], [edge("a", "b"), edge("b", "a")]);
    expect(crumbOf(cyclic, "a")).toBe("B");
    const orphan = payloadOf([node("x", "note", "X")], [edge("ghost", "x"), edge("x", "x")]);
    expect(crumbOf(orphan, "x")).toBe("ghost");
  });
});

describe("tldrOf", () => {
  it("reads the TLDR block a finalized note opens with", () => {
    expect(tldrOf("**TLDR:** README demo is done; the launch posts are still open.")).toBe("README demo is done; the launch posts are still open.");
  });

  it("ends the block at the next heading or bold label", () => {
    expect(tldrOf("**TLDR:** Short. ## Steps More text")).toBe("Short.");
    expect(tldrOf("**TLDR:** Short. **Decisions:** keep")).toBe("Short.");
  });

  it("turns flattened checkboxes and bullets back into readable separators", () => {
    expect(tldrOf("**TLDR:** Two things. - [ ] Write the post - [x] Record the demo")).toBe("Two things. ☐ Write the post ☑ Record the demo");
    expect(tldrOf("**TLDR:** - first - second")).toBe("first · second");
  });

  it("accepts the common spellings and strips markdown inside", () => {
    expect(tldrOf("# Title TL;DR: the *gist* with [[link]]")).toBe("the gist with link");
    expect(tldrOf("**TLDR**: done")).toBe("done");
  });

  it("is null without a TLDR, or with an empty one", () => {
    expect(tldrOf("Just a body.")).toBeNull();
    expect(tldrOf("**TLDR:** ## Next")).toBeNull();
    expect(tldrOf("")).toBeNull();
  });
});

describe("sheetText", () => {
  const terms = spotlightTerms("launch");

  it("prefers the TLDR, marked with the query's words", () => {
    const text = sheetText(VAULT.model.nodes.find((n) => n.id === "note:projects/launch-checklist")!, terms)!;
    expect(text.heading).toBe("TLDR");
    expect(text.parts.filter((part) => part.hit).map((part) => part.text)).toEqual(["launch", "launch"]);
  });

  it("falls back to a summary, then to the note's opening words", () => {
    expect(sheetText(VAULT.model.nodes.find((n) => n.id === "entryPoint:scripts/build-web.mjs")!, terms)!.heading).toBe("Summary");
    expect(sheetText(node("artifact:a", "file", "A", { description: "An HTML page." }), [])).toEqual({
      heading: "Summary",
      parts: [{ text: "An HTML page.", hit: false }],
    });
    expect(sheetText(VAULT.model.nodes.find((n) => n.id === "note:projects/launch-post-draft")!, [])).toEqual({
      heading: "Preview",
      parts: [{ text: "One paragraph, a GIF and the install line.", hit: false }],
    });
  });

  it("is null when the payload carries no text at all", () => {
    expect(sheetText(node("module:x", "module", "x"), terms)).toBeNull();
    expect(sheetText(node("module:x", "module", "x", { summary: "  " }), terms)).toBeNull();
  });

  it("stays short", () => {
    const long = sheetText(node("note:l", "note", "L", { preview: "word ".repeat(120) }), [])!;
    const length = long.parts.map((part) => part.text).join("").length;
    expect(length).toBeLessThanOrEqual(SHEET_TEXT_LIMIT + 1);
  });
});

describe("connectionsOf", () => {
  it("lists content links in both directions, lit ones first, then alphabetical", () => {
    const spot = spotlightOf(VAULT, "launch");
    const rows = connectionsOf(VAULT, "note:projects/launch-checklist", spot);
    expect(rows.map((row) => [row.label, row.lit])).toEqual([
      ["Launch post draft", true],
      ["Meeting with testers", true],
      ["Inbox scratch", false],
      ["Pi-weave roadmap", false],
      ["scripts/build-web.mjs", false],
    ]);
    expect(rows[0]!.ariaLabel).toBe("Launch post draft (lit)");
    expect(rows[2]!.ariaLabel).toBe("Inbox scratch");
  });

  it("lists a folder's children when it has no content links", () => {
    expect(connectionsOf(VAULT, "vfolder:projects", null).map((row) => row.id)).toEqual([
      "vfolder:projects/2026",
      "note:projects/launch-checklist",
      "note:projects/launch-post-draft",
      "note:projects/roadmap",
    ].sort((a, b) => {
      const label = (id: string) => VAULT.model.nodes.find((n) => n.id === id)!.label;
      return label(a).localeCompare(label(b));
    }));
  });

  it("skips self-links, duplicates and edges to missing nodes, and breaks label ties by id", () => {
    const messy = payloadOf(
      [node("a", "note", "A"), node("b", "note", "Same"), node("c", "note", "Same")],
      [edge("a", "a", "links-to"), edge("a", "c", "links-to"), edge("b", "a", "links-to"), edge("a", "b", "links-to"), edge("a", "ghost", "links-to")],
    );
    expect(connectionsOf(messy, "a", null).map((row) => row.id)).toEqual(["b", "c"]);
    expect(connectionsOf(messy, "nobody", null)).toEqual([]);
  });
});

describe("graphSheet", () => {
  it("is null with nothing previewed, no payload, or an unknown id", () => {
    expect(graphSheet(VAULT, null, null, NOW)).toBeNull();
    expect(graphSheet(null, "note:inbox", null, NOW)).toBeNull();
    expect(graphSheet(VAULT, "note:gone", null, NOW)).toBeNull();
  });

  it("describes a lit note: crumb, who and when, TLDR, why it lit, its connections", () => {
    const spot = spotlightOf(VAULT, "launch");
    const sheet = graphSheet(VAULT, "note:projects/launch-checklist", spot, NOW)!;
    expect(sheet).toMatchObject({
      id: "note:projects/launch-checklist",
      title: "Launch checklist",
      kind: "note",
      icon: "note",
      crumb: "projects",
      who: { provenance: "human", glyph: "●", word: "You", title: "human-authored" },
      when: "2h ago",
      litBecause: "title, tag #launch",
      connectedTotal: 5,
    });
    expect(sheet.text?.heading).toBe("TLDR");
    expect(sheet.connected).toHaveLength(5);
  });

  it("says Agent for an agent's note — never You", () => {
    expect(graphSheet(VAULT, "note:projects/launch-post-draft", null, NOW)!.who).toMatchObject({ word: "Agent", glyph: "◐" });
    expect(graphSheet(VAULT, "note:projects/2026/q4", null, NOW)!.who).toMatchObject({ word: "Generated", glyph: "○" });
  });

  it("has no who, when or reason for an unlit structural node", () => {
    const sheet = graphSheet(VAULT, "vfolder:projects", spotlightOf(VAULT, "launch"), NOW)!;
    expect(sheet.kind).toBe("Folder");
    expect(sheet.who).toBeNull();
    expect(sheet.when).toBe("");
    expect(sheet.litBecause).toBeNull();
    expect(sheet.text).toBeNull();
  });

  it("caps the Connected list and keeps the total", () => {
    const hub = payloadOf(
      [node("hub", "note", "Hub"), ...Array.from({ length: 9 }, (_, i) => node(`n${i}`, "note", `N${i}`))],
      Array.from({ length: 9 }, (_, i) => edge("hub", `n${i}`, "links-to")),
    );
    const sheet = graphSheet(hub, "hub", null, NOW)!;
    expect(sheet.connected).toHaveLength(CONNECTED_LIMIT);
    expect(sheet.connectedTotal).toBe(9);
  });
});

// --- the column's picture -------------------------------------------------------------------

describe("graphPicture and hoverPicture", () => {
  const edges = [edge("a", "b", "links-to"), edge("b", "c", "links-to")];
  const neighbourhood = new Set(["a", "b"]);

  it("is the selection's neighbourhood with no spotlight, exactly as before", () => {
    expect(graphPicture(neighbourhood, "a", null)).toEqual({ highlight: neighbourhood, selectedId: "a", style: "neighbourhood" });
    expect(graphPicture(null, null, null)).toEqual({ highlight: null, selectedId: null, style: "neighbourhood" });
  });

  it("lets a spotlight win, keeping the selection as its subject", () => {
    const lit = new Set(["c"]);
    expect(graphPicture(neighbourhood, "a", lit)).toEqual({ highlight: lit, selectedId: "a", style: "spotlight" });
  });

  it("hovers to a neighbourhood without a spotlight, and falls back on leave", () => {
    const shown = graphPicture(neighbourhood, "a", null);
    expect(hoverPicture(edges, "c", shown)).toEqual({ highlight: new Set(["b", "c"]), selectedId: "c", style: "neighbourhood" });
    expect(hoverPicture(edges, null, shown)).toEqual({ highlight: neighbourhood, selectedId: "a", style: "neighbourhood" });
  });

  it("keeps the lit set under hover and only moves the subject", () => {
    const shown: GraphPicture = graphPicture(neighbourhood, "a", new Set(["c"]));
    expect(hoverPicture(edges, "b", shown)).toEqual({ highlight: shown.highlight, selectedId: "b", style: "spotlight" });
    expect(hoverPicture(edges, null, shown)).toBe(shown);
  });

  it("exposes the reduction's representative map on the column model", () => {
    const state: GraphViewState = { expanded: new Set(["vault", "repository"]) };
    const column = graphColumnModel(VAULT, null, state, storage(), "dark");
    expect(column.representative.get("note:projects/2026/q4")).toBe("vfolder:projects");
    expect(graphColumnModel(VAULT, null, initialGraphView(viewModel(VAULT)), storage(), "dark").representative.size).toBe(0);
    expect(EMPTY_COLUMN.representative.size).toBe(0);
  });
});

// --- the spotlight treatment (graph.model) ----------------------------------------------------

function at(entries: Array<[string, number, number]>): Map<string, Point> {
  return new Map(entries.map(([id, x, y]) => [id, { x, y }]));
}

describe("the spotlight reducers", () => {
  const model = renderGraph(
    [node("a", "note", "A"), node("b", "note", "B"), node("c", "note", "C"), node("d", "note", "D")],
    [edge("a", "b", "links-to"), edge("b", "c", "links-to"), edge("c", "d")],
    at([["a", 0, 0], ["b", 10, 0], ["c", 0, 10], ["d", 10, 10]]),
    "dark",
  );
  const nodeOf = (id: string): RenderNode => model.nodes.find((n) => n.id === id)!;
  const edgeOf = (source: string, target: string): RenderEdge => model.edges.find((e) => e.source === source && e.target === target)!;
  const lit = new Set(["a", "b"]);

  it("grows, lifts and labels a lit node at full colour", () => {
    const shown = nodeReducer(lit, null, 1, "spotlight")("a", nodeOf("a"), "dark");
    expect(shown).toEqual({ zIndex: nodeOf("a").zIndex + HIGHLIGHT_Z_LIFT, size: nodeOf("a").size * SPOTLIGHT_GROWTH, forceLabel: true });
    expect(shown.color).toBeUndefined();
  });

  it("makes the selection the biggest subject, lit or not", () => {
    for (const id of ["a", "c"]) {
      expect(nodeReducer(lit, id, 1, "spotlight")(id, nodeOf(id), "dark")).toEqual({
        zIndex: nodeOf(id).zIndex + HIGHLIGHT_Z_LIFT * 2,
        size: nodeOf(id).size * SPOTLIGHT_SELECTED_GROWTH,
        forceLabel: true,
      });
    }
  });

  it("drops an unlit node further back than a neighbourhood's cloud, and shrinks it", () => {
    const dim = nodeReducer(lit, null, 1, "spotlight")("c", nodeOf("c"), "light");
    expect(dim).toEqual({
      color: recessColor(nodeOf("c").color, "light", SPOTLIGHT_RECESS),
      label: null,
      size: nodeOf("c").size * SPOTLIGHT_SHRINK,
      zIndex: 0,
    });
    expect(SPOTLIGHT_RECESS).toBeGreaterThan(RECESS_STRENGTH);
  });

  it("dims everything when the query matched nothing", () => {
    const nodes = nodeReducer(new Set(), null, 1, "spotlight");
    for (const id of ["a", "b", "c", "d"]) expect(nodes(id, nodeOf(id), "dark").label).toBeNull();
  });

  it("leaves the labels to the size threshold past the label limit", () => {
    const many = new Set(["a", ...Array.from({ length: SPOTLIGHT_LABEL_LIMIT }, (_, i) => `x${i}`)]);
    expect(nodeReducer(many, null, 1, "spotlight")("a", nodeOf("a"), "dark").forceLabel).toBe(false);
  });

  it("fades in: labels speak and drop at the fade's midpoint, sizes interpolate", () => {
    const early = LABEL_DROP_AT / 2;
    const litEarly = nodeReducer(lit, null, early, "spotlight")("a", nodeOf("a"), "dark");
    expect(litEarly.forceLabel).toBe(false);
    expect(litEarly.size).toBeCloseTo(nodeOf("a").size * (1 + (SPOTLIGHT_GROWTH - 1) * early));
    const dimEarly = nodeReducer(lit, null, early, "spotlight")("c", nodeOf("c"), "dark");
    expect(dimEarly.label).toBe(nodeOf("c").label);
    expect(dimEarly.color).toBe(recessColor(nodeOf("c").color, "dark", SPOTLIGHT_RECESS * early));
    expect(nodeReducer(lit, "c", early, "spotlight")("c", nodeOf("c"), "dark").forceLabel).toBe(false);
  });

  it("changes nothing at zero progress or with no set", () => {
    expect(nodeReducer(lit, null, 0, "spotlight")("a", nodeOf("a"), "dark")).toEqual({});
    expect(nodeReducer(null, null, 1, "spotlight")("a", nodeOf("a"), "dark")).toEqual({});
    expect(edgeReducer(lit, null, 0, "spotlight")("k", edgeOf("a", "b"), "dark")).toEqual({});
  });

  it("paints an edge between two lit nodes in the highlighter slot, and recedes the rest", () => {
    const edges = edgeReducer(lit, null, 1, "spotlight");
    const between: EdgeDisplayOverride = edges("k", edgeOf("a", "b"), "dark");
    expect(between).toEqual({
      zIndex: 2,
      size: edgeOf("a", "b").size * EDGE_PRESENCE * 1.35,
      color: GRAPH_PALETTE.dark[SPOTLIGHT_EDGE_SLOT],
    });
    // Touching a lit node is not enough — the line has to join two of them.
    expect(edges("k", edgeOf("b", "c"), "dark")).toEqual({ color: recessColor(edgeOf("b", "c").color, "dark", SPOTLIGHT_RECESS) });
    expect(edges("k", edgeOf("c", "d"), "light")).toEqual({ color: recessColor(edgeOf("c", "d").color, "light", SPOTLIGHT_RECESS) });
  });

  it("blends a lit edge toward the highlighter as the fade arrives", () => {
    const half = edgeReducer(lit, null, 0.5, "spotlight")("k", edgeOf("a", "b"), "dark");
    expect(half.color).toBe(blendHex(edgeOf("a", "b").color, GRAPH_PALETTE.dark.warning, 0.5));
  });

  it("keeps the neighbourhood treatment as the default style", () => {
    const fallback = nodeReducer(lit, "a", 1)("b", nodeOf("b"), "dark");
    expect(fallback.forceLabel).toBeUndefined();
    expect(edgeReducer(lit, "a", 1)("k", edgeOf("a", "b"), "dark").color).toBe(blendHex(edgeOf("a", "b").color, GRAPH_PALETTE.dark.accent, 1));
  });
});

// --- the renderer carries the style ------------------------------------------------------------

function fakeSigma() {
  let nodes: ((id: string, data: RenderNode) => NodeDisplayOverride) | null = null;
  const instance = {
    on: () => instance,
    setSetting(key: string, value: unknown) {
      if (key === "nodeReducer") nodes = value as (id: string, data: RenderNode) => NodeDisplayOverride;
      return instance;
    },
    setGraph: () => instance,
    setCustomBBox: () => instance,
    refresh: () => instance,
    viewportToGraph: (position: Point) => position,
    getCamera: () => ({ animatedReset: () => Promise.resolve() }),
    kill() {},
  } as unknown as SigmaLike;
  return { factory: () => instance, nodeReducer: () => nodes! };
}

function fakeClock() {
  let t = 0;
  let pending: (() => void) | null = null;
  const clock: FrameClock = {
    now: () => t,
    request(step) {
      pending = step;
      return 1;
    },
    cancel() {
      pending = null;
    },
  };
  return {
    clock,
    settle() {
      for (let i = 0; i < 400 && pending !== null; i++) {
        t += 20;
        const step = pending;
        pending = null;
        step();
      }
    },
    tick() {
      t += 20;
      const step = pending;
      pending = null;
      step?.();
    },
  };
}

describe("sigmaRenderer with a spotlight", () => {
  const model = renderGraph(
    [node("a", "note", "A"), node("b", "note", "B"), node("c", "note", "C")],
    [edge("a", "b", "links-to"), edge("b", "c", "links-to")],
    at([["a", 0, 0], ["b", 10, 0], ["c", 0, 10]]),
    "dark",
  );
  const nodeOf = (id: string): RenderNode => model.nodes.find((n) => n.id === id)!;
  const container = { clientWidth: 400, clientHeight: 300 };

  it("installs the spotlight treatment when told to, without a clock", () => {
    const fake = fakeSigma();
    const renderer = sigmaRenderer(fake.factory, "dark");
    renderer.setGraph(model);
    renderer.mount(container);
    renderer.setHighlight(new Set(["a"]), null, "spotlight");
    expect(fake.nodeReducer()("c", nodeOf("c")).size).toBe(nodeOf("c").size * SPOTLIGHT_SHRINK);
    // Back to a neighbourhood: the same set, the old treatment.
    renderer.setHighlight(new Set(["a"]), null);
    expect(fake.nodeReducer()("c", nodeOf("c")).size).toBe(nodeOf("c").size);
  });

  it("fades a spotlight out *as* a spotlight, then lands on the plain graph", () => {
    const fake = fakeSigma();
    const clock = fakeClock();
    const renderer = sigmaRenderer(fake.factory, "dark", clock.clock);
    renderer.setGraph(model);
    renderer.mount(container);
    renderer.setHighlight(new Set(["a"]), null, "spotlight");
    clock.settle();
    expect(fake.nodeReducer()("c", nodeOf("c")).color).toBe(recessColor(nodeOf("c").color, "dark", SPOTLIGHT_RECESS));
    renderer.setHighlight(null);
    clock.tick();
    // Mid-fade the cloud is still shrunk: the outgoing style is kept with the
    // outgoing set, so the clear does not flick to a neighbourhood's picture.
    const leaving = fake.nodeReducer()("c", nodeOf("c"));
    expect(leaving.size).toBeLessThan(nodeOf("c").size);
    expect(leaving.size).toBeGreaterThan(nodeOf("c").size * SPOTLIGHT_SHRINK);
    clock.settle();
    expect(fake.nodeReducer()("c", nodeOf("c"))).toEqual({ ...nodeOf("c") });
  });

  it("swaps a neighbourhood for a spotlight instantly once the highlight is up", () => {
    const fake = fakeSigma();
    const clock = fakeClock();
    const renderer = sigmaRenderer(fake.factory, "dark", clock.clock);
    renderer.setGraph(model);
    renderer.mount(container);
    renderer.setHighlight(new Set(["a", "b"]), "a");
    clock.settle();
    renderer.setHighlight(new Set(["c"]), null, "spotlight");
    expect(fake.nodeReducer()("c", nodeOf("c")).forceLabel).toBe(true);
  });
});
