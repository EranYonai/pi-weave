/**
 * The theme *choice* — what the user picked, and what that makes the screen
 * do (weave-workspace §1.2).
 *
 * The stylesheet decides what the palettes are (`theme.ts`); this module
 * decides *which one is showing*. The two are separate for §10's reason: the
 * choice is state a user controls, so every decision about it has to be a
 * testable pure function, while the `.tsx` that applies the attribute is
 * three lines no test can reach.
 *
 * ## Why tri-state
 *
 * "Dark" and "light" alone are not enough: stripping a user of "follow my OS"
 * is a regression the moment anyone prefers the *default* behaviour rather
 * than either specific scheme. The cycle is `system → light → dark → system`
 * so the control is one button, never a menu — a popover in a 34 px header is
 * a second focusable thing to reach, and the setting is not worth one.
 *
 * ## The attribute, not a class, not inline styles
 *
 * The sheet's light branch moves from the bare `prefers-color-scheme` media
 * query to a *pair* of selectors: `:root[data-weave-theme="light"]` (the
 * override) plus the media query narrowed by
 * `:root:not([data-weave-theme="dark"])` (system default). The attribute is
 * written on `<html>` because CSP `style-src 'nonce-…'` blocks inline
 * `style=""` attributes outright — the same verified reasoning that pushes
 * `cssvars.ts` through the CSSOM — while `data-*` attribute writes are not
 * style at all and need no exception. In `system` mode the attribute is
 * **cleared**, not set to a third value, so the media query keeps answering
 * a live OS flip without the client listening.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`. Storage arrives as the two-method port
 * `selection.storage.ts` uses, so a fake is an object literal and quota
 * failures stay the caller's problem — a theme the user could not persist is
 * the same cosmetic cost as a selection.
 */

import type { ColorScheme } from "../graph/graph.model";

/** What the user picked, as the button cycles it. */
export type ThemeChoice = "system" | "light" | "dark";

/** The choices in cycle order. */
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

/** The `localStorage` key. Namespaced and versioned, like the layout's. */
export const THEME_STORAGE_KEY = "pi-weave.theme.v1";

/** The slice of `Storage` this module needs. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Structural guard, mirroring `readBootstrap`'s. */
export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
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

/** Persist the choice. Reports failure as `false`, like `saveSelection`. */
export function saveTheme(storage: ThemeStorage, choice: ThemeChoice): boolean {
  try {
    storage.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/** The next choice in the cycle {@link THEME_CHOICES}. */
export function cycleTheme(choice: ThemeChoice): ThemeChoice {
  const index = THEME_CHOICES.indexOf(choice);
  // An out-of-table choice cannot exist (the type says so), but a miss
  // here must not be an `undefined` into the UI: wrap to the head.
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length] ?? "system";
}

/**
 * The scheme actually drawing right now.
 *
 * This is the *whole* resolution: the sheet owns what colours a scheme is,
 * `scheme.ts` owns reading the OS once, and this owns the decision — so the
 * graph column, whose WebGL palette cannot read CSS custom properties, takes
 * the same answer the stylesheet's attribute takes.
 */
export function effectiveScheme(choice: ThemeChoice, systemScheme: ColorScheme): ColorScheme {
  return choice === "system" ? systemScheme : choice;
}

/**
 * The `data-weave-theme` attribute value, or `null` to clear it.
 *
 * `null` is not a third value on purpose: in `system` mode the media query
 * alone must govern, and any attribute would override the OS. See the module
 * header's "attribute, not class" note.
 */
export function themeAttr(choice: ThemeChoice): "light" | "dark" | null {
  return choice === "system" ? null : choice;
}

// --- the control's view ------------------------------------------------------------

/**
 * The header button's face.
 *
 * The glyphs are the provenance language the tree already teaches
 * (`tree.model.ts`): filled, half and hollow of one shape. Filled `●` is
 * dark, hollower `◐` is system — half machine, half choice — and `○` is
 * light. Three glyphs, one family, no icon font, no `url()`.
 */
export interface ThemeButtonView {
  readonly glyph: "●" | "◐" | "○";
  /** The `title=`/`aria-label`. Names where it is *and* what clicking does. */
  readonly hint: string;
}

const THEME_GLYPHS: Readonly<Record<ThemeChoice, ThemeButtonView["glyph"]>> = {
  dark: "●",
  system: "◐",
  light: "○",
};

export function themeButton(choice: ThemeChoice): ThemeButtonView {
  return {
    glyph: THEME_GLYPHS[choice],
    hint: `Colour theme: ${choice} — click for ${cycleTheme(choice)}`,
  };
}