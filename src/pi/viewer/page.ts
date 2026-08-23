/**
 * The weave-view page (v2): a single self-contained HTML string — inline
 * CSS+JS, zero external resources (docs/weave-view.md §5, docs/weave-view-v2.md).
 *
 * v2 pillars: provenance is the hero (ring style + glyph + filter, never
 * color alone); three surfaces over one model (Graph / List / Detail);
 * overview-first status strip; explicit focus mode (1-hop, visibility-only).
 * The List surface is an expandable index tree over the `contains`
 * hierarchy (repository → modules → files), so you can drill into the index
 * and navigate to any file.
 *
 * NOTE for contributors: the rendered page must contain NO backtick and NO
 * `${` — the page is a TS template literal, and a CI guard asserts the
 * rendered output stays clean. Regex backslashes are `\\`-escaped; backtick
 * matching uses the `\x60` hex escape so no literal backtick reaches output.
 */

export function renderPage(cwd?: string): string {
  // Inject the cwd so per-repo positions can be keyed by a stable cwd hash
  // (decision 4). Without it the placeholder stays (still valid JS when
  // parsed; the real server always passes cwd).
  return cwd ? PAGE.replace("__VIEWER_CWD_JSON__", JSON.stringify(cwd)) : PAGE;
}

const PAGE = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi-weave · knowledge view</title>
<style>
  :root[data-theme="dark"] {
    --bg:#0b1020; --surface:#131a2e; --raised:#1a2340; --line:#26324d;
    --line-strong:#33415f; --text:#e8ecf6; --muted:#93a0bd; --faint:#64748b;
    --accent:#a78bfa; --ok:#34d399; --warn:#f59e0b; --danger:#f87171;
  }
  :root[data-theme="light"] {
    --bg:#f8fafc; --surface:#ffffff; --raised:#f1f5f9; --line:#e2e8f0;
    --line-strong:#cbd5e1; --text:#0f172a; --muted:#64748b; --faint:#94a3b8;
    --accent:#7c3aed; --ok:#059669; --warn:#d97706; --danger:#dc2626;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); overflow: hidden; }
  button, select, input { font: inherit; color: inherit; }
  button { background: var(--raised); color: var(--text); border: 1px solid var(--line);
           border-radius: 7px; padding: 4px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button:focus-visible, select:focus-visible, input:focus-visible, .row:focus-visible,
  .link-row:focus-visible, g.node:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .muted { color: var(--muted); }

  /* ---------- header ---------- */
  header { position: fixed; inset: 0 0 auto 0; padding: 8px 14px; display: flex; gap: 10px;
           align-items: center; flex-wrap: wrap; background: var(--surface);
           border-bottom: 1px solid var(--line); z-index: 10; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  header h1 span { color: var(--accent); }
  .tabs { display: flex; gap: 2px; background: var(--raised); border: 1px solid var(--line);
          border-radius: 8px; padding: 2px; }
  .tabs button { border: none; background: none; padding: 3px 10px; font-size: 12px; font-weight: 600;
                 text-transform: uppercase; letter-spacing: .08em; color: var(--muted); border-radius: 6px; }
  .tabs button.active { background: var(--accent); color: #0b1020; }
  #search { background: var(--raised); border: 1px solid var(--line); color: var(--text);
            border-radius: 7px; padding: 5px 10px; width: 200px; }
  #search:focus { outline: none; border-color: var(--accent); }
  #layout { background: var(--raised); border: 1px solid var(--line); border-radius: 7px;
            padding: 4px 8px; font-size: 12px; }
  .zoomgrp button { width: 30px; }
  #status { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 12px;
            font-feature-settings: "tnum"; color: var(--muted); }
  #status .stat { white-space: nowrap; }
  #status .stat.stale { color: var(--warn); font-weight: 600; }
  #stamp { color: var(--faint); font-size: 11px; white-space: nowrap; }
  .provbar { display: inline-flex; width: 64px; height: 8px; border-radius: 4px; overflow: hidden;
             background: var(--line); vertical-align: middle; }
  .provbar i { display: block; height: 100%; }
  .provbar .p-human { background: var(--ok); }
  .provbar .p-agent { background: var(--accent); }
  .provbar .p-generated { background: var(--faint); }
  .provbar.big { width: 100%; height: 12px; }

  /* ---------- graph ---------- */
  #graph { display: block; width: 100vw; height: 100vh; touch-action: none;
           background: radial-gradient(1200px 800px at 50% 40%, var(--surface) 0%, var(--bg) 70%); }
  text.label { fill: var(--text); font-size: 12px; pointer-events: none;
               paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; }
  text.glyph { font-size: 7px; fill: var(--bg); pointer-events: none; text-anchor: middle; }
  text.badge { font-size: 9px; fill: var(--muted); pointer-events: none; text-anchor: end; font-weight: 700; }
  g.node { cursor: pointer; }
  g.node .shape { transition: transform 120ms ease; }
  g.node.hovered .shape { transform: scale(1.06); }
  g.node.hovered .halo { opacity: .15; }
  g.node .halo { transition: opacity 120ms ease; }
  .dim { opacity: .14; }

  /* ---------- surfaces ---------- */
  .surface { position: fixed; top: 48px; bottom: 0; overflow-y: auto; background: var(--bg); }
  #list { left: 0; width: 340px; border-right: 1px solid var(--line); display: none; padding: 12px; }
  body.list-open #list { display: block; }
  #list-toggle[aria-pressed="true"] { background: var(--accent); color: #0b1020; }
  #health { left: 0; right: 0; display: none; padding: 20px 24px; max-width: 760px; }
  #health h2 { font-size: 18px; line-height: 1.3; font-weight: 650; margin: 0 0 4px; }
  #health h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
               margin: 20px 0 8px; }
  .list-toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .list-toolbar select { background: var(--raised); border: 1px solid var(--line); border-radius: 6px;
                         padding: 3px 6px; font-size: 12px; }
  #list-rows { display: flex; flex-direction: column; gap: 2px; }
  .row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 7px;
         cursor: pointer; border: 1px solid transparent; }
  .row:hover { background: var(--raised); }
  .row.selected { background: var(--raised); border-color: var(--accent); }
  .row-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-meta { color: var(--faint); font-size: 11px; white-space: nowrap; }
  .chev { display: inline-block; width: 14px; flex: none; text-align: center; color: var(--muted);
          font-size: 10px; user-select: none; }
  .chev.empty { visibility: hidden; }
  .row-kind { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
              border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  #show-more { width: 100%; margin-top: 8px; }

  /* ---------- detail panel ---------- */
  #panel { position: fixed; top: 48px; right: 0; bottom: 0; width: 420px; overflow-y: auto;
           background: var(--surface); border-left: 1px solid var(--line); padding: 18px 20px 40px;
           transform: translateX(100%); transition: transform 250ms cubic-bezier(.2,.7,.2,1); z-index: 9; }
  #panel.open { transform: translateX(0); }
  #pclose { position: absolute; top: 12px; right: 12px; width: 26px; height: 26px;
            border-radius: 50%; padding: 0; color: var(--muted); }
  #panel h2 { font-size: 18px; margin: 0 30px 4px 0; line-height: 1.3; font-weight: 650; }
  #pkicker { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
             margin-bottom: 8px; }
  .pactions { display: flex; gap: 6px; margin: 8px 0 12px; }
  .ptabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 12px; }
  .ptabs button { border: none; background: none; padding: 5px 10px; font-size: 12px; font-weight: 600;
                  color: var(--muted); border-bottom: 2px solid transparent; border-radius: 0; }
  .ptabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  #pcontent { font-size: 14px; line-height: 1.6; }
  #pcontent h1, #pcontent h2, #pcontent h3, #pcontent h4 { margin: .9em 0 .35em; line-height: 1.3; }
  #pcontent p { margin: .5em 0; }
  #pcontent ul { margin: .4em 0; padding-left: 22px; }
  #pcontent li { margin: .15em 0; }
  #pcontent code { background: var(--raised); border: 1px solid var(--line); border-radius: 4px;
                   padding: 1px 4px; font-size: 12px; }
  #pcontent pre { background: var(--raised); border: 1px solid var(--line); border-radius: 8px;
                  padding: 10px 12px; overflow-x: auto; }
  #pcontent pre code { background: none; border: none; padding: 0; }
  #pcontent blockquote { border-left: 3px solid var(--line); margin: .6em 0; padding-left: 12px;
                         color: var(--muted); }
  #pcontent a { color: var(--accent); }
  .wikilink { color: var(--accent); border-bottom: 1px dashed var(--accent); cursor: pointer; }
  .chip { display: inline-block; background: var(--raised); color: var(--accent); border-radius: 999px;
          padding: 1px 9px; font-size: 11px; margin: 0 5px 5px 0; }
  #pmeta { border-top: 1px solid var(--line); margin: 4px 0 14px; padding-top: 10px; font-size: 12px; }
  #pmeta .k { color: var(--muted); display: inline-block; min-width: 88px; }
  #pbody { border-top: 1px solid var(--line); padding-top: 12px; }
  .link-row { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px;
              cursor: pointer; }
  .link-row:hover { background: var(--raised); }
  .prov { font-size: 11px; border-radius: 999px; padding: 1px 8px; margin-left: 7px; }
  .prov.human { background: var(--ok); color: #0b1020; }
  .prov.agent { background: var(--accent); color: #0b1020; }
  .prov.generated { background: var(--faint); color: #0b1020; }
  .cluster-meta { border-bottom: 1px solid var(--line); margin-bottom: 10px; padding-bottom: 10px; font-size: 12px; }
  .cluster-meta .k { color: var(--muted); display: inline-block; min-width: 88px; }
  #pexpand { margin-bottom: 12px; }

  /* ---------- legend ---------- */
  #legend { position: fixed; left: 10px; bottom: 10px; background: var(--surface);
            border: 1px solid var(--line); border-radius: 9px; padding: 7px 10px; z-index: 8;
            font-size: 11px; color: var(--muted); }
  #legend .legend-head { display: flex; align-items: center; gap: 6px; cursor: pointer; background: none;
            border: none; color: var(--muted); font: inherit; font-size: 11px; padding: 0; width: 100%; text-align: left; }
  #legend .legend-head .caret { transition: transform 140ms; }
  #legend.collapsed .legend-head .caret { transform: rotate(-90deg); }
  #legend .legend-body { margin-top: 6px; }
  #legend.collapsed .legend-body { display: none; }
  #legend .row { display: flex; align-items: center; gap: 7px; margin: 2px 0; white-space: nowrap; }
  #legend .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  #legend .ring { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  #legend .ring.human { border: 2px solid var(--ok); }
  #legend .ring.agent { border: 2px dashed var(--accent); }
  #legend .ring.generated { border: 2px dotted var(--faint); }

  /* ---------- controls panel (v3 5.2) ---------- */
  #controls-open { position: fixed; left: 12px; top: 58px; z-index: 11; width: 32px; height: 32px;
            border-radius: 50%; font-size: 16px; line-height: 1; }
  #controls { position: fixed; left: 0; top: 48px; bottom: 0; width: 250px; z-index: 11;
            background: var(--surface); border-right: 1px solid var(--line); overflow-y: auto;
            transform: translateX(-100%); transition: transform 200ms cubic-bezier(.2,.7,.2,1);
            padding: 12px 12px 24px; }
  body.controls-open #controls { transform: translateX(0); }
  body.controls-open #controls-open { display: none; }
  #controls-grip { position: absolute; top: 0; right: -3px; width: 6px; height: 100%; cursor: col-resize; }
  #controls-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  #controls-head strong { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  #controls-close { width: 24px; height: 24px; border-radius: 50%; padding: 0; }
  .cgroup { border-top: 1px solid var(--line); padding: 10px 0; }
  .ct-label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 6px; }
  #controls label { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 4px 0; color: var(--muted); }
  #controls input[type="range"], #controls select { flex: 1; min-width: 0; }
  #controls input[type=text], #controls input:not([type]) { flex: 1; min-width: 0; background: var(--raised); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; color: var(--text); }
  .seg { display: flex; gap: 2px; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }
  .seg button { border: none; background: none; padding: 3px 6px; font-size: 11px; font-weight: 600; color: var(--muted); border-radius: 6px; flex: 1; }
  .seg button.active { background: var(--accent); color: #0b1020; }
  #force-sliders { margin-top: 8px; }
  #force-sliders.hidden { display: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
  .chips .chip { background: var(--raised); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; font-size: 11px; cursor: pointer; color: var(--muted); }
  .chips .chip.active { background: var(--accent); border-color: var(--accent); color: #0b1020; }
  .ctoggle input { accent-color: var(--accent); }
  .cbtns { display: flex; gap: 6px; }
  .cbtns button { flex: 1; }
  #search-drop { margin-top: 6px; max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  #search-drop .row { font-size: 12px; }
  .hidden { display: none !important; }

  /* ---------- overlays ---------- */
  #overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
             background: var(--bg); z-index: 20; }
  #overlay.hidden { display: none; }
  #overlay .card { text-align: center; color: var(--muted); }
  #overlay .spinner { width: 26px; height: 26px; border: 3px solid var(--line);
                      border-top-color: var(--accent); border-radius: 50%; margin: 0 auto 12px;
                      animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #help { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,.5); z-index: 30; }
  #help.hidden { display: none; }
  #help .card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
                padding: 20px 24px; min-width: 320px; }
  #help h2 { margin: 0 0 12px; font-size: 16px; }
  #help table { border-collapse: collapse; width: 100%; }
  #help td { padding: 4px 8px; font-size: 12px; }
  #help td:first-child { color: var(--accent); font-weight: 600; white-space: nowrap; }
  #help .close { margin-top: 12px; width: 100%; }
  #toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
           background: var(--raised); border: 1px solid var(--line); color: var(--text);
           padding: 8px 14px; border-radius: 8px; z-index: 40; opacity: 0; transition: opacity 200ms; }
  #toast.show { opacity: 1; }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body class="list-open">
<header>
  <h1>pi-weave <span>knowledge view</span></h1>
  <nav class="tabs" aria-label="surface">
    <button data-surface="graph" class="tab active">Explore</button>
    <button data-surface="health" class="tab">Health</button>
    <button id="list-toggle" title="Toggle list sidebar" aria-pressed="true">▤</button>
  </nav>
  <input id="search" placeholder="search…" aria-label="search">
  <select id="layout" aria-label="layout" title="Layout">
    <option value="cluster" selected>cluster</option>
    <option value="tree">tree</option>
    <option value="radial">radial</option>
    <option value="force">physics</option>
  </select>
  <button id="layout-reset" title="Reset layout">⟲</button>
  <span class="zoomgrp">
    <button id="zoom-in" title="Zoom in">+</button><button id="zoom-out" title="Zoom out">−</button><button id="zoom-reset" title="Reset view">⌂</button>
  </span>
  <button id="theme" title="Toggle theme">◐</button>
  <button id="help-btn" title="Shortcuts (?)">?</button>
  <span id="status"></span>
  <span id="stamp"></span>
</header>
<div id="overlay"><div class="card"><div class="spinner"></div>loading knowledge graph…</div></div>
<svg id="graph"></svg>
<aside id="list" class="surface">
  <div class="list-toolbar">
    <select id="sort" aria-label="sort">
      <option value="name">name</option>
      <option value="updated">updated</option>
      <option value="links">links</option>
      <option value="provenance">provenance</option>
    </select>
    <select id="kind-filter" aria-label="kind"><option value="">all kinds</option></select>
    <select id="prov-filter" aria-label="provenance">
      <option value="">all provenance</option>
      <option value="human">human</option>
      <option value="agent">agent</option>
      <option value="generated">generated</option>
    </select>
    <select id="recent-filter" aria-label="recency">
      <option value="">any time</option>
      <option value="7">last 7 days</option>
      <option value="30">last 30 days</option>
      <option value="90">last 90 days</option>
    </select>
    <label class="internals"><input id="internals" type="checkbox" aria-label="show internals"> show internals</label>
  </div>
  <div id="list-rows"></div>
  <button id="show-more" style="display:none">Show more</button>
</aside>
<aside id="panel">
  <button id="pclose" title="Close (Esc)">✕</button>
  <h2 id="ptitle"></h2>
  <div id="pkicker"></div>
  <div class="pactions">
    <button id="pfocus">Focus</button>
    <button id="popen">Open in editor</button>
  </div>
  <nav class="ptabs">
    <button data-ptab="overview" class="active">Overview</button>
    <button data-ptab="links">Links</button>
    <button data-ptab="backlinks">Backlinks</button>
  </nav>
  <div id="pcontent"></div>
</aside>
<section id="health" class="surface">
  <h2>Health</h2>
  <div id="health-content"></div>
</section>
<aside id="controls" class="controls-closed">
  <div id="controls-grip"></div>
  <div id="controls-head"><strong>View</strong><button id="controls-close" title="Close (c)">✕</button></div>
  <div class="cgroup">
    <div class="ct-label">Layout</div>
    <div class="seg" id="ctl-layout">
      <button data-layout="cluster" class="active">Cluster</button>
      <button data-layout="tree">Tree</button>
      <button data-layout="radial">Radial</button>
      <button data-layout="force">Force</button>
    </div>
    <div id="force-sliders" class="hidden">
      <label>Repel <input type="range" id="f-repel" min="0" max="200" value="100"></label>
      <label>Link <input type="range" id="f-link" min="40" max="260" value="150"></label>
      <label>Center <input type="range" id="f-center" min="0" max="100" value="30"></label>
      <label>Collide <input type="range" id="f-collide" min="0" max="100" value="70"></label>
    </div>
  </div>
  <div class="cgroup">
    <div class="ct-label">Filter</div>
    <div class="chips" id="kind-chips"></div>
    <div class="chips" id="prov-chips"></div>
    <label class="ctoggle"><input type="checkbox" id="ctl-orphans"> orphans</label>
    <label class="ctoggle"><input type="checkbox" id="ctl-internals"> internals</label>
    <label class="ctoggle"><input type="checkbox" id="ctl-dim"> dim filtered</label>
    <label class="cselect">Recent
      <select id="ctl-recent"><option value="0">any</option><option value="7">7d</option><option value="30">30d</option><option value="90">90d</option></select>
    </label>
  </div>
  <div class="cgroup">
    <div class="ct-label">Aggregation</div>
    <div class="cbtns">
      <button id="ctl-expand-all">Expand all</button>
      <button id="ctl-collapse-all">Collapse all</button>
    </div>
    <label class="ctoggle"><input type="checkbox" id="ctl-hover"> auto-expand on hover</label>
    <label>Depth <input type="range" id="ctl-depth" min="0" max="10" value="0"></label>
  </div>
  <div class="cgroup">
    <div class="ct-label">Search</div>
    <input id="ctl-search" placeholder="search…">
    <div id="search-drop"></div>
  </div>
</aside>
<button id="controls-open" title="View controls (c)">⚙</button>
<div id="legend" class="collapsed"></div>
<div id="help" class="hidden">
  <div class="card">
    <h2>Shortcuts</h2>
    <table>
      <tr><td>1 2 3 4</td><td>Cluster / Tree / Radial / Force layout</td></tr>
      <tr><td>c</td><td>Toggle controls panel</td></tr>
      <tr><td>/</td><td>Focus search</td></tr>
      <tr><td>p</td><td>Cycle provenance filter</td></tr>
      <tr><td>i</td><td>Toggle internals</td></tr>
      <tr><td>o</td><td>Toggle orphans</td></tr>
      <tr><td>e / E</td><td>Expand selected / expand all</td></tr>
      <tr><td>Space</td><td>Toggle selected cluster</td></tr>
      <tr><td>f</td><td>Focus selected node</td></tr>
      <tr><td>g</td><td>Exit focus</td></tr>
      <tr><td>▸ / ▾</td><td>Expand / collapse in List</td></tr>
      <tr><td>?</td><td>This help</td></tr>
      <tr><td>+ / −</td><td>Zoom in / out</td></tr>
      <tr><td>Esc</td><td>Close / clear / exit</td></tr>
      <tr><td>Enter</td><td>Activate node / row</td></tr>
    </table>
    <button class="close" id="help-close">Close</button>
  </div>
</div>
<div id="toast"></div>
<script>
(function () {
  "use strict";

  // ===== pure =====
  function focusNeighborhood(id, edges) {
    var out = {}; out[id] = 1;
    edges.forEach(function (e) {
      if (e.source === id) out[e.target] = 1;
      if (e.target === id) out[e.source] = 1;
    });
    return out;
  }
  function deriveBacklinks(edges) {
    var out = {};
    edges.forEach(function (e) {
      if (e.kind !== "links-to") return;
      (out[e.target] = out[e.target] || []).push(e.source);
    });
    return out;
  }
  function applyFilter(items, kind, prov) {
    return items.filter(function (n) {
      if (kind && n.kind !== kind) return false;
      if (prov && n.provenance !== prov) return false;
      return true;
    });
  }
  function sortRows(rows, key) {
    var arr = rows.slice();
    arr.sort(function (a, b) {
      if (key === "name") return a.label.localeCompare(b.label);
      if (key === "updated") return (b.updated || "").localeCompare(a.updated || "");
      if (key === "links") return b.links - a.links;
      if (key === "provenance") return (a.provenance || "").localeCompare(b.provenance || "");
      return 0;
    });
    return arr;
  }
  function counts(nodes) {
    var out = { total: nodes.length, human: 0, agent: 0, generated: 0, structural: 0 };
    nodes.forEach(function (n) {
      if (n.provenance === "human") out.human++;
      else if (n.provenance === "agent") out.agent++;
      else if (n.provenance === "generated") out.generated++;
      else out.structural++;
    });
    return out;
  }
  function relTime(iso, now) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var s = Math.max(0, Math.floor((now - t) / 1000));
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d < 30) return d + "d ago";
    var mo = Math.floor(d / 30);
    if (mo < 12) return mo + "mo ago";
    return Math.floor(mo / 12) + "y ago";
  }
  function linksOf(id, edges) {
    var d = 0;
    edges.forEach(function (e) { if (e.source === id || e.target === id) d++; });
    return d;
  }
  // Build the List surface as an expandable index tree over the contains
  // hierarchy. Entry points (files) are nested under the module whose path is
  // their directory prefix, so the repository reads as a real file tree.
  // Returns rows [{id, depth, hasKids, expanded}] in display order.
  function listTree(model, state) {
    var byId = {};
    model.nodes.forEach(function (n) { byId[n.id] = n; });
    var contains = {}; // strict contains (used for file/module placement)
    var tree = {};     // contains + anchored-at (nesting hierarchy)
    var incoming = {};
    model.edges.forEach(function (e) {
      if (e.kind === "contains") {
        (contains[e.source] = contains[e.source] || []).push(e.target);
      }
      // Nest under a parent via contains OR anchored-at (the git anchor
      // belongs under its repository); only nodes with no parent become roots.
      if (e.kind === "contains" || e.kind === "anchored-at") {
        (tree[e.source] = tree[e.source] || []).push(e.target);
        incoming[e.target] = 1;
      }
    });
    function moduleFor(entryId) {
      var entry = byId[entryId];
      if (!entry || entry.kind !== "entryPoint" || !entry.detail.path) return null;
      var p = entry.detail.path, best = null, bestLen = 0;
      (contains["repository"] || []).forEach(function (cid) {
        var c = byId[cid];
        if (c && c.kind === "module" && c.detail.path) {
          var mp = c.detail.path;
          if (p.indexOf(mp + "/") === 0 && mp.length > bestLen) { best = cid; bestLen = mp.length; }
        }
      });
      return best;
    }
    var moduleEntries = {};
    model.nodes.forEach(function (n) {
      if (n.kind !== "entryPoint") return;
      var m = moduleFor(n.id);
      if (m) (moduleEntries[m] = moduleEntries[m] || []).push(n.id);
    });
    function children(id) {
      var kids = (tree[id] || []).filter(function (kid) {
        return !(byId[kid] && byId[kid].kind === "entryPoint" && moduleFor(kid));
      });
      kids = kids.concat(moduleEntries[id] || []);
      // Knowledge-first default: hide repo plumbing (git anchor, remotes,
      // packages, entry points) unless the user explicitly reveals internals.
      if (!state.showInternals) {
        kids = kids.filter(function (k) {
          var kind = byId[k] && byId[k].kind;
          return kind !== "gitState" && kind !== "external" && kind !== "package" && kind !== "entryPoint";
        });
      }
      return kids;
    }
    var roots = model.nodes.filter(function (n) { return !incoming[n.id]; }).map(function (n) { return n.id; });
    var filtering = state.kindFilter || state.provFilter || state.recentDays || state.query;
    var rows = [];
    function sortKids(kids) {
      var arr = kids.map(function (k) {
        var n = byId[k];
        return { id: k, label: n.label, kind: n.kind, provenance: n.provenance || "",
          updated: n.detail.updated || "", links: linksOf(k, model.edges) };
      });
      return sortRows(arr, state.listSort).map(function (r) { return r.id; });
    }
    function matches(node) {
      if (state.recentDays) {
        var u = node.detail.updated;
        if (!u || new Date(u).getTime() < Date.now() - state.recentDays * 86400000) return false;
      }
      if (state.query && node.label.toLowerCase().indexOf(state.query) < 0) return false;
      return applyFilter([node], state.kindFilter || null, state.provFilter || null).length > 0;
    }
    // Pass 1: mark which nodes are visible (self-match or a visible descendant).
    var visibleSet = {};
    function mark(id) {
      var node = byId[id];
      if (!node) return false;
      var kids = sortKids(children(id));
      var any = false;
      kids.forEach(function (k) { if (mark(k)) any = true; });
      var show = matches(node) || any;
      if (show) visibleSet[id] = 1;
      return show;
    }
    roots.forEach(function (r) { mark(r); });
    // Pass 2: pre-order walk so parents precede their children.
    function walk(id, depth) {
      if (!visibleSet[id]) return;
      var node = byId[id];
      var kids = sortKids(children(id));
      var visibleKids = kids.filter(function (k) { return visibleSet[k]; });
      var expanded = filtering ? visibleKids.length > 0 : !!state.listExpanded[id];
      rows.push({ id: id, depth: depth, hasKids: kids.length > 0, expanded: expanded });
      if (expanded) visibleKids.forEach(function (k) { walk(k, depth + 1); });
    }
    roots.forEach(function (r) { walk(r, 0); });
    return rows;
  }
  // Disambiguate labels that would otherwise read as the same entry twice
  // (a remote URL whose tail matches the repo name, an npm package named
  // after the repo). The raw node label still drives sorting and search.
  function listLabel(n) {
    if (n.kind === "external" && n.detail.url) {
      var u = n.detail.url.replace(/^[a-z]+:\\/\\//, "").replace(/^[^@\\/]+@/, "").replace(/\\.git$/, "").replace(/\\/+$/, "");
      if (u) return u;
    }
    if (n.kind === "package" && n.detail.manifest) {
      return n.label + " (" + n.detail.manifest + ")";
    }
    return n.label;
  }
  // Split YAML front matter (--- … ---) from a markdown body, returning the
  // stripped body plus the fields (and tags, when present). Pure/derivable.
  function parseFrontMatter(text) {
    if (typeof text !== "string" || text.slice(0, 3) !== "---") return { body: text || "", meta: [], tags: [] };
    var m = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/.exec(text);
    if (!m) return { body: text, meta: [], tags: [] };
    var meta = [], tags = [];
    m[1].split(/\\r?\\n/).forEach(function (line) {
      var i = line.indexOf(":");
      if (i <= 0) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k === "tags") { tags = v.split(",").map(function (t) { return t.trim(); }).filter(Boolean); return; }
      meta.push([k, v]);
    });
    return { body: text.slice(m[0].length), meta: meta, tags: tags };
  }
  // ---- graph layout (section 16): position persistence, degree-scaled forces ----
  // Global anti-oscillation tolerance (ForceAtlas2 swinging/traction): the
  // larger it is, the harder oscillating nodes are damped.
  var SWING_K = 0.25;
  // Reuse survivor positions across rebuilds; seed only NEW ids on a
  // deterministic phyllotaxis spiral (no Math.random). Returns id -> {x,y,vx,vy}.
  function seedPositions(existing, ids, W, H) {
    var out = {}, cx = W / 2, cy = H / 2, newIds = [], i, id;
    for (i = 0; i < ids.length; i++) {
      id = ids[i];
      if (existing && existing[id]) {
        out[id] = { x: existing[id].x, y: existing[id].y, vx: 0, vy: 0 };
      } else newIds.push(id);
    }
    for (i = 0; i < newIds.length; i++) {
      var angle = i * 2.399963, r = 24 + i * 4; // golden-angle spiral
      out[newIds[i]] = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, vx: 0, vy: 0 };
    }
    return out;
  }
  // Degree-sized collision radius (matches the v2 node sizing).
  function collideRadius(degree) {
    return 7 + Math.min(6, Math.sqrt(degree) * 1.2);
  }
  // Repulsion-by-degree (ForceAtlas2): leaves (low degree) repel weakly so they
  // pack near hubs instead of scattering to the periphery. Normalized by /4 so a
  // pair of degree-1 leaves keeps the original neutral strength (~1).
  function degreeRepulsion(deg1, deg2) {
    return (deg1 + 1) * (deg2 + 1) / 4;
  }
  // ForceAtlas2 swinging/traction local speed: scale a node's displacement by
  // 1/(1+k*sqrt(swing)) where swing is the change in its force between ticks.
  // Oscillators (large swing) take smaller steps than steady movers.
  function localSpeed(prevForce, force) {
    var pfx = prevForce ? prevForce.x : 0;
    var pfy = prevForce ? prevForce.y : 0;
    var dx = force.x - pfx, dy = force.y - pfy;
    var swing = Math.sqrt(dx * dx + dy * dy);
    return 1 / (1 + SWING_K * Math.sqrt(swing));
  }
  // Delta-aware reheat policy: identical structure -> no reheat (0); small delta
  // (<=3 nodes added/removed) -> gentle 0.05; larger change / explicit rebuild -> 0.5.
  function deltaAlpha(prev, next) {
    var a, b;
    try { a = JSON.parse(prev); b = JSON.parse(next); } catch (e) { return 0.5; }
    if (!a || !b || !a.nodes || !b.nodes) return 0.5;
    var idsA = {}, idsB = {}, k, added = 0, removed = 0;
    a.nodes.forEach(function (n) { idsA[n.id] = 1; });
    b.nodes.forEach(function (n) { idsB[n.id] = 1; });
    for (k in idsB) if (!idsA[k]) added++;
    for (k in idsA) if (!idsB[k]) removed++;
    if (added === 0 && removed === 0) return 0; // identical structure (no-op)
    return (added + removed <= 3) ? 0.05 : 0.5;
  }
  // Deterministic concentric-by-degree layout: hubs in the center, leaves outward.
  function radialLayout(nodes, degreeOf) {
    var deg = {}, groups = {};
    nodes.forEach(function (n) { deg[n.id] = degreeOf(n); });
    nodes.forEach(function (n) { (groups[deg[n.id]] = groups[deg[n.id]] || []).push(n.id); });
    var degs = Object.keys(groups).map(Number).sort(function (a, b) { return b - a; });
    var out = {}, ring = 0;
    for (var g = 0; g < degs.length; g++) {
      var ids = groups[degs[g]];
      var radius = 30 + ring * 60;
      for (var i = 0; i < ids.length; i++) {
        var angle = (2 * Math.PI * i) / ids.length + ring * 0.618;
        out[ids[i]] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      }
      ring++;
    }
    return out;
  }
  // Deterministic layered tree over the containment DAG (contains + anchored-at).
  // Cross-links are not drawn by this helper; it only places nodes on depth rows.
  function treeLayout(nodes, edges) {
    var children = {}, incoming = {};
    edges.forEach(function (e) {
      if (e.kind !== "contains" && e.kind !== "anchored-at") return;
      (children[e.source] = children[e.source] || []).push(e.target);
      incoming[e.target] = 1;
    });
    var roots = nodes.filter(function (n) { return !incoming[n.id]; }).map(function (n) { return n.id; });
    var out = {}, x = 0;
    function place(id, depth) {
      out[id] = { x: x, y: depth * 70 };
      var kids = children[id] || [];
      if (kids.length === 0) x += 50;
      else kids.forEach(function (k) { place(k, depth + 1); });
    }
    roots.forEach(function (r) { place(r, 0); });
    var minX = Infinity, maxX = -Infinity;
    Object.keys(out).forEach(function (id) {
      minX = Math.min(minX, out[id].x); maxX = Math.max(maxX, out[id].x);
    });
    Object.keys(out).forEach(function (id) { out[id].x -= (minX + maxX) / 2; });
    return out;
  }
  // Label discipline (section 16 Tier C): show a label only above a camera zoom
  // threshold or for high-degree nodes; hover/selection reveal it regardless.
  function labelVisible(zoom, degree) {
    return zoom >= 0.6 || degree >= 8;
  }

  // ---- weave-view v3: cluster aggregation + deterministic layouts ----
  // Structural aggregation over contains/anchored-at edges (zero core
  // change). Clusters are nodes with >0 children; leaves hide inside their
  // collapsed parent cluster until it is expanded. Everything is derived from
  // the model + the client expand-set, so a no-op rebuild changes nothing.
  function clusterAggregate(model, expanded) {
    var byId = {}, children = {}, incoming = {};
    model.nodes.forEach(function (n) { byId[n.id] = n; });
    model.edges.forEach(function (e) {
      if (e.kind !== "contains" && e.kind !== "anchored-at") return;
      (children[e.source] = children[e.source] || []).push(e.target);
      incoming[e.target] = 1;
    });
    // Dedupe children (a DAG may mention a child twice); classify clusters.
    var clusters = {}, counts = {};
    Object.keys(children).forEach(function (id) {
      var seen = {}, list = [];
      (children[id] || []).forEach(function (c) { if (!seen[c]) { seen[c] = 1; list.push(c); } });
      children[id] = list;
      if (list.length === 0) return;
      clusters[id] = { child: list, count: list.length };
      counts[id] = list.length;
    });
    // Per-cluster provenance split over all descendants (ring = dominant,
    // mini-bar if mixed).
    var provSplits = {};
    function descend(id, seen) {
      var s = { human: 0, agent: 0, generated: 0 };
      if (seen[id]) return s;
      seen[id] = 1;
      (children[id] || []).forEach(function (c) {
        var n = byId[c];
        if (n && n.provenance === "human") s.human++;
        else if (n && n.provenance === "agent") s.agent++;
        else if (n && n.provenance === "generated") s.generated++;
        var sub = descend(c, seen);
        s.human += sub.human; s.agent += sub.agent; s.generated += sub.generated;
      });
      return s;
    }
    Object.keys(clusters).forEach(function (id) { provSplits[id] = descend(id, {}); });
    // Visibility: clusters are the aggregation surface (always shown); leaves
    // are revealed only when every containing cluster is expanded.
    var roots = model.nodes.filter(function (n) { return !incoming[n.id]; }).map(function (n) { return n.id; });
    var visible = {};
    function reveal(id) {
      if (visible[id]) return;
      visible[id] = 1;
      (children[id] || []).forEach(function (c) {
        if (clusters[c]) reveal(c);
        else if (expanded[id]) reveal(c);
      });
    }
    roots.forEach(reveal);
    var hiddenLeafIds = [];
    model.nodes.forEach(function (n) {
      if (!visible[n.id] && !clusters[n.id]) hiddenLeafIds.push(n.id);
    });
    return { clusters: clusters, counts: counts, provSplits: provSplits,
      hiddenLeafIds: hiddenLeafIds, visible: visible, roots: roots };
  }
  // All cluster ids nested under [clusterId] (recursively), used by both
  // expand-all and collapse.
  function clusterDescendants(model, clusterId) {
    var children = {}, clusters = {};
    model.edges.forEach(function (e) {
      if (e.kind !== "contains" && e.kind !== "anchored-at") return;
      (children[e.source] = children[e.source] || []).push(e.target);
    });
    Object.keys(children).forEach(function (id) {
      var seen = {}, list = [];
      (children[id] || []).forEach(function (c) { if (!seen[c]) { seen[c] = 1; list.push(c); } });
      children[id] = list;
      if (list.length) clusters[id] = 1;
    });
    function collect(id, out) {
      (children[id] || []).forEach(function (c) {
        if (clusters[c]) { out[c] = 1; collect(c, out); }
      });
    }
    var out = {}; collect(clusterId, out);
    return out;
  }
  // Return the set of cluster ids that should be added to the expand-set.
  // one level: just [clusterId]; [all] adds every descendant cluster too.
  function expandChildren(model, clusterId, all) {
    var set = new Set();
    set.add(clusterId);
    if (all) { var d = clusterDescendants(model, clusterId); Object.keys(d).forEach(function (k) { set.add(k); }); }
    return set;
  }
  // Return the set of cluster ids that should be removed from the expand-set
  // (the cluster and every descendant cluster it swallows).
  function collapseChildren(model, clusterId) {
    var set = new Set();
    set.add(clusterId);
    var d = clusterDescendants(model, clusterId); Object.keys(d).forEach(function (k) { set.add(k); });
    return set;
  }
  // Deterministic cluster layout: containment roots fanned around the centre,
  // each expanded cluster's children in a ring around their frame (so revealed
  // leaves stay local and never collide with the rest of the graph).
  function clusterLayout(agg, expanded) {
    var out = {};
    var roots = agg.roots || [];
    roots.forEach(function (id, i) {
      var a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, roots.length);
      var R = 190;
      out[id] = { x: Math.cos(a) * R, y: Math.sin(a) * R };
    });
    function childrenOf(id) { return agg.clusters[id] ? agg.clusters[id].child : []; }
    function placeChildren(id) {
      var kids = childrenOf(id);
      if (!kids.length || !out[id]) return;
      var shown = 0;
      kids.forEach(function (k) { if (agg.clusters[k] || expanded[id]) shown++; });
      if (shown === 0) return;
      var r = 70 + Math.sqrt(agg.counts[id] || 0) * 16;
      var idx = 0;
      kids.forEach(function (k) {
        var isCluster = !!agg.clusters[k];
        if (!isCluster && !expanded[id]) return; // hidden leaf: no position yet
        var a = -Math.PI / 2 + (2 * Math.PI * idx) / Math.max(1, shown);
        out[k] = { x: out[id].x + Math.cos(a) * r, y: out[id].y + Math.sin(a) * r };
        idx++;
        if (isCluster && expanded[k]) placeChildren(k);
      });
    }
    roots.forEach(function (id) { placeChildren(id); });
    return out;
  }
  // FNV-1a hash of a string (used to key per-repo localStorage positions).
  function hashCwd(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }
  // Cubic-bezier easing (.2,.7,.2,1) — Newton solve on the x curve, then
  // evaluate y. t is normalised progress in [0,1].
  function cubicBezierEase(progress, x1, y1, x2, y2) {
    var p = Math.max(0, Math.min(1, progress));
    var t = p;
    for (var i = 0; i < 8; i++) {
      var x = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
      var dx = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
      t -= (x - p) / (dx || 1e-9);
    }
    return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  }
  // Interpolate node positions from [from] to [to] by progress t (reduced-motion
  // callers pass t=1 for an instant cut). New nodes (no [from]) jump to target.
  function tweenPositions(from, to, t) {
    var u = cubicBezierEase(t, 0.2, 0.7, 0.2, 1);
    var out = {};
    for (var id in to) {
      var f = from[id], end = to[id];
      out[id] = f ? { x: f.x + (end.x - f.x) * u, y: f.y + (end.y - f.y) * u } : { x: end.x, y: end.y };
    }
    return out;
  }
  // Restore persisted node positions for [ids] from a per-repo localStorage
  // store (keyed by cwd hash). Drops ids that no longer exist and ignores
  // malformed/corrupt entries (never throws). [store] may be a real
  // localStorage (getItem) or a plain map for tests.
  function persistedPositions(cwdHash, store, ids) {
    var raw = null;
    try { raw = store.getItem ? store.getItem(cwdHash) : store[cwdHash]; } catch (e) { raw = null; }
    var data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
    if (!data || typeof data !== "object" || data === null) return {};
    var out = {};
    for (var i = 0; i < ids.length; i++) {
      var p = data[ids[i]];
      if (p && typeof p.x === "number" && typeof p.y === "number" &&
        isFinite(p.x) && isFinite(p.y)) {
        out[ids[i]] = { x: p.x, y: p.y };
      }
    }
    return out;
  }
  // ---- weave-view v3 M3: semantic zoom + labels + edges (pure) ----
  // Camera-scale zoom band: far (overview) / mid / near (drill-in). Labels and
  // detail follow this policy (section 3.2).
  function semanticZoomBand(scale) {
    if (scale < 0.4) return "far";
    if (scale < 0.8) return "mid";
    return "near";
  }
  // Whether a (non-cluster) node label shows at the current camera scale.
  // Degree priority + zoom gate + selection (section 4.3): far shows only hubs,
  // mid shows mid/high degree + selection, near shows everything. Cluster labels
  // are always shown by the renderer (few of them), so this policy only gates leaves.
  function clusterLabelPolicy(zoom, degree, selection) {
    var band = semanticZoomBand(zoom);
    if (selection) return true;
    if (band === "far") return degree >= 8;
    if (band === "mid") return degree >= 3;
    return true;
  }
  // Mid-ellipsis truncation (decision 6): keep the prefix AND the extension so
  // src…slug.ts.summary.md stays readable. Returns the label unchanged when it fits.
  function midEllipsis(label, maxLen) {
    if (!label || label.length <= maxLen) return label;
    var ell = "…";
    var keep = maxLen - ell.length;
    if (keep < 2) return label.slice(0, Math.max(0, maxLen - 1)) + ell;
    var left = Math.ceil(keep / 2);
    var right = Math.floor(keep / 2);
    return label.slice(0, left) + ell + label.slice(label.length - right);
  }
  // Axis-aligned rect helpers for the quadtree label collision pass.
  function Rect(x, y, w, h) { this.x = x; this.y = y; this.w = w; this.h = h; }
  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  // Hand-rolled quadtree (no dep) over label rects: O(n log n) overlap tests.
  // Items may be duplicated into boundary quadrants (safe superset for queries).
  function Quad(x, y, w, h, depth) {
    this.x = x; this.y = y; this.w = w; this.h = h; this.depth = depth;
    this.items = []; this.nw = null; this.ne = null; this.sw = null; this.se = null;
  }
  Quad.prototype.insert = function (rect, maxDepth) {
    if (this.nw) {
      if (rectsOverlap(rect, this.nw)) this.nw.insert(rect, maxDepth);
      if (rectsOverlap(rect, this.ne)) this.ne.insert(rect, maxDepth);
      if (rectsOverlap(rect, this.sw)) this.sw.insert(rect, maxDepth);
      if (rectsOverlap(rect, this.se)) this.se.insert(rect, maxDepth);
      return;
    }
    this.items.push(rect);
    if (this.items.length > 8 && this.depth < maxDepth) {
      var hw = this.w / 2, hh = this.h / 2, d = this.depth + 1;
      this.nw = new Quad(this.x, this.y, hw, hh, d);
      this.ne = new Quad(this.x + hw, this.y, hw, hh, d);
      this.sw = new Quad(this.x, this.y + hh, hw, hh, d);
      this.se = new Quad(this.x + hw, this.y + hh, hw, hh, d);
      var items = this.items; this.items = [];
      for (var i = 0; i < items.length; i++) this.insert(items[i], maxDepth);
    }
  };
  Quad.prototype.query = function (rect, out) {
    out = out || [];
    for (var i = 0; i < this.items.length; i++) {
      if (rectsOverlap(rect, this.items[i])) out.push(this.items[i]);
    }
    if (this.nw) {
      if (rectsOverlap(rect, this.nw)) this.nw.query(rect, out);
      if (rectsOverlap(rect, this.ne)) this.ne.query(rect, out);
      if (rectsOverlap(rect, this.sw)) this.sw.query(rect, out);
      if (rectsOverlap(rect, this.se)) this.se.query(rect, out);
    }
    return out;
  };
  // Label collision pass (section 4.3): draw a label only if it doesn't overlap a
  // higher-priority label. Priority = degree/selection then alphabetical. Returns
  // the Set of label ids to render.
  function labelCollision(positions, labels, priority) {
    var scored = labels.map(function (l) {
      var pos = positions[l.id] || { x: 0, y: 0 };
      var p = typeof priority === "function" ? priority(l) : (l.priority || 0);
      return { id: l.id, x: pos.x, y: pos.y, w: l.w || 60, h: l.h || 12, p: p };
    });
    scored.sort(function (a, b) { return b.p - a.p || a.id.localeCompare(b.id); });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    scored.forEach(function (s) {
      if (s.x < minX) minX = s.x; if (s.y < minY) minY = s.y;
      if (s.x + s.w > maxX) maxX = s.x + s.w; if (s.y + s.h > maxY) maxY = s.y + s.h;
    });
    var tree = new Quad(minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY), 0);
    var out = new Set();
    scored.forEach(function (s) {
      var rect = new Rect(s.x, s.y, s.w, s.h);
      var hits = tree.query(rect), clash = false;
      for (var i = 0; i < hits.length; i++) {
        if (rectsOverlap(rect, hits[i])) { clash = true; break; }
      }
      if (!clash) { tree.insert(rect, 6); out.add(s.id); }
    });
    return out;
  }
  // Edge declutter (section 4.2): merge parallel edges (same source+kind+target)
  // into one line with reduced opacity, and prune edges to hidden/clustered
  // leaves. [visible] is a record {id:1} of currently visible nodes.
  function bundledEdges(edges, visible) {
    var byKey = {}, out = [];
    edges.forEach(function (e) {
      if (!visible || !visible[e.source] || !visible[e.target]) return;
      var key = e.source + "\u0001" + e.kind + "\u0001" + e.target;
      if (!byKey[key]) {
        byKey[key] = { source: e.source, target: e.target, kind: e.kind, count: 0 };
        out.push(byKey[key]);
      }
      byKey[key].count++;
    });
    return out.map(function (b) {
      var opacity = b.count > 2 ? 0.4 : b.count > 1 ? 0.7 : 1;
      return { source: b.source, target: b.target, kind: b.kind, count: b.count, opacity: opacity };
    });
  }
  // ---- weave-view v3 M4: filter + scored search (pure) ----
  // Whether a single node passes the current control-panel filter. opts = {
  //   kinds, provenance (sets), hideInternals, orphans, backlinks, recentDays }.
  function nodeMatchesFilter(node, opts) {
    opts = opts || {};
    if (opts.kinds && Object.keys(opts.kinds).length && !opts.kinds[node.kind]) return false;
    if (opts.provenance && Object.keys(opts.provenance).length &&
      !(node.provenance && opts.provenance[node.provenance])) return false;
    if (opts.hideInternals && (node.kind === "gitState" || node.kind === "external")) return false;
    if (opts.orphans) {
      var isNote = node.kind === "note";
      var back = opts.backlinks ? opts.backlinks[node.id] : null;
      if (isNote && (!back || !back.length)) { /* orphan note: pass */ }
      else return false;
    }
    if (opts.recentDays) {
      var now = opts.now != null ? opts.now : Date.now();
      var u = node.detail && node.detail.updated ? new Date(node.detail.updated).getTime() : NaN;
      if (isNaN(u) || u < now - opts.recentDays * 86400000) return false;
    }
    return true;
  }
  // The set of cluster ids that contain a matching node (auto-expand ancestors so
  // filtered matches stay reachable).
  function ancestorClusters(model, matchSet) {
    var children = {};
    model.edges.forEach(function (e) {
      if (e.kind === "contains" || e.kind === "anchored-at") (children[e.source] = children[e.source] || []).push(e.target);
    });
    Object.keys(children).forEach(function (id) {
      var seen = {}, list = [];
      (children[id] || []).forEach(function (c) { if (!seen[c]) { seen[c] = 1; list.push(c); } });
      children[id] = list;
    });
    function hasMatch(id, visited) {
      visited = visited || {};
      if (visited[id]) return false;
      visited[id] = 1;
      if (matchSet[id]) return true;
      return (children[id] || []).some(function (c) { return hasMatch(c, visited); });
    }
    var out = new Set();
    Object.keys(children).forEach(function (id) {
      if (hasMatch(id, {})) out.add(id);
    });
    return out;
  }
  // Client-side scored search over the graph (mirrors core searchNotes ranking):
  // label/title = 3, slug/path = 2, summary = 1; sorted score desc then label asc.
  function scoredSearch(nodes, query) {
    var q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    var hits = [];
    nodes.forEach(function (n) {
      var score = 0;
      var label = (n.label || "").toLowerCase();
      if (label.indexOf(q) >= 0) score += 3;
      var d = n.detail || {};
      if ((d.slug || "").toLowerCase().indexOf(q) >= 0 || (d.path || "").toLowerCase().indexOf(q) >= 0) score += 2;
      if ((d.summary || "").toLowerCase().indexOf(q) >= 0) score += 1;
      if (score > 0) hits.push({ id: n.id, score: score, label: n.label });
    });
    hits.sort(function (a, b) { return b.score - a.score || a.label.localeCompare(b.label); });
    return hits;
  }
  // ===== end pure =====

  var COLORS = { vault: "#8b5cf6", note: "#c4b5fd", repository: "#3b82f6",
    module: "#22c55e", "package": "#14b8a6", entryPoint: "#a3e635",
    gitState: "#facc15", external: "#fb923c", file: "#6ee7b7" };
  var PROV_COLOR = { human: "#a7f3d0", agent: "#e9d5ff", generated: "#94a3b8" };
  var PROV_GLYPH = { human: "●", agent: "◐", generated: "○" };
  var EDGE_COLORS = { contains: "#2e3a55", "anchored-at": "#a16207", "links-to": "#7c3aed", mentions: "#525252" };
  var EDGE_DASH = { "links-to": "4 3", "mentions": "2 3" };
  var REST = { contains: 105, "anchored-at": 130, "links-to": 160, mentions: 160 };
  var svgNS = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("graph");
  var panel = document.getElementById("panel");
  var searchEl = document.getElementById("search");
  var model = null, lastJson = "";
  var surface = "graph", selectedId = null, focusId = null, focusSet = null;
  var query = "", kindFilter = "", provFilter = "", recentDays = 0, listSort = "name";
  var listLimit = 100;
  var listExpanded = { vault: 1, repository: 1 };
  var showInternals = false;
  var sim = {}, alpha = 0, posMap = {}, layoutMode = "cluster";
  var expanded = {}, aggregate = null;
  // Force-layout tunables surfaced in the controls panel force sliders (M4).
  var REPEL_K = 1, CENTER_K = 1, COLLIDE_K = 1;
  // cwd is injected by the server (renderPage(cwd)) so per-repo positions are
  // keyed by a stable cwd hash, not by the volatile loopback port.
  var PAGE_CWD = __VIEWER_CWD_JSON__;
  var cwdHash = hashCwd(typeof PAGE_CWD === "string" ? PAGE_CWD : "");
  var storeKey = function () { return "weave-pos-" + cwdHash; };
  var W = window.innerWidth, H = window.innerHeight, world = null;
  var cam = { x: 0, y: 0, k: 1 };
  var panning = null, helpOpen = false;
  // weave-view v3 M3/M4 state: hovered node (default edge/label emphasis) and
  // the control-panel filter state (kinds/provenance sets, toggles, depth).
  var hoveredId = null;
  var matchSet = null;             // ids matching the active filter
  var ancSet = null;               // clusters that contain a filter match
  var ctl = { kinds: {}, provenance: {}, orphans: false, hideInternals: false,
    recentDays: 0, dimFiltered: false, hoverExpand: false, depthLimit: 0 };
  var controlsOpen = false;
  function filterActive() {
    return !!Object.keys(ctl.kinds).length || !!Object.keys(ctl.provenance).length ||
      ctl.orphans || ctl.hideInternals || ctl.recentDays > 0;
  }

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    svg.setAttribute("width", W); svg.setAttribute("height", H);
  }
  window.addEventListener("resize", resize);
  resize();

  function el(name, attrs) {
    var n = document.createElementNS(svgNS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  // ===== markdown =====
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function capLabel(s) { return s.length > 30 ? s.slice(0, 29) + "…" : s; }
  function mdInline(t) {
    t = t.replace(/\\[\\[([^\\[\\]|]+)(?:\\|([^\\]\\[]*))?\\]\\]/g, function (m, slug, al) {
      return "<a class='wikilink' href='#' data-slug='" + esc(slug) + "'>" + esc(al || slug) + "</a>";
    });
    t = t.replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>");
    t = t.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\\*([^*\\s][^*]*)\\*/g, "$1<em>$2</em>");
    t = t.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (m, txt, url) {
      if (!/^(https?:\\/\\/|mailto:|#|\\/)/.test(url)) return txt;
      return "<a href=\\"" + url + "\\" target=\\"_blank\\" rel=\\"noopener\\">" + txt + "</a>";
    });
    return t;
  }
  function renderMd(rawSrc) {
    var src = esc(rawSrc); // escape FIRST: everything we add afterwards is our own markup
    var lines = src.replace(/\\r/g, "").split("\\n"), out = "", inCode = false, list = false, para = [];
    function flushPara() {
      if (para.length) { out += "<p>" + mdInline(para.join(" ")) + "</p>"; para = []; }
    }
    function flushList() { if (list) { out += "</ul>"; list = false; } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], m;
      if (/^\\s*\\x60\\x60\\x60/.test(line)) {
        flushPara(); flushList();
        out += inCode ? "</code></pre>" : "<pre><code>";
        inCode = !inCode; continue;
      }
      if (inCode) { out += line + "\\n"; continue; }
      if ((m = /^(#{1,4})\\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        out += "<h" + m[1].length + ">" + mdInline(m[2]) + "</h" + m[1].length + ">"; continue;
      }
      if ((m = /^\\s*[-*]\\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list) { out += "<ul>"; list = true; }
        out += "<li>" + mdInline(m[1]) + "</li>"; continue;
      }
      if ((m = /^&gt;\\s?(.*)$/.exec(line))) {
        flushPara(); flushList();
        out += "<blockquote>" + mdInline(m[1]) + "</blockquote>"; continue;
      }
      flushList();
      if (line.trim().length === 0) flushPara(); else para.push(line.trim());
    }
    flushPara(); flushList();
    if (inCode) out += "</code></pre>";
    return out;
  }
  // ===== end markdown =====

  // ---------- graph helpers ----------
  function degreeOf(id, edges) {
    var d = 0;
    edges.forEach(function (e) { if (e.source === id || e.target === id) d++; });
    return d;
  }
  function radiusFor(node, edges) {
    if (node.kind === "vault" || node.kind === "repository") return 14;
    return 7 + Math.min(6, Math.sqrt(degreeOf(node.id, edges)) * 1.2);
  }
  function shapeEl(kind, r) {
    var n;
    if (kind === "repository" || kind === "module" || kind === "package") {
      n = document.createElementNS(svgNS, "rect");
      n.setAttribute("x", -r); n.setAttribute("y", -r);
      n.setAttribute("width", r * 2); n.setAttribute("height", r * 2);
      n.setAttribute("rx", r * 0.35);
    } else if (kind === "entryPoint") {
      n = document.createElementNS(svgNS, "polygon");
      n.setAttribute("points", "0," + (-r) + " " + (r * 0.9) + "," + (r * 0.7) + " " + (-r * 0.9) + "," + (r * 0.7));
    } else if (kind === "gitState") {
      n = document.createElementNS(svgNS, "polygon");
      n.setAttribute("points", "0," + (-r) + " " + (r * 0.8) + ",0 0," + r + " " + (-r * 0.8) + ",0");
    } else if (kind === "external") {
      n = document.createElementNS(svgNS, "polygon");
      var pts = [];
      for (var i = 0; i < 6; i++) {
        var a = Math.PI / 6 + i * Math.PI / 3;
        pts.push((Math.cos(a) * r).toFixed(1) + "," + (Math.sin(a) * r).toFixed(1));
      }
      n.setAttribute("points", pts.join(" "));
    } else {
      n = document.createElementNS(svgNS, "circle");
      n.setAttribute("r", r);
    }
    n.setAttribute("class", "shape");
    return n;
  }

  // ---------- visibility (progressive disclosure) ----------
  function childrenOf(id) {
    var out = [];
    model.edges.forEach(function (e) {
      if (e.kind === "contains" && e.source === id) out.push(e.target);
    });
    return out;
  }

  // ---------- force layout (section 16: persisted positions, degree-scaled
  // forces, real collision, anti-oscillation; warm-up before paint) ----------
  function tick() {
    var ids = Object.keys(sim).filter(function (id) { return sim[id].visible; });
    var i, j, a, b, dx, dy, d2, d, f, id, iter;
    var deg = {};
    model.edges.forEach(function (e) {
      if (sim[e.source]) deg[e.source] = (deg[e.source] || 0) + 1;
      if (sim[e.target]) deg[e.target] = (deg[e.target] || 0) + 1;
    });
    // degree-weighted gravity (ForceAtlas2): hubs held central, islands (low
    // degree) pulled gently so they pack without imploding into the center.
    for (i = 0; i < ids.length; i++) {
      id = ids[i]; a = sim[id];
      var g = 0.0006 * alpha * (1 + (deg[id] || 0) * 0.12) * CENTER_K;
      a.vx += (W / 2 - a.x) * g;
      a.vy += (H / 2 - a.y) * g;
    }
    // repulsion-by-degree (ForceAtlas2): weak between leaves (so they pack near
    // hubs), strong around hubs. Normalized so a leaf-leaf pair ~original.
    for (i = 0; i < ids.length; i++) {
      id = ids[i]; a = sim[id];
      for (j = i + 1; j < ids.length; j++) {
        b = sim[ids[j]];
        dx = a.x - b.x; dy = a.y - b.y;
        d2 = dx * dx + dy * dy;
        if (d2 > 67600) continue; // 260px repulsion cutoff
        d = Math.sqrt(d2) || 0.001;
        f = 380 * alpha * degreeRepulsion(deg[id] || 0, deg[ids[j]] || 0) / d2 * REPEL_K;
        a.vx += dx / d * f; a.vy += dy / d * f;
        b.vx -= dx / d * f; b.vy -= dy / d * f;
      }
    }
    model.edges.forEach(function (e) {
      var s = sim[e.source], t = sim[e.target];
      if (!s || !t || !s.visible || !t.visible) return;
      var ddx = t.x - s.x, ddy = t.y - s.y;
      var dd = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      var k = (dd - (REST[e.kind] || 120)) * 0.018 * alpha;
      s.vx += ddx * k; s.vy += ddy * k;
      t.vx -= ddx * k; t.vy -= ddy * k;
    });
    // real collision: border-to-border, 2 relaxation iterations, anticipated
    // positions (x+vx) to reduce jitter. Replaces the old 22px floor.
    for (iter = 0; iter < 2; iter++) {
      for (i = 0; i < ids.length; i++) {
        id = ids[i]; a = sim[id];
        for (j = i + 1; j < ids.length; j++) {
          b = sim[ids[j]];
          dx = (a.x + a.vx) - (b.x + b.vx);
          dy = (a.y + a.vy) - (b.y + b.vy);
          d2 = dx * dx + dy * dy;
          var minD = (collideRadius(deg[id] || 0) + collideRadius(deg[ids[j]] || 0)) * COLLIDE_K;
          if (d2 >= minD * minD) continue;
          d = Math.sqrt(d2) || 0.001;
          var push = (minD - d) / 2;
          if (!a.fixed) { a.x += dx / d * push; a.y += dy / d * push; }
          if (!b.fixed) { b.x -= dx / d * push; b.y -= dy / d * push; }
        }
      }
    }
    // integrate with anti-oscillation (ForceAtlas2 swinging/traction local
    // speed): oscillators take smaller steps than steady movers.
    ids.forEach(function (id) {
      var n = sim[id];
      if (n.fixed) return;
      var sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > 14) { n.vx = n.vx * 14 / sp; n.vy = n.vy * 14 / sp; } // speed cap
      var speed = localSpeed(n.prevForce, { x: n.vx, y: n.vy });
      n.prevForce = { x: n.vx, y: n.vy };
      n.vx *= 0.82 * speed; n.vy *= 0.82 * speed;
      n.x += n.vx; n.y += n.vy;
    });
    ids.forEach(function (id) {
      var n = sim[id];
      n.x = Math.max(20, Math.min(W - 20, n.x));
      n.y = Math.max(60, Math.min(H - 20, n.y));
    });
    alpha *= 0.995;
  }

  var edgeLines = [];
  // The label text for a node: mid-ellipsis (decision 6) + cluster chevron +
  // staleness warning. Full name stays in the hover tooltip and Detail panel.
  function displayLabel(node, isCluster) {
    var txt = midEllipsis(node.label, 26);
    if (isCluster) txt += expanded[node.id] ? "  ▾" : "  ▸";
    if (node.id === "repository" && model.staleness && model.staleness.state === "stale") txt = "⚠ " + txt;
    return txt;
  }
  // Semantic-zoom + collision label pass (M3): decide which labels draw this
  // frame. Cluster labels always qualify; leaves follow clusterLabelPolicy;
  // then a quadtree collision pass drops any label that overlaps a higher-
  // priority label (priority = cluster > selection/hover > degree).
  function paintLabels() {
    var positions = {}, labels = [];
    Object.keys(sim).forEach(function (id) {
      var n = sim[id];
      if (!n.labelEl || !n.visible) return;
      var isCluster = !!aggregate.clusters[id];
      var hovered = n.g.classList.contains("hovered") || id === hoveredId;
      var sel = selectedId === id;
      var show = isCluster || clusterLabelPolicy(cam.k, n.deg || 0, sel || hovered);
      var txt = displayLabel(n.node, isCluster);
      // label rect in screen space (the world group is scaled by cam.k)
      positions[id] = { x: cam.x + n.x * cam.k, y: cam.y + n.y * cam.k };
      labels.push({ id: id, w: (txt.length * 6.2 + 10) * cam.k, h: 12 * cam.k,
        priority: (isCluster ? 10000 : 0) + (sel || hovered ? 5000 : 0) + (n.deg || 0) });
    });
    var toShow = labelCollision(positions, labels, null);
    Object.keys(sim).forEach(function (id) {
      var n = sim[id];
      if (!n.labelEl || !n.visible) return;
      n.labelEl.style.opacity = toShow.has(id) ? "1" : "0";
    });
  }
  function paint() {
    if (!aggregate) return;
    Object.keys(sim).forEach(function (id) {
      var n = sim[id];
      n.visible = !!aggregate.visible[id];
      if (n.visible && filterActive()) {
        var isC = !!aggregate.clusters[id];
        if (!matchSet[id]) {
          // hide non-matching nodes unless they are a dimmed ancestor frame.
          if (!(isC && ancSet[id]) && !ctl.dimFiltered) n.visible = false;
        }
      }
      n.g.style.display = n.visible ? "" : "none";
      if (n.visible) {
        var filtered = filterActive() && !matchSet[id];
        var dimmed = (query.length > 0 && n.node.label.toLowerCase().indexOf(query) < 0) ||
          (focusSet && !focusSet[id]) || filtered;
        n.g.setAttribute("class", dimmed ? "node dim" : "node");
        n.g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
        if (n.selRing) n.selRing.style.display = selectedId === id ? "" : "none";
        // keep the drawn label text in sync (mid-ellipsis + chevron).
        if (n.labelEl) {
          var txt = displayLabel(n.node, !!aggregate.clusters[id]);
          if (n.labelEl.__txt !== txt) { n.labelEl.__txt = txt; n.labelEl.textContent = txt; }
        }
      }
    });
    paintLabels();
    edgeLines.forEach(function (rec) {
      var s = sim[rec.e.source], t = sim[rec.e.target];
      var vis = s && t && s.visible && t.visible;
      rec.line.style.display = vis ? "" : "none";
      if (vis) {
        rec.line.setAttribute("x1", s.x); rec.line.setAttribute("y1", s.y);
        rec.line.setAttribute("x2", t.x); rec.line.setAttribute("y2", t.y);
        // default interaction (v3 4.2): incident edges brighten, the rest fade;
        // containment skeleton stays thin under nodes; cross-links bundle-dimmer.
        var incident = rec.e.source === selectedId || rec.e.target === selectedId ||
          rec.e.source === hoveredId || rec.e.target === hoveredId;
        var focusDim = focusSet && !(focusSet[rec.e.source] && focusSet[rec.e.target]);
        rec.line.setAttribute("opacity", (incident && !focusDim) ? "1" : String(rec.base));
      }
    });
  }

  function loop() { if (alpha > 0.006) { tick(); paint(); } requestAnimationFrame(loop); }

  // ---------- camera ----------
  function camApply() {
    if (world) world.setAttribute("transform", "translate(" + cam.x + "," + cam.y + ") scale(" + cam.k + ")");
  }
  function zoomAt(mx, my, dk) {
    var nk = Math.min(4, Math.max(0.25, cam.k * dk));
    cam.x = mx - (mx - cam.x) * (nk / cam.k);
    cam.y = my - (my - cam.y) * (nk / cam.k);
    cam.k = nk; camApply();
  }
  svg.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    var rect = svg.getBoundingClientRect();
    zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.exp(-ev.deltaY * 0.0012));
  }, { passive: false });
  svg.addEventListener("pointerdown", function (ev) {
    if (ev.target !== svg) return;
    panning = { px: ev.clientX, py: ev.clientY, cx: cam.x, cy: cam.y };
    svg.setPointerCapture(ev.pointerId);
    closePanel();
  });
  svg.addEventListener("pointermove", function (ev) {
    if (!panning) return;
    cam.x = panning.cx + (ev.clientX - panning.px);
    cam.y = panning.cy + (ev.clientY - panning.py);
    camApply();
  });
  svg.addEventListener("pointerup", function () { panning = null; });
  document.getElementById("zoom-in").addEventListener("click", function () { zoomAt(W / 2, H / 2, 1.25); });
  document.getElementById("zoom-out").addEventListener("click", function () { zoomAt(W / 2, H / 2, 0.8); });
  document.getElementById("zoom-reset").addEventListener("click", function () {
    cam = { x: 0, y: 0, k: 1 }; camApply();
  });
  function toWorld(ev) {
    var rect = svg.getBoundingClientRect();
    return { x: (ev.clientX - rect.left - cam.x) / cam.k, y: (ev.clientY - rect.top - cam.y) / cam.k };
  }

  // ---------- surfaces ----------
  // Graph and List are merged into one "Explore" surface: the graph canvas is
  // the main view with the index tree as a collapsible left sidebar (there is
  // no separate List tab). Health stays a distinct full surface.
  var listOpen = true;
  function showSurface(s) {
    surface = s;
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-surface") === s);
    });
    svg.style.display = s === "graph" ? "block" : "none";
    document.body.classList.toggle("list-open", s === "graph" && listOpen);
    document.getElementById("health").style.display = s === "health" ? "block" : "none";
    if (s === "graph") renderList();
    if (s === "health") renderHealth();
  }
  function toggleListPanel() {
    listOpen = !listOpen;
    document.body.classList.toggle("list-open", surface === "graph" && listOpen);
    var t = document.getElementById("list-toggle");
    t.setAttribute("aria-pressed", listOpen ? "true" : "false");
  }
  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () { showSurface(b.getAttribute("data-surface")); });
  });
  document.getElementById("list-toggle").addEventListener("click", toggleListPanel);

  function provBar(c) {
    var total = Math.max(1, c.human + c.agent + c.generated);
    var hw = Math.round(c.human / total * 100);
    var aw = Math.round(c.agent / total * 100);
    var gw = Math.round(c.generated / total * 100);
    return "<span class='provbar' title='human/agent/generated'>" +
      "<i class='p-human' style='width:" + hw + "%'></i>" +
      "<i class='p-agent' style='width:" + aw + "%'></i>" +
      "<i class='p-generated' style='width:" + gw + "%'></i></span>";
  }
  function renderStatus() {
    var el = document.getElementById("status");
    if (!model) { el.innerHTML = ""; return; }
    var c = counts(model.nodes);
    var html = "<span class='stat'>" + c.total + " nodes</span>" + provBar(c);
    if (model.staleness && model.staleness.state === "stale") {
      html += "<span class='stat stale'>stale</span>";
    }
    el.innerHTML = html;
    document.getElementById("stamp").textContent =
      model.generatedAt ? "indexed " + relTime(model.generatedAt, Date.now()) : "";
  }

  // ---------- list (tree) ----------
  function listById() {
    var byId = {};
    model.nodes.forEach(function (n) { byId[n.id] = n; });
    return byId;
  }
  function toggleList(id) {
    if (listExpanded[id]) delete listExpanded[id]; else listExpanded[id] = 1;
    renderList();
  }
  function renderList() {
    if (!model) return;
    var container = document.getElementById("list-rows");
    var byId = listById();
    var rows = listTree(model, {
      kindFilter: kindFilter, provFilter: provFilter, recentDays: recentDays,
      query: query, listSort: listSort, listExpanded: listExpanded, showInternals: showInternals,
    });
    var shown = rows.slice(0, listLimit);
    var html = "";
    shown.forEach(function (r) {
      var n = byId[r.id];
      var chev = r.hasKids ? (r.expanded ? "▾" : "▸") : "";
      html += "<div class='row" + (selectedId === r.id ? " selected" : "") + "' data-id='" + esc(r.id) + "' tabindex='0' role='button' style='padding-left:" + (8 + r.depth * 16) + "px'>" +
        "<span class='chev" + (r.hasKids ? "" : " empty") + "' data-toggle='" + esc(r.id) + "'>" + chev + "</span>" +
        "<span class='row-label' title='" + esc(listLabel(n)) + "'>" + esc(listLabel(n)) + "</span>" +
        "<span class='row-kind'>" + esc(n.kind) + "</span>" +
        (n.provenance ? "<span class='prov " + esc(n.provenance) + "'>" + esc(n.provenance) + "</span>" : "") +
        "<span class='row-meta'>" + (n.detail.updated ? relTime(n.detail.updated, Date.now()) : "") + " · " + linksOf(n.id, model.edges) + "</span>" +
        "</div>";
    });
    container.innerHTML = html;
    document.getElementById("show-more").style.display = rows.length > listLimit ? "" : "none";
    container.querySelectorAll(".row").forEach(function (row) {
      row.addEventListener("click", function (ev) {
        var t = ev.target;
        if (t && t.getAttribute && t.getAttribute("data-toggle")) {
          toggleList(t.getAttribute("data-toggle"));
          return;
        }
        selectById(row.getAttribute("data-id"));
      });
    });
  }
  document.getElementById("show-more").addEventListener("click", function () {
    listLimit += 100; renderList();
  });
  document.getElementById("sort").addEventListener("change", function (e) { listSort = e.target.value; renderList(); });
  document.getElementById("kind-filter").addEventListener("change", function (e) { kindFilter = e.target.value; renderList(); });
  document.getElementById("prov-filter").addEventListener("change", function (e) { provFilter = e.target.value; renderList(); });
  document.getElementById("recent-filter").addEventListener("change", function (e) {
    recentDays = Number(e.target.value) || 0; renderList();
  });
  document.getElementById("internals").addEventListener("change", function (e) {
    showInternals = !!e.target.checked; renderList();
  });

  // ---------- health ----------
  function renderHealth() {
    var content = document.getElementById("health-content");
    if (!model) { content.innerHTML = ""; return; }
    var backlinks = deriveBacklinks(model.edges);
    var c = counts(model.nodes);
    var orphans = model.nodes.filter(function (n) {
      return n.kind === "note" && !(backlinks[n.id] && backlinks[n.id].length);
    });
    var dangling = model.nodes.filter(function (n) {
      var d = n.detail["dangling links"];
      return d && d !== "0" && d !== "";
    });
    var hubs = model.nodes.slice().sort(function (a, b) {
      return degreeOf(b.id, model.edges) - degreeOf(a.id, model.edges);
    }).slice(0, 10);
    var html = "";
    html += "<h3>Coverage</h3>" + provBar(c) +
      "<p class='muted'>" + c.human + " human · " + c.agent + " agent · " + c.generated + " generated · " + c.structural + " structural</p>";
    html += "<h3>Orphans (" + orphans.length + ")</h3>";
    html += orphans.length ? orphans.slice(0, 20).map(function (n) {
      return "<div class='link-row' data-id='" + esc(n.id) + "' tabindex='0' role='button'>" + esc(n.label) + "</div>";
    }).join("") : "<p class='muted'>none — every note is linked</p>";
    html += "<h3>Dangling links (" + dangling.length + ")</h3>";
    html += dangling.length ? dangling.slice(0, 20).map(function (n) {
      return "<div class='link-row' data-id='" + esc(n.id) + "' tabindex='0' role='button'>" + esc(n.label) +
        " <span class='muted'>→ " + esc(n.detail["dangling links"]) + "</span></div>";
    }).join("") : "<p class='muted'>none</p>";
    html += "<h3>Hubs</h3>";
    html += hubs.map(function (n) {
      return "<div class='link-row' data-id='" + esc(n.id) + "' tabindex='0' role='button'>" + esc(n.label) +
        " <span class='muted'>" + degreeOf(n.id, model.edges) + " links</span></div>";
    }).join("");
    html += "<h3>Export</h3><button id='export'>Export snapshot (JSON)</button>";
    content.innerHTML = html;
    content.querySelectorAll(".link-row").forEach(function (row) {
      row.addEventListener("click", function () { selectById(row.getAttribute("data-id")); });
    });
    document.getElementById("export").addEventListener("click", exportSnapshot);
  }
  function exportSnapshot() {
    var data = { generatedAt: model.generatedAt, staleness: model.staleness, nodes: model.nodes, edges: model.edges };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "weave-snapshot.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("snapshot exported");
  }

  // ---------- detail ----------
  function closePanel() { panel.className = ""; }
  document.getElementById("pclose").addEventListener("click", closePanel);
  function linkRow(id) {
    var n = model.nodes.find(function (x) { return x.id === id; });
    if (!n) return "<div class='link-row muted'>" + esc(id) + "</div>";
    return "<div class='link-row' data-id='" + esc(id) + "' tabindex='0' role='button'>" +
      esc(n.label) + "<span class='row-kind'>" + esc(n.kind) + "</span></div>";
  }
  function wireLinks(container) {
    container.querySelectorAll(".link-row").forEach(function (row) {
      row.addEventListener("click", function () { selectById(row.getAttribute("data-id")); });
    });
  }
  function wireWikilinks(container) {
    container.querySelectorAll(".wikilink").forEach(function (a) {
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        var slug = a.getAttribute("data-slug");
        if (slug) openNote(slug);
      });
    });
  }
  function openNote(slug) {
    var node = model.nodes.find(function (n) { return n.detail.slug === slug; });
    if (node) selectById(node.id);
  }
  function renderBodyInto(node, container) {
    if (node.kind === "note" && node.detail.slug) {
      container.innerHTML = "<p class='muted'>loading note…</p>";
      fetch("note/" + encodeURIComponent(node.detail.slug)).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }).then(function (noteData) {
        container.innerHTML = renderMd(noteData.body || "(empty note)");
        wireWikilinks(container);
      }).catch(function () {
        container.innerHTML = "<p class='muted'>(could not load note body — it may have moved)</p>";
      });
    } else if (node.kind === "file" && node.detail.path) {
      // A derived index file (.okf/…) — fetch its real body from the viewer server.
      container.innerHTML = "<p class='muted'>loading file…</p>";
      fetch("okffile/" + encodeURIComponent(node.detail.path)).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }).then(function (fileData) {
        var pf = parseFrontMatter(fileData.body || "");
        renderOverviewMeta(pf.meta, pf.tags);
        container.innerHTML = renderMd(pf.body || "(empty file)");
        wireWikilinks(container);
      }).catch(function () {
        container.innerHTML = "<p class='muted'>(could not load file body)</p>";
      });
    } else {
      var body = node.detail.summary ? renderMd(node.detail.summary)
        : node.detail.preview ? renderMd(node.detail.preview) : "<p class='muted'>(no body)</p>";
      container.innerHTML = body;
      wireWikilinks(container);
    }
  }
  // Fill the Overview meta table (#pmeta) and tag chips (#ptags) from a
  // front-matter parse (used for both notes and derived .okf files).
  function renderOverviewMeta(meta, tags) {
    var pt = document.getElementById("ptags");
    var pm = document.getElementById("pmeta");
    if (pt) pt.innerHTML = tags.map(function (t) { return "<span class='chip'>" + esc(t) + "</span>"; }).join("");
    if (pm) pm.innerHTML = meta.map(function (p) {
      return "<div><span class='k'>" + esc(p[0]) + "</span>" + esc(p[1]) + "</div>";
    }).join("");
  }
  function renderPtab(node, tab) {
    var content = document.getElementById("pcontent");
    if (tab === "overview") {
      if (aggregate && aggregate.clusters[node.id]) {
        renderClusterDetail(node, content);
        return;
      }
      var meta = [];
      if (node.detail.slug) meta.push(["slug", node.detail.slug]);
      if (node.detail.updated) meta.push(["updated", node.detail.updated]);
      if (node.detail["dangling links"]) meta.push(["dangling links", node.detail["dangling links"]]);
      var tags = (node.detail.tags || "").split(",").map(function (t) { return t.trim(); }).filter(Boolean);
      content.innerHTML = "<div id='ptags'></div><div id='pmeta'></div><div id='pbody'></div>";
      renderOverviewMeta(meta, tags);
      renderBodyInto(node, document.getElementById("pbody"));
    } else if (tab === "links") {
      var out = [];
      model.edges.forEach(function (e) { if (e.source === node.id) out.push(e.target); });
      content.innerHTML = out.length ? out.map(function (t) { return linkRow(t); }).join("")
        : "<p class='muted'>no outgoing links</p>";
      wireLinks(content);
    } else if (tab === "backlinks") {
      var bl = deriveBacklinks(model.edges)[node.id] || [];
      content.innerHTML = bl.length ? bl.map(function (s) { return linkRow(s); }).join("")
        : "<p class='muted'>no backlinks</p>";
      wireLinks(content);
    }
  }
  // v3: a selected cluster's Overview shows the aggregate — count, provenance
  // split, and top children — instead of a single node's metadata.
  function renderClusterDetail(node, content) {
    var count = aggregate.counts[node.id] || 0;
    var info = clusterProvInfo(aggregate.provSplits[node.id]);
    var kids = (aggregate.clusters[node.id].child || []).map(function (k) {
      return model.nodes.find(function (x) { return x.id === k; });
    }).filter(Boolean);
    var top = kids.slice().sort(function (a, b) {
      return degreeOf(b.id, model.edges) - degreeOf(a.id, model.edges);
    }).slice(0, 10);
    var html = "<div class='cluster-meta'>" +
      "<div><span class='k'>cluster</span>" + count + " children</div>" +
      "<div><span class='k'>provenance</span>" +
      provBar({ human: info.human, agent: info.agent, generated: info.generated }) + "</div>" +
      "</div>";
    html += "<button id='pexpand' class='pactions'>" + (expanded[node.id] ? "Collapse cluster" : "Expand cluster") + "</button>";
    html += "<h3>Top children</h3>" +
      (top.length ? top.map(function (n) { return linkRow(n.id); }).join("") : "<p class='muted'>no children</p>");
    content.innerHTML = html;
    wireLinks(content);
    var b = document.getElementById("pexpand");
    if (b) b.addEventListener("click", function () { toggleExpand(node.id, false); });
  }
  function selectById(id) {
    selectedId = id;
    var node = model.nodes.find(function (n) { return n.id === id; });
    if (!node) return;
    panel.className = "open";
    document.getElementById("ptitle").innerHTML = esc(node.label) +
      (node.provenance ? "<span class='prov " + node.provenance + "'>" + node.provenance + "</span>" : "");
    document.getElementById("pkicker").textContent = node.kind;
    document.getElementById("pfocus").onclick = function () { focusOn(node.id); };
    var openBtn = document.getElementById("popen");
    if (node.kind === "note" && node.detail.slug) {
      openBtn.style.display = "";
      openBtn.onclick = function () {
        fetch("open/" + encodeURIComponent(node.detail.slug), { method: "POST" })
          .then(function (r) { if (r.ok) toast("opened in editor"); })
          .catch(function () { toast("could not open in editor"); });
      };
    } else {
      openBtn.style.display = "none";
    }
    document.querySelectorAll(".ptabs button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-ptab") === "overview");
    });
    renderPtab(node, "overview");
    if (surface === "graph" && listOpen) renderList();
    paint();
  }
  document.querySelectorAll(".ptabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      var node = model.nodes.find(function (n) { return n.id === selectedId; });
      if (!node) return;
      document.querySelectorAll(".ptabs button").forEach(function (x) {
        x.classList.toggle("active", x === b);
      });
      renderPtab(node, b.getAttribute("data-ptab"));
    });
  });

  // ---------- focus ----------
  function focusOn(id) {
    focusId = id;
    focusSet = focusNeighborhood(id, model.edges);
    var n = sim[id];
    if (n) {
      cam.k = Math.max(1.2, cam.k);
      cam.x = W / 2 - n.x * cam.k;
      cam.y = H / 2 - n.y * cam.k;
      camApply();
    }
    paint();
  }
  function exitFocus() {
    focusId = null; focusSet = null;
    paint();
  }

  // ---------- scene (weave-view v3: aggregation + deterministic layouts) ----------
  function loadPersisted() {
    var out = {};
    try {
      var p = persistedPositions(cwdHash, localStorage,
        model.nodes.map(function (n) { return n.id; }));
      Object.keys(p).forEach(function (id) { out[id] = { x: p[id].x, y: p[id].y }; });
    } catch (e) { /* storage unavailable */ }
    return out;
  }
  function deterministicPositions() {
    var pos;
    if (layoutMode === "cluster") pos = clusterLayout(aggregate, expanded);
    else if (layoutMode === "tree") pos = treeLayout(model.nodes, model.edges);
    else pos = radialLayout(model.nodes, function (n) { return degreeOf(n.id, model.edges); });
    var out = {};
    Object.keys(pos).forEach(function (id) { out[id] = { x: W / 2 + pos[id].x, y: H / 2 + pos[id].y }; });
    return out;
  }
  function applyPositions(pos) {
    Object.keys(pos).forEach(function (id) {
      var n = sim[id]; if (!n) return;
      n.x = pos[id].x; n.y = pos[id].y; n.vx = 0; n.vy = 0;
    });
  }
  var tweenAnim = null;
  // Layout-switch / expand-collapse tween (~250ms, cubic-bezier .2,.7,.2,1);
  // prefers-reduced-motion cuts straight to the target.
  function tweenTo(targetPos) {
    if (tweenAnim) { cancelAnimationFrame(tweenAnim); tweenAnim = null; }
    var from = {};
    Object.keys(targetPos).forEach(function (id) { var n = sim[id]; if (n) from[id] = { x: n.x, y: n.y }; });
    var reduced = false;
    try { reduced = !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { reduced = false; }
    if (reduced) { applyPositions(targetPos); paint(); return; }
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / 250);
      applyPositions(tweenPositions(from, targetPos, t));
      paint();
      if (t < 1) { tweenAnim = requestAnimationFrame(step); }
      else { applyPositions(targetPos); paint(); tweenAnim = null; }
    }
    tweenAnim = requestAnimationFrame(step);
  }
  // Cluster node sizing: log(childCount) so a big cluster reads big.
  function clusterRadius(count) { return 22 + Math.log(count + 1) * 9; }
  function clusterShape(r) {
    var n = document.createElementNS(svgNS, "rect");
    n.setAttribute("x", -r); n.setAttribute("y", -r);
    n.setAttribute("width", r * 2); n.setAttribute("height", r * 2);
    n.setAttribute("rx", r * 0.22);
    return n;
  }
  // Dominant provenance (ring) vs mixed split (mini-bar) for a cluster.
  function clusterProvInfo(split) {
    var s = split || { human: 0, agent: 0, generated: 0 };
    var mixed = (s.human > 0 ? 1 : 0) + (s.agent > 0 ? 1 : 0) + (s.generated > 0 ? 1 : 0) > 1;
    var dom = (s.human >= s.agent && s.human >= s.generated) ? "human"
      : (s.agent >= s.generated ? "agent" : "generated");
    return { mixed: mixed, dom: s.human + s.agent + s.generated > 0 ? dom : null,
      human: s.human, agent: s.agent, generated: s.generated };
  }
  function buildScene(first, prevJson) {
    aggregate = clusterAggregate(model, expanded);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    sim = {}; edgeLines = [];
    world = el("g", {});
    svg.appendChild(world);
    // Position persistence (v3): restore saved positions from localStorage
    // (per repo, keyed by cwd hash), then reuse in-session survivors; seed only
    // new ids on a deterministic phyllotaxis spiral; drop removed ids.
    var persisted = loadPersisted();
    var merged = {};
    Object.keys(persisted).forEach(function (pid) { merged[pid] = { x: persisted[pid].x, y: persisted[pid].y }; });
    Object.keys(posMap).forEach(function (pid) { merged[pid] = posMap[pid]; });
    var seeded = seedPositions(merged, model.nodes.map(function (n) { return n.id; }), W, H);
    model.nodes.forEach(function (node) {
      var was = posMap[node.id];
      var p = seeded[node.id];
      sim[node.id] = { node: node, x: p.x, y: p.y, vx: 0, vy: 0, visible: !!aggregate.visible[node.id],
        fixed: !!(was && was.fixed), deg: degreeOf(node.id, model.edges), g: null, selRing: null, labelEl: null };
    });
    var edgeLayer = el("g", {}), nodeLayer = el("g", {});
    world.appendChild(edgeLayer); world.appendChild(nodeLayer);
    // Edge declutter (v3 4.2): bundle parallel edges (same kind + pair), draw
    // containment as a thin skeleton under nodes, cross-links as dimmer accent
    // curves. Hidden leaves are pruned at paint time via sim visibility.
    var allVisible = {};
    model.nodes.forEach(function (nd) { allVisible[nd.id] = 1; });
    var bundled = bundledEdges(model.edges, allVisible);
    bundled.forEach(function (be) {
      var isLink = be.kind === "links-to";
      var line = el("line", { stroke: EDGE_COLORS[be.kind] || "#2e3a55",
        "stroke-width": isLink ? "1.4" : "1" });
      if (EDGE_DASH[be.kind]) line.setAttribute("stroke-dasharray", EDGE_DASH[be.kind]);
      edgeLayer.appendChild(line);
      // base dim: containment stays low-sat under nodes; cross-links fade unless
      // incident to the hovered/selected node (default interaction, 4.2).
      var base = isLink ? (be.count > 2 ? 0.1 : 0.12) : 0.35;
      edgeLines.push({ e: be, line: line, base: base });
    });
    model.nodes.forEach(function (node) {
      var n = sim[node.id];
      var isCluster = !!aggregate.clusters[node.id];
      var prov = node.provenance;
      var root = node.kind === "vault" || node.kind === "repository";
      var r = isCluster ? clusterRadius(aggregate.counts[node.id] || 0) : radiusFor(node, model.edges);
      var g = el("g", { "class": "node", tabindex: "0", role: "button" });
      if (isCluster) {
        var info = clusterProvInfo(aggregate.provSplits[node.id]);
        if (info.mixed) {
          var total = Math.max(1, info.human + info.agent + info.generated);
          var bar = el("g", { "class": "provbar" });
          var acc = 0;
          ["human", "agent", "generated"].forEach(function (p) {
            var w = Math.round(info[p] / total * (r * 2));
            if (w > 0) { bar.appendChild(el("rect", { x: acc, y: 0, width: w, height: 3, fill: PROV_COLOR[p] })); acc += w; }
          });
          bar.setAttribute("transform", "translate(" + (-r) + "," + (-r - 4) + ")");
          g.appendChild(bar);
        } else if (info.dom) {
          var ring = el("rect", { x: -r - 3, y: -r - 3, width: r * 2 + 6, height: r * 2 + 6, rx: r * 0.22 + 3,
            fill: "none", stroke: PROV_COLOR[info.dom], "stroke-width": "1.4" });
          g.appendChild(ring);
        }
      } else if (prov) {
        var ring = el("circle", { r: r + 2.5, fill: "none", stroke: PROV_COLOR[prov], "stroke-width": "1.4" });
        if (prov === "agent") ring.setAttribute("stroke-dasharray", "3 2");
        if (prov === "generated") ring.setAttribute("stroke-dasharray", "1 2");
        g.appendChild(ring);
      }
      var halo = el("circle", { r: r + 6, fill: "none", stroke: "var(--accent)", "stroke-width": "1", "class": "halo", opacity: "0" });
      g.appendChild(halo);
      var shape;
      if (isCluster) {
        shape = clusterShape(r);
        shape.setAttribute("fill", COLORS[node.kind] || "#6b7280");
        shape.setAttribute("fill-opacity", "0.28");
        shape.setAttribute("stroke", COLORS[node.kind] || "#6b7280");
        shape.setAttribute("stroke-width", "1.6");
        // collapsed = solid frame; expanded = dashed frame around its children.
        shape.setAttribute("stroke-dasharray", expanded[node.id] ? "5 3" : "");
      } else {
        shape = shapeEl(node.kind, r);
        shape.setAttribute("fill", COLORS[node.kind] || "#6b7280");
        shape.setAttribute("stroke", "#0b1020");
        shape.setAttribute("stroke-width", "1.2");
      }
      if (node.id === "repository" && model.staleness && model.staleness.state === "stale") {
        shape.setAttribute("stroke", "#f59e0b"); shape.setAttribute("stroke-width", "3");
      }
      g.appendChild(shape);
      if (isCluster) {
        var badge = el("text", { "class": "badge", x: r - 6, y: -r - 4 });
        badge.textContent = String(aggregate.counts[node.id] || 0);
        g.appendChild(badge);
      } else if (prov) {
        var glyph = el("text", { "class": "glyph", x: 0, y: 2.5 });
        glyph.textContent = PROV_GLYPH[prov];
        g.appendChild(glyph);
      }
      var selRing = el("circle", { r: r + 4, fill: "none", stroke: "var(--accent)", "stroke-width": "2", "class": "sel-ring" });
      selRing.style.display = "none";
      g.appendChild(selRing);
      n.selRing = selRing;
      var label = el("text", { "class": "label", x: root ? r + 5 : r + 4, y: 4 });
      label.textContent = displayLabel(node, isCluster);
      g.appendChild(label);
      n.labelEl = label;
      var moved = false;
      shape.addEventListener("pointerdown", function (ev) {
        n.fixed = true; moved = false; ev.stopPropagation(); shape.setPointerCapture(ev.pointerId);
        posMap[node.id] = { x: n.x, y: n.y, fixed: true }; // pin survives rebuilds
      });
      shape.addEventListener("pointermove", function (ev) {
        if (!n.fixed) return;
        var p = toWorld(ev);
        n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0; moved = true;
        posMap[node.id] = { x: n.x, y: n.y, fixed: true };
        if (layoutMode === "force") alpha = Math.max(alpha, .08);
        paint(); scheduleSave();
      });
      shape.addEventListener("pointerup", function (ev) {
        n.fixed = false;
        if (posMap[node.id]) posMap[node.id].fixed = false; // released pin no longer fixed
        if (!moved) {
          if (isCluster) toggleExpand(node.id, !!(ev && ev.shiftKey)); // dbl/shift = expand recursively
          selectById(node.id);
        }
        scheduleSave();
      });
      shape.addEventListener("dblclick", function () {
        if (isCluster) toggleExpand(node.id, false); else focusOn(node.id);
      });
      shape.addEventListener("pointerenter", function () {
        hoveredId = node.id;
        g.classList.add("hovered");
        if (ctl.hoverExpand && isCluster && !expanded[node.id]) toggleExpand(node.id, false);
        paint();
      });
      shape.addEventListener("pointerleave", function () {
        if (hoveredId === node.id) hoveredId = null;
        g.classList.remove("hovered");
        paint();
      });
      g.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          if (isCluster) toggleExpand(node.id, !!(ev.shiftKey));
          selectById(node.id);
        }
      });
      nodeLayer.appendChild(g);
      n.g = g;
    });
    camApply();
    if (layoutMode === "force") {
      if (first) {
        alpha = .6;
        for (var i = 0; i < 140; i++) { tick(); if (i % 20 === 19) paint(); }
        alpha = .06;
      } else {
        // delta-aware reheat (section 16 Tier A): no-op -> none, small -> gentle.
        alpha = Math.max(alpha, deltaAlpha(prevJson, lastJson));
      }
    } else {
      applyPositions(deterministicPositions()); // deterministic: no physics
      alpha = 0;
    }
    paint();
    // persist settled positions + pins so the next rebuild does not jump.
    posMap = {};
    Object.keys(sim).forEach(function (id) {
      var nn = sim[id];
      posMap[id] = { x: nn.x, y: nn.y, fixed: nn.fixed };
    });
  }

  // ---------- layout toggle (weave-view v3): cluster (default) / tree / radial / force ----------
  function toggleExpand(id, recursive) {
    if (!aggregate || !aggregate.clusters[id]) return;
    if (expanded[id]) {
      var out = collapseChildren(model, id);
      out.forEach(function (k) { delete expanded[k]; });
    } else {
      var set = expandChildren(model, id, !!recursive);
      set.forEach(function (k) { expanded[k] = 1; });
    }
    aggregate = clusterAggregate(model, expanded);
    Object.keys(sim).forEach(function (nid) { if (sim[nid]) sim[nid].visible = !!aggregate.visible[nid]; });
    if (layoutMode === "force") { alpha = Math.max(alpha, 0.5); paint(); }
    else tweenTo(deterministicPositions());
    scheduleSave();
  }
  function applyLayout() {
    if (layoutMode === "force") { alpha = Math.max(alpha, 0.5); return; } // re-simulate
    if (!aggregate) return;
    tweenTo(deterministicPositions());
    scheduleSave();
  }
  document.getElementById("layout").addEventListener("change", function () {
    layoutMode = this.value;
    applyLayout();
  });
  document.getElementById("layout-reset").addEventListener("click", function () {
    try { localStorage.removeItem(storeKey()); } catch (e) { /* ignore */ }
    posMap = {};
    expanded = {};
    layoutMode = "cluster";
    document.getElementById("layout").value = "cluster";
    buildScene(true, "");
    scheduleSave();
  });

  // ---------- position persistence (v3, decision 4): debounced localStorage ----------
  var saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 300);
  }
  function persistNow() {
    if (!sim) return;
    var data = {};
    Object.keys(sim).forEach(function (id) {
      var n = sim[id]; if (n) data[id] = { x: Math.round(n.x), y: Math.round(n.y) };
    });
    try { localStorage.setItem(storeKey(), JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  // ---------- data ----------
  function fetchGraph(first) {
    var overlay = document.getElementById("overlay");
    if (first) overlay.className = "";
    return fetch("graph.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    }).then(function (text) {
      if (text === lastJson) { overlay.className = "hidden"; return; } // identical JSON -> no reheat (polling no-op)
      var prev = lastJson;
      lastJson = text;
      model = JSON.parse(text);
      renderStatus();
      buildScene(first, prev);
      if (surface === "graph" && listOpen) renderList();
      if (surface === "health") renderHealth();
      overlay.className = "hidden";
      if (!model.nodes.length) {
        overlay.className = "";
        overlay.innerHTML = "<div class='card'><p>no notes yet — write one in pi</p></div>";
      }
    }).catch(function () {
      overlay.className = "";
      overlay.innerHTML = "<div class='card'><p>could not load the graph</p>" +
        "<button id='retry'>Retry</button></div>";
      document.getElementById("retry").addEventListener("click", function () { fetchGraph(true); });
    });
  }

  // ---------- search ----------
  searchEl.addEventListener("input", function () {
    query = searchEl.value.trim().toLowerCase();
    if (surface === "graph" && listOpen) renderList();
    paint();
  });

  // ---------- theme ----------
  var theme = "dark";
  try {
    theme = localStorage.getItem("weave-theme") ||
      (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  } catch (e) { /* storage may be unavailable */ }
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("theme").addEventListener("click", function () {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("weave-theme", theme); } catch (e) { /* ignore */ }
  });

  // ---------- help ----------
  function toggleHelp() {
    helpOpen = !helpOpen;
    document.getElementById("help").classList.toggle("hidden", !helpOpen);
  }
  document.getElementById("help-btn").addEventListener("click", toggleHelp);
  document.getElementById("help-close").addEventListener("click", function () { helpOpen = false; document.getElementById("help").classList.add("hidden"); });

  // ---------- toast ----------
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }

  // ---------- keyboard (v3 6): every control is also a key ----------
  document.addEventListener("keydown", function (ev) {
    var k = ev.key;
    if (k === "1") { layoutMode = "cluster"; setLayoutUI(); applyLayout(); }
    else if (k === "2") { layoutMode = "tree"; setLayoutUI(); applyLayout(); }
    else if (k === "3") { layoutMode = "radial"; setLayoutUI(); applyLayout(); }
    else if (k === "4") { layoutMode = "force"; setLayoutUI(); applyLayout(); }
    else if (k === "c") toggleControls();
    else if (k === "o") { toggleChip("orphans"); }
    else if (k === "i") { toggleChip("internals"); }
    else if (k === "p") cycleProvenance();
    else if (k === "f") { if (selectedId) focusOn(selectedId); }
    else if (k === "e") {
      if (selectedId && aggregate && aggregate.clusters[selectedId]) toggleExpand(selectedId, false);
      else expandAll();
    }
    else if (k === "E") expandAll();
    else if (k === "x") collapseAll();
    else if (k === "g") exitFocus();
    else if (k === "/") { ev.preventDefault(); focusSearch(); }
    else if (k === "?") toggleHelp();
    else if (k === "=" || k === "+") zoomAt(W / 2, H / 2, 1.25);
    else if (k === "-" || k === "_") zoomAt(W / 2, H / 2, 0.8);
    else if (k === " ") {
      // Space toggles the selected cluster's expand state.
      if (selectedId && aggregate && aggregate.clusters[selectedId]) {
        ev.preventDefault(); toggleExpand(selectedId, false);
      }
    }
    else if (k === "Enter") {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute("data-id")) { ev.preventDefault(); selectById(t.getAttribute("data-id")); }
    }
    else if (k === "Escape") {
      if (helpOpen) { helpOpen = false; document.getElementById("help").classList.add("hidden"); }
      else if (document.activeElement === searchEl) { searchEl.blur(); }
      else if (document.activeElement === ctlSearchEl) { ctlSearchEl.blur(); }
      else if (panel.className === "open") { closePanel(); }
      else if (focusId) { exitFocus(); }
    }
  });

  // ---------- controls panel (v3 5.2 / M4) ----------
  var controls = document.getElementById("controls");
  var ctlSearchEl = document.getElementById("ctl-search");
  var searchDrop = document.getElementById("search-drop");
  function toggleControls() {
    controlsOpen = !controlsOpen;
    document.body.classList.toggle("controls-open", controlsOpen);
    if (controlsOpen) { buildKindChips(); buildProvChips(); }
  }
  document.getElementById("controls-open").addEventListener("click", toggleControls);
  document.getElementById("controls-close").addEventListener("click", function () { if (controlsOpen) toggleControls(); });
  // Draggable panel width via the grip (v3 5.2).
  (function () {
    var grip = document.getElementById("controls-grip"), start = null;
    grip.addEventListener("pointerdown", function (ev) {
      start = { x: ev.clientX, w: controls.offsetWidth };
      grip.setPointerCapture(ev.pointerId);
    });
    grip.addEventListener("pointermove", function (ev) {
      if (!start) return;
      controls.style.width = Math.max(170, Math.min(460, start.w + (ev.clientX - start.x))) + "px";
    });
    grip.addEventListener("pointerup", function () { start = null; });
  })();
  // Layout segmented control + force sliders (reuse the 16 sim tunables).
  function setLayoutUI() {
    document.querySelectorAll("#ctl-layout button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-layout") === layoutMode);
    });
    document.getElementById("force-sliders").classList.toggle("hidden", layoutMode !== "force");
  }
  document.querySelectorAll("#ctl-layout button").forEach(function (b) {
    b.addEventListener("click", function () {
      layoutMode = b.getAttribute("data-layout");
      setLayoutUI(); applyLayout();
    });
  });
  document.getElementById("f-repel").addEventListener("input", function () {
    // repel slider tunes the repulsion scale factor.
    REPEL_K = Number(this.value) / 100;
    if (layoutMode === "force") alpha = Math.max(alpha, 0.5);
  });
  document.getElementById("f-link").addEventListener("input", function () {
    REST["links-to"] = Number(this.value); REST.contains = Number(this.value) * 0.7;
    if (layoutMode === "force") alpha = Math.max(alpha, 0.5);
  });
  document.getElementById("f-center").addEventListener("input", function () {
    CENTER_K = Number(this.value) / 100;
    if (layoutMode === "force") alpha = Math.max(alpha, 0.5);
  });
  document.getElementById("f-collide").addEventListener("input", function () {
    COLLIDE_K = Number(this.value) / 100;
    if (layoutMode === "force") alpha = Math.max(alpha, 0.5);
  });
  // ---- filter chips ----
  function buildKindChips() {
    var kinds = [];
    model.nodes.forEach(function (n) { if (kinds.indexOf(n.kind) < 0) kinds.push(n.kind); });
    var box = document.getElementById("kind-chips");
    box.innerHTML = "";
    kinds.sort().forEach(function (kd) {
      var c = document.createElement("button");
      c.className = "chip" + (ctl.kinds[kd] ? " active" : "");
      c.textContent = kd;
      c.setAttribute("data-kind", kd);
      c.addEventListener("click", function () { toggleChip("kinds", kd); });
      box.appendChild(c);
    });
  }
  function buildProvChips() {
    var box = document.getElementById("prov-chips");
    box.innerHTML = "";
    ["human", "agent", "generated"].forEach(function (p) {
      var c = document.createElement("button");
      c.className = "chip" + (ctl.provenance[p] ? " active" : "");
      c.textContent = p;
      c.setAttribute("data-prov", p);
      c.addEventListener("click", function () { toggleChip("provenance", p); });
      box.appendChild(c);
    });
  }
  function toggleChip(which, key) {
    if (which === "orphans") { ctl.orphans = !ctl.orphans; }
    else if (which === "internals") { ctl.hideInternals = !ctl.hideInternals; }
    else if (which === "kinds" || which === "provenance") {
      var set = which === "kinds" ? ctl.kinds : ctl.provenance;
      if (set[key]) delete set[key]; else set[key] = 1;
    }
    applyFilters();
  }
  function cycleProvenance() {
    var order = ["human", "agent", "generated"], cur = Object.keys(ctl.provenance);
    ctl.provenance = {};
    var next = cur.length ? order[(order.indexOf(cur[0]) + 1) % order.length] : order[0];
    if (next) ctl.provenance[next] = 1;
    buildProvChips(); applyFilters();
  }
  function applyFilters() {
    if (!model) return;
    var backlinks = deriveBacklinks(model.edges);
    var opts = { kinds: ctl.kinds, provenance: ctl.provenance, orphans: ctl.orphans,
      hideInternals: ctl.hideInternals, recentDays: ctl.recentDays, backlinks: backlinks };
    matchSet = {}; ancSet = {};
    model.nodes.forEach(function (n) {
      if (nodeMatchesFilter(n, opts)) matchSet[n.id] = 1;
    });
    if (filterActive()) {
      ancestorClusters(model, matchSet).forEach(function (c) { ancSet[c] = 1; expanded[c] = 1; });
    }
    applyDepth();
    reflow();
    if (surface === "graph") renderList();
  }
  function applyDepth() {
    if (!ctl.depthLimit || !aggregate) return;
    var depths = clusterDepths(model);
    Object.keys(depths).forEach(function (id) {
      if (depths[id] >= ctl.depthLimit) delete expanded[id];
    });
  }
  function expandAll() {
    if (!aggregate) return;
    Object.keys(aggregate.clusters).forEach(function (id) { expanded[id] = 1; });
    reflow();
  }
  function collapseAll() {
    if (!aggregate) return;
    expanded = {};
    reflow();
  }
  function reflow() {
    if (!model || !aggregate) return;
    aggregate = clusterAggregate(model, expanded);
    Object.keys(sim).forEach(function (id) { if (sim[id]) sim[id].visible = !!aggregate.visible[id]; });
    if (layoutMode === "force") { alpha = Math.max(alpha, 0.5); paint(); }
    else tweenTo(deterministicPositions());
    scheduleSave();
  }
  document.getElementById("ctl-expand-all").addEventListener("click", expandAll);
  document.getElementById("ctl-collapse-all").addEventListener("click", collapseAll);
  document.getElementById("ctl-hover").addEventListener("change", function (e) {
    ctl.hoverExpand = !!e.target.checked;
  });
  document.getElementById("ctl-depth").addEventListener("input", function (e) {
    ctl.depthLimit = Number(e.target.value) || 0;
    applyFilters();
  });
  document.getElementById("ctl-orphans").addEventListener("change", function (e) {
    ctl.orphans = !!e.target.checked; applyFilters();
  });
  document.getElementById("ctl-internals").addEventListener("change", function (e) {
    ctl.hideInternals = !!e.target.checked; applyFilters();
  });
  document.getElementById("ctl-dim").addEventListener("change", function (e) {
    ctl.dimFiltered = !!e.target.checked; reflow();
  });
  document.getElementById("ctl-recent").addEventListener("change", function (e) {
    ctl.recentDays = Number(e.target.value) || 0; applyFilters();
  });
  // ---- scored search dropdown (v3 5.2) ----
  function focusSearch() {
    if (!controlsOpen) toggleControls();
    ctlSearchEl.focus();
  }
  ctlSearchEl.addEventListener("input", function () {
    runSearch(ctlSearchEl.value);
  });
  function runSearch(q) {
    if (!model) { searchDrop.innerHTML = ""; return; }
    var hits = scoredSearch(model.nodes, q);
    searchDrop.innerHTML = hits.length ? "" : "<div class='row muted'>no matches</div>";
    hits.slice(0, 8).forEach(function (h) {
      var row = document.createElement("div");
      row.className = "row"; row.setAttribute("data-id", h.id); row.setAttribute("tabindex", "0");
      row.setAttribute("role", "button");
      row.innerHTML = esc(h.label);
      searchDrop.appendChild(row);
    });
    // highlight matching nodes + auto-expand ancestor clusters.
    if (q) {
      var m = {}; hits.forEach(function (h) { m[h.id] = 1; });
      ancestorClusters(model, m).forEach(function (c) { expanded[c] = 1; });
      reflow();
    }
  }
  document.getElementById("search-drop").addEventListener("click", function (ev) {
    var t = ev.target;
    if (t && t.getAttribute && t.getAttribute("data-id")) selectById(t.getAttribute("data-id"));
  });
  // ---- auto-expand on hover (v3 aggregation toggle) ----
  // clusterDepths maps every node to its depth from the containment roots.
  function clusterDepths(model) {
    var children = {}, incoming = {};
    model.edges.forEach(function (e) {
      if (e.kind !== "contains" && e.kind !== "anchored-at") return;
      (children[e.source] = children[e.source] || []).push(e.target);
      incoming[e.target] = 1;
    });
    var depths = {};
    function walk(id, d) {
      if (depths[id] !== undefined) return;
      depths[id] = d;
      (children[id] || []).forEach(function (c) { walk(c, d + 1); });
    }
    model.nodes.forEach(function (n) { if (!incoming[n.id]) walk(n.id, 0); });
    return depths;
  }

  // ---------- legend (collapsible; hidden by default so it stays out of the face) ----------
  var legend = document.getElementById("legend");
  var L = [["vault", "vault root"], ["note", "vault note"], ["repository", "repository"],
    ["module", "module"], ["file", "okf file"], ["package", "package"], ["entryPoint", "entry point"],
    ["gitState", "git anchor"], ["external", "remote"]];
  var legendBody = L.map(function (p) {
    return "<div class='row'><span class='dot' style='background:" + COLORS[p[0]] + "'></span>" + p[1] + "</div>";
  }).join("") +
    "<div class='row'><span class='ring human'></span>human</div>" +
    "<div class='row'><span class='ring agent'></span>agent</div>" +
    "<div class='row'><span class='ring generated'></span>generated</div>" +
    "<div class='row'>scroll=zoom · drag=pan · dblclick=focus</div>";
  legend.innerHTML = "<button id='legend-toggle' class='legend-head' aria-expanded='false'><span class='caret'>▾</span>legend</button>" +
    "<div class='legend-body'>" + legendBody + "</div>";
  document.getElementById("legend-toggle").addEventListener("click", function () {
    var collapsed = legend.classList.toggle("collapsed");
    document.getElementById("legend-toggle").setAttribute("aria-expanded", String(!collapsed));
  });

  // ---------- init ----------
  expanded = {}; // weave-view v3 decision 1: clusters-only first paint
  fetchGraph(true);
  setInterval(function () { fetchGraph(false).catch(function () {}); }, 5000);
  loop();
})();
</script>
</body>
</html>
`;
