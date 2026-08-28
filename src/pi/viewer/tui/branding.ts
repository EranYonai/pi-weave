/**
 * branding.ts — weave-view TUI logo & wordmark tiers (weave-view-tui-v2 §5).
 *
 * Renders the brand as a small, casual in-bar mark. Three tiers, auto-selected
 * once per session from terminal capability and cached:
 *
 *   1. "kitty"   — the real raster logo via pi-tui's `Image` component (a small
 *                  ~2×2-cell favicon). The raw JPG is bundled and base64'd once.
 *   2. "glyph"   — a tiny curated Unicode glyph derived from the logo silhouette.
 *   3. "plain"   — `🕸️` + wordmark, forced by PI_WEAVE_TUI_PLAIN.
 *
 * The line-art/unicode constants contain no ESC by construction (decision 1:
 * the representation fallback is a curated constant, never generated at runtime).
 */

import { detectCapabilities, getCapabilities, Image, type Component } from "@earendil-works/pi-tui";
import type { ThemeSlot } from "./theme";

/** Logo render tier. */
export type LogoTier = "kitty" | "glyph" | "plain";

/** A tiny Unicode mark derived from the logo silhouette (decision 1 fallback). */
export const MARK_GLYPH = "◈";
/** Absolute last-resort mark (also the forced plain tier). */
export const PLAIN_MARK = "🕸️";
/** The wordmark shown after the mark. */
export const WORDMARK = "weave view";

/** Env var that forces the plain tier. */
export const PLAIN_ENV = "PI_WEAVE_TUI_PLAIN";

/** MIME of the bundled raster logo asset (downscaled transparent PNG of the logo). */
export const LOGO_MIME = "image/png";

/**
 * Bundled downscaled raster copy of `docs/pi-weave-logo.png` (the transparent-
 * background spider, 32×32, ~1.7 KB). Decision 1 (§15): ship a small raster copy
 * and embed it via pi-tui's `Image`
 * (Kitty graphics) as a small ~2×2-cell favicon in the header strip — a casual
 * in-bar mark, not a hero splash. Stored base64 so the render path needs no
 * fs/path resolution and the asset is trivially unit-testable.
 */
export const LOGO_B64 =
  "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";

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
 * Takes the base64 JPG + mime; renders at ~2×2 cells. Returns a component that
 * emits the Kitty sequence when the terminal supports it, else a text fallback.
 */
export function logoImage(
  base64Data: string,
  mimeType: string,
  theme: { fg: (slot: ThemeSlot, text: string) => string },
): Component {
  return new Image(base64Data, mimeType, { fallbackColor: (t) => theme.fg("text", t) }, {
    maxWidthCells: 2,
    maxHeightCells: 2,
  });
}

/**
 * Build the bundled kitty raster logo `Image` (decision 1 favicon). Returns a
 * component only when the terminal supports the Kitty graphics protocol;
 * `null` otherwise so the caller keeps the one-line glyph header. The render
 * path splices this component's lines onto their own row(s) — never inlined
 * into a styled text line. The base64 asset is a compile-time constant, so the
 * only fallback needed is the Kitty gate (no fs/path reads at runtime).
 */
export function bundledLogoImage(
  theme: { fg: (slot: ThemeSlot, text: string) => string },
): Component | null {
  if (getCapabilities().images === "kitty") return logoImage(LOGO_B64, LOGO_MIME, theme);
  return null;
}
