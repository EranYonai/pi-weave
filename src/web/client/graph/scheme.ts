/**
 * Reading `prefers-color-scheme` (weave-workspace §7.4).
 *
 * WebGL cannot read a CSS custom property: sigma needs a concrete `#rrggbb`
 * per node, so unlike every other column the graph has to know which palette
 * the user is in rather than leaving it to the stylesheet. That is one media
 * query, and it is here rather than inline in a component for §10's reason —
 * a `matchMedia` call in a `.tsx` is a line no test can reach.
 *
 * The default is **dark**, matching `shell/theme.ts` (which is dark-first with
 * a `prefers-color-scheme: light` override) rather than `page.ts`'s
 * light-first pre-paint block. §15.1 records that disagreement as known debt;
 * this file follows the sheet the user actually ends up looking at.
 */

import type { ColorScheme } from "./graph.model";

/**
 * The slice of `window` this module reads.
 *
 * `matchMedia` returns far more than `matches`, and naming `MediaQueryList`
 * would make the module uncompilable by the root `tsconfig.json` project (no
 * `DOM` lib), which is what a test importing it runs under. The narrow shape
 * is the same trick `viewport.ts` and `cssvars.ts` use, and the real `window`
 * satisfies it structurally.
 */
export interface SchemeHost {
  matchMedia(query: string): { readonly matches: boolean };
}

/** The query. Light is the exception; see the module header. */
export const LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * Which palette to draw in.
 *
 * A host without `matchMedia` — an old embedding, a partial test double —
 * gets dark rather than an exception. A graph in the wrong palette is legible;
 * a graph that threw at mount is not.
 */
export function schemeOf(host: SchemeHost | null | undefined): ColorScheme {
  if (host === null || host === undefined || typeof host.matchMedia !== "function") return "dark";
  return host.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}
