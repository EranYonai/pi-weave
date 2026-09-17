/**
 * The hidden force tuner (docs/weave-workspace.md §15.7).
 *
 * Two questions, and neither needs a browser. First, does the gate open only
 * when it should — a debug panel that appears on a typo is worse than no panel
 * at all. Second, do the constants it writes actually reach the simulation,
 * which is the whole reason the record was made mutable and the one way the
 * feature can be silently dead.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  FORCE_SLIDERS,
  FORCES_FLAG,
  SUGGESTED,
  forcesFlag,
  forcesSnippet,
  formatValue,
  isDefault,
  parseSlider,
  sliderValue,
} from "../../src/web/client/graph/tuner.model";
import { FORCE_DEFAULTS, FORCES, computeLayout, setForces } from "../../src/web/shared/layout";
import type { SliderSpec } from "../../src/web/client/graph/tuner.model";
import { bbox } from "../../src/web/shared/metrics";
import { SIBLING_BLOB_BRANCHES, repoLikeGraph, siblingBlobsGraph } from "../fixtures/graphShapes";

/** Every test that writes `FORCES` must put it back: it is module-global. */
afterEach(() => setForces(FORCE_DEFAULTS));

const spec = (key: SliderSpec["key"]): SliderSpec => FORCE_SLIDERS.find((s) => s.key === key)!;

describe("the tuner's gate", () => {
  it("opens only on an affirmative flag", () => {
    for (const search of ["?forces", "?forces=1", "?forces=true", "?q=x&forces=1", "forces=1"]) {
      expect(forcesFlag(search)).toBe(true);
    }
    for (const search of ["", "?", "?forces=0", "?forces=false", "?forced=1", "?q=forces", "?x=1"]) {
      expect(forcesFlag(search)).toBe(false);
    }
  });

  it("names the parameter it documents", () => {
    expect(FORCES_FLAG).toBe("forces");
    expect(forcesFlag(`?${FORCES_FLAG}=1`)).toBe(true);
  });
});

describe("the sliders", () => {
  it("covers every constant exactly once, with the default inside its range", () => {
    const keys = FORCE_SLIDERS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(Object.keys(FORCE_DEFAULTS)));
    for (const s of FORCE_SLIDERS) {
      const value = FORCE_DEFAULTS[s.key];
      // `chargeMax` ships as Infinity, which reads as the top of its range.
      if (Number.isFinite(value)) expect(value).toBeGreaterThanOrEqual(s.min);
      if (Number.isFinite(value)) expect(value).toBeLessThanOrEqual(s.max);
      expect(s.max).toBeGreaterThan(s.min);
    }
  });

  it("reads an infinite constant as the top of the range, and clamps the rest", () => {
    expect(sliderValue(FORCES, spec("chargeMax"))).toBe(spec("chargeMax").max);
    expect(sliderValue({ ...FORCES, center: 99 }, spec("center"))).toBe(spec("center").max);
    expect(sliderValue({ ...FORCES, center: -99 }, spec("center"))).toBe(spec("center").min);
    expect(sliderValue(FORCES, spec("center"))).toBe(FORCE_DEFAULTS.center);
  });

  it("clamps what a slider reports and refuses a non-number", () => {
    expect(parseSlider(spec("charge"), "-300")).toBe(-300);
    expect(parseSlider(spec("charge"), "-99999")).toBe(spec("charge").min);
    expect(parseSlider(spec("charge"), "500")).toBe(spec("charge").max);
    // A NaN would reach every node position within one tick.
    expect(parseSlider(spec("charge"), "banana")).toBe(FORCE_DEFAULTS.charge);
    expect(parseSlider(spec("chargeMax"), "")).toBe(FORCE_DEFAULTS.chargeMax);
  });

  it("formats a readout without float noise", () => {
    expect(formatValue(90)).toBe("90");
    expect(formatValue(-250)).toBe("-250");
    expect(formatValue(0.02)).toBe("0.02");
    expect(formatValue(0.8500000000000001)).toBe("0.85");
    expect(formatValue(Infinity)).toBe("∞");
  });
});

describe("handing the numbers back", () => {
  it("emits a snippet that names every constant, Infinity included", () => {
    const snippet = forcesSnippet(FORCES);
    for (const s of FORCE_SLIDERS) expect(snippet).toContain(`${s.key}:`);
    expect(snippet).toContain("chargeMax: Infinity,");
    expect(snippet.startsWith("export const FORCES: ForceConstants = {")).toBe(true);
    expect(snippet.trimEnd().endsWith("};")).toBe(true);
  });

  it("knows whether anything has been moved", () => {
    expect(isDefault(FORCES)).toBe(true);
    setForces({ charge: -250 });
    expect(isDefault(FORCES)).toBe(false);
    setForces(FORCE_DEFAULTS);
    expect(isDefault(FORCES)).toBe(true);
  });
});

describe("the constants actually drive the layout", () => {
  const extent = (): number => {
    const box = bbox([...computeLayout(repoLikeGraph(), { ticks: 300, seed: 1 }).values()]);
    return Math.max(box.w, box.h);
  };

  it("changes the arrangement, and restores it exactly", () => {
    const shipped = extent();
    // The direction the diagnosis predicts: real cohesion plus real repulsion
    // against weak centre gravity must spread the graph well past the packed
    // disc the shipped constants settle to. This is the assertion that fails
    // if `createForceSimulation` ever goes back to reading module consts.
    setForces(SUGGESTED);
    expect(extent()).toBeGreaterThan(shipped);
    setForces(FORCE_DEFAULTS);
    expect(extent()).toBe(shipped);
  });

  it("ships a suggestion that actually separates the sibling blobs", () => {
    // The claim in `SUGGESTED`'s doc comment, asserted rather than asserted-in-
    // prose: the shipped constants interleave the three big branches (a
    // negative gap between their bounding boxes) and the suggestion opens a
    // corridor. This is also the shape of the test that will pin the *frozen*
    // constants once a human has picked them.
    const worstGap = (): number => {
      const model = siblingBlobsGraph();
      const at = computeLayout(model, { ticks: 300, seed: 1 });
      const kids = new Map<string, string[]>();
      for (const e of model.edges) {
        if (e.kind !== "contains" && e.kind !== "anchored-at") continue;
        kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
      }
      const boxes = SIBLING_BLOB_BRANCHES.map((root) => {
        const ids: string[] = [];
        const walk = (id: string): void => {
          ids.push(id);
          for (const kid of kids.get(id) ?? []) walk(kid);
        };
        walk(root);
        return bbox(ids.map((id) => at.get(id)).filter((p): p is NonNullable<typeof p> => p !== undefined));
      });
      let worst = Infinity;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          worst = Math.min(worst, Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY));
        }
      }
      return worst;
    };

    expect(worstGap()).toBeLessThan(0);
    setForces(SUGGESTED);
    expect(worstGap()).toBeGreaterThan(0);
  });

  it("stays deterministic under any constants", () => {
    setForces({ charge: -400, center: 0.01 });
    expect(computeLayout(repoLikeGraph(), { ticks: 120, seed: 3 })).toEqual(
      computeLayout(repoLikeGraph(), { ticks: 120, seed: 3 }),
    );
  });
});
