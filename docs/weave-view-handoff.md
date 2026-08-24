# weave-view (browser) — design handoff

> Status: the in-browser graph viewer (`/weave-view` in a browser) has been **retired** from the
> tree (see commit after `cef1177`). `/weave-view` now opens the in-terminal explorer (TUI). The
> browser viewer is being rebuilt from scratch on **pixi.js**. This note is the handoff for the
> next agent: what the last attempt was, what went wrong, what to improve, and what to research.
>
> The retired code is preserved in git history at commit `cef1177` (`src/pi/viewer/page.ts`,
> `server.ts`, `browser.ts` + `tests/pi/viewer.test.ts`) — read it there for reference, do not
> restore it. The TUI (`src/pi/viewer/tui/`) is alive and unaffected.

## What the last attempt was

A single-file, zero-dependency browser viewer: one self-contained HTML template literal
(`page.ts`, ~2400 lines) served by a loopback-only `node:http` server (`server.ts`). Inline CSS+JS,
tight CSP, no external resources, no backticks/`${` in the rendered output (a CI source-guard
checked this). A ForceAtlas2-style force simulation rendered to SVG `<g>`/`<line>` nodes+edges,
with v3 cluster aggregation (collapse subtrees into cluster nodes, expand on click), semantic
zoom bands, label collision, edge bundling, and position persistence in localStorage.

The last session removed the cluster/tree/radial layout *selector* (physics became the only
layout), seeded the sim from the cluster hierarchy, replaced a hard one-screen clamp with a soft
boundary, and made springs scale with containment fanout. **All unit tests passed (671, 95% branch
gate) but the live layout was visually broken** — see below.

## What went wrong (verified headlessly, no screenshots)

After warm-up, the **5 top-level cluster nodes collapsed onto a vertical line at `x = W/2`
exactly, spreading only along y** (≈ ±400px around center). A graph, not a ring. Measured via
`getBoundingClientRect` on visible `g.node` elements: all 5 had `transform translate(640, …)` —
identical x to the pixel, distinct y. Min pairwise distance was fine (~149px, no overlap), so it
wasn't a hairball; it was a **degenerate 1-D equilibrium**.

### Root cause (mechanism)

The force code (gravity, repulsion, collision) is **x/y symmetric**, so a vertical line is not
forced by the equations — it's a metastable state the sim fell into and could not escape:

1. **Repulsion and collision cannot break a shared axis.** Both compute direction as `dx/d` and
   `dy/d`. When two nodes share an x (`dx = 0`), the x-component of the push is **exactly zero**
   (`0 / 0.001`). So once any pair aligns in x, nothing ever separates them along x again.
2. **Gravity then pins x to center.** With x-repulsion gone, the only x-force is gravity pulling
   to `W/2`, so every node's x converges to exactly `W/2`. Meanwhile y-repulsion (`dy ≠ 0`) keeps
   working, so y spreads into a line. The line is then **stable**: no x-force exists to break it.
3. **Anti-oscillation damping freezes it.** `localSpeed` (ForceAtlas2 swinging) shrinks a node's
   step when its force flips sign tick-to-tick. As nodes settle, x-velocities oscillate → damped
   to ~0 → x is frozen at `W/2` while y is still free. This locks the degenerate state in.
4. **Seed co-location makes it easy to enter.** `buildScene` co-locates a hidden leaf at its
   parent's *exact* seed position (`merged[pid] = {x: parent.x, y: parent.y}`) and nested clusters
   inherit parent positions too. Any exact co-location is a `dx=dy=0` pair → zero repulsion
   direction → the sim has no signal to separate them, so they drift together and align.

So: the sim can *enter* a line (via co-located seeds or transient alignment during collapse) and
has *no mechanism to leave it* (repulsion/collision are zero along a shared axis, damping freezes
x). The cluster-hierarchy ring seed (distinct x for 5 roots) was not enough — warm-up collapse
re-aligned them.

### Secondary issues found along the way

- **No symmetry breaking anywhere.** No per-node jitter, no `d≈0` safeguard in repulsion or
  collision. The whole pipeline assumes nodes never share an axis, which the seed violates.
- **Force balance is fragile.** Repulsion (`520·deg/4` at degree ~60 → very strong) vs gravity
  (`0.0004·(1+deg·0.12)` → weak) means high-degree hubs *explode* outward until the soft boundary
  (1.6·max(W,H)) stops them — good for spread, but the interplay with the damping/freezing made
  the collapse-to-line failure mode hard to predict. Tuning constants blindly is not reliable.
- **No runtime verification in CI.** Unit tests cover pure helpers + source guards but **not the
  actual simulation dynamics**. The layout was "green" by every test yet visually broken. The
  bug only showed up under headless DOM measurement (node bounding boxes).

## What to improve (design goals for the rewrite)

1. **Make the layout provably non-degenerate.** Either (a) add deterministic symmetry breaking
   (per-node angular jitter, a hash-derived push direction when `d² < ε` in both repulsion and
   collision), or (b) use a layout algorithm with convergence guarantees that can't collapse to a
   line. Don't ship another "tuned constants" sim without a property test for spread (see §Verify).
2. **Seed from the hierarchy but never co-locate exactly.** Children should start on a tiny ring
   around the parent (deterministic angle, small radius), never at the parent's exact point.
3. **Add a dynamics smoke test to CI.** A headless test that builds the graph, runs N sim ticks,
   and asserts (a) bounding box exceeds one viewport in **both** axes, (b) min pairwise distance
   > node diameter, (c) no axis is degenerate (spreadX and spreadY both > threshold). This would
   have caught the vertical-line bug instantly. The project already has a headless path via the
   `/browse` skill (JS-eval only — **no screenshots**, per the hard constraint).
4. **Keep the single-file + tight-CSP + no-backticks invariant** if staying self-contained. It
   served the project well (zero deps, fast, sandboxable). pixi.js can still be vendored inline as
   a single bundled script if you want to preserve this — see research below.
5. **Decouple sim, rendering, and interaction.** In the retired code they were entangled in one
   2400-line template. The rewrite should separate: graph model (already in `src/core`), layout
   engine, renderer, and input/camera — each independently testable.

## What to research (pixi.js + graph layout)

The user wants the rewrite on **pixi.js** (WebGL/WebGPU 2D renderer). Research these before
writing the first line:

### Rendering: pixi.js
- **pixi.js v8** (current): scene graph, `Graphics`/`Mesh` for nodes/edges, `@pixi/graphics-extras`
  or custom `ParticleContainer` for 100s–1000s of nodes. WebGL fallback + WebGPU where available.
- **Text**: pixi's `Text`/`BitmapText` is heavier than SVG `<text>`; for graph labels, consider
  `HTMLText` or a DOM overlay for labels (pixi draws glyphs, DOM handles rich text + reflow). Decide
  the label strategy early — it drove a lot of complexity in the SVG version (label collision
  quadtree).
- **Hit-testing & interaction**: pixi `eventMode` for node hover/click; for large graphs consider a
  spatial index (RBush) rather than pixi's per-object hit testing.
- **Self-contained build**: can pixi be bundled into a **single inlined `<script>`** (no external
  fetch, tight CSP `script-src 'unsafe-inline'`)? Verify: `esbuild --bundle --format=iife` → one
  string, no `import`/backticks in output. If pixi is too large or fetches assets, the no-external-
  resource invariant breaks — decide explicitly whether to relax the CSP or vendor everything.
  This is a **go/no-go** question for the single-file approach.

### Layout: don't hand-roll force sim
The hand-rolled ForceAtlas2 variant is where the bug lived. **Prefer a battle-tested library** and
evaluate each for the degenerate-line failure mode:
- **`d3-force`**: the standard. `forceManyBody` (Barnes–Hut), `forceLink`, `forceCollide`,
  `forceX/forceY/forceCenter`. Crucially, d3-force **adds jitter** and handles `d≈0` by assigning a
  random direction (look at its `forceManyBody` source — it explicitly does `Math.random` on
  coincident points), which is *exactly* the safeguard our hand-rolled sim lacked. Strong default.
- **`force-graph`** (d3-force + canvas/WebGL renderer, supports pixi-ish perf): near turnkey for
  the "graph in a browser" use case; check if it meets the self-contained/CSP constraint.
- **graphology layout**: `graphology-layout-forceatlas2` (a maintained, correct FA2 with anti-
  collision + the same swinging/traction we tried, but *with* the symmetry-breaking safeguards) —
  usable headless to compute positions, then pixi just renders. Decouples layout from rendering
  (goal #5 above).
- For large/clustered graphs: **`forceatlas2` properties** (preventing "star" hairballs), and
  whether a **multi-level / coarsen-then-refine** layout (e.g. graphology `circular`/`random` seed
  + refine) gives better cluster separation than single-level FA2 for the 5-root + big-hub shape
  this graph has (one root has ~60 children — that's the hairball risk).

### The specific test case to design against
This repo's graph has **~5 top-level roots** (vault, repository, modules, git-state, external,
package) where **one root has ~60 containment children** (a module/file hub). That is the shape
that must look good: 5 distinct clusters, the 60-child hub's leaves spread on a wide ring (not a
hairball, not a line), and the whole graph spreading beyond one viewport (so pan/zoom finds
things). Use that as the fixture for the dynamics smoke test in §improve #3.

### Interaction model (carry over from the retired design — these were good)
- Semantic zoom bands (far/mid/near): labels and detail reveal as you zoom in.
- Cluster aggregation: collapse subtrees into a single cluster node, expand on click; this is
  what keeps 1000s of files readable. The aggregation logic (`clusterAggregate`) lives in the
  retired `page.ts` but is pure and portable — consider promoting it into `src/core` or a shared
  view-model so both the TUI and the pixi viewer use one implementation.
- Position persistence (localStorage, per-repo hash) — keep, it's cheap UX.
- Pan/zoom camera; edge bundling (containment skeleton + cross-link curves).

## Hard constraints to preserve (verbatim from the project owner)

- **"YOU DONT HAVE IMAGES CAPABILITIES, DONT LOAD IMAGES."** — never take screenshots; all
  browser inspection is text/DOM/JS-eval only (the `/browse` skill `js` command works).
- If keeping the single-file approach: the page is a self-contained HTML template literal with
  **ZERO external resources**, a **tight CSP**, and **no backticks / `${`** in the rendered output
  (the CI source guard in the retired `viewer.test.ts` enforced this; bring it back for the new
  page). No new runtime dependencies that can't be inlined.
- Stay on the `feat/weave-view-v3-design` branch lineage (or a fresh branch off it).

## Suggested first steps for the next agent
1. Resolve the **pixi single-file/CSP go/no-go** (research §Rendering) — this shapes everything.
2. Decide **layout engine** (research §Layout): recommend `d3-force` or `graphology-layout-
   forceatlas2` rather than a hand-rolled sim; the bug that killed the last attempt is a known,
   solved problem in both.
3. Add the **dynamics smoke test** (improve #3) *before* building UI — make "spread in both axes,
   no degenerate line, no overlap" a CI-checked property from day one.
4. Promote `clusterAggregate` out of the retired `page.ts` into a shared pure module so the TUI
   and the pixi viewer share one graph-reduction implementation.

## Pointers
- Retired code (reference only): `git show cef1177 -- src/pi/viewer/page.ts`.
- TUI (alive, shares the same `GraphModel`): `src/pi/viewer/tui/`, esp. `model.ts` (pure
  view-model: `listTree`, `focusNeighborhood`, `deriveBacklinks`) and `run.ts`.
- Graph model: `src/core/graph/model.ts`, `src/core/graph/current.ts` (`buildCurrentGraph`,
  `readNoteForView`, `readOkfFileForView`).
- OpenNote (editor-open helper, moved out of the retired server): `src/pi/viewer/tui/openNote.ts`.