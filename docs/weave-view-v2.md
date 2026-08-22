# weave-view v2 — Beautiful, Modern, Useful

A design proposal to revive the `/weave-view` human surface. It keeps every
hard constraint of v1 (single self-contained HTML string, zero external
resources, no new dependencies, read-only, derived/disposable) while making
the knowledge space *legible, navigable, and trustworthy at a glance*.

> Status: **proposal** — not yet implemented. This document is the design
> input; implementation is a separate milestone (see §10).

---

## 1. Vision & principles

The viewer is the human face of pi-weave: *"an agent-native knowledge
workspace for your life and your code."* Its job is not to be a pretty
force-graph demo — it is to make the **structure and trust** of the knowledge
space visible, and to let a human move through it quickly.

Five principles drive every decision below:

1. **Trust at a glance.** Provenance (human / agent / generated) is the
   hero, not a footnote. It must be legible through *more than color* —
   shape, stroke, and a filter — so it survives color-blindness and both
   themes.
2. **Three surfaces, one space.** A graph alone is pretty but hard to *use*.
   v2 offers **Graph** (explore), **List** (find), **Detail** (read) as
   switchable surfaces over the same data — not competing views.
3. **Progressive disclosure, preserved.** Nothing expands until clicked
   (design §9). But the *overview* gives the map first, so the user knows
   what exists before choosing what to open.
4. **Zero-dependency, single file.** All improvements are hand-rolled in
   `page.ts`. No build step, no CDN, no vendored lib. If a feature needs a
   library, it is out of scope (see §11).
5. **Read-only, derived.** The viewer never mutates knowledge; it points
   back to pi (`/weave-scan`, editing in the editor). It stores nothing.

---

## 2. Current state assessment

### What works (keep)
- **Calm first paint** — pre-simulated 140 ticks before first render; the
  graph is settled, not exploding. This is a genuinely good touch.
- **Provenance styling** — solid/dashed/dim is already present and correct.
- **Progressive disclosure** — two roots, nothing expands until clicked.
- **Live freshness** — `/graph.json` rebuilt per request, identical-JSON
  no-op polling. Cheap and honest.
- **Security posture** — HTML-escaped-first markdown, `javascript:` URL
  refusal, loopback-only server, tight CSP. Keep all of it.

### What's weak (fix)
- **The graph is the only surface.** For a knowledge workspace this is the
  biggest gap: you can't *find* a note by name, you can't see the whole
  inventory, you can't tell how big or how healthy the space is.
- **No overview.** Nothing tells you "42 notes, 30 human / 8 agent / 4
  generated, repo stale." The map is missing.
- **Search is weak.** Substring filter that dims nodes — no result list, no
  kind/provenance filtering, no way to jump to a match.
- **No navigation.** Wiki-links in the detail panel render as inert spans.
  You cannot click a link to jump to another note, and there is no backlinks
  list. The graph is a dead end.
- **No focus/context.** The whole graph is always shown. You can't isolate
  a node's neighborhood to actually *read* the connections.
- **Visual design is functional but flat.** The palette is reasonable but
  there is no elevation, no motion, no hierarchy, no light theme, and
  provenance relies on color/dash alone.

---

## 3. Design pillars

### P1 — Provenance as a first-class visual
- Every knowledge node gets a **provenance ring** (a thin colored ring around
  the node) *plus* the existing dash pattern *plus* a small glyph in the
  detail panel. Color is never the only signal.
- A **provenance filter** (chips: Human / Agent / Generated) dims or hides
  whole classes, so "show me only what a human wrote" is one click.

### P2 — Three surfaces
- **Graph** — the existing force layout, upgraded (focus mode, better
  rendering, refined palette).
- **List** — a sortable, filterable inventory of all notes (and modules):
  title, kind, provenance, updated, link count. Click → detail.
- **Detail** — the side panel, upgraded to tabs: **Overview | Body |
  Links | Backlinks**, with clickable wiki-links that navigate.

### P3 — Overview first
- A compact **status strip** (top or bottom) shows: note count, provenance
  split (mini bars), repo staleness, `generatedAt`. The user sees the map
  before choosing where to go.

### P4 — Focus mode
- Click a node → **focus**: center + zoom to it, dim everything outside its
  immediate neighborhood, highlight its edges. A breadcrumb / "back to full
  view" restores the whole graph. This turns the graph from decoration into
  a reading tool.

---

## 4. Visual design system

### 4.1 Tokens (CSS custom properties)
Refine the palette into an elevation scale and semantic tokens so both
themes share one vocabulary:

```css
:root {
  /* elevation */
  --bg: #0b1020;        /* page */
  --surface: #111827;   /* panels, header */
  --raised: #1a2338;    /* cards, dropdowns */
  --line: #26324d;      /* borders */
  --line-strong: #33415e;
  /* text */
  --text: #e8ecf6;
  --muted: #93a0bd;
  --faint: #5b6b8c;
  /* accent + semantic */
  --accent: #a78bfa;
  --accent-soft: rgba(167,139,250,.14);
  --ok: #34d399; --warn: #fbbf24; --danger: #f87171;
  /* provenance */
  --prov-human: #34d399;   /* solid ring */
  --prov-agent: #c084fc;    /* dashed ring */
  --prov-generated: #64748b;/* dim */
}
```

- **Light theme** (optional, milestone M4): a `[data-theme="light"]` block
  with the same token names inverted. Default follows `prefers-color-scheme`;
  a header toggle overrides. Provenance colors are chosen to hold contrast on
  both themes.

### 4.2 Typography
- System stack (unchanged — no webfonts, offline-safe).
- Clear hierarchy: header title, surface tabs, node labels, panel headings.
- **Tabular numerals** (`font-variant-numeric: tabular-nums`) for counts and
  timestamps so the status strip doesn't jitter.

### 4.3 Motion
- A shared easing (`cubic-bezier(.2,.7,.2,1)`) and duration scale
  (150ms micro, 250ms panel, 300ms focus zoom).
- Node **hover**: subtle glow + slight scale; **focus**: dim non-neighbors.
- Panel slide, tab cross-fade, status-strip count transitions.
- **`prefers-reduced-motion: reduce`** disables non-essential motion
  (keeps the force sim, drops glows/transitions).

### 4.4 Node rendering
- Roots keep a soft **radial glow** (SVG `<radialGradient>` or a blurred
  halo circle) so Vault/Repository read as anchors.
- Provenance ring: a thin `<circle>` with `stroke` = provenance color and
  `stroke-dasharray` = human solid / agent dashed / generated dotted.
- Kind colors refined for contrast on both themes (see §4.1 + legend).

---

## 5. Surfaces

### 5.1 Graph (upgraded)
- Keep the force layout, warm-up, zoom/pan, expand/collapse.
- Add **focus mode** (§3 P4): click node → isolate neighborhood.
- Add **kind + provenance filters** that dim/hide nodes (shared with List).
- Better edge rendering: `links-to` and `mentions` get arrowheads or
  direction hints; hover on a node highlights its incident edges.

### 5.2 List
- A left or full-width panel listing all notes (and modules) as rows:
  `kind glyph · title · provenance chip · updated · link count`.
- **Sort** by title / updated / link count; **filter** by kind and
  provenance (shared filter state with Graph).
- Click a row → open Detail. This is the "find by name" surface the graph
  lacks.

### 5.3 Detail (side panel, tabs)
- **Overview** — kind, provenance, tags, updated, slug, dangling-link
  warning, summary/preview.
- **Body** — the existing mini-markdown renderer, upgraded so `[[wiki-links]]`
  are **clickable** and navigate to the target note (fetch `/note/<slug>`,
  render, update breadcrumb). `javascript:` URLs still refused.
- **Links** — outgoing edges (what this node points to), clickable.
- **Backlinks** — incoming edges (what points here), clickable. Derived
  client-side from `model.edges` — no server change.

---

## 6. Interactions & shortcuts

| Key | Action |
| --- | --- |
| `/` | focus search |
| `Esc` | close panel / clear search / exit focus |
| `f` | toggle focus mode on selected node |
| `1` `2` `3` | switch Graph / List / Detail focus |
| `+` `−` `0` | zoom in / out / reset |
| `g` | back to full graph (exit focus) |

- Search: substring match with a **result dropdown** (grouped by kind),
  Enter jumps to the top match. Kind/provenance filter chips shared across
  Graph and List.
- Clickable wiki-links and backlinks make the graph navigable end-to-end.

---

## 7. Data model implications

**Deliberately minimal.** Almost everything above is client-side over the
existing `GraphModel`:

- **Counts / provenance split** — computed client-side from `model.nodes`.
- **Backlinks / link counts** — derived client-side from `model.edges`.
- **Focus neighborhood** — derived client-side from `model.edges`.
- **Dangling links** — already present in note `detail["dangling links"]`.

One small, optional, backward-compatible addition to consider (defer to
implementation, not required for the design):

```ts
// GraphModel (optional v2 field)
overview?: {
  noteCount: number;
  byProvenance: { human: number; agent: number; generated: number };
  moduleCount: number;
};
```

If added, it must be **derived from the same inputs** so identical inputs
still produce identical JSON (keeps L1 snapshot tests and no-op polling
valid). If it risks that invariant, compute it client-side instead.

---

## 8. Architecture & maintainability

- The page stays a single self-contained HTML string behind the
  `page.ts` seam. **No build step.**
- To keep a ~22KB template string maintainable, restructure `page.ts` into
  clearly delimited sections (CSS tokens, layout, graph, list, detail,
  interactions, data) — either as one template with strong section comments
  or as a few concatenated template-string constants. **Do not** introduce a
  build step or a framework.
- Keep the "no backticks / no template substitutions inside the page script"
  rule (the page is a TS template literal). If splitting into multiple
  constants, keep each free of backticks.
- Server (`server.ts`) and graph model (`core/graph`) are **unchanged** unless
  the optional `overview` field is adopted. The redesign is a `page.ts`
  rewrite plus tests.

---

## 9. Accessibility, performance, security

### Accessibility
- Provenance never relies on color alone (ring + dash + glyph + filter).
- Keyboard: all surfaces reachable via shortcuts; visible focus rings.
- `prefers-reduced-motion` honored.
- Semantic HTML where possible (buttons, lists, headings); ARIA labels on
  icon buttons.

### Performance
- Force layout stays O(n²) but nodes are capped (~2k) by containment depth.
- **Focus mode reduces visible nodes**, which also speeds up the sim.
- List view renders rows lazily (virtualize or cap at ~500 with a "show
  more").
- Keep the 5s identical-JSON polling (cheap).

### Security
- Preserve: HTML-escape-first markdown, `javascript:` URL refusal, loopback
  server, tight CSP, traversal-proof `/note/<slug>`.
- New clickable wiki-links must resolve through the same safe path and never
  inject raw HTML.

---

## 10. Milestones

| Milestone | Contents | Exit check |
| --- | --- | --- |
| **M1 — Design system** | tokens, elevation, typography, motion, provenance ring + glyph, light-theme scaffold | page renders with new palette; provenance legible without color |
| **M2 — Overview + filters** | status strip (counts, provenance split, staleness), kind/provenance filter chips, search result dropdown | "show only human" dims agent/generated; counts correct |
| **M3 — Navigation** | clickable wiki-links, Links/Backlinks tabs, focus mode, breadcrumb | click a link → jumps to note; backlinks list correct |
| **M4 — List surface + polish** | List view (sort/filter/virtualize), light theme toggle, reduced-motion, keyboard shortcuts | find a note by name; theme toggle works; a11y pass |

Each milestone keeps coverage ≥95% and `npm run check` green.

---

## 11. Non-goals (v2)

- Editing/deleting knowledge from the browser (stays read-only).
- Any external resource, webfont, or vendored graph library.
- Server push (websockets/SSE), auth, multi-user, remote access.
- Level-2 semantic nodes (symbols) — still gated behind the analyzer.
- Mobile-first layout (responsive status strip only, not a mobile app).
- A build step or framework.

---

## 12. Testing

- **L1 (core)** — unchanged unless the optional `overview` field is added;
  if so, snapshot tests for identical-input ⇒ identical-JSON.
- **L2 (server)** — unchanged; add a check that `/` still returns the CSP
  header and well-formed HTML.
- **L3 (adapter)** — unchanged.
- **L4 (page smoke)** — new: assert the rendered page string contains the
  required surface markers (status strip, filter chips, tabs, focus
  controls) and that provenance ring/dash classes are present. Keep the page
  as a string so these are cheap string assertions.
- **L5 (manual)** — visual checklist: provenance legible without color,
  focus mode isolates a neighborhood, wiki-link navigation works, light
  theme, reduced-motion.

---

## 13. Open questions

1. **Graph vs List default.** Should the first paint be the graph (current)
   or the overview+list (more "useful" but less "wow")? Proposal: keep graph
   as the hero, but show the status strip immediately so the map is present.
2. **`overview` field in the model** — worth the model change, or compute
   client-side? (Lean client-side to protect the identical-JSON invariant.)
3. **Focus mode default depth** — 1-hop neighborhood, or 2-hop with
   dimmed 2nd ring? (Proposal: 1-hop bright, 2-hop dimmed.)
4. **Light theme** — in v2 or later? (Proposal: M4, optional.)
5. **Clickable wiki-links** — should they also support `[[slug|alias]]`
   display and dangling-link styling (red/dashed when target missing)?
