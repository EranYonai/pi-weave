import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "../../src/core/slug";

describe("slugify", () => {
  it("lowercases and dashes basic titles", () => {
    expect(slugify("Auth Boundary Decision")).toBe("auth-boundary-decision");
  });

  it("strips punctuation", () => {
    expect(slugify("What is auth, really?")).toBe("what-is-auth-really");
  });

  it("folds accents to ASCII", () => {
    expect(slugify("Résumé über café")).toBe("resume-uber-cafe");
  });

  it("collapses repeated dashes and trims edges", () => {
    expect(slugify("--weird___title--")).toBe("weird-title");
  });

  it("falls back to 'note' when nothing usable remains", () => {
    expect(slugify("🔥🔥")).toBe("note");
    expect(slugify("   ")).toBe("note");
  });
});

describe("uniqueSlug", () => {
  it("returns the base when free", () => {
    expect(uniqueSlug("foo", () => false)).toBe("foo");
  });

  it("appends -2, -3, ... until free", () => {
    const taken = new Set(["foo", "foo-2", "foo-4"]);
    expect(uniqueSlug("foo", (s) => taken.has(s))).toBe("foo-3");
  });
});
