/**
 * The deep-link model (weave-workspace UX backlog T5.4): the selection,
 * addressable, in both directions — a boot hash names a note on screen, and
 * every selection is formatted back into the address bar. Pure functions,
 * §10.
 */

import { describe, expect, it } from "vitest";
import type { GraphPayload } from "../../src/web/shared/wire";
import { deeplinkSelection, formatHash, hashSelection } from "../../src/web/client/shell/deeplink.model";

function graphWith(...ids: string[]): GraphPayload {
  return {
    model: {
      generatedAt: "",
      staleness: null,
      nodes: ids.map((id) => ({ id, kind: "note", label: id, provenance: "human", detail: {} })),
      edges: [],
      contentDigest: "",
    },
    tags: {},
    dangling: {},
    positions: null,
    stamp: "",
  };
}

describe("hashSelection", () => {
  it("parses the #note/<slug> spelling", () => {
    expect(hashSelection("#note/release-plan")).toBe("note:release-plan");
  });

  it("accepts the node-id spelling too", () => {
    // `#note:<slug>` is what the tree's own row ids look like, so a link
    // built from one lands on the same note either way.
    expect(hashSelection("#note:release-plan")).toBe("note:release-plan");
  });

  it("rejects the bare hash, other fragments and the empty slug", () => {
    expect(hashSelection("")).toBeNull();
    expect(hashSelection("#")).toBeNull();
    expect(hashSelection("#repo")).toBeNull();
    expect(hashSelection("#file")).toBeNull();
    expect(hashSelection("#note/")).toBeNull();
  });
});

describe("deeplinkSelection", () => {
  it("selects a hash that names a node the graph holds", () => {
    expect(deeplinkSelection("#note/alpha", graphWith("note:alpha"))).toBe("note:alpha");
  });

  it("refuses a hash naming a node the payload does not hold", () => {
    // A stale link must fall through to the saved note, not land on
    // "Nothing open" with the workspace's own continuity passed over.
    expect(deeplinkSelection("#note/gone", graphWith("note:alpha"))).toBeNull();
  });

  it("is null before the graph arrives, whatever the hash says", () => {
    expect(deeplinkSelection("#note/alpha", null)).toBeNull();
  });
});

describe("formatHash", () => {
  it("formats a note selection", () => {
    expect(formatHash("note:alpha")).toBe("#note/alpha");
  });

  it("formats a cleared selection to the bare URL", () => {
    expect(formatHash(null)).toBe("");
  });

  it("formats nothing for a non-note node — the bar describes the note", () => {
    expect(formatHash("repo")).toBe("");
  });
});