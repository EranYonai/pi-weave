/**
 * The note column: Markdown, sanitisation and wikilinks
 * (weave-workspace §1.2, §5.2, §10, P2.4).
 *
 * "Notes are the product" (§1.1), so this is the column the workspace is
 * actually for. It is also the only place in the client that turns content off
 * the disk into DOM, which makes it the only place with a genuine threat
 * model — so most of the length below is about that.
 *
 * ## The threat model, stated plainly
 *
 * The server is loopback-only and cookie-authenticated (§5.1), so this is not
 * about a remote attacker reaching the page. It is about *content*: a vault
 * note written by an agent, a `.okf` summary generated from a repository, or a
 * README in a repo someone cloned to look at. Any of those can contain
 * `<img src=x onerror=…>`, and a workspace whose whole premise is "point it at
 * an unfamiliar repository and read the knowledge" cannot treat that as
 * hypothetical. Rendering untrusted-ish local content into the DOM is exactly
 * the case §0 V5 chose DOMPurify for.
 *
 * ## Three independent layers, in order
 *
 * Each would be sufficient against the obvious attacks; they are stacked
 * because "sufficient against the attacks I thought of" is the assumption that
 * fails.
 *
 * 1. **Raw HTML never becomes HTML.** {@link markdownRenderer} overrides
 *    marked's `html` renderer to escape its input, so `<script>alert(1)</script>`
 *    in a note body reaches the DOM as the *text* `<script>alert(1)</script>`.
 *    marked removed its own `sanitize` option in v5 precisely in favour of
 *    this shape — the renderer, not the parser, is where the decision belongs.
 * 2. **Unsafe URL schemes are dropped at render.** {@link safeUrl} allows a
 *    short scheme allowlist and nothing else, so a `[a](javascript:alert(1))`
 *    link renders with no `href` at all rather than with a stripped one.
 * 3. **DOMPurify is the final gate.** {@link SANITIZE_CONFIG} is an explicit
 *    tag/attribute *allowlist* — not a denylist of known-bad — so anything
 *    layers 1 and 2 failed to anticipate still has to be on a list somebody
 *    wrote down. No `on*` handler is on it, and `script`, `iframe`, `object`,
 *    `embed`, `form` and `style` are not either.
 *
 * ## What the tests can and cannot prove
 *
 * §10 forbids a DOM test environment, and DOMPurify needs one — it is a
 * wrapper around `DOMParser` and refuses to run without it
 * (`DOMPurify.isSupported === false` under bare Node). So layer 3 cannot be
 * *executed* in this repository's test suite, and no amount of wanting it to
 * changes that.
 *
 * What the suite does instead is prove the two layers that are pure string
 * transforms, against hostile fixtures, and prove that layer 3 is wired
 * correctly: {@link renderNote} takes its sanitiser as a parameter, so a test
 * hands it a spy and asserts the HTML is passed through it with
 * {@link SANITIZE_CONFIG}, and asserts the config's contents directly. The
 * honest summary is: *the input to DOMPurify is already safe by construction
 * and that is tested; DOMPurify is configured strictly and wired as the last
 * step, and that is tested; DOMPurify's own behaviour is upstream's tested
 * property, not ours.*
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`. `marked` and `dompurify` are the two npm dependencies
 * this phase adds, both listed in `tests/web/tiers.test.ts`' client allowlist
 * and both already licence-cleared in `scripts/build-web.mjs` (§0.1). The
 * view-models come through `../../shared/view`; core is never imported
 * directly. No DOM *type* is named here either — {@link Purifier} and
 * {@link ClosestElement} are structural ports — which is what lets the root
 * `tsconfig.json` project compile the tests.
 */

import { Marked } from "marked";
import type { TokenizerAndRendererExtension, Tokens } from "marked";
import { relTime } from "../../shared/view";
import type { GraphPayload, ViewNote, WireGraphNode, WireNoteSource } from "../../shared/wire";
import { provenanceGlyph, provenanceTitle } from "../tree/tree.model";

// --- escaping ---------------------------------------------------------------------

/** The five HTML-significant characters. */
const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

type HtmlSpecial = keyof typeof HTML_ESCAPES;

/**
 * The character class matching exactly {@link HTML_ESCAPES}' keys.
 *
 * Built from the keys rather than written out a second time, which is what
 * justifies the cast in {@link escapeHtml}: the regex and the table cannot
 * disagree about which characters are special, because one is derived from the
 * other. All five are literal inside a character class, so no escaping is
 * needed to assemble it.
 */
const HTML_SPECIAL_RE = new RegExp(`[${Object.keys(HTML_ESCAPES).join("")}]`, "g");

/**
 * Escape a string for interpolation into HTML text or a quoted attribute.
 *
 * `src/web/server/page.ts` has a near-identical function and this is not
 * shared with it, deliberately: that one is server-tier and the client may not
 * import it, and promoting five characters into `src/web/shared/` to avoid
 * five lines would be a module whose only content is a table everyone already
 * knows. The duplication is bounded (it cannot grow — HTML will not acquire a
 * sixth significant character) and both copies are tested.
 *
 * Both quote styles are escaped even though every attribute below is
 * double-quoted, because the cost is nothing and the invariant "an escaped
 * string is safe in *any* attribute position" is much easier to hold in your
 * head than "safe in the positions I checked".
 *
 * The cast is sound and the usual `?? ch` fallback is deliberately absent:
 * {@link HTML_SPECIAL_RE} is generated from {@link HTML_ESCAPES}' own keys, so
 * a matched character is a key by construction. A fallback here would be a
 * branch that cannot be taken and therefore cannot be covered — the same
 * consideration as `tree.model.ts`' `idAt`, resolved by making the two
 * definitions share a source instead of by adding dead defensive code.
 */
export function escapeHtml(value: string): string {
  return value.replace(HTML_SPECIAL_RE, (ch) => HTML_ESCAPES[ch as HtmlSpecial]);
}

// --- URL safety -----------------------------------------------------------------------

/**
 * URL schemes a link or image in a note may use.
 *
 * An allowlist, and a short one. `javascript:` is the attack everyone knows;
 * `data:` is the one that gets forgotten, and `data:text/html,<script>…` in an
 * `href` is script execution with a friendlier spelling. `vbscript:` still
 * works in enough places to be worth naming. Rather than enumerate those, this
 * enumerates what a knowledge note legitimately needs.
 *
 * `mailto:` is included because notes cite people. `data:` is *not*, even for
 * images: an inline image is a legitimate thing to want, but it is also how a
 * large hostile payload gets past a size heuristic, and the CSP already allows
 * `img-src data:` for anything the client itself constructs.
 */
export const SAFE_SCHEMES: readonly string[] = ["http:", "https:", "mailto:"];

/**
 * A scheme-bearing prefix: letters, digits, `+`, `-`, `.`, then a colon.
 *
 * Matched against the value with **all** ASCII whitespace and control
 * characters removed first, which is the step naive implementations skip.
 * `java\tscript:alert(1)` and `java\u0000script:alert(1)` are both parsed as
 * `javascript:` by browsers, so a check against the raw string sees an
 * unrecognised scheme, decides it must be a relative path, and lets it
 * through. DOMPurify strips the same class of character for the same reason
 * (`ATTR_WHITESPACE` in its source).
 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const URL_NOISE_RE = /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g;

/**
 * The URL to put in an `href`/`src`, or `null` to emit none.
 *
 * Returning `null` rather than `"#"` or `"about:blank"` matters: an anchor
 * with no `href` is not a link, so it is not focusable, not announced as a
 * link, and cannot be middle-clicked into a new tab. A neutralised link that
 * still *looks* like a link is a link a user will keep trying to follow.
 *
 * A value with no scheme at all is a relative URL — `./diagram.png`,
 * `#heading` — and is allowed. That is not a hole: relative URLs resolve
 * against the loopback origin, which `connect-src 'self'` and
 * `img-src 'self'` already bound.
 */
export function safeUrl(raw: string): string | null {
  const bare = raw.replace(URL_NOISE_RE, "");
  const scheme = SCHEME_RE.exec(bare);
  if (scheme === null) return bare === "" ? null : raw;
  return SAFE_SCHEMES.includes(scheme[0].toLowerCase()) ? raw : null;
}

// --- resolving wikilinks ----------------------------------------------------------------

/**
 * The attribute a clickable wikilink carries.
 *
 * A `data-` attribute holding a **bare slug**, not a `note:` node id and not
 * an `href`. Three reasons, in increasing order of importance:
 *
 *  - An `href` would navigate. §1.1's rule is that selecting anything updates
 *    every column *in place*; a full page load is the opposite of that, and it
 *    would also throw away the SSE connection and the layout state.
 *  - `note:foo` reads as a URL with an unknown scheme, and DOMPurify's
 *    `IS_ALLOWED_URI` rejects unknown schemes in any attribute it does not
 *    consider inert. A bare slug sidesteps a fight with the sanitiser over a
 *    value that was never a URL. (Belt and braces: it is also declared
 *    URI-safe in {@link SANITIZE_CONFIG}, so the check is skipped outright.)
 *  - The component adds the `note:` prefix when it reads the attribute, so the
 *    node-id format lives in one place — `workspace.ts`'s `noteSlug` and this,
 *    which are inverses of each other.
 */
export const WIKILINK_ATTR = "data-weave-target";

/** Prefix core's graph builder gives note nodes. Mirrors `noteSlug`. */
const NOTE_PREFIX = "note:";

/**
 * Raw wikilink text → the slug of the note it names, for one graph.
 *
 * ## Why this is a lookup and not a slugifier
 *
 * Core resolves `[[Release Plan]]` by running it through `slugify` and
 * checking the result against the vault. The browser cannot call that
 * function: `src/core/slug.ts` is not among the modules `src/web/shared/view.ts`
 * re-exports, and it is not a view-model, so widening the door for it is out
 * of scope here (§2.1 requires each addition to come with its own purity
 * proof, in the commit that first needs it).
 *
 * The alternative — reimplementing `slugify` in the client — is the exact
 * drift §3 exists to prevent, and it would be *silently* wrong rather than
 * loudly wrong: core's version does an NFKD normalise and strips combining
 * marks, so a hand-rolled copy that skipped that would resolve `[[Café]]`
 * differently from the graph and every accented note would render as a ghost.
 *
 * So this resolves against the data instead. Every note node in the payload
 * contributes two keys — its title (the node's label) and its slug (the tail
 * of its node id) — each also under a case-folded spelling. A wikilink written
 * the way people actually write them, as either the title or the slug, hits
 * one of those exactly.
 *
 * ## The gap, named rather than hidden
 *
 * A spelling that is *neither* the title nor the slug but that `slugify`
 * happens to normalise onto one — `[[Release_Plan]]`, `[[release  plan]]` —
 * resolves in the graph and misses here. {@link isGhost} is what keeps that
 * from becoming a lie: a miss is only rendered as a ghost when the payload's
 * `dangling` map says this note *has* unresolved links. When it says the note
 * has none, a miss renders as ordinary text with no ghost styling, because the
 * one thing known for certain is that nothing in this note is unresolved.
 *
 * Closing the gap properly means promoting `slugify` through the door. That is
 * a one-line change to `src/web/shared/view.ts` plus an entry in
 * `NODE_FREE_CORE_MODULES` — cheap, but it is a change to a guarded boundary
 * and it belongs in its own reviewed commit rather than riding along here.
 */
export interface WikiIndex {
  /** Lookup key → slug. Keys are the raw title/slug and their case-folded forms. */
  readonly bySpelling: ReadonlyMap<string, string>;
  /** True when the note being rendered has at least one unresolved link. */
  readonly hasGhosts: boolean;
}

/** The empty index, for the render that happens before the graph arrives. */
export const EMPTY_WIKI_INDEX: WikiIndex = { bySpelling: new Map(), hasGhosts: false };

/** The slug inside a `note:<slug>` id, or `null` for any other node. */
export function slugOfNode(node: WireGraphNode): string | null {
  if (node.kind !== "note" || !node.id.startsWith(NOTE_PREFIX)) return null;
  const slug = node.id.slice(NOTE_PREFIX.length);
  return slug === "" ? null : slug;
}

/**
 * Build the index for rendering the note with slug `slug`.
 *
 * `slug` is only used to decide {@link WikiIndex.hasGhosts}; the spelling map
 * covers the whole vault, because a note links to other notes and not to
 * itself.
 */
export function wikiIndex(payload: GraphPayload | null, slug: string | null): WikiIndex {
  if (payload === null) return EMPTY_WIKI_INDEX;
  const bySpelling = new Map<string, string>();
  for (const node of payload.model.nodes) {
    const target = slugOfNode(node);
    if (target === null) continue;
    // Insertion order is node order and `set` overwrites, so a later note
    // whose title collides with an earlier one's slug wins. Collisions between
    // a title and a slug are vanishingly rare and either answer is defensible;
    // what matters is that it is deterministic, which node order makes it.
    for (const key of [target, node.label]) {
      bySpelling.set(key, target);
      bySpelling.set(key.toLowerCase(), target);
    }
  }
  const hasGhosts = slug !== null && (payload.dangling[slug]?.length ?? 0) > 0;
  return { bySpelling, hasGhosts };
}

/** The slug a wikilink points at, or `null` when nothing in the vault matches. */
export function resolveWikilink(index: WikiIndex, target: string): string | null {
  const trimmed = target.trim();
  return index.bySpelling.get(trimmed) ?? index.bySpelling.get(trimmed.toLowerCase()) ?? null;
}

/**
 * Whether an unresolved wikilink should be drawn as a ghost.
 *
 * See {@link WikiIndex}: only when the payload independently confirms this
 * note has unresolved links. Obsidian's ghost styling is an *offer to create
 * the note*, so showing it for a link that in fact resolves would be an offer
 * to create a note that already exists.
 */
export function isGhost(index: WikiIndex): boolean {
  return index.hasGhosts;
}

// --- the markdown renderer -------------------------------------------------------------

/** A `[[target|alias]]` token. */
export interface WikilinkToken extends Tokens.Generic {
  readonly type: "wikilink";
  readonly raw: string;
  readonly target: string;
  readonly alias: string;
}

/**
 * `[[target]]` and `[[target|alias]]`, matched at the start of the remaining
 * inline source.
 *
 * The character classes mirror `src/core/graph/wikilinks.ts`' `WIKILINK_RE`
 * exactly — no `[`, `]` or `|` in the target, anything but `]` in the alias —
 * so the browser tokenises the same spans of text the graph builder counted as
 * links. A looser rule here would draw link styling on text that produced no
 * edge; a tighter one would leave a real edge unlinked.
 */
const WIKILINK_RE = /^\[\[([^\][|]+)(?:\|([^\]]*))?\]\]/;

/** Where the next `[[` is, so marked can skip ahead. */
function wikilinkStart(src: string): number | undefined {
  const at = src.indexOf("[[");
  return at === -1 ? undefined : at;
}

/**
 * The `[[wikilink]]` inline extension.
 *
 * A real tokenizer rather than a regex pass over the rendered HTML, which is
 * the tempting shortcut and is wrong in both directions: it would rewrite
 * `[[not a link]]` inside a fenced code block, and it would miss nothing but
 * would corrupt any HTML attribute that happened to contain double brackets.
 * Tokenising means a wikilink inside a code span is left alone by
 * construction, because marked never offers the extension that text.
 */
function wikilinkExtension(index: WikiIndex): TokenizerAndRendererExtension {
  return {
    name: "wikilink",
    level: "inline",
    start: wikilinkStart,
    tokenizer(src: string) {
      return parseWikilink(src);
    },
    renderer(token) {
      return renderWikilinkToken(index, token);
    },
  };
}

/**
 * Render whatever marked hands the `wikilink` renderer.
 *
 * marked types extension tokens as `Tokens.Generic`, so the two fields the
 * tokenizer set arrive as `unknown` and have to be narrowed rather than
 * asserted — a renderer registered under a name is called for every token
 * carrying that `type`, and this module does not own the token stream.
 *
 * Split out of the extension object so the narrowing is directly testable:
 * reached only through `marked`, the non-string arm cannot occur, and an
 * uncoverable branch in the middle of the rendering path is exactly what the
 * 95 % gate is meant to stop accumulating.
 */
export function renderWikilinkToken(index: WikiIndex, token: Tokens.Generic): string {
  const target = typeof token["target"] === "string" ? token["target"] : "";
  const alias = typeof token["alias"] === "string" ? token["alias"] : "";
  return renderWikilink(index, target, alias);
}

/**
 * Tokenise a leading `[[target]]` / `[[target|alias]]`, or `undefined`.
 *
 * Split out of the extension so it is directly testable: reaching it through
 * `marked` means every assertion about the token shape has to be made
 * indirectly through rendered HTML, and the `alias`-absent case in particular
 * is invisible that way.
 *
 * `target` needs no fallback — group 1 is not optional in
 * {@link WIKILINK_RE}, so a match guarantees it. `alias` genuinely can be
 * absent (`[[target]]` has no `|`), and `""` is the right value for it: the
 * renderer's rule is "show the alias, or the target when there is no alias".
 */
export function parseWikilink(src: string): WikilinkToken | undefined {
  const match = WIKILINK_RE.exec(src);
  if (match === null) return undefined;
  return { type: "wikilink", raw: match[0], target: match[1] as string, alias: match[2] ?? "" };
}

/**
 * One wikilink, as HTML.
 *
 * Exported because it is the security-relevant half of the extension and
 * deserves direct tests: the target and the alias both come from a note body
 * and both are interpolated into markup, one into an attribute and one into
 * text.
 *
 * A resolved link is an `<a>` with no `href` — see {@link WIKILINK_ATTR} — plus
 * `role="link"` and `tabIndex` so that removing the `href` does not also
 * remove it from the keyboard order. A ghost is a `<span>`, not a disabled
 * anchor: it is not a link, it is a name with no note behind it, and marking
 * it up as a link that refuses to work is worse than not marking it up at all.
 */
export function renderWikilink(index: WikiIndex, target: string, alias: string): string {
  const text = escapeHtml((alias === "" ? target : alias).trim());
  // Nothing to show and nothing to link to. `WIKILINK_RE` requires at least
  // one character, so this is unreachable through the tokenizer — but
  // `renderWikilinkToken` accepts whatever token stream marked hands it, and
  // an empty ghost span is a hoverable nothing rather than an affordance.
  if (text === "") return "";
  const slug = resolveWikilink(index, target);
  if (slug !== null) {
    return `<a class="weave-wiki" ${WIKILINK_ATTR}="${escapeHtml(slug)}" role="link" tabindex="0" title="${escapeHtml(target.trim())}">${text}</a>`;
  }
  if (!isGhost(index)) return text;
  return `<span class="weave-wiki weave-wiki-ghost" title="no note named ${escapeHtml(target.trim())}">${text}</span>`;
}

/**
 * A `Marked` configured for one render.
 *
 * Rebuilt per render rather than held at module scope, because the wikilink
 * renderer closes over the index and the index depends on which note is open.
 * A module-level instance would need a mutable "current index" global, which
 * is a data race waiting for the first time two renders interleave.
 *
 * `async: false` is explicit so `parse` is typed as returning a `string`
 * rather than `string | Promise<string>`; nothing here is asynchronous.
 */
export function markdownRenderer(index: WikiIndex): Marked {
  return new Marked({
    gfm: true,
    async: false,
    extensions: [wikilinkExtension(index)],
    renderer: {
      /**
       * Layer 1. Raw HTML in a note body is rendered as **text**.
       *
       * This is the single highest-value line in the file. marked passes
       * through inline and block HTML verbatim by default, so without this
       * override `<img src=x onerror=alert(1)>` reaches DOMPurify as an actual
       * element and the whole question becomes "is DOMPurify's configuration
       * perfect". With it, that string is never markup in the first place.
       *
       * The cost is that a note using `<kbd>` or `<sub>` sees the tag rather
       * than the effect. That is the correct trade for a read-only workspace
       * over content an agent may have written, and it is also what a reader
       * needs in order to notice that a note contains markup at all.
       */
      html({ text }) {
        return escapeHtml(text);
      },
      /** Layer 2, for links. An unsafe scheme yields no `href`. */
      link({ href, title, tokens }) {
        const url = safeUrl(href);
        const text = this.parser.parseInline(tokens);
        const attrs = [
          url === null ? "" : ` href="${escapeHtml(url)}"`,
          title === null || title === undefined || title === "" ? "" : ` title="${escapeHtml(title)}"`,
          // A note that links out is linking out of the workspace, and the
          // workspace is the only thing in this tab worth keeping.
          url === null ? "" : ' rel="noreferrer noopener" target="_blank"',
        ].join("");
        return `<a${attrs}>${text}</a>`;
      },
      /** Layer 2, for images. An unsafe scheme yields the alt text alone. */
      image({ href, title, text }) {
        const url = safeUrl(href);
        if (url === null) return escapeHtml(text);
        const titleAttr = title === null || title === undefined || title === "" ? "" : ` title="${escapeHtml(title)}"`;
        return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${titleAttr}>`;
      },
    },
  });
}

/** Markdown → HTML, **before** sanitisation. Exported so layer 1 is testable. */
export function renderMarkdown(body: string, index: WikiIndex): string {
  return markdownRenderer(index).parse(body, { async: false });
}

// --- sanitisation --------------------------------------------------------------------------

/** The slice of DOMPurify this module uses. The real one satisfies it. */
export interface Purifier {
  sanitize(dirty: string, config: SanitizeConfig): string;
}

/**
 * The subset of DOMPurify's config object {@link SANITIZE_CONFIG} sets.
 *
 * The arrays are `string[]` and not `readonly string[]`, which looks like the
 * wrong choice for a security-critical constant and is forced: DOMPurify's own
 * `Config` declares them mutable, so a `readonly` here makes the real
 * `sanitize` unassignable to {@link Purifier} and the only way through is a
 * cast — trading a real type check for a cosmetic one.
 *
 * Immutability is therefore enforced where it actually holds, at runtime:
 * {@link SANITIZE_CONFIG} and each of its arrays are frozen by {@link frozen},
 * so a `push("script")` from anywhere throws in strict mode (which every ES
 * module is) rather than silently widening the allowlist. That is a stronger
 * property than the `readonly` would have given, since `readonly` erases at
 * compile time and this does not.
 */
export interface SanitizeConfig {
  readonly ALLOWED_TAGS: string[];
  readonly ALLOWED_ATTR: string[];
  readonly ADD_URI_SAFE_ATTR: string[];
  readonly ALLOW_DATA_ATTR: boolean;
  readonly ALLOW_ARIA_ATTR: boolean;
  readonly ALLOW_UNKNOWN_PROTOCOLS: boolean;
  readonly USE_PROFILES: { readonly html: true };
}

/**
 * Layer 3: what survives sanitisation.
 *
 * An **allowlist**, which is the whole point. A denylist (`FORBID_TAGS: […]`)
 * is a list of the attacks its author had heard of, and the interesting ones
 * are always the others — `<math>`/`<svg>` mXSS, `<template>`, mutation
 * gadgets. Everything below is a tag marked can actually emit for the
 * Markdown a note is allowed to contain, and nothing else exists.
 *
 * Absent and deliberately so: `script`, `iframe`, `object`, `embed`, `form`,
 * `input` other than the GFM task-list checkbox, `style`, `svg`, `math`,
 * `template`, `base`, `link`, `meta`. Note that a `<style>` block would be
 * blocked by `style-src 'nonce-…'` as well (§5.2), so that one is defended
 * twice over.
 *
 * `ALLOWED_ATTR` contains no `on*` handler, which is what makes
 * `<img src=x onerror=alert(1)>` inert even in the world where layer 1 has
 * been removed: `onerror` is not on the list, so DOMPurify drops the attribute
 * and keeps the element. It also contains no `style`, so a CSS-based overlay
 * attack has no attribute to live in.
 *
 * `ALLOW_DATA_ATTR: false` with {@link WIKILINK_ATTR} named explicitly is
 * narrower than leaving data attributes on: the only `data-` attribute that
 * may exist in rendered output is the one this module writes.
 * `ADD_URI_SAFE_ATTR` then tells DOMPurify that the attribute's value is not a
 * URL and must not be run through `IS_ALLOWED_URI` — without it a slug like
 * `note-2` is fine but the check is being applied to a value that was never a
 * URL, and relying on a URL grammar to accept a non-URL is the kind of
 * accidental pass that stops being true in a patch release.
 *
 * `ALLOW_UNKNOWN_PROTOCOLS: false` is DOMPurify's default and is stated anyway,
 * because it is the setting that would silently re-admit `javascript:` if some
 * future config merge turned it on.
 */
/**
 * `Object.freeze` that keeps the value's declared type.
 *
 * The built-in signature returns `Readonly<T>`, which turns `string[]` into
 * `readonly string[]` and then will not satisfy DOMPurify's `Config` — see
 * {@link SanitizeConfig}. This freezes just as hard and says so in a way the
 * compiler can still hand to `sanitize`.
 */
function frozen<T>(value: T): T {
  return Object.freeze(value);
}

export const SANITIZE_CONFIG: SanitizeConfig = frozen({
  ALLOWED_TAGS: frozen([
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "em",
    "strong",
    "del",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "a",
    "span",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "input",
  ]),
  ALLOWED_ATTR: frozen([
    "href",
    "src",
    "alt",
    "title",
    "class",
    "role",
    "tabindex",
    "colspan",
    "rowspan",
    "align",
    "type",
    "checked",
    "disabled",
    "start",
    WIKILINK_ATTR,
  ]),
  ADD_URI_SAFE_ATTR: frozen([WIKILINK_ATTR]),
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  USE_PROFILES: frozen({ html: true as const }),
});

/**
 * Markdown → sanitised HTML.
 *
 * The sanitiser is a parameter rather than a module-level `import DOMPurify`
 * call for the same reason `fetch` is injected into `api.ts`: it is the one
 * thing in this file that cannot run in the test environment, so isolating it
 * behind a port keeps everything else covered. `Note.tsx` passes the real
 * DOMPurify; a test passes a spy and asserts that the pre-sanitiser HTML is
 * what gets handed over, with {@link SANITIZE_CONFIG}.
 */
export function renderNote(purify: Purifier, body: string, index: WikiIndex): string {
  return purify.sanitize(renderMarkdown(body, index), SANITIZE_CONFIG);
}

// --- reading a click back out of the DOM --------------------------------------------------

/** The slice of `Element` {@link wikilinkTargetOf} walks. `HTMLElement` satisfies it. */
export interface ClosestElement {
  getAttribute(name: string): string | null;
  readonly parentElement: ClosestElement | null;
}

/**
 * Depth limit for the ancestor walk.
 *
 * A malformed or adversarial DOM with a parent cycle would otherwise spin
 * forever inside a click handler and hang the tab. Markdown nesting is a
 * handful of levels; 32 is far past anything real.
 */
const MAX_ANCESTOR_WALK = 32;

/**
 * The node id a click landed on, or `null`.
 *
 * One delegated listener on the container rather than a listener per link:
 * the body is re-rendered wholesale whenever the note changes, and per-element
 * handlers on `dangerouslySetInnerHTML` output would have to be re-attached by
 * hand every time — which is the sort of thing that works until the day it
 * leaks. The walk is needed because the click target is usually the text node's
 * parent (`<em>`, `<code>`) rather than the anchor itself.
 *
 * Returns a full `note:` node id, not a slug, so the caller can hand it
 * straight to the §1.3 context bus without knowing the id format.
 */
export function wikilinkTargetOf(from: ClosestElement | null): string | null {
  let node = from;
  for (let depth = 0; node !== null && depth < MAX_ANCESTOR_WALK; depth++) {
    const slug = node.getAttribute(WIKILINK_ATTR);
    if (slug !== null && slug !== "") return `${NOTE_PREFIX}${slug}`;
    node = node.parentElement;
  }
  return null;
}

// --- the front-matter header --------------------------------------------------------------

/** The note header: title, provenance badge, relative time, tags. */
export interface NoteHeaderView {
  readonly title: string;
  readonly slug: string;
  readonly provenance: WireNoteSource;
  readonly provenanceGlyph: string;
  readonly provenanceTitle: string;
  readonly updated: string;
  /** The ISO string, for a `<time datetime=…>` and the `title=` tooltip. */
  readonly updatedIso: string;
  readonly created: string;
  readonly createdIso: string;
  readonly tags: readonly string[];
}

/**
 * Resolve a note's front matter for display.
 *
 * The provenance badge reuses the tree's glyphs rather than declaring a second
 * vocabulary — AGENTS.md rule 4 is about the *reader* being able to tell
 * agent-written content apart, and a reader who has learned `◐` in the tree
 * should not have to learn a different mark two columns to the right.
 *
 * `now` is injected, per AGENTS.md, so `"12m ago"` is a tested value rather
 * than whatever the clock said when the suite ran.
 */
export function noteHeader(note: ViewNote, now: number): NoteHeaderView {
  return {
    title: note.title,
    slug: note.slug,
    provenance: note.source,
    provenanceGlyph: provenanceGlyph(note.source),
    provenanceTitle: provenanceTitle(note.source),
    updated: relTime(note.updated, now),
    updatedIso: note.updated,
    created: relTime(note.created, now),
    createdIso: note.created,
    tags: note.tags,
  };
}

/** `#architecture`. The `#` is display only — tags are stored bare. */
export function tagLabel(tag: string): string {
  return `#${tag}`;
}

// --- empty states ----------------------------------------------------------------------------

/**
 * What the column says when it has no note to render.
 *
 * The three cases are genuinely different and a single "nothing selected"
 * message for all of them is how a user concludes the app is broken when they
 * click a module and the reading pane does not change.
 */
export function noteEmptyMessage(selectedId: string | null, note: ViewNote | null): string | null {
  if (note !== null) return null;
  if (selectedId === null) return "Nothing open — search with ⌘K, or walk the tree with j and k.";
  if (selectedId.startsWith(NOTE_PREFIX)) return "Loading…";
  // A module, a file, a package, the git state: real nodes with no prose
  // behind them. The context rail beside this column is where their
  // relationships live, so the message points at it rather than apologising.
  return "This node has no note body — see the context rail for what it connects to.";
}
