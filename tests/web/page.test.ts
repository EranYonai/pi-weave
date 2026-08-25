/**
 * The HTML shell: escaping, nonces, and the source guard
 * (weave-workspace §5.2, §5.3, §9).
 *
 * ## The guard, and why it is two tests
 *
 * §9 retired the no-backtick *source* guard for `dist/app.js` — the bundle
 * is generated, and `build:web:check`'s byte comparison is a strictly
 * stronger invariant than any pattern match over its source. That argument
 * does not extend to `page.ts`, which is a hand-written template literal
 * with three interpolated values, one of them a filesystem path. So the
 * guard stays, in two complementary forms:
 *
 *  1. **{@link describe} "rendered output"** — no `` ` `` and no `${` in the
 *     HTML, for adversarial bootstrap values. This catches a leak, but only
 *     one a fixture happens to trigger.
 *  2. **{@link describe} "source guard"** — every `${…}` in `page.ts` is a
 *     call to `escapeHtml`, `escapeAttr` or `jsonScriptBody`. This is the
 *     stronger half: it fails on the commit that adds an unescaped
 *     interpolation, without anyone having to imagine the input that would
 *     exploit it.
 *
 * Test 1 alone is the trap the retired viewer fell into — a guard that
 * passes because nobody wrote the fixture that breaks it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_ELEMENT_ID, type Bootstrap } from "../../src/web/shared/wire";
import {
  contentSecurityPolicy,
  cspNonce,
  escapeAttr,
  escapeHtml,
  generateNonce,
  jsonScriptBody,
  NONCE_BYTES,
  renderPage,
} from "../../src/web/server/page";

const PAGE_SOURCE_PATH = new URL("../../src/web/server/page.ts", import.meta.url).pathname;

function bootstrap(over: Partial<Bootstrap> = {}): Bootstrap {
  return { cwd: "/tmp/repo", vaultRoot: "/home/u/.okf", session: "deadbeef", ...over };
}

/**
 * Bootstrap values built to break out of every context in the shell. Each
 * is something a real filesystem accepts as a directory name.
 */
const HOSTILE = [
  '</script><script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "</style><script>alert(1)</script>",
  "<!--<script>",
  "`${alert(1)}`",
  "'; alert(1); //",
  "\u2028\u2029",
  "&amp;<>\"'",
  "]]>",
  "</SCRIPT >",
];

// --- escaping -----------------------------------------------------------------

describe("escapeHtml", () => {
  const cases: Array<[input: string, expected: string]> = [
    ["plain", "plain"],
    ["<script>", "&lt;script&gt;"],
    ["a & b", "a &amp; b"],
    ['say "hi"', "say &quot;hi&quot;"],
    ["it's", "it&#39;s"],
    ["`tick`", "&#96;tick&#96;"],
    ["${x}", "&#36;{x}"],
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(escapeHtml(input)).toBe(expected);
    });
  }

  it("escapes the ampersand first, so entities are not double-decoded", () => {
    // "&lt;" must become "&amp;lt;", not "&lt;". Replacing "<" before "&"
    // would produce "&amp;" from an "&" we ourselves emitted.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("escapes backtick and dollar so the output guard has no exceptions", () => {
    // Neither is HTML-significant. They are escaped anyway so that finding
    // one in rendered output is unambiguous evidence of a raw interpolation
    // rather than a note title that happened to contain a code span.
    expect(escapeHtml("`")).not.toContain("`");
    expect(escapeHtml("${")).not.toContain("${");
  });

  it("is idempotent in the sense that matters: never emits a raw delimiter", () => {
    for (const value of HOSTILE) {
      const out = escapeHtml(value);
      expect(out).not.toMatch(/[<>"'`]/);
    }
  });
});

describe("escapeAttr", () => {
  it("closes every quoted-attribute breakout", () => {
    expect(escapeAttr('" onload="alert(1)')).toBe("&quot; onload=&quot;alert(1)");
    expect(escapeAttr("' onload='alert(1)")).toBe("&#39; onload=&#39;alert(1)");
  });
});

describe("jsonScriptBody", () => {
  it("round-trips through JSON.parse", () => {
    const value = { a: 1, b: "two", c: [3, null], d: { e: true } };
    expect(JSON.parse(jsonScriptBody(value))).toEqual(value);
  });

  it("escapes </script so the HTML parser cannot close the element early", () => {
    // This is the one that matters. The HTML tokenizer scans for `</script`
    // before the JSON parser ever runs, so a raw one terminates the block
    // and everything after it is parsed as markup.
    const out = jsonScriptBody({ cwd: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(JSON.parse(out)).toEqual({ cwd: "</script><script>alert(1)</script>" });
  });

  it("escapes <!-- , which opens an HTML comment with the same effect", () => {
    const out = jsonScriptBody({ x: "<!--" });
    expect(out).not.toContain("<!--");
    expect(JSON.parse(out).x).toBe("<!--");
  });

  it("escapes U+2028 and U+2029", () => {
    // Valid inside a JSON string, but line terminators in JavaScript source
    // — a hazard the moment this block is read by anything eval-adjacent.
    const out = jsonScriptBody({ x: "a\u2028b\u2029c" });
    expect(out).not.toContain("\u2028");
    expect(out).not.toContain("\u2029");
    expect(JSON.parse(out).x).toBe("a\u2028b\u2029c");
  });

  it("escapes backtick and dollar while staying parseable", () => {
    const out = jsonScriptBody({ x: "`${x}`" });
    expect(out).not.toContain("`");
    expect(out).not.toContain("${");
    expect(JSON.parse(out).x).toBe("`${x}`");
  });

  it("survives every hostile fixture", () => {
    for (const value of HOSTILE) {
      const out = jsonScriptBody({ value });
      expect(out).not.toMatch(/[<>`]/);
      expect(JSON.parse(out).value).toBe(value);
    }
  });
});

// --- nonce ---------------------------------------------------------------------

describe("generateNonce", () => {
  it("carries at least the 128 bits CSP requires", () => {
    expect(NONCE_BYTES).toBeGreaterThanOrEqual(16);
    // base64 of 16 bytes is 24 characters including padding.
    expect(generateNonce()).toHaveLength(24);
  });

  it("is unique across many calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(seen.size).toBe(200);
  });
});

describe("contentSecurityPolicy", () => {
  it("is the exact §5.2 policy", () => {
    expect(contentSecurityPolicy("N")).toBe(
      "default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; " +
        "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it("permits no inline, no eval, and no blob", () => {
    // The three concessions that would each, individually, undo the point of
    // having a CSP at all — and the three a careless dependency addition
    // asks for.
    const csp = contentSecurityPolicy(generateNonce());
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("blob:");
    expect(csp).not.toMatch(/https?:/);
    expect(csp).toContain("default-src 'none'");
  });
});

// --- rendering ------------------------------------------------------------------

describe("renderPage", () => {
  it("is the four-element shell §5.3 describes", () => {
    const { html } = renderPage({ bootstrap: bootstrap(), nonce: "NONCE" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<div id="app"');
    expect(html).toContain('<script nonce="NONCE" src="/app.js"></script>');
    expect(html).toContain(`<script type="application/json" id="${BOOTSTRAP_ELEMENT_ID}" nonce="NONCE">`);
    expect(html).toContain('<style nonce="NONCE">');
  });

  it("loads nothing from the network", () => {
    // `default-src 'none'` would block it anyway, but a remote reference in
    // the shell is a privacy leak at parse time and a broken page offline.
    const { html } = renderPage({ bootstrap: bootstrap() });
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(html).not.toMatch(/(?:src|href)=["']\/\//);
  });

  it("returns a CSP whose nonce is the one in the document", () => {
    // The single invariant that makes the whole scheme work: a mismatch
    // means the browser refuses to run our own script, silently.
    const page = renderPage({ bootstrap: bootstrap() });
    expect(page.csp).toContain(`'nonce-${page.nonce}'`);
    expect(page.html).toContain(`nonce="${page.nonce}"`);
  });

  it("mints a fresh nonce per response", () => {
    // Reuse would make the nonce a static secret that any successful
    // injection could read off the previous page and replay.
    const seen = new Set(Array.from({ length: 50 }, () => renderPage({ bootstrap: bootstrap() }).nonce));
    expect(seen.size).toBe(50);
  });

  it("uses every nonce it minted, in all three places", () => {
    const page = renderPage({ bootstrap: bootstrap() });
    const occurrences = page.html.split(`nonce="${page.nonce}"`).length - 1;
    expect(occurrences).toBe(3); // style, bootstrap JSON, app.js
  });

  it("embeds a bootstrap block that parses back to its input", () => {
    const boot = bootstrap({ cwd: "/x/y", vaultRoot: "/v", session: "abc123" });
    const { html } = renderPage({ bootstrap: boot, nonce: "N" });
    const start = html.indexOf('<script type="application/json"');
    const open = html.indexOf(">", start) + 1;
    const close = html.indexOf("</script>", open);
    expect(JSON.parse(html.slice(open, close))).toEqual(boot);
  });

  it("refuses a nonce that is not base64, rather than emitting it", () => {
    // A nonce reaching the CSP header cannot be HTML-escaped — `&quot;` in a
    // header is the literal six characters — so the only safe handling is a
    // character-set check. `;` would end the `script-src` directive early
    // and CR/LF would split the header; both are worse than a 500.
    expect(() => renderPage({ bootstrap: bootstrap(), nonce: '"><script>' })).toThrow(/base64/);
    expect(() => renderPage({ bootstrap: bootstrap(), nonce: "abc'; script-src *" })).toThrow(/base64/);
    expect(() => renderPage({ bootstrap: bootstrap(), nonce: "abc\r\nX-Evil: 1" })).toThrow(/base64/);
    expect(() => renderPage({ bootstrap: bootstrap(), nonce: "" })).toThrow(/base64/);
  });

  it("accepts every nonce it generates", () => {
    // The round trip: `cspNonce` must never reject `generateNonce`'s output,
    // including the padded forms base64 produces.
    for (let i = 0; i < 100; i += 1) {
      const nonce = generateNonce();
      expect(cspNonce(nonce)).toBe(nonce);
      expect(() => renderPage({ bootstrap: bootstrap(), nonce })).not.toThrow();
    }
  });

  describe("rendered output carries no template delimiters", () => {
    // Guard form 1 (§9): the invariant a reader can check on the output.
    for (const hostile of HOSTILE) {
      it(`for cwd = ${JSON.stringify(hostile)}`, () => {
        const { html } = renderPage({ bootstrap: bootstrap({ cwd: hostile }), nonce: "N" });
        expect(html).not.toContain("`");
        expect(html).not.toContain("${");
      });
      it(`for vaultRoot = ${JSON.stringify(hostile)}`, () => {
        const { html } = renderPage({ bootstrap: bootstrap({ vaultRoot: hostile }), nonce: "N" });
        expect(html).not.toContain("`");
        expect(html).not.toContain("${");
      });
      it(`for session = ${JSON.stringify(hostile)}`, () => {
        const { html } = renderPage({ bootstrap: bootstrap({ session: hostile }), nonce: "N" });
        expect(html).not.toContain("`");
        expect(html).not.toContain("${");
      });
    }

    it("never lets a hostile cwd close the app div or the script element", () => {
      const { html } = renderPage({
        bootstrap: bootstrap({ cwd: '"><script>alert(1)</script>' }),
        nonce: "N",
      });
      // Exactly two script elements: the JSON block and app.js. A third
      // means one of them was closed early and markup was injected.
      expect(html.match(/<script/g)).toHaveLength(2);
      expect(html.match(/<\/script>/g)).toHaveLength(2);
      expect(html).not.toContain("alert(1)</script>");
    });
  });
});

// --- the source guard --------------------------------------------------------

describe("source guard: every interpolation in page.ts is escaped", () => {
  const source = readFileSync(PAGE_SOURCE_PATH, "utf8");

  /** Strip comments — the module header legitimately discusses `${`. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  /**
   * The three sanitisers, one per context. `cspNonce` is the header-context
   * member: HTML escaping is wrong there, so it validates instead of
   * rewriting. An interpolation wrapped in none of these is the finding.
   */
  const ESCAPERS = ["escapeHtml", "escapeAttr", "jsonScriptBody", "cspNonce"];

  it("finds interpolations to check, so the guard is not vacuous", () => {
    // A guard that passes because it matched nothing is worse than no
    // guard: it reports safety it never established.
    expect([...code(source).matchAll(/\$\{([^}]*)\}/g)].length).toBeGreaterThan(0);
  });

  it("wraps every one of them in an escaper", () => {
    const offenders: string[] = [];
    for (const match of code(source).matchAll(/\$\{([^}]*)\}/g)) {
      const expression = (match[1] ?? "").trim();
      if (!ESCAPERS.some((fn) => expression.startsWith(`${fn}(`))) offenders.push(expression);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the only unescaped template in the module a nonce-free constant", () => {
    // THEME_CSS is a literal with no interpolation at all, which is what
    // makes it exempt. If it ever grows a `${`, the test above catches it.
    expect(source).toContain("const THEME_CSS");
    const theme = source.slice(source.indexOf("const THEME_CSS"), source.indexOf('].join("");'));
    expect(theme).not.toContain("${");
  });
});
