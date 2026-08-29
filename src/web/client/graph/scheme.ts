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
 * `matchMedia` returns far more than a {@link SchemeList}, and naming
 * `MediaQueryList` would make the module uncompilable by the root
 * `tsconfig.json` project (no `DOM` lib), which is what a test importing it
 * runs under. The narrow shape is the same trick `viewport.ts` and
 * `cssvars.ts` use, and the real `window` satisfies it structurally.
 */
export interface SchemeHost {
  matchMedia(query: string): SchemeList;
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

// --- the live watcher ---------------------------------------------------------------

/**
 * The slice of `MediaQueryList` the watcher reads.
 *
 * Three members, so the platform's list satisfies it structurally and a fake
 * is an object literal with a listener slot.
 */
export interface SchemeList {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/**
 * Watch for an OS scheme flip, calling back with the resolved scheme.
 *
 * The stylesheet answers an OS flip on its own (the media query repaints
 * without JavaScript), but the graph cannot: sigma's palette is fixed at
 * renderer construction ("the scheme is fixed at construction" —
 * `renderer.ts`), so the shell must learn about the flip to hand the column a
 * new scheme and let it remount. This is that one listener.
 *
 * The returned `stop` removes the listener; the shell registers the watch in
 * a mount effect, so a hot reload cannot stack listeners. A host without
 * `matchMedia` gets a do-nothing cleanup — the same "legible, not throwing"
 * answer `schemeOf` gives, because a graph in a stale palette beats a
 * workspace that crashed on mount.
 *
 * A manual choice ("light" / "dark") ignores this callback entirely — the
 * shell simply does not consult the OS while overridden, and the stylesheet's
 * `:root[data-weave-theme=…]` attribute wins over the media query the same way.
 */
export function watchScheme(
  host: SchemeHost,
  onChange: (scheme: ColorScheme) => void,
): () => void {
  if (typeof host.matchMedia !== "function") return () => {};
  const list: SchemeList = host.matchMedia(LIGHT_QUERY);
  if (typeof list.addEventListener !== "function") return () => {};
  const listener = (): void => onChange(list.matches ? "light" : "dark");
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}
