/**
 * The workspace theme and its CSP-legal installation
 * (weave-workspace §1.2, §5.2).
 *
 * Two things are asserted here, and the second is the one that matters.
 *
 * The CSS is a constant, so it can be checked as text: that it defines the
 * custom properties the components reference, that every class the `.tsx`
 * files emit has a rule, and — the §1.2 "dense but calm" brief — that it does
 * not drift into the card-and-whitespace defaults it was written to avoid.
 *
 * The installer is the CSP half. `style-src 'nonce-{N}'` with no
 * `'unsafe-inline'` means a script-inserted `<style>` is dropped unless it
 * carries the per-response nonce, and that nonce is only readable through the
 * IDL property. These tests pin that behaviour with a four-method fake
 * `document`, no DOM required (§10).
 */

import { describe, expect, it } from "vitest";
import { fetchJson } from "../../src/web/client/api.dom";
import { NONCE_SOURCES, THEME_CSS, findNonce, installTheme } from "../../src/web/client/shell/theme";
import type { StyleElement, ThemeHost } from "../../src/web/client/shell/theme";
import { COLUMNS, columnVar } from "../../src/web/client/shell/layout.model";
import { EDITOR_PROMPT_KINDS } from "../../src/web/client/note/editor.model";
import {
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  cycleTheme,
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
    // `theme.model.ts`'s header explains the pair of selectors: an explicit
    // light branch (must beat the media query) plus the media query narrowed
    // by `:not([data-weave-theme="dark"])` (so a dark *choice* wins when the
    // OS says light, and system mode still answers a live OS flip). There is
    // deliberately no `:root[data-weave-theme="dark"]` — the dark tokens sit
    // in the base `:root` and every light rule is guarded, so dark is what
    // remains when the guards all fail to match. No selector here may depend
    // on inline styles — CSP forbids them.
    expect(THEME_CSS).toContain(':root[data-weave-theme="light"]');
    expect(THEME_CSS).toContain(':root:not([data-weave-theme="dark"])');
  });

  it("consumes the column custom properties layout.model.ts produces", () => {
    // The contract between `columnVars` and the grid rule. If either side is
    // renamed, the columns silently fall back to percentages.
    for (const column of COLUMNS) {
      expect(THEME_CSS).toContain(`var(${columnVar(column)}`);
    }
  });

  it("gives the grid a fallback width for every column", () => {
    // The first frame runs before `useLayoutEffect` writes the properties.
    for (const column of COLUMNS) {
      expect(THEME_CSS).toMatch(new RegExp(`var\\(${columnVar(column)},\\s*\\d+%\\)`));
    }
  });

  it("has a rule for every class the components emit", () => {
    const classes = [
      "weave-header",
      "weave-brand",
      "weave-brand-mark",
      "weave-search",
      "weave-summary",
      "weave-summary-part",
      "weave-refresh",
      "weave-theme",
      "weave-conn",
      "weave-conn-dot",
      "weave-conn-ok",
      "weave-conn-warn",
      "weave-conn-bad",
      "weave-grid",
      "weave-col",
      "weave-col-title",
      "weave-divider",
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
      "weave-note-head",
      "weave-note-title",
      "weave-note-meta",
      "weave-note-time",
      "weave-note-tags",
      "weave-tag",
      "weave-note-body",
      "weave-wiki",
      "weave-wiki-ghost",
      // The P5 editor. `weave-note-prompt-{conflict,collision,external,discard}`
      // are generated from `EditorPromptKind`, so they get their own
      // assertion below rather than four entries here.
      "weave-note-bar",
      "weave-note-toggle",
      "weave-note-save",
      "weave-note-open",
      "weave-note-action",
      "weave-note-dirty",
      "weave-note-status",
      "weave-note-status-ok",
      "weave-note-status-warn",
      "weave-note-prompt",
      "weave-note-prompt-text",
      "weave-note-prompt-actions",
      "weave-note-editor",
      "weave-ctx-empty",
      "weave-ctx-group",
      "weave-ctx-heading",
      "weave-ctx-rows",
      "weave-ctx-row",
      "weave-ctx-link",
      "weave-ctx-tags",
      "weave-ctx-tag",
      "weave-status",
      "weave-status-cwd",
      "weave-status-sel",
      "weave-status-stamp",
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
      "weave-search-text",
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

  it("styles every prompt kind, derived from the union rather than listed", () => {
    // `Editor.tsx` emits `weave-note-prompt-${prompt.kind}`, so the class set
    // is generated at runtime from `EditorPromptKind`. Listing the four by
    // hand above would pass on the day a fifth kind arrives unstyled; walking
    // the union means the assertion grows with it.
    for (const kind of EDITOR_PROMPT_KINDS) expect(THEME_CSS, kind).toContain(`.weave-note-prompt-${kind}`);
  });

  it("styles all three grid arities, so a breakpoint is never unstyled", () => {
    for (const count of [1, 2, 3]) expect(THEME_CSS).toContain(`[data-columns="${count}"]`);
  });

  it("stays dense: no card shadows, no oversized gutters", () => {
    // §1.2 asks for "dense but calm" and the failure mode is a marketing
    // page. Shadows and 24 px padding are the tells.
    expect(THEME_CSS).not.toContain("box-shadow");
    expect(THEME_CSS).not.toMatch(/padding:\s*2[0-9]px/);
    expect(THEME_CSS).not.toMatch(/font-size:\s*(1[6-9]|[2-9]\d)px/);
  });

  it("draws every size from the named type ramp, never an ad-hoc pixel", () => {
    // Tier 4's ramp: seven role-named tokens, and every `font-size:` in the
    // sheet is one of them. A literal px here is a size the ramp does not
    // govern — the exact drift (9/10/11/11.5/…) this gate exists to stop.
    const steps = ["9.5px", "10.5px", "11.5px", "12px", "13px", "14px", "15px"];
    const declared = [...THEME_CSS.matchAll(/--weave-px-([a-z]+):(\d+(?:\.\d+)?px)/g)].map((m) => m[2]!);
    expect(new Set(declared)).toEqual(new Set(steps));
    const stray = [...THEME_CSS.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1]!.trim())
      .filter((size) => !/^var\(--weave-px-(prov|caption|ui|row|base|subhead|title)\)$/.test(size));
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

  it("widens the divider's hit area without thickening the visible rule", () => {
    // A 1 px grid track is unhittable with a mouse.
    expect(THEME_CSS).toContain(".weave-divider::after");
    expect(THEME_CSS).toContain("col-resize");
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
    expect(document.appended[0]?.textContent).toBe(THEME_CSS);
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
   * it is proven here the same way `domEventSource` is: by stubbing the
   * global and asserting the delegation, not by opening a socket.
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
    // `EventSource` cannot set headers, so the whole security model rides the
    // `__Host-weave` cookie. A default is a worse place for that dependency
    // than a line of code.
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

  it("cycles system → light → dark → system", () => {
    expect(cycleTheme("system")).toBe("light");
    expect(cycleTheme("light")).toBe("dark");
    expect(cycleTheme("dark")).toBe("system");
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
  it("gives every choice a distinct glyph from the provenance family", () => {
    const glyphs = THEME_CHOICES.map((choice) => themeButton(choice).glyph);
    for (const [choice, glyph] of THEME_CHOICES.map((c, i) => [c, glyphs[i]] as const)) {
      expect(["●", "◐", "○"], choice).toContain(glyph);
    }
    expect(new Set(glyphs).size).toBe(THEME_CHOICES.length);
  });

  it("hints where the choice is and what clicking does", () => {
    const view = themeButton("system");
    expect(view.hint).toContain("system");
    expect(view.hint).toContain("light");
  });
});
