import { THEMES, accentColor } from "./themes";
import type { AccentChoice, PaletteChoice } from "./themes";

/** Authoring defaults only: saved scenes retain explicit portable colors. */
export function excalidrawPalette(theme: PaletteChoice, accent: AccentChoice = "theme") {
  const { colors, scheme } = THEMES[theme];
  return {
    theme, accent, scheme,
    canvas: colors.bg,
    text: colors.fg,
    stroke: colors.fg,
    primary: { fill: colors.panel, stroke: accentColor(theme, accent) },
    secondary: { fill: colors.raise, stroke: colors.fg },
    accentNode: { fill: colors.panel, stroke: accentColor(theme, accent) },
    group: { fill: colors.page, stroke: colors.dim },
    annotation: colors.dim,
    edge: colors.dim,
  };
}
