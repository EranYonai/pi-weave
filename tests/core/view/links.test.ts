/**
 * src/core/view/links.ts — deriveBacklinks, deriveTagIndex.
 * Promoted from tests/pi/viewTuiModel.test.ts + viewTuiCoverage.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../../../src/core/graph/model";
import type { NoteSummary } from "../../../src/core/types";
import { deriveBacklinks, deriveTagIndex, type TaggedNote } from "../../../src/core/view";

describe("deriveBacklinks", () => {
  it("maps each target to its incoming links-to sources", () => {
    const edges: GraphEdge[] = [
      { source: "a", target: "b", kind: "links-to" },
      { source: "c", target: "b", kind: "links-to" },
      { source: "a", target: "c", kind: "contains" },
    ];
    const bl = deriveBacklinks(edges);
    expect(bl.get("b")).toEqual(["a", "c"]);
    // contains is not a backlink
    expect(bl.has("c")).toBe(false);
  });
  it("is empty for no edges", () => {
    expect(deriveBacklinks([]).size).toBe(0);
  });
  it("ignores non-links-to edge kinds entirely", () => {
    const edges: GraphEdge[] = [
      { source: "a", target: "b", kind: "contains" },
      { source: "a", target: "b", kind: "anchored-at" },
      { source: "a", target: "b", kind: "mentions" },
    ];
    expect(deriveBacklinks(edges).size).toBe(0);
  });
});

// --- deriveTagIndex (§4.3) ----------------------------------------------------

function tagged(slug: string, ...tags: string[]): TaggedNote {
  return { slug, tags };
}

describe("deriveTagIndex", () => {
  it("inverts note→tags into tag→slugs", () => {
    const index = deriveTagIndex([tagged("a", "arch"), tagged("b", "arch", "viewer")]);
    expect(index).toEqual([
      { tag: "arch", slugs: ["a", "b"] },
      { tag: "viewer", slugs: ["b"] },
    ]);
  });

  it("orders by count desc, then tag asc", () => {
    // `zebra` and `alpha` both have 1 note, so they tie and break
    // alphabetically — not by the order they were encountered.
    const index = deriveTagIndex([
      tagged("n1", "zebra", "popular"),
      tagged("n2", "alpha", "popular"),
      tagged("n3", "popular"),
    ]);
    expect(index.map((t) => [t.tag, t.slugs.length])).toEqual([
      ["popular", 3],
      ["alpha", 1],
      ["zebra", 1],
    ]);
  });

  it("sorts each slug list ascending regardless of note order", () => {
    // The whole point: two vaults holding the same tag memberships in a
    // different note order must produce byte-identical output, or the index
    // cannot ride an ETag derived from content.
    const forward = deriveTagIndex([tagged("a", "t"), tagged("b", "t"), tagged("c", "t")]);
    const reverse = deriveTagIndex([tagged("c", "t"), tagged("b", "t"), tagged("a", "t")]);
    expect(forward).toEqual([{ tag: "t", slugs: ["a", "b", "c"] }]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });

  it("collapses a tag repeated inside one note", () => {
    // Front matter is hand-editable; `tags: [a, a]` is a typo, not two
    // memberships, and must not inflate the count that drives the ordering.
    const index = deriveTagIndex([tagged("dup", "a", "a", "a")]);
    expect(index).toEqual([{ tag: "a", slugs: ["dup"] }]);
  });

  it("is empty for no notes, and for notes with no tags", () => {
    expect(deriveTagIndex([])).toEqual([]);
    expect(deriveTagIndex([tagged("bare"), tagged("also-bare")])).toEqual([]);
  });

  it("treats tags case-sensitively (no normalization here)", () => {
    // Deliberate: normalizing would be a vault-wide policy decision, and the
    // place to make it is the front-matter parser, not a read-side index that
    // would then disagree with what the note actually says.
    const index = deriveTagIndex([tagged("a", "Arch"), tagged("b", "arch")]);
    expect(index.map((t) => t.slugs)).toEqual([["a"], ["b"]]);
    expect(new Set(index.map((t) => t.tag))).toEqual(new Set(["Arch", "arch"]));
  });

  it("breaks ties by codepoint, not locale", () => {
    // `localeCompare` would sort "Arch" and "arch" case-insensitively (and
    // differently depending on the runtime's ICU build). This output feeds an
    // ETag, so the order has to be the same on every machine: uppercase
    // sorts before lowercase because 'A' (0x41) < 'a' (0x61).
    const index = deriveTagIndex([tagged("b", "arch"), tagged("a", "Arch")]);
    expect(index.map((t) => t.tag)).toEqual(["Arch", "arch"]);
  });

  it("accepts a NoteSummary array — the §4.3 signature", () => {
    // The parameter is structurally widened to `{ slug, tags }`, so this is
    // the check that the documented `NoteSummary[]` call still typechecks.
    const summaries: NoteSummary[] = [
      {
        slug: "s1",
        title: "S1",
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        tags: ["x"],
        source: "human",
        bodyLength: 10,
      },
    ];
    expect(deriveTagIndex(summaries)).toEqual([{ tag: "x", slugs: ["s1"] }]);
  });

  it("does not merge two notes that share a slug-like tag name", () => {
    // Guards against keying the accumulator on the wrong axis.
    const index = deriveTagIndex([tagged("arch", "b"), tagged("other", "arch")]);
    expect(index).toEqual([
      { tag: "arch", slugs: ["other"] },
      { tag: "b", slugs: ["arch"] },
    ]);
  });
});
