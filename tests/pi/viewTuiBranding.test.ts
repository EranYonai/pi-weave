import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MARK_GLYPH, WORDMARK, renderMark } from "../../src/pi/viewer/tui/branding";

const theme = { fg: (_slot: string, text: string) => text };

describe("TUI branding", () => {
  it("renders one Unicode mark without terminal probing", () => {
    const mark = renderMark(theme, 10);
    expect(mark).toContain(MARK_GLYPH);
    expect(mark).not.toContain("\\x1b");
    expect(visibleWidth(mark)).toBeLessThanOrEqual(10);
  });

  it("omits the mark when the viewport cannot fit it", () => {
    expect(renderMark(theme, 0)).toBe("");
  });

  it("keeps the wordmark constant", () => {
    expect(WORDMARK).toBe("weave view");
  });
});
