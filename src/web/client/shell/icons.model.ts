/**
 * The inline icon sprite (Tier 6,  P6.4).
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
 * : this module decides (which glyphs exist, which are filled, how fat a
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
  // Workspace chrome (the ribbon, tabs, the edit bar and the Context card).
  | "sidebar"
  | "graph"
  | "noteGraph"
  | "search"
  | "context"
  | "refresh"
  | "settings"
  | "sun"
  | "moon"
  | "system"
  | "history"
  | "edit"
  | "check"
  | "heading"
  | "bold"
  | "italic"
  | "link"
  | "wikilink"
  | "task"
  | "pin"
  | "close"
  | "folder";

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
  /** A window with its left panel ruled off: the notes sidebar. */
  sidebar: { d: ["M2.75 3.25h10.5v9.5H2.75Z", "M6.25 3.25v9.5"], filled: false },
  /** Three linked nodes: the graph view. */
  graph: { d: ["M5.5 4a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0Z", "M13.5 5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0Z", "M8.5 12a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0Z", "M5.5 4.3 10.5 4.8M4.6 5.4l1.9 5.2M11.3 6.3 8.3 10.8"], filled: false },
  /** A framed node: the current note's own graph. */
  noteGraph: { d: ["M3.25 2.75h9.5v10.5h-9.5Z", "M10.5 8a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0Z"], filled: false },
  /** A lens. */
  search: { d: ["M11 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0Z", "m10 10 3.5 3.5"], filled: false },
  /** A window with its right panel ruled off: Context. */
  context: { d: ["M2.75 3.25h10.5v9.5H2.75Z", "M9.75 3.25v9.5"], filled: false },
  /** An open loop with its arrowhead. */
  refresh: { d: ["M13 8a5 5 0 1 1-1.5-3.55", "M13 2.75V5.5h-2.75"], filled: false },
  /** A hub with eight spokes. */
  settings: { d: ["M10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0Z", "M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"], filled: false },
  /** A light theme. */
  sun: { d: ["M10.5 8a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0Z", "M8 1.75V3M8 13v1.25M1.75 8H3M13 8h1.25M3.6 3.6l.9.9M11.5 11.5l.9.9M3.6 12.4l.9-.9M11.5 4.5l.9-.9"], filled: false },
  /** A dark theme. */
  moon: { d: ["M13 9.75A5.25 5.25 0 0 1 6.25 3a5.25 5.25 0 1 0 6.75 6.75Z"], filled: false },
  /** Follow the system: a circle split down the middle. */
  system: { d: ["M13.25 8a5.25 5.25 0 1 1-10.5 0a5.25 5.25 0 1 1 10.5 0Z", "M8 2.75v10.5"], filled: false },
  /** A clock face: the note's history. */
  history: { d: ["M13.25 8a5.25 5.25 0 1 1-10.5 0a5.25 5.25 0 1 1 10.5 0Z", "M8 5v3l2 1.5"], filled: false },
  /** A pencil. */
  edit: { d: ["M10.75 2.75 13.25 5.25 6 12.5H3.5V10Z", "M9.25 4.25l2.5 2.5"], filled: false },
  /** A tick. */
  check: { d: ["m3.25 8.5 3 3 6.5-6.75"], filled: false },
  /** A heading mark. */
  heading: { d: ["M4 3v10M12 3v10M4 8h8"], filled: false },
  /** Bold. */
  bold: { d: ["M4.5 3h4a2.5 2.5 0 0 1 0 5h-4Z", "M4.5 8h4.75a2.5 2.5 0 0 1 0 5H4.5Z"], filled: false },
  /** Italic. */
  italic: { d: ["M7 3h5M4 13h5M10 3 6 13"], filled: false },
  /** Two chain links. */
  link: { d: ["M6.75 9.25l2.5-2.5", "M7.25 4.75 8.5 3.5a2.5 2.5 0 0 1 3.5 3.5l-1.25 1.25", "M8.75 11.25 7.5 12.5a2.5 2.5 0 0 1-3.5-3.5l1.25-1.25"], filled: false },
  /** Square brackets: a [[wikilink]]. */
  wikilink: { d: ["M5.5 3H3.5v10h2", "M10.5 3h2v10h-2"], filled: false },
  /** A ticked box: a task line. */
  task: { d: ["M3 3h10v10H3Z", "m5.5 8 1.75 1.75L10.75 6.25"], filled: false },
  /** A pushpin: dock the Context card. */
  pin: { d: ["M6 2.75h4l-.5 4 2 2v1h-7v-1l2-2Z", "M8 9.75v3.5"], filled: false },
  /** A cross. */
  close: { d: ["m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5"], filled: false },
  /** A folder tab, for the crumb above a note's title. */
  folder: { d: ["M2.75 4.25h3.5l1.25 1.5h5.75v6.5H2.75Z"], filled: false },
};
