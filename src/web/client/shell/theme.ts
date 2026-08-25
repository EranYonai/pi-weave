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
 * ## "Dense but calm" (§1.2)
 *
 * The sketch is an information-dense IDE surface, not a marketing page, so
 * the rules below deliberately avoid the defaults that produce the opposite:
 * no card shadows, no 24 px gutters, no rounded panels floating on a
 * contrasting background. Density comes from a 13 px base, 4–10 px padding
 * and 1 px hairline rules; calm comes from a **single** accent colour used
 * only for focus and selection, three greys doing all the structural work,
 * and no borders where a background change already separates two regions.
 */
export const THEME_CSS = `
:root{
  --weave-bg:#141317;--weave-panel:#191820;--weave-fg:#e8e6ee;--weave-dim:#8f8a9c;
  --weave-faint:#5d5869;--weave-line:#26242e;--weave-line-strong:#343141;
  --weave-accent:#a48cff;--weave-ok:#4ade80;--weave-warn:#fbbf24;--weave-bad:#f87171;
  --weave-row:26px;--weave-gutter:10px;
}
@media (prefers-color-scheme: light){
  :root{
    --weave-bg:#faf9f7;--weave-panel:#ffffff;--weave-fg:#1c1b19;--weave-dim:#6f6b66;
    --weave-faint:#9a958e;--weave-line:#e6e3de;--weave-line-strong:#d2cec8;
    --weave-accent:#6d4aff;--weave-ok:#15803d;--weave-warn:#b45309;--weave-bad:#b91c1c;
  }
}
body{font-size:13px}
#app{height:100%;display:grid;grid-template-rows:auto 1fr auto;background:var(--weave-bg)}

/* header --------------------------------------------------------------- */
.weave-header{
  display:flex;align-items:center;gap:14px;padding:0 var(--weave-gutter);
  height:34px;border-bottom:1px solid var(--weave-line);background:var(--weave-panel);
}
.weave-brand{font-weight:600;letter-spacing:.01em;white-space:nowrap}
/* A button styled as a search field: the palette owns the only text input,
   so this opens it rather than pretending to accept a query. */
.weave-search{
  display:flex;align-items:center;gap:6px;flex:0 1 260px;min-width:0;
  height:22px;padding:0 7px;font:inherit;font-size:12px;text-align:left;cursor:pointer;
  color:var(--weave-dim);background:var(--weave-bg);
  border:1px solid var(--weave-line-strong);border-radius:4px;
}
.weave-search:hover{color:var(--weave-fg);border-color:var(--weave-accent)}
.weave-search-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.weave-search kbd{
  font-family:var(--weave-mono);font-size:10.5px;color:var(--weave-faint);
  padding:1px 5px;border:1px solid var(--weave-line-strong);border-radius:3px;white-space:nowrap;
}
.weave-summary{
  margin-left:auto;display:flex;gap:9px;font-family:var(--weave-mono);
  font-size:11.5px;color:var(--weave-dim);white-space:nowrap;
}
.weave-summary-part+.weave-summary-part::before{content:"·";margin-right:9px;color:var(--weave-faint)}
.weave-refresh{
  font:inherit;font-size:14px;line-height:1;color:var(--weave-dim);background:none;
  border:0;padding:3px 5px;border-radius:4px;cursor:pointer;
}
.weave-refresh:hover{color:var(--weave-fg);background:var(--weave-line)}

/* connection indicator -------------------------------------------------- */
.weave-conn{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--weave-dim);white-space:nowrap}
.weave-conn-dot{font-size:9px;line-height:1}
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
  margin:0;padding:5px var(--weave-gutter) 4px;font-size:10px;font-weight:600;
  letter-spacing:.09em;text-transform:uppercase;color:var(--weave-faint);
  border-bottom:1px solid var(--weave-line);
}
/* Title, then the graph (which takes the slack), then the context rail. The
   \`1fr\` is what gives \`.weave-graph-canvas\` a definite height to measure. */
.weave-col-graph{display:grid;grid-template-rows:auto 1fr auto;background:var(--weave-bg)}

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
  flex:1;min-width:0;height:21px;padding:0 6px;font:inherit;font-size:11.5px;
  color:var(--weave-fg);background:var(--weave-panel);
  border:1px solid var(--weave-line-strong);border-radius:4px;
}
.weave-chip{
  font:inherit;font-size:10.5px;line-height:1;white-space:nowrap;cursor:pointer;
  color:var(--weave-dim);background:var(--weave-panel);padding:4px 6px;
  border:1px solid var(--weave-line-strong);border-radius:4px;
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
.weave-twisty{width:10px;flex:none;color:var(--weave-faint);cursor:pointer;text-align:center}
.weave-kind{flex:none;color:var(--weave-faint);font-size:11px}
.weave-prov{flex:none;font-size:9px}
.weave-prov-human{color:var(--weave-ok)}
.weave-prov-agent{color:var(--weave-accent)}
.weave-prov-generated{color:var(--weave-faint)}
.weave-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.weave-meta{flex:none;font-size:10.5px;color:var(--weave-faint)}
.weave-tree-empty{flex:1;margin:0;padding:14px var(--weave-gutter);color:var(--weave-dim)}
.weave-tree-count{
  margin:0;padding:3px var(--weave-gutter);font-size:10.5px;color:var(--weave-faint);
  border-top:1px solid var(--weave-line);
}

/* note column ----------------------------------------------------------- */
.weave-note{display:flex;flex-direction:column;min-height:0;flex:1;overflow:auto}
.weave-note-empty{flex:1;margin:0;padding:14px var(--weave-gutter);color:var(--weave-dim);max-width:44ch;line-height:1.5}
.weave-note-head{padding:10px var(--weave-gutter) 8px;border-bottom:1px solid var(--weave-line)}
.weave-note-title{margin:0 0 4px;font-size:15px;font-weight:600;line-height:1.3;color:var(--weave-fg)}
.weave-note-meta{margin:0;display:flex;gap:10px;font-size:11px;color:var(--weave-dim);flex-wrap:wrap}
.weave-note-time{color:var(--weave-faint)}
.weave-note-tags{margin:5px 0 0;display:flex;gap:5px;flex-wrap:wrap}
.weave-tag{
  font-size:10.5px;color:var(--weave-accent);background:var(--weave-panel);
  padding:1px 6px;border:1px solid var(--weave-line-strong);border-radius:9px;
}
.weave-note-body{padding:10px var(--weave-gutter) 24px;line-height:1.6;max-width:78ch;color:var(--weave-fg)}
.weave-note-body>*:first-child{margin-top:0}
.weave-note-body h1,.weave-note-body h2,.weave-note-body h3,
.weave-note-body h4,.weave-note-body h5,.weave-note-body h6{
  margin:18px 0 6px;font-weight:600;line-height:1.3;
}
.weave-note-body h1{font-size:15px}
.weave-note-body h2{font-size:14px}
.weave-note-body h3,.weave-note-body h4,.weave-note-body h5,.weave-note-body h6{font-size:13px}
.weave-note-body p,.weave-note-body ul,.weave-note-body ol,.weave-note-body blockquote{margin:0 0 10px}
.weave-note-body ul,.weave-note-body ol{padding-left:20px}
.weave-note-body li{margin:2px 0}
.weave-note-body blockquote{
  padding-left:10px;border-left:2px solid var(--weave-line-strong);color:var(--weave-dim);
}
.weave-note-body code{
  font-family:var(--weave-mono);font-size:11.5px;padding:1px 4px;
  background:var(--weave-panel);border:1px solid var(--weave-line);border-radius:3px;
}
.weave-note-body pre{
  margin:0 0 10px;padding:8px 10px;overflow:auto;
  background:var(--weave-panel);border:1px solid var(--weave-line);border-radius:5px;
}
.weave-note-body pre code{padding:0;background:none;border:0}
.weave-note-body hr{margin:14px 0;border:0;border-top:1px solid var(--weave-line)}
.weave-note-body table{border-collapse:collapse;margin:0 0 10px;font-size:12px}
.weave-note-body th,.weave-note-body td{padding:3px 8px;border:1px solid var(--weave-line);text-align:left}
.weave-note-body th{color:var(--weave-dim);font-weight:600}
.weave-note-body img{max-width:100%;height:auto}
.weave-note-body a{color:var(--weave-accent);text-decoration:none}
.weave-note-body a:hover{text-decoration:underline}
/* Wikilinks carry no href — they drive the §1.3 bus, not the browser — so the
   pointer has to be restored by hand. A ghost is a name with no note behind
   it: Obsidian's dashed, dimmed affordance to create one. */
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
  font:inherit;font-size:11px;padding:2px 8px;cursor:pointer;
  color:var(--weave-fg);background:var(--weave-raise);
  border:1px solid var(--weave-line);border-radius:4px;
}
.weave-note-toggle:hover,.weave-note-save:hover,.weave-note-open:hover,.weave-note-action:hover{
  border-color:var(--weave-accent);
}
.weave-note-toggle[aria-pressed="true"]{border-color:var(--weave-accent);color:var(--weave-accent)}
.weave-note-save:disabled{opacity:.45;cursor:default;border-color:var(--weave-line)}
.weave-note-dirty{color:var(--weave-accent);font-size:14px;line-height:1}
.weave-note-status{font-size:11px;color:var(--weave-dim)}
.weave-note-status-ok{color:var(--weave-ok)}
.weave-note-status-warn{color:var(--weave-warn)}
/* The prompt takes the full row rather than sitting inline: reload-or-overwrite
   is a decision about the user's unsaved text, and a decision squeezed between
   two buttons reads as a hint. */
.weave-note-prompt{
  flex-basis:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  margin-top:4px;padding:5px 8px;border-radius:4px;
  background:var(--weave-raise);border:1px solid var(--weave-warn);
}
.weave-note-prompt-conflict,.weave-note-prompt-collision{border-color:var(--weave-warn)}
.weave-note-prompt-external,.weave-note-prompt-discard{border-color:var(--weave-line)}
.weave-note-prompt-text{margin:0;font-size:11px;color:var(--weave-fg)}
.weave-note-prompt-actions{margin:0;display:flex;gap:6px;flex-wrap:wrap}
.weave-note-editor{
  flex:1;min-height:240px;resize:none;
  padding:10px var(--weave-gutter) 24px;
  font:inherit;font-family:var(--weave-mono);font-size:12px;line-height:1.6;
  color:var(--weave-fg);background:var(--weave-bg);border:0;outline-offset:-2px;
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
.weave-depth{font:inherit;font-size:10.5px;padding:3px 4px}
.weave-graph-legend{
  margin-left:auto;display:flex;gap:9px;font-size:10.5px;color:var(--weave-faint);
  white-space:nowrap;
}
.weave-legend-on{color:var(--weave-accent)}
.weave-legend-near{color:var(--weave-fg)}
.weave-graph-count{
  margin:0;padding:3px var(--weave-gutter);font-size:10.5px;color:var(--weave-faint);
  border-top:1px solid var(--weave-line);
}

/* context rail ---------------------------------------------------------- */
/* The \`.weave-empty\` block that used to sit above went with \`EmptyState.tsx\`
   in P3: every column now has its own empty state (\`treeEmptyMessage\`,
   \`noteEmptyMessage\`, \`graphEmptyMessage\`, \`RAIL_EMPTY\`), each rendered as a
   plain paragraph, so the shared placeholder had no callers left. */
.weave-rail{
  display:flex;flex-direction:column;min-height:96px;max-height:46%;overflow:auto;
  border-top:1px solid var(--weave-line);background:var(--weave-panel);
}
.weave-ctx-empty{margin:0;padding:10px var(--weave-gutter);color:var(--weave-dim);line-height:1.5}
.weave-ctx-group{padding:5px var(--weave-gutter) 2px}
.weave-ctx-heading{
  margin:0 0 2px;font-size:9.5px;font-weight:600;letter-spacing:.09em;color:var(--weave-faint);
}
.weave-ctx-rows,.weave-ctx-tags{margin:0;padding:0;list-style:none}
.weave-ctx-row{display:flex}
.weave-ctx-link{
  display:flex;align-items:center;gap:5px;width:100%;min-width:0;
  font:inherit;font-size:12px;text-align:left;color:var(--weave-fg);
  background:none;border:0;padding:2px var(--weave-gutter) 2px 0;cursor:pointer;
  border-radius:3px;
}
.weave-ctx-link:hover{background:var(--weave-line)}
.weave-ctx-row.weave-row-on .weave-ctx-link{background:var(--weave-line-strong)}
.weave-ctx-tag{margin:0 0 3px}
.weave-ctx-tag .weave-ctx-rows{padding-left:12px}

/* status bar ------------------------------------------------------------ */
.weave-status{
  display:flex;align-items:center;gap:12px;height:22px;padding:0 var(--weave-gutter);
  font-family:var(--weave-mono);font-size:11px;color:var(--weave-dim);
  border-top:1px solid var(--weave-line);background:var(--weave-panel);
}
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
.weave-palette,.weave-help{
  display:flex;flex-direction:column;width:100%;max-width:560px;max-height:72vh;
  overflow:hidden;background:var(--weave-panel);color:var(--weave-fg);
  border:1px solid var(--weave-line-strong);border-radius:7px;
}
.weave-palette-input{
  flex:none;height:34px;padding:0 11px;font:inherit;font-size:14px;
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
  flex:none;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--weave-faint);
  min-width:56px;
}
.weave-hit-note .weave-hit-badge{color:var(--weave-accent)}
.weave-hit-label{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis}
.weave-hit-detail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--weave-dim)}
.weave-palette-status{margin:0;padding:14px 11px;color:var(--weave-dim);line-height:1.5}
.weave-palette-foot,.weave-help-foot{
  display:flex;gap:12px;margin:0;padding:4px 11px;font-size:10.5px;color:var(--weave-faint);
  border-top:1px solid var(--weave-line);
}
.weave-palette-hint,.weave-help-hint{margin-left:auto}
.weave-help-title{margin:0;padding:9px 11px;font-size:13px;font-weight:600;border-bottom:1px solid var(--weave-line)}
.weave-keys{flex:1;min-height:0;overflow:auto;margin:0;padding:5px 11px}
.weave-key-group{margin:0 0 3px;font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--weave-faint)}
.weave-key-row{display:flex;align-items:baseline;gap:9px;padding:1px 0}
.weave-key-combo{
  flex:none;min-width:74px;font-family:var(--weave-mono);font-size:11px;color:var(--weave-accent);
}
.weave-key-what{flex:1;min-width:0;font-size:12px}

/* focus ----------------------------------------------------------------- */
:focus-visible{outline:2px solid var(--weave-accent);outline-offset:1px}
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
