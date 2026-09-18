import { describe, expect, it } from "vitest";
import { suggestLinks, suggestionTarget } from "../../src/core/links/similar";

const note = (slug: string, title: string, body = "", tags: string[] = []) => ({ slug, title, tags, body });

/**
 * A vault with two genuine clusters and a decoy.
 *
 * `filler-*` notes exist to give the corpus a size, so document frequency
 * means something: with three notes every term is "rare" and everything
 * connects to everything.
 */
function corpus(extra: ReturnType<typeof note>[] = []) {
  const filler = Array.from({ length: 30 }, (_, i) =>
    note(`filler/f${i}`, `Filler ${i}`, `routine standup notes number ${i} nothing special here`),
  );
  return { notes: [...filler, ...extra] };
}

describe("suggestLinks", () => {
  it("connects notes sharing rare vocabulary, with the evidence", () => {
    const input = corpus([
      note("a/alpha", "Alpha", "the zephyrine protocol governs quorum handoff"),
      note("b/beta", "Beta", "quorum handoff under the zephyrine protocol is delicate"),
    ]);
    const { suggestions } = suggestLinks(input);
    expect(suggestions[0]).toMatchObject({ a: "a/alpha", b: "b/beta" });
    expect(suggestions[0]!.score).toBeGreaterThan(0);
    expect(suggestions[0]!.shared).toContain("zephyrine");
  });

  it("scores a real cosine — never above 1", () => {
    const input = corpus([
      note("a/one", "One", "zephyrine quorum handoff protocol"),
      note("b/two", "Two", "zephyrine quorum handoff protocol"),
    ]);
    for (const s of suggestLinks(input).suggestions) {
      expect(s.score).toBeLessThanOrEqual(1);
      expect(s.score).toBeGreaterThan(0);
    }
  });

  it("ignores vocabulary common to the whole vault", () => {
    // Every filler note says "routine" and "standup". A pair that shares only
    // those is the same *genre*, not the same subject.
    const input = corpus([
      note("a/x", "X", "routine standup notes nothing special here"),
      note("b/y", "Y", "routine standup notes nothing special here"),
    ]);
    expect(suggestLinks(input).suggestions).toEqual([]);
  });

  it("never re-suggests a pair that is already linked", () => {
    const linked = corpus([
      note("a/alpha", "Alpha", "zephyrine quorum handoff — see [[b/beta]]"),
      note("b/beta", "Beta", "zephyrine quorum handoff"),
    ]);
    expect(suggestLinks(linked).suggestions).toEqual([]);
  });

  it("treats a repairable link as an existing connection", () => {
    // `[[beta]]` resolves to `b/beta` by basename, so the pair is connected
    // even though the link is written stale.
    const input = corpus([
      note("a/alpha", "Alpha", "zephyrine quorum handoff — see [[beta]]"),
      note("b/beta", "Beta", "zephyrine quorum handoff"),
    ]);
    expect(suggestLinks(input).suggestions).toEqual([]);
  });

  it("still suggests a pair whose existing link is ambiguous", () => {
    // `[[plan]]` matches two notes, so it connects neither — the notes are
    // not actually linked, and the suggestion stands.
    const input = corpus([
      note("a/alpha", "Alpha", "zephyrine quorum handoff, see [[plan]]"),
      note("b/beta", "Beta", "zephyrine quorum handoff"),
      note("x/plan", "X Plan", "routine"),
      note("y/plan", "Y Plan", "routine"),
    ]);
    expect(suggestLinks(input, { slug: "a/alpha" }).suggestions[0]?.b).toBe("b/beta");
  });

  it("ignores a link to a note that does not exist", () => {
    const input = corpus([
      note("a/alpha", "Alpha", "zephyrine quorum handoff, see [[ghost]]"),
      note("b/beta", "Beta", "zephyrine quorum handoff"),
    ]);
    expect(suggestLinks(input, { slug: "a/alpha" }).suggestions[0]?.b).toBe("b/beta");
  });

  it("scopes to one note when asked", () => {
    const input = corpus([
      note("a/alpha", "Alpha", "zephyrine quorum handoff"),
      note("b/beta", "Beta", "zephyrine quorum handoff"),
      note("c/gamma", "Gamma", "unrelated palomino saddle stitching"),
      note("d/delta", "Delta", "palomino saddle stitching technique"),
    ]);
    const { suggestions } = suggestLinks(input, { slug: "a/alpha" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ a: "a/alpha", b: "b/beta" });
  });

  it("returns nothing for an unknown or featureless focus", () => {
    expect(suggestLinks(corpus(), { slug: "nope" }).suggestions).toEqual([]);
    const blank = suggestLinks(corpus([note("a/empty", "", "")]), { slug: "a/empty" });
    expect(blank.suggestions).toEqual([]);
  });

  it("honours limit, minScore and evidence caps", () => {
    const input = corpus([
      note("a/alpha", "Alpha", "zephyrine quorum handoff palomino saddle stitching brackish"),
      note("b/beta", "Beta", "zephyrine quorum handoff palomino saddle stitching brackish"),
      note("c/gamma", "Gamma", "zephyrine quorum handoff palomino saddle stitching brackish"),
    ]);
    expect(suggestLinks(input, { limit: 1 }).suggestions).toHaveLength(1);
    expect(suggestLinks(input, { minScore: 1.01 }).suggestions).toEqual([]);
    expect(suggestLinks(input, { evidence: 2 }).suggestions[0]!.shared).toHaveLength(2);
  });

  it("folds title and tags into the same signal as the body", () => {
    const input = corpus([
      note("a/alpha", "Zephyrine", "nothing else of note here at all"),
      note("b/beta", "Plain", "routine standup", ["zephyrine"]),
    ]);
    const { suggestions } = suggestLinks(input, { slug: "a/alpha" });
    expect(suggestions[0]?.b).toBe("b/beta");
  });

  it("counts only notes carrying a distinctive term", () => {
    // The filler notes are interchangeable boilerplate: nothing in them is
    // rare, so there is nothing to compare and they are not "considered".
    expect(suggestLinks(corpus()).considered).toBe(0);
    const withSignal = suggestLinks(
      corpus([note("a/alpha", "Alpha", "zephyrine"), note("b/beta", "Beta", "zephyrine")]),
    );
    expect(withSignal.considered).toBe(2);
    expect(suggestLinks({ notes: [] })).toEqual({ considered: 0, suggestions: [] });
  });

  it("is deterministic and order-independent in its pair keys", () => {
    const input = corpus([
      note("z/last", "Last", "zephyrine quorum handoff"),
      note("a/first", "First", "zephyrine quorum handoff"),
    ]);
    const once = suggestLinks(input);
    const twice = suggestLinks(input);
    expect(once).toEqual(twice);
    // Focused from the *larger* slug: the pair must still be keyed and
    // reported smaller-first, which is the branch a vault-wide run never
    // reaches.
    expect(suggestLinks(input, { slug: "z/last" }).suggestions[0]).toMatchObject({
      a: "a/first",
      b: "z/last",
    });
    // `a` is always the lexicographically smaller slug: a suggestion is
    // unordered, so its rendering must not depend on note order.
    expect(once.suggestions[0]).toMatchObject({ a: "a/first", b: "z/last" });
  });
});

describe("suggestionTarget", () => {
  it("slugifies each path segment", () => {
    expect(suggestionTarget("1-1s/Some Note")).toBe("1-1s/some-note");
  });
});
