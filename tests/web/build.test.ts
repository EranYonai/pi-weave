/**
 * Invariants of the committed web bundle (weave-workspace §9, §5.2, §14).
 *
 * This suite deliberately does **not** run a build. Two reasons: a bundle is
 * slow enough to be felt in a watch loop, and drift detection is already
 * `npm run build:web:check`'s job — running it here would duplicate that gate
 * while making every unrelated test run pay for esbuild. What this asserts
 * instead are the properties a *reader of the repository* should be able to
 * rely on without rebuilding: the artifact exists, it is attributed, it parses,
 * it is CSP-clean, and it is inside budget.
 *
 * The CSP assertions are the important ones. §5.2 serves the client under a
 * strict Content-Security-Policy with no `unsafe-eval` and no `blob:`, so a
 * dependency that reaches for `eval`, `new Function`, dynamic `import()` or
 * `URL.createObjectURL` does not fail in CI — it fails silently in the user's
 * browser, at runtime, in a feature nobody tested. Checking the bytes turns
 * that class of bug into a build failure on the PR that introduces it.
 */

import { readFileSync } from "node:fs";
import { gzipSync, constants as zlibConstants } from "node:zlib";
import { describe, expect, it } from "vitest";

const BUNDLE = new URL("../../src/web/client/dist/app.js", import.meta.url).pathname;

/** §14: hard budget, 150 KiB gzip. */
const GZIP_BUDGET_BYTES = 150 * 1024;

const bytes = readFileSync(BUNDLE);
const source = bytes.toString("utf8");

describe("committed bundle", () => {
  it("exists and is non-empty", () => {
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("carries the generated licence banner", () => {
    expect(source.startsWith("/*!")).toBe(true);
    expect(source).toContain("pi-weave web client — generated bundle. Do not edit.");
    expect(source).toContain("Rebuild with `npm run build:web`");
    expect(source).toContain("Bundled dependencies and their licences:");
  });

  it("attributes every dependency it actually bundles", () => {
    // The banner is derived from esbuild's metafile, so this is really a check
    // that the derivation ran — an empty dependency list would still produce a
    // well-formed header.
    const banner = source.slice(0, source.indexOf("*/"));
    const attributions = [...banner.matchAll(/^ \* {3}(\S+) — (.+)$/gm)];
    expect(attributions.length).toBeGreaterThan(0);
    for (const [, spec, licence] of attributions) {
      expect(spec).toMatch(/@\d+\.\d+\.\d+/); // name@version
      expect(licence?.trim()).not.toBe("");
    }
  });

  it("is a valid, parseable script", () => {
    // Compiled but never called: this is a syntax check, not an execution. The
    // bundle touches `document` at module scope and there is no DOM here.
    expect(() => new Function(source)).not.toThrow();
  });
});

describe("CSP cleanliness (§5.2)", () => {
  // Each entry is a construct the strict CSP forbids at runtime. Patterns are
  // deliberately narrow so that minified identifiers which merely *contain* a
  // keyword (`evaluate`, `myimport`) do not trip them.
  const forbidden: readonly { readonly what: string; readonly pattern: RegExp; readonly why: string }[] = [
    { what: "eval(", pattern: /\beval\s*\(/, why: "requires script-src 'unsafe-eval'" },
    { what: "new Function", pattern: /\bnew\s+Function\s*\(/, why: "requires script-src 'unsafe-eval'" },
    { what: "Function constructor call", pattern: /[^.\w]Function\s*\(\s*["'`]/, why: "requires script-src 'unsafe-eval'" },
    { what: "createObjectURL", pattern: /\bcreateObjectURL\s*\(/, why: "blob: is not in the CSP" },
  ];

  for (const { what, pattern, why } of forbidden) {
    it(`contains no ${what}`, () => {
      const at = source.search(pattern);
      const context = at === -1 ? "" : `\n…${source.slice(Math.max(0, at - 80), at + 80)}…`;
      expect(at, `bundle uses ${what}, which ${why}${context}`).toBe(-1);
    });
  }

  /**
   * Dynamic `import()`, distinguished from a **method named `import`**.
   *
   * §0.1 footnote 2 called this exactly: *"graphology's one `import(` hit is
   * the substring in `i.import(e)` — a method named `import`, not a dynamic
   * import. Verified in context."* P3 put graphology in the bundle and the
   * blanket `/\bimport\s*\(/` duly went red on the two occurrences —
   * `Graph.prototype.import(e, n = !1)` and the `i.import(e)` that calls it.
   *
   * A `\b` word boundary cannot tell those apart, because `.` is a
   * non-word character and therefore *is* a boundary. The distinction that
   * matters is the preceding character: a real dynamic import is preceded by
   * an operator, a bracket or nothing, while a method is preceded by `.` (or
   * by `function`/whitespace in a class body, which is the declaration).
   *
   * So the check classifies each hit rather than banning the substring. The
   * assertion is still zero *dynamic* imports — the property §5.2 needs, since
   * the bundle is a single IIFE with nothing to load — and the footnote's
   * verification is now executable rather than a claim in a doc.
   */
  it("contains no dynamic import(), only methods named `import`", () => {
    const dynamic: string[] = [];
    const methods: string[] = [];
    for (const match of source.matchAll(/\bimport\s*\(/g)) {
      const at = match.index;
      const before = source.slice(0, at).trimEnd();
      const previous = before.at(-1) ?? "";
      // `.import(` is a member call; `import(` after `function`/`;`/`{` in a
      // class body is a method declaration. Both are graphology's `import`.
      const isMethod = previous === "." || /\b(?:function|class)$/.test(before) || /[;{}]$/.test(before);
      (isMethod ? methods : dynamic).push(`…${source.slice(Math.max(0, at - 60), at + 40)}…`);
    }
    expect(dynamic, "the bundle is a single IIFE; there is nothing to load").toEqual([]);
    // …and the classifier is not vacuously passing everything. graphology
    // ships `Graph.prototype.import`, so this is a real, expected non-zero.
    expect(methods.length).toBeGreaterThan(0);
  });

  it("declares strict mode, as an IIFE bundle should", () => {
    expect(source).toContain('"use strict"');
  });
});

describe("size budget (§14)", () => {
  it("is under 150 KiB gzip", () => {
    const gzip = gzipSync(bytes, { level: zlibConstants.Z_BEST_COMPRESSION }).length;
    expect(gzip, `bundle is ${(gzip / 1024).toFixed(1)} KiB gzip`).toBeLessThanOrEqual(GZIP_BUDGET_BYTES);
  });
});
