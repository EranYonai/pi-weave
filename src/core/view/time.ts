/**
 * Time formatting for the portable view-models (weave-workspace §3).
 */

import type { TreeMeta } from "./types";

/** Relative human time, mirroring the page's `relTime`. `now` is epoch ms. */
export function relTime(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Short-sha length used when abbreviating a commit for display. */
const SHORT_SHA_LEN = 7;

/**
 * Render a `TreeMeta` as a single plain-text annotation.
 *
 * This reproduces the strings the TUI printed when `TreeRow.meta` was itself a
 * string, so terminal output is unchanged by the structuring. Richer renderers
 * (the browser workspace) should switch on the union instead of calling this.
 */
export function formatTreeMeta(meta: TreeMeta, now: number): string {
  if (meta === null) return "";
  switch (meta.kind) {
    case "relTime":
      return relTime(meta.iso, now);
    case "count":
      return meta.phrasing === "attribute" ? `${meta.unit}=${meta.n}` : `${meta.n} ${meta.unit}`;
    case "commit":
      return meta.sha.slice(0, SHORT_SHA_LEN);
    case "text":
      return meta.text;
  }
}
