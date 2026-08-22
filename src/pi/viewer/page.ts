/**
 * The weave-view page: a single self-contained HTML string — inline CSS+JS,
 * zero external resources (docs/weave-view.md §5). Hand-rolled force layout
 * with pre-simulated warm-up (calm first paint), wheel zoom + pan, and a
 * mini markdown renderer for note bodies.
 *
 * NOTE for contributors: this file must not contain backticks or template
 * substitutions inside the page script — the page is a TS template literal.
 */

export function renderPage(): string {
  return PAGE;
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi-weave · knowledge view</title>
<style>
  :root {
    --bg: #0b1020; --panel: #131a2e; --line: #26324d; --text: #e8ecf6;
    --muted: #93a0bd; --accent: #a78bfa; --note: #c4b5fd;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--text); overflow: hidden; }
  header { position: fixed; inset: 0 0 auto 0; padding: 9px 14px; display: flex; gap: 10px;
           align-items: center; background: rgba(13,18,34,.94); border-bottom: 1px solid var(--line);
           z-index: 10; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  header h1 span { color: var(--accent); }
  #search { background: #0d1424; border: 1px solid var(--line); color: var(--text);
            border-radius: 7px; padding: 5px 10px; width: 240px; }
  #search:focus { outline: none; border-color: var(--accent); }
  button { background: #0d1424; color: var(--text); border: 1px solid var(--line);
           border-radius: 7px; padding: 4px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .zoomgrp button { width: 30px; }
  #stamp { color: var(--muted); font-size: 11px; margin-left: auto; }
  #stale { display: none; background: #78350f; color: #fde68a; padding: 3px 9px;
           border-radius: 7px; font-size: 11px; max-width: 46ch; overflow: hidden;
           text-overflow: ellipsis; white-space: nowrap; }
  #graph { display: block; width: 100vw; height: 100vh; touch-action: none; }
  .dim { opacity: .14; }
  text.label { fill: var(--text); font-size: 11.5px; pointer-events: none;
               paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; }
  circle { cursor: pointer; }
  g.node-hovered circle { filter: brightness(1.35); }

  #panel { position: fixed; top: 48px; right: 0; bottom: 0; width: 400px; overflow-y: auto;
           background: var(--panel); border-left: 1px solid var(--line); padding: 20px 22px 40px;
           transform: translateX(100%); transition: transform .18s ease; z-index: 9; }
  #panel.open { transform: translateX(0); }
  #pclose { position: absolute; top: 12px; right: 12px; width: 26px; height: 26px;
            border-radius: 50%; padding: 0; color: var(--muted); }
  #panel h2 { font-size: 17px; margin: 0 30px 4px 0; line-height: 1.3; }
  #pkicker { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
             margin-bottom: 12px; }
  #ptags { margin: 0 0 10px; }
  .chip { display: inline-block; background: #233052; color: var(--note); border-radius: 999px;
          padding: 1px 9px; font-size: 11px; margin: 0 5px 5px 0; }
  #pmeta { border-top: 1px solid var(--line); margin: 4px 0 14px; padding-top: 10px;
           font-size: 12px; }
  #pmeta .k { color: var(--muted); display: inline-block; min-width: 88px; }
  #pbody { font-size: 13.5px; }
  #pbody h1, #pbody h2, #pbody h3, #pbody h4 { margin: .9em 0 .35em; line-height: 1.3; }
  #pbody p { margin: .5em 0; }
  #pbody ul { margin: .4em 0; padding-left: 22px; }
  #pbody li { margin: .15em 0; }
  #pbody code { background: #0d1424; border: 1px solid var(--line); border-radius: 4px;
                padding: 1px 4px; font-size: 12px; }
  #pbody pre { background: #0d1424; border: 1px solid var(--line); border-radius: 8px;
               padding: 10px 12px; overflow-x: auto; }
  #pbody pre code { background: none; border: none; padding: 0; }
  #pbody blockquote { border-left: 3px solid var(--line); margin: .6em 0; padding-left: 12px;
                      color: var(--muted); }
  #pbody a { color: #7dd3fc; }
  .wikilink { color: var(--accent); border-bottom: 1px dashed var(--accent); }
  .prov { font-size: 11px; border-radius: 999px; padding: 1px 8px; margin-left: 7px; }
  .prov.human { background: #14532d; color: #bbf7d0; }
  .prov.agent { background: #3b0764; color: #e9d5ff; }
  .prov.generated { background: #1f2937; color: #9ca3af; }

  #legend { position: fixed; left: 10px; bottom: 10px; background: rgba(13,18,34,.94);
            border: 1px solid var(--line); border-radius: 9px; padding: 9px 12px; z-index: 8;
            font-size: 11px; color: var(--muted); }
  #legend .row { display: flex; align-items: center; gap: 7px; margin: 2px 0; }
  #legend .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
</style>
</head>
<body>
<header>
  <h1>pi-weave <span>knowledge view</span></h1>
  <input id="search" placeholder="search labels…" aria-label="search">
  <button id="refresh" type="button">Refresh</button>
  <span class="zoomgrp">
    <button id="zoom-in" title="Zoom in">+</button><button id="zoom-out" title="Zoom out">−</button><button id="zoom-reset" title="Reset view">⌂</button>
  </span>
  <span id="stale"></span>
  <span id="stamp"></span>
</header>
<svg id="graph"></svg>
<aside id="panel">
  <button id="pclose" title="Close (Esc)">✕</button>
  <h2 id="ptitle"></h2>
  <div id="pkicker"></div>
  <div id="ptags"></div>
  <div id="pmeta"></div>
  <div id="pbody"></div>
</aside>
<div id="legend"></div>
<script>
(function () {
  "use strict";
  var COLORS = { vault: "#8b5cf6", note: "#c4b5fd", repository: "#3b82f6",
    module: "#22c55e", "package": "#059669", entryPoint: "#a3e635",
    gitState: "#facc15", external: "#fb923c" };
  var EDGE_COLORS = { contains: "#2e3a55", "anchored-at": "#a16207", "links-to": "#7c3aed", mentions: "#525252" };
  var EDGE_DASH = { "links-to": "4 3", "mentions": "2 3" };
  var REST = { contains: 105, "anchored-at": 130, "links-to": 160, mentions: 160 };
  var PROV_STYLE = { human: { dash: null, op: 1 }, agent: { dash: "3 2", op: 1 }, generated: { dash: null, op: .5 } };
  var svgNS = "http://www.w3.org/2000/svg";
  var svg = document.getElementById("graph");
  var panel = document.getElementById("panel");
  var searchEl = document.getElementById("search");
  var model = null, lastJson = "";
  var sim = {}, collapsed = {}, query = "", alpha = 0;
  var W = window.innerWidth, H = window.innerHeight, world = null;
  var cam = { x: 0, y: 0, k: 1 };
  var panning = null;

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
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function capLabel(s) { return s.length > 30 ? s.slice(0, 29) + "…" : s; }

  // ---------- mini markdown (escapes HTML itself: output is always safe) ----------
  function mdInline(t) {
    t = t.replace(/\\[\\[([^\\[\\]|]+)(?:\\|([^\\]\\[]*))?\\]\\]/g, function (m, slug, al) {
      return "<span class=\\"wikilink\\">" + (al || slug) + "</span>";
    });
    t = t.replace(/\\\`([^\\\`]+)\\\`/g, "<code>$1</code>");
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
      if (/^\\s*\\\`\\\`\\\`/.test(line)) {
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
      // note: ">" was escaped to "&gt;" by esc() before parsing
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
    // Minimum-distance relaxation: position correction, alpha-independent,
    // so two nodes can never end up stacked under each other regardless of
    // how cool the sim is.
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
    if (touched) alpha = Math.max(alpha, 0.008); // keep the loop alive until separated
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
        var dimmed = query.length > 0 && (n.node.label.toLowerCase().indexOf(query) < 0);
        n.g.setAttribute("class", dimmed ? "dim" : "");
        n.g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
      }
    });
    edgeLines.forEach(function (rec) {
      var s = sim[rec.e.source], t = sim[rec.e.target];
      var vis = s && t && s.visible && t.visible;
      rec.line.style.display = vis ? "" : "none";
      if (vis) {
        rec.line.setAttribute("x1", s.x); rec.line.setAttribute("y1", s.y);
        rec.line.setAttribute("x2", t.x); rec.line.setAttribute("y2", t.y);
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

  // ---------- side panel ----------
  function closePanel() { panel.className = ""; }
  document.getElementById("pclose").addEventListener("click", closePanel);
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") closePanel(); });

  function setMeta(pairs) {
    var html = "";
    pairs.forEach(function (p) {
      if (p[1] !== undefined && p[1] !== "") html += "<div><span class='k'>" + esc(p[0]) + "</span>" + esc(p[1]) + "</div>";
    });
    document.getElementById("pmeta").innerHTML = html;
  }
  function select(n) {
    panel.className = "open";
    var node = n.node;
    document.getElementById("ptitle").innerHTML = esc(node.label) +
      (node.provenance ? "<span class='prov " + node.provenance + "'>" + node.provenance + "</span>" : "");
    document.getElementById("pkicker").textContent = node.kind;
    var tags = node.detail.tags || "";
    document.getElementById("ptags").innerHTML = tags.split(",").map(function (t) { return t.trim(); })
      .filter(Boolean).map(function (t) { return "<span class='chip'>" + esc(t) + "</span>"; }).join("");
    var bodyEl = document.getElementById("pbody");
    if (node.kind === "note" && node.detail.slug) {
      setMeta([["slug", node.detail.slug], ["updated", node.detail.updated],
        ["dangling links", node.detail["dangling links"]]]);
      bodyEl.innerHTML = "<p style='color:var(--muted)'>loading note…</p>";
      fetch("note/" + encodeURIComponent(node.detail.slug)).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }).then(function (noteData) {
        bodyEl.innerHTML = renderMd(noteData.body || "(empty note)");
      }).catch(function () {
        bodyEl.innerHTML = "<p style='color:var(--muted)'>(could not load note body — it may have moved)</p>";
      });
    } else {
      var skip = { tags: 1, preview: 1 };
      setMeta(Object.keys(node.detail).filter(function (k) { return !skip[k]; }).map(function (k) { return [k, node.detail[k]]; }));
      bodyEl.innerHTML = node.detail.preview ? renderMd(node.detail.preview) : "";
    }
  }

  // ---------- scene ----------
  function buildScene(first) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    sim = {}; edgeLines = [];
    world = el("g", {});
    svg.appendChild(world);
    model.nodes.forEach(function (node, idx) {
      var angle = idx * 2.399963; // golden-angle scatter, tight radius
      sim[node.id] = { node: node, x: W / 2 + Math.cos(angle) * (24 + idx * 4), y: H / 2 + Math.sin(angle) * (24 + idx * 4),
        vx: 0, vy: 0, visible: true, fixed: false, g: null };
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
      var prov = node.provenance ? PROV_STYLE[node.provenance] : null;
      var root = node.kind === "vault" || node.kind === "repository";
      var g = el("g", {});
      var c = el("circle", {
        r: root ? 14 : node.kind === "note" ? 9 : 8,
        fill: COLORS[node.kind] || "#6b7280",
        stroke: prov ? "#e8ecf6" : "#0b1020",
        "stroke-width": prov ? "1.6" : "1.2"
      });
      if (prov && prov.dash) c.setAttribute("stroke-dasharray", prov.dash);
      if (prov && prov.op < 1) c.setAttribute("opacity", prov.op);
      if (node.id === "repository" && model.staleness && model.staleness.state === "stale") {
        c.setAttribute("stroke", "#f59e0b"); c.setAttribute("stroke-width", "3");
      }
      var hasKids = childrenOf(node.id).length > 0;
      var label = el("text", { "class": "label", x: root ? 18 : 13, y: 4 });
      label.textContent = capLabel(node.label) + (hasKids ? (collapsed[node.id] ? "  ▸" : "  ▾") : "");
      if (node.id === "repository" && model.staleness && model.staleness.state === "stale") {
        label.textContent = "⚠ " + label.textContent;
      }
      g.appendChild(c); g.appendChild(label);
      var moved = false;
      c.addEventListener("pointerdown", function (ev) {
        n.fixed = true; moved = false; ev.stopPropagation(); c.setPointerCapture(ev.pointerId);
      });
      c.addEventListener("pointermove", function (ev) {
        if (!n.fixed) return;
        var p = toWorld(ev);
        n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0; moved = true;
        alpha = Math.max(alpha, .08); paint();
      });
      c.addEventListener("pointerup", function () {
        n.fixed = false;
        if (!moved) {
          if (hasKids) {
            if (collapsed[node.id]) delete collapsed[node.id]; else collapsed[node.id] = 1;
            alpha = Math.max(alpha, .35); // gentle reheat only
            paint();
          }
          select(n);
        }
      });
      nodeLayer.appendChild(g);
      n.g = g;
    });
    camApply();
    paint(); // sync visibility before any physics
    alpha = .6;
    if (first) {
      // Pre-simulate against the initial (collapsed) visibility: calm first paint.
      for (var i = 0; i < 140; i++) {
        tick();
        if (i % 20 === 19) paint();
      }
      alpha = .06;
      paint();
    } else {
      alpha = .22; // gentle reheat for content refreshes
    }
  }

  // ---------- data ----------
  function renderMeta() {
    var stale = document.getElementById("stale");
    if (model.staleness && model.staleness.state === "stale") {
      stale.style.display = "";
      var reason = model.staleness.reasons[0] || "index is stale";
      stale.textContent = "stale: " + reason + " — run /weave-scan in pi";
      stale.title = model.staleness.reasons.join("\\n");
    } else {
      stale.style.display = "none";
    }
    document.getElementById("stamp").textContent =
      model.generatedAt ? "data as of " + model.generatedAt : "";
  }

  function fetchGraph(first) {
    return fetch("graph.json", { cache: "no-store" }).then(function (r) { return r.text(); })
      .then(function (text) {
        if (text === lastJson) return; // unchanged inputs ⇒ identical JSON
        lastJson = text;
        model = JSON.parse(text);
        renderMeta();
        buildScene(first);
      });
  }

  searchEl.addEventListener("input", function () {
    query = searchEl.value.trim().toLowerCase(); paint();
  });
  document.getElementById("refresh").addEventListener("click", function () {
    fetchGraph(false);
  });

  var legend = document.getElementById("legend");
  var L = [["vault", "vault root"], ["note", "vault note"], ["repository", "repository"],
    ["module", "module"], ["package", "package"], ["entryPoint", "entry point"],
    ["gitState", "git anchor"], ["external", "remote"]];
  legend.innerHTML = L.map(function (p) {
    return "<div class='row'><span class='dot' style='background:" + COLORS[p[0]] + "'></span>" + p[1] + "</div>";
  }).join("") + "<div class='row'>border: solid=human · dashed=agent · dim=generated</div>" +
    "<div class='row'>scroll=zoom · drag bg=pan · click=expand</div>";

  collapsed = { vault: 1, repository: 1 };
  fetchGraph(true);
  setInterval(function () { fetchGraph(false).catch(function () {}); }, 5000);
  loop();
})();
</script>
</body>
</html>
`;
