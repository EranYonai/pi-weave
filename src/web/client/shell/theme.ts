import { THEMES, ACCENTS } from "../../shared/themes";
import type { PaletteChoice } from "../../shared/themes";
import { WORKSPACE_CSS } from "./workspace.css";

/**
 * The workspace stylesheet, and how it gets past the CSP
 * (weave-workspace §1.2, §5.2).
 *
 * ## Why the client ships CSS at all
 *
 * `page.ts` emits a nonce'd `<style>` block, but it is deliberately tiny —
 * the custom-property palette and enough body rules that the first paint has
 * a background colour before `app.js` parses. It knows nothing about the
 * status bar, and it is owned by the server tier, which this
 * work may not edit. There is also no `/app.css` route. So the shell's own
 * rules have to travel in the bundle and be installed at runtime.
 *
 * ## The CSP path, verified rather than assumed
 *
 * The policy is `style-src 'nonce-{N}'` with **no `'unsafe-inline'`**. Three
 * facts decide the implementation, and each was checked rather than recalled:
 *
 *  1. **A literal `style="…"` attribute in markup is blocked.** That is what
 *     `'unsafe-inline'` governs for styles, and it is absent.
 *  2. **CSSOM writes are not.** `el.style.setProperty(…)` has no CSP hook at
 *     all, which is why dynamic note preview positions use CSSOM. Confirmed
 *     against Preact's own behaviour:
 *     `preact/src/diff/props.js` handles a `style` prop via
 *     `dom.style.cssText` or `style.setProperty`, never `setAttribute`.
 *  3. **A script-created `<style>` element needs the nonce.** Inserting a
 *     stylesheet *is* subject to `style-src`, so the element must carry a
 *     matching `nonce` or the browser drops it.
 *
 * (3) is the one that shapes this module. The nonce is not a constant the
 * bundle can hold — it is fresh per response (`page.ts`) — so it has to be
 * read from the document at runtime. The `nonce` **content attribute** is
 * hidden by browsers (`getAttribute("nonce")` returns `""`) specifically to
 * stop an injection from exfiltrating it; the **IDL property** `el.nonce`
 * remains readable by same-origin script, which is exactly this case. So
 * {@link installTheme} copies `nonce` from an element the server already
 * nonce'd onto the one it creates.
 *
 * ## Testability
 *
 * The CSS is a pure constant and the installer takes a four-method port, so
 * both are covered without a DOM (§10). The port is narrow enough that the
 * real `document` satisfies it structurally.
 */

/** Palette declarations are shared with the WebGL graph. */
function paletteTokens(id: PaletteChoice): string {
  const { scheme, colors } = THEMES[id];
  return Object.entries(colors).map(([key, value]) => `--weave-${key}:${value};`).join("")
    + `--weave-new:color-mix(in srgb,var(--weave-accent) ${scheme === "light" ? 10 : 16}%,transparent);`
    + `color-scheme:${scheme};`
    + `--weave-vignette:radial-gradient(ellipse at center,transparent 55%,${scheme === "light" ? "rgba(0,0,0,.10)" : "rgba(0,0,0,.22)"} 100%);`
    + `--weave-scrim:rgba(0,0,0,${scheme === "light" ? ".30" : ".45"});`;
}

export const THEME_CSS = `
:root{
  ${paletteTokens("dark")}
  --weave-row:26px;--weave-gutter:10px;
  /* The reading gutter is note-only: prose wants a wider margin than chrome.
     Rails, rows and bars keep --weave-gutter, so density is a property of the
     furniture and generosity a property of the page. */
  --weave-note-gutter:18px;
  /* The desk-and-page split. The workspace is a desk of instruments — tree,
     graph, rail, bars — on the --weave-bg ground; the note column is the one
     *page* lying on it: crust under dark, plain white under Latte (the
     refresh's "quiet page": paper reads as paper), the ground that sits
     furthest from the desk. Two
     voices in total: sans for instruments and prose alike, mono for data — a
     third face was tried (serif prose) and withdrawn at the user's call; two
     voices read calmer than three. The CSP allows nothing fetched, and both
     are system stacks. */

  /* Two radii, per the plan: hairline-sharp for controls (a 4 px corner is
     the difference between a control and a card), one softer corner for the
     two overlays that float above the grid. Tag pills are 999px — a capsule
     shape, not a scale step. The gate test below refuses any literal px
     radius so the scale cannot drift back. */
  --weave-radius:6px;--weave-radius-pop:10px;
  /* The type ramp, role-named because sizes drift and roles stick. Nine
     steps; every font-size in this sheet is one of these vars — that is a
     gate, not a convention:
       prov     9.5   micro badges, kind glyphs, uppercase key groups
       caption  10.5  chips, meta, counts, legend, column overlines
       ui       11.5  status bar, the note's meta row, small controls
       row      12    list rows, text inputs, inline code
       base     13    body copy, h3-h6, preview-card text
       body     13.5  the note column's prose
       subhead  14    palette input, note-body h2, ribbon icon buttons
       title    15    note-body h1
       display  26    the note's page title (20 before the refresh)
     Two earlier sizes were merged into neighbours: 9px glyphs to prov, and
     the 10px column overlines to caption (caps plus .09em tracking already
     read larger than their point size suggests). \`display\` and \`body\` are
     P6.3's two additions, and deliberately its only two. The review's
     headline finding was hierarchy inverted inside the note: a 15px title
     barely above its own 11.5px meta line, over 13px prose. A page title is
     not another \`title\` — it is a size no instrument in the sheet shares,
     which is exactly what a role-named step is for. \`body\` exists because
     reading prose and reading chrome are different jobs done at the same
     desk: holding prose at \`base\` made a page of text sit inside 0.5px of
     its own meta line, and half-steps are how the ramp refuses to be a
     rubber stamp. */
  --weave-px-prov:9.5px;--weave-px-caption:10.5px;--weave-px-ui:11.5px;
  --weave-px-row:12px;--weave-px-base:13px;--weave-px-body:13.5px;
  --weave-px-subhead:14px;--weave-px-title:15px;--weave-px-display:26px;
}
@media (prefers-color-scheme: light){
  :root:not([data-weave-theme]){${paletteTokens("light")}}
}
${(Object.keys(THEMES) as PaletteChoice[]).map((id) => `:root[data-weave-theme="${id}"]{${paletteTokens(id)}}`).join("\n")}
${Object.entries(ACCENTS).map(([id, colors]) => ["light", "dark"].map((scheme) =>
  `:root[data-weave-scheme="${scheme}"][data-weave-accent="${id}"]{--weave-accent:${colors[scheme as "light" | "dark"]};}`
).join("\n")).join("\n")}
body{font-size:var(--weave-px-base)}
#app{height:100%;display:grid;grid-template-rows:minmax(0,1fr) auto;background:var(--weave-bg)}

/* tree column ----------------------------------------------------------- */
/* --weave-depth is written per row by \`depthVar\`, through CSSOM
   path as the column widths, and multiplied by a step this sheet owns — so
   the tree's density stays a CSS decision. */
.weave-tree{display:flex;flex-direction:column;min-height:0;flex:1}
.weave-tree-controls{
  display:flex;align-items:center;gap:6px;padding:5px var(--weave-gutter);
  border-bottom:1px solid var(--weave-line);
}
.weave-filter{
  flex:1;min-width:0;height:21px;padding:0 6px;font:inherit;font-size:var(--weave-px-row);
  color:var(--weave-fg);background:var(--weave-panel);
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius);
}
.weave-chip{
  font:inherit;font-size:var(--weave-px-caption);line-height:1;white-space:nowrap;cursor:pointer;
  color:var(--weave-dim);background:var(--weave-panel);padding:4px 6px;
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius);
}
.weave-chip:hover{color:var(--weave-fg);border-color:var(--weave-accent)}
/* A chip that is a toggle, while it is on: the accent states it without a
   second control or an icon. */
.weave-chip-on{color:var(--weave-accent);border-color:var(--weave-accent)}
.weave-rows{
  flex:1;min-height:0;overflow:auto;margin:0;padding:3px 0;list-style:none;
}
.weave-rows:focus-visible{outline-offset:-2px}
.weave-row{
  display:flex;align-items:center;gap:5px;height:var(--weave-row);
  padding-right:var(--weave-gutter);
  padding-left:calc(var(--weave-gutter) + var(--weave-depth,0) * 13px);
  cursor:default;white-space:nowrap;
}
.weave-row:hover{background:var(--weave-line)}
/* A hover changes two things, in this order: the ground appears under the
   row, then the label steps up to fg. The second half is what stops the
   hover from reading as a stray grey rectangle — the row answers the pointer
   in both channels at once. */
.weave-row:hover .weave-label{color:var(--weave-fg)}
/* The selection has one voice. On the tinted ground every quieter token still
   fails contrast — even --weave-dim lands under 4.5 — so a selected row's
   kind, provenance and meta children join its label in --weave-fg. The
   provenance glyph shape carries the distinction the colour swap drops;
   elsewhere the hues are unaffected. The palette's hit rows need the same
   remap: same selected ground, same failure. The label is restated last
   so the selected row is always readable. The ground itself is the Context
   rail's selection: the --weave-new tint plus a 2px inset accent bar, kept
   under the pointer too. It is the only tinted row: the tree is where you
   are, not what the agent touched (the graph shows that). */
.weave-row-on,.weave-row-on:hover{background:var(--weave-new);box-shadow:inset 2px 0 0 var(--weave-accent)}
.weave-row-on .weave-twisty,.weave-row-on .weave-kind,.weave-row-on .weave-prov,
.weave-row-on .weave-meta,.weave-row-on .weave-label{color:var(--weave-fg)}
.weave-hit-on .weave-hit-icon,.weave-hit-on .weave-hit-detail,.weave-hit-on .weave-hit-meta{color:var(--weave-fg)}
/* A newly-arrived node (a file or note added since the last update, ):
   one short highlight that fades while the label settles from bold back to
   normal. The class is computed from the frame diff in workspace.ts and
   expires with it, so collapsing and re-expanding later does not replay the
   arrival, and the first load never flashes the whole tree. */
.weave-row-new{animation:weave-row-new 2.6s ease-out both}
@keyframes weave-row-new{
  0%{background:var(--weave-new);font-weight:700}
  40%{font-weight:700}
  100%{background:transparent;font-weight:400}
}
.weave-twisty{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--weave-faint);cursor:pointer}
.weave-kind{flex:none;color:var(--weave-faint);font-size:var(--weave-px-ui)}
.weave-prov{flex:none;font-size:var(--weave-px-prov)}
.weave-prov-human{color:var(--weave-ok)}
.weave-prov-agent{color:var(--weave-accent)}
.weave-prov-generated{color:var(--weave-faint)}
.weave-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.weave-tree-rename{flex:1;min-width:0;height:20px;padding:0 4px;font:inherit;color:var(--weave-fg);background:var(--weave-panel);border:1px solid var(--weave-accent)}
.weave-meta{flex:none;font-size:var(--weave-px-caption);color:var(--weave-faint)}
.weave-tree-empty{flex:1;margin:0;padding:14px var(--weave-gutter);color:var(--weave-dim)}
.weave-tree-count{
  margin:0;padding:3px var(--weave-gutter);font-size:var(--weave-px-caption);color:var(--weave-faint);
  border-top:1px solid var(--weave-line);
}
.weave-menu-backdrop{position:fixed;inset:0;border:0;background:transparent;z-index:20}
.weave-menu{position:fixed;z-index:21;display:grid;min-width:120px;padding:4px;background:var(--weave-panel);border:1px solid var(--weave-line-strong)}
.weave-menu button{padding:6px 10px;border:0;background:transparent;color:var(--weave-fg);text-align:left}
.weave-menu button:hover{background:var(--weave-line)}
.weave-menu .weave-menu-danger{color:var(--weave-bad)}

/* icons ------------------------------------------------------------------
   The sprite's only CSS: one colour (the glyph inherits the row's, so a
   quiet row's icon recedes with it and a selected row's brightens with it)
   and the twisty's rotation, which is the *same* 16px chevron the rail's
   group headings use — right-pointing closed, rotated 90° open. The
   rotation is not in the motion block's transition list, on purpose: that
   list is furniture shared with two other passes, and a snap on a 16px
   glyph is what every tree reader already expects. The reduced-motion kill
   switch would neutralise it anyway, since a universal rule reaches any
   transition declared anywhere in this sheet. */
.weave-icon{display:block;flex:none}
.weave-icon-open{transform:rotate(90deg)}

/* note column ----------------------------------------------------------- */
/* The page. The desk holds instruments; this column is what the user reads,
   so it lies on --weave-page — one step off the desk and the canvas grounds.
   The 2px rule flush to its left edge is the spine: it takes the note's
   provenance colour (see the --weave-spine map), so the document's origin is
   readable peripherally, before any glyph is. Head and body share the
   --weave-note-gutter so the page has one consistent measure. */
.weave-note{display:flex;flex-direction:column;min-height:0;flex:1;overflow:auto;background:var(--weave-page)}
.weave-note-human{--weave-spine:var(--weave-ok)}
.weave-note-agent{--weave-spine:var(--weave-accent)}
.weave-note-generated{--weave-spine:var(--weave-faint)}
.weave-note{border-left:2px solid var(--weave-spine,transparent)}
.weave-note-empty{flex:1;margin:0;padding:14px var(--weave-note-gutter);color:var(--weave-dim);max-width:44ch;line-height:1.5;background:var(--weave-page)}
.weave-artifact-frame{display:block;flex:1;width:100%;min-height:320px;border:0;background:#fff}
/* The head pins itself (P6.3): a long note scrolls its prose under the title,
   and the title is what says you are still in the right document — the
   alternative, a title that scrolls away, is how a reader ends up annotating
   the wrong file. It carries the page ground rather than a fill or a shadow,
   so the reveal reads as the page continuing under it and not as a bar
   arriving; the hairline is the only seam. The head's z-index is only what keeps it above
   the prose (and the wikilinks inside it) as that prose scrolls beneath. */
.weave-note-head{position:sticky;top:0;z-index:2;padding:14px var(--weave-note-gutter) 9px;background:var(--weave-page);border-bottom:1px solid var(--weave-line)}
/* The page's largest voice, and the point of the review's headline finding:
   a 15px title sat 1.5px above the body it named. --weave-px-display puts the
   title where a page's title belongs, weight 650 for presence at 26px (600
   reads thin at that size, 700 reads as a poster), tracking pulled in by a
   hair because large sans needs it. */
.weave-note-title{margin:0 0 4px;font-size:var(--weave-px-display);font-weight:650;line-height:1.25;letter-spacing:-.005em;color:var(--weave-fg)}
/* One quiet line: provenance word, edited, created — a footnote, not a
   second headline. The gap is tightened and the row is capped at the ui step
   so the eye can read the whole of it without ever reading it. */
.weave-note-meta{margin:0;display:flex;align-items:center;gap:8px;font-size:var(--weave-px-ui);color:var(--weave-dim);flex-wrap:wrap}
.weave-note-time{color:var(--weave-faint)}
/* \`Open in $EDITOR\` is a quiet icon at the end of the meta line. */
.weave-note-open{
  display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;padding:0;font:inherit;color:var(--weave-faint);
  background:none;border:0;border-radius:var(--weave-radius);cursor:pointer;
}
.weave-note-open:hover{color:var(--weave-fg);background:var(--weave-line)}
.weave-note-open-mark{display:inline-flex;line-height:0}
/* The note's own actions, at the end of the meta line. History is a quiet
   word with an icon; Edit is the one bordered control, and neither outweighs
   the title. */
.weave-note-actions{margin-left:auto;display:inline-flex;align-items:center;gap:4px}
.weave-note-meta .weave-note-action{
  display:inline-flex;align-items:center;gap:5px;
  font:inherit;font-size:var(--weave-px-caption);line-height:1;white-space:nowrap;cursor:pointer;
  color:var(--weave-dim);background:none;padding:5px 8px;
  border:1px solid transparent;border-radius:var(--weave-radius);
}
.weave-note-meta .weave-note-action .weave-icon{width:13px;height:13px}
.weave-note-meta .weave-note-action:hover{color:var(--weave-fg);background:var(--weave-new)}
.weave-note-meta .weave-note-action:disabled{color:var(--weave-faint);background:none;cursor:default}
.weave-note-meta .weave-note-edit{color:var(--weave-fg);background:var(--weave-page);border-color:var(--weave-line-strong)}
.weave-note-meta .weave-note-edit:hover{border-color:var(--weave-accent);background:var(--weave-page)}
.weave-note-meta .weave-note-history[aria-pressed="true"]{color:var(--weave-accent);background:var(--weave-new)}
/* Where the note lives, above its title: a crumb, not a heading. */
.weave-note-crumb{margin:0 0 6px;display:flex;align-items:center;gap:5px;font-size:var(--weave-px-caption);color:var(--weave-faint)}
.weave-note-crumb .weave-icon{width:12px;height:12px}
/* Who wrote it, in words, with the spine's colour as a dot. */
.weave-note-meta .weave-prov{display:inline-flex;align-items:center;gap:6px;font-size:var(--weave-px-ui);color:var(--weave-dim)}
.weave-prov-dot{width:7px;height:7px;border-radius:999px;background:var(--weave-spine,var(--weave-accent))}
/* The edit bar (E1): one row while editing, pinned over the text it edits.
   Formatting on the left, where the words are; the save state and the two
   ways out on the right. Saving is automatic, so Done is the only
   affirmative control and the only one in the accent. */
.weave-editbar{
  position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  min-height:40px;padding:5px 12px;font-size:var(--weave-px-ui);
  background:var(--weave-page);border-bottom:1px solid var(--weave-line);
}
.weave-editbar .weave-icon{width:14px;height:14px}
.weave-editbar-badge{
  display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;
  font-size:var(--weave-px-caption);font-weight:600;color:var(--weave-accent);background:var(--weave-new);
}
.weave-editbar-badge .weave-icon{width:12px;height:12px}
.weave-editbar-tools{display:inline-flex;align-items:center;gap:1px;margin-left:4px;padding-left:8px;border-left:1px solid var(--weave-line)}
.weave-editbar .weave-editbar-tool{
  display:inline-grid;place-items:center;width:28px;height:28px;padding:0;cursor:pointer;
  color:var(--weave-dim);background:none;border:0;border-radius:var(--weave-radius);
}
.weave-editbar .weave-editbar-tool:hover{color:var(--weave-fg);background:var(--weave-new)}
.weave-editbar-status{margin-left:auto;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:var(--weave-px-caption);color:var(--weave-faint)}
.weave-editbar-pending,.weave-editbar-saving{color:var(--weave-dim)}
.weave-editbar-saved{color:var(--weave-ok)}
.weave-editbar-failed{color:var(--weave-bad);font-weight:600}
.weave-editbar .weave-editbar-retry{font:inherit;color:var(--weave-accent);background:none;border:0;padding:2px 4px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.weave-editbar .weave-editbar-discard,.weave-editbar .weave-editbar-done{font:inherit;font-size:var(--weave-px-caption);line-height:1;white-space:nowrap;cursor:pointer;border-radius:var(--weave-radius)}
.weave-editbar .weave-editbar-discard{padding:7px 9px;color:var(--weave-dim);background:none;border:1px solid transparent}
.weave-editbar .weave-editbar-discard:hover{color:var(--weave-fg);background:var(--weave-new)}
.weave-editbar .weave-editbar-done{padding:7px 14px;font-weight:600;color:var(--weave-page);background:var(--weave-accent);border:1px solid var(--weave-accent)}
.weave-editbar .weave-editbar-done:hover{filter:brightness(1.08)}
.weave-editbar .weave-editbar-discard:disabled,.weave-editbar .weave-editbar-done:disabled{opacity:.5;cursor:default;filter:none}
/* A finalized note's opening TLDR, set apart as the first thing to read.
   The label is the card's own; task boxes keep their row and lose the bullet. */
.weave-tldr{margin:0 0 18px;padding:12px 16px;background:var(--weave-new);border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius)}
.weave-tldr>p,.weave-tldr>ul,.weave-tldr>ol{margin:0 0 6px}
.weave-tldr>*:last-child{margin-bottom:0}
.weave-tldr ul:has(>li>input[type="checkbox"]){list-style:none;padding-left:2px}
.weave-tldr-label{display:block;margin-bottom:3px;font-size:var(--weave-px-prov);font-weight:700;letter-spacing:.08em;color:var(--weave-accent)}
/* The replay band sits under the header like the header itself: full width,
   the note's gutter, one line of words, one line of controls. Dots on the
   track are the versions, coloured by who made them. */
.weave-replay{
  display:flex;flex-direction:column;gap:8px;padding:10px var(--weave-note-gutter) 12px;
  background:var(--weave-panel);border-bottom:1px solid var(--weave-line);
  font-size:var(--weave-px-ui);color:var(--weave-dim);
}
.weave-replay-note{color:var(--weave-faint)}
.weave-replay-caption{margin:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:18px}
.weave-replay-clock{display:inline-flex;color:var(--weave-dim)}
.weave-replay-position{font-weight:650;color:var(--weave-fg);font-variant-numeric:tabular-nums}
.weave-replay-who{display:inline-flex;align-items:center;gap:6px;color:var(--weave-dim)}
.weave-replay-who::before{content:"";width:8px;height:8px;border-radius:999px;background:var(--weave-who)}
.weave-replay-time{color:var(--weave-faint)}
.weave-replay-change{color:var(--weave-ok);font-size:var(--weave-px-caption);font-variant-numeric:tabular-nums}
.weave-replay-human{--weave-who:var(--weave-ok)}
.weave-replay-agent{--weave-who:var(--weave-accent)}
.weave-replay-outside,.weave-replay-system{--weave-who:var(--weave-faint)}
.weave-replay-controls{display:flex;align-items:center;gap:6px}
.weave-replay-controls button{
  flex:none;display:inline-grid;place-items:center;width:28px;height:28px;padding:0;cursor:pointer;
  color:var(--weave-fg);background:var(--weave-page);
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius-pop);
}
.weave-replay-controls button:hover:not(:disabled){border-color:var(--weave-accent)}
.weave-replay-controls button:focus-visible{outline:2px solid var(--weave-accent);outline-offset:1px}
.weave-replay-controls button:disabled{color:var(--weave-faint);cursor:default;opacity:.6}
.weave-replay-controls .weave-replay-play{color:var(--weave-page);background:var(--weave-accent);border-color:var(--weave-accent)}
.weave-replay-controls .weave-replay-play:hover:not(:disabled){filter:brightness(1.08)}
/* The change bars (the refresh's H2): one bar per version, as tall as the
   change was big, coloured by who made it; the version on screen is ringed.
   The day labels sit under the band. Heights and label positions arrive as
   custom properties through Preact's CSSOM style path, never an attribute. */
.weave-replay-track{--weave-replay-at:100%;position:relative;flex:1;min-width:80px;height:46px;margin-left:8px}
.weave-replay-track::before{
  content:"";position:absolute;left:7px;right:7px;top:31px;height:2px;border-radius:999px;
  background:linear-gradient(to right,color-mix(in srgb,var(--weave-accent) 55%,transparent) var(--weave-replay-at),var(--weave-line-strong) var(--weave-replay-at));
}
.weave-replay-bars{position:absolute;left:7px;right:7px;top:2px;height:26px;pointer-events:none}
.weave-replay-bar{position:absolute;bottom:0;left:var(--weave-bar-at,0);width:max(1px,min(8px,calc(100% / var(--weave-bars,1) - 2px)));transform:translateX(-50%);height:var(--weave-bar,14%);border-radius:var(--weave-radius);background:var(--weave-who);opacity:.85}
.weave-replay-ahead{opacity:.35}
.weave-replay-current{opacity:1;outline:2px solid var(--weave-accent);outline-offset:1px}
.weave-replay-days{position:absolute;left:7px;right:7px;top:34px;height:12px;pointer-events:none}
.weave-replay-day{position:absolute;left:var(--weave-day-at,0);transform:translateX(-2px);font-size:var(--weave-px-prov);line-height:12px;color:var(--weave-faint);white-space:nowrap}
.weave-replay-slider{position:absolute;inset:0;width:100%;height:100%;margin:0;background:transparent;-webkit-appearance:none;appearance:none;cursor:pointer}
.weave-replay-slider:disabled{cursor:default}
.weave-replay-slider:focus{outline:none}
.weave-replay-slider::-webkit-slider-runnable-track{height:46px;background:transparent}
.weave-replay-slider::-moz-range-track{height:46px;background:transparent}
.weave-replay-slider::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:25px;border-radius:999px;
  background:var(--weave-page);border:2px solid var(--weave-accent);box-sizing:border-box;
}
.weave-replay-slider::-moz-range-thumb{
  width:14px;height:14px;border-radius:999px;box-sizing:border-box;
  background:var(--weave-page);border:2px solid var(--weave-accent);
}
/* Focus fills the thumb: a ring would need an elevation shadow. */
.weave-replay-slider:focus-visible::-webkit-slider-thumb{background:var(--weave-accent);border-color:var(--weave-page)}
.weave-replay-slider:focus-visible::-moz-range-thumb{background:var(--weave-accent);border-color:var(--weave-page)}
.weave-replay-hint{margin:0;color:var(--weave-faint)}
.weave-replay-mark{background:var(--weave-new);color:inherit}
/* Mono and a tighter line than the prose: this is Markdown source, where
   alignment carries meaning proportional text throws away. */
.weave-note-editor{
  display:block;width:100%;flex:1 0 auto;min-height:12em;resize:none;
  padding:12px var(--weave-note-gutter) 28px;box-sizing:border-box;
  font-family:var(--weave-mono);font-size:var(--weave-px-row);line-height:1.6;
  color:var(--weave-fg);background:var(--weave-page);border:0;outline:0;
}
/* The \`## Raw\` box under the editor: folded by default so a long
   dictation never outgrows the note, a dashed edge to say "captured, not
   written", and a capped height once open. */
.weave-raw{
  flex:none;margin:0 var(--weave-note-gutter) 24px;
  border:1px dashed var(--weave-line-strong);border-radius:var(--weave-radius-pop);background:var(--weave-panel);
}
.weave-raw-head{display:flex;align-items:center;gap:10px;padding:5px 8px;min-height:24px}
.weave-raw[data-open] .weave-raw-head{border-bottom:1px dashed var(--weave-line-strong)}
.weave-raw-toggle{
  display:inline-flex;align-items:center;gap:6px;padding:3px 6px;cursor:pointer;
  font:inherit;font-size:var(--weave-px-ui);font-weight:600;color:var(--weave-fg);
  background:none;border:0;border-radius:var(--weave-radius);
}
.weave-raw-toggle:hover{background:var(--weave-line)}
.weave-raw-toggle:focus-visible{outline:2px solid var(--weave-accent);outline-offset:1px}
.weave-raw-chevron{flex:none;color:var(--weave-dim);transition:transform .12s ease}
.weave-raw-toggle[aria-expanded="true"] .weave-raw-chevron{transform:rotate(90deg)}
.weave-raw-hint{font-size:var(--weave-px-caption);color:var(--weave-faint)}
.weave-raw-editor{
  display:block;width:100%;box-sizing:border-box;min-height:7em;max-height:18em;
  field-sizing:content;resize:vertical;padding:10px 14px 12px;
  font-family:var(--weave-mono);font-size:var(--weave-px-row);line-height:1.6;
  color:var(--weave-dim);background:transparent;border:0;outline:0;
}
.weave-raw-editor:focus{color:var(--weave-fg)}
.weave-note-tags{margin:6px 0 0;display:flex;gap:5px;flex-wrap:wrap}
.weave-tag{
  font-size:var(--weave-px-caption);color:var(--weave-accent);background:var(--weave-panel);
  padding:1px 6px;border:1px solid var(--weave-line-strong);border-radius:999px;
}
/* Prose runs the column's full width — a 66ch measure was tried and
   withdrawn at the user's call: this is a workspace, and the note shares the
   width the desk gives it. It reads at --weave-px-body on 1.7 rather than the
   chrome's 1.6: the extra leading is what a page of running text needs that a
   status bar does not. Code stays mono deliberately. */
.weave-note-body{padding:12px var(--weave-note-gutter) 28px;font-size:var(--weave-px-body);line-height:1.7;color:var(--weave-fg)}
.weave-note-body>*:first-child{margin-top:0}
.weave-note-body h1,.weave-note-body h2,.weave-note-body h3,
.weave-note-body h4,.weave-note-body h5,.weave-note-body h6{
  margin:22px 0 8px;font-weight:650;line-height:1.35;letter-spacing:.005em;
}
/* With prose at 13.5px the old ladder (15/14/13) put h3 *below* the body it
   headed. h1 takes title, h2 subhead, h3-h6 share the body step — a heading
   at the prose's size still reads as one, because weight and the 22px gap
   above say so, and that is exactly what the extra ramp step would have been
   spent on. */
.weave-note-body h1{font-size:var(--weave-px-title)}
.weave-note-body h2{font-size:var(--weave-px-subhead)}
.weave-note-body h3,.weave-note-body h4,.weave-note-body h5,.weave-note-body h6{font-size:var(--weave-px-body)}
.weave-note-body p,.weave-note-body ul,.weave-note-body ol,.weave-note-body blockquote{margin:0 0 12px}
.weave-note-body ul,.weave-note-body ol{padding-left:20px}
.weave-note-body li{margin:4px 0}
.weave-note-body input[type="checkbox"]{accent-color:var(--weave-accent);cursor:pointer}
.weave-note-body input[type="checkbox"]:disabled{cursor:wait}
.weave-note-body blockquote{
  padding-left:10px;border-left:2px solid var(--weave-line-strong);color:var(--weave-dim);
}
.weave-note-body code{
  font-family:var(--weave-mono);font-size:var(--weave-px-row);padding:1px 4px;
  background:var(--weave-panel);border:1px solid var(--weave-line);border-radius:var(--weave-radius);
}
.weave-note-body pre{
  margin:0 0 12px;padding:8px 10px;overflow:auto;
  background:var(--weave-panel);border:1px solid var(--weave-line);border-radius:var(--weave-radius);
}
.weave-note-body pre code{padding:0;background:none;border:0}
.weave-note-body hr{margin:16px 0;border:0;border-top:1px solid var(--weave-line)}
.weave-note-body table{border-collapse:collapse;margin:0 0 12px;font-size:var(--weave-px-row)}
.weave-note-body th,.weave-note-body td{padding:3px 8px;border:1px solid var(--weave-line);text-align:left}
.weave-note-body th{color:var(--weave-dim);font-weight:600}
.weave-note-body img{max-width:100%;height:auto}
/* Two link species, one underline discipline. An external link is underlined
   *before* any hover, in the quiet line-strong rather than the accent — it
   announces "this leaves the workspace" while it is still inert. A wikilink
   stays clean text until hover (it drives the §1.3 bus, not the browser, so
   the pointer is restored by hand); leaving vs staying is legible at a
   glance, with the same hover response once you commit. */
.weave-note-body a{
  color:var(--weave-accent);text-decoration:underline;text-decoration-color:var(--weave-line-strong);
  text-decoration-thickness:1px;text-underline-offset:2px;
}
.weave-note-body a:hover{text-decoration-color:var(--weave-accent)}
/* A ghost is a name with no note behind it: a dashed, dimmed affordance to
   create one. */
.weave-wiki{cursor:pointer;color:var(--weave-accent);text-decoration:none}
.weave-wiki:hover{text-decoration:underline}
.weave-wiki-ghost{
  cursor:help;color:var(--weave-faint);border-bottom:1px dashed var(--weave-faint);text-decoration:none;
}
.weave-wiki-ghost:hover{text-decoration:none}
/* The wikilink hover card (P6.3). Position comes from two custom properties
   the component writes per card (see Note.tsx's layout effect) — the CSP
   allows no style attribute, and these are the same CSSOM path the column
   widths take. \`pointer-events: none\` is load-bearing rather than cosmetic:
   the card is delegated no clicks and may cover one, so it must stay a
   *displayer* — the click underneath still reaches the wikilink and the
   §1.3 bus, and hovering "through" the card back to the link is impossible,
   which is what keeps hover and card from fighting each other. */
.weave-preview{
  position:fixed;left:var(--weave-preview-x,0);top:var(--weave-preview-y,0);z-index:5;
  width:280px;padding:8px 10px 9px;pointer-events:none;
  background:var(--weave-panel);border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius-pop);
  animation:weave-preview-in 140ms ease-out both;
}
.weave-preview-kind{
  display:block;margin:0 0 1px;font-size:var(--weave-px-prov);letter-spacing:.09em;text-transform:uppercase;color:var(--weave-faint);
}
.weave-preview-title{
  display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:var(--weave-px-ui);font-weight:600;color:var(--weave-fg);
}
.weave-preview-text{margin:5px 0 0;font-size:var(--weave-px-base);line-height:1.6;color:var(--weave-dim)}
/* A ghost's card is the offer, not the preview: it carries the same
   "no note" kind line the dashed link does, and the dimmer frame reads as
   "nothing here yet" before the text does. */
.weave-preview-ghost{border-style:dashed;border-color:var(--weave-faint)}
/* The card's one entrance. Declared here rather than in the shared motion
   block because it belongs to the note column alone, and the global
   reduced-motion kill switch below still reaches it — that is why motion
   must be a declared animation and never element.animate(). Fade and a 2px
   rise, in the overlay family's vocabulary but quieter: a card that
   underlines a hover should not land with a thud. */
@keyframes weave-preview-in{from{opacity:0;transform:translateY(2px)}}

/* graph column ---------------------------------------------------------- */
/* The canvas is a plain block sigma appends its own <canvas> layers into. It
   must have a definite size before sigma measures it, hence \`min-height\` and
   the \`1fr\` row from \`.weave-col-graph\` above — a zero-height container makes
   sigma refuse to render (we pass \`allowInvalidContainer\`, so it degrades to
   blank rather than throwing). */
.weave-graph{display:grid;grid-template-rows:1fr auto auto;min-height:0;overflow:hidden;position:relative}
.weave-graph-canvas{min-height:120px;min-width:0;position:relative;overflow:hidden}
/* A barely-there vignette, so the stage reads as a lit surface rather than a
   flat void. Sigma clears its WebGL layers transparent (no background colour
   is set in \`graphSettings\`), so this paints *under* the graph while sitting
   above it in paint order — a \`::after\` is the container's last child and
   sigma's layers are unpositioned in the stack, so the gradient draws over
   the WebGL output without a z-index fight. It is one radial gradient, from
   fully transparent mid-stage to a fifth-strength black veil at the corners:
   the eye gets an edge to measure the ground against, the gesture area loses
   nothing (\`pointer-events:none\`). Light takes the same shape from its own
   foreground, at half the strength, because a warm paper ground darkens
   faster than a dark one under a black veil. */
.weave-graph-canvas::after{
  content:"";position:absolute;inset:0;pointer-events:none;
  background:var(--weave-vignette);
}
.weave-graph-empty{
  margin:0;padding:14px var(--weave-gutter);color:var(--weave-dim);
  max-width:44ch;line-height:1.5;
}
.weave-graph-controls{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  padding:5px var(--weave-gutter);border-top:1px solid var(--weave-line);
}
.weave-graph-legend{
  margin-left:auto;display:flex;gap:9px;font-size:var(--weave-px-caption);color:var(--weave-faint);
  white-space:nowrap;
}
.weave-legend-on{color:var(--weave-accent)}
.weave-legend-near{color:var(--weave-fg)}
/* The third entry is the one the graph actually draws most when a selection
   dims its neighbourhood: unrelated nodes keep their own colour and recede to
   a 15 % blend of it into --weave-bg (the WebGL side has no per-node alpha),
   and the legend names that state instead of leaving it unexplained. */
.weave-legend-dim{color:var(--weave-faint)}
.weave-graph-count{
  margin:0;padding:3px var(--weave-gutter);font-size:var(--weave-px-caption);color:var(--weave-faint);
  border-top:1px solid var(--weave-line);
}

/* graph spotlight (G1) ---------------------------------------------------
   The field floating top-left over the canvas, and the side sheet top-right.
   Both are overlays on the stage, so they sit on the panel ground with a
   hairline and the pop radius — no elevation shadow, per the sheet's rule.
   The spotlight's voice is --weave-warn: the highlighter colour the WebGL
   side paints lit edges in (graph.model.ts SPOTLIGHT_EDGE_SLOT), so the chip,
   the legend, the marked words and the lit dots all say "lit" in one hue.
   The sheet stops short of the control strip and count line under the
   canvas (about 54px together) and scrolls inside itself. Button rules are
   qualified by their overlay (.weave-sheet .weave-sheet-open) because the
   workspace sheet's \`.weave-workbench button{font:inherit;color:inherit}\`
   reset is installed later and would outrank a single class. */
.weave-spotlight{
  position:absolute;z-index:3;top:10px;left:10px;width:min(330px,calc(100% - 20px));box-sizing:border-box;
  display:flex;align-items:center;gap:6px;padding:3px 5px 3px 9px;
  color:var(--weave-faint);background:var(--weave-panel);
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius-pop);
}
/* The pill is the focus ring: the input inside it drops the global outline
   and the frame takes a 2px accent edge (border plus an inset hairline). */
.weave-spotlight:focus-within{border-color:var(--weave-accent);box-shadow:inset 0 0 0 1px var(--weave-accent)}
.weave-spotlight-input:focus-visible{outline:none}
.weave-spotlight-on{color:var(--weave-warn)}
.weave-spotlight-icon{flex:none;display:block}
.weave-spotlight-input{
  flex:1;min-width:0;height:24px;padding:0;font:inherit;font-size:var(--weave-px-row);
  color:var(--weave-fg);background:transparent;border:0;outline:0;
}
.weave-spotlight-input::placeholder{color:var(--weave-faint)}
.weave-spotlight-input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.weave-spotlight-count{
  flex:none;padding:1px 7px;font-size:var(--weave-px-caption);font-weight:650;white-space:nowrap;
  color:var(--weave-warn);background:color-mix(in srgb,var(--weave-warn) 16%,transparent);border-radius:999px;
}
.weave-spotlight-none{color:var(--weave-dim);background:var(--weave-line)}
.weave-spotlight-by{flex:none;font-size:var(--weave-px-caption);color:var(--weave-dim);white-space:nowrap}
.weave-spotlight .weave-spotlight-clear{
  flex:none;padding:1px 5px;cursor:pointer;font-family:var(--weave-mono);font-size:var(--weave-px-prov);
  color:var(--weave-faint);background:transparent;border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius);
}
.weave-spotlight .weave-spotlight-clear:hover{color:var(--weave-fg);border-color:var(--weave-accent)}
.weave-legend-lit{color:var(--weave-warn)}
.weave-sheet{
  position:absolute;z-index:3;top:10px;right:10px;width:min(300px,calc(100% - 20px));max-height:calc(100% - 74px);
  box-sizing:border-box;overflow:auto;padding:12px 14px 14px;
  font-size:var(--weave-px-base);color:var(--weave-fg);background:var(--weave-panel);
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius-pop);
}
.weave-sheet .weave-sheet-close{
  position:absolute;top:6px;right:6px;width:24px;height:24px;padding:0;cursor:pointer;
  font-size:var(--weave-px-display);line-height:1;color:var(--weave-dim);
  background:transparent;border:0;border-radius:var(--weave-radius);
}
.weave-sheet .weave-sheet-close:hover{color:var(--weave-fg);background:var(--weave-line)}
.weave-sheet-crumb{
  margin:0 28px 2px 0;display:flex;align-items:center;gap:5px;min-width:0;
  font-size:var(--weave-px-caption);color:var(--weave-faint);
}
.weave-sheet-crumb span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.weave-sheet-title{
  margin:0 20px 4px 0;font-size:var(--weave-px-title);font-weight:650;line-height:1.3;overflow-wrap:anywhere;
}
.weave-sheet-meta{margin:0;display:flex;align-items:center;gap:5px;font-size:var(--weave-px-ui);color:var(--weave-dim);text-transform:capitalize}
.weave-sheet-when{color:var(--weave-faint);text-transform:none}
.weave-sheet-text{
  margin:10px 0 0;padding:8px 10px;line-height:1.55;overflow-wrap:anywhere;
  background:var(--weave-new);border:1px solid color-mix(in srgb,var(--weave-accent) 30%,transparent);
  border-radius:var(--weave-radius-pop);
}
.weave-sheet-text-head{
  display:block;margin:0 0 2px;font-size:var(--weave-px-prov);font-weight:700;letter-spacing:.09em;
  text-transform:uppercase;color:var(--weave-accent);
}
.weave-sheet-mark{border-radius:var(--weave-radius)}
.weave-sheet-why{margin:8px 0 0;display:flex;gap:5px;font-size:var(--weave-px-caption);color:var(--weave-dim)}
.weave-sheet-why span{color:var(--weave-warn)}
.weave-sheet-section{margin:12px 0 0}
.weave-sheet-heading{
  margin:0 0 3px;display:flex;align-items:center;font-size:var(--weave-px-caption);font-weight:600;
  letter-spacing:.09em;text-transform:uppercase;color:var(--weave-faint);
}
.weave-sheet-count{margin-left:auto;font-family:var(--weave-mono);letter-spacing:0}
.weave-sheet-rows{margin:0;padding:0;list-style:none}
.weave-sheet .weave-sheet-row{
  display:flex;align-items:center;gap:7px;width:100%;padding:3px 0;cursor:pointer;text-align:left;
  font:inherit;font-size:var(--weave-px-row);color:var(--weave-fg);background:none;border:0;
}
.weave-sheet .weave-sheet-row:hover{color:var(--weave-accent)}
.weave-sheet-row-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.weave-sheet-dot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--weave-faint)}
.weave-sheet-dot-lit{background:var(--weave-warn)}
.weave-sheet-more{margin:2px 0 0;font-size:var(--weave-px-caption);color:var(--weave-faint)}
.weave-sheet-actions{margin:14px 0 0;display:flex;gap:6px;flex-wrap:wrap}
.weave-sheet .weave-sheet-open,.weave-sheet .weave-sheet-split{
  padding:5px 11px;cursor:pointer;font:inherit;font-size:var(--weave-px-ui);font-weight:600;
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius);
}
.weave-sheet .weave-sheet-open{color:var(--weave-page);background:var(--weave-accent);border-color:var(--weave-accent)}
.weave-sheet .weave-sheet-open:hover{filter:brightness(1.08)}
.weave-sheet .weave-sheet-split{color:var(--weave-fg);background:var(--weave-page)}
.weave-sheet .weave-sheet-split:hover{border-color:var(--weave-accent)}
/* Side by side the field (330) and the sheet (300) need about 660px of
   stage; a narrower graph — a split pane, a small window — drops the sheet
   under the field instead of letting the two overlap. */
.weave-graph{container-type:inline-size}
@container (max-width:680px){.weave-sheet{top:50px;max-height:calc(100% - 114px)}}
/* end graph spotlight ---------------------------------------------------- */

/* context rail ---------------------------------------------------------- */
/* The \`.weave-empty\` block that used to sit above went with \`EmptyState.tsx\`
   in P3: every column now has its own empty state (\`treeEmptyMessage\`,
   \`noteEmptyMessage\`, \`graphEmptyMessage\`, \`RAIL_EMPTY\`), each rendered as a
   plain paragraph, so the shared placeholder had no callers left. */
.weave-rail{
  display:flex;flex-direction:column;min-height:0;overflow:auto;
  border-top:1px solid var(--weave-line);background:var(--weave-panel);
}
.weave-ctx-empty{margin:0;padding:10px var(--weave-gutter);color:var(--weave-dim);line-height:1.5}
/* Groups tighten to the tree's rhythm: 2px of air above, none below, the
   heading carrying the separation itself. The heading is now a <button> and
   therefore needs the control reset a heading never did — margins, background,
   border, cursor — plus a full-width flex row so the count badge lands on the
   right edge of the *column*, not of the text. */
.weave-ctx-group{padding:2px var(--weave-gutter) 2px}
.weave-trail{padding-top:6px;padding-bottom:6px;border-bottom:1px solid var(--weave-line)}
.weave-trail-head{display:flex;align-items:center;gap:6px;font-size:var(--weave-px-caption);font-weight:600;letter-spacing:.09em;color:var(--weave-faint);text-transform:uppercase}
.weave-trail-head .weave-ctx-count{margin-left:0}
.weave-trail-turn{font:inherit;font-size:var(--weave-px-caption);letter-spacing:0;text-transform:none;color:var(--weave-dim);background:none;border:1px solid var(--weave-line);border-radius:var(--weave-radius);padding:0 6px;cursor:pointer}
.weave-trail-turn:hover{color:var(--weave-fg)}
.weave-trail-turn-on{color:var(--weave-accent);border-color:var(--weave-accent)}
.weave-trail-steps{margin:4px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.weave-trail-step{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;padding-left:10px;position:relative;line-height:1.45}
.weave-trail-step::before{content:"";position:absolute;left:0;top:.55em;width:6px;height:6px;border-radius:999px;background:var(--weave-warn)}
.weave-trail-read::before{background:var(--weave-ok)}
.weave-trail-wrote::before{background:var(--weave-accent)}
.weave-trail-verb{color:var(--weave-dim)}
.weave-trail-detail{color:var(--weave-faint);font-family:var(--weave-mono);font-size:var(--weave-px-caption)}
.weave-trail-note{font:inherit;color:var(--weave-fg);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-decoration-color:var(--weave-line-strong);text-underline-offset:2px}
.weave-trail-note:hover{color:var(--weave-accent)}
.weave-trail-empty{margin:4px 0 0;color:var(--weave-faint)}
.weave-trail-turns{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.weave-ctx-head{margin:0}
.weave-ctx-heading{
  display:flex;align-items:center;gap:5px;width:100%;margin:0;padding:2px 0;
  font:inherit;font-size:var(--weave-px-caption);font-weight:600;letter-spacing:.09em;color:var(--weave-faint);
  text-align:left;background:none;border:0;cursor:pointer;
}
.weave-ctx-heading:hover{color:var(--weave-fg)}
/* The count is a mono voice like the other status numbers, so a rail that
   says "BACKLINKS 4" in the text face would be the one thing off-key. */
.weave-ctx-count{
  margin-left:auto;font-family:var(--weave-mono);font-size:var(--weave-px-caption);
  letter-spacing:0;color:var(--weave-faint);font-weight:400;
}
/* The chevron rides the heading's colour — quiet at rest, fg on hover or
   open — so it never becomes a third accent voice in a rail that already
   spends --weave-new on the selected row. */
.weave-ctx-chevron{display:inline-flex;color:inherit}
.weave-ctx-rows,.weave-ctx-tags{margin:0;padding:0;list-style:none}
.weave-ctx-row{display:flex}
/* Row vocabulary, unified with the tree's rather than merely similar to it:
   hover raises the ground and steps the label to fg, the selected row takes
   the --weave-new tint plus the same 2px inset accent bar. The radius is gone
   deliberately — tree rows are square (the radius scale's own rule: sharp for
   rails and rows), and the rail's 4px corner was the one row left rounding. */
.weave-ctx-link{
  display:flex;align-items:center;gap:5px;width:100%;min-width:0;
  font:inherit;font-size:var(--weave-px-row);text-align:left;color:var(--weave-fg);
  background:none;border:0;padding:2px var(--weave-gutter) 2px 0;cursor:pointer;
}
.weave-ctx-row:hover .weave-ctx-link{background:var(--weave-line)}
.weave-ctx-row:hover .weave-label{color:var(--weave-fg)}
.weave-ctx-row.weave-row-on .weave-ctx-link{background:var(--weave-new);box-shadow:inset 2px 0 0 var(--weave-accent)}
.weave-ctx-tag{margin:0 0 3px}
.weave-ctx-tag .weave-ctx-rows{padding-left:12px}

/* workspace footer ------------------------------------------------------ */
/* The status items share one mid-dot separator in --weave-faint. */
.weave-status{
  display:flex;align-items:center;gap:8px;height:22px;padding:0 var(--weave-gutter);
  font-family:var(--weave-mono);font-size:var(--weave-px-ui);color:var(--weave-dim);
  border-top:1px solid var(--weave-line);background:var(--weave-panel);
}
.weave-status-sel::before{content:"·";margin-right:8px;color:var(--weave-faint)}
.weave-status-cwd,.weave-status-sel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.weave-status-cwd{max-width:38%;color:var(--weave-faint)}
.weave-status-sel{color:var(--weave-fg)}
.weave-status-hint{margin-left:auto;padding-left:8px;white-space:nowrap;color:var(--weave-faint)}

/* overlays: the ⌘K palette and the ? help sheet (P4) --------------------- */
/* The scrim is a click target that closes, and the reason both overlays sit
   at the top of the stacking context rather than inside a column: a dialog
   that a column's \`overflow:hidden\` can clip is a dialog that disappears at
   the wrong breakpoint. */
.weave-scrim{
  position:fixed;inset:0;z-index:10;display:flex;justify-content:center;
  align-items:flex-start;padding:9vh 16px 16px;background:var(--weave-scrim);
}
.weave-palette,.weave-help{
  display:flex;flex-direction:column;width:100%;max-width:560px;max-height:72vh;
  overflow:hidden;background:var(--weave-panel);color:var(--weave-fg);
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius-pop);
}
/* The ⌘K palette, grouped and compact: an input row (glyph, query, Esc), a
   scope row of pills that Tab cycles, one line per result under small
   capitals group heads, and a footer of key hints. Wider than the help sheet
   because a row carries a title, a snippet and a meta column side by side. */
.weave-palette{max-width:640px}
.weave-palette-bar{
  flex:none;display:flex;align-items:center;gap:8px;padding:0 11px;
  border-bottom:1px solid var(--weave-line);
}
.weave-palette-glyph{color:var(--weave-faint)}
.weave-palette-input{
  flex:1;min-width:0;height:36px;padding:0;font:inherit;font-size:var(--weave-px-subhead);
  color:var(--weave-fg);background:transparent;border:0;border-radius:0;
}
.weave-palette-input:focus-visible{outline:0}
.weave-palette-input::-webkit-search-cancel-button{display:none}
.weave-palette-bar:focus-within{box-shadow:inset 0 -1px 0 var(--weave-accent)}
.weave-palette-kbd{
  flex:none;padding:0 4px;font-family:inherit;font-size:var(--weave-px-prov);line-height:14px;
  color:var(--weave-faint);border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius);
}
.weave-palette-scopes{
  flex:none;display:flex;flex-wrap:wrap;gap:3px;padding:5px 8px;
  border-bottom:1px solid var(--weave-line);
}
.weave-palette-scope{
  font:inherit;font-size:var(--weave-px-caption);line-height:1;padding:3px 9px;cursor:pointer;
  color:var(--weave-dim);background:none;border:0;border-radius:999px;
}
.weave-palette-scope:hover{color:var(--weave-fg);background:var(--weave-line)}
.weave-palette-scope[aria-pressed="true"]{color:var(--weave-panel);background:var(--weave-fg);font-weight:600}
.weave-palette-scope-count{font-variant-numeric:tabular-nums}
.weave-hits{flex:1;min-height:0;overflow:auto;margin:0;padding:0 0 4px;list-style:none}
.weave-hit-section{list-style:none}
.weave-hit-group{
  padding:7px 11px 2px;font-size:var(--weave-px-prov);font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:var(--weave-faint);
}
.weave-hit-rows{margin:0;padding:0;list-style:none}
.weave-hit{
  display:flex;align-items:center;gap:8px;padding:3px 11px;cursor:pointer;
  min-width:0;white-space:nowrap;font-size:var(--weave-px-row);
}
.weave-hit-on{background:var(--weave-new);box-shadow:inset 2px 0 0 var(--weave-accent)}
.weave-hit-icon{color:var(--weave-faint)}
.weave-hit-notes .weave-hit-icon{color:var(--weave-accent)}
.weave-hit-label{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:var(--weave-fg)}
.weave-hit-mono{font-family:var(--weave-mono);font-size:var(--weave-px-ui);font-weight:500}
.weave-hit-detail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:var(--weave-px-ui);color:var(--weave-dim)}
/* The match marks (search rows, the graph sheet) are a find-in-page amber.
   Dark themes tint their own light --weave-warn, and the marked words go
   white: the theme's text on that tint measured 3.3–3.6:1 in the Catppuccin
   darks, white is 5.5:1 or better in every dark theme. A light theme's
   --weave-warn is a deep brown that tints to mud, so light schemes take a
   fixed amber under their own text instead. */
.weave-hit-mark,.weave-sheet-mark{color:#fff;background:color-mix(in srgb,var(--weave-warn) 28%,transparent)}
.weave-hit-mark{border-radius:var(--weave-radius);padding:0 1px}
:root[data-weave-scheme="light"] .weave-hit-mark,:root[data-weave-scheme="light"] .weave-sheet-mark{color:var(--weave-fg);background:color-mix(in srgb,#f2a93b 34%,transparent)}
.weave-hit-meta{flex:none;margin-left:auto;font-size:var(--weave-px-caption);color:var(--weave-faint);font-variant-numeric:tabular-nums}
.weave-palette-status{margin:0;padding:14px 11px;color:var(--weave-dim);line-height:1.5}
.weave-palette-foot,.weave-help-foot{
  display:flex;gap:12px;margin:0;padding:4px 11px;font-size:var(--weave-px-caption);color:var(--weave-faint);
  border-top:1px solid var(--weave-line);
}
.weave-palette-foot{align-items:center;flex-wrap:wrap;row-gap:2px;min-height:26px;box-sizing:border-box;background:var(--weave-bg)}
.weave-palette-light{
  margin-left:auto;display:flex;align-items:center;gap:6px;padding:0;cursor:pointer;white-space:nowrap;
  font:inherit;font-weight:600;color:var(--weave-accent);background:none;border:0;
}
.weave-palette-light .weave-palette-kbd{color:inherit;border-color:currentColor}
.weave-help-hint{margin-left:auto}
.weave-help-title{margin:0;padding:9px 11px;font-size:var(--weave-px-base);font-weight:600;border-bottom:1px solid var(--weave-line)}
.weave-keys{flex:1;min-height:0;overflow:auto;margin:0;padding:5px 11px}
.weave-key-group{margin:0 0 3px;font-size:var(--weave-px-prov);letter-spacing:.09em;text-transform:uppercase;color:var(--weave-faint)}
.weave-key-row{display:flex;align-items:baseline;gap:9px;padding:1px 0}
.weave-key-combo{
  flex:none;min-width:74px;font-family:var(--weave-mono);font-size:var(--weave-px-ui);color:var(--weave-accent);
}
.weave-key-what{flex:1;min-width:0;font-size:var(--weave-px-row)}

/* focus ----------------------------------------------------------------- */
:focus-visible{outline:2px solid var(--weave-accent);outline-offset:1px}
/* Text selection rides the accent, not the browser default: a selection in
   the ⌘K palette and a selection while editing stay *of* this theme, and the
   --weave-new tint is exactly an accent at a strength text stays legible in. */
::selection{background:var(--weave-new)}
/* Every scroller in the workspace (rows, note body, rail, palette results,
   help sheet) gets the same thin chrome: the default scrollbar is a
   15 px system object the hairline aesthetic cannot afford, and Firefox and
   the Blink/WebKit pair cover the whole surface with these five rules. */
*{scrollbar-width:thin;scrollbar-color:var(--weave-line-strong) transparent}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--weave-line-strong);border-radius:var(--weave-radius)}
::-webkit-scrollbar-thumb:hover{background:var(--weave-faint)}
/* motion -----------------------------------------------------------------
   The one place motion is declared, directly above the kill switch that
   neutralises it: every animated thing in the sheet is either in the
   transition list or carries one of the three animation names, which is what
   keeps the reduced-motion rule sufficient by construction — a future
   element.animate() call would duck under it and is therefore not motion
   this sheet may use. Transitions cover the interactive set (hover states
   that would otherwise snap); entrances are overlay-only, because exits
   would need delay-unmount plumbing far past polish. Compositor-safe
   properties only — colour, border, opacity, transform; height and padding
   snap. */
.weave-row,.weave-ctx-link,.weave-chip,.weave-ribbon button,
.weave-hit,.weave-note-open{
  transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease;
}
.weave-scrim{animation:weave-fade-in 140ms ease-out both}
.weave-palette,.weave-help{animation:weave-overlay-in 160ms ease-out both}
@keyframes weave-fade-in{from{opacity:0}}
@keyframes weave-overlay-in{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}
`;

// --- installation --------------------------------------------------------------

/** A `<style>` element, as far as this module is concerned. */
export interface StyleElement {
  /** The IDL property, not the content attribute. See the module header. */
  nonce?: string | undefined;
  textContent: string | null;
}

/**
 * The slice of `document` the installer needs.
 *
 * Four members, so a fake is a short object literal and the real `document`
 * satisfies it structurally.
 */
export interface ThemeHost {
  createElement(tag: "style"): StyleElement;
  /** Used to find an element the server already nonce'd. */
  querySelector(selector: string): StyleElement | null;
  head: { appendChild(node: StyleElement): unknown };
}

/**
 * Where to look for a nonce, in order.
 *
 * The server's `<style>` block first because it is guaranteed present and is
 * the same kind of element we are about to create. The bundle's own `<script>`
 * is the fallback: it carries the same per-response nonce, and it exists by
 * definition, because it is the thing currently running.
 */
export const NONCE_SOURCES = ["style[nonce]", "style", "script[nonce]", "script[src]"];

/** Read the per-response nonce from the document, or `null`. */
export function findNonce(host: ThemeHost): string | null {
  for (const selector of NONCE_SOURCES) {
    const nonce = host.querySelector(selector)?.nonce;
    if (typeof nonce === "string" && nonce !== "") return nonce;
  }
  return null;
}

/**
 * Install {@link THEME_CSS} into the document.
 *
 * Returns whether a nonce was found and applied. A `false` return means the
 * browser will refuse the sheet — the workspace still renders, using only
 * `page.ts`'s palette and the browser's defaults, which is ugly but legible.
 * That is the right failure: silently weakening the CSP to guarantee styling
 * would trade a cosmetic problem for a security one.
 *
 * The element is appended even without a nonce, deliberately. It costs
 * nothing, it keeps the two paths identical, and the resulting CSP violation
 * report in the console is a far better diagnostic than a stylesheet that was
 * never created.
 */
export function installTheme(host: ThemeHost, css: string = THEME_CSS + WORKSPACE_CSS): boolean {
  const element = host.createElement("style");
  const nonce = findNonce(host);
  if (nonce !== null) element.nonce = nonce;
  element.textContent = css;
  host.head.appendChild(element);
  return nonce !== null;
}
