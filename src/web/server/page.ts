/**
 * The HTML shell (weave-workspace §5.2, §5.3, §9).
 *
 * Four elements and nothing else: a nonce'd `<style>` carrying the CSS
 * variable theme, `<div id="app">`, a nonce'd JSON bootstrap block, and
 * `<script nonce src="/app.js">`. All behaviour lives in the committed
 * bundle; this file exists to deliver a nonce, a CSP header and three
 * strings of context.
 *
 * ## Why the no-backtick guard survived the rewrite
 *
 * §9 retired the *source* guard for `dist/app.js` in favour of a stronger
 * invariant — `build:web:check` byte-compares the committed bundle against a
 * fresh build, so the shipped artifact provably matches its source. That
 * argument does not transfer here, because this file is not generated: it is
 * a template literal into which `cwd`, `vaultRoot` and a session id are
 * interpolated, and it is therefore still an injection surface. A vault path
 * containing `</script>` is not a hypothetical — it is one `mkdir` away.
 *
 * So the guard stays, in two forms, both in `tests/web/page.test.ts`:
 *
 *  1. **Output**: the rendered page contains no `` ` `` and no `${`. Every
 *     escaper below emits those as numeric entities or `\u` escapes, so a
 *     hit means an interpolation reached the output raw.
 *  2. **Source**: every `${…}` in this file's template is a call to one of
 *     {@link escapeHtml}, {@link escapeAttr} or {@link jsonScriptBody}. This
 *     is the stronger half — the output guard can only catch a leak that a
 *     *test fixture* happens to trigger, while the source guard catches the
 *     unescaped interpolation itself, on the commit that adds it.
 *
 * ## CSP
 *
 * `default-src 'none'` and a per-response nonce. Nothing loads that we did
 * not name: no `'unsafe-inline'`, no `'unsafe-eval'`, no `blob:`, no remote
 * origin. `connect-src 'self'` is what permits `/api/*` and the `/events`
 * stream; `frame-ancestors 'none'` means no page can embed us, which
 * matters because a framed workspace plus a stolen click is a way to reach
 * `POST /api/open`.
 *
 * The nonce is fresh per response (16 bytes). Reuse across responses would
 * make it a static secret that any successful injection could simply read
 * from the previous page and replay.
 */

import { randomBytes } from "node:crypto";
import { LOGO_MARK_B64, LOGO_MARK_MIME } from "../shared/logo";
import type { Bootstrap } from "../shared/wire";
import { BOOTSTRAP_ELEMENT_ID } from "../shared/wire";

/** Nonce entropy, in bytes. 128 bits — CSP requires ≥ 128. */
export const NONCE_BYTES = 16;

/** A fresh per-response CSP nonce. */
export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64");
}

/**
 * A nonce, validated for use inside a CSP header.
 *
 * The third escaper, and the odd one out: HTML escaping is *wrong* here,
 * because a `&quot;` in a header value is a literal `&quot;`, not a quote.
 * What a header needs is a character-set check — a nonce containing `;`,
 * `'`, CR or LF would either terminate the directive early (turning
 * `script-src` into something permissive) or split the header outright.
 *
 * Base64 is a strict subset of what CSP's `base64-value` grammar allows, so
 * requiring it costs nothing and makes the failure loud. It throws rather
 * than sanitising: a nonce that is not base64 did not come from
 * {@link generateNonce}, and quietly repairing it would hide the bug that
 * produced it.
 */
export function cspNonce(nonce: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)) throw new Error("pi-weave: CSP nonce must be base64");
  return nonce;
}

/**
 * The §5.2 policy, bound to one nonce.
 *
 * Emitted as a single line with `; ` separators. `tests/web/routes.test.ts`
 * asserts the exact string — a policy that drifts silently is a policy that
 * has already stopped protecting anything.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${cspNonce(nonce)}'`,
    `style-src 'nonce-${cspNonce(nonce)}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// --- escaping ----------------------------------------------------------------

/**
 * The five HTML-significant characters, plus `` ` `` and `$`.
 *
 * The last two are not HTML-significant and are escaped anyway, to keep the
 * output guard above meaningful: if `` ` `` can never appear in rendered
 * output, then finding one is unambiguous evidence of a raw interpolation
 * rather than a false positive from a note title that happened to contain a
 * code span. `&#96;` and `&#36;` render identically to the user.
 */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  $: "&#36;",
};

/**
 * The character class matching exactly {@link HTML_ESCAPES}' keys.
 *
 * Derived from the map rather than written twice, so the two cannot drift —
 * a key added to the map without a matching regex edit would be a character
 * that silently stops being escaped, which is the quietest possible way to
 * introduce an XSS.
 */
const HTML_ESCAPE_PATTERN = new RegExp(
  // Built by concatenation rather than a template literal so the source
  // guard in `tests/web/page.test.ts` stays absolute: *every* `${…}` in this
  // file is an escaper call, with no exemptions to remember.
  "[" + Object.keys(HTML_ESCAPES).map((ch) => "\\" + ch).join("") + "]",
  "g",
);

/** Escape a value for HTML text content. */
export function escapeHtml(value: string): string {
  // The regex is built from the map's keys, so every match has an entry.
  // Asserted rather than left as a `?? ch` fallback, which would be a dead
  // branch dressed up as safety — and one that fails *open*, emitting the
  // raw character it was supposed to escape.
  return value.replace(HTML_ESCAPE_PATTERN, (ch) => HTML_ESCAPES[ch] as string);
}

/**
 * Escape a value for a double-quoted attribute.
 *
 * Identical to {@link escapeHtml} today — the set of characters that can
 * break out of a quoted attribute is a subset of the set that can break out
 * of text. Kept as a distinct name because the *call site* documents intent,
 * and because an attribute-specific rule (escaping whitespace, for unquoted
 * attributes) is the obvious future divergence.
 */
export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/**
 * Serialize a value for embedding inside `<script type="application/json">`.
 *
 * `JSON.stringify` alone is **not** safe here. The HTML parser looks for
 * `</script` inside a script element before the JSON parser ever sees the
 * bytes, so a string containing it terminates the element early and
 * everything after is parsed as markup. `<!--` opens an HTML comment with
 * the same effect. Escaping `<` and `>` to `\u003c` / `\u003e` closes both,
 * and is transparent to `JSON.parse`.
 *
 * `&`, `` ` `` and `$` follow for the same reason as in {@link HTML_ESCAPES}:
 * so the output guard has no legitimate exceptions to carve out.
 *
 * U+2028 and U+2029 are escaped because they are valid in JSON strings but
 * are line terminators in JavaScript source — a hazard if this block is ever
 * read with `eval`-adjacent machinery rather than `JSON.parse`.
 */
export function jsonScriptBody(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&`$\u2028\u2029]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

// --- rendering ---------------------------------------------------------------

export interface RenderPageOptions {
  bootstrap: Bootstrap;
  /** Defaults to a fresh {@link generateNonce}. Injectable for tests. */
  nonce?: string;
}

export interface RenderedPage {
  html: string;
  nonce: string;
  /** The exact `Content-Security-Policy` header value for this response. */
  csp: string;
}

/**
 * The theme, as CSS custom properties.
 *
 * A constant, never interpolated, so it cannot carry user input. It stays in
 * the shell rather than the bundle so the first paint has a background
 * colour before `app.js` parses — a dark-mode user should not get a white
 * flash while 21 KB of JavaScript loads.
 */
const THEME_CSS = [
  ":root{color-scheme:light dark;",
  "--weave-bg:#f8ede3;--weave-fg:#43303a;--weave-dim:#7c6257;",
  "--weave-line:#dfd3c3;--weave-accent:#85586f;--weave-warn:#a05a1c;",
  "--weave-mono:ui-monospace,SFMono-Regular,Menlo,monospace;",
  "--weave-sans:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}",
  "@media(prefers-color-scheme:dark){:root{",
  "--weave-bg:#2a2f4f;--weave-fg:#fde2f3;--weave-dim:#bb9ecf;",
  "--weave-line:#3b4266;--weave-accent:#b79fdd;--weave-warn:#e8b04c}}",
  "*{box-sizing:border-box}",
  "html,body{height:100%}",
  "body{margin:0;background:var(--weave-bg);color:var(--weave-fg);",
  "font-family:var(--weave-sans);font-size:14px;line-height:1.5}",
  "#app{height:100%;display:flex;flex-direction:column}",
].join("");

/**
 * Render the shell.
 *
 * Returns the nonce and the CSP alongside the HTML rather than setting a
 * header itself: the caller owns the response, and coupling a renderer to
 * `ServerResponse` would make it untestable without a socket. The invariant
 * that the header and the document agree on the nonce is held by
 * `routes.ts`, which receives both from this one call.
 */
export function renderPage(opts: RenderPageOptions): RenderedPage {
  const nonce = opts.nonce ?? generateNonce();
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    "<title>pi-weave workspace</title>",
    `<link rel="icon" type="image/png" href="data:${escapeAttr(LOGO_MARK_MIME)};base64,${escapeAttr(LOGO_MARK_B64)}">`,
    `<style nonce="${escapeAttr(nonce)}">`,
    THEME_CSS,
    "</style>",
    "</head>",
    "<body>",
    `<div id="app" data-cwd="${escapeAttr(opts.bootstrap.cwd)}">`,
    "<noscript>pi-weave needs JavaScript. Use <code>/weave-view tui</code> instead.</noscript>",
    "</div>",
    `<script type="application/json" id="${escapeAttr(BOOTSTRAP_ELEMENT_ID)}" nonce="${escapeAttr(nonce)}">`,
    jsonScriptBody(opts.bootstrap),
    "</script>",
    `<script nonce="${escapeAttr(nonce)}" src="/app.js"></script>`,
    "</body>",
    "</html>",
  ].join("\n");

  return { html, nonce, csp: contentSecurityPolicy(nonce) };
}
