/**
 * branding.ts — weave-view TUI logo & wordmark tiers (weave-view-tui-v2 §5).
 *
 * Renders the brand as a small, casual in-bar mark. Three tiers, auto-selected
 * once per session from terminal capability and cached:
 *
 *   1. "kitty"   — the real raster logo via pi-tui's `Image` component (a small
 *                  ~2×2-cell favicon). The raw JPG is bundled and base64'd once.
 *   2. "glyph"   — a tiny curated Unicode glyph derived from the logo silhouette.
 *   3. "plain"   — `🧵` + wordmark, forced by PI_WEAVE_TUI_PLAIN.
 *
 * The line-art/unicode constants contain no ESC by construction (decision 1:
 * the representation fallback is a curated constant, never generated at runtime).
 */

import { detectCapabilities, Image, type Component } from "@earendil-works/pi-tui";
import type { ThemeSlot } from "./theme";

/** Logo render tier. */
export type LogoTier = "kitty" | "glyph" | "plain";

/** A tiny Unicode mark derived from the logo silhouette (decision 1 fallback). */
export const MARK_GLYPH = "◈";
/** Absolute last-resort mark (also the forced plain tier). */
export const PLAIN_MARK = "🧵";
/** The wordmark shown after the mark. */
export const WORDMARK = "weave view";

/** Env var that forces the plain tier. */
export const PLAIN_ENV = "PI_WEAVE_TUI_PLAIN";

/** Terminal capability surface branding probes. */
export interface BrandCapabilities {
  /** Kitty graphics protocol available. */
  kitty: boolean;
}

/** Pure tier selection; exported for direct unit testing. */
export function logoTierFor(caps: BrandCapabilities, forcePlain: boolean): LogoTier {
  if (forcePlain) return "plain";
  if (caps.kitty) return "kitty";
  return "glyph";
}

/**
 * Resolve the environment (PI_WEAVE_TUI_PLAIN) to a plain flag. Exported as a
 * small pure function so the env read is testable in isolation.
 */
export function plainEnv(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[PLAIN_ENV];
  return v !== undefined && v !== "" && v !== "0";
}

// Session-level probe cache (probed once, reused for the whole session §5.1).
let cachedTier: LogoTier | null = null;
let cachedCaps: BrandCapabilities | null = null;

/**
 * Return the session-cached capabilities (probed once). The probe runs at most
 * once per process; subsequent calls reuse the cache. `getCaps` is injectable
 * for tests (defaults to a live kitty probe). Never throws.
 */
export function probeGraphics(getCaps: () => BrandCapabilities): BrandCapabilities {
  if (cachedCaps) return cachedCaps;
  try {
    cachedCaps = getCaps();
  } catch {
    cachedCaps = { kitty: false };
  }
  return cachedCaps;
}

/**
 * Resolve the session logo tier, probing terminal capability once and caching
 * for the process. `env` is injectable for tests.
 */
export function logoTier(env: Record<string, string | undefined> = process.env): LogoTier {
  if (cachedTier) return cachedTier;
  const caps = probeGraphics(() => getBrandCapabilities());
  cachedTier = logoTierFor(caps, plainEnv(env));
  return cachedTier;
}

/** Reset the session probe cache (test seam). */
export function resetBrandCache(): void {
  cachedTier = null;
  cachedCaps = null;
}

/** A live kitty-capability probe backed by pi-tui's terminal capability query. */
export function getBrandCapabilities(): BrandCapabilities {
  return { kitty: detectCapabilities().images === "kitty" };
}

/**
 * The mark rendered as a single header line (≤ width). This is the string the
 * header strip / empty state embed. For the kitty tier the mark glyph is used
 * in the text strip; the real raster is emitted via `logoImage()` when a kitty
 * surface is available.
 */
export function renderMark(tier: LogoTier, theme: { fg: (slot: ThemeSlot, text: string) => string }, width: number): string {
  let mark: string;
  if (tier === "plain") {
    mark = theme.fg("muted", PLAIN_MARK);
  } else {
    // kitty and glyph tiers share the curated glyph in the text strip.
    mark = theme.fg("accent", MARK_GLYPH);
  }
  return mark.slice(0, Math.max(1, width));
}

/**
 * A small pi-tui `Image` component for the kitty tier (decision 1 favicon).
 * Takes the base64 JPG + mime; renders at ~2×2 cells. `null` when not kitty.
 */
export function logoImage(
  base64Data: string,
  mimeType: string,
  theme: { fg: (slot: string, text: string) => string },
): Component | null {
  return new Image(base64Data, mimeType, { fallbackColor: (t) => theme.fg("text", t) }, {
    maxWidthCells: 2,
    maxHeightCells: 2,
  });
}
