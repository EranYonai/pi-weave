# weave-view v3 — A Controllable, Anti-Hairball Graph

> **Status: design draft for implementation.** This is the redesign of the
> **browser** `/weave-view` (no `tui` arg) — the force-graph viewer in
> `src/pi/viewer/page.ts`. It supersedes the *layout philosophy* of
> `docs/weave-view-v2.md` (the current browser viewer, "Beautiful, Modern,
> Useful") and extends the graph fixes already landed in PR #17 (§16:
> position persistence, degree-repulsion, real collision, swinging damping,
> label fade, layout toggle). v3 keeps all hard constraints and all of v2's
> provenance/Markdown/CSP work; it changes *how the graph scales and how much
> the user controls.*

---

## 0. The problem, in the user's words

> "weave-view still can be jumpy when there are multiple nodes." And from a
> real screenshot critique:
> - **Severe label collision & unreadability** in the dense lower leaf cluster
>   — "file names entirely unreadable without hovering."
> - **Edge routing & collision** — "connections overlap heavily … turning the
>   lower cluster into a solid hairball rather than an informative map."
> - **Truncated label names** across the board (e.g.
>   `src--core--slug.ts.summary.md`), "reducing context without zooming in."
> - **Missing scale strategy** — "the force-directed physics fail to expand
>   dynamically for large child-node clusters, lacking cluster aggregation,
>   semantic zooming, or expanding sub-graphs on click."

**Root cause:** v2/§16 still *shows every node at once in one force blob*. No
force tuning (charge, collision, damping — all already improved in §16) can
fix that, because the hairball is *structural*: a codebase has a few hubs and
hundreds of leaves, and a flat force layout must place all leaves somewhere
visible. The only real fix is to **not show all leaves at once** — aggregate,
and reveal on demand. This is exactly what Cytoscape ("the hairball problem →
show a relevant subgraph"), Gephi/ForceAtlas2 (cluster aggregation), and
Obsidian (filter + collapse) actually do. v2's force graph is the wrong
default; v3 makes **aggregation + semantic zoom + deterministic layouts the
default**, with force as an opt-in.

This mirrors the TUI v2 redesign: v1 was an immovable single pane; the fix was
*give the user control of the layout*. The browser graph's analog: v2 was an
uncontrollable hairball; the fix is *give the user control of scale and
layout*.

---

## 1. Vision & principles

**Vision:** *pi-weave's knowledge space, as a map that stays legible at any
scale — and that you steer, not just watch.*

Principles (ported from the TUI v2 design + browser realities):

1. **P1 — Aggregation before explosion.** The default view is *clusters*, not
   leaves. You see the shape of the workspace; you drill in where you care.
   "Show everything" is never the first paint.
2. **P2 — Layout is the user's.** Deterministic layouts (cluster / tree /
   radial) are the default and never jumpy; force is opt-in. The user switches
   and tunes — repel/link/center sliders, filters, collapse/expand — without
   leaving the keyboard or the mouse.
3. **P3 — Progressive disclosure, spatially.** Click a cluster → it expands its
   children in place; click again → collapse. Zoom in → labels and sub-nodes
   reveal (semantic zoom). The graph is a *browseable hierarchy*, not a dump.
4. **P4 — Trust at a glance (unchanged).** Provenance (human/agent/generated)
   is still the hero — ring style + glyph + filter, never color alone (v2 §4.1).
5. **P5 — Refined and branded.** Restrained chrome, a real controls panel
   (Obsidian-style, not a debug drawer), the logo present in the header, motion
   choreographed and reduced-motion-safe.
6. **P6 — Keep the hard constraints.** Single self-contained HTML string, zero
   external resources, **no new dependencies**, read-only, derived, ≥95%
   coverage gate, no backtick / no `${` in the rendered page, core untouched.

---

## 2. What we keep (do not redo)

- **The `GraphModel`** and all readers — unchanged.
- **Provenance/kind theming** (v2 §4.1/§4.2) — ring style + glyph + shape, color
  as weak secondary. Cluster nodes reuse the same markers.
- **The §16 graph helpers** already in PR #17 (`seedPositions`,
  `collideRadius`, `degreeRepulsion`, `localSpeed`, `deltaAlpha`,
  `radialLayout`, `treeLayout`, `labelVisible`) — v3 *extends* them; it does
  not replace them. Force mode still uses the §16 sim.
- **Security** (escape-first markdown, `javascript:` refusal, loopback server,
  tight CSP, traversal-proof `/note/<slug>`, the no-backtick/`${` guard).
- **Single self-contained HTML string** behind `page.ts`; server + core
  unchanged.
- **Extract-and-run pure-helper testing** (v2 §13 / §16.5).

---

## 3. The core shift: aggregation + semantic zoom (the scale strategy)

### 3.1 Cluster aggregation — the fix for the hairball

A **cluster node** aggregates a subtree. By default the graph shows only:

- The **roots**: `vault`, `repository`.
- Their **direct children** as cluster nodes: each `module`, each top-level
  note grouping, the `package`/`gitState` nodes. A cluster shows a **count
  badge** (`module:src · 14 children`) instead of its leaves.

Leaf nodes (files, individual notes) are **hidden inside their parent cluster
until expanded**. This is structural aggregation over the `contains`/`anchored-at`
edges — no new algorithm, no community detection, zero core change (the
containment hierarchy is already in the model). It is the cheapest possible
answer to "cluster aggregation" and it directly eliminates the leaf hairball.

- **Expand a cluster** (click / `enter` / `+`): its children appear in a small
  local layout around it (a mini force or a tidy fan), positioned so they
  don't collide with the rest of the graph; the cluster node becomes a "frame"
  around its children. **Collapse** reverses it.
- **Expand depth**: a cluster can expand "one level" or "all" (recursive);
  `Shift+click` = expand all; the controls panel has "expand all / collapse all".
- Aggregation respects the current **filter**: a cluster whose children are
  all filtered out shows dimmed/empty and can be hidden entirely.

### 3.2 Semantic zoom — labels and detail scale with the viewport

Semantic zoom = *what you see depends on zoom level*, not just *how big it is*.

| Zoom band | What shows |
| --- | --- |
| Far (overview) | Only cluster nodes; labels for clusters + high-degree hubs; **no leaf labels**. Edges between clusters only. |
| Mid | Cluster nodes + their direct children (if expanded); labels for all visible non-leaf nodes + the hovered/selected leaf. |
| Near (drill-in) | All expanded leaves get labels; incident edges highlighted, others faded. |

This is the direct fix for "label collision & unreadability" and "truncated
names": at overview you simply don't render 200 leaf labels; as you zoom into
a region, labels appear where there's room. Combined with a **label collision
pass** (§4.4) it's impossible to produce the solid-text hairball the critique
called out.

### 3.3 Deterministic layouts first — never jumpy by default

The containment graph is *genuinely a tree/DAG* (vault→notes, repo→module→file).
A force layout fights that structure. v3 makes the defaults deterministic:

- **Cluster layout** (default): clusters placed by a tidy-tree / radial fan of
  the containment roots; expanded children laid out locally inside their
  cluster frame. Deterministic → **zero jumpiness**; identical data → identical
  positions; rebuild is a no-op visually.
- **Tree layout**: a top-down tidy tree over containment edges (reuse §16
  `treeLayout`), cross-links (`links-to`) drawn as curved chords. Best for
  reading the repo structure.
- **Radial layout**: concentric by depth (roots center, leaves outer), reuse
  §16 `radialLayout`. Best for "what's big/central."
- **Force layout** (opt-in): the §16 improved force sim, for users who want
  the live physics. Clearly labeled "physics" — not the default.

Switching layouts animates nodes from current to target positions (one
`requestAnimationFrame` tween, reduced-motion → instant), so it never "jumps";
positions interpolate.

### 3.4 Position persistence — the shape survives (Obsidian's #1 want)

The single most-requested Obsidian feature (the Persistent Graph plugin) is
*keep my layout across restarts*. v3 persists **per-repo node positions** to
`localStorage` (keyed by cwd hash + node id):

- On load: restore saved positions; new nodes seed near their parent (or
  phyllotaxis for orphans); removed nodes drop.
- On drag / expand / layout switch: debounced save (300ms).
- A "reset layout" control clears the store.

This makes the graph a *spatial memory* of the workspace, not a re-exploding
physics demo each visit. (§16 already persists positions in-session across
rebuilds; v3 extends that to *across sessions* via `localStorage`.)

---

## 4. Visual design system (delta on v2 §4)

### 4.1 Cluster nodes

- Render as a **rounded rectangle** sized by `log(childCount)` (a big cluster
  reads big). Fill = the cluster's kind color (translucent); **count badge**
  in a corner. Provenance ring on the cluster = the *dominant* provenance of
  its children (or a split mini-bar if mixed — the v2 "mini bars" idea, now on
  the cluster).
- Expanded cluster = a **dashed frame** around its children; collapsed =
  solid. Selection = accent ring (v2 §4.6). Hover = soft halo.
- A cluster with **dangling/health issues** (orphans inside, stale repo) gets
  a small warning tick — the Health surface (v2 §5.5) made spatial.

### 4.2 Edges

- **Containment edges** (`contains`/`anchored-at`) are the *structural*
  skeleton: thin, low-saturation, drawn *under* nodes. Between clusters, drawn
  cluster-to-cluster.
- **Cross-links** (`links-to`, wiki-links) are the *interesting* signal: solid
  accent curves, only between visible nodes. On hover/select of a node, its
  incident edges brighten to full opacity and others fade to 0.12 (v2 already
  does this in focus; v3 makes it the default interaction, not just focus mode).
- **Edge declutter**: when >N edges cross a region, bundle parallel edges and
  reduce opacity; never draw edges to hidden/clustered leaves (draw to the
  cluster instead). This is the fix for "edge routing & collision."

### 4.3 Labels

- **Degree-priority + zoom-gated + collision-checked** (the fix for label
  collision): a label is drawn only if (a) the node is a cluster/hub OR
  expanded-leaf at sufficient zoom, AND (b) it doesn't overlap a
  higher-priority label (quadtree collision pass, O(n log n), cheap). Priority
  = degree, then selection/hover, then alphabetical.
- Long labels: **ellipsis in the middle** (`src…slug.ts.summary.md`) not the
  end, so the file extension + prefix stay visible (fixes "truncated names"
  losing context). Full name always in the hover tooltip and the Detail panel.
- Cluster labels always show (few of them). Leaf labels only on demand.

### 4.4 Motion (refined, reduced-motion-safe)

- Layout switch / expand-collapse: 250ms position tween (cubic-bezier
  `.2,.7,.2,1`); reduced-motion → instant.
- Hover/select: 120ms halo + edge brighten (already in v2 §4.5).
- Stale repo: 2s slow pulse on the repo cluster (dimmed under reduced-motion).
- No perpetual simulation in the default layouts (deterministic = static after
  settle), which itself removes the "jumpy" feel.

---

## 5. Surfaces & controls (the user controls the graph)

### 5.1 The graph canvas (primary)

The main SVG/Canvas area. v2 already has zoom/pan/warm-up/edges/staleness;
v3 adds aggregation + semantic zoom + layout switch + neighborhood highlight.

### 5.2 Controls panel (Obsidian-style, refined) — NEW

A collapsible panel (default collapsed to a single `⚙` button; `c` toggles;
draggable width) with grouped controls — *not* a debug drawer:

- **Layout**: `Cluster | Tree | Radial | Force` (segmented). "Force" expands
  force sliders (repel / link distance / center / collision) like Obsidian's
  Forces section.
- **Filter**: by kind (vault/note/repository/module/package/entryPoint/…),
  by provenance (human/agent/generated), "orphans" toggle, "internals" toggle
  (hide `gitState`/`external`), "recent" (last N days). Each is a chip; active
  chips are filled. Filtered-out clusters can be hidden or shown dimmed.
- **Aggregation**: "expand all / collapse all", an "auto-expand on hover" toggle,
  and a depth slider ("show to depth N").
- **Search**: scored `searchNotes` (v2 §5.2) with a result dropdown; matching
  nodes are highlighted and their ancestor clusters auto-expand.

### 5.3 Detail panel (right side) — v2 §5.3, refined

Tabs Overview | Body | Links | Backlinks. v3 additions:
- When a **cluster** is selected, Overview shows the aggregate (counts,
  provenance split, top children, health) instead of a single node's meta.
- "Expand this cluster" / "collapse" buttons in the panel header.
- `/open/<slug>` (open-in-editor) unchanged.

### 5.4 Status strip (top) — v2 §5.4, refined + branded

One branded line: **logo mark** + `weave view` wordmark + counts (human/agent/
generated mini-bars) + repo staleness + "indexed 3m ago" + layout name.
Provenance split is clickable → drills into a filtered view (v2 open question,
resolved yes in v3). The header is the brand home; the controls panel is the
steering wheel.

---

## 6. Interactions & shortcuts

| Input | Action |
| --- | --- |
| `click` node | select + open Detail |
| `dblclick` / `f` | expand/collapse a cluster; for a leaf, focus its 1-hop neighborhood |
| `Shift+click` / `Shift+enter` | expand cluster recursively (all) |
| `+` / `-`, wheel | zoom (semantic; label/detail scales per §3.2) |
| `drag` node | reposition (pins; persisted) |
| `drag` canvas | pan |
| `1`/`2`/`3`/`4` | Cluster / Tree / Radial / Force layout |
| `c` | toggle controls panel |
| `/` | focus search |
| `p` | cycle provenance filter |
| `i` | toggle internals |
| `o` | toggle orphans |
| `e` | expand selected / `E` expand all · `Collapse` key collapse all |
| `r` | refresh (rebuild from disk) |
| `g` | exit focus / back to overview |
| `Esc` | precedence: search → close panel → exit focus → (no quit; it's a browser tab) |
| `?` | shortcuts help overlay |
| `Space` | toggle the selected cluster's expand state |

All mouse actions have keyboard equivalents (a11y, §10). Esc does not quit
(it's a browser tab) — the TUI's `q`/Esc-quit has no analog here.

---

## 7. Data model — client-side aggregation, zero core change

Aggregation is **view state**, not model state. Everything is derived
client-side from the existing `GraphModel` (mirrors v2 §7 / §16's "zero core
change"):

- Clusters = nodes that have outgoing `contains`/`anchored-at` edges to
  >threshold children; their aggregate (count, provenance split, top children,
  health) is computed from `model.nodes` + `model.edges`.
- Expand state = a client `Set<nodeId>` of expanded clusters; hidden leaves =
  children of collapsed clusters. The render reads this set, not the model.
- Semantic-zoom band = a function of camera scale + node count in view.
- Position persistence = `localStorage` keyed by cwd-hash → `Map<nodeId,
  {x,y}>`; the §16 `seedPositions` already handles "reuse survivors, seed new"
  — v3 seeds from `localStorage` first, phyllotaxis second.

This protects the identical-JSON no-op polling invariant (aggregation is pure
view; a no-op rebuild changes nothing) and keeps core untouched.

---

## 8. Architecture & maintainability

- `page.ts` stays a **single self-contained HTML string** with one contiguous
  `<script>` block (v2 §8). No backtick, no `${` (CI guard stays).
- New pure helpers are extracted into the `// ===== pure =====` block and
  extract-and-run tested (v2 §13 / §16.5):
  `clusterAggregate(model, expanded)`, `clusterLabelPolicy(zoom, degree,
  selection)`, `labelCollision(positions, labels, priority)`,
  `semanticZoomBand(scale)`, `expandChildren(model, clusterId)`,
  `persistedPositions(cwdHash, localStorage)`, `tweenPositions(from, to, t)`,
  `bundledEdges(edges, visible)`.
- The render loop: deterministic layouts compute positions once (cached by
  layout + expanded-set + model-version); force mode runs the §16 sim; both
  feed the same paint path. A single `requestAnimationFrame` tween handles
  layout switches and expand/collapse.
- Canvas vs SVG: v2 uses SVG. With aggregation keeping visible node counts low
  (tens, not hundreds), SVG stays fine. If profiling shows pain in force mode
  with many expanded nodes, a `<canvas>` paint layer is a *deferred* option
  (§14) — not v3.1.

---

## 9. Performance & scope

- **Visible nodes drop from ~hundreds to ~tens by default** (clusters), so the
  sim/paint is dramatically cheaper than v2's "everything at once." This is the
  performance win *and* the legibility win — same change.
- Deterministic layouts are O(n log n) for the visible tree; recompute only on
  expand/layout/model change, cached otherwise.
- Force mode (opt-in) still uses §16's already-tuned sim + collision; with
  fewer visible nodes it's faster than today.
- `localStorage` persistence: debounced 300ms writes; key is cwd-hash; capped
  at the model's node set (drops removed ids on load).
- Notes cap unchanged (`DEFAULT_MAX_NOTES = 500`); repo side bounded by
  structure. Aggregation means the cap rarely bites visually.

---

## 10. Accessibility

- Provenance/kind never color-only (ring + glyph + shape) — kept from v2.
- **Cluster vs leaf** is conveyed by shape (rounded-rect cluster vs the kind
  shape) + a count badge + the expand chevron, not color alone.
- Keyboard: every layout/filter/expand action is a key; clusters expand via
  `enter`/`Space`; focus order follows the visible (expanded) tree; `Tab`
  reaches controls. SVG nodes keep `tabindex`+`role="button"` (v2 §6/§10).
- Reduced-motion: all tweens instant; no perpetual sim in deterministic layouts.
- Contrast verified for both themes (v2 §4.4 tokens reused).
- Labels: the collision pass *hides* labels for density, but the Detail panel
  always shows the full name + meta, so information is never *lost* — just not
  piled on the canvas.

---

## 11. Security (unchanged + one note)

- All v2/§16 guarantees retained (escape-first md, `javascript:` refusal,
  loopback CSP, traversal-safe `/note/<slug>`, no-backtick/`${`).
- **`localStorage`** stores only `{nodeId: {x,y}}` — no content, no paths
  beyond the model's own ids, no code. Malformed/corrupt entries degrade to
  "ignore + reseed" (never crash). Origin-bound (loopback), so it's local-only.
- Wiki-link navigation still resolves through the safe `/note/<slug>` path.
- `/open/<slug>` shell-out policy unchanged (v2 §5.3/§11).

---

## 12. Milestones

| M | Contents | Exit check |
| --- | --- | --- |
| **M1 — Aggregation core** | `clusterAggregate`, expanded-set state, cluster node render + count badge, hide collapsed leaves; default first paint = clusters only | graph opens on a 100-node repo showing ~10 clusters, no leaves; click expands a cluster in place |
| **M2 — Deterministic layouts + persistence** | Cluster/Tree/Radial layouts (reuse §16 helpers) as defaults; layout switch tween; `localStorage` per-repo position persistence + reset | switch layouts without jumps; reload keeps positions; force is opt-in |
| **M3 — Semantic zoom + labels** | zoom-band label policy, quadtree label collision, mid-ellipsis truncation, neighborhood edge highlight/fade | zoom in → labels reveal with no overlaps; no "solid text" cluster at any zoom |
| **M4 — Controls panel** | collapsible refined panel (layout/filter/aggregation/search); chip filters; scored search with auto-expand | steer the graph without devtools; every control is also a key |
| **M5 — Branding + polish** | branded status strip (logo + wordmark + counts), cluster health ticks, motion pass, help overlay | reads as a product; a11y + reduced-motion pass |
| **M6 — Hardening** | extract-and-run tests for all new pure helpers; no-backtick/`${` guard green; `npm run check` ≥95% | gate green; manual smoke at 50/200/500 nodes |

Force-mode force-sliders ship with M1 (reuse §16 sim) but aren't the default.

---

## 13. Testing

- **Core:** unchanged.
- **Page pure helpers** (extract-and-run, behavior tests — v2 §13 / §16.5):
  `clusterAggregate` (counts/provenance split/top-children on hand-built
  models; filter respects collapsed), `clusterLabelPolicy` (zoom bands +
  degree priority), `labelCollision` (higher-priority wins, O(n log n)
  correctness on small sets), `semanticZoomBand` thresholds, `expandChildren`
  (one-level vs all; collapse reverses), `persistedPositions` (save/load/drop
  removed/ corrupt-ignore), `tweenPositions` (endpoints + reduced-motion
  instant), `bundledEdges` (parallel-edge merge + opacity).
- **Invariant tests:** identical-JSON no-op rebuild → no reheat, no position
  move, no aggregation change (extends §16's no-op test). No-backtick/`${` guard
  stays green.
- **Server:** unchanged (`/open/<slug>` tests stay).

---

## 14. Non-goals (explicit)

- **Community detection / Louvain clustering** — structural (containment)
  aggregation is enough and is a tested, no-new-dep, no-new-algorithm path.
  Auto-community is a *possible* future "semantic cluster" toggle, not v3.1.
- **A canvas renderer** — SVG + aggregation keeps counts low; canvas is a
  deferred perf option only if profiling forces it.
- **Editing in the viewer** — read-only; `/open` is the only shell-out.
- **New dependencies** (d3, cytoscape, graphology) — never; formulas ported
  into the hand-rolled page, exactly as §16 did.
- **Replacing the §16 force sim** — it's reused as the opt-in "Force" layout.
- **Session-scope knowledge** — out of scope (v2 §14).

---

## 15. Open questions (need your input before implementation)

1. **Default first paint — clusters, or clusters-with-top-notes-expanded?**
   I propose **clusters only** (cleanest, kills the hairball on first sight).
   If you'd rather see your notes immediately, the default could auto-expand
   the `vault` cluster. Your call.
2. **Aggregation axis — structural (containment) only, or also a "by kind /
   by provenance" cluster toggle?** I propose structural-only for v3.1 (cheap,
   honest, matches the repo's real shape). A "group notes by tag/provenance"
   cluster mode is a nice future toggle but adds a clustering policy — defer?
3. **Controls panel default state — collapsed (`⚙` button) or open?** I lean
   **collapsed** so the graph is the hero (Obsidian hides its controls behind a
   cog too). Confirm?
4. **Position persistence scope — per-repo (`localStorage` keyed by cwd hash)
   or one global layout?** I propose **per-repo** (a workspace's spatial map
   is repo-specific), matching the TUI v2 workspace decision (per-project).
5. **Force mode prominence — keep it as a 4th layout tab, or demote it to an
   "advanced" toggle?** I lean **4th tab** (discoverable, the §16 work is good),
   clearly labeled "physics." Confirm?
6. **Truncation style — mid-ellipsis (`src…slug.ts.summary.md`) vs head-trunc
   with full name in tooltip?** I propose mid-ellipsis (keeps prefix +
   extension). OK?
7. **Should cluster nodes be draggable/pinnable like leaves, or anchored
   (move only on layout switch)?** I propose **draggable + pinnable**
   (consistency), with layout switch re-tweening from pinned positions.