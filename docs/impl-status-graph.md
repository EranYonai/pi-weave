# impl-status-graph.md — browser force-graph fixes (weave-view §16)

Implements `docs/weave-view-tui-v2.md` **section 16** (fixing the jumpy &
crowded browser force graph) for the **browser viewer** (`src/pi/viewer/page.ts`).
The TUI (`src/pi/viewer/tui/**`) is untouched — this is the spatial graph that
lives in the HTML page.

Branch: `feat/weave-view-graph-v2`.

## What is done

**Tier A — stop the jump**
- Positions persist across poll/rebuilds via a `posMap` keyed by the stable
  node id: survivors reuse their coords, only NEW ids get seeded on a
  deterministic phyllotaxis spiral (`seedPositions`), removed ids are dropped.
- Delta-aware reheat: identical JSON is already a polling no-op (no reheat,
  no movement); small delta → `alpha = max(alpha, 0.05)`; large delta /
  explicit rebuild → `alpha = 0.5` (`deltaAlpha`). Never a full 1.0 reset.
- User-pinned nodes (`fixed`) persist across ticks *and* rebuilds (drag writes
  `posMap`; `buildScene` restores `fixed`).

**Tier B — kill the crowding**
- Real collision force: radius `7 + min(6, sqrt(deg)*1.2)` (`collideRadius`),
  border-to-border, `iterations = 2`/tick, anticipated positions (`x+vx`)
  to reduce jitter. Replaces the old 22px floor.
- Repulsion-by-degree (`degreeRepulsion = (deg1+1)(deg2+1)/4`, normalized so a
  leaf-leaf pair keeps ~original strength): leaves pack near hubs instead of
  scattering to the periphery.
- Degree-weighted gravity so disconnected islands pack without imploding into
  the center.

**Tier C — kill the jiggle + labels**
- ForceAtlas2 swinging/traction local speed (`localSpeed`): each node's
  displacement is scaled by `1/(1 + SWING_K*sqrt(swing))` from the change in its
  force vs the previous tick; one global tolerance constant `SWING_K`.
- Label fade threshold (`labelVisible`): labels hidden below a camera zoom or
  for low-degree nodes; revealed on hover/selection/zoom-in.

**Tier D (partial) — structural alternative**
- Layout toggle in the header (`#layout`): `force` (default) / `radial`
  (concentric by degree, `radialLayout`) / `tree` (layered containment DAG,
  `treeLayout`). Deterministic; switching to radial/tree places nodes directly
  with no physics; switching back to force re-simulates.

## TODO (not done)

- **Focused-neighborhood default first paint** (Tier D overlap with Cytoscape
  "subgraph-by-default"): the viewer still opens on the whole graph; it does
  not yet auto-select a node and show only its 1-hop with "show all" on `g`.
  Deferred — it changes first-paint UX and was not needed for A–C + the layout
  toggle to be green.
- No Barnes-Hut, no Louvain/auto-clustering, no edge bundling, no new
  dependency — all deliberately out of scope per §16.4.

## Testing

New pure helpers are extract-and-run tested (behavior, not string markers):
`seedPositions`, `collideRadius`, `degreeRepulsion`, `localSpeed`, `deltaAlpha`,
`radialLayout`, `treeLayout`, `labelVisible`. The existing real-`tick` physics
test now injects the pure block so `tick()`'s helper dependencies are in scope.

`npm run check` (typecheck + `vitest --coverage`) is green.
