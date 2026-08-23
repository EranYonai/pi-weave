import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MARK_GLYPH,
  PLAIN_ENV,
  PLAIN_MARK,
  WORDMARK,
  getBrandCapabilities,
  logoImage,
  logoTier,
  logoTierFor,
  plainEnv,
  probeGraphics,
  renderMark,
  resetBrandCache,
  type LogoTier,
} from "../../src/pi/viewer/tui/branding";
import { visibleWidth } from "@earendil-works/pi-tui";

function theme() {
  return { fg: (_slot: string, t: string) => t };
}

afterEach(() => {
  resetBrandCache();
  vi.restoreAllMocks();
});

describe("logoTierFor", () => {
  it("prefers kitty, falls back to glyph, plain forced by flag", () => {
    expect(logoTierFor({ kitty: true }, false)).toBe("kitty");
    expect(logoTierFor({ kitty: false }, false)).toBe("glyph");
    expect(logoTierFor({ kitty: true }, true)).toBe("plain");
  });
});

describe("plainEnv", () => {
  it("honors PI_WEAVE_TUI_PLAIN truthiness", () => {
    expect(plainEnv({})).toBe(false);
    expect(plainEnv({ [PLAIN_ENV]: "1" })).toBe(true);
    expect(plainEnv({ [PLAIN_ENV]: "0" })).toBe(false);
    expect(plainEnv({ [PLAIN_ENV]: "" })).toBe(false);
  });
});

describe("probeGraphics", () => {
  it("probes once and caches for the session", () => {
    const getCaps = vi.fn(() => ({ kitty: false }));
    const first = probeGraphics(getCaps);
    expect(first.kitty).toBe(false);
    expect(getCaps).toHaveBeenCalledTimes(1);
    const second = probeGraphics(getCaps);
    expect(second).toBe(first);
    expect(getCaps).toHaveBeenCalledTimes(1); // cached, no re-probe
  });
  it("tolerates a throwing probe", () => {
    resetBrandCache();
    const caps = probeGraphics(() => {
      throw new Error("no terminal");
    });
    expect(caps.kitty).toBe(false);
  });
});

describe("logoTier (session resolution)", () => {
  it("selects kitty when capability supports it and not plain-forced", () => {
    // Force the cached capability via the probe seam, then resolve the tier.
    probeGraphics(() => ({ kitty: true }));
    expect(logoTier({})).toBe("kitty");
  });
  it("honors PI_WEAVE_TUI_PLAIN", () => {
    probeGraphics(() => ({ kitty: true }));
    expect(logoTier({ [PLAIN_ENV]: "1" })).toBe("plain");
  });
  it("falls back to glyph when no kitty", () => {
    probeGraphics(() => ({ kitty: false }));
    expect(logoTier({})).toBe("glyph");
  });
});

describe("getBrandCapabilities", () => {
  it("maps kitty image support from detectCapabilities", () => {
    expect(typeof getBrandCapabilities().kitty).toBe("boolean");
  });
});

describe("renderMark", () => {
  it("renders the glyph for kitty and glyph tiers, ≤ width, no ESC", () => {
    for (const tier of ["kitty", "glyph"] as LogoTier[]) {
      const line = renderMark(tier, theme(), 10);
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
      expect(line).not.toContain("\x1b");
      expect(line).toContain(MARK_GLYPH);
    }
  });
  it("renders the plain mark for the plain tier", () => {
    const line = renderMark("plain", theme(), 10);
    expect(line).toContain(PLAIN_MARK);
  });
  it("truncates to width (tiny viewport)", () => {
    expect(visibleWidth(renderMark("glyph", theme(), 1))).toBeLessThanOrEqual(1);
  });
  it("WORDMARK constant is defined", () => {
    expect(WORDMARK.length).toBeGreaterThan(0);
  });
});

describe("logoImage", () => {
  it("returns a kitty Image component that renders at least one line", () => {
    const img = logoImage("aGVsbG8=", "image/jpeg", theme());
    expect(img).not.toBeNull();
    const lines = img!.render(20);
    expect(lines.length).toBeGreaterThan(0);
  });
});
