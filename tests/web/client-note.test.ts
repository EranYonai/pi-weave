/**
 * The note column's pure model (weave-workspace §1.2, §5.2, §10, P2.4).
 *
 * ## What this suite is really for
 *
 * Two of the three sanitisation layers in `note.model.ts` are pure string
 * transforms, and this is where they are proven against hostile input. That
 * matters more than the usual coverage argument: this is the only place in the
 * client where content off the disk becomes DOM, and "a malicious note or repo
 * is a real threat model" is a design constraint, not a hypothetical.
 *
 * ## What it deliberately does not do
 *
 * It does not execute DOMPurify. DOMPurify wraps `DOMParser` and reports
 * `isSupported === false` under bare Node, and §10 forbids adding a DOM test
 * environment. So layer 3 is covered by *wiring* assertions — the HTML handed
 * to it, the config it is handed — plus direct assertions on the allowlist's
 * contents. The claim these tests support is precise: **the input DOMPurify
 * receives is already inert, and DOMPurify is configured strictly and called
 * last.** Whether DOMPurify itself is correct is upstream's property.
 *
 * Every "hostile fixture" below is therefore run against layers 1 and 2 and
 * asserted to produce no live markup *before* the sanitiser is even reached.
 * That is the stronger claim of the two, since it does not depend on the
 * sanitiser's configuration being right.
 */

import { describe, expect, it } from "vitest";
import type { GraphPayload, ViewNote, WireGraphNode } from "../../src/web/shared/wire";
import {
  EMPTY_WIKI_INDEX,
  SAFE_SCHEMES,
  SANITIZE_CONFIG,
  WIKILINK_ATTR,
  escapeHtml,
  isGhost,
  noteEmptyMessage,
  noteHeader,
  parseWikilink,
  renderMarkdown,
  renderNote,
  renderWikilink,
  renderWikilinkToken,
  resolveWikilink,
  safeUrl,
  slugOfNode,
  tagLabel,
  wikiIndex,
  wikilinkTargetOf,
} from "../../src/web/client/note/note.model";
import type { ClosestElement, Purifier } from "../../src/web/client/note/note.model";

// --- fixtures -------------------------------------------------------------------------

function noteNode(slug: string, title: string): WireGraphNode {
  return { id: `note:${slug}`, kind: "note", label: title, provenance: "human", detail: {} };
}

function payloadOf(nodes: WireGraphNode[], dangling: Record<string, string[]> = {}): GraphPayload {
  return {
    model: { generatedAt: "2026-03-04T09:00:00Z", staleness: null, nodes, edges: [], contentDigest: "" },
    tags: {},
    dangling,
    positions: null,
    stamp: "2026-03-04T09:00:00Z",
  };
}

const GRAPH = payloadOf(
  [
    noteNode("release-plan", "Release Plan"),
    noteNode("graph-architecture", "Graph Architecture"),
    { id: "repository", kind: "repository", label: "pi-weave", provenance: null, detail: {} },
  ],
  { "release-plan": ["ghost-note"] },
);

const NOTE: ViewNote = {
  slug: "release-plan",
  title: "Release Plan",
  body: "# Plan\n\nSee [[Graph Architecture]].",
  created: "2026-03-01T09:00:00Z",
  updated: "2026-03-04T08:00:00Z",
  tags: ["architecture", "viewer"],
  source: "agent",
};

const NOW = Date.parse("2026-03-04T09:00:00Z");

/**
 * The hostile corpus.
 *
 * Each is something a note body could plausibly contain — written by an agent
 * that was prompt-injected, or sitting in a README of a repository someone
 * cloned to look at. The assertion applied to all of them is the same: after
 * layers 1 and 2, and *before* DOMPurify, the output contains no executable
 * markup.
 */
const HOSTILE: ReadonlyArray<readonly [name: string, markdown: string]> = [
  ["inline event handler", "<img src=x onerror=alert(1)>"],
  ["script element", "<script>alert(1)</script>"],
  ["javascript: link", "[click me](javascript:alert(1))"],
  ["javascript: with a tab inside the scheme", "[click me](java\tscript:alert(1))"],
  ["javascript: with a NUL inside the scheme", "[click me](java\u0000script:alert(1))"],
  ["javascript: with a newline inside the scheme", "[click me](java\nscript:alert(1))"],
  ["uppercase JavaScript:", "[click me](JaVaScRiPt:alert(1))"],
  ["javascript: in an image", "![x](javascript:alert(1))"],
  ["data: URL html payload", "[x](data:text/html,<script>alert(1)</script>)"],
  ["vbscript: link", "[x](vbscript:msgbox(1))"],
  ["svg onload", "<svg onload=alert(1)></svg>"],
  ["iframe", '<iframe src="javascript:alert(1)"></iframe>'],
  ["style block", "<style>body{background:url(javascript:alert(1))}</style>"],
  ["form with a formaction", '<form><button formaction="javascript:alert(1)">go</button></form>'],
  ["object element", '<object data="javascript:alert(1)"></object>'],
  ["div with onclick", '<div onclick="evil()">block</div>'],
  ["mXSS-style nesting", "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">"],
  ["quote break out of a title", '[x](https://ok.example "a\\" onmouseover=\\"alert(1)")'],
  ["html in a wikilink target", '[[<img src=x onerror=alert(1)>]]'],
  ["html in a wikilink alias", "[[Release Plan|<script>alert(1)</script>]]"],
  ["base tag", '<base href="https://evil.example/">'],
  ["meta refresh", '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
];

/**
 * One parsed tag: its name and its attributes.
 *
 * ## Why the detector tokenises instead of pattern-matching
 *
 * The first version of {@link liveMarkup} was a list of regexes over the whole
 * document, and it reported two false positives — which is worth recording,
 * because the lesson generalises. Given the hostile fixture
 * `[[<img src=x onerror=alert(1)>]]`, the renderer correctly produces
 *
 * ```html
 * <span class="weave-wiki-ghost" title="no note named &lt;img src=x onerror=alert(1)&gt;">
 * ```
 *
 * — fully escaped and completely inert. But `/<[^>]*\son[a-z]+=/` matches it,
 * because `[^>]*` happily runs *through* the opening quote and finds
 * ` onerror=` inside the title's text. The same thing happened to
 * `title="a&quot; onmouseover=&quot;alert(1)"`, where the attacker's quote had
 * been escaped to `&quot;` and therefore did not break out at all.
 *
 * A detector that cannot tell "an attribute" from "text that looks like one
 * inside a quoted value" is testing the wrong thing in both directions: it
 * fails on safe output, and it would equally pass unsafe output that avoided
 * its patterns. Attribute-vs-text is a *parsing* distinction, so the detector
 * parses. Roughly thirty lines, and it makes the assertion mean what it says.
 */
interface ParsedTag {
  readonly name: string;
  readonly attrs: ReadonlyArray<readonly [name: string, value: string]>;
}

/** Tag name and raw attribute text, respecting quotes when finding the `>`. */
const TAG_RE = /<(\/?)([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
/** One attribute: a name, and a double-quoted, single-quoted or bare value. */
const ATTR_RE = /([a-z_:][a-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/gi;

/** Every element in a document, with its attributes. Entities are not markup. */
function parseTags(html: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  for (const tag of html.matchAll(TAG_RE)) {
    const attrs: Array<readonly [string, string]> = [];
    for (const attr of (tag[3] ?? "").matchAll(ATTR_RE)) {
      attrs.push([(attr[1] ?? "").toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? ""]);
    }
    tags.push({ name: (tag[2] ?? "").toLowerCase(), attrs });
  }
  return tags;
}

/** Elements that execute, embed, restyle or redirect. */
const DANGEROUS_TAGS = ["script", "iframe", "object", "embed", "form", "style", "svg", "math", "base", "meta", "link", "template"];

/** Attributes whose value a browser resolves as a URL. */
const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href", "data"];

/** Schemes that execute. Compared after stripping what a browser strips. */
const DANGEROUS_SCHEMES = ["javascript:", "vbscript:", "data:"];

/**
 * Anything in `html` that would execute, embed, or navigate somewhere
 * unexpected — as a list of findings, so a failure names what it found.
 *
 * Applied to **pre-sanitiser** output. That is deliberate: it means the
 * assertion holds independently of DOMPurify's configuration being right,
 * which is the property defence in depth is supposed to buy.
 */
function liveMarkup(html: string): string[] {
  const found: string[] = [];
  for (const tag of parseTags(html)) {
    if (DANGEROUS_TAGS.includes(tag.name)) found.push(`element <${tag.name}>`);
    for (const [name, value] of tag.attrs) {
      if (/^on[a-z]+$/.test(name)) found.push(`event handler ${name}=`);
      if (!URL_ATTRS.includes(name)) continue;
      // Browsers strip ASCII whitespace and controls before parsing a scheme,
      // so `java\tscript:` is `javascript:`. Compare the way they do.
      const bare = value.replace(/[\u0000-\u0020\u00a0]/g, "").toLowerCase();
      for (const scheme of DANGEROUS_SCHEMES) if (bare.startsWith(scheme)) found.push(`${scheme} in ${name}`);
    }
  }
  return found;
}

// --- escaping ------------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeHtml("Release Plan — v2")).toBe("Release Plan — v2");
  });

  it("escapes the ampersand so a double-escape cannot be unwound", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("escapes both quote styles, so an escaped string is safe in any attribute", () => {
    expect(escapeHtml(`a" onmouseover="x`)).not.toContain('"');
    expect(escapeHtml("a' onmouseover='x")).not.toContain("'");
  });
});

// --- layer 2: URL safety ----------------------------------------------------------------------

describe("safeUrl", () => {
  it("allows exactly the declared schemes", () => {
    expect(SAFE_SCHEMES).toEqual(["http:", "https:", "mailto:"]);
    for (const url of ["http://x.example/a", "https://x.example/a", "mailto:a@b.example"]) {
      expect(safeUrl(url)).toBe(url);
    }
  });

  it("rejects javascript:, in every spelling a browser would still run", () => {
    // A browser strips ASCII whitespace and control characters before parsing
    // the scheme, so a check against the raw string sees an unknown scheme,
    // assumes "relative path", and lets it through. That is the bug this
    // guards; DOMPurify strips the same class for the same reason.
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "java\u0000script:alert(1)",
      "  javascript:alert(1)",
      "\u00a0javascript:alert(1)",
    ]) {
      expect(safeUrl(url), url).toBeNull();
    }
  });

  it("rejects data: and vbscript:", () => {
    // `data:text/html,<script>` in an href is script execution with a
    // friendlier spelling, and it is the one people forget.
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects any other scheme, because the list is an allowlist", () => {
    for (const url of ["file:///etc/passwd", "ftp://x.example", "chrome://settings", "note:release-plan"]) {
      expect(safeUrl(url), url).toBeNull();
    }
  });

  it("allows relative URLs, which the CSP's 'self' already bounds", () => {
    expect(safeUrl("./diagram.png")).toBe("./diagram.png");
    expect(safeUrl("#heading")).toBe("#heading");
    expect(safeUrl("/api/okf/index/notes.md")).toBe("/api/okf/index/notes.md");
  });

  it("rejects an empty or whitespace-only URL rather than emitting href=''", () => {
    expect(safeUrl("")).toBeNull();
    expect(safeUrl("   ")).toBeNull();
  });

  it("returns the original string, not the de-noised one, for an allowed URL", () => {
    // The noise-stripped copy exists only to classify the scheme. Emitting it
    // would silently rewrite a URL whose path legitimately contains an encoded
    // space-adjacent character.
    expect(safeUrl("https://x.example/a b")).toBe("https://x.example/a b");
  });
});

// --- the wikilink index ---------------------------------------------------------------------

describe("slugOfNode", () => {
  it("reads the slug out of a note node id", () => {
    expect(slugOfNode(noteNode("release-plan", "Release Plan"))).toBe("release-plan");
  });

  it("is null for anything that is not a note", () => {
    expect(slugOfNode({ id: "repository", kind: "repository", label: "r", provenance: null, detail: {} })).toBeNull();
  });

  it("is null for a note node with a malformed id", () => {
    expect(slugOfNode({ id: "note:", kind: "note", label: "x", provenance: null, detail: {} })).toBeNull();
    expect(slugOfNode({ id: "weird", kind: "note", label: "x", provenance: null, detail: {} })).toBeNull();
  });
});

describe("wikiIndex", () => {
  it("is empty before the first graph arrives", () => {
    expect(wikiIndex(null, "release-plan")).toBe(EMPTY_WIKI_INDEX);
    expect(EMPTY_WIKI_INDEX.bySpelling.size).toBe(0);
    expect(EMPTY_WIKI_INDEX.hasGhosts).toBe(false);
  });

  it("indexes each note under its title and its slug, case-folded too", () => {
    const index = wikiIndex(GRAPH, "release-plan");
    for (const spelling of ["Graph Architecture", "graph architecture", "graph-architecture", "GRAPH-ARCHITECTURE"]) {
      expect(resolveWikilink(index, spelling), spelling).toBe("graph-architecture");
    }
  });

  it("indexes only notes — a module is not a wikilink target", () => {
    expect(resolveWikilink(wikiIndex(GRAPH, null), "pi-weave")).toBeNull();
  });

  it("tolerates surrounding whitespace, which `[[ x ]]` produces", () => {
    expect(resolveWikilink(wikiIndex(GRAPH, null), "  Release Plan  ")).toBe("release-plan");
  });

  it("is null for a spelling no note carries", () => {
    expect(resolveWikilink(wikiIndex(GRAPH, null), "Nothing At All")).toBeNull();
  });

  it("reports ghosts only for a note the payload says has unresolved links", () => {
    // §4.2's `dangling` map is the authority, not the index's own miss — see
    // the WikiIndex doc comment for the gap this closes.
    expect(isGhost(wikiIndex(GRAPH, "release-plan"))).toBe(true);
    expect(isGhost(wikiIndex(GRAPH, "graph-architecture"))).toBe(false);
    expect(isGhost(wikiIndex(GRAPH, null))).toBe(false);
  });

  it("treats an empty dangling list as no ghosts", () => {
    const empty = payloadOf([noteNode("a", "A")], { a: [] });
    expect(isGhost(wikiIndex(empty, "a"))).toBe(false);
  });
});

// --- tokenising a wikilink ------------------------------------------------------------------

describe("parseWikilink", () => {
  it("reads a bare target, with no alias", () => {
    expect(parseWikilink("[[Release Plan]] and more")).toEqual({
      type: "wikilink",
      raw: "[[Release Plan]]",
      target: "Release Plan",
      alias: "",
    });
  });

  it("reads a target and an alias", () => {
    expect(parseWikilink("[[Release Plan|the plan]]")).toMatchObject({ target: "Release Plan", alias: "the plan" });
  });

  it("reads an empty alias, which `[[x|]]` produces", () => {
    expect(parseWikilink("[[x|]]")).toMatchObject({ target: "x", alias: "" });
  });

  it("matches only at the start, because marked feeds it the remaining source", () => {
    expect(parseWikilink("text [[Release Plan]]")).toBeUndefined();
  });

  it("rejects the shapes that are not wikilinks", () => {
    // The character classes mirror core's `WIKILINK_RE` exactly, so the
    // browser tokenises the same spans the graph builder counted as links.
    for (const src of ["[[]]", "[[a", "[not a wikilink]", "[[a[b]]", "[[a]b]]"]) {
      expect(parseWikilink(src), src).toBeUndefined();
    }
  });
});

// --- rendering one wikilink ---------------------------------------------------------------

describe("renderWikilink", () => {
  const index = wikiIndex(GRAPH, "release-plan");

  it("renders a resolved link with the target attribute and no href", () => {
    // No href is the point: §1.1 says selecting updates every column in place,
    // and an href would navigate away, dropping the SSE stream and the layout.
    const html = renderWikilink(index, "Graph Architecture", "");
    expect(html).toContain(`${WIKILINK_ATTR}="graph-architecture"`);
    expect(html).not.toContain("href");
    expect(html).toContain(">Graph Architecture<");
  });

  it("keeps a resolved link reachable from the keyboard despite having no href", () => {
    const html = renderWikilink(index, "Graph Architecture", "");
    expect(html).toContain('role="link"');
    expect(html).toContain('tabindex="0"');
  });

  it("shows the alias and links the target", () => {
    const html = renderWikilink(index, "Graph Architecture", "the architecture");
    expect(html).toContain(`${WIKILINK_ATTR}="graph-architecture"`);
    expect(html).toContain(">the architecture<");
  });

  it("renders an unresolved link as a ghost span, not a broken anchor", () => {
    // A link that refuses to work is worse than no link: it is not focusable,
    // not announced as a link, and the dashed underline is Obsidian's offer to
    // create the missing note.
    const html = renderWikilink(index, "Ghost Note", "");
    expect(html).toContain("weave-wiki-ghost");
    expect(html).toContain("<span");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain(WIKILINK_ATTR);
  });

  it("renders nothing at all for an empty target, rather than an empty ghost", () => {
    // Unreachable through the tokenizer, which requires at least one
    // character — but `renderWikilinkToken` takes whatever marked hands it,
    // and a hoverable nothing is worse than no element.
    expect(renderWikilink(index, "", "")).toBe("");
    expect(renderWikilink(index, "   ", "")).toBe("");
  });

  it("renders an unresolved link as plain text when the note has no ghosts", () => {
    // The payload says this note's links all resolved, so a miss here is the
    // index's gap and not a missing note — claiming otherwise would offer to
    // create a note that already exists.
    const clean = wikiIndex(GRAPH, "graph-architecture");
    const html = renderWikilink(clean, "Release_Plan", "");
    expect(html).toBe("Release_Plan");
    expect(html).not.toContain("<");
  });

  it("escapes a hostile target in every position it reaches", () => {
    const html = renderWikilink(index, '<img src=x onerror=alert(1)>', "");
    expect(liveMarkup(html)).toEqual([]);
    expect(html).not.toContain("<img");
  });

  it("escapes a hostile alias", () => {
    const html = renderWikilink(index, "Graph Architecture", '"><script>alert(1)</script>');
    expect(liveMarkup(html)).toEqual([]);
    expect(html).toContain(`${WIKILINK_ATTR}="graph-architecture"`);
  });

  it("escapes a slug before putting it in an attribute", () => {
    // The slug comes off the graph, so it is not attacker-controlled today —
    // but it is interpolated into markup, and "not attacker-controlled today"
    // is not a property worth relying on.
    const odd = payloadOf([{ id: 'note:a"onmouseover="x', kind: "note", label: "Odd", provenance: null, detail: {} }]);
    const html = renderWikilink(wikiIndex(odd, null), "Odd", "");
    expect(liveMarkup(html)).toEqual([]);
    expect(html).toContain("&quot;");
  });
});

describe("renderWikilinkToken", () => {
  const index = wikiIndex(GRAPH, "release-plan");

  it("renders a well-formed token", () => {
    const token = parseWikilink("[[Graph Architecture|arch]]")!;
    expect(renderWikilinkToken(index, token)).toBe(renderWikilink(index, "Graph Architecture", "arch"));
  });

  it("narrows rather than asserts, because it does not own the token stream", () => {
    // A renderer registered under a name is called for every token carrying
    // that `type`. Non-string fields must degrade to empty strings, not to a
    // `String(undefined)` reading "undefined" on screen.
    expect(renderWikilinkToken(index, { type: "wikilink", raw: "", target: 42, alias: null })).toBe("");
    expect(renderWikilinkToken(index, { type: "wikilink", raw: "" })).toBe("");
  });
});

// --- layers 1 and 2 end to end ---------------------------------------------------------------

describe("renderMarkdown", () => {
  const index = wikiIndex(GRAPH, "release-plan");

  it("renders ordinary Markdown", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text.", index);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders GFM tables, task lists and fenced code", () => {
    expect(renderMarkdown("| a |\n| - |\n| 1 |", index)).toContain("<table>");
    expect(renderMarkdown("- [x] done", index)).toContain('type="checkbox"');
    expect(renderMarkdown("```ts\nconst x = 1;\n```", index)).toContain('class="language-ts"');
  });

  it("turns wikilinks into internal links", () => {
    const html = renderMarkdown("See [[Graph Architecture]].", index);
    expect(html).toContain(`${WIKILINK_ATTR}="graph-architecture"`);
  });

  it("leaves a wikilink inside a code span alone", () => {
    // The reason the extension is a real tokenizer and not a regex pass over
    // rendered HTML: marked never offers code-span content to the extension,
    // so this is correct by construction rather than by a lookahead.
    const html = renderMarkdown("Write `[[Graph Architecture]]` to link.", index);
    expect(html).not.toContain(WIKILINK_ATTR);
    expect(html).toContain("<code>");
  });

  it("leaves a wikilink inside a fenced block alone", () => {
    expect(renderMarkdown("```\n[[Graph Architecture]]\n```", index)).not.toContain(WIKILINK_ATTR);
  });

  it("leaves text that merely contains brackets alone", () => {
    expect(renderMarkdown("an array[[0]] index", index)).not.toContain(WIKILINK_ATTR);
  });

  describe("layer 1 — raw HTML never becomes HTML", () => {
    it("escapes an inline tag into visible text", () => {
      const html = renderMarkdown("raw <b>bold</b> inline", index);
      expect(html).toContain("&lt;b&gt;");
      expect(html).not.toContain("<b>");
    });

    it("escapes a block-level tag", () => {
      const html = renderMarkdown('<div onclick="evil()">block</div>', index);
      expect(html).toContain("&lt;div");
      expect(html).not.toContain("<div");
    });
  });

  describe("layer 2 — unsafe schemes lose their href entirely", () => {
    it("emits an anchor with no href for javascript:", () => {
      const html = renderMarkdown("[click](javascript:alert(1))", index);
      expect(html).toContain("<a>click</a>");
      expect(html).not.toContain("href");
    });

    it("degrades an unsafe image to its alt text", () => {
      const html = renderMarkdown("![the diagram](javascript:alert(1))", index);
      expect(html).not.toContain("<img");
      expect(html).toContain("the diagram");
    });

    it("keeps a safe link, and sends it out of the tab it came from", () => {
      const html = renderMarkdown("[docs](https://x.example/a)", index);
      expect(html).toContain('href="https://x.example/a"');
      expect(html).toContain('rel="noreferrer noopener"');
      expect(html).toContain('target="_blank"');
    });

    it("keeps a safe image, with its alt and title", () => {
      const html = renderMarkdown('![alt text](https://x.example/a.png "the title")', index);
      expect(html).toContain('src="https://x.example/a.png"');
      expect(html).toContain('alt="alt text"');
      expect(html).toContain('title="the title"');
    });

    it("renders a titled link's title, escaped", () => {
      const html = renderMarkdown('[x](https://x.example "a > b")', index);
      expect(html).toContain('title="a &gt; b"');
    });

    it("omits the title attribute when there is no title", () => {
      expect(renderMarkdown("![alt](https://x.example/a.png)", index)).not.toContain("title=");
    });
  });

  describe("the hostile corpus produces no live markup", () => {
    // This is the load-bearing assertion of the whole suite. It is made
    // against *pre-sanitiser* output, so it holds independently of whether
    // DOMPurify's configuration is right — which is exactly the property
    // defence in depth is supposed to give.
    for (const [name, markdown] of HOSTILE) {
      it(name, () => {
        expect(liveMarkup(renderMarkdown(markdown, index))).toEqual([]);
      });
    }
  });

  describe("the live-markup detector itself", () => {
    // A detector that matched nothing would make every test above pass while
    // proving nothing at all, and one that matched too much would have to be
    // loosened until it did. Both directions are pinned here.

    it("catches every shape it claims to catch", () => {
      expect(liveMarkup('<img src=x onerror="alert(1)">')).toContain("event handler onerror=");
      expect(liveMarkup("<img src=x onerror=alert(1)>")).toContain("event handler onerror=");
      expect(liveMarkup("<script>alert(1)</script>")).toContain("element <script>");
      expect(liveMarkup("<svg onload=alert(1)>")).toContain("element <svg>");
      expect(liveMarkup('<a href="javascript:alert(1)">x</a>')).toContain("javascript: in href");
      expect(liveMarkup('<a href="data:text/html,x">x</a>')).toContain("data: in href");
      expect(liveMarkup('<a href="vbscript:x">x</a>')).toContain("vbscript: in href");
      expect(liveMarkup('<button formaction="javascript:x">')).toContain("javascript: in formaction");
    });

    it("sees through the obfuscations a browser sees through", () => {
      expect(liveMarkup('<a href="java\tscript:alert(1)">x</a>')).toContain("javascript: in href");
      expect(liveMarkup('<a href="  JaVaScRiPt:alert(1)">x</a>')).toContain("javascript: in href");
      expect(liveMarkup('<a href="java\u0000script:alert(1)">x</a>')).toContain("javascript: in href");
    });

    it("does not mistake escaped text for markup — the false positive that forced a parser", () => {
      // Both of these are real renderer output for hostile fixtures, and both
      // are inert. A whole-document regex flagged them, because `[^>]*` runs
      // straight through an opening quote into the attribute's *value*.
      expect(liveMarkup('<span title="no note named &lt;img src=x onerror=alert(1)&gt;">x</span>')).toEqual([]);
      expect(liveMarkup('<a href="https://ok.example" title="a&quot; onmouseover=&quot;alert(1)">x</a>')).toEqual([]);
      expect(liveMarkup("&lt;script&gt;alert(1)&lt;/script&gt;")).toEqual([]);
    });

    it("passes ordinary rendered Markdown", () => {
      expect(liveMarkup('<p><a href="https://x.example" rel="noreferrer noopener" target="_blank">x</a></p>')).toEqual([]);
      expect(liveMarkup('<img src="https://x.example/a.png" alt="a">')).toEqual([]);
      expect(liveMarkup('<input checked="" disabled="" type="checkbox">')).toEqual([]);
    });
  });
});

// --- layer 3: the sanitiser's configuration and wiring -------------------------------------------

describe("SANITIZE_CONFIG", () => {
  it("allows no tag that can execute, embed, or restyle the page", () => {
    for (const tag of ["script", "iframe", "object", "embed", "form", "style", "svg", "math", "template", "base", "link", "meta", "noscript"]) {
      expect(SANITIZE_CONFIG.ALLOWED_TAGS, tag).not.toContain(tag);
    }
  });

  it("allows the tags marked actually emits for permitted Markdown", () => {
    for (const tag of ["p", "h1", "h2", "em", "strong", "code", "pre", "ul", "ol", "li", "a", "span", "img", "table", "th", "td"]) {
      expect(SANITIZE_CONFIG.ALLOWED_TAGS, tag).toContain(tag);
    }
  });

  it("allows no event-handler attribute", () => {
    // What makes `<img src=x onerror=alert(1)>` inert even in the world where
    // layer 1 has been removed: the element survives, the attribute does not.
    expect(SANITIZE_CONFIG.ALLOWED_ATTR.filter((attr) => /^on/i.test(attr))).toEqual([]);
  });

  it("allows no style attribute, so there is nowhere for an overlay to live", () => {
    expect(SANITIZE_CONFIG.ALLOWED_ATTR).not.toContain("style");
  });

  it("permits the wikilink attribute and treats its value as a non-URL", () => {
    // Without ADD_URI_SAFE_ATTR the value is run through IS_ALLOWED_URI — a
    // URL grammar applied to something that was never a URL, which passes
    // today by accident and is exactly the sort of thing a patch release
    // changes.
    expect(SANITIZE_CONFIG.ALLOWED_ATTR).toContain(WIKILINK_ATTR);
    expect(SANITIZE_CONFIG.ADD_URI_SAFE_ATTR).toEqual([WIKILINK_ATTR]);
  });

  it("admits no other data-* or aria-* attribute", () => {
    expect(SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
  });

  it("does not allow unknown protocols, which would re-admit javascript:", () => {
    expect(SANITIZE_CONFIG.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
  });

  it("is frozen, so the allowlist cannot be widened at runtime", () => {
    // `readonly` erases at compile time; this does not. A `push("script")`
    // from anywhere throws, because ES modules are strict mode.
    expect(Object.isFrozen(SANITIZE_CONFIG)).toBe(true);
    expect(Object.isFrozen(SANITIZE_CONFIG.ALLOWED_TAGS)).toBe(true);
    expect(Object.isFrozen(SANITIZE_CONFIG.ALLOWED_ATTR)).toBe(true);
    expect(() => SANITIZE_CONFIG.ALLOWED_TAGS.push("script")).toThrow();
    expect(SANITIZE_CONFIG.ALLOWED_TAGS).not.toContain("script");
  });
});

describe("renderNote", () => {
  function spy(): Purifier & { calls: Array<{ dirty: string; config: unknown }> } {
    const calls: Array<{ dirty: string; config: unknown }> = [];
    return {
      calls,
      sanitize(dirty, config) {
        calls.push({ dirty, config });
        return `<sanitised>${dirty}</sanitised>`;
      },
    };
  }

  it("passes the rendered HTML through the sanitiser with the strict config", () => {
    // DOMPurify cannot run here (no DOM; §10 forbids adding one), so what is
    // asserted is the wiring: sanitisation is the *last* step and it is handed
    // the exact config above, not a default.
    const purify = spy();
    const index = wikiIndex(GRAPH, "release-plan");
    const out = renderNote(purify, "# Plan", index);
    expect(purify.calls).toHaveLength(1);
    expect(purify.calls[0]?.dirty).toBe(renderMarkdown("# Plan", index));
    expect(purify.calls[0]?.config).toBe(SANITIZE_CONFIG);
    expect(out).toBe(`<sanitised>${renderMarkdown("# Plan", index)}</sanitised>`);
  });

  it("returns whatever the sanitiser returns, never the unsanitised HTML", () => {
    const purify: Purifier = { sanitize: () => "" };
    expect(renderNote(purify, "# Plan", EMPTY_WIKI_INDEX)).toBe("");
  });

  it("hands the sanitiser input that is already inert, for every hostile fixture", () => {
    const purify = spy();
    for (const [name, markdown] of HOSTILE) {
      renderNote(purify, markdown, wikiIndex(GRAPH, "release-plan"));
      const dirty = purify.calls[purify.calls.length - 1]?.dirty ?? "";
      expect(liveMarkup(dirty), name).toEqual([]);
    }
  });
});

// --- reading a click back out of the DOM ---------------------------------------------------

describe("wikilinkTargetOf", () => {
  /** A minimal element chain. The real `HTMLElement` satisfies the port. */
  function element(attrs: Record<string, string>, parent: ClosestElement | null = null): ClosestElement {
    return { getAttribute: (name) => attrs[name] ?? null, parentElement: parent };
  }

  it("reads the target off the element itself", () => {
    expect(wikilinkTargetOf(element({ [WIKILINK_ATTR]: "release-plan" }))).toBe("note:release-plan");
  });

  it("walks up to the anchor, because the click lands on the text's parent", () => {
    const anchor = element({ [WIKILINK_ATTR]: "release-plan" });
    const em = element({}, anchor);
    expect(wikilinkTargetOf(element({}, em))).toBe("note:release-plan");
  });

  it("is null for a click that hit no wikilink", () => {
    expect(wikilinkTargetOf(element({}, element({})))).toBeNull();
    expect(wikilinkTargetOf(null)).toBeNull();
  });

  it("ignores an empty target rather than selecting `note:`", () => {
    expect(wikilinkTargetOf(element({ [WIKILINK_ATTR]: "" }))).toBeNull();
  });

  it("terminates on a parent cycle instead of hanging the tab", () => {
    // A malformed or adversarial DOM should cost a null, not a frozen browser
    // inside a click handler.
    const cyclic: { getAttribute: (n: string) => string | null; parentElement: ClosestElement | null } = {
      getAttribute: () => null,
      parentElement: null,
    };
    cyclic.parentElement = cyclic;
    expect(wikilinkTargetOf(cyclic)).toBeNull();
  });

  it("returns a node id, not a slug — the inverse of workspace.ts's noteSlug", () => {
    expect(wikilinkTargetOf(element({ [WIKILINK_ATTR]: "a" }))).toBe("note:a");
  });
});

// --- the header --------------------------------------------------------------------------------

describe("noteHeader", () => {
  it("carries the front matter the column renders", () => {
    const view = noteHeader(NOTE, NOW);
    expect(view.title).toBe("Release Plan");
    expect(view.slug).toBe("release-plan");
    expect(view.tags).toEqual(["architecture", "viewer"]);
  });

  it("badges provenance with the tree's glyph, so one vocabulary is learned once", () => {
    // AGENTS.md rule 4 is about the reader being able to tell agent-written
    // content apart; a second mark two columns to the right defeats that.
    const view = noteHeader(NOTE, NOW);
    expect(view.provenance).toBe("agent");
    expect(view.provenanceGlyph).toBe("◐");
    expect(view.provenanceTitle).toBe("agent-authored");
  });

  it("renders times against the injected clock, never the wall clock", () => {
    const view = noteHeader(NOTE, NOW);
    expect(view.updated).toBe("1h ago");
    expect(view.created).toBe("3d ago");
    expect(noteHeader(NOTE, NOW + 86_400_000).updated).toBe("1d ago");
  });

  it("keeps the ISO strings, for a `<time datetime>` and a precise tooltip", () => {
    const view = noteHeader(NOTE, NOW);
    expect(view.updatedIso).toBe("2026-03-04T08:00:00Z");
    expect(view.createdIso).toBe("2026-03-01T09:00:00Z");
  });
});

describe("tagLabel", () => {
  it("adds the display-only hash", () => {
    expect(tagLabel("architecture")).toBe("#architecture");
  });
});

// --- empty states -----------------------------------------------------------------------------

describe("noteEmptyMessage", () => {
  it("is null when there is a note to render", () => {
    expect(noteEmptyMessage("note:release-plan", NOTE)).toBeNull();
  });

  it("invites a selection when nothing is selected", () => {
    expect(noteEmptyMessage(null, null)).toBe("Select a note to read it here.");
  });

  it("says loading while a selected note's body is in flight", () => {
    expect(noteEmptyMessage("note:release-plan", null)).toBe("Loading…");
  });

  it("explains a node that has no prose, and points at the rail", () => {
    // Without this the user clicks a module, the reading pane does not change,
    // and they conclude the app is broken.
    for (const id of ["repository", "module:src/core", "gitState", "package:package.json"]) {
      expect(noteEmptyMessage(id, null), id).toBe("This node has no note body — see the context rail for what it connects to.");
    }
  });
});
