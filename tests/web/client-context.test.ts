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
import type { ContextGroup } from "../../src/web/client/context/context.model";
import {
  HEADINGS,
  RAIL_COLLAPSE_THRESHOLD,
  RAIL_EMPTY,
  contextModel,
  emptyRailToggles,
  incomingMentions,
  railCollapsed,
  railPanelId,
  railSectionView,
  railTagsView,
  railToggled,
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

  it("carries the kind icon and provenance glyph the tree uses, not a second set", () => {
    const backlink = contextModel(GRAPH, "note:alpha").groups.find((g) => g.heading === HEADINGS.backlinks)?.rows[0];
    expect(backlink?.provenance).toBe("generated");
    expect(backlink?.provenanceGlyph).toBe("○");
    expect(backlink?.provenanceTitle).toBe("generated-authored");
    expect(backlink?.kindIcon).toBe("note");
  });

  it("draws a session-memory note with the session icon, so the two columns agree", () => {
    // A session note reaching the rail through a LINKS edge is the same object
    // it is in the tree; the rail saying so is how the two columns read as one
    // surface.
    const session = { ...NODES[1]!, id: "note:sessions/2026-08-29" };
    expect(rowFor("x", session, null).kindIcon).toBe("session");
    expect(rowFor("x", NODES[1]!, null).kindIcon).toBe("note");
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

// --- counts and collapse (Tier 6, §8 P6.4) -------------------------------------------------

/** A group of `n` unselected rows, for the collapse rules below. */
function groupOf(n: number): ContextGroup {
  return {
    heading: HEADINGS.links,
    count: n,
    rows: Array.from({ length: n }, (_, i) => ({
      id: `row${i}`,
      target: `note:${i}`,
      label: String(i),
      kind: "note" as const,
      kindIcon: "note" as const,
      provenance: null,
      provenanceGlyph: "",
      provenanceTitle: "",
      selected: false,
    })),
  };
}
/** The group above re-headed — same shape, different name, since a toggle is keyed by heading. */
function rehead(group: ContextGroup, heading: string): ContextGroup {
  return { ...group, heading, count: group.count };
}

describe("counts", () => {
  it("carries each group's size, so the heading never recounts", () => {
    expect(contextModel(GRAPH, "module:src/core").groups.map((g) => [g.heading, g.count])).toEqual([[HEADINGS.mentions, 2]]);
  });

  it("counts the tags themselves, not their sibling rows", () => {
    // "3 tags" is what a scanner wants from a heading; the sibling count is
    // already the rail's row count and would double-count a note twice.
    expect(contextModel(GRAPH, "note:alpha").tagsCount).toBe(3);
    expect(contextModel(GRAPH, "note:lonely").tagsCount).toBe(0);
    // Every empty state reports 0 rather than leaving the field undefined.
    expect(contextModel(null, "note:alpha").tagsCount).toBe(0);
  });
});

describe("railCollapsed", () => {
  const none = emptyRailToggles();
  const LINKS = HEADINGS.links;

  it("leaves a short section open — collapsing three rows would be ceremony", () => {
    expect(railCollapsed(none, LINKS, 3, false)).toBe(false);
  });

  it("collapses a section past the threshold", () => {
    expect(RAIL_COLLAPSE_THRESHOLD).toBe(8);
    expect(railCollapsed(none, LINKS, RAIL_COLLAPSE_THRESHOLD, false)).toBe(false);
    expect(railCollapsed(none, LINKS, RAIL_COLLAPSE_THRESHOLD + 1, false)).toBe(true);
  });

  it("never collapses a section holding the selection, however the user toggled it", () => {
    // The selection is §1.3's bus and can arrive from the graph's stage click;
    // a selection that vanished into a fold reads as "the click did nothing".
    const everything = { open: new Set<string>(), closed: new Set([LINKS]) };
    expect(railCollapsed(everything, LINKS, 40, true)).toBe(false);
    expect(railCollapsed(everything, LINKS, 40, false)).toBe(true);
  });

  it("gives the user's explicit words the precedence, in order", () => {
    // A close beats the default; an open beats a large default; the two sets
    // can never both answer while a heading sits in both.
    const closed = { open: new Set<string>(["TAGS"]), closed: new Set<string>([LINKS]) };
    expect(railCollapsed(closed, LINKS, 3, false)).toBe(true);
    expect(railCollapsed(closed, "TAGS", 40, false)).toBe(false);
  });
});

describe("railSectionView", () => {
  const none = emptyRailToggles();

  it("empties the rows when collapsed, so the fold is decided here, not in the .tsx", () => {
    const view = railSectionView(groupOf(RAIL_COLLAPSE_THRESHOLD + 1), none);
    expect(view.collapsed).toBe(true);
    expect(view.rows).toEqual([]);
    expect(view.count).toBe(RAIL_COLLAPSE_THRESHOLD + 1);
    // The count survives the fold: a closed section that reads "0" would be a
    // lie about what it holds.
  });
});

describe("railTagsView", () => {
  const none = emptyRailToggles();
  const tags = contextModel(GRAPH, "note:alpha").tags;

  it("routes through the same collapse rule as the link sections", () => {
    // Three tags is far under the threshold, twice over.
    expect(railTagsView(tags, none).collapsed).toBe(false);
    expect(railTagsView(tags, none).count).toBe(3);
    expect(railTagsView(tags, none).heading).toBe(HEADINGS.tags);
  });

  it("stays open when the selection is one of the tag's siblings", () => {
    const shut = { open: new Set<string>(), closed: new Set<string>([HEADINGS.tags]) };
    expect(railTagsView(tags, shut).collapsed).toBe(true);
    // `architecture`'s siblings include Beta; making that row the selection
    // forces the section open again.
    const withSelection = tags.map((tag) =>
      tag.tag === "architecture" ? { ...tag, siblings: tag.siblings.map((row) => ({ ...row, selected: true })) } : tag,
    );
    expect(railTagsView(withSelection, shut).collapsed).toBe(false);
  });
});

describe("railToggled", () => {
  const none = emptyRailToggles();
  const LINKS = HEADINGS.links;

  it("records an open against a collapsed section, and a close against an open one", () => {
    const opened = railToggled(none, LINKS, true);
    expect(opened.open.has(LINKS)).toBe(true);
    expect(railCollapsed(opened, LINKS, 3, false)).toBe(false);
    const shut = railToggled(opened, LINKS, false);
    expect(railCollapsed(shut, LINKS, 3, false)).toBe(true);
    expect(shut.open.has(LINKS)).toBe(false);
  });

  it("never leaves a heading in both sets, however many times it is flicked", () => {
    let toggles = none;
    for (let i = 0; i < 6; i++) toggles = railToggled(toggles, LINKS, i % 2 === 0);
    expect(toggles.open.has(LINKS) && toggles.closed.has(LINKS)).toBe(false);
  });

  it("leaves the other headings' words untouched", () => {
    const toggles = railToggled(railToggled(none, LINKS, true), HEADINGS.mentions, false);
    expect(toggles.open.has(LINKS)).toBe(true);
    expect(toggles.closed.has(HEADINGS.mentions)).toBe(true);
  });
});

describe("railPanelId", () => {
  it("is a stable id for aria-controls to name", () => {
    // Headings are a fixed vocabulary, so the id is derived rather than
    // invented — and identical across re-renders, which is what the reference
    // being a *promise about the DOM* requires.
    expect(railPanelId(HEADINGS.backlinks)).toBe("weave-ctx-panel-backlinks");
    expect(railPanelId(HEADINGS.backlinks)).toBe(railPanelId(HEADINGS.backlinks));
    expect(railSectionView(rehead(groupOf(1), HEADINGS.backlinks), emptyRailToggles()).heading).toBe(HEADINGS.backlinks);
  });
});
