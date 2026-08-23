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

import { detectCapabilities, getCapabilities, Image, type Component } from "@earendil-works/pi-tui";
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

/** MIME of the bundled raster logo asset (downscaled JPEG of the logo). */
export const LOGO_MIME = "image/jpeg";

/**
 * Bundled downscaled raster copy of `docs/pi-weave-logo.jpg` (32×32, ~1.3 KB).
 * Decision 1 (§15): ship a small raster copy and embed it via pi-tui's `Image`
 * (Kitty graphics) as a small ~2×2-cell favicon in the header strip — a casual
 * in-bar mark, not a hero splash. Stored base64 so the render path needs no
 * fs/path resolution and the asset is trivially unit-testable.
 */
export const LOGO_B64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QDORXhpZgAATU0AKgAAAAgABgESAAMAAAABAAEAAAEaAAUAAAABAAAAVgEbAAUAAAABAAAAXgEoAAMAAAABAAIAAAExAAIAAAAVAAAAZodpAAQAAAABAAAAfAAAAAAAAABIAAAAAQAAAEgAAAABUGl4ZWxtYXRvciBQcm8gMi4xLjMAAAAEkAQAAgAAABQAAACyoAEAAwAAAAEAAQAAoAIABAAAAAEAAAAgoAMABAAAAAEAAAAgAAAAADIwMjY6MDg6MjIgMTk6NTY6MjIA/+0AZFBob3Rvc2hvcCAzLjAAOEJJTQQEAAAAAAAsHAFaAAMbJUccAgAAAgACHAI+AAgyMDI2MDgyMhwCPwALMTk1NjIyKzAwMDA4QklNBCUAAAAAABBB7D4+CxrdyaRylkhoEmIW/8AAEQgAIAAgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAv/aAAwDAQACEQMRAD8A/E8Lk4rQsocXcD46SIf/AB4VDbpvYDua95+HfhtZtHn8QpBbXEdvKyM00iKW2RtKY4Vcjc+xGY45wAByQD62FwzqO17Luc0pWPC7yHNzM2Orsf1NUGXBxXu/xH8O/Y7Cy114baCG9m8oNBIrbCYlmCTKmdr7JEbHJwcH5gQPEZ02sR6UsThnTdr3XcIyuf/Q/GHT/JkcQzbQpO7Lccjtn3r0Dwv/AG1fMdH0e+e1e+kRTaEM4uZwTtBXhSRk7c8YOO/PlwJByK14dZvI7dbXcDEpJAKjv79ccetezQxfLHlZw1acn8L1PTPE+nanZpb2Wr6i99JBkw2gV4xbzSk8KuGA3BckgYKjGQMVzPjG70+ygh8LaXFZSQWshuGurdd8kkkqDKGY5YqgABUfKH3ECsW48U6vcWs1k02IbjbvUKBnb0AOMgdsA4xxXOE55oxGJ5lZDjRVk5atH//Z";

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
