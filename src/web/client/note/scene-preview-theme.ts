import { excalidrawPalette } from "../../shared/excalidrawTheme";
import { ACCENTS, THEMES, themeId } from "../../shared/themes";
import type { GraphTheme, PaletteChoice } from "../../shared/themes";

/** Infer roles only from a known Weave canvas and stock colors; arbitrary palettes retain their colors. */
export function previewColors(canvas: unknown, theme: GraphTheme) {
  const target = excalidrawPalette(themeId(theme), typeof theme === "string" ? "theme" : theme.accent);
  const replacements = new Map<string, string>([
    ["#000000", target.stroke], ["#1e1e1e", target.stroke], ["#ffffff", target.canvas],
  ]);
  const sourceThemes = (Object.keys(THEMES) as PaletteChoice[]).filter((id) => THEMES[id].colors.bg === (typeof canvas === "string" ? canvas.toLowerCase() : canvas));
  for (const sourceTheme of sourceThemes) {
    const source = excalidrawPalette(sourceTheme);
    for (const accent of Object.values(ACCENTS)) replacements.set(accent[source.scheme], target.primary.stroke);
    for (const [from, to] of [
      [source.canvas, target.canvas], [source.text, target.text], [source.primary.fill, target.primary.fill],
      [source.primary.stroke, target.primary.stroke], [source.secondary.fill, target.secondary.fill],
      [source.group.fill, target.group.fill], [source.annotation, target.annotation],
    ] as const) replacements.set(from, to);
  }
  return { canvas: target.canvas, color: (value: string) => replacements.get(value.toLowerCase()) ?? value };
}
