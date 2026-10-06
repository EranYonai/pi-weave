import { describe, expect, it } from "vitest";
import { previewColors } from "../../src/web/client/note/scene-preview-theme";
import { excalidrawPalette } from "../../src/web/shared/excalidrawTheme";
import { THEMES } from "../../src/web/shared/themes";
import type { PaletteChoice } from "../../src/web/shared/themes";
import { THEME_CSS } from "../../src/web/client/shell/theme";

describe("preview palette and fit", () => {
  it("maps known source roles to every active named theme and accent, retaining custom semantic colors", () => {
    const source = excalidrawPalette("paper-blue");
    for (const theme of Object.keys(THEMES) as PaletteChoice[]) {
      const target = excalidrawPalette(theme, "rose");
      const preview = previewColors(source.canvas, { theme, accent: "rose" });
      expect(preview.canvas).toBe(target.canvas);
      expect(preview.color(source.text)).toBe(target.text);
      expect(preview.color(source.primary.fill)).toBe(target.primary.fill);
      expect(preview.color(source.primary.stroke)).toBe(target.primary.stroke);
      expect(preview.color(source.secondary.fill)).toBe(target.secondary.fill);
      expect(preview.color(source.group.fill)).toBe(target.group.fill);
      expect(preview.color(source.annotation)).toBe(target.annotation);
      expect(preview.color("#ef1234")).toBe("#ef1234");
      expect(preview.color("transparent")).toBe("transparent");
    }
  });
  it("recognizes named accent variants sharing the same surface palette", () => {
    for (const theme of ["latte-blue", "macchiato-peach"] as const) {
      const source = excalidrawPalette(theme);
      const preview = previewColors(source.canvas, "forest-teal");
      expect(preview.color(source.primary.stroke)).toBe(excalidrawPalette("forest-teal").primary.stroke);
    }
  });
  it("recognizes uppercase canvas colors and authored accent overrides", () => {
    const source = excalidrawPalette("paper-blue", "teal");
    const preview = previewColors(source.canvas.toUpperCase(), { theme: "dark", accent: "rose" });
    expect(preview.color(source.text.toUpperCase())).toBe(THEMES.dark.colors.fg);
    expect(preview.color(source.primary.stroke)).toBe(excalidrawPalette("dark", "rose").primary.stroke);
    expect(preview.color("#ef1234")).toBe("#ef1234");
  });
  it("adapts stock neutrals while preserving custom palettes", () => {
    const preview = previewColors("#ef1234", "dark");
    expect(preview.color("#FFFFFF")).toBe(THEMES.dark.colors.bg);
    expect(preview.color("#000000")).toBe(THEMES.dark.colors.fg);
    expect(preview.color("#1e1e1e")).toBe(THEMES.dark.colors.fg);
    expect(preview.color("#174ea6")).toBe("#174ea6");
  });
  it("shares the reading column and animates dimensions with reduced motion support", () => {
    expect(THEME_CSS).toContain("max-width:var(--weave-reading-width,760px)");
    expect(THEME_CSS).toContain("transition:width 180ms ease,height 180ms ease");
    expect(THEME_CSS).toContain("max-height:min(60vh,640px)");
  });
});
