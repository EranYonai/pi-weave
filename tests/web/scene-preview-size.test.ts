import { describe, expect, it } from "vitest";
import { scenePreviewSize } from "../../src/web/client/note/scene-preview-size";

describe("diagram preview sizing", () => {
  it("upscales small diagrams to fill the reading column while preserving aspect ratio", () => {
    expect(scenePreviewSize(200, 100, 760, false)).toEqual({ width: 760, height: 380 });
    const enlarged = scenePreviewSize(200, 100, 760, true);
    expect(enlarged.width).toBeCloseTo(1140);
    expect(enlarged.height).toBeCloseTo(570);
  });
  it("fits width for wide and tall diagrams, leaving tall content to scroll", () => {
    expect(scenePreviewSize(2000, 1000, 600, false)).toEqual({ width: 600, height: 300 });
    expect(scenePreviewSize(400, 2000, 760, false)).toEqual({ width: 760, height: 3800 });
    expect(scenePreviewSize(2000, 1000, 600, true)).toEqual({ width: 2000, height: 1000 });
  });
});
