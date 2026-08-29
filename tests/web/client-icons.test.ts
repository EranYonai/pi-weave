/**
 * The inline icon sprite (Tier 6, §8 P6.4).
 *
 * The sprite is a constant, so — like `THEME_CSS` — it can be checked as
 * data. What matters here is not the artwork but the three properties the
 * rest of the workspace silently depends on: every name anything can ask for
 * exists, every path stays inside the box it claims, and nothing in the file
 * could make the browser fetch a byte (the CSP grants no `img-src`/`font-src`
 * beyond `'self'`, and the theme gate refuses `url(` outright).
 */

import { describe, expect, it } from "vitest";
import { ICON_BOX, ICONS, ICON_STROKE } from "../../src/web/client/shell/icons.model";
import type { IconName } from "../../src/web/client/shell/icons.model";
import { WIRE_NODE_KINDS } from "../../src/web/shared/wire";
import { kindIcon, isSessionNote } from "../../src/web/client/tree/tree.model";

describe("ICONS", () => {
  /** Coarse path-length check: an icon is small, a missing `d` is not. */
  function pathLength(d: string): number {
    return d.length;
  }

  it("draws every glyph from at least one path", () => {
    for (const [name, def] of Object.entries(ICONS)) {
      expect(def.d.length, name).toBeGreaterThan(0);
      for (const d of def.d) expect(pathLength(d), name).toBeGreaterThan(5);
    }
  });

  it("stays inside its declared box", () => {
    // Every coordinate is in the 16-box, so the renderer needs no per-icon
    // viewBox override. A path that drifted out would be clipped mid-glyph —
    // the failure that makes an icon look like a smudge rather than a shape.
    for (const [name, def] of Object.entries(ICONS)) {
      for (const d of def.d) {
        const coords = [...d.matchAll(/(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
        expect(Math.max(...coords), `${name}: ${d}`).toBeLessThanOrEqual(ICON_BOX);
        expect(Math.min(...coords), `${name}: ${d}`).toBeGreaterThanOrEqual(-ICON_BOX);
      }
    }
  });

  it("carries no reference the CSP would have to fetch", () => {
    // No `url(`, no `href`, no `xlink` — the sprite is pure `d` strings, so
    // there is nothing for `img-src` to be asked about and nothing for a
    // sanitizer to have to trust.
    for (const def of Object.values(ICONS)) {
      for (const d of def.d) {
        expect(d.toLowerCase()).not.toContain("url(");
        expect(d.toLowerCase()).not.toContain("href");
      }
    }
    expect(JSON.stringify(ICONS)).not.toMatch(/<svg|<use|<symbol/);
  });

  it("uses the sheet's 1.5px stroke unless an icon says otherwise", () => {
    // One stroke weight across every outline is the point of the pass: the
    // glyph soup was characters from three fallbacks at three weights.
    for (const def of Object.values(ICONS)) {
      expect(def.width ?? ICON_STROKE, def.d[0]).toBeGreaterThanOrEqual(ICON_STROKE);
    }
  });

  it("draws every node kind the wire can carry", () => {
    // The gate that matters: a kind added to core is a failing test here
    // rather than a silent `undefined` reaching the tree.
    expect(new Set(WIRE_NODE_KINDS.map(kindIcon)).size).toBe(WIRE_NODE_KINDS.length);
    for (const kind of WIRE_NODE_KINDS) expect(ICONS[kindIcon(kind)], kind).toBeDefined();
  });

  it("gives the session fold its own glyph while notes keep the page", () => {
    expect(isSessionNote("note:sessions/x")).toBe(true);
    expect(ICONS.session).toBeDefined();
    expect(ICONS.note).toBeDefined();
    expect(ICONS.session).not.toBe(ICONS.note);
  });
});

describe("ICON_BOX", () => {
  it("is the box every path assumes, and dense-row friendly", () => {
    // 16px: large enough for a 1.5px stroke to keep its weight, small enough
    // to sit in the tree's 26px row beside 12px text.
    expect(ICON_BOX).toBe(16);
  });
});

describe("the names the two renderers ask for", () => {
  it("covers every call site's needs", () => {
    // `Tree.tsx`'s twisty and kind slots, and `ContextRail.tsx`'s row glyphs
    // and group chevrons, between them ask for these.
    const asked: IconName[] = ["chevron", "session", "note", "module", "repository", "external"];
    for (const name of asked) expect(ICONS[name], name).toBeDefined();
  });
});