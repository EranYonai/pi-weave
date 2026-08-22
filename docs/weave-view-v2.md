# weave-view v2 — Beautiful, Modern, Useful

A design proposal to revive the `/weave-view` human surface. It keeps every
hard constraint of v1 (single self-contained HTML string, zero external
resources, no new dependencies, read-only, derived/disposable) while making
the knowledge space *legible, navigable, and trustworthy*.

> **Status: design draft, iterated.** Reviewed by three parallel subagents
> (UX/visual, engineering/constraints, product/usefulness). §0 records the
> synthesis; every review finding is folded into the body below.

---

## 0. Review synthesis (what changed from the first draft)

Three reviewers read the draft against the live code (`page.ts`, `server.ts`,
`core/graph/model.ts`, `core/graph/build.ts`, `core/vault.ts`,
`tests/pi/viewer.test.ts`). Consensus findings and how this revision answers
them:

| # | Finding | Resolution in this revision |
| --- | --- | --- |
| R1 | **Blocker:** click opens Detail *and* enters focus — incoherent | §5.1/§6: single click = select + open Detail; focus is an explicit action (double-click, `f`, or panel button) |
| R2 | **High:** provenance ring colors collide with kind fills & semantic colors | §4.1: provenance is **style-first** (solid/dashed/dotted ring + glyph + filter); ring color is a weak desaturated secondary cue, offset outside the node |
| R3 | **High:** light-theme contrast claim unsubstantiated | §4.4: full light token set specified now; provenance colors verified for both themes |
| R4 | **High:** dead hover code in v1 (`node-hovered` never set) | §4.6/§5.1: hover wired via `pointerenter/leave`; treatment specified |
| R5 | **High:** testing plan is string-assertion-only; inline JS invisible to the 95% gate | §13: extract-and-run unit tests for pure functions (the pattern already used for `tick()`/`renderMd`); explicit note that inline JS is outside the gate |
| R6 | **High:** cut the optional `overview` model field | §7: compute counts/provenance split client-side from `model.nodes` + vault `detail.notes`; zero core change |
| R7 | **High:** orphan/dangling "health" view missing | §5.5: new Health surface (orphans, dangling, hubs) — all derivable from `model.edges` |
| R8 | **High:** no "what changed recently" surface | §5.2/§5.5: recency sort + "recent" filter using existing `updated` timestamps |
| R9 | **Med-high:** search ignores existing scored `searchNotes` | §5.2/§6: layer core's relevance-scored search over the substring filter |
| R10 | **Med:** focus mode must not reheat the sim | §5.1/§9: focus enter/exit is visibility-only; positions preserved; rebuild only on data change |
| R11 | **Med:** virtualization overkill | §9: cap + "show more"; defer true virtualization |
| R12 | **Med:** doubled-escaping tax + no-backtick guard | §8: keep `<script>` one contiguous block; add a CI guard asserting no backtick / no `${` |
| R13 | **Med:** typography underspecified | §4.3: concrete type scale |
| R14 | **Med:** motion generic | §4.5: choreographed motion (focus dim, selection pop, list stagger) |
| R15 | **Med:** no selection state; no degree/size encoding | §4.6: accent selection ring; radius ∝ degree |
| R16 | **Med:** kind palette not color-blind safe | §4.2: shape encoding for kinds (circle/square/triangle) |
| R17 | **Med:** Esc overloaded; no keyboard nav; no empty/error states | §6/§10: Esc precedence; `tabindex`+arrow nav; loading/empty/error states |
| R18 | **Med:** open-in-editor bridge (`file://` blocked by CSP) | §5.3/§11: server `/open/<slug>` endpoint (shells out) — acknowledged constraint |
| R19 | **Low:** `1 2 3` muddled; `+` needs Shift; List layout undecided | §6: `1`=Graph, `2`=List, `?`=help; accept `=`/`+`; §5.2: left-rail List |
| R20 | **Low:** "~2k containment cap" unsubstantiated | §9: correct to "notes capped at 500 (`DEFAULT_MAX_NOTES`); repo side bounded by structure" |
| R21 | **Low:** export snapshot, human-vs-agent coverage | §5.5/§11: export (client-side serialize); coverage comparison in Health |
| R22 | **Defer:** light theme, session scope, focus 2-hop | §14: explicitly out of scope for v2 |

---

## 1. Vision & principles

The viewer is the human face of pi-weave: an agent-native knowledge workspace
that unifies a **vault** of human/agent notes with a **derived repository
index**, where **provenance** (human / agent / generated) is the trust signal
that keeps the space honest (design §13, AGENTS.md rule 4).

v2's job: make the space *legible at a glance, navigable by intent, and
trustworthy by design* — not merely prettier.

**Principles (unchanged from v1, reaffirmed):**

1. **Trust at a glance.** Provenance is the hero. Human vs agent vs generated
   must be legible through ring style + glyph + filter, never color alone.
2. **Three surfaces, one space.** Graph (explore), List (find), Detail (read)
   are switchable views of the same data — not competing tools.
3. **Overview first.** The map precedes the detail: a status strip gives
   scale, health, and staleness before the user dives in.
4. **Progressive disclosure, preserved.** Nothing expands until clicked; focus
   mode is a reading tool, not a decoration.
5. **Zero-dependency, single file.** Every improvement is hand-rolled, offline,
   auditable. No build step, no framework, no external resources.
6. **Read-only, derived.** The viewer never mutates; it points back to pi for
   editing. Everything it shows is derivable from `.okf` + the vault.

---

## 2. Current state assessment

**What v1 does well (keep):**
- Single self-contained HTML string; zero external resources; tight CSP.
- Hand-rolled force layout with **pre-simulated warm-up** ("calm first paint").
- Wiki-link edges, staleness badge, expand/collapse, zoom/pan, side panel.
- Identical-JSON no-op polling (liveness ≤5s).
- Provenance field already on every node (`model.ts:31`).

**What v1 does poorly (fix):**
- **Graph is the only surface.** You cannot find a note by name or see the
  whole inventory; search is a substring filter that just dims nodes
  (`page.ts:497-498`).
- **Dead ends.** Wiki-links render as inert spans; there are no backlinks; the
  graph is a dead end once you open a note.
- **No overview.** First paint gives no sense of scale, health, or staleness.
- **No focus/context.** The whole graph is always shown; no way to isolate a
  neighborhood.
- **Dead hover code.** `g.node-hovered` CSS exists (`page.ts:50`) but is never
  set in JS.
- **Visual layer is generic.** Competent dark-developer-tool palette, no
  distinctive identity, underspecified type, no choreographed motion.

---

## 3. Design pillars

1. **P1 — Provenance is the hero.** Multi-channel (ring style + glyph + filter),
   not color-only. A "show only human" query is a first-class, useful action.
2. **P2 — Three surfaces, one space.** Graph / List / Detail over one model.
3. **P3 — Overview first.** Status strip = the map before the detail.
4. **P4 — Focus as a reading tool.** Explicit focus mode isolates a node's
   neighborhood; the graph becomes a way to *read*, not just look.

---

## 4. Visual design system

### 4.1 Provenance — style-first, not hue-first

Provenance is encoded **primarily by ring style + glyph + filter**, with color
as a weak secondary cue. This survives color-blindness, light/dark themes, and
collisions with kind fills.

| Provenance | Ring style | Glyph | Weak color (dark) | Weak color (light) |
| --- | --- | --- | --- | --- |
| `human` | solid | `●` | `#a7f3d0` | `#059669` |
| `agent` | dashed | `◐` | `#e9d5ff` | `#7e22ce` |
| `generated` | dotted | `○` | `#94a3b8` | `#475569` |
| structural (null) | none | — | — | — |

- The ring is **offset outside the node** (`r+2.5`) with a thin dark gap so it
  reads as a ring, not a border.
- **Staleness is a separate signal** (amber pulse/badge), never the provenance
  ring — v1 conflated the two on the node stroke.

### 4.2 Kind encoding — color + shape (color-blind safe)

Kinds get both a hue and a shape so no two kinds rely on color alone:

| Kind | Shape | Color (dark) | Color (light) |
| --- | --- | --- | --- |
| `vault` | circle | `#8b5cf6` | `#7c3aed` |
| `note` | circle | `#c4b5fd` | `#7c3aed` |
| `repository` | rounded-square | `#3b82f6` | `#2563eb` |
| `module` | rounded-square | `#22c55e` | `#16a34a` |
| `package` | rounded-square | `#14b8a6` | `#0d9488` |
| `entryPoint` | triangle | `#a3e635` | `#65a30d` |
| `gitState` | diamond | `#facc15` | `#ca8a04` |
| `external` | hexagon | `#fb923c` | `#ea580c` |

Shapes: circle, rounded-square, triangle, diamond, hexagon. This removes the
three-greens deuteranopia problem (module/package/entryPoint now differ by
shape and hue).

### 4.3 Typography

Concrete type scale (system stack, no webfonts):

| Role | Size / weight | Notes |
| --- | --- | --- |
| Base | 13px / 1.5 | keep |
| Header title | 15px / 600 | `letter-spacing:-0.01em` |
| Surface tabs | 12px / 600 | uppercase, `letter-spacing:.08em` |
| Node labels | 12px | up from 11.5 |
| Panel h2 | 18px / 1.3 / 650 | |
| Body | 14px / 1.6 | up from 13.5 for readability |
| Meta / counts | 12px | `font-feature-settings:"tnum"` so the status strip doesn't jitter |

### 4.4 Color tokens — dark + light

Dark (default) and light (toggleable, `prefers-color-scheme` aware) token sets.
Both are specified now so contrast is verifiable, not asserted.

```css
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
```

A subtle background dot-grid or vignette keeps the graph from floating on a
flat `--bg`.

### 4.5 Motion — choreography, not just a shared curve

Shared easing `cubic-bezier(.2,.7,.2,1)`; durations per intent:

- **Focus zoom** 300ms + a 200ms opacity fade on non-neighbors (dim, don't snap).
- **Panel slide** 250ms.
- **List rows** 20ms-per-row stagger on appear (capped).
- **Selection pop** 150ms scale-in on the selected node's accent ring.
- **Stale repository** slow 2s opacity pulse (disabled under reduced-motion).

All motion respects `prefers-reduced-motion` (→ instant).

### 4.6 Node rendering & selection

- **Radius ∝ degree:** `r = 7 + min(6, sqrt(degree)*1.2)` so hubs read at a
  glance (the single biggest "useful" win for graph legibility).
- **Hover:** `pointerenter/leave` → scale 1.06 + soft halo (0.15 opacity,
  120ms); incident edges brightened to full opacity and thickened to 1.8px.
- **Selection:** 2px `--accent` ring at `r+4` on the selected node, distinct
  from the provenance ring; panel opens.
- **Edge direction:** small triangle markers on `links-to`; subtle animated dash
  flow to show direction.

---

## 5. Surfaces

### 5.1 Graph

- Force layout with pre-simulated warm-up (keep).
- **Focus mode:** explicit (double-click, `f`, or panel button). Centers +
  zooms the node, dims everything outside its 1-hop neighborhood, shows its
  incident edges. **Enter/exit is visibility-only — no sim reheat, positions
  preserved.** Full rebuild only on data change.
- **Hover tooltip:** kind, provenance, updated, link count before committing to
  a click.
- **Breadcrumb / path** showing where you are in the neighborhood, with a
  visible "back to full view" affordance.

### 5.2 List

- **Left rail (~340px)** with Detail on the right (the graph stays the hero).
- **Expandable index tree.** The list is a tree over the `contains`
  hierarchy, not a flat dump: roots (`vault`, `repository`) are expanded by
  default, and each node with children shows a `▸`/`▾` chevron to expand or
  collapse it. Entry points (files) are nested under the module whose path is
  their directory prefix, so the repository reads as a real file tree —
  expand `repository` → `module` → file, then click a file to open its Detail.
- Sortable within each sibling group: by name, updated, link count,
  provenance.
- Filterable: by kind, provenance, and a **"recent"** filter (last N days).
  When a filter or search is active, ancestors of matching nodes are
  auto-expanded so matches stay reachable.
- **Search** layers core's relevance-scored `searchNotes` over the substring
  filter, with a grouped result dropdown.
- Cap at `DEFAULT_MAX_NOTES` (500) with a **"show more"** affordance; true
  virtualization deferred (§9).
- Keyboard: arrow up/down + Enter; `▸`/`▾` toggles expansion.

### 5.3 Detail

Tabs: **Overview | Body | Links | Backlinks.**

- **Overview:** provenance, tags, updated, link count, dangling-link warning.
- **Body:** markdown renderer (keep escape-first); **wiki-links are now
  clickable** and navigate to the target note (fetch + render through the same
  safe `/note/<slug>` path).
- **Links:** outgoing edges.
- **Backlinks:** incoming edges, derived client-side from `model.edges`.
- **Open in editor:** a button that calls a new server `/open/<slug>` endpoint
  (shells out to the OS editor). Raw `file://` links are blocked by browser/CSP,
  so this needs the endpoint — acknowledged constraint (§11).

### 5.4 Overview / status strip

A compact strip: note count, human/agent/generated split (mini bars), repo
staleness, **relative** "indexed 3m ago", generatedAt. All computed client-side
from `model.nodes` + vault `detail.notes` (§7).

### 5.5 Health

A dedicated surface for the maintenance problems a knowledge workspace actually
has — all derivable from `model.edges`, zero server change:

- **Orphans:** notes with no incoming links.
- **Dangling:** notes whose wiki-links point to non-existent targets.
- **Hubs:** most-connected notes (sort by link count).
- **Coverage:** human vs agent vs generated split, and per-module summarized-vs-
  not (from repo summaries).
- **Export snapshot:** one-click serialize of the current graph/notes to JSON or
  Markdown (read-only, client-side).

---

## 6. Interactions & shortcuts

| Key | Action |
| --- | --- |
| `1` | Graph surface |
| `2` | List surface |
| `f` | Focus selected node |
| `g` | Exit focus / back to full graph |
| `/` | Focus search |
| `?` | Shortcuts help overlay |
| `=` / `+`, `-` / `_` | Zoom in / out |
| `Esc` | Precedence: search focused → clear search; else panel open → close panel; else focus mode → exit focus |
| `Enter` / `Space` | Activate focused node / list row |

Graph nodes get `tabindex="0" role="button"` + Enter/Space; List rows get arrow
up/down + Enter. All surfaces reachable via keyboard.

**Loading / empty / error states:** first-load skeleton; empty state ("no notes
yet — write one in pi"); error state with retry (polling errors are no longer
silently swallowed).

---

## 7. Data model implications — client-side, zero core change

The `overview` field is **cut** (R6). Everything the new UI needs is derivable
client-side from the existing `GraphModel`:

- Counts / provenance split → `model.nodes` + vault node `detail.notes`.
- Backlinks → `model.edges` (`links-to`).
- Orphans / dangling / hubs → `model.edges` + note `detail.dangling`.
- Recency → `node.detail.updated`.
- Focus neighborhood → `model.edges` (1-hop).

This protects the identical-JSON invariant (no-op polling + snapshot tests) and
keeps core untouched. The only server addition is the `/open/<slug>` endpoint
(§5.3, §11).

---

## 8. Architecture & maintainability

- The page stays a **single self-contained HTML string** behind the `page.ts`
  seam; server and core unchanged except the `/open` endpoint.
- Keep the `<script>` block as **one contiguous template constant** so the
  existing regex-extraction tests (`extractScript`, physics test) keep working.
- **New pure functions** live inside the page script and are extract-and-run
  tested (§13): `focusNeighborhood(id, edges)`, `deriveBacklinks(edges)`,
  `applyFilter(nodes, kind, prov)`, `sortRows(rows, key)`, `counts(nodes)`,
  `linksOf(id, edges)`, and `listTree(model, state)` (the expandable index
  tree).
- **CI guard:** assert the rendered page contains no backtick and no `${` —
  protects the single-file invariant from silently breaking.
- Acknowledge the **doubled-escaping tax**: every regex/string escape in the
  page script must be `\\`-escaped. Pure-function extraction is the mitigation.

---

## 9. Performance & scope

- **Notes capped at 500** (`DEFAULT_MAX_NOTES`, `build.ts:17`); repo side
  bounded by structure. (Corrected from the draft's "~2k containment cap".)
- Force layout is O(n²); focus mode reduces visible nodes, which speeds the sim
  — but focus enter/exit is visibility-only (no reheat).
- List: cap + "show more"; **true virtualization deferred** (hand-rolled
  windowing is a real cost and testing liability in a no-dependency single file).

---

## 10. Accessibility

- Provenance never color-only (ring + dash + glyph + filter).
- Kind never color-only (shape + hue).
- `prefers-reduced-motion` honored.
- Keyboard navigation on graph nodes and list rows.
- Focus rings on all interactive elements.
- Contrast verified for both themes (§4.4).

---

## 11. Security

- Keep: escape-first markdown, `javascript:` URL refusal, loopback-only server,
  tight CSP, traversal-proof `/note/<slug>`.
- New wiki-link navigation resolves through the same safe path.
- **`/open/<slug>` endpoint** shells out to the OS editor; must validate the
  slug against the vault (no path traversal), and is the only new server
  surface. Raw `file://` links are blocked by browser/CSP — acknowledged.

---

## 12. Milestones

| Milestone | Contents | Exit check |
| --- | --- | --- |
| **M1 — Design system** | tokens (dark+light), type scale, kind shapes, provenance rings, hover, selection, degree sizing, motion | visual pass on real graph; no dead CSS |
| **M2 — Overview + List** | status strip, left-rail list, sort/filter, recency, scored search, show-more | find a note by name; see scale/health |
| **M3 — Detail + navigation** | tabs, clickable wiki-links, backlinks, focus mode, breadcrumb, `/open` endpoint | click a wiki-link → target note; backlinks listed |
| **M4 — Health + polish** | orphans/dangling/hubs, coverage, export, empty/error states, shortcuts help | health view accurate; export works |
| **M5 — Hardening** | a11y pass, contrast verification, no-backtick guard, full test suite | `npm run check` green |

Light theme ships with M1 tokens but is **not** a gating milestone.

---

## 13. Testing

- **Core:** unchanged (no model change). Existing L1–L3 stay green.
- **Page:** the inline JS is **invisible to the 95% coverage gate** (vitest
  covers `src/**/*.ts`; the page script is a string). This is stated explicitly.
  Mitigation: **extract-and-run unit tests** for the pure functions (§8) using
  the existing pattern (`tests/pi/viewer.test.ts:241-279` regex-extracts and
  executes `tick()`/`renderMd`). Add behavior tests for `focusNeighborhood`,
  `deriveBacklinks`, `applyFilter`, `sortRows`, `counts` — not just string
  markers.
- **Server:** `/open/<slug>` endpoint tests (valid slug, traversal refusal).
- **Guard:** CI asserts no backtick / no `${` in the rendered page.

---

## 14. Non-goals (explicit)

- **Session-scope knowledge** (design §1, §17) — not persisted; out of scope.
- **Focus 2-hop** — 1-hop is right; don't overbuild.
- **True list virtualization** — deferred.
- **Light theme as a gate** — ships with M1 tokens, not a milestone gate.
- **Editing in the viewer** — read-only; editing stays in pi / the editor.
- **New dependencies, build step, external resources** — never.

---

## 15. Open questions

1. `/open/<slug>`: which editor? Respect `$EDITOR` / `VISUAL`, fall back to
   `open`/`xdg-open`? Should it be opt-in (a setting) given it shells out?
2. Should the status strip's provenance split be clickable (drill into a
   filtered List)? Likely yes — cheap and useful.
3. Export format: JSON (raw graph) vs Markdown (readable) vs both? Default?
4. Should "recent" be a fixed window (7d) or a "since last visit" marker
   (needs a small client-side localStorage cursor)?
