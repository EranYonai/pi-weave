/**
 * The workspace stylesheet, and how it gets past the CSP
 * (weave-workspace §1.2, §5.2).
 *
 * ## Why the client ships CSS at all
 *
 * `page.ts` emits a nonce'd `<style>` block, but it is deliberately tiny —
 * the custom-property palette and enough body rules that the first paint has
 * a background colour before `app.js` parses. It knows nothing about a grid,
 * a divider or a status bar, and it is owned by the server tier, which this
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
 *     all, which is why `cssvars.ts` applies column widths that way and why
 *     dynamic layout works here. Confirmed against Preact's own behaviour:
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

/**
 * The theme.
 *
 * Dark-first, per the task's brief and against `page.ts`'s light-first
 * fallback. That inversion is intentional and safe: this sheet is installed
 * *after* the server's, so its `:root` wins on equal specificity, and the
 * light branch is re-stated under `prefers-color-scheme: light`. The server
 * block keeps doing its real job — painting a correct background before this
 * bundle has parsed — while the palette a user actually looks at is decided
 * here.
 *
 * And since `shell/theme.model.ts`, the palette a user looks at is a
 * *choice*: `:root` carries dark, the light tokens sit in
 * {@link LIGHT_TOKENS} and are applied by a `data-weave-theme` attribute
 * (a manual selection) and by the media query narrowed with
 * `:root:not([data-weave-theme="dark"])` (the system default). Clearing the
 * attribute returns the workspace to following the OS with no client-side
 * listener involved. The graph follows the same resolution through
 * `theme.model.ts`'s `effectiveScheme`, because its WebGL palette cannot
 * read any of this.
 *
 * ## "Dense but calm" (§1.2)
 *
 * The sketch is an information-dense IDE surface, not a marketing page, so
 * the rules below deliberately avoid the defaults that produce the opposite:
 * no card shadows, no 24 px gutters, no rounded panels floating on a
 * contrasting background. Density comes from a 13 px base, 4–10 px padding
 * and 1 px hairline rules; calm comes from a **single** accent colour used
 * only for focus and selection, three greys doing all the structural work,
 * and no borders where a background change already separates two regions.
 *
 * ## Where the hexes come from
 *
 * Both schemes are Catppuccin (the user's call): dark is **Macchiato**, light
 * is **Latte**, mapped onto the desk-and-page split with one structural rule
 * shared by both — the note page is the `crust` ground, rails and bars are
 * `mantle`, the desk and graph canvas are `base`, raised controls and
 * hairlines are `surface0` with `surface1` for the strong hairline. Light's
 * topology is therefore an exact mirror of dark's (a darker sheet on a lighter
 * desk), so a token means the same thing in either scheme:
 *
 * - **Dark, Macchiato** — every value a stock Catppuccin label: `base #24273A`
 *   desk, `mantle #1E2030` panel, `crust #181926` page, `surface0 #363A4F`
 *   raise/hairline, `surface1 #494D64` strong hairline; text `#CAD3F5`,
 *   dims `#A5ADCB`/`#939AB7`, and **Mauve `#C6A0F6` as the single accent
 *   voice** (7.5:1 on panel) with Green/Yellow/Red as status.
 *
 * - **Light, Latte** — grounds are stock labels again (`base #EFF1F5` desk,
 *   `mantle #E6E9EF` panel, `crust #DCE0E8` page, `surface0 #CCD0DA`,
 *   `surface1 #BCC0CC`), and text/status hue-preservingly *deepened* to hold
 *   4.5:1 on the darkest grounds Latte owns: `dim #56586A` (from Subtext0,
 *   same hue 233°), `faint #606274` (Overlay2), `accent #7113EC` (Mauve),
 *   `ok #28641B`, `warn #7C4F10`, `bad #B20D30`. Text `#4C4F69` is stock
 *   Text. The hue-preserving deepening keeps the palette recognisably
 *   Catppuccin where blending toward neutral would grey it away.
 *
 * Measured ratios (WCAG, on the darkest grounds — `raise`/`surface0` for
 * light text tokens, `panel`/`mantle` for dark): light fg 4.5, dim 4.5,
 * accent 4.5, ok 4.6, warn 4.6, bad 4.5, each also ≥ 4.5 on the brighter
 * grounds; dark faint 4.6 on `surface0` and 5.8 on panel, dim 5.0 on
 * `surface0`, fg 7.6. The one below-4.5 site is `faint` *on* `raise`
 * (light 3.9) — every use is non-text there (scrollbar thumb, ghost
 * borders, icon glyphs), where WCAG asks 3:1.
 *
 * Status colours keep each scheme's temperature at ≥ 4.5:1 text contrast —
 * measured, not eyeballed (dark `#a6da95`/`#1e2030` 10.0, `#eed49f` 11.2,
 * `#ed8796` 6.5; light values are the deepened derivatives above).
 *
 * The graph cannot read these variables (WebGL — `graph.model.ts`), so
 * `GRAPH_PALETTE` mirrors the eight palette slots as literals; the test that makes
 * that copy safe asserts every mirrored hex appears in this string.
 */
/**
 * The light-block tokens, interpolated into both selectors that need them —
 * see the {@link THEME_CSS} branch rules.
 */
const LIGHT_TOKENS = `
    --weave-bg:#eff1f5;--weave-panel:#e6e9ef;--weave-raise:#ccd0da;--weave-fg:#4c4f69;--weave-dim:#56586a;
    --weave-faint:#606274;--weave-line:#ccd0da;--weave-line-strong:#bcc0cc;
    --weave-accent:#7113ec;--weave-ok:#28641b;--weave-warn:#7c4f10;--weave-bad:#b20d30;
    --weave-new:rgba(113,19,236,.10);
    --weave-page:#dce0e8;
  `;

export const THEME_CSS = `
:root{
  --weave-bg:#24273a;--weave-panel:#1e2030;--weave-raise:#363a4f;--weave-fg:#cad3f5;--weave-dim:#a5adcb;
  --weave-faint:#939ab7;--weave-line:#363a4f;--weave-line-strong:#494d64;
  --weave-accent:#c6a0f6;--weave-ok:#a6da95;--weave-warn:#eed49f;--weave-bad:#ed8796;
  --weave-new:rgba(198,160,246,.16);
  --weave-row:26px;--weave-gutter:10px;
  /* The reading gutter is note-only: prose wants a wider margin than chrome.
     Rails, rows and bars keep --weave-gutter, so density is a property of the
     furniture and generosity a property of the page. */
  --weave-note-gutter:18px;
  /* The desk-and-page split. The workspace is a desk of instruments — tree,
     graph, rail, bars — on the --weave-bg ground; the note column is the one
     *page* lying on it: crust in both Catppuccin schemes, the ground that
     sits furthest from the desk (deep under dark, bright over light). Two
     voices in total: sans for instruments and prose alike, mono for data — a
     third face was tried (serif prose) and withdrawn at the user's call; two
     voices read calmer than three. The CSP allows nothing fetched, and both
     are system stacks. */
  --weave-page:#181926;
  /* Two radii, per the plan: hairline-sharp for controls (a 4 px corner is
     the difference between a control and a card), one softer corner for the
     two overlays that float above the grid. Tag pills are 999px — a capsule
     shape, not a scale step. The gate test below refuses any literal px
     radius so the scale cannot drift back. */
  --weave-radius:4px;--weave-radius-pop:7px;
  /* The type ramp, role-named because sizes drift and roles stick. Nine
     steps; every font-size in this sheet is one of these vars — that is a
     gate, not a convention:
       prov     9.5   micro badges, kind glyphs, uppercase key groups
       caption  10.5  chips, meta, counts, legend, column overlines
       ui       11.5  status bar, the note's meta row, small controls
       row      12    list rows, text inputs, inline code
       base     13    body copy, h3-h6, preview-card text
       body     13.5  the note column's prose and its mono editor
       subhead  14    palette input, note-body h2, header icon buttons
       title    15    note-body h1
       display  20    the note's page title
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
  --weave-px-subhead:14px;--weave-px-title:15px;--weave-px-display:20px;
}
/* The light tokens, shared verbatim by the attribute branch and the media
   query below — one const interpolated twice is the only way CSS gets
   "these are the same colours" without a preprocessor. Which branch wins is
   theme.model.ts's business: the attribute carries a *manual* choice, the
   media query the system default, and the :not() is what lets the two coexist
   without a manual "dark" being dragged back into light by the OS. */
@media (prefers-color-scheme: light){
  :root:not([data-weave-theme="dark"]){
    ${LIGHT_TOKENS}
  }
}
:root[data-weave-theme="light"]{
  ${LIGHT_TOKENS}
}
body{font-size:var(--weave-px-base)}
#app{height:100%;display:grid;grid-template-rows:auto 1fr auto;background:var(--weave-bg)}

/* header --------------------------------------------------------------- */
.weave-header{
  display:flex;align-items:center;gap:14px;padding:0 var(--weave-gutter);
  height:34px;border-bottom:1px solid var(--weave-line);background:var(--weave-panel);
}
.weave-brand{display:inline-flex;align-items:center;gap:6px;font-size:var(--weave-px-subhead);font-weight:600;letter-spacing:.01em;white-space:nowrap}
.weave-brand-mark{height:20px;width:20px;border-radius:var(--weave-radius)}
/* A button styled as a search field: the palette owns the only text input,
   so this opens it rather than pretending to accept a query. */
.weave-search{
  display:flex;align-items:center;gap:6px;flex:0 1 260px;min-width:0;
  height:22px;padding:0 7px;font:inherit;font-size:var(--weave-px-row);text-align:left;cursor:pointer;
  color:var(--weave-dim);background:var(--weave-bg);
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius);
}
.weave-search:hover{color:var(--weave-fg);border-color:var(--weave-accent)}
.weave-search-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.weave-search kbd{
  font-family:var(--weave-mono);font-size:var(--weave-px-caption);color:var(--weave-faint);
  padding:1px 5px;border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius);white-space:nowrap;
}
.weave-summary{
  margin-left:auto;display:flex;gap:9px;font-family:var(--weave-mono);
  font-size:var(--weave-px-ui);color:var(--weave-dim);white-space:nowrap;
}
.weave-summary-part+.weave-summary-part::before{content:"·";margin-right:9px;color:var(--weave-faint)}
.weave-refresh{
  font:inherit;font-size:var(--weave-px-subhead);line-height:1;color:var(--weave-dim);background:none;
  border:0;padding:3px 5px;border-radius:var(--weave-radius);cursor:pointer;
  display:inline-flex;align-items:center;
}
.weave-refresh:hover{color:var(--weave-fg);background:var(--weave-line)}
/* One full 600 ms turn per click ("the request left"), not a loop: the
   refetch is fire-and-forget and a 304 may never fire a completion signal
   for a spinner to wait on. Reduced-motion restores the static stroke. */
.weave-refresh-spinning{animation:weave-refresh-turn 600ms ease-out}
@keyframes weave-refresh-turn{from{transform:rotate(0)}to{transform:rotate(360deg)}}
/* The theme cycle (shell/theme.model.ts). Same shape as the refresh button:
   an icon-size control in a 34 px bar, glyph-only because the filled/half/
   hollow family already means something in this workspace. */
.weave-theme{
  font:inherit;font-size:var(--weave-px-base);line-height:1;color:var(--weave-dim);background:none;
  border:0;padding:3px 6px;border-radius:var(--weave-radius);cursor:pointer;
}
.weave-theme:hover{color:var(--weave-fg);background:var(--weave-line)}

/* connection indicator -------------------------------------------------- */
.weave-conn{display:inline-flex;align-items:center;gap:5px;font-size:var(--weave-px-ui);white-space:nowrap}
.weave-conn-dot{font-size:var(--weave-px-prov);line-height:1}
/* Reconnecting breathes instead of sitting there: the one state whose whole
   message is "hold on, I am still working" is the one that should keep
   saying it. The offline dot stays still — its message needs a decision,
   not patience. The global reduced-motion kill switch restores the static
   dot, the same way it does every animation in this sheet. */
.weave-conn-ok .weave-conn-dot,.weave-conn-ok{color:var(--weave-ok)}
.weave-conn-warn .weave-conn-dot,.weave-conn-warn{color:var(--weave-warn)}
.weave-conn-warn .weave-conn-dot{animation:weave-conn-pulse 1.6s ease-in-out infinite}
.weave-conn-bad .weave-conn-dot,.weave-conn-bad{color:var(--weave-bad)}
@keyframes weave-conn-pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* the grid -------------------------------------------------------------- */
/* Widths arrive as custom properties from cssvars.ts — the CSSOM path. The
   fallbacks keep the layout sane for the first frame and if a write is ever
   missed. */
.weave-grid{display:grid;min-height:0;overflow:hidden;background:var(--weave-line)}
.weave-grid[data-columns="3"]{
  grid-template-columns:var(--weave-col-tree,22%) 1px var(--weave-col-note,46%) 1px var(--weave-col-graph,32%);
}
.weave-grid[data-columns="2"]{grid-template-columns:var(--weave-col-tree,32%) 1px var(--weave-col-note,68%)}
.weave-grid[data-columns="1"]{grid-template-columns:1fr}

.weave-col{
  display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;
  background:var(--weave-bg);
}
.weave-col-title{
  margin:0;padding:5px var(--weave-gutter) 4px;font-size:var(--weave-px-caption);font-weight:600;
  letter-spacing:.09em;text-transform:uppercase;color:var(--weave-faint);
  border-bottom:1px solid var(--weave-line);
}
/* Title, then the graph (which takes the slack), then the context rail. The
   1fr is what gives .weave-graph-canvas a definite height to measure, and the
   rail's row is a fixed fraction of the column — not content-sized — so
   moving the selection between a sparsely-connected note and a richly
   connected one never repartitions the right-hand column: the rail scrolls
   inside the same region instead of squeezing the graph. */
.weave-col-graph{display:grid;grid-template-rows:auto minmax(0,1fr) minmax(96px,40%);background:var(--weave-bg)}

/* dividers -------------------------------------------------------------- */
.weave-divider{
  background:var(--weave-line);cursor:col-resize;position:relative;
  touch-action:none;
}
/* A 1 px target is unhittable, so the hit area is widened with a pseudo
   element rather than by making the visible rule thicker. */
.weave-divider::after{content:"";position:absolute;inset:0 -3px;z-index:1}
.weave-divider:hover,.weave-divider:focus-visible{background:var(--weave-accent);outline:none}

/* tree column ----------------------------------------------------------- */
/* --weave-depth is written per row by \`depthVar\`, through the same CSSOM
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
/* The session fold (tree.model.ts's isMuted): machine-written memory that
   accrues by the dozens with near-duplicate titles, dropped one notch so the
   rows a human wrote keep the foreground. --weave-dim holds ≥ 4.5 on both
   grounds, so this is quiet, not illegible — and the two states below always
   restore full weight, which is why the model never emits both classes on
   one row. */
.weave-row-muted .weave-label{color:var(--weave-dim)}
.weave-row-muted:hover .weave-label{color:var(--weave-fg)}
/* The selection has one voice. On the tinted ground every quieter token still
   fails contrast — even --weave-dim lands under 4.5 — so a selected row's
   kind, provenance and meta children join its label in --weave-fg. The
   provenance glyph shape carries the distinction the colour swap drops;
   elsewhere the hues are unaffected. The palette's hit rows need the same
   remap: same selected ground, same failure. The label is restated last
   because .weave-row-muted outranks the inheritance the row-on rule relies
   on. */
.weave-row-on .weave-twisty,.weave-row-on .weave-kind,.weave-row-on .weave-prov,
.weave-row-on .weave-meta,.weave-row-on .weave-label{color:var(--weave-fg)}
.weave-hit-on .weave-hit-badge,.weave-hit-on .weave-hit-detail{color:var(--weave-fg)}
/* A newly-arrived node (a file or note added since the last update, §6):
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
.weave-meta{flex:none;font-size:var(--weave-px-caption);color:var(--weave-faint)}
.weave-tree-empty{flex:1;margin:0;padding:14px var(--weave-gutter);color:var(--weave-dim)}
.weave-tree-count{
  margin:0;padding:3px var(--weave-gutter);font-size:var(--weave-px-caption);color:var(--weave-faint);
  border-top:1px solid var(--weave-line);
}

/* icons ------------------------------------------------------------------
   The sprite's only CSS: one colour (the glyph inherits the row's, so a
   muted row's icon recedes with it and a selected row's brightens with it)
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
   readable peripherally, before any glyph is. Head, body and editor share the
   --weave-note-gutter so toggling the editor does not reflow the measure. */
.weave-note{display:flex;flex-direction:column;min-height:0;flex:1;overflow:auto;background:var(--weave-page)}
.weave-note-human{--weave-spine:var(--weave-ok)}
.weave-note-agent{--weave-spine:var(--weave-accent)}
.weave-note-generated{--weave-spine:var(--weave-faint)}
.weave-note{border-left:2px solid var(--weave-spine,transparent)}
.weave-note-empty{flex:1;margin:0;padding:14px var(--weave-note-gutter);color:var(--weave-dim);max-width:44ch;line-height:1.5;background:var(--weave-page)}
/* The head pins itself (P6.3): a long note scrolls its prose under the title,
   and the title is what says you are still in the right document — the
   alternative, a title that scrolls away, is how a reader ends up annotating
   the wrong file. It carries the page ground rather than a fill or a shadow,
   so the reveal reads as the page continuing under it and not as a bar
   arriving; the hairline is the only seam. The editor bar is the *next*
   sibling in the column flow, so it can never slide underneath — no stacking
   contest exists between them. The head's z-index is only what keeps it above
   the prose (and the wikilinks inside it) as that prose scrolls beneath. */
.weave-note-head{position:sticky;top:0;z-index:2;padding:14px var(--weave-note-gutter) 9px;background:var(--weave-page);border-bottom:1px solid var(--weave-line)}
/* The page's largest voice, and the point of the review's headline finding:
   a 15px title sat 1.5px above the body it named. --weave-px-display puts the
   title where a page's title belongs, weight 650 for presence at 20px (600
   reads thin at that size, 700 reads as a poster), tracking pulled in by a
   hair because large sans needs it. */
.weave-note-title{margin:0 0 4px;font-size:var(--weave-px-display);font-weight:650;line-height:1.25;letter-spacing:-.005em;color:var(--weave-fg)}
/* One quiet line: provenance word, edited, created — a footnote, not a
   second headline. The gap is tightened and the row is capped at the ui step
   so the eye can read the whole of it without ever reading it. */
.weave-note-meta{margin:0;display:flex;align-items:center;gap:8px;font-size:var(--weave-px-ui);color:var(--weave-dim);flex-wrap:wrap}
.weave-note-time{color:var(--weave-faint)}
/* \`Open in $EDITOR\`, demoted (P6.3). It used to be the bar's full-width
   bordered button — the note's loudest control, sitting between its title and
   its prose. Now it is an icon at the end of the meta line: the hint rides
   the \`title\`/\`aria-label\` (\`editor.model.ts\`'s OPEN_HINT/OPEN_LABEL), and
   the control is quiet until the pointer asks for it. */
.weave-note-open{
  margin-left:auto;display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;padding:0;font:inherit;color:var(--weave-faint);
  background:none;border:0;border-radius:var(--weave-radius);cursor:pointer;
}
.weave-note-open:hover{color:var(--weave-fg);background:var(--weave-line)}
.weave-note-open-mark{display:inline-flex;line-height:0}
.weave-note-tags{margin:6px 0 0;display:flex;gap:5px;flex-wrap:wrap}
.weave-tag{
  font-size:var(--weave-px-caption);color:var(--weave-accent);background:var(--weave-panel);
  padding:1px 6px;border:1px solid var(--weave-line-strong);border-radius:999px;
}
/* Prose runs the column's full width — a 66ch measure was tried and
   withdrawn at the user's call: this is a workspace, and the note shares the
   width the desk gives it. It reads at --weave-px-body on 1.7 rather than the
   chrome's 1.6: the extra leading is what a page of running text needs that a
   status bar does not. Code and the raw editor stay mono deliberately —
   reading prose and reading raw are different postures, and the face switch
   is the toggle. */
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
/* A ghost is a name with no note behind it: Obsidian's dashed, dimmed
   affordance to create one. */
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

/* note editor (§11 P5) ---------------------------------------------------- */
/* A \`<textarea>\`, not CodeMirror: §0 V10 measured CM6 at 118 KB gzip, more
   than the entire rest of the client. It inherits the body's type so toggling
   \`⌘E\` does not reflow the column into a different shape. */
.weave-note-bar{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  padding:5px var(--weave-gutter);border-bottom:1px solid var(--weave-line);
}
/* \`weave-note-open\` is styled in the note column above (P6.3 moved it into
   the head's meta row as an icon), and no longer shares the bar's bordered
   button voice. */
.weave-note-toggle,.weave-note-save,.weave-note-action{
  font:inherit;font-size:var(--weave-px-ui);padding:2px 8px;cursor:pointer;
  color:var(--weave-fg);background:var(--weave-raise);
  border:1px solid var(--weave-line);border-radius:var(--weave-radius);
}
.weave-note-toggle:hover,.weave-note-save:hover,.weave-note-action:hover{
  border-color:var(--weave-accent);
}
.weave-note-toggle[aria-pressed="true"]{border-color:var(--weave-accent);color:var(--weave-accent)}
.weave-note-save:disabled{opacity:.45;cursor:default;border-color:var(--weave-line)}
.weave-note-dirty{color:var(--weave-accent);font-size:var(--weave-px-subhead);line-height:1}
.weave-note-status{font-size:var(--weave-px-ui);color:var(--weave-dim)}
.weave-note-status-ok{color:var(--weave-ok)}
.weave-note-status-warn{color:var(--weave-warn)}
/* The prompt takes the full row rather than sitting inline: reload-or-overwrite
   is a decision about the user's unsaved text, and a decision squeezed between
   two buttons reads as a hint. */
.weave-note-prompt{
  flex-basis:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  margin-top:4px;padding:5px 8px;border-radius:var(--weave-radius);
  background:var(--weave-raise);border:1px solid var(--weave-warn);
}
.weave-note-prompt-conflict,.weave-note-prompt-collision{border-color:var(--weave-warn)}
.weave-note-prompt-external,.weave-note-prompt-discard{border-color:var(--weave-line)}
.weave-note-prompt-text{margin:0;font-size:var(--weave-px-ui);color:var(--weave-fg)}
.weave-note-prompt-actions{margin:0;display:flex;gap:6px;flex-wrap:wrap}
.weave-note-editor{
  flex:1;min-height:240px;resize:none;
  padding:10px var(--weave-note-gutter) 24px;
  /* Exactly the prose body's size and leading. The invariant is documented
     and deliberate: ⌘E must not reflow, and reading raw at the same measure
     the prose uses is what makes the toggle a lens rather than a jump. */
  font:inherit;font-family:var(--weave-mono);font-size:var(--weave-px-body);line-height:1.7;
  color:var(--weave-fg);background:var(--weave-page);border:0;outline-offset:-2px;
}

/* graph column ---------------------------------------------------------- */
/* The canvas is a plain block sigma appends its own <canvas> layers into. It
   must have a definite size before sigma measures it, hence \`min-height\` and
   the \`1fr\` row from \`.weave-col-graph\` above — a zero-height container makes
   sigma refuse to render (we pass \`allowInvalidContainer\`, so it degrades to
   blank rather than throwing). */
.weave-graph{display:grid;grid-template-rows:1fr auto auto;min-height:0;overflow:hidden}
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
  background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.22) 100%);
}
:root[data-weave-theme="light"] .weave-graph-canvas::after{
  background:radial-gradient(ellipse at center,transparent 55%,rgba(76,79,105,.10) 100%);
}
@media (prefers-color-scheme: light){
  :root:not([data-weave-theme="dark"]) .weave-graph-canvas::after{
    background:radial-gradient(ellipse at center,transparent 55%,rgba(76,79,105,.10) 100%);
  }
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
.weave-ctx-head{margin:0}
.weave-ctx-heading{
  display:flex;align-items:center;gap:5px;width:100%;margin:0;padding:2px 0;
  font:inherit;font-size:var(--weave-px-caption);font-weight:600;letter-spacing:.09em;color:var(--weave-faint);
  text-align:left;background:none;border:0;cursor:pointer;
}
.weave-ctx-heading:hover{color:var(--weave-fg)}
/* The count is a mono voice, like every other number in the chrome: the
   header summary and the status bar count in mono, so a rail that says
   "BACKLINKS 4" in the text face would be the one thing off-key. */
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

/* status bar ------------------------------------------------------------ */
/* One separator vocabulary, shared with the header summary: every run of
   status items after the first opens with the same mid-dot, in the same
   --weave-faint. cwd · selection | stamp · connection reads as one grammar,
   the same way the header's three-part summary does. */
.weave-status{
  display:flex;align-items:center;gap:8px;height:22px;padding:0 var(--weave-gutter);
  font-family:var(--weave-mono);font-size:var(--weave-px-ui);color:var(--weave-dim);
  border-top:1px solid var(--weave-line);background:var(--weave-panel);
}
.weave-status-sel::before,.weave-conn::before{content:"·";margin-right:8px;color:var(--weave-faint)}
.weave-status-cwd,.weave-status-sel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.weave-status-cwd{max-width:38%;color:var(--weave-faint)}
.weave-status-sel{color:var(--weave-fg)}
.weave-status-stamp{margin-left:auto;color:var(--weave-faint)}

/* overlays: the ⌘K palette and the ? help sheet (P4) --------------------- */
/* The scrim is a click target that closes, and the reason both overlays sit
   at the top of the stacking context rather than inside a column: a dialog
   that a column's \`overflow:hidden\` can clip is a dialog that disappears at
   the wrong breakpoint. */
.weave-scrim{
  position:fixed;inset:0;z-index:10;display:flex;justify-content:center;
  align-items:flex-start;padding:9vh 16px 16px;background:rgba(0,0,0,.45);
}
/* The scrim above is tuned for the dark ground, where a neutral black veil
   reads as depth. On the linen ground the same veil reads as a power cut, so
   the light scheme gets its own — a plum-tinted veil at reduced strength,
   drawn from the foreground ramp rather than from grey. */
:root[data-weave-theme="light"] .weave-scrim{background:rgba(76,79,105,.30)}
@media (prefers-color-scheme: light){
  :root:not([data-weave-theme="dark"]) .weave-scrim{background:rgba(76,79,105,.30)}
}
.weave-palette,.weave-help{
  display:flex;flex-direction:column;width:100%;max-width:560px;max-height:72vh;
  overflow:hidden;background:var(--weave-panel);color:var(--weave-fg);
  border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius-pop);
}
.weave-palette-input{
  flex:none;height:34px;padding:0 11px;font:inherit;font-size:var(--weave-px-subhead);
  color:var(--weave-fg);background:transparent;border:0;
  border-bottom:1px solid var(--weave-line);border-radius:0;
}
.weave-palette-input:focus-visible{outline-offset:-2px}
.weave-hits{flex:1;min-height:0;overflow:auto;margin:0;padding:3px 0;list-style:none}
.weave-hit{
  display:flex;align-items:baseline;gap:7px;padding:3px 11px;cursor:pointer;
  min-width:0;white-space:nowrap;
}
.weave-hit-on{background:var(--weave-new);box-shadow:inset 2px 0 0 var(--weave-accent)}
.weave-hit-badge{
  flex:none;font-size:var(--weave-px-prov);letter-spacing:.06em;text-transform:uppercase;color:var(--weave-faint);
  min-width:56px;
}
.weave-hit-note .weave-hit-badge{color:var(--weave-accent)}
.weave-hit-label{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis}
.weave-hit-detail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:var(--weave-px-ui);color:var(--weave-dim)}
.weave-palette-status{margin:0;padding:14px 11px;color:var(--weave-dim);line-height:1.5}
.weave-palette-foot,.weave-help-foot{
  display:flex;gap:12px;margin:0;padding:4px 11px;font-size:var(--weave-px-caption);color:var(--weave-faint);
  border-top:1px solid var(--weave-line);
}
.weave-palette-hint,.weave-help-hint{margin-left:auto}
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
   help sheet, editor) gets the same thin chrome: the default scrollbar is a
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
.weave-row,.weave-ctx-link,.weave-chip,.weave-search,.weave-refresh,.weave-theme,
.weave-divider,.weave-hit,.weave-note-toggle,.weave-note-save,.weave-note-open,
.weave-note-action{
  transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease;
}
.weave-scrim{animation:weave-fade-in 140ms ease-out both}
.weave-palette,.weave-help{animation:weave-overlay-in 160ms ease-out both}
/* The conflict prompt mounts once per conflict, so its entrance cannot strobe
   the way a context-rail flash would — that rail deliberately stays still. */
.weave-note-prompt{animation:weave-prompt-in 180ms ease-out both}
@keyframes weave-fade-in{from{opacity:0}}
@keyframes weave-overlay-in{from{opacity:0;transform:translateY(4px)}}
@keyframes weave-prompt-in{from{opacity:0;transform:translateY(-2px)}}
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
export function installTheme(host: ThemeHost, css: string = THEME_CSS): boolean {
  const element = host.createElement("style");
  const nonce = findNonce(host);
  if (nonce !== null) element.nonce = nonce;
  element.textContent = css;
  host.head.appendChild(element);
  return nonce !== null;
}
