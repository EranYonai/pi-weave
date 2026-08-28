/**
 * The context rail's pure model (weave-workspace §1.1, §1.2, §10, P2.5).
 *
 * The property under test is §1.1's principle: *whatever is selected, the rail
 * shows everything related without a navigation.* So the fixture is a graph
 * with all four relationship kinds present at once — wikilinks between notes,
 * shared tags, and `mentions` edges from notes to code — and the assertions
 * are mostly of the form "standing here, you can see there".
 *
 * `ContextRail.tsx` renders what `contextModel` returns and decides nothing,
 * so this suite is the rail's coverage rather than a proxy for it.
 */

import { describe, expect, it } from "vitest";
import type { GraphPayload, WireGraphEdge, WireGraphNode, WireNodeKind, WireNoteSource } from "../../src/web/shared/wire";
import {
  HEADINGS,
  RAIL_EMPTY,
  contextModel,
  incomingMentions,
  rowFor,
  rowFromDetail,
  slugOf,
  tagsFor,
} from "../../src/web/client/context/context.model";
import { viewModel } from "../../src/web/client/tree/tree.model";

// --- fixtures ------------------------------------------------------------------------

function node(
  id: string,
  kind: WireNodeKind,
  label: string,
  provenance: WireNoteSource | null = null,
  detail: Record<string, string> = {},
): WireGraphNode {
  return { id, kind, label, provenance, detail };
}

const NODES: WireGraphNode[] = [
  node("vault", "vault", "Vault"),
  node("note:alpha", "note", "Alpha", "human", { tags: "architecture, viewer" }),
  node("note:beta", "note", "Beta", "agent", { tags: "architecture" }),
  node("note:gamma", "note", "Gamma", "generated", { tags: "viewer" }),
  node("note:lonely", "note", "Lonely", "human"),
  node("repository", "repository", "pi-weave"),
  node("module:src/core", "module", "src/core", null, { path: "src/core" }),
];

const EDGES: WireGraphEdge[] = [
  { source: "vault", target: "note:alpha", kind: "contains" },
  { source: "vault", target: "note:beta", kind: "contains" },
  { source: "vault", target: "note:gamma", kind: "contains" },
  { source: "vault", target: "note:lonely", kind: "contains" },
  { source: "repository", target: "module:src/core", kind: "contains" },
  // Alpha → Beta, and Gamma → Alpha, so Alpha has one of each direction.
  { source: "note:alpha", target: "note:beta", kind: "links-to" },
  { source: "note:gamma", target: "note:alpha", kind: "links-to" },
  // Alpha and Beta both talk about src/core.
  { source: "note:alpha", target: "module:src/core", kind: "mentions" },
  { source: "note:beta", target: "module:src/core", kind: "mentions" },
];

const GRAPH: GraphPayload = {
  model: { generatedAt: "2026-03-04T09:00:00Z", staleness: null, nodes: NODES, edges: EDGES, contentDigest: "" },
  // Key order is `deriveTagIndex`'s: count descending, then tag ascending.
  tags: { architecture: ["alpha", "beta"], viewer: ["alpha", "gamma"], solo: ["alpha"] },
  dangling: {},
  positions: null,
  stamp: "2026-03-04T09:00:00Z",
};

/** The rail's groups as `{heading: [labels]}`, which is what the eye sees. */
function shape(payload: GraphPayload | null, id: string | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const group of contextModel(payload, id).groups) out[group.heading] = group.rows.map((row) => row.label);
  return out;
}

// --- empty states --------------------------------------------------------------------

describe("contextModel empty states", () => {
  it("says loading before the first graph, not `nothing selected`", () => {
    const model = contextModel(null, "note:alpha");
    expect(model.empty).toBe(RAIL_EMPTY.loading);
    expect(model.groups).toEqual([]);
    expect(model.tags).toEqual([]);
  });

  it("invites a selection when nothing is selected", () => {
    expect(contextModel(GRAPH, null).empty).toBe(RAIL_EMPTY.noSelection);
  });

  it("says so when the selection is not in this graph", () => {
    // A stale selection surviving a refetch that dropped the node. Distinct
    // from "isolated", because the two need different reactions.
    const model = contextModel(GRAPH, "note:vanished");
    expect(model.empty).toBe(RAIL_EMPTY.unknown);
    expect(model.subject).toBeNull();
  });

  it("says so for a real node with no relationships at all", () => {
    const model = contextModel(GRAPH, "note:lonely");
    expect(model.empty).toBe(RAIL_EMPTY.isolated);
    // Still names the subject: the rail is showing the right node, it just
    // has nothing to report about it.
    expect(model.subject).toBe("Lonely");
  });

  it("has no empty message when there is something to show", () => {
    expect(contextModel(GRAPH, "note:alpha").empty).toBeNull();
  });
});

// --- the four groups -------------------------------------------------------------------

describe("contextModel groups", () => {
  it("names the subject, so the rail says what it is describing", () => {
    expect(contextModel(GRAPH, "note:alpha").subject).toBe("Alpha");
  });

  it("shows everything related to a note at once — the §1.1 principle", () => {
    // Standing on Alpha: it links to Beta, Gamma links to it, it mentions
    // src/core, and it shares tags with Beta and Gamma. All visible, no click.
    expect(shape(GRAPH, "note:alpha")).toEqual({
      LINKS: ["Beta"],
      BACKLINKS: ["Gamma"],
      MENTIONS: ["src/core"],
    });
    expect(contextModel(GRAPH, "note:alpha").tags.map((tag) => tag.tag)).toEqual(["architecture", "viewer", "solo"]);
  });

  it("shows a module the notes that discuss it — the reverse direction", () => {
    // The question a repository workspace exists to answer, and the one
    // `deriveBacklinks` cannot answer because it filters to `links-to`.
    expect(shape(GRAPH, "module:src/core")).toEqual({ MENTIONS: ["Alpha", "Beta"] });
  });

  it("omits empty groups rather than rendering a heading over nothing", () => {
    // The rail is a fixed-height region under the graph (§1.2). Four headings
    // with one row between them wastes the space the populated group needed,
    // and an empty heading reads as a load that failed.
    expect(Object.keys(shape(GRAPH, "note:beta"))).toEqual([HEADINGS.backlinks, HEADINGS.mentions]);
  });

  it("keeps the tree's structural edges out of the rail", () => {
    // `contains` and `anchored-at` are the tree's job, and the tree is on
    // screen at the same time. Without this the repository's rail is a second
    // copy of the tree.
    expect(shape(GRAPH, "repository")).toEqual({});
    expect(shape(GRAPH, "vault")).toEqual({});
    expect(contextModel(GRAPH, "vault").empty).toBe(RAIL_EMPTY.isolated);
  });

  it("separates mentions from links, so a note's prose and its code do not mix", () => {
    const groups = contextModel(GRAPH, "note:alpha").groups;
    const links = groups.find((group) => group.heading === HEADINGS.links);
    const mentions = groups.find((group) => group.heading === HEADINGS.mentions);
    expect(links?.rows.map((row) => row.target)).toEqual(["note:beta"]);
    expect(mentions?.rows.map((row) => row.target)).toEqual(["module:src/core"]);
  });

  it("orders the groups as §1.2 sketches them", () => {
    expect(contextModel(GRAPH, "note:alpha").groups.map((group) => group.heading)).toEqual([
      HEADINGS.links,
      HEADINGS.backlinks,
      HEADINGS.mentions,
    ]);
  });
});

// --- rows ----------------------------------------------------------------------------------

describe("context rows", () => {
  it("makes every entry clickable, which is what `bring it to the view` requires", () => {
    const model = contextModel(GRAPH, "note:alpha");
    const rows = [...model.groups.flatMap((group) => group.rows), ...model.tags.flatMap((tag) => tag.siblings)];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.target, row.label).not.toBe("");
  });

  it("gives every row a unique key, so a re-render cannot reorder the rail", () => {
    const model = contextModel(GRAPH, "note:alpha");
    const ids = [...model.groups.flatMap((group) => group.rows), ...model.tags.flatMap((tag) => tag.siblings)].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the kind and provenance glyphs the tree uses, not a second set", () => {
    const backlink = contextModel(GRAPH, "note:alpha").groups.find((g) => g.heading === HEADINGS.backlinks)?.rows[0];
    expect(backlink?.provenance).toBe("generated");
    expect(backlink?.provenanceGlyph).toBe("○");
    expect(backlink?.provenanceTitle).toBe("generated-authored");
    expect(backlink?.kindGlyph).toBe("▪");
  });

  it("labels a row by the node, not by core's terminal-composed string", () => {
    // `DetailLinkRow.label` is `"links-to → Beta"`; the heading already says
    // the direction, so repeating it in every row is noise.
    const link = contextModel(GRAPH, "note:alpha").groups[0]?.rows[0];
    expect(link?.label).toBe("Beta");
  });

  it("marks a row that is itself the selection", () => {
    // Reachable through the tag siblings of a note that shares a tag with the
    // selection — the rail can legitimately list what is already selected.
    const alpha = NODES[1]!;
    expect(rowFor("x", alpha, "note:alpha").selected).toBe(true);
    expect(rowFor("x", alpha, "note:beta").selected).toBe(false);
  });

  it("skips an edge whose target is missing from the payload", () => {
    // Core filters these already; this is the guard for a truncated payload,
    // where an edge can outlive the node it points at.
    const torn: GraphPayload = {
      ...GRAPH,
      // No tags either, so the only thing that could populate the rail is an
      // edge — and every edge here points at a node that is gone.
      tags: {},
      model: {
        ...GRAPH.model,
        nodes: [node("note:alpha", "note", "Alpha", "human")],
        edges: [
          { source: "note:alpha", target: "note:gone", kind: "links-to" },
          { source: "note:missing", target: "note:alpha", kind: "links-to" },
          { source: "note:absent", target: "note:alpha", kind: "mentions" },
          { source: "note:alpha", target: "module:evaporated", kind: "mentions" },
        ],
      },
    };
    expect(contextModel(torn, "note:alpha").empty).toBe(RAIL_EMPTY.isolated);
    expect(contextModel(torn, "note:alpha").groups).toEqual([]);
  });
});

describe("rowFromDetail", () => {
  const byId = new Map(NODES.map((n) => [n.id, n]));
  const detail = { id: "link:links-to:note:beta", target: "note:beta", label: "links-to → Beta", kind: "note" as const, provenance: "agent" as const, direction: "link" as const };

  it("resolves a detail row against the node set", () => {
    expect(rowFromDetail(detail, byId, null)).toMatchObject({ id: detail.id, target: "note:beta", label: "Beta" });
  });

  it("is null for a row with no target", () => {
    // `SelectableRow.target` is optional in general and always set on a
    // `DetailLinkRow`, so this guard is unreachable through `contextModel` —
    // and a guard that cannot be exercised is one nobody can check is right.
    const { target: _dropped, ...targetless } = detail;
    expect(rowFromDetail(targetless, byId, null)).toBeNull();
  });

  it("is null for a target that is not in the node set", () => {
    expect(rowFromDetail({ ...detail, target: "note:gone" }, byId, null)).toBeNull();
  });
});

describe("slugOf", () => {
  it("reads the slug out of a note id", () => {
    expect(slugOf("note:release-plan")).toBe("release-plan");
  });

  it("is null for a non-note id and for a malformed one", () => {
    expect(slugOf("module:src/core")).toBeNull();
    expect(slugOf("note:")).toBeNull();
  });
});

// --- tags -----------------------------------------------------------------------------------

describe("tagsFor", () => {
  const byId = new Map(NODES.map((n) => [n.id, n]));

  it("reads the structured index, never the display string", () => {
    // §4.2 forbids turning `detail.tags` back into structure, and it would be
    // lossy: a tag containing a comma round-trips wrong.
    const commas: GraphPayload = { ...GRAPH, tags: { "a, b": ["alpha"] } };
    expect(tagsFor(commas, "alpha", byId, null).map((tag) => tag.tag)).toEqual(["a, b"]);
  });

  it("lists the other notes carrying each tag", () => {
    const tags = tagsFor(GRAPH, "alpha", byId, null);
    expect(tags.map((tag) => [tag.tag, tag.count, tag.siblings.map((row) => row.label)])).toEqual([
      ["architecture", 2, ["Beta"]],
      ["viewer", 2, ["Gamma"]],
      ["solo", 1, []],
    ]);
  });

  it("keeps a tag with no siblings — it still says something true", () => {
    expect(tagsFor(GRAPH, "alpha", byId, null).find((tag) => tag.tag === "solo")).toMatchObject({ count: 1, siblings: [] });
  });

  it("preserves the server's count-descending ranking rather than re-sorting", () => {
    // `deriveTagIndex` already ordered these (§4.3) and the ETag depends on
    // that order; re-sorting here would discard a ranking already computed.
    expect(tagsFor(GRAPH, "alpha", byId, null).map((tag) => tag.tag)).toEqual(["architecture", "viewer", "solo"]);
  });

  it("returns nothing for a note in no tag", () => {
    expect(tagsFor(GRAPH, "lonely", byId, null)).toEqual([]);
  });

  it("skips a slug with no node, which a truncated graph produces", () => {
    const stale: GraphPayload = { ...GRAPH, tags: { architecture: ["alpha", "deleted"] } };
    expect(tagsFor(stale, "alpha", byId, null)[0]?.siblings).toEqual([]);
  });

  it("is empty for a non-note selection, which has no slug to look up", () => {
    expect(contextModel(GRAPH, "module:src/core").tags).toEqual([]);
    expect(contextModel(GRAPH, "repository").tags).toEqual([]);
  });
});

// --- incoming mentions -------------------------------------------------------------------------

describe("incomingMentions", () => {
  const model = viewModel(GRAPH);
  const byId = new Map(NODES.map((n) => [n.id, n]));

  it("finds every note that names a path", () => {
    expect(incomingMentions(model, "module:src/core", byId, null).map((row) => row.label)).toEqual(["Alpha", "Beta"]);
  });

  it("ignores edges of other kinds pointing at the same node", () => {
    // `repository → module:src/core` is a `contains`, not a mention.
    expect(incomingMentions(model, "module:src/core", byId, null).every((row) => row.kind === "note")).toBe(true);
  });

  it("is empty for a node nothing mentions", () => {
    expect(incomingMentions(model, "note:lonely", byId, null)).toEqual([]);
  });
});
