/**
 * The weave-view page (v2): a single self-contained HTML string — inline
 * CSS+JS, zero external resources (docs/weave-view.md §5, docs/weave-view-v2.md).
 *
 * v2 pillars: provenance is the hero (ring style + glyph + filter, never
 * color alone); three surfaces over one model (Graph / List / Detail);
 * overview-first status strip; explicit focus mode (1-hop, visibility-only).
 *
 * NOTE for contributors: the rendered page must contain NO backtick and NO
 * `${` — the page is a TS template literal, and a CI guard asserts the
 * rendered output stays clean. Regex backslashes are `\\`-escaped; backtick
 * matching uses the `\x60` hex escape so no literal backtick reaches output.
 */

export function renderPage(): string {
  return PAGE;
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
  g.node { cursor: pointer; }
  g.node .shape { transition: transform 120ms ease; }
  g.node.hovered .shape { transform: scale(1.06); }
  g.node.hovered .halo { opacity: .15; }
  g.node .halo { transition: opacity 120ms ease; }
  .dim { opacity: .14; }

  /* ---------- surfaces ---------- */
  .surface { position: fixed; top: 48px; bottom: 0; overflow-y: auto; background: var(--bg); }
  #list { left: 0; width: 340px; border-right: 1px solid var(--line); display: none; padding: 12px; }
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

  /* ---------- legend ---------- */
  #legend { position: fixed; left: 10px; bottom: 10px; background: var(--surface);
            border: 1px solid var(--line); border-radius: 9px; padding: 9px 12px; z-index: 8;
            font-size: 11px; color: var(--muted); }
  #legend .row { display: flex; align-items: center; gap: 7px; margin: 2px 0; }
  #legend .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  #legend .ring { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  #legend .ring.human { border: 2px solid var(--ok); }
  #legend .ring.agent { border: 2px dashed var(--accent); }
  #legend .ring.generated { border: 2px dotted var(--faint); }

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
<body>
<header>
  <h1>pi-weave <span>knowledge view</span></h1>
  <nav class="tabs" aria-label="surface">
    <button data-surface="graph" class="tab active">Graph</button>
    <button data-surface="list" class="tab">List</button>
    <button data-surface="health" class="tab">Health</button>
  </nav>
  <input id="search" placeholder="search…" aria-label="search">
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
<div id="legend"></div>
<div id="help" class="hidden">
  <div class="card">
    <h2>Shortcuts</h2>
    <table>
      <tr><td>1 / 2 / 3</td><td>Graph / List / Health</td></tr>
      <tr><td>f</td><td>Focus selected node</td></tr>
      <tr><td>g</td><td>Exit focus</td></tr>
      <tr><td>/</td><td>Focus search</td></tr>
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
  // ===== end pure =====

  var COLORS = { vault: "#8b5cf6", note: "#c4b5fd", repository: "#3b82f6",
    module: "#22c55e", "package": "#14b8a6", entryPoint: "#a3e635",
    gitState: "#facc15", external: "#fb923c" };
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
  var sim = {}, collapsed = {}, alpha = 0;
  var W = window.innerWidth, H = window.innerHeight, world = null;
  var cam = { x: 0, y: 0, k: 1 };
  var panning = null, helpOpen = false;

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
  function hiddenSet() {
    var hidden = {};
    function bury(id) {
      childrenOf(id).forEach(function (c) {
        if (!hidden[c]) { hidden[c] = 1; bury(c); }
      });
    }
    Object.keys(collapsed).forEach(bury);
    return hidden;
  }

  // ---------- force layout (calm: capped forces, warm-up before paint) ----------
  function tick() {
    var ids = Object.keys(sim).filter(function (id) { return sim[id].visible; });
    var i, j, a, b, dx, dy, d2, d, f;
    for (i = 0; i < ids.length; i++) {
      a = sim[ids[i]];
      for (j = i + 1; j < ids.length; j++) {
        b = sim[ids[j]];
        dx = a.x - b.x; dy = a.y - b.y;
        d2 = dx * dx + dy * dy;
        if (d2 > 67600) continue; // 260px repulsion cutoff
        if (d2 < 400) { dx = (i - j) * 1.3 + 0.2; dy = 0.6; d2 = dx * dx + dy * dy; }
        d = Math.sqrt(d2);
        f = 380 * alpha / d2;
        a.vx += dx * f / d; a.vy += dy * f / d;
        b.vx -= dx * f / d; b.vy -= dy * f / d;
      }
      a.vx += (W / 2 - a.x) * 0.006 * alpha;
      a.vy += (H / 2 - a.y) * 0.006 * alpha;
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
    ids.forEach(function (id) {
      var n = sim[id];
      if (n.fixed) return;
      var sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > 14) { n.vx = n.vx * 14 / sp; n.vy = n.vy * 14 / sp; } // speed cap
      n.vx *= .82; n.vy *= .82;
      n.x += n.vx; n.y += n.vy;
    });
    var touched = false;
    for (i = 0; i < ids.length; i++) {
      for (j = i + 1; j < ids.length; j++) {
        a = sim[ids[i]]; b = sim[ids[j]];
        dx = b.x - a.x; dy = b.y - a.y;
        var gap2 = dx * dx + dy * dy;
        if (gap2 > 484) continue; // 22px minimum separation
        var gap = Math.sqrt(gap2) || 0.01;
        var push = (22 - gap) / 2;
        touched = true;
        if (!a.fixed) { a.x -= dx / gap * push; a.y -= dy / gap * push; }
        if (!b.fixed) { b.x += dx / gap * push; b.y += dy / gap * push; }
      }
    }
    ids.forEach(function (id) {
      var n = sim[id];
      n.x = Math.max(20, Math.min(W - 20, n.x));
      n.y = Math.max(60, Math.min(H - 20, n.y));
    });
    if (touched) alpha = Math.max(alpha, 0.008);
    alpha *= 0.995;
  }

  var edgeLines = [];
  function paint() {
    var hidden = hiddenSet();
    Object.keys(sim).forEach(function (id) {
      var n = sim[id];
      n.visible = !hidden[id];
      n.g.style.display = n.visible ? "" : "none";
      if (n.visible) {
        var dimmed = (query.length > 0 && n.node.label.toLowerCase().indexOf(query) < 0) ||
          (focusSet && !focusSet[id]);
        n.g.setAttribute("class", dimmed ? "node dim" : "node");
        n.g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
        if (n.selRing) n.selRing.style.display = selectedId === id ? "" : "none";
      }
    });
    edgeLines.forEach(function (rec) {
      var s = sim[rec.e.source], t = sim[rec.e.target];
      var vis = s && t && s.visible && t.visible;
      rec.line.style.display = vis ? "" : "none";
      if (vis) {
        rec.line.setAttribute("x1", s.x); rec.line.setAttribute("y1", s.y);
        rec.line.setAttribute("x2", t.x); rec.line.setAttribute("y2", t.y);
        var inFocus = !focusSet || (focusSet[rec.e.source] && focusSet[rec.e.target]);
        rec.line.setAttribute("opacity", inFocus ? "1" : "0.12");
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
  function showSurface(s) {
    surface = s;
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-surface") === s);
    });
    svg.style.display = s === "graph" ? "block" : "none";
    document.getElementById("list").style.display = s === "list" ? "block" : "none";
    document.getElementById("health").style.display = s === "health" ? "block" : "none";
    if (s === "list") renderList();
    if (s === "health") renderHealth();
  }
  document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () { showSurface(b.getAttribute("data-surface")); });
  });

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

  // ---------- list ----------
  function listRows() {
    var rows = model.nodes.map(function (n) {
      return { id: n.id, label: n.label, kind: n.kind, provenance: n.provenance || "",
        updated: n.detail.updated || "", links: degreeOf(n.id, model.edges) };
    });
    var filtered = applyFilter(rows, kindFilter || null, provFilter || null);
    if (recentDays) {
      var cutoff = Date.now() - recentDays * 86400000;
      filtered = filtered.filter(function (r) { return r.updated && new Date(r.updated).getTime() >= cutoff; });
    }
    if (query) {
      filtered = filtered.filter(function (r) { return r.label.toLowerCase().indexOf(query) >= 0; });
    }
    return sortRows(filtered, listSort);
  }
  function renderList() {
    var container = document.getElementById("list-rows");
    var rows = listRows();
    var shown = rows.slice(0, listLimit);
    var html = "";
    shown.forEach(function (r) {
      html += "<div class='row" + (selectedId === r.id ? " selected" : "") + "' data-id='" + esc(r.id) + "' tabindex='0' role='button'>" +
        "<span class='row-label'>" + esc(r.label) + "</span>" +
        "<span class='row-kind'>" + esc(r.kind) + "</span>" +
        (r.provenance ? "<span class='prov " + esc(r.provenance) + "'>" + esc(r.provenance) + "</span>" : "") +
        "<span class='row-meta'>" + (r.updated ? relTime(r.updated, Date.now()) : "") + " · " + r.links + "</span>" +
        "</div>";
    });
    container.innerHTML = html;
    document.getElementById("show-more").style.display = rows.length > listLimit ? "" : "none";
    container.querySelectorAll(".row").forEach(function (row) {
      row.addEventListener("click", function () { selectById(row.getAttribute("data-id")); });
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
    } else {
      var body = node.detail.summary ? renderMd(node.detail.summary)
        : node.detail.preview ? renderMd(node.detail.preview) : "<p class='muted'>(no body)</p>";
      container.innerHTML = body;
      wireWikilinks(container);
    }
  }
  function renderPtab(node, tab) {
    var content = document.getElementById("pcontent");
    if (tab === "overview") {
      var meta = [];
      if (node.detail.slug) meta.push(["slug", node.detail.slug]);
      if (node.detail.updated) meta.push(["updated", node.detail.updated]);
      if (node.detail["dangling links"]) meta.push(["dangling links", node.detail["dangling links"]]);
      var tags = node.detail.tags || "";
      var tagHtml = tags.split(",").map(function (t) { return t.trim(); }).filter(Boolean)
        .map(function (t) { return "<span class='chip'>" + esc(t) + "</span>"; }).join("");
      var metaHtml = meta.map(function (p) {
        return "<div><span class='k'>" + esc(p[0]) + "</span>" + esc(p[1]) + "</div>";
      }).join("");
      content.innerHTML = "<div id='ptags'>" + tagHtml + "</div><div id='pmeta'>" + metaHtml + "</div><div id='pbody'></div>";
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
    if (surface === "list") renderList();
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

  // ---------- scene ----------
  function buildScene(first) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    sim = {}; edgeLines = [];
    world = el("g", {});
    svg.appendChild(world);
    model.nodes.forEach(function (node, idx) {
      var angle = idx * 2.399963;
      sim[node.id] = { node: node, x: W / 2 + Math.cos(angle) * (24 + idx * 4), y: H / 2 + Math.sin(angle) * (24 + idx * 4),
        vx: 0, vy: 0, visible: true, fixed: false, g: null, selRing: null };
    });
    var edgeLayer = el("g", {}), nodeLayer = el("g", {});
    world.appendChild(edgeLayer); world.appendChild(nodeLayer);
    model.edges.forEach(function (e) {
      if (!sim[e.source] || !sim[e.target]) return;
      var line = el("line", { stroke: EDGE_COLORS[e.kind] || "#2e3a55", "stroke-width": "1.2" });
      if (EDGE_DASH[e.kind]) line.setAttribute("stroke-dasharray", EDGE_DASH[e.kind]);
      edgeLayer.appendChild(line);
      edgeLines.push({ e: e, line: line });
    });
    model.nodes.forEach(function (node) {
      var n = sim[node.id];
      var prov = node.provenance;
      var root = node.kind === "vault" || node.kind === "repository";
      var r = radiusFor(node, model.edges);
      var g = el("g", { "class": "node", tabindex: "0", role: "button" });
      if (prov) {
        var ring = el("circle", { r: r + 2.5, fill: "none", stroke: PROV_COLOR[prov], "stroke-width": "1.4" });
        if (prov === "agent") ring.setAttribute("stroke-dasharray", "3 2");
        if (prov === "generated") ring.setAttribute("stroke-dasharray", "1 2");
        g.appendChild(ring);
      }
      var halo = el("circle", { r: r + 6, fill: "none", stroke: "var(--accent)", "stroke-width": "1", "class": "halo", opacity: "0" });
      g.appendChild(halo);
      var shape = shapeEl(node.kind, r);
      shape.setAttribute("fill", COLORS[node.kind] || "#6b7280");
      shape.setAttribute("stroke", "#0b1020");
      shape.setAttribute("stroke-width", "1.2");
      if (node.id === "repository" && model.staleness && model.staleness.state === "stale") {
        shape.setAttribute("stroke", "#f59e0b"); shape.setAttribute("stroke-width", "3");
      }
      g.appendChild(shape);
      if (prov) {
        var glyph = el("text", { "class": "glyph", x: 0, y: 2.5 });
        glyph.textContent = PROV_GLYPH[prov];
        g.appendChild(glyph);
      }
      var selRing = el("circle", { r: r + 4, fill: "none", stroke: "var(--accent)", "stroke-width": "2", "class": "sel-ring" });
      selRing.style.display = "none";
      g.appendChild(selRing);
      n.selRing = selRing;
      var hasKids = childrenOf(node.id).length > 0;
      var label = el("text", { "class": "label", x: root ? r + 5 : r + 4, y: 4 });
      label.textContent = capLabel(node.label) + (hasKids ? (collapsed[node.id] ? "  ▸" : "  ▾") : "");
      if (node.id === "repository" && model.staleness && model.staleness.state === "stale") {
        label.textContent = "⚠ " + label.textContent;
      }
      g.appendChild(label);
      var moved = false;
      shape.addEventListener("pointerdown", function (ev) {
        n.fixed = true; moved = false; ev.stopPropagation(); shape.setPointerCapture(ev.pointerId);
      });
      shape.addEventListener("pointermove", function (ev) {
        if (!n.fixed) return;
        var p = toWorld(ev);
        n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0; moved = true;
        alpha = Math.max(alpha, .08); paint();
      });
      shape.addEventListener("pointerup", function () {
        n.fixed = false;
        if (!moved) {
          if (hasKids) {
            if (collapsed[node.id]) delete collapsed[node.id]; else collapsed[node.id] = 1;
            alpha = Math.max(alpha, .35);
            paint();
          }
          selectById(node.id);
        }
      });
      shape.addEventListener("dblclick", function () { focusOn(node.id); });
      shape.addEventListener("pointerenter", function () {
        g.classList.add("hovered");
        edgeLines.forEach(function (rec) {
          if (rec.e.source === node.id || rec.e.target === node.id) {
            rec.line.setAttribute("stroke-width", "1.8");
            rec.line.setAttribute("opacity", "1");
          }
        });
      });
      shape.addEventListener("pointerleave", function () {
        g.classList.remove("hovered");
        paint();
      });
      g.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectById(node.id); }
      });
      nodeLayer.appendChild(g);
      n.g = g;
    });
    camApply();
    paint();
    alpha = .6;
    if (first) {
      for (var i = 0; i < 140; i++) {
        tick();
        if (i % 20 === 19) paint();
      }
      alpha = .06;
      paint();
    } else {
      alpha = .22;
    }
  }

  // ---------- data ----------
  function fetchGraph(first) {
    var overlay = document.getElementById("overlay");
    if (first) overlay.className = "";
    return fetch("graph.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    }).then(function (text) {
      if (text === lastJson) { overlay.className = "hidden"; return; }
      lastJson = text;
      model = JSON.parse(text);
      renderStatus();
      buildScene(first);
      if (surface === "list") renderList();
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
    if (surface === "list") renderList();
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

  // ---------- keyboard ----------
  document.addEventListener("keydown", function (ev) {
    var k = ev.key;
    if (k === "1") showSurface("graph");
    else if (k === "2") showSurface("list");
    else if (k === "3") showSurface("health");
    else if (k === "f") { if (selectedId) focusOn(selectedId); }
    else if (k === "g") exitFocus();
    else if (k === "/") { ev.preventDefault(); searchEl.focus(); }
    else if (k === "?") toggleHelp();
    else if (k === "=" || k === "+") zoomAt(W / 2, H / 2, 1.25);
    else if (k === "-" || k === "_") zoomAt(W / 2, H / 2, 0.8);
    else if (k === "Enter" || k === " ") {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute("data-id")) { ev.preventDefault(); selectById(t.getAttribute("data-id")); }
    }
    else if (k === "ArrowDown" || k === "ArrowUp") {
      if (surface === "list") {
        ev.preventDefault();
        var rows = document.querySelectorAll("#list-rows .row");
        var idx = Array.prototype.indexOf.call(rows, document.activeElement);
        var next = k === "ArrowDown" ? idx + 1 : idx - 1;
        if (next >= 0 && next < rows.length) rows[next].focus();
      }
    }
    else if (k === "Escape") {
      if (helpOpen) { helpOpen = false; document.getElementById("help").classList.add("hidden"); }
      else if (document.activeElement === searchEl) { searchEl.blur(); }
      else if (panel.className === "open") { closePanel(); }
      else if (focusId) { exitFocus(); }
    }
  });

  // ---------- legend ----------
  var legend = document.getElementById("legend");
  var L = [["vault", "vault root"], ["note", "vault note"], ["repository", "repository"],
    ["module", "module"], ["package", "package"], ["entryPoint", "entry point"],
    ["gitState", "git anchor"], ["external", "remote"]];
  legend.innerHTML = L.map(function (p) {
    return "<div class='row'><span class='dot' style='background:" + COLORS[p[0]] + "'></span>" + p[1] + "</div>";
  }).join("") +
    "<div class='row'><span class='ring human'></span>human</div>" +
    "<div class='row'><span class='ring agent'></span>agent</div>" +
    "<div class='row'><span class='ring generated'></span>generated</div>" +
    "<div class='row'>scroll=zoom · drag=pan · dblclick=focus</div>";

  // ---------- init ----------
  collapsed = { vault: 1, repository: 1 };
  fetchGraph(true);
  setInterval(function () { fetchGraph(false).catch(function () {}); }, 5000);
  loop();
})();
</script>
</body>
</html>
`;
