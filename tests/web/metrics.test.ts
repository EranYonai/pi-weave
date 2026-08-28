/**
 * src/web/shared/metrics.ts — the measurements the dynamics gate is built on.
 *
 * These are asserted directly, on hand-computed values, because a gate is only
 * as trustworthy as its ruler. If `variance` returned a constant, every
 * assertion in layout.dynamics.test.ts would pass on a broken layout.
 */

import { describe, expect, it } from "vitest";
import { allFinite, angularOccupancy, bbox, clusterSeparation, minPairwiseDistance, variance } from "../../src/web/shared/metrics";

describe("variance", () => {
  it("is zero for empty and single samples", () => {
    expect(variance([])).toBe(0);
    expect(variance([42])).toBe(0);
  });

  it("is exactly zero for a constant sample — the collapsed-layout case", () => {
    expect(variance([640, 640, 640, 640])).toBe(0);
  });

  it("matches the hand-computed population variance", () => {
    // mean 3; deviations -2,-1,0,1,2; squares 4,1,0,1,4 → 10/5 = 2
    expect(variance([1, 2, 3, 4, 5])).toBe(2);
  });

  it("grows with spread", () => {
    expect(variance([0, 100])).toBeGreaterThan(variance([0, 10]));
  });
});

describe("minPairwiseDistance", () => {
  it("is Infinity below two points", () => {
    expect(minPairwiseDistance([])).toBe(Infinity);
    expect(minPairwiseDistance([{ x: 1, y: 1 }])).toBe(Infinity);
  });

  it("is zero for coincident points", () => {
    expect(
      minPairwiseDistance([
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ]),
    ).toBe(0);
  });

  it("finds the closest pair, not the first", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 103, y: 4 },
    ];
    expect(minPairwiseDistance(pts)).toBe(5);
  });
});

describe("bbox", () => {
  it("is the empty box for no points", () => {
    expect(bbox([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, cx: 0, cy: 0 });
  });

  it("is zero-sized for a single point, centred on it", () => {
    const b = bbox([{ x: 7, y: -3 }]);
    expect(b.w).toBe(0);
    expect(b.h).toBe(0);
    expect(b.cx).toBe(7);
    expect(b.cy).toBe(-3);
  });

  it("spans the extremes and reports width, height and centre", () => {
    const b = bbox([
      { x: -10, y: 4 },
      { x: 30, y: -6 },
      { x: 0, y: 0 },
    ]);
    expect(b).toEqual({ minX: -10, minY: -6, maxX: 30, maxY: 4, w: 40, h: 10, cx: 10, cy: -1 });
  });
});

describe("clusterSeparation", () => {
  const positions = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 300, y: 0 }],
    ["c", { x: 0, y: 400 }],
  ]);

  it("is the closest anchor pair", () => {
    expect(clusterSeparation(positions, ["a", "b", "c"])).toBe(300);
  });

  it("skips ids with no position", () => {
    expect(clusterSeparation(positions, ["a", "missing", "c"])).toBe(400);
  });

  it("is Infinity below two resolvable anchors", () => {
    expect(clusterSeparation(positions, ["a"])).toBe(Infinity);
    expect(clusterSeparation(positions, ["nope", "nada"])).toBe(Infinity);
  });
});

describe("angularOccupancy", () => {
  const origin = { x: 0, y: 0 };

  it("counts every sector for a full ring", () => {
    const pts = Array.from({ length: 36 }, (_, i) => {
      const a = (i / 36) * Math.PI * 2;
      return { x: Math.cos(a) * 50, y: Math.sin(a) * 50 };
    });
    expect(angularOccupancy(origin, pts, 12)).toBe(12);
  });

  it("counts two sectors for a line through the centre — the failure signature", () => {
    const pts = [
      { x: -50, y: 0 },
      { x: -20, y: 0 },
      { x: 20, y: 0 },
      { x: 50, y: 0 },
    ];
    expect(angularOccupancy(origin, pts, 12)).toBe(2);
  });

  it("counts one sector for a single ray", () => {
    expect(angularOccupancy(origin, [{ x: 0, y: 10 }, { x: 0, y: 40 }], 12)).toBe(1);
  });

  it("ignores points at the exact centre", () => {
    expect(angularOccupancy(origin, [origin, origin], 12)).toBe(0);
  });

  it("clamps the +π edge into the last sector rather than overflowing", () => {
    // atan2(+0, -1) === +π exactly — the one input whose raw index is `sectors`,
    // one past the end. Unclamped it would be its own phantom sector, so a point
    // just short of +π plus a point exactly at +π would count as two, not one.
    const justShort = { x: -1000, y: 1 }; // atan2 just under +π ⇒ last sector
    expect(Math.atan2(0, -1)).toBe(Math.PI);
    expect(angularOccupancy(origin, [justShort], 4)).toBe(1);
    expect(angularOccupancy(origin, [justShort, { x: -1, y: 0 }], 4)).toBe(1);
  });
});

describe("allFinite", () => {
  it("accepts an empty set and finite points", () => {
    expect(allFinite([])).toBe(true);
    expect(allFinite([{ x: 0, y: -1e9 }])).toBe(true);
  });

  it("rejects NaN and Infinity on either axis", () => {
    expect(allFinite([{ x: Number.NaN, y: 0 }])).toBe(false);
    expect(allFinite([{ x: 0, y: Number.POSITIVE_INFINITY }])).toBe(false);
    expect(allFinite([{ x: 1, y: 1 }, { x: 0, y: Number.NEGATIVE_INFINITY }])).toBe(false);
  });
});
