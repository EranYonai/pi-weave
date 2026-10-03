/**
 * The workspace theme and its CSP-legal installation
 * (weave-workspace §1.2, §5.2).
 *
 * Two things are asserted here, and the second is the one that matters.
 *
 * The CSS is a constant, so it can be checked as text: that it defines the
 * custom properties the components reference, that every class the `.tsx`
 * files emit has a rule, and — the  "dense but calm" brief — that it does
 * not drift into the card-and-whitespace defaults it was written to avoid.
 *
 * The installer is the CSP half. `style-src 'nonce-{N}'` with no
 * `'unsafe-inline'` means a script-inserted `<style>` is dropped unless it
 * carries the per-response nonce, and that nonce is only readable through the
 * IDL property. These tests pin that behaviour with a four-method fake
 * `document`, no DOM required (§10).
 */

import { THEMES } from "../../src/web/shared/themes";
import { initialLayout, parseWorkspaceLayout } from "../../src/web/shared/workspace";
import { GROUP_HUES, shadeFor } from "../../src/web/client/graph/groups";
import { GRAPH_PALETTE, graphSettings, kindColor } from "../../src/web/client/graph/graph.model";
import { describe, expect, it } from "vitest";
import { fetchJson } from "../../src/web/client/api.dom";
import { WORKSPACE_CSS } from "../../src/web/client/shell/workspace.css";
import { NONCE_SOURCES, THEME_CSS, findNonce, installTheme } from "../../src/web/client/shell/theme";
import type { StyleElement, ThemeHost } from "../../src/web/client/shell/theme";
import {
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  toggleTheme,
  effectiveScheme,
  isThemeChoice,
  loadTheme,
  saveTheme,
  themeAttr,
  themeButton,
} from "../../src/web/client/shell/theme.model";

// --- a fake document ------------------------------------------------------------

function host(existing: Record<string, StyleElement> = {}): ThemeHost & { readonly appended: StyleElement[] } {
  const appended: StyleElement[] = [];
  return {
    createElement: () => ({ textContent: null }),
    querySelector: (selector) => existing[selector] ?? null,
    head: { appendChild: (node) => appended.push(node) },
    appended,
  };
}

/** An element the server nonce'd, as the browser exposes it. */
function nonced(nonce: string): StyleElement {
  // Note the shape: the *content attribute* is hidden by the browser, so a
  // real element answers `getAttribute("nonce")` with `""` while `.nonce`
  // still returns the value. The fake mirrors that by only having `.nonce`.
  return { nonce, textContent: "" };
}

// --- the stylesheet ---------------------------------------------------------------

describe("THEME_CSS", () => {
  it("starts with the tabs workspace and footer, without the retired header", () => {
    expect(THEME_CSS).toContain("#app{height:100%;display:grid;grid-template-rows:minmax(0,1fr) auto;");
    expect(THEME_CSS).not.toContain(".weave-header");
    expect(THEME_CSS).not.toContain(".weave-summary");
    expect(WORKSPACE_CSS).not.toContain(".weave-header");
    for (const selector of [".weave-brand", ".weave-search", ".weave-refresh", ".weave-theme"]) {
      expect(THEME_CSS).not.toContain(selector);
    }
  });

  it("defines the palette the components reference", () => {
    for (const name of [
      "--weave-bg",
      "--weave-panel",
      "--weave-fg",
      "--weave-dim",
      "--weave-faint",
      "--weave-line",
      "--weave-accent",
      "--weave-ok",
      "--weave-warn",
      "--weave-bad",
    ]) {
      expect(THEME_CSS).toContain(`${name}:`);
    }
  });

  it("is dark-first, with light as the media-query branch", () => {
    // The inversion of `page.ts`'s fallback, and it is safe because this
    // sheet is installed second and wins on equal specificity.
    const root = THEME_CSS.indexOf(":root{");
    const light = THEME_CSS.indexOf("prefers-color-scheme: light");
    expect(root).toBeGreaterThanOrEqual(0);
    expect(light).toBeGreaterThan(root);
  });

  it("answers the manual override through the data attribute", () => {
    for (const id of Object.keys(THEMES)) expect(THEME_CSS).toContain(`:root[data-weave-theme="${id}"]`);
    expect(THEME_CSS).toContain(':root:not([data-weave-theme])');
  });

  it("has a rule for every class the components emit", () => {
    const classes = [
      // `weave-empty` / `-body` / `-phase` went with `EmptyState.tsx` in P3.
      // Every column now renders its own empty state as a plain paragraph
      // (`treeEmptyMessage`, `noteEmptyMessage`, `graphEmptyMessage`,
      // `RAIL_EMPTY`), so the shared placeholder had no callers left.
      "weave-rail",
      "weave-tree",
      "weave-tree-controls",
      "weave-filter",
      "weave-chip",
      "weave-rows",
      "weave-row",
      "weave-row-new",
      "weave-row-on",
      "weave-icon",
      "weave-icon-open",
      "weave-twisty",
      "weave-kind",
      "weave-prov",
      "weave-prov-human",
      "weave-prov-agent",
      "weave-prov-generated",
      "weave-label",
      "weave-meta",
      "weave-tree-empty",
      "weave-tree-count",
      "weave-note",
      "weave-note-empty",
      // The page's provenance spine: the article carries `weave-note-${source}`,
      // so the manuscript's left rule takes its writer's colour. Same three
      // kinds as the `weave-prov-*` glyphs.
      "weave-note-human",
      "weave-note-agent",
      "weave-note-generated",
      "weave-note-head",
      "weave-note-title",
      "weave-note-meta",
      "weave-note-time",
      "weave-note-tags",
      "weave-tag",
      "weave-note-body",
      "weave-wiki",
      "weave-wiki-ghost",
      // The P6.3 wikilink hover card: `Note.tsx` mounts it with a fixed id
      // (unique per document view), so it is classed and asserted here like any other.
      // Ghost links add `weave-preview-ghost`, which carries the no-note
      // offer's dashed frame.
      "weave-preview",
      "weave-preview-ghost",
      "weave-preview-kind",
      "weave-preview-title",
      "weave-preview-text",
      "weave-note-open",
      "weave-ctx-empty",
      "weave-ctx-group",
      "weave-ctx-head",
      "weave-ctx-heading",
      "weave-ctx-chevron",
      "weave-ctx-count",
      "weave-ctx-rows",
      "weave-ctx-row",
      "weave-ctx-link",
      "weave-ctx-tags",
      "weave-ctx-tag",
      "weave-status",
      "weave-status-cwd",
      "weave-status-sel",
      // The graph column (P3).
      "weave-graph",
      "weave-graph-canvas",
      "weave-graph-empty",
      "weave-graph-controls",
      "weave-graph-legend",
      "weave-legend-on",
      "weave-legend-near",
      "weave-legend-dim",
      "weave-graph-count",
      // The ⌘K palette and the help overlay (P4).
      "weave-scrim",
      "weave-palette",
      "weave-palette-input",
      "weave-palette-status",
      "weave-palette-foot",
      "weave-palette-hint",
      "weave-hits",
      "weave-hit",
      "weave-hit-on",
      "weave-hit-badge",
      "weave-hit-label",
      "weave-hit-detail",
      "weave-help",
      "weave-help-title",
      "weave-help-foot",
      "weave-help-hint",
      "weave-keys",
      "weave-key-group",
      "weave-key-row",
      "weave-key-combo",
      "weave-key-what",
    ];
    for (const name of classes) expect(THEME_CSS).toContain(`.${name}`);
  });

  it("stays dense: no card shadows, no oversized gutters", () => {
    //  asks for "dense but calm" and the failure mode is a marketing
    // page. Shadows and 24 px padding are the tells. Tier 6 narrows the
    // shadow refusal to *elevation* only: the selection's inset accent bar
    // (`box-shadow:inset 2px 0 0 …`) is a hairline edge, not a shadow — it
    // projects no elevation and the anti-card intent is untouched.
    expect(THEME_CSS).not.toMatch(/box-shadow\s*:\s*(?!inset)/);
    expect(THEME_CSS).not.toMatch(/padding:\s*2[0-9]px/);
    expect(THEME_CSS).not.toMatch(/font-size:\s*(1[6-9]|[2-9]\d)px/);
  });

  it("draws every size from the named type ramp, never an ad-hoc pixel", () => {
    // Tier 4's ramp, extended by P6.3 (`body`, `display`): every role-named
    // token, and every `font-size:` in the sheet is one of them. A literal px
    // here is a size the ramp does not govern — the exact drift
    // (9/10/11/11.5/…) this gate exists to stop.
    const steps = ["9.5px", "10.5px", "11.5px", "12px", "13px", "13.5px", "14px", "15px", "20px"];
    const declared = [...THEME_CSS.matchAll(/--weave-px-([a-z]+):(\d+(?:\.\d+)?px)/g)].map((m) => m[2]!);
    expect(new Set(declared)).toEqual(new Set(steps));
    const stray = [...THEME_CSS.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1]!.trim())
      .filter((size) => !/^var\(--weave-px-(prov|caption|ui|row|base|body|subhead|title|display)\)$/.test(size));
    expect(stray).toEqual([]);
  });

  it("keeps the two-value radius scale, not ad-hoc corners", () => {
    // Controls take --weave-radius, overlays --weave-radius-pop, tag pills
    // are 999px capsules, and the palette input resets to 0 inside its own
    // pop radius. Nothing else may state a literal.
    const radii = [...THEME_CSS.matchAll(/border-radius:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    const allowed = new Set([
      "var(--weave-radius)",
      "var(--weave-radius-pop)",
      "0",
      "999px",
    ]);
    expect(radii.filter((r) => !allowed.has(r))).toEqual([]);
  });

  it("keeps a visible focus ring, which P4's keyboard work depends on", () => {
    expect(THEME_CSS).toContain(":focus-visible");
    expect(THEME_CSS).toContain("outline:2px solid var(--weave-accent)");
  });

  it("honours prefers-reduced-motion", () => {
    expect(THEME_CSS).toContain("prefers-reduced-motion");
  });

  it("carries nothing that the CSP or the bundle guard would reject", () => {
    // `url()` would need `img-src`/`font-src` beyond `'self'`; `@import` would
    // be a network fetch the policy forbids outright.
    expect(THEME_CSS).not.toContain("@import");
    expect(THEME_CSS).not.toContain("url(");
    expect(THEME_CSS).not.toContain("</style");
  });
});

// --- finding the nonce -------------------------------------------------------------

describe("findNonce", () => {
  it("reads the nonce off the server's style block", () => {
    expect(findNonce(host({ "style[nonce]": nonced("abc123") }))).toBe("abc123");
  });

  it("falls back to the bundle's own script tag", () => {
    // It carries the same per-response nonce and exists by definition — it is
    // the code currently running.
    expect(findNonce(host({ "script[nonce]": nonced("s3cr3t") }))).toBe("s3cr3t");
  });

  it("tries every declared source in order", () => {
    expect(NONCE_SOURCES.length).toBeGreaterThan(1);
    for (const selector of NONCE_SOURCES) {
      expect(findNonce(host({ [selector]: nonced("n") }))).toBe("n");
    }
  });

  it("is null when no element carries one", () => {
    expect(findNonce(host())).toBeNull();
  });

  it("ignores an element whose nonce is empty or absent", () => {
    // Exactly what `getAttribute("nonce")` returns on a real nonce'd element,
    // which is why this module reads the IDL property instead.
    expect(findNonce(host({ "style[nonce]": { nonce: "", textContent: "" } }))).toBeNull();
    expect(findNonce(host({ "style[nonce]": { textContent: "" } }))).toBeNull();
  });

  it("skips a nonce-less element and keeps looking", () => {
    const document = host({ "style[nonce]": { textContent: "" }, "script[nonce]": nonced("later") });
    expect(findNonce(document)).toBe("later");
  });
});

// --- installation --------------------------------------------------------------------

describe("installTheme", () => {
  it("appends a nonce'd style element carrying the theme", () => {
    const document = host({ "style[nonce]": nonced("abc123") });
    expect(installTheme(document)).toBe(true);

    expect(document.appended).toHaveLength(1);
    expect(document.appended[0]?.nonce).toBe("abc123");
    expect(document.appended[0]?.textContent).toBe(THEME_CSS + WORKSPACE_CSS);
  });

  it("accepts injected CSS, so a test need not assert against the whole sheet", () => {
    const document = host({ "style[nonce]": nonced("n") });
    installTheme(document, ".x{color:red}");
    expect(document.appended[0]?.textContent).toBe(".x{color:red}");
  });

  it("reports failure — and still appends — when no nonce is available", () => {
    // The console CSP violation is a better diagnostic than a stylesheet that
    // was never created, and weakening the policy to avoid it is not on the
    // table.
    const document = host();
    expect(installTheme(document)).toBe(false);
    expect(document.appended).toHaveLength(1);
    expect(document.appended[0]?.nonce).toBeUndefined();
  });
});

// --- the platform fetch adapter -------------------------------------------------------

describe("fetchJson", () => {
  /**
   * The one line in the HTTP layer that names a DOM global.
   *
   * `api.ts` is deliberately free of `fetch`, `Response` and `RequestInit` so
   * it compiles under the root project (no `DOM` lib) and is testable with a
   * fake. `api.dom.ts` is the four-line adapter that calls the real thing, and
   * it is proven here by stubbing the global and asserting the delegation,
   * not by opening a socket.
   */
  function withFetch<T>(impl: (url: string, init: unknown) => Promise<unknown>, run: () => T): T {
    const globals = globalThis as { fetch?: unknown };
    const original = globals.fetch;
    globals.fetch = impl;
    try {
      return run();
    } finally {
      if (original === undefined) delete globals.fetch;
      else globals.fetch = original;
    }
  }

  it("delegates to the platform fetch and returns its response", async () => {
    const seen: Array<{ url: string; init: Record<string, unknown> }> = [];
    const response = await withFetch(
      (url, init) => {
        seen.push({ url, init: init as Record<string, unknown> });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ hi: true }) });
      },
      () => fetchJson("/api/graph"),
    );

    expect(seen[0]?.url).toBe("/api/graph");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hi: true });
  });

  it("always sends same-origin credentials — §5.1 authenticates by cookie", () => {
    // The request uses same-origin credentials so the security model rides
    // the `__Host-weave` cookie. A default is a worse place for that
    // dependency than a line of code.
    const seen: Array<Record<string, unknown>> = [];
    withFetch(
      (_url, init) => {
        seen.push(init as Record<string, unknown>);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      },
      () => fetchJson("/api/graph"),
    );
    expect(seen[0]?.["credentials"]).toBe("same-origin");
  });

  it("omits method, headers and body when the caller set none", () => {
    // `exactOptionalPropertyTypes` is on, and passing `undefined` explicitly
    // is not the same as omitting — a `method: undefined` would be a type
    // error at the call site and a surprise at the network layer.
    const seen: Array<Record<string, unknown>> = [];
    withFetch(
      (_url, init) => {
        seen.push(init as Record<string, unknown>);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      },
      () => fetchJson("/api/graph"),
    );
    expect(seen[0]).not.toHaveProperty("method");
    expect(seen[0]).not.toHaveProperty("headers");
    expect(seen[0]).not.toHaveProperty("body");
  });

  it("forwards a POST with its headers and body", () => {
    const seen: Array<Record<string, unknown>> = [];
    withFetch(
      (_url, init) => {
        seen.push(init as Record<string, unknown>);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      },
      () =>
        fetchJson("/api/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"slug":"alpha"}',
        }),
    );
    expect(seen[0]?.["method"]).toBe("POST");
    expect(seen[0]?.["headers"]).toEqual({ "content-type": "application/json" });
    expect(seen[0]?.["body"]).toBe('{"slug":"alpha"}');
  });
});

// --- the choice, not the palette ------------------------------------------------------

describe("theme.model", () => {
  /** A storage fake that behaves like a real `localStorage`, plus a broken one. */
  function storage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }

  it("round-trips a choice through storage", () => {
    const store = storage();
    for (const choice of THEME_CHOICES) {
      saveTheme(store, choice);
      expect(loadTheme(store)).toBe(choice);
      expect(store.data.get(THEME_STORAGE_KEY)).toBe(choice);
    }
  });

  it("absorbs unreadable storage and foreign values as system", () => {
    // The section-5 partitioned-storage posture: a theme that cannot load is
    // cosmetic, never a mount failure.
    const broken = { getItem: () => { throw new Error("quota"); }, setItem: () => {} };
    expect(loadTheme(broken)).toBeNull();
    const foreign = storage();
    foreign.setItem(THEME_STORAGE_KEY, "sepia");
    expect(loadTheme(foreign)).toBeNull();
  });

  it("saves and reports failure, in the shape saveSelection returns", () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(saveTheme(broken, "light")).toBe(false);
  });

  it("toggles only the selected light/dark pair, including from system mode", () => {
    const pair = { lightTheme: "paper-blue", darkTheme: "mocha-lavender" } as const;
    expect(toggleTheme("paper-blue", "dark", pair)).toBe("mocha-lavender");
    expect(toggleTheme("mocha-lavender", "light", pair)).toBe("paper-blue");
    expect(toggleTheme("system", "dark", pair)).toBe("paper-blue");
    expect(toggleTheme("system", "light", pair)).toBe("mocha-lavender");
    expect(effectiveScheme("system", "dark", pair)).toBe("mocha-lavender");
    expect(effectiveScheme("system", "light", pair)).toBe("paper-blue");
    expect(toggleTheme("light", "dark")).toBe("dark");
  });

  it("restores every candidate through workspace persistence and rejects unknown choices", () => {
    for (const theme of THEME_CHOICES) {
      const layout = { ...initialLayout(), theme };
      expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
      expect(effectiveScheme(theme, "light")).toBe(theme === "system" ? "light" : theme);
      expect(themeAttr(theme)).toBe(theme === "system" ? null : theme);
    }
    expect(parseWorkspaceLayout({ ...initialLayout(), theme: "foreign" })).toBeNull();
    for (const value of [null, undefined, 42, {}, "foreign"]) expect(isThemeChoice(value)).toBe(false);
  });

  it("resolves system mode through the OS, and a choice over it", () => {
    expect(effectiveScheme("system", "light")).toBe("light");
    expect(effectiveScheme("system", "dark")).toBe("dark");
    expect(effectiveScheme("light", "dark")).toBe("light");
    expect(effectiveScheme("dark", "light")).toBe("dark");
  });

  it("clears the attribute in system mode so the media query governs", () => {
    // Any attribute at all would override the OS flip the media query is
    // there to follow — so "system" is the *absence*, not a third value.
    expect(themeAttr("system")).toBeNull();
    expect(themeAttr("light")).toBe("light");
    expect(themeAttr("dark")).toBe("dark");
  });
});

describe("themeButton", () => {
  it("names the current palette and opposite chosen palette with a scheme glyph", () => {
    for (const choice of THEME_CHOICES) {
      const view = themeButton(choice);
      expect(view.hint).toContain(view.label);
      expect(view.hint).toContain(themeButton(toggleTheme(choice, "dark")).label);
      expect(view.glyph).toBe(choice === "system" ? "◐" : THEMES[choice].scheme === "light" ? "○" : "●");
    }
  });
});

function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((offset) => {
      const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  };
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + .05) / (lo + .05);
}

describe("theme candidates", () => {
  it("offers six Catppuccin themes and three custom light/dark pairs", () => {
    const themes = Object.values(THEMES);
    expect(themes.filter((theme) => theme.name.startsWith("Catppuccin"))).toHaveLength(6);
    const custom = themes.filter((theme) => !theme.name.startsWith("Catppuccin"));
    expect(custom.filter((theme) => theme.scheme === "light")).toHaveLength(3);
    expect(custom.filter((theme) => theme.scheme === "dark")).toHaveLength(3);
  });

  it("keeps text and accent readable on workspace surfaces and shares colors with WebGL", () => {
    for (const id of THEME_CHOICES) {
      if (id === "system") continue;
      const { colors } = THEMES[id];
      for (const token of ["fg", "dim", "accent", "ok", "warn", "bad"] as const) {
        for (const surface of ["bg", "panel", "page", "raise"] as const) {
          expect(contrast(colors[token], colors[surface]), `${id} ${token}/${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const surface of ["bg", "panel", "page"] as const) {
        expect(contrast(colors.faint, colors[surface]), `${id} faint/${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(colors.faint, colors.raise), `${id} faint/raise`).toBeGreaterThanOrEqual(3);
      for (const hue of GROUP_HUES[THEMES[id].scheme]) {
        expect(contrast(shadeFor(hue, 10, id), colors.bg), `${id} group hue ${hue}`).toBeGreaterThanOrEqual(3);
      }
      expect(GRAPH_PALETTE[id].ground).toBe(colors.bg);
      expect(kindColor("vault", id)).toBe(colors.accent);
      expect(graphSettings(id).labelColor).toEqual({ color: colors.fg });
      for (const [key, value] of Object.entries(colors)) expect(THEME_CSS).toContain(`--weave-${key}:${value};`);
    }
  });
});

it("keeps every independent accent readable and passes it into the graph palette", async () => {
  const { ACCENTS, accentColor, themeId } = await import("../../src/web/shared/themes");
  const { graphPalette } = await import("../../src/web/client/graph/graph.model");
  for (const id of THEME_CHOICES) {
    if (id === "system") continue;
    expect(accentColor(id, "theme")).toBe(THEMES[id].colors.accent);
    expect(themeId(id)).toBe(id);
    for (const accent of Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]) {
      const theme = { theme: id, accent };
      expect(themeId(theme)).toBe(id);
      expect(kindColor("vault", theme)).toBe(accentColor(id, accent));
      expect(graphPalette(theme).ground).toBe(THEMES[id].colors.bg);
      for (const surface of ["bg", "panel", "page", "raise"] as const) {
        expect(contrast(accentColor(id, accent), THEMES[id].colors[surface]), `${id} ${accent}/${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(THEME_CSS).toContain(`--weave-accent:${accentColor(id, accent)}`);
    }
  }
});

it("names the user's chosen destination rather than the next preview palette", () => {
  const pair = { lightTheme: "mist-teal", darkTheme: "frappe-teal" } as const;
  expect(themeButton("frappe-teal", "dark", pair).hint).toContain("click for Mist · Teal");
  expect(themeButton("mist-teal", "light", pair).hint).toContain("click for Catppuccin Frappé · Teal");
  expect(themeButton("system", "dark", pair).hint).toContain("click for Mist · Teal");
  expect(themeButton("system", "light", pair).hint).toContain("click for Catppuccin Frappé · Teal");
});
