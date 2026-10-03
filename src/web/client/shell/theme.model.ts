/** Persistent appearance mode and switching between the selected light/dark palettes. */
import { DEFAULT_PREFERENCES, type Preferences } from "../../shared/preferences";
import { THEMES } from "../../shared/themes";
import type { PaletteChoice, ThemeChoice } from "../../shared/themes";
import type { ColorScheme } from "../graph/graph.model";
import { THEME_CHOICES, isThemeChoice } from "../../shared/themes";
export { THEME_CHOICES, isThemeChoice };
export type { ThemeChoice };

export const THEME_STORAGE_KEY = "pi-weave.theme.v1";
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The stored choice, or `null`.
 *
 * Reads are failure-absorbing (§5.1's partitioned-storage note): an
 * unresolvable storage must not break the workspace's mount. `null` — no
 * entry, unreadable storage, or a value from some other era of the key —
 * means system, which is what a fresh visitor wants anyway.
 */
export function loadTheme(storage: ThemeStorage): ThemeChoice | null {
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the choice. Reports failure as `false`. */
export function saveTheme(storage: ThemeStorage, choice: ThemeChoice): boolean {
  try {
    storage.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

type ThemePair = Pick<Preferences, "lightTheme" | "darkTheme">;

/** Toggle to the selected palette for the opposite effective appearance. */
export function toggleTheme(choice: ThemeChoice, systemScheme: ColorScheme, pair: ThemePair = DEFAULT_PREFERENCES): PaletteChoice {
  const current = THEMES[effectiveScheme(choice, systemScheme, pair)].scheme;
  return current === "light" ? pair.darkTheme : pair.lightTheme;
}

/** System mode uses the user's palette for the current device appearance. */
export function effectiveScheme(choice: ThemeChoice, systemScheme: ColorScheme, pair: ThemePair = DEFAULT_PREFERENCES): PaletteChoice {
  return choice === "system" ? (systemScheme === "light" ? pair.lightTheme : pair.darkTheme) : choice;
}

/** System mode clears the attribute so the media query governs. */
export function themeAttr(choice: ThemeChoice): PaletteChoice | null {
  return choice === "system" ? null : choice;
}

export interface ThemeButtonView {
  readonly glyph: "●" | "◐" | "○";
  readonly label: string;
  readonly hint: string;
}

function themeName(choice: ThemeChoice): string {
  return choice === "system" ? "System" : THEMES[choice].name;
}

export function themeButton(choice: ThemeChoice, systemScheme: ColorScheme = "dark", pair: ThemePair = DEFAULT_PREFERENCES): ThemeButtonView {
  return {
    glyph: choice === "system" ? "◐" : THEMES[choice].scheme === "light" ? "○" : "●",
    label: themeName(choice),
    hint: `Colour theme: ${themeName(choice)} — click for ${themeName(toggleTheme(choice, systemScheme, pair))}`,
  };
}
