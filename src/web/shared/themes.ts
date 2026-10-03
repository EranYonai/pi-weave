/** Theme candidates. Catppuccin colors: https://github.com/catppuccin/palette (MIT).
 * Latte colors are deepened and Frappé red lifted for contrast on raised controls.
 * `light` and `dark` keep existing saved choices compatible.
 */
const latte = {
  bg: "#eff1f5", panel: "#e6e9ef", page: "#dce0e8", raise: "#ccd0da",
  fg: "#4c4f69", dim: "#56586a", faint: "#606274", line: "#ccd0da", "line-strong": "#bcc0cc",
  accent: "#7113ec", ok: "#28641b", warn: "#7c4f10", bad: "#b20d30",
};
const macchiato = {
  bg: "#24273a", panel: "#1e2030", page: "#181926", raise: "#363a4f",
  fg: "#cad3f5", dim: "#a5adcb", faint: "#939ab7", line: "#363a4f", "line-strong": "#494d64",
  accent: "#c6a0f6", ok: "#a6da95", warn: "#eed49f", bad: "#ed8796",
};

/** One table drives CSS, WebGL and the appearance theme choices. */
export const THEMES = {
  light: { name: "Catppuccin Latte · Mauve", scheme: "light", colors: latte },
  "latte-blue": { name: "Catppuccin Latte · Blue", scheme: "light", colors: { ...latte, accent: "#1750bf" } },
  "frappe-teal": { name: "Catppuccin Frappé · Teal", scheme: "dark", colors: {
    bg: "#303446", panel: "#292c3c", page: "#232634", raise: "#414559",
    fg: "#c6d0f5", dim: "#b5bfe2", faint: "#a5adce", line: "#414559", "line-strong": "#51576d",
    accent: "#81c8be", ok: "#a6d189", warn: "#e5c890", bad: "#f4a4a6",
  } },
  dark: { name: "Catppuccin Macchiato · Mauve", scheme: "dark", colors: macchiato },
  "macchiato-peach": { name: "Catppuccin Macchiato · Peach", scheme: "dark", colors: { ...macchiato, accent: "#f5a97f" } },
  "mocha-lavender": { name: "Catppuccin Mocha · Lavender", scheme: "dark", colors: {
    bg: "#1e1e2e", panel: "#181825", page: "#11111b", raise: "#313244",
    fg: "#cdd6f4", dim: "#a6adc8", faint: "#9399b2", line: "#313244", "line-strong": "#45475a",
    accent: "#b4befe", ok: "#a6e3a1", warn: "#f9e2af", bad: "#f38ba8",
  } },
  "paper-blue": { name: "Paper · Blue", scheme: "light", colors: {
    bg: "#f4f6f8", panel: "#e9edf2", page: "#ffffff", raise: "#dce3eb",
    fg: "#182334", dim: "#42536a", faint: "#526176", line: "#dce3eb", "line-strong": "#bac6d4",
    accent: "#174ea6", ok: "#21623b", warn: "#805300", bad: "#a3223c",
  } },
  "ink-blue": { name: "Ink · Blue", scheme: "dark", colors: {
    bg: "#1b2430", panel: "#141c27", page: "#101720", raise: "#2b3748",
    fg: "#edf2f8", dim: "#becadc", faint: "#a5b5cb", line: "#2b3748", "line-strong": "#46566d",
    accent: "#8bbcff", ok: "#91d5a5", warn: "#edc47b", bad: "#ff9fae",
  } },
  "sand-amber": { name: "Sand · Amber", scheme: "light", colors: {
    bg: "#f7f3ec", panel: "#ede6da", page: "#fffdf8", raise: "#e2d8c8",
    fg: "#30291f", dim: "#5b4e3f", faint: "#675847", line: "#e2d8c8", "line-strong": "#c7b8a2",
    accent: "#814500", ok: "#365c2a", warn: "#795000", bad: "#a12c32",
  } },
  "ember-amber": { name: "Ember · Amber", scheme: "dark", colors: {
    bg: "#29231f", panel: "#211c19", page: "#191512", raise: "#3c322b",
    fg: "#f3e9dc", dim: "#d0bfab", faint: "#bfa991", line: "#3c322b", "line-strong": "#5c4d40",
    accent: "#edb96b", ok: "#b5cf8a", warn: "#efc57a", bad: "#f69a91",
  } },
  "mist-teal": { name: "Mist · Teal", scheme: "light", colors: {
    bg: "#eff5f3", panel: "#e1ece8", page: "#fafffd", raise: "#d2e2dc",
    fg: "#18342e", dim: "#3c5b52", faint: "#48655b", line: "#d2e2dc", "line-strong": "#acc5bc",
    accent: "#006457", ok: "#2a5e35", warn: "#795300", bad: "#a52a43",
  } },
  "forest-teal": { name: "Forest · Teal", scheme: "dark", colors: {
    bg: "#1c2b27", panel: "#16221e", page: "#101b17", raise: "#2b4038",
    fg: "#e6f2ec", dim: "#b8d0c4", faint: "#a2bfb0", line: "#2b4038", "line-strong": "#456255",
    accent: "#7cd8bb", ok: "#a5d6a0", warn: "#e6c582", bad: "#f5a2ac",
  } },
} as const;

export type PaletteChoice = keyof typeof THEMES;
export type ThemeChoice = "system" | PaletteChoice;
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", ...Object.keys(THEMES) as PaletteChoice[]];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && THEME_CHOICES.includes(value as ThemeChoice);
}

/** Accent selection is independent of the theme's surface palette. */
export const ACCENTS = {
  mauve: { name: "Mauve", light: "#7113ec", dark: "#cba9f8" },
  blue: { name: "Blue", light: "#1750bf", dark: "#8bbcff" },
  teal: { name: "Teal", light: "#006457", dark: "#7cd8bb" },
  peach: { name: "Peach", light: "#814500", dark: "#f5a97f" },
  rose: { name: "Rose", light: "#a52a43", dark: "#f4a4a6" },
  green: { name: "Green", light: "#28641b", dark: "#a6da95" },
  amber: { name: "Amber", light: "#775000", dark: "#edb96b" },
  lavender: { name: "Lavender", light: "#445198", dark: "#b4befe" },
} as const;
export type AccentChoice = "theme" | keyof typeof ACCENTS;
export type GraphTheme = PaletteChoice | { theme: PaletteChoice; accent: AccentChoice };

export function themeId(theme: GraphTheme): PaletteChoice {
  return typeof theme === "string" ? theme : theme.theme;
}

export function accentColor(theme: PaletteChoice, accent: AccentChoice): string {
  return accent === "theme" ? THEMES[theme].colors.accent : ACCENTS[accent][THEMES[theme].scheme];
}
