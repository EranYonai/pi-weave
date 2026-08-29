/**
 * The inline icon sprite (Tier 6, §8 P6.4).
 *
 * ## Why a sprite of path data
 *
 * The tree drew its twisties and kind marks as text — `▸ ▾ ◧ ▣ ◈ · ▷` — and
 * every one of those characters came from a *different font*: the geometric
 * shapes from one fallback, the arrows from another, and the `·` from
 * wherever the platform's monospace put it. Same column, three stroke
 * weights, and nothing on the sheet could reconcile them, because a font's
 * stroke weight is not a CSS property.
 *
 * So the marks become SVG, and the sprite is deliberately the smallest thing
 * that can carry them: a 16×16 box, 1.5px strokes, `currentColor`, and **path
 * data only** — no wrapper XML, no `<symbol>`/`<use>` table, no external
 * reference of any kind. Two CSP facts decided that:
 *
 *  1. `<use href="…">` and icon fonts fetch — `img-src`/`font-src` territory
 *     the policy does not grant, and `url()` anywhere in the sheet or the
 *     bundle is a failing gate (see `client-theme.test.ts`).
 *  2. `dangerouslySetInnerHTML` with a constant we own *is* CSP-legal — no
 *     `script-src` hook fires on it, which is how the note body already
 *     renders — but an innerHTML string invites a whole `<svg>` per row,
 *     wrapper and all. Preact can build the same element from path data with
 *     a spread, so the sprite stays at the `d` strings and nothing else.
 *
 * ## Why the renderer is not here
 *
 * §10: this module decides (which glyphs exist, which are filled, how fat a
 * dot is), and the `.tsx` renders (`<svg>` JSX from {@link IconDef}). That
 * also keeps this file free of JSX and DOM types, so the root `tsconfig.json`
 * project compiles its tests.
 */

/** Every icon the sprite carries. Exhaustive by construction — a new icon is a new key or it does not exist. */
export type IconName =
  | "chevron"
  | "vault"
  | "note"
  | "repository"
  | "module"
  | "package"
  | "entryPoint"
  | "gitState"
  | "external"
  | "file"
  | "session";

/** The box every path is drawn in, and the stroke the sheet's aesthetic asks for. */
export const ICON_BOX = 16;
export const ICON_STROKE = 1.5;

/** The `d`-only description of one glyph. */
export interface IconDef {
  /**
   * One or more subpaths. Multiple paths only where a shape has genuinely
   * separate strokes (a fold, a seam): the renderer maps them, so an icon
   * never has to fake a joint with an overlay.
   */
  readonly d: readonly [string, ...string[]];
  /**
   * Filled rather than stroked — used only where the TUI's vocabulary makes
   * solid meaningful: `vault` ◆ against `gitState` ◇ is a filled/hollow pair,
   * and losing it would erase the one distinction those two roots carry.
   */
  readonly filled: boolean;
  /** Stroke-width override; unset means {@link ICON_STROKE}. */
  readonly width?: number;
}

/**
 * The sprite.
 *
 * Written by hand against the 16-box grid; each path is commented with what
 * it draws. Budget note: these eleven strings are ~700 bytes, against the
 * ~1 KiB the plan set aside for the whole sprite.
 */
export const ICONS: Readonly<Record<IconName, IconDef>> = {
  /** The twisty / group chevron, pointing right; CSS rotates it 90° when open. */
  chevron: { d: ["M5.75 4.25 9.5 8l-3.75 3.75"], filled: false },
  /** The vault root, solid — the TUI's ◆. */
  vault: { d: ["M8 2.6 13.4 8 8 13.4 2.6 8Z"], filled: true },
  /** A note page with a folded corner — the vault's contents. */
  note: { d: ["M4.5 2.75h4.75l2.25 2.25v8.25h-7Z", "M9.25 2.75V5h2.25"], filled: false },
  /** A session memory page: a rounded speech bubble with a tail. */
  session: { d: ["M3 3.75h10v6.5H6.75L3.75 13v-2.75H3Z"], filled: false },
  /** The repository root, a framed card with a header rule — the TUI's ▣. */
  repository: { d: ["M2.75 4.25h10.5v7.5H2.75Z", "M2.75 6.75h10.5"], filled: false },
  /** A folder — the tree's module / synthesized vault directory. */
  module: { d: ["M2.75 4.25h4l1.5 1.75h5v5.75h-10.5Z"], filled: false },
  /** A package: a sealed box with its tape. */
  package: { d: ["M8 2.5 13.25 5v6L8 13.5 2.75 11V5Z", "M2.75 5 8 7.5 13.25 5", "M8 7.5v6"], filled: false },
  /** An entry point, solid — the TUI's ▷. */
  entryPoint: { d: ["M5.75 3.75v8.5L12.75 8Z"], filled: true },
  /** Git state, hollow against the vault's solid diamond — the TUI's ◇. */
  gitState: { d: ["M8 2.85 13.15 8 8 13.15 2.85 8Z"], filled: false },
  /** An external resource, leaving the frame. */
  external: { d: ["M4.5 11.5l7-7", "M6.75 4.5h4.75v4.75"], filled: false },
  /** A plain repo file, an unfolded page. */
  file: { d: ["M4.5 2.75h7v10.5h-7Z"], filled: false },
};