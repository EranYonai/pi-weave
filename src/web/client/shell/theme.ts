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
 * Both schemes are derived from two four-colour seeds, and every token is
 * either one of the four or a blend/darkening of them — so the two schemes
 * read as siblings of one product, not a light theme bolted onto a dark one:
 *
 * - **Dark, "indigo dusk"** — `#2A2F4F` ground, `#917FB3` violet kept for
 *   fills and the `--weave-new` tint, `#E5BEEC` and `#FDE2F3` as the text
 *   ramp. `--weave-accent` is the halfway blend of the violet and the lilac
 *   (`#B79FDD`, 5.6:1 on the ground) because the violet alone sits at 3.8:1 —
 *   fine under a pointer, too faint for an 11 px link or a focus ring.
 * - **Light, "linen & plum"** — `#F8EDE3` ground, `#DFD3C3`/`#D0B8A8` as the
 *   hairline pair, and the plum `#85586F` running the *whole* text ramp:
 *   foreground is plum darkened to `#43303A`, dim plum warmed to `#7C6257`,
 *   faint deepened to `#7F6455` (4.7:1 on the ground). The greys are of the
 *   palette rather than neutral, which is what keeps a warm ground from
 *   feeling tinted.
 *
 * The two faints are AA-floor fixes, not taste: the first drafts (`#8F83B5`
 * dark, `#A68D80` light) measured 3.8:1 and 2.7:1 on their grounds — a 9 px
 * kind label at 2.7:1 was decoration, not text. The replacements
 * (`#ACA3D4`, `#7F6455`) sit at 4.5–4.7:1 while staying clearly below their
 * `--weave-dim` siblings, which is what keeps a hint reading as a hint.
 *
 * Status colours follow each scheme's temperature (sage/amber/brick in
 * light; soft green/amber/rose on indigo) at ≥ 4.5:1 text contrast — measured,
 * not eyeballed (`eb93a1`/`2a2f4f` 5.70, `a93b45`/`f8ede3` 5.36), replacing
 * the framework defaults this sheet shipped with. The dark rose is lightened
 * from its first draft `#e37e8d` — which already passed at 4.72, but only
 * just — to `#eb93a1` for margin.
 *
 * The graph cannot read these variables (WebGL — `graph.model.ts`), so
 * `GRAPH_PALETTE` mirrors seven of the slots as literals; the test that makes
 * that copy safe asserts every mirrored hex appears in this string.
 */
/**
 * The light-block tokens, interpolated into both selectors that need them —
 * see the {@link THEME_CSS} branch rules.
 */
const LIGHT_TOKENS = `
    --weave-bg:#f8ede3;--weave-panel:#fdf9f3;--weave-raise:#f1e3d4;--weave-fg:#43303a;--weave-dim:#7c6257;
    --weave-faint:#7f6455;--weave-line:#dfd3c3;--weave-line-strong:#d0b8a8;
    --weave-accent:#85586f;--weave-ok:#3f704e;--weave-warn:#a05a1c;--weave-bad:#a93b45;
    --weave-new:rgba(133,88,111,.16);
    --weave-page:#fdf9f3;
  `;

export const THEME_CSS = `
:root{
  --weave-bg:#2a2f4f;--weave-panel:#343b61;--weave-raise:#3d4570;--weave-fg:#fde2f3;--weave-dim:#bb9ecf;
  --weave-faint:#aca3d4;--weave-line:#3b4266;--weave-line-strong:#4a527e;
  --weave-accent:#b79fdd;--weave-ok:#7fc49a;--weave-warn:#e8b04c;--weave-bad:#eb93a1;
  --weave-new:rgba(145,127,179,.22);
  --weave-row:26px;--weave-gutter:10px;
  /* The reading gutter is note-only: prose wants a wider margin than chrome.
     Rails, rows and bars keep --weave-gutter, so density is a property of the
     furniture and generosity a property of the page. */
  --weave-note-gutter:18px;
  /* The desk-and-page split. The workspace is a desk of instruments — tree,
     graph, rail, bars — on the --weave-bg ground; the note column is the one
     *page* lying on it, one step off the desk and one step off the canvas:
     dark keeps a deeper indigo sheet, light keeps the linen panel. Two voices
     in total: sans for instruments and prose alike, mono for data — a third
     face was tried (serif prose) and withdrawn at the user's call; two voices
     read calmer than three. The CSP allows nothing fetched, and both are
     system stacks. */
  --weave-page:#272c4a;
  /* Two radii, per the plan: hairline-sharp for controls (a 4 px corner is
     the difference between a control and a card), one softer corner for the
     two overlays that float above the grid. Tag pills are 999px — a capsule
     shape, not a scale step. The gate test below refuses any literal px
     radius so the scale cannot drift back. */
  --weave-radius:4px;--weave-radius-pop:7px;
  /* The type ramp, role-named because sizes drift and roles stick. Seven
     steps (9.5/10.5/11.5/12/13/14/15px); every font-size in this sheet is
     one of these vars — that is a gate, not a convention:
       prov     9.5   micro badges, kind glyphs, uppercase key groups
       caption  10.5  chips, meta, counts, legend, column overlines
       ui       11.5  status bar, note meta line, small controls
       row      12    list rows, text inputs, the mono editor, inline code
       base     13    body copy, h3-h6
       subhead  14    palette input, h2, header icon buttons
       title    15    note title, h1
     Two earlier sizes were merged into neighbours: 9px glyphs to prov, and
     the 10px column overlines to caption (caps plus .09em tracking already
     read larger than their point size suggests). */
  --weave-px-prov:9.5px;--weave-px-caption:10.5px;--weave-px-ui:11.5px;
  --weave-px-row:12px;--weave-px-base:13px;--weave-px-subhead:14px;--weave-px-title:15px;
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
}
.weave-refresh:hover{color:var(--weave-fg);background:var(--weave-line)}
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
.weave-conn-ok .weave-conn-dot,.weave-conn-ok{color:var(--weave-ok)}
.weave-conn-warn .weave-conn-dot,.weave-conn-warn{color:var(--weave-warn)}
.weave-conn-bad .weave-conn-dot,.weave-conn-bad{color:var(--weave-bad)}

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
.weave-row-on{background:var(--weave-line-strong);color:var(--weave-fg)}
/* The selection has one voice. On the stronger --weave-line-strong ground
   every quieter token fails contrast — measured 3.2:1 (dark faint) to 2.9:1
   (light faint), and even --weave-dim lands under 3 — so a selected row's
   kind, provenance and meta children join its label in --weave-fg. The
   provenance glyph shape carries the distinction the colour swap drops;
   elsewhere the hues are unaffected. The palette's hit rows need the same
   remap: same selected ground, same failure. */
.weave-row-on .weave-twisty,.weave-row-on .weave-kind,.weave-row-on .weave-prov,
.weave-row-on .weave-meta{color:var(--weave-fg)}
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
.weave-twisty{width:10px;flex:none;color:var(--weave-faint);cursor:pointer;text-align:center}
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

/* note column ----------------------------------------------------------- */
/* The page. The desk holds instruments; this column is what the user reads,
   so it lies on --weave-page — one step off the desk and the canvas grounds —
   in the serif reading voice. The 2px rule flush to its left edge is the
   spine: it takes the note's provenance colour (see the --weave-spine map),
   so the document's origin is readable peripherally, before any glyph is.
   Head, body and editor share the --weave-note-gutter so toggling the editor
   does not reflow the measure. */
.weave-note{display:flex;flex-direction:column;min-height:0;flex:1;overflow:auto;background:var(--weave-page)}
.weave-note-human{--weave-spine:var(--weave-ok)}
.weave-note-agent{--weave-spine:var(--weave-accent)}
.weave-note-generated{--weave-spine:var(--weave-faint)}
.weave-note{border-left:2px solid var(--weave-spine,transparent)}
.weave-note-empty{flex:1;margin:0;padding:14px var(--weave-note-gutter);color:var(--weave-dim);max-width:44ch;line-height:1.5;background:var(--weave-page)}
.weave-note-head{padding:12px var(--weave-note-gutter) 8px;border-bottom:1px solid var(--weave-line)}
.weave-note-title{margin:0 0 4px;font-size:var(--weave-px-title);font-weight:600;line-height:1.3;color:var(--weave-fg)}
.weave-note-meta{margin:0;display:flex;gap:10px;font-size:var(--weave-px-ui);color:var(--weave-dim);flex-wrap:wrap}
.weave-note-time{color:var(--weave-faint)}
.weave-note-tags{margin:5px 0 0;display:flex;gap:5px;flex-wrap:wrap}
.weave-tag{
  font-size:var(--weave-px-caption);color:var(--weave-accent);background:var(--weave-panel);
  padding:1px 6px;border:1px solid var(--weave-line-strong);border-radius:999px;
}
/* Prose runs the column's full width — a 66ch measure was tried and
   withdrawn at the user's call: this is a workspace, and the note shares the
   width the desk gives it. Code and the raw editor stay mono deliberately —
   reading prose and reading raw are different postures, and the face switch
   is the toggle. */
.weave-note-body{padding:12px var(--weave-note-gutter) 28px;line-height:1.6;color:var(--weave-fg)}
.weave-note-body>*:first-child{margin-top:0}
.weave-note-body h1,.weave-note-body h2,.weave-note-body h3,
.weave-note-body h4,.weave-note-body h5,.weave-note-body h6{
  margin:20px 0 7px;font-weight:600;line-height:1.35;letter-spacing:.005em;
}
.weave-note-body h1{font-size:var(--weave-px-title)}
.weave-note-body h2{font-size:var(--weave-px-subhead)}
.weave-note-body h3,.weave-note-body h4,.weave-note-body h5,.weave-note-body h6{font-size:var(--weave-px-base)}
.weave-note-body p,.weave-note-body ul,.weave-note-body ol,.weave-note-body blockquote{margin:0 0 10px}
.weave-note-body ul,.weave-note-body ol{padding-left:20px}
.weave-note-body li{margin:2px 0}
.weave-note-body blockquote{
  padding-left:10px;border-left:2px solid var(--weave-line-strong);color:var(--weave-dim);
}
.weave-note-body code{
  font-family:var(--weave-mono);font-size:var(--weave-px-row);padding:1px 4px;
  background:var(--weave-panel);border:1px solid var(--weave-line);border-radius:var(--weave-radius);
}
.weave-note-body pre{
  margin:0 0 10px;padding:8px 10px;overflow:auto;
  background:var(--weave-panel);border:1px solid var(--weave-line);border-radius:var(--weave-radius);
}
.weave-note-body pre code{padding:0;background:none;border:0}
.weave-note-body hr{margin:14px 0;border:0;border-top:1px solid var(--weave-line)}
.weave-note-body table{border-collapse:collapse;margin:0 0 10px;font-size:var(--weave-px-row)}
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

/* note editor (§11 P5) ---------------------------------------------------- */
/* A \`<textarea>\`, not CodeMirror: §0 V10 measured CM6 at 118 KB gzip, more
   than the entire rest of the client. It inherits the body's type so toggling
   \`⌘E\` does not reflow the column into a different shape. */
.weave-note-bar{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  padding:5px var(--weave-gutter);border-bottom:1px solid var(--weave-line);
}
.weave-note-toggle,.weave-note-save,.weave-note-open,.weave-note-action{
  font:inherit;font-size:var(--weave-px-ui);padding:2px 8px;cursor:pointer;
  color:var(--weave-fg);background:var(--weave-raise);
  border:1px solid var(--weave-line);border-radius:var(--weave-radius);
}
.weave-note-toggle:hover,.weave-note-save:hover,.weave-note-open:hover,.weave-note-action:hover{
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
  font:inherit;font-family:var(--weave-mono);font-size:var(--weave-px-row);line-height:1.6;
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
   dims its neighbourhood: unrelated nodes recede to --weave-faint, and the
   legend names that state instead of leaving it unexplained. */
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
.weave-ctx-group{padding:5px var(--weave-gutter) 2px}
.weave-ctx-heading{
  margin:0 0 2px;font-size:var(--weave-px-caption);font-weight:600;letter-spacing:.09em;color:var(--weave-faint);
}
.weave-ctx-rows,.weave-ctx-tags{margin:0;padding:0;list-style:none}
.weave-ctx-row{display:flex}
.weave-ctx-link{
  display:flex;align-items:center;gap:5px;width:100%;min-width:0;
  font:inherit;font-size:var(--weave-px-row);text-align:left;color:var(--weave-fg);
  background:none;border:0;padding:2px var(--weave-gutter) 2px 0;cursor:pointer;
  border-radius:var(--weave-radius);
}
.weave-ctx-link:hover{background:var(--weave-line)}
.weave-ctx-row.weave-row-on .weave-ctx-link{background:var(--weave-line-strong)}
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
:root[data-weave-theme="light"] .weave-scrim{background:rgba(67,48,58,.28)}
@media (prefers-color-scheme: light){
  :root:not([data-weave-theme="dark"]) .weave-scrim{background:rgba(67,48,58,.28)}
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
.weave-hit-on{background:var(--weave-line-strong)}
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
