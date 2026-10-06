import { describe, expect, it } from "vitest";
import { scenePreviewSize } from "../../src/web/client/note/scene-preview-size";

describe("diagram preview sizing", () => {
  it("allows moderate enlargement while preserving the bitmap aspect ratio", () => {
    expect(scenePreviewSize(200, 100, 760, 480, false)).toEqual({ width: 260, height: 130 });
    const enlarged = scenePreviewSize(200, 100, 760, 480, true);
    expect(enlarged.width).toBeCloseTo(390);
    expect(enlarged.height).toBeCloseTo(195);
  });
  it("fits wide and tall diagrams within both available pane dimensions", () => {
    expect(scenePreviewSize(2000, 1000, 600, 500, false)).toEqual({ width: 600, height: 300 });
    expect(scenePreviewSize(400, 2000, 600, 500, false)).toEqual({ width: 100, height: 500 });
    expect(scenePreviewSize(2000, 1000, 600, 500, true)).toEqual({ width: 2000, height: 1000 });
  });
});
