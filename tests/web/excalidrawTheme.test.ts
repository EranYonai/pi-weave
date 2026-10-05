import { describe, expect, it } from "vitest";
import { excalidrawPalette } from "../../src/web/shared/excalidrawTheme";
import { ACCENTS, THEMES, accentColor } from "../../src/web/shared/themes";
import type { PaletteChoice } from "../../src/web/shared/themes";

describe("Excalidraw authoring palette", () => {
  it("uses shared surfaces, readable text and semantic strokes for every theme", () => {
    for (const theme of Object.keys(THEMES) as PaletteChoice[]) {
      const palette = excalidrawPalette(theme);
      const { colors } = THEMES[theme];
      expect(palette).toMatchObject({ canvas: colors.bg, text: colors.fg, stroke: colors.fg, annotation: colors.dim, edge: colors.dim });
      expect(palette.primary).toEqual({ fill: colors.panel, stroke: colors.accent });
      expect(palette.secondary).toEqual({ fill: colors.raise, stroke: colors.fg });
      expect(palette.group).toEqual({ fill: colors.page, stroke: colors.dim });
      for (const accent of Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]) {
        const customized = excalidrawPalette(theme, accent);
        expect(customized.primary.stroke).toBe(accentColor(theme, accent));
        expect(customized.accentNode.stroke).toBe(customized.primary.stroke);
        expect(customized.text).toBe(colors.fg);
      }
    }
  });
});
