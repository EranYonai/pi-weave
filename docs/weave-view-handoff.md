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


------
GPT input:
Yes — that changes the product direction substantially.

I would make **the notes workspace the product**, and treat the graph canvas as one of several views that can be embedded alongside notes. The `.okf` knowledge graph is the underlying model, but the user's primary interaction is **reading, writing, connecting, and navigating knowledge**.

The existing handoff already points toward shared view-models and reusable graph knowledge; I think we should push that philosophy much further. 

## The mental model

Think:

**Obsidian + IDE + Granola + spatial canvas**

but with one important principle:

> **Everything useful should be visible without opening another screen.**

Not:

> click note → open note → click relationship → go back → open file.

Instead:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 🕸 PI-WEAVE       Search ⌘K       + New note       ⌘P Command       ⋯        │
├───────────────┬──────────────────────────────────────┬───────────────────────┤
│               │                                      │                       │
│ NOTES         │             WORKSPACE                │   CONTEXT             │
│               │                                      │                       │
│ ▾ Architecture│  ┌────────────────┐ ┌────────────┐ │  model.ts             │
│   Graph model │  │                │ │            │ │  ─────────────────    │
│   Viewer      │  │  Markdown      │ │   Graph    │ │                       │
│   TUI         │  │  Preview       │ │            │ │  Dependencies         │
│               │  │                │ │     ●      │ │  → current.ts         │
│ ▾ Decisions   │  │                │ │   ╱ │ ╲    │ │  → types.ts           │
│   Layout      │  │                │ │  ●──●──●   │ │                       │
│   Pixi        │  │                │ │            │ │  Dependents            │
│               │  └────────────────┘ └────────────┘ │  ← tui/model.ts       │
│ ▾ TODO        │                                      │                       │
│   Scan        │  ┌────────────────────────────────┐ │  📝 Notes             │
│               │  │ Related notes                  │ │  3 related            │
│ 🔍 Filter     │  │ Graph architecture             │ │                       │
│               │  │ Rendering decisions             │ │  [Open in editor]     │
├───────────────┴──────────────────────────────────────┴───────────────────────┤
│ 12 notes · 127 nodes · 438 relations                  ⌘K Search   ⌘Enter Open │
└──────────────────────────────────────────────────────────────────────────────┘
```

But crucially, **those panels are not fixed**.

---

# 1. Everything is a panel

I'd make the entire UI based on a **tilable / dockable panel system**.

Panels could be:

* 📝 Note
* 📚 Notes
* 🕸 Graph
* 📁 Repository
* 🔗 Relations
* 🧠 Summary
* 📜 Git history
* 💻 Source
* 🔍 Search
* 🗺 Overview
* 🏷 Tags
* 📝 Backlinks

And the user can arrange them.

For example:

### Notes-centric

```text
┌───────────────┬──────────────────────────────────────────────┐
│ NOTES         │ NOTE                                         │
│               │                                              │
│ Architecture  │ # Graph Architecture                         │
│ Decisions     │                                              │
│ TODO          │ The graph model represents...                │
│ Ideas         │                                              │
│               │ ## Design                                    │
│               │ ...                                          │
│               │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

### Investigation

```text
┌──────────────┬───────────────────────┬────────────────────────┐
│ NOTES        │ SOURCE                │ RELATIONS              │
│              │                       │                        │
│ Graph model  │ model.ts              │ imports                │
│              │                       │ current.ts             │
│ TODO         │ class GraphModel      │ types.ts               │
│              │                       │                        │
│              │                       │ used by                │
│              │                       │ tui/model.ts            │
├──────────────┴───────────────────────┴────────────────────────┤
│ GRAPH                                                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Architecture exploration

```text
┌───────────────┬───────────────────────────────────────────────┐
│ NOTES         │                                               │
│               │                  GRAPH                         │
│ Architecture  │                                               │
│ Viewer        │                    ●                           │
│ TUI           │                 ╱  │  ╲                        │
│               │              ●────●────●                      │
│               │                                               │
│               │                                               │
├───────────────┼───────────────────────────────────────────────┤
│ REPOSITORY    │ NOTE                                           │
│ src/          │ # Viewer architecture                          │
│ core/         │ ...                                            │
└───────────────┴───────────────────────────────────────────────┘
```

Same application. Different workspace.

---

# 2. Notes should behave like documents, not list items

This is important.

The left panel isn't merely:

> list of markdown files

It should be a **live knowledge navigator**.

Something like:

```text
NOTES

⌕ Search notes...

RECENT
  📝 Graph architecture
     updated 2m ago

  📝 Pixi renderer
     updated yesterday

PINNED
  📌 Product vision

ARCHITECTURE
  📝 Graph model
  📝 Viewer
  📝 TUI

DECISIONS
  📝 Use d3-force
  📝 Pixi rendering

TODO
  ☐ Expensive repository scan
  ☐ Notepad skill
```

And importantly, **preview on hover/selection**.

No need to open a new page.

---

# 3. Markdown preview should be immediate

I agree strongly with your "glance" principle.

A note panel should support:

```text
┌─────────────────────────────────────────────┐
│ Graph Architecture             ✎ Edit       │
├─────────────────────────────────────────────┤
│                                             │
│ # Graph Architecture                        │
│                                             │
│ The graph represents the repository as a   │
│ knowledge model rather than a file tree.   │
│                                             │
│ ## Principles                               │
│                                             │
│ • semantic zoom                             │
│ • cluster aggregation                       │
│ • persistent positions                      │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ Related                                 │ │
│ │ 🕸 Graph model                           │ │
│ │ 📝 Viewer architecture                  │ │
│ │ 💻 src/core/graph/model.ts              │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Markdown isn't just formatting.

**Links in Markdown become navigation primitives.**

If a note says:

```markdown
The graph is built by [buildCurrentGraph](...)
```

clicking it should reveal the relevant source / graph node **without destroying the current workspace**.

---

# 4. Split view should be trivial

Every panel should have:

```text
┌───────────────────────────────────────┐
│ Graph Architecture       ⋯  ⛶  ×     │
```

`⋯`:

```text
Move
Split right
Split down
Float
Pin
Duplicate
Close
```

But also keyboard shortcuts.

For example:

* `⌘\` split
* `⌘⇧\` split vertically
* `⌘W` close panel
* `⌘⇧[` / `]` move focus
* `⌘1..9` switch panel
* `⌘P` panel picker

This is where the IDE influence becomes useful.

---

# 5. Panels should be persistent

This is particularly important for Pi-Weave.

The workspace itself becomes part of the knowledge model.

For example:

```text
pi-weave
└── workspace
    ├── notes panel
    ├── graph panel
    ├── source panel
    └── relations panel
```

When I return tomorrow, Pi-Weave should remember:

> "I was investigating the viewer architecture."

Not reset me to the default graph.

Store workspace state keyed by repository:

```text
.okf/
  knowledge.okf
  workspace.json
```

Or equivalent.

---

# 6. “Glance” means information density

I'd deliberately avoid huge cards and excessive whitespace.

You want **dense but calm**.

For a selected note:

```text
Graph Architecture

Architecture / Viewer
Updated 12 min ago

The browser viewer is a spatial representation
of the repository knowledge graph.

TAGS
#architecture #viewer #pixi

LINKS
→ Graph Model
→ Cluster Aggregation
→ Layout

MENTIONS
src/core/graph/model.ts
src/pi/viewer/

RELATED
📝 Pixi renderer
📝 Layout decisions
📝 Repository scanning

GRAPH
  14 related nodes
```

That's the whole knowledge context **in one glance**.

The user shouldn't have to ask:

> "What else is related to this?"

Pi-Weave should already show it.

---

# 7. The graph becomes another panel

This is the conceptual change I'd make from my previous answer.

I previously treated:

> graph = world

I'd now make:

> **workspace = world**

and:

> **graph = one lens into the world**

You could have:

```text
             WORKSPACE
                 │
     ┌───────────┼────────────┐
     │           │            │
   Notes       Graph        Source
     │           │            │
     └───────────┼────────────┘
                 │
             Relations
```

All of these are views over the **same underlying knowledge model**.

That aligns very nicely with your existing idea of sharing `GraphModel` / view-model logic between interfaces. 

---

# 8. And this gives you a very powerful interaction

Suppose I click a note:

**Graph Architecture**

The application can automatically show:

```text
NOTE
Graph Architecture
      │
      ├── related notes
      │
      ├── referenced files
      │
      ├── referenced symbols
      │
      └── graph neighborhood
```

The graph panel automatically highlights the relevant nodes.

The source panel automatically shows the relevant file.

The relations panel shows the relationships.

**One click changes the context of the whole workspace.**

That's the "glance" experience I think you're describing.

---

# 9. I would also make the UI configurable by “workspace presets”

Rather than expecting users to manually build their perfect layout immediately:

### Default

```text
Notes | Note | Graph
```

### Writing

```text
Notes | Markdown editor
```

### Exploring

```text
Repository | Graph | Relations
```

### Investigating

```text
Notes | Source | Graph
```

### Reviewing

```text
Note | Source | Git
```

And:

**Save workspace**

```text
My investigation
My architecture view
My notes
```

These are essentially **saved layouts + panel state**.

---

# 10. The left side should feel like the “home”

I would visually communicate that notes are primary.

Not:

```text
PI-WEAVE
   Graph
   Notes
   Repository
```

but:

```text
PI-WEAVE

NOTES
  Recent
  Pinned
  All notes
  Tags

KNOWLEDGE
  Graph
  Repository
  Relations

TOOLS
  Search
  Git
```

Notes are first.

Graph is under **Knowledge**.

That subtle hierarchy communicates the product philosophy.

---

# 11. The most important architectural requirement

I'd design the frontend around a generic:

```ts
Panel
```

rather than:

```ts
GraphPanel
NotePanel
RepositoryPanel
```

conceptually.

Each panel has:

```ts
type Panel = {
    id: string
    type: PanelType
    title: string
    state: unknown
}
```

And:

```ts
type Workspace = {
    layout: LayoutTree
    panels: Panel[]
}
```

So the workspace engine knows nothing about graphs or Markdown.

Then:

```text
Workspace
   │
   ├── Panel: Notes
   │      └── NotesView
   │
   ├── Panel: Markdown
   │      └── MarkdownView
   │
   ├── Panel: Graph
   │      └── PixiView
   │
   ├── Panel: Source
   │      └── SourceView
   │
   └── Panel: Relations
          └── RelationsView
```

This will make the UI **far easier to extend**.

---

## So I'd revise the product definition to:

> **Pi-Weave is a visual knowledge workspace for a codebase.**
>
> Notes are the primary interface. The repository graph, source code, relationships, Git state, and generated summaries are contextual views that can be arranged around the user's current knowledge task.

And the key UX principle:

> **Don't make the user navigate to information. Bring related information into the current workspace.**

That, IMO, is the direction that makes Pi-Weave substantially more interesting than "a nice PixiJS code graph."

And it fits your `.okf` concept extremely well: the `.okf` isn't just storing a graph — it becomes the **persistent knowledge layer from which all these panels derive their views**.
