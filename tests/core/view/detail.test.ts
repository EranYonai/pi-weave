/**
 * src/core/view/detail.ts — detailModel.
 * Promoted from tests/pi/viewTuiModel.test.ts + viewTuiCoverage.test.ts.
 */

import { describe, expect, it } from "vitest";
import { detailModel } from "../../../src/core/view";
import { graph, node } from "./fixtures";

const T0 = "2026-01-01T00:00:00.000Z";

describe("detailModel", () => {
  it("orders meta, derives links and backlinks (contains not a backlink)", () => {
    const model = graph(
      [
        node("vault", "vault", "Vault", null),
        node("note:a", "note", "A", "human", { slug: "a", updated: T0, tags: "x, y" }),
        node("note:b", "note", "B", "agent", { slug: "b" }),
        node("module:src", "module", "src", null, { path: "src", files: "3" }),
      ],
      [
        { source: "vault", target: "note:a", kind: "contains" },
        { source: "vault", target: "note:b", kind: "contains" },
        { source: "note:a", target: "note:b", kind: "links-to" },
        { source: "note:b", target: "note:a", kind: "links-to" },
      ],
    );
    const d = detailModel(model, "note:a")!;
    expect(d.label).toBe("A");
    expect(d.provenance).toBe("human");
    const keys = d.meta.map((m) => m.label);
    expect(keys.indexOf("slug")).toBeLessThan(keys.indexOf("updated"));
    expect(keys).toContain("tags");
    expect(d.links.map((l) => l.target)).toContain("note:b");
    expect(d.backlinks.map((l) => l.target)).toEqual(["note:b"]);
    expect(d.links[0]!.direction).toBe("link");
    expect(d.backlinks[0]!.direction).toBe("backlink");
  });

  it("returns null for an unknown id", () => {
    const model = graph([node("vault", "vault", "Vault", null)], []);
    expect(detailModel(model, "note:nope")).toBeNull();
  });

  it("entry-point summary surfaces as a meta row", () => {
    const model = graph(
      [
        node("repository", "repository", "repo", null),
        node("entryPoint:src/index.ts", "entryPoint", "src/index.ts", null, { path: "src/index.ts", summary: "the entry" }),
      ],
      [{ source: "repository", target: "entryPoint:src/index.ts", kind: "contains" }],
    );
    const d = detailModel(model, "entryPoint:src/index.ts")!;
    expect(d.meta.find((m) => m.label === "summary")?.value).toBe("the entry");
  });

  it("renders every known meta key in META_ORDER and links of all outgoing kinds", () => {
    const m = graph(
      [
        node("vault", "vault", "Vault", null, { root: "/v", notes: "1" }),
        node("note:a", "note", "A", "human", {
          slug: "a", source: "human", updated: "2026-01-01", created: "2026-01-01", tags: "x",
          "dangling links": "1", preview: "p", path: "p", files: "1", languages: "TS",
          branch: "main", commit: "abc", "uncommitted changes": "0", captured: "now",
          manifest: "m", kind: "npm", url: "u", "summarized files": "1", "summarized by": "x",
          "summarized at": "now", summary: "s", warning: "w", stale: "yes", state: "fresh",
        }),
        node("note:b", "note", "B", "agent"),
        node("module:src", "module", "src", null),
      ],
      [
        { source: "vault", target: "note:a", kind: "contains" },
        { source: "note:a", target: "note:b", kind: "links-to" },
        { source: "note:a", target: "module:src", kind: "contains" },
      ],
    );
    const d = detailModel(m, "note:a")!;
    const keys = d.meta.map((m2) => m2.label);
    expect(keys[0]).toBe("path");
    expect(keys.indexOf("slug")).toBeLessThan(keys.indexOf("source"));
    expect(d.links.length).toBe(2); // links-to + contains
    expect(d.backlinks).toHaveLength(0);
  });

  it("skips meta keys whose value is the empty string", () => {
    const m = graph([node("note:a", "note", "A", "human", { slug: "a", tags: "" })], []);
    const d = detailModel(m, "note:a")!;
    expect(d.meta.map((x) => x.label)).toEqual(["slug"]);
  });

  it("drops links to unknown targets and backlinks from unknown sources", () => {
    const m = graph(
      [node("note:a", "note", "A", "human", { slug: "a" })],
      [
        { source: "note:a", target: "note:ghost", kind: "links-to" },
        { source: "note:phantom", target: "note:a", kind: "links-to" },
        { source: "note:a", target: "note:ghost2", kind: "contains" },
      ],
    );
    const d = detailModel(m, "note:a")!;
    expect(d.links).toHaveLength(0);
    expect(d.backlinks).toHaveLength(0);
  });

  it("labels links with the edge kind and the disambiguated target label", () => {
    const m = graph(
      [
        node("note:a", "note", "A", "human"),
        node("package:p", "package", "demo", null, { manifest: "package.json" }),
      ],
      [{ source: "note:a", target: "package:p", kind: "links-to" }],
    );
    const d = detailModel(m, "note:a")!;
    expect(d.links[0]!.label).toBe("links-to → demo (package.json)");
    expect(d.links[0]!.id).toBe("link:links-to:package:p");
  });
});
