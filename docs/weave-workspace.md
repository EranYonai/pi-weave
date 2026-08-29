# weave-workspace — the browser knowledge workspace

> Status: **P0, P1, P2 and P3 are built and green; P4–P5 are still design.** This doc supersedes `docs/weave-view-handoff.md` (post-mortem
> of the retired SVG viewer, kept as a stub pointing here). It is the plan of record for `/weave-view`. §16 is the two-minute summary of
> where things stand.
>
> Scope: a local web workspace over the same `GraphModel` the TUI already uses. Notes are the product; the graph is one column of it.
>
> Where the build diverged from the plan, this doc has been reconciled to describe **what exists**, with the reasoning preserved — §2 (the
> `shared` tier is fully core-free, not "core types only"), §13 (the web default flipped in P1, not P3), §11 (phase status), and §15 (the
> debt the build actually produced). Sections describing unbuilt work say so.

## 0. Verdicts

Every decision below is settled with evidence, so it does not get relitigated mid-build. Measurements were taken against published npm
artifacts (minified dist, gzip -9) on 2026-08-24.

| # | Decision | Verdict | Why |
| --- | --- | --- | --- |
| V1 | Graph renderer | **sigma.js v3** (not pixi.js) | Pixi is a renderer, not a graph library — with pixi we still hand-roll camera, hit-testing, label collision, semantic zoom. That is exactly the surface that broke last time. Sigma ships all of it. 46 KB gzip vs 225 KB; **0** `new Function` vs 5; no blob workers. |
| V2 | Layout engine | **d3-force** (not graphology-layout-forceatlas2) | d3-force is the only candidate with verified coincident-node symmetry breaking (`jiggle`, §7.2). FA2's `iterate.js` has **no** jiggle — it carries the same blind spot that produced the vertical line. d3's seeded LCG also makes layout deterministic, which the CI dynamics test depends on. |
| V3 | Graph model (client) | **graphology** | Sigma's native model; 13 KB gzip. Used as a *render-side projection only* — `src/core/graph/model.ts` stays the single source of truth (§7.1). |
| V4 | UI framework | **Preact + @preact/signals** (7 KB gzip) | 9× smaller than React for identical semantics. Signals give us the cross-column context sync with no store boilerplate. |
| V5 | Markdown | **marked + DOMPurify** (22 KB gzip) | Both zero-dependency. `markdown-it` is 46 KB with 6 deps. We render untrusted-ish local content into the DOM, so sanitizing is not optional. |
| V6 | Layout model | **One fixed layout**, not a panel engine | Tree │ Note │ Graph. No presets, no dockable tiling, no `workspace.json`. §1.2. |
| V7 | Editing | **Read-first**; editing is phase P5 | Core has no update/rename/delete, and the front-matter parser silently drops unknown fields. A browser save today would destroy user properties. §11 P5. |
| V8 | Liveness | **fs.watch (debounced) → SSE → refetch** | Requires a cache first: `buildCurrentGraph` reads every note *twice per call* (§4.1). |
| V9 | Build | **esbuild devDep, committed bundle, CI drift check** | Installing pi-weave still needs no build and keeps zero runtime deps. §9. |
| V10 | Editor component | **`<textarea>` at P5**, CodeMirror 6 only if it earns it | CM6 is 118 KB gzip — more than the entire rest of the client. Defer. It is fully CSP-clean when we want it. |

### 0.1 The measurements

| Package | Version | min | **gzip** | `new Function` | `import()` | Blob worker |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| sigma | 3.0.3 (2026-04-30) | 183 KB | **46 KB** | 0 | 0 | 0¹ |
| graphology | 0.26.0 | 71 KB | **13 KB** | 0 | 0² | 0 |
| d3-force (+quadtree, dispatch, timer) | 3.0.0 | 15 KB | **5 KB** | 0 | 0 | 0 |
| preact + @preact/signals | 10.29.x | 20 KB | **7 KB** | 0 | 0 | 0 |
| marked + dompurify | 18.x / 3.4.x | 69 KB | **22 KB** | 0 | 0 | 0 |
| **client total** | | | **~93 KB** | **0** | **0** | **0** |
| — rejected — | | | | | | |
| pixi.js | 8.20.0 | 799 KB | 225 KB | **5** | 3³ | **yes** (×9) |
| cytoscape | 3.34.1 | 425 KB | 133 KB | 0 | 0 | 0 |
| force-graph | 1.51.4 | — | — | — | — | 15 runtime deps |
| codemirror (meta) | 6.x | 368 KB | 118 KB | 0 | 0 | 0 |

¹ Sigma's single `createObjectURL` is in the **SVG-snapshot export** path only (`new XMLSerializer()… Blob… createObjectURL`). We do not
call it; if we ever add "export as image", it needs `img-src blob:` and nothing else. ² graphology's `import(` hits are methods named
`import`, not dynamic imports. **This is now executable rather than a claim in a doc.** P3 put graphology in the bundle and the blanket
`/\bimport\s*\(/` ban in `tests/web/build.test.ts` duly went red on two occurrences — `Graph.prototype.import(e, n = !1)` and the
`i.import(e)` that calls it. A `\b` word boundary cannot tell a method from a dynamic import, because `.` is itself a non-word character and
therefore a boundary; the distinguishing fact is the *preceding* character (a member call is preceded by `.`, a declaration by
`function`/`class`/`;`/`{`, a real dynamic import by an operator, a bracket or nothing). So the test classifies each hit instead of banning
the substring, and asserts **both** halves: zero dynamic imports, and a **non-zero** method count — the second assertion is what stops the
first from passing vacuously if the classifier ever mislabels everything. ³ Zero in the prebuilt `dist/pixi.min.mjs`; 3 in the package entry
point.

Ecosystem health (npm, last week): d3-force 21.6M · cytoscape 14.8M · graphology 1.55M · pixi.js 1.01M · force-graph 797k · sigma 290k ·
graphology-layout-forceatlas2 290k. All MIT.

**The as-built baseline, phase by phase.** The ~93 KB above is the *projected* total once every dependency is in play. That projection has
now been paid in full, and the growth is recorded here so it stays measurable rather than decorative:

| | raw | **gzip** | Bundled packages |
| --- | ---: | ---: | --- |
| `dist/app.js` as of P1 | 39.7 KiB | **14.8 KiB** | `preact`, `@preact/signals`, `@preact/signals-core` |
| `dist/app.js` as of P2 | — | **44.8 KiB** | + `marked`, `dompurify` (§0 V5) |
| `dist/app.js` as of **P3** | **318.4 KiB** | **93.0 KiB** | + `sigma`, `graphology`, `graphology-utils`, `d3-force`, `d3-quadtree`, `d3-dispatch`, `d3-timer`, `events` |

93.0 KiB gzip is **62 % of the 150 KiB budget** (§14), and it matches the §0.1 projection of ~93 KB almost exactly — the measurements were
right. Licences, from the generated banner: MIT for preact, signals, graphology, graphology-utils, marked, sigma and `events`; ISC for the
four d3 packages; `MPL-2.0 OR Apache-2.0` for dompurify. `events` is the one package the projection did not anticipate — it is a browser
shim graphology's `EventEmitter` pulls in, and it is licence-cleared in `scripts/build-web.mjs` like the rest.

Measured by `npm run build:web:check`, which prints both figures on every run and is the number to quote. The banner block at the top of
`dist/app.js` is generated from esbuild's metafile, so the bundled set is always readable from the artifact itself — and a package in the
bundle but absent from the licence table fails the build.

### 0.2 Why pixi lost, precisely

The handoff mandated pixi. That was the right instinct — *"stop hand-rolling"* — aimed at the wrong layer. The retired viewer's bug was not
in drawing; it was in **simulation and graph semantics**. Pixi replaces the drawing and leaves every broken part in our hands:

| Capability | sigma | pixi |
| --- | --- | --- |
| Camera / pan / zoom | built in | write it |
| Node hit-testing | built in (`getNodeAtPosition`) | write it (or add RBush) |
| Label rendering + collision | built in (`labelGrid`) | write it |
| Semantic zoom | `labelRenderedSizeThreshold` | write it |
| Neighborhood highlight | `nodeReducer` / `edgeReducer` | write it |
| Layout | — (bring d3-force) | — (bring d3-force) |
| CSP cost | none | `'unsafe-eval'` or the `pixi.js/unsafe-eval` polyfill import, plus `worker-src blob:` |

Choosing pixi would mean re-writing, by hand, the five things that made the last attempt 2400 lines — at 2.4× the byte cost and with CSP
concessions. Sigma is the battle-tested package for *this* problem.

Revisit only if we measurably exceed sigma's comfort zone (tens of thousands of nodes). §7.5 keeps that swap cheap.

**One sigma default we refuse: `autoRescale`.** Sigma's default recomputes the graph→viewport normalization from the *moving extent* on
every repaint — and a drag repaints every frame. The moment a dragged node crossed the extent boundary (the edge of the view), the whole
graph rescaled under the cursor: the view "suddenly made a distance", the node read as dragged very far from the centre while the user
chased it, and node sizes shrank with every frame. The renderer now freezes the view onto a `setCustomBBox` computed from the rendered
positions — on mount, on every `setGraph` (a shape change legitimately changes the extent) and on `[fit]` (which re-frames onto the
*current* positions, dragged nodes included) — and never while the simulation settles, so a drag's coordinates are stable for its whole
gesture and the canvas itself bounds how far a node can be pulled. `graph.model.ts`'s `frameBox` is the pure half; the renderer wires it.

---

## 1. Product frame

### 1.1 What this is

> pi-weave is a knowledge workspace over your vault and your repository. **Notes are the product.** The graph, the source tree, and the
> relations are lenses onto the same `.okf` knowledge.

And the UX principle that decides arguments:

> **Don't make the user navigate to information. Bring related information into the current view.**

Concretely: selecting anything, anywhere, updates every column at once. No "click through, then go back".

### 1.2 One layout

There is exactly one layout. No presets, no dockable panel engine, no saved arrangements, no `workspace.json`.

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ 🕸️ pi-weave        ⌘K search…                    vault:34 · repo:fresh · 127 nodes      ⟳ ●  │
├────────────────────┬──────────────────────────────────┬──────────────────────────────────────┤
│ TREE               │ NOTE                             │ GRAPH                                │
│                    │                                  │                                      │
│ ▾ vault (34)       │ Graph Architecture               │            ●───●                     │
│   Graph model      │ ─────────────────────────────    │           ╱     ╲                    │
│   Viewer         ◂ │ human · updated 12m ago          │      ●───●   ◉   ●───●               │
│   TUI              │ #architecture #viewer            │           ╲     ╱                    │
│ ▾ repository       │                                  │            ●───●                     │
│   ▾ src/core       │ The browser viewer is a spatial  │                                      │
│     graph/         │ representation of the repository │  ◉ selected  ● neighborhood          │
│     vault.ts       │ knowledge graph.                 │                                      │
│   ▾ src/pi         │                                  │  [fit] [expand] [depth 1 ▾]          │
│     viewer/        │ ## Principles                    │                                      │
│                    │ • semantic zoom                  ├──────────────────────────────────────┤
│ [◧ all] [◧ notes]  │ • cluster aggregation            │ CONTEXT                              │
│                    │                                  │ LINKS      → Graph model             │
│ ⌕ filter…          ├──────────────────────────────────┤            → Layout                  │
│                    │ 3 links · 2 backlinks · 14 nodes │ BACKLINKS  ← Viewer architecture     │
└────────────────────┴──────────────────────────────────┴──────────────────────────────────────┘
```

Three resizable columns (drag dividers, widths in `localStorage`), a context rail under the graph, a header, a status bar. Below 1100 px the
graph column collapses to a toggle; below 800 px the tree does too. That is the entire layout system.

**Why not the panel engine.** A tiling engine with saved workspaces is a genuinely large subsystem — split trees, focus management, drag
targets, serialization, migration — and it is the part of an IDE users configure once and never touch. It would dominate the build and delay
every feature that makes the product good. One well-tuned layout that always shows tree + note + context beats a configurable one that
starts empty. If real usage proves a second arrangement is needed, `src/web/client/shell/` is where it goes — but we ship the opinionated
layout first.

### 1.3 The context bus is one signal

No event bus, no pub/sub. Preact signals:

```ts
// src/web/client/state.ts
export const selectedId  = signal<string | null>(null);   // the graph node id, everywhere
export const graph       = signal<GraphModel | null>(null);
export const noteBody    = signal<ViewNote | null>(null);  // derived: fetched when selectedId is a note
export const treeState   = signal<TreeState>(initialTreeState());
export const connection  = signal<"live" | "reconnecting" | "offline">("live");
```

Selecting in the tree, clicking a graph node, following a wikilink, and hitting a search result all write `selectedId`. The note column, the
graph highlight, and the context rail are computed from it. That is the whole "context bus" — approximately 40 lines.

---

## 2. Module layout

A new portable tier. Core purity (AGENTS.md rule 3) is preserved and extended.

```text
src/core/                    portable knowledge engine — no harness, no web, no DOM
  view/                      NEW: pure view-models, shared by TUI and web (§3)
  cache/                     NEW: mtime-keyed workspace cache (§4.1)

src/web/                     NEW tier
  shared/                    isomorphic: wire types, layout algorithm. No node:*, no DOM.
    wire.ts                  request/response contracts
    layout.ts                d3-force → positions. Pure. Runs in Node (tests) and browser.
    view.ts                  the one legal door onto src/core/view (§2.1). Re-exports only.
  server/                    node-only. May import src/core and src/web/shared.
    server.ts  routes.ts  security.ts  sse.ts  watcher.ts  page.ts
  client/                    browser-only. May import src/web/shared. NEVER src/core, NEVER node:*.
    main.tsx  state.ts
    shell/      header, columns, resizer, statusbar
    tree/  note/  graph/  context/  search/
    dist/app.js              committed build artifact (§9)

src/pi/                      adapter: registers /weave-view, boots the server
  viewer/tui/                unchanged; now imports view-models from src/core/view
```

**Import rules** (enforced by a test, like the existing core-purity check):

| Tier | May import | Must never import |
| --- | --- | --- |
| `src/core/**` | node builtins, itself | `@earendil-works/*`, typebox, `src/web`, `src/pi`, any npm UI dep |
| `src/web/shared/**` | itself, `d3-force`, the **node-free core modules** (§2.1) | `node:*`, DOM globals, `src/pi`, the rest of `src/core` |
| `src/web/server/**` | node builtins, `src/core`, `src/web/shared` | DOM, `src/web/client`, `@earendil-works/*` |
| `src/web/client/**` | `src/web/shared`, `preact` / `@preact/signals` | `node:*`, `src/core`, `src/pi` |
| `src/pi/**` | everything | — |

The client cannot import `src/core` because core is Node-flavoured TypeScript that would drag `node:fs` into the bundle. That has not
changed and is not negotiable: the client row above is exactly as strict as it was. What §2.1 narrows is the *shared* row — a proven
node-free subset of core may be re-exported through `src/web/shared/view.ts`, and the client reaches it through that door and nowhere else.
Everything else both sides need is still a **type** in `src/web/shared/wire.ts` (and `shared/graph.ts`) or a pure function in
`src/web/shared/`.

`tests/web/tiers.test.ts` is the executable form of this table. It absorbed the former `tests/core/purity.test.ts`, walks every tier
directory, **resolves** each specifier rather than pattern-matching it, and checks the result against a per-tier allowlist of tiers, npm
packages, node builtins and node/DOM globals. A tier directory that does not exist yet passes vacuously; a file under `src/` that no tier
claims fails the suite. The npm column is an allowlist on purpose — adding sigma in P3 is a one-line, reviewable edit there in the same
commit. The graph-walking machinery lives in `tests/web/importGraph.ts`, shared with `tests/web/view.purity.test.ts` so the two guards
cannot disagree about what is reachable; the *rules* stay in `tiers.test.ts`.

### 2.1 The lesson: `import type` is a bundler distinction, not a compiler one

This table originally said `src/web/shared/**` may import `src/core` **types only**, with the reasoning that `import type` erases at compile
time and therefore cannot drag `node:fs` into the browser bundle. That reasoning is true and it is *not sufficient*, and finding out cost a
broken build.

Type erasure protects the **bundle**. It does nothing for the **typecheck**. To resolve `GraphModel`, TypeScript must load
`src/core/graph/model.ts`, which imports `../types`, and the compiler walks that entire transitive closure. Under `tsconfig.web.json` —
which deliberately sets `"types": []` and a `lib` with no node types, precisely so a stray `node:fs` fails typecheck rather than review —
every `node:*` in that closure is an error. One `import type` line produced **24 errors**. The tier rule was being enforced in exactly the
sense it was not written to check.

Worse, the violation arrived *transitively*: `src/web/client/api.ts` reached core through `src/web/shared/wire.ts`. Both hops were
individually legal under a single-hop rule, and both single-hop checks were green. The guard now walks the **closure**, which is the claim
this table was always making.

So the rule became literal rather than aspirational: **nothing under `src/web/shared/` imports `src/core` at all.** The wire DTOs are
declared *structurally* in `src/web/shared/graph.ts` (`WireGraphModel`, `WireGraphNode`, `WireViewNote`, …), and `src/web/shared/wire.ts`
re-exports them under the names the client and server use. That remains true of the wire types, for the design reason given below — but the
blanket form of the rule has since been narrowed, and §2.1.1 is the record of that reversal.

The obvious cost of a copy is drift, so **drift is a compile error**. `tests/web/wire.contract.test.ts` asserts *mutual assignability*
between every wire DTO and its core counterpart, using a type-level `Exact<A, B>` witness that only typechecks when `A extends B` and `B
extends A`. That test is Node-side, where importing core is legal and free, and it is enforced by `tsc --noEmit` rather than at runtime —
almost nothing in the file executes. Add a field to core's `GraphNode` and the test stops compiling until `graph.ts` agrees, which is
exactly the moment a human should decide whether the field belongs on the wire. Answering "no" is allowed: narrow the wire type deliberately
and relax the assertion to a one-directional `Extends` with a comment. What must never happen is the two shapes diverging silently.

The runtime enumerations (`WIRE_NODE_KINDS`, `WIRE_EDGE_KINDS`) get element-for-element equality checks against core's `NODE_KINDS` /
`EDGE_KINDS`, because a *value* can drift without a type error — core gains a kind, the union assertion forces `graph.ts` to add it, and the
array is still forgotten, producing a legend with a missing colour and no failing test anywhere.

There is also a real design payoff, independent of the build failure. `GraphModel` is an *internal* core type, free to change shape whenever
core needs it to. What crosses an HTTP boundary is a **contract**, and a contract that silently reshapes itself whenever an internal type is
refactored is not a contract. Declaring it separately makes a core change that would break the client a visible, deliberate edit.

### 2.1.1 The narrowing: a node-free closure is the case §2.1 was not considering

> **This reverses part of a documented decision.** §2.1 says "nothing under `src/web/shared/` imports `src/core` at all". That is now
> "`src/web/shared/` may import the `src/core` modules proven node-free, and only through one door". The paragraphs above are kept verbatim
> rather than edited, because the failure they describe is real and the reasoning that produced the blanket rule is worth reading before
> reading why it was too wide.

**Why the blanket rule was too wide.** §2.1 was written while reasoning about *node-flavoured* core. `GraphModel` was reached via a path
whose neighbours read the filesystem and spawn git, and the 24 errors were the closure of `src/core/graph/current.ts` — `vault.ts`,
`git.ts`, `paths.ts`, `repoIndex.ts`, `summaries.ts` — arriving in a project with no node lib. The conclusion drawn ("core is unreachable
from shared") is correct *about that closure* and was generalised to core as a whole, which is a category the evidence did not support.

`src/core/view/` is a different object. Its entire transitive closure is eleven modules:

```text
src/web/shared/view.ts
  → src/core/view/{tree,detail,focus,links,time,types}.ts
    → src/core/graph/model.ts → src/core/types.ts
```

Zero `node:*` imports, zero node globals, zero npm dependencies, pure functions over plain data. Verified by compiling that closure under
`--lib ES2022,DOM --types [] --strict`: clean. These modules are genuinely browser-portable; only the blanket rule stood in the way.

**What the blanket rule cost.** §3's entire purpose is that the TUI and the browser share **one** implementation of the tree, detail and
focus projections — "TUI and web can never drift, because there is one implementation". Under the blanket rule the browser's only options
were to re-implement `treeRows` and `detailModel` in the client tier, or to have the server pre-render rows and ship them over the wire. The
first is the drift §3 was promoted to prevent. The second makes the wire contract carry view-model output, which reshapes every time a
column changes. Both are worse than the exception.

**The rule, precisely.** `src/web/shared/view.ts` re-exports — never wraps — a named subset of the view-models. `tests/web/tiers.test.ts`
encodes the permission as a **module allowlist** (`NODE_FREE_CORE_MODULES` in `tests/web/importGraph.ts`), not a directory one:

| | Reachable from `src/web/shared/` | Why |
| --- | --- | --- |
| `core/view/{tree,detail,focus,links,time,types}.ts` | ✅ | Pure projections over `GraphModel`. §3's shared implementation. |
| `core/graph/model.ts`, `core/types.ts` | ✅ | Their type closure. Data declarations only. |
| `core/view/{health,cluster}.ts`, `core/view/index.ts` | ❌ | Node-free, but unused by the browser today. The barrel is excluded *because* it re-exports these. |
| `core/vault.ts`, `git.ts`, `repoIndex.ts`, `summaries.ts`, `paths.ts`, `cache/`, `graph/current.ts` | ❌ | Read the filesystem or spawn git. The original 24 errors. |

Spelling it as "shared may import core" would re-open the exact hole §2.1 closed, so it is spelled as eight file paths. Adding a ninth is a
visible edit with a purity proof attached — P3's graph column will add `clusterAggregate`, `focusNeighborhood` and `degreeOf` in the commit
that first calls them.

The client row of the §2 table is **unchanged**: `src/web/client/**` still may not import `src/core`, even a node-free module, even
transitively. It goes through `shared/view.ts`. `tiers.test.ts` asserts that too ("reaches core only through `src/web/shared/view.ts`"),
because a permission attached to a door is auditable and a permission attached to eight files scattered across a tier is not.

**What makes the exception sound rather than convenient.** Two guards, both in `tests/web/view.purity.test.ts`:

1. **Runtime.** It walks the transitive closure from `shared/view.ts` and fails on any `node:*` import, any node global (`process`,
   `Buffer`, `__dirname`), any npm specifier, or any module from a tier the browser may not bundle. The core portion of the closure is
   asserted **equal** to the allowlist in both directions, so a module sneaking in fails *and* a stale permission nobody uses fails.
2. **Type-level.** `tsconfig.web.json`'s `include` now covers `src/web/shared/**/*.ts`, so `npm run typecheck` compiles the closure with
   `"types": []` and a node-free `lib` — the same check that produced the 24 errors, now aimed at this path on purpose. The suite asserts
   the `include` entry covers the door and that `types`/`lib` have not been loosened, because an `include` that silently stopped matching
   would be a total, invisible loss of coverage.

Both halves are needed. The text scan cannot see a type-level dependency on `@types/node` (a bare `NodeJS.Timeout` annotation imports
nothing); the typecheck cannot see a global read that the DOM lib happens to permit. Verified by mutation: adding `import { readFileSync }
from "node:fs"` to `core/view/tree.ts` fails both halves; a `process.env` read in `core/view/time.ts` fails the global check; an `import
type { ViewNote } from "../graph/current"` in `core/view/links.ts` drags `vault`/`git`/`paths`/`repoIndex`/`summaries` into the closure and
fails with all fourteen `node:*` chains named.

**What would make this wrong again.** Stated explicitly, because a reversal without a reversal condition is just a preference:

- **A `node:*` import, node global, or npm dependency lands anywhere in the closure.** Then the closure is not node-free and the premise is
  gone. The guard fails first, so the choice is to move the offending logic out of `core/view/` or to remove that module from the allowlist
  — not to relax the guard.
- **The allowlist grows into filesystem-adjacent territory.** Each addition needs the same proof. A `core/view/` module that wants to read a
  file is a signal the projection belongs in `core/cache/` or on the server, not that the door should widen.
- **The door acquires logic.** The purity suite requires `shared/view.ts` to be nothing but `export … from` lines. The moment it holds a
  wrapper it is a second implementation, and §3's no-drift guarantee — the whole justification — is void.
- **`tsconfig.web.json` stops covering `src/web/shared/`, or gains `"types": ["node"]`.** The type-level half is the one that caught the
  original failure; without it the runtime scan is guarding half the surface.
- **A second door appears.** Two `src/web/shared/` files importing core directly is the "both hops individually legal" shape that produced
  the original bug. The guard is written against one door for that reason.

If any of these becomes true and cannot be fixed, the correct response is to revert to §2.1's blanket rule and pay for a second
implementation of the view-models in the client — with the drift cost stated in the PR, not discovered later.

---

## 3. Promote the view-models (highest-leverage move)

`src/pi/viewer/tui/model.ts` is 1010 lines of **pure, harness-free, already-tested** view-model logic: `treeRows` (the tree), `detailModel`,
`focusModel`, `deriveBacklinks`, `degreeOf`, `relTime`, `healthModel`, `graphRoots`, `countProvenance`. It imports only core types.

It is in the wrong place. Move it:

```text
src/core/view/tree.ts        treeRows, TreeRow, TreeState, listLabel, treeEmptyHint
src/core/view/detail.ts      detailModel, DetailModel, DetailLinkRow
src/core/view/focus.ts       focusModel, focusNeighborhood, degreeOf
src/core/view/links.ts       deriveBacklinks, (NEW) deriveDanglingTargets, (NEW) deriveTagIndex
src/core/view/health.ts      healthModel, countProvenance
src/core/view/time.ts        relTime
src/core/view/cluster.ts     (NEW) clusterAggregate, ported from the retired page.ts
src/core/view/types.ts       shared row/meta types (TreeMeta &c.) — type-only, hence the one coverage exclusion
src/core/view/index.ts       barrel
```

**Built in P0.** `TreeRow.meta` is now structured (`TreeMeta`) rather than a pre-truncated terminal string, as §3 required, and every module
above is at 100% coverage.

`src/pi/viewer/tui/model.ts` keeps only the TUI-specific parts (`ExplorerState`, `Action`, `reduce`, `sanitizeTerminalText`,
`mergeAfterRefresh`, theme glue) and re-exports the rest so no TUI file changes.

Payoff: the web tree column is `treeRows()` with a different renderer — already covered by tests. The context rail is `detailModel()`. The
graph's neighborhood highlight is `focusNeighborhood()`. TUI and web can never drift, because there is one implementation.

The browser reaches all of this through `src/web/shared/view.ts`, which re-exports the subset the columns actually use. §2.1.1 records why
that door is a legal exception to §2.1's "shared never imports core" and what would make it illegal again.

**Constraint:** these must stay free of terminal concepts. `TreeRow.meta` is currently a pre-truncated string sized for a terminal column.
Change it to structured data (`{ kind: "relTime", iso } | { kind: "count", n, unit }`) and let each renderer format it. That is the only
behavioural change in the move; everything else is a file move plus import rewrites.

---

## 4. Core gaps to close

Each is a task with its own tests. All are in `src/core`, all are useful to the TUI too.

### 4.1 `WorkspaceCache` — the blocker for liveness

`buildCurrentGraph(cwd, vaultRoot)` today, per call:

1. `listNotes()` — reads and parses **every** note serially;
2. `Promise.all(map(getNote))` — reads and parses **every note again**;
3. `noteCount()` — a third readdir;
4. `findGitRoot` + `assessStaleness` — ~5 git subprocesses + sha1 of every dirty file;
5. `readRepoIndex` (4 JSON reads) + `readSummaryMap` (readdir + every summary file).

That is ~2N file reads plus 5 process spawns for one graph. With SSE pushing on every file event, this becomes the bottleneck immediately.

```ts
// src/core/cache/workspace.ts
export interface CacheStats { notesRead: number; notesCached: number; gitCalls: number; builtAt: string; }

export class WorkspaceCache {
  constructor(opts: { cwd: string; vaultRoot: string; now?: () => Date });
  /** Cached graph. Re-reads only notes whose mtime+size changed. */
  graph(): Promise<GraphModel>;
  /** Invalidate a path (from the watcher). Scope inferred from the path. */
  invalidate(absPath: string): void;
  /** Invalidate everything (repo scan landed, vault root changed). */
  invalidateAll(): void;
  stats(): CacheStats;
}
```

Design: a `Map<slug, { mtimeMs, size, note }>`; `listNotes` becomes a stat-only pass and only changed entries are re-read. Staleness is
cached with a 2 s TTL (it spawns git). `graph()` coalesces concurrent callers into one in-flight promise. Target: no-change rebuild does
**zero** note reads and **zero** git spawns.

**Snapshot reuse (added with §15.6).** A build that proves nothing moved returns the *identical* `WorkspaceSnapshot` object rather than an
equal one. `buildGraph` is pure and byte-deterministic, so the rebuild could only have produced a deep-equal copy — skipping it removes the
last per-request cost (graph construction itself, which the mtime cache never addressed), and the stable identity is what lets the server
memoize the serialized payload and its ETag digest in a `WeakMap`. Reuse requires *all* of: no note read, no note vanished, an unchanged raw
`.md` count, the repository side served from its TTL rather than re-assessed, and no invalidation landing mid-build.

While here, fix the double read in `buildCurrentGraph` itself — steps 1 and 2 read the same files twice even without a cache. `listNotes`
should return enough to build the graph, or the builder should take pre-read notes.

### 4.2 Dangling link targets — ✅ **built**

`buildGraph` used to count dangling links and discard the names (`detail["dangling links"] = "3"`). Obsidian shows unresolved links as ghost
nodes you can click to create, which needs the names. `GraphModel` now carries `danglingLinks: Record<string, string[]>` (slug → unresolved
targets); `detail` keeps the count, because that is what the TUI's side panel prints, and does **not** grow structure. Notes with nothing
unresolved are absent from the map rather than present-and-empty.

The wire model is declared one field narrower than core here: `GraphPayload` hoists this to its own top-level `dangling`, so the map does
not cross the wire twice. `tests/web/wire.contract.test.ts` enforces the narrowing as an `Omit`, so a *second* core field added and
forgotten still fails to compile.

### 4.3 Tag index — ✅ **built**

`src/core/view/links.ts`:

```ts
export interface TagIndex { tag: string; slugs: string[]; }
export function deriveTagIndex(notes: readonly TaggedNote[]): TagIndex[];  // count desc, tag asc
```

**Source: notes, not the graph.** The graph flattens tags to a comma-joined display string, and recovering an array from it means re-parsing
`detail` into structure — exactly what §4.2 forbids, and lossy besides (a tag containing a comma round-trips wrong). The alternative, making
`GraphNode` carry a real `tags: string[]` next to the display string, would put the same fact on the node twice and grow the wire model for
every note. Notes are the upstream source of truth and both callers already hold them, so deriving from notes costs no extra I/O and keeps
one representation of a tag.

`TaggedNote` is `{ slug, tags }` — the §4.3 signature widened to its actual requirement, so a `NoteSummary` or a full `Note` both satisfy
it. Ties break by **codepoint**, not `localeCompare`: this output is hashed into a cache key, and `localeCompare` varies with the host
locale and the runtime's ICU build.

Because the index must agree with the graph about which notes exist, `WorkspaceCache.snapshot()` returns the model and the notes it was
built from — already truncated to `DEFAULT_MAX_NOTES` — from a single build. Pairing `graph()` with a separate vault read would let the cap
fall between them and produce a tag naming a slug with no node.

### 4.4 `mentions` edges — ✅ **built**

Implemented in `src/core/graph/mentions.ts`: a cheap path regex over note bodies, no parsing, no LLM, no new dependency. Candidates resolve
against a `PathIndex` derived from the same `RepoStructure` arrays `buildRepositorySide` walks, so **every** emitted edge targets a node
that exists — a mention of an unindexed path creates nothing rather than a phantom.

**Granularity: exact match, else the longest enclosing module — never downward.** The asymmetry is the whole design:

- *Never downward.* "see `src/core`" is **one** edge to `module:src/core`, not one per file beneath it. Fanning a prefix out downward is how
  a three-word sentence becomes forty edges.
- *Upward, at most one step.* `src/core/graph/build.ts` resolves to `module:src/core`. Most repo files are not graph nodes, so
  exact-match-only would drop the majority of genuine references and leave the feature looking broken. The walk is restricted to
  **modules**: "inside `package.json`" is not a relationship.

Each distinct mentioned path therefore contributes at most one target, and same-module mentions dedupe, so a note's edge count is bounded by
the distinct paths it names and usually far below that. URLs and email-like tokens are excluded by a lookbehind — without it every GitHub
link in every note becomes a candidate.

### 4.5 `engines`

Raise `"node": ">=20"` → `">=20.13.0"`. Recursive `fs.watch` on Linux landed in 20.13.0; below that it throws
`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. macOS and Windows have had it since v7. Alternative is feature detection with a walk-based fallback —
more code, and 20.13 is two years old. Raise the floor.

---

## 5. The server

### 5.1 Security — four layers

The retired server bound loopback and stopped there. `git show cef1177:src/pi/viewer/server.ts` has **zero** matches for `token`, `Origin`,
or `Host`. Loopback alone does not protect you: every process on the machine can reach it, and so can any website the user visits, via DNS
rebinding.

```ts
// src/web/server/security.ts
const token = randomBytes(32).toString("base64url");         // 1. 256-bit, per session
server.listen(0, "127.0.0.1");                               // 2. loopback, ephemeral port

// 3. Host allowlist — DNS rebinding cannot forge this header
const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
if (!HOSTS.has(req.headers.host ?? "")) return deny(res, 403);

// 4. Origin — absent on same-origin GET navigations, so require it only on writes
const origin = req.headers.origin;
if (origin && !ORIGINS.has(origin)) return deny(res, 403);
if (req.method !== "GET" && !origin) return deny(res, 403);
```

Token handoff: open `http://127.0.0.1:PORT/?t=TOKEN` once → server verifies with `timingSafeEqual` → sets `Set-Cookie: __Host-weave=…;
HttpOnly; SameSite=Strict; Path=/; Secure`¹ → `302` to `/`. The token leaves the address bar (and therefore `Referer` and shell history)
immediately. Every later request, including SSE, carries the cookie automatically — which matters because `EventSource` cannot set headers.

¹ `__Host-` requires `Secure`, which browsers accept on `http://127.0.0.1` because loopback is a [secure
context](https://w3c.github.io/webappsec-secure-contexts/). Verify in Chrome, Firefox and Safari during P1; fall back to a plain
`weave_token` cookie name if any browser disagrees.

No CORS headers, ever. One server per pi session; a second `/weave-view web` focuses the existing one.

### 5.2 CSP

```
default-src 'none';
script-src 'nonce-{N}';
style-src 'nonce-{N}';
img-src 'self' data:;
connect-src 'self';
font-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Per-response nonce. No `'unsafe-inline'`, no `'unsafe-eval'`, no `blob:`. Asserted by a test that fetches `/` and parses the header (§10).

### 5.3 Routes

| Method | Path | Response |
| --- | --- | --- |
| GET | `/` | HTML shell: nonce'd inline CSS-variable theme, `<script nonce src="/app.js">`, a bootstrap `<script type="application/json">` |
| GET | `/app.js` | The committed bundle. `Cache-Control: no-store` (it changes on rebuild). |
| GET | `/api/graph` | `GraphPayload` — the wire model (below) |
| GET | `/api/note/:slug` | `NotePayload` — `{ note, revision }` (P5; it was a bare `ViewNote` through P4) |
| POST | `/api/note/:slug` | update → `NotePayload`, or `409` (P5) |
| POST | `/api/note/:slug/rename` | rename → `NotePayload`, or `409` |
| DELETE | `/api/note/:slug` | `{ deleted: true }`. Hard delete — the vault has no trash. |
| GET | `/api/okf/:rel` | `{ path, body }` |
| GET | `/api/search?q=` | `NoteSearchHit[]` |
| POST | `/api/open` | `{ slug }` → `openNoteInEditor`. The only write through P4. |
| GET | `/events` | SSE stream |

**The write routes and their status codes (P5).** `MutationResult` → HTTP is the one mapping `routes.ts` owns:

| Core result | Status | Body |
| --- | ---: | --- |
| `ok` | `200` | `NotePayload`, **re-read** so the revision describes the bytes just written rather than one inferred from the write |
| `reason: "missing"` | `404` | `ErrorPayload` |
| `reason: "conflict"` | `409` | `{ reason: "conflict", current: NotePayload }` — the whole current note, so the client can offer reload-or-overwrite with no second round trip |
| `reason: "collision"` | `409` | `{ reason: "collision", slug }` — the destination is taken |

One status for both failures, discriminated by `reason` in the body. They are the same *kind* of answer — the vault is not in the state you
thought it was — and the client's response to each is a question for the user, so two status codes would buy a distinction the HTTP layer
has no use for while making the client branch twice.

`SaveNoteRequest` is decoded through a field-by-field **allowlist**, which is a security control rather than ceremony: `updateNote` spreads
`meta` over the note's front matter, so anything that survives the decode reaches the file. Only `title`, `tags` and `source` are copied
(and `source` only when it is one of the three legal values). `created` is not the caller's to set and `updated` is the server's — a client
that could set the latter could make an edit look older than the state it overwrote.

`revision` rides in the **body**, not an `ETag`. `api.ts`'s `HttpResponse` port exposes `ok`, `status` and `json()` and nothing else,
because it exists so a two-line fake can stand in for `fetch` in a repository with no DOM (§10) — and, more to the point, the revision is a
property of the *note*, not of the HTTP representation, unlike `/api/graph`'s stamp, which really is a cache validator.

The wire model is **not** `GraphModel` verbatim — the graph is lossy (§Handoff findings): tags are a joined string, note bodies are absent,
dangling targets are discarded.

```ts
// src/web/shared/wire.ts
export interface GraphPayload {
  model: GraphModel;                          // nodes, edges, staleness, generatedAt
  tags: Record<string, string[]>;             // tag → slugs               (§4.3)
  dangling: Record<string, string[]>;         // slug → unresolved targets (§4.2)
  positions: Record<string, { x: number; y: number }> | null;  // server-computed layout, §7.3
  stamp: string;                              // content digest; ETag + SSE dedupe key
}
```

`stamp` is a **content digest of the serialized payload** — a SHA-256 truncated to 128 bits, hex-encoded. It is opaque: the only defined
operation is equality, and it guarantees exactly one thing, that two payloads share a stamp iff they serialize to the same bytes. That makes
conditional GETs correct: `If-None-Match` → `304` precisely when the client already holds these bytes.

The ETag is **strong** (no `W/` prefix), and honestly so — the digest is taken over the exact string written to the socket, so an equal
validator really does mean a byte-identical representation. Incoming `W/` prefixes are still stripped when comparing, because RFC 9110
mandates weak comparison for `If-None-Match` and an intermediary that weakened our tag should still get its `304`.

**As built (P2, unchanged by P3),** every route above exists and is covered, and only one field of `GraphPayload` still ships structurally
empty:

| Field | Ships as | Status |
| --- | --- | --- |
| `tags` | tag → slugs | **Populated** (§4.3). Built by `deriveTagIndex` from the notes in `cache.snapshot()`, never by re-parsing `detail.tags`. Key order is count-desc/tag-asc, preserved by `Object.fromEntries`. |
| `dangling` | slug → targets | **Populated** (§4.2). Hoisted from `GraphModel.danglingLinks` and stripped from `model` by `WIRE_MODEL_OMITTED_KEYS`, so it crosses the wire once. |
| `positions` | `null` | **By design, unchanged.** Server-side layout needs `src/web/shared/layout`, which imports `d3-force`, and the server tier's npm allowlist is empty (§9: zero runtime deps). The client runs the identical `shared/layout` code itself. |

`stamp` is a content digest as of §15.6 (resolved). `model.generatedAt` keeps its own, separate job — the human-facing "data as of" marker,
which is what the status bar renders. The two were the same string until the digest landed; conflating them is what made the cache key blind
to any edit that did not advance the timestamp maximum.

**Where it is computed.** `WorkspaceCache` returns the *identical* snapshot object while nothing on disk has moved, and `routes.ts` memoizes
`{body, etag}` against that identity in a `WeakMap`. A warm `/api/graph` is therefore a lookup: no rebuild, no `JSON.stringify`, and no
hashing — consistent with §4.1's "zero note reads, zero git spawns". The first request after a real change misses the memo and pays once.

### 5.4 Lifecycle

Started lazily by `/weave-view` (§13); stopped on `session_shutdown`, which used to be a documented no-op and no longer is — it closes the
server, which closes the SSE hub and awaits the watcher. Idle timeout: shut down 30 min after the last SSE client disconnects, clearing the
session's server slot so the next `/weave-view` boots fresh. Port is never fixed; always `listen(0)`.

---

## 6. Liveness

```text
fs.watch(vault, {recursive})  ─┐
fs.watch(repo/.okf, {recur})  ─┼─▶ debounce 80ms ─▶ cache.invalidate(path) ─▶ SSE {scope, stamp}
git HEAD/index poll (2s)      ─┘                                                    │
                                                                                    ▼
                                              client: refetch /api/graph (If-None-Match) ─▶ signals update
```

- **Debounce 80 ms**, coalescing paths into a scope set. macOS `fs.watch` coalesces and can miss rapid bursts, so events mean "something
  changed, re-read", never "here is the delta".
- **Ignore** `.git/` (except `HEAD` and `index`), editor swap files (`*.swp`, `*~`, `.#*`), and `4913` (vim's probe file).
- **SSE frames**: `{ "scope": "vault" | "repo" | "git", "stamp": "…" }`. The client refetches only the affected endpoints. Heartbeat comment
  every 20 s to defeat proxies and detect dead sockets.
- **`stamp` is the same content digest `/api/graph` serves as its ETag** (§5.3), and the server derives both from one function so they
  cannot drift. This is load-bearing rather than tidy: the client dedupes frames on `stamp` and already holds the stamp of the graph it last
  fetched, so while frames carried `generatedAt`, an edit that did not advance the timestamp maximum produced a frame the client discarded
  *before* it ever issued the conditional GET. Both layers failed for the same three cases; one shared key fixes both (§15.6).
- **Reconnect**: `EventSource` does it natively; the client shows `connection: "reconnecting"` in the status bar and refetches everything on
  reopen (it may have missed frames).
- **Self-writes**: `/api/open` and, later, editor saves must not cause a feedback loop. The cache marks a path as self-written for 200 ms.

---

## 7. The graph column

### 7.1 Pipeline

```text
GraphModel (core, authoritative)
      │
      ▼  src/web/shared/layout.ts        pure, no DOM, runs in Node
   d3-force ──▶ Map<id, {x, y}>          seeded LCG ⇒ deterministic
      │
      ▼  src/web/client/graph/project.ts
   graphology instance (render projection only — never edited, never a second source of truth)
      │
      ▼
   sigma renderer  ──  camera · hit-test · labels · reducers
```

`graphology` exists solely because sigma consumes it. Every mutation flows `GraphModel → projection`, never back. As built, the pipeline has
one more stage than the sketch: `graph/graph.model.ts` sits between the layout and `project.ts` and makes *every* decision — which nodes and
edges survive, colour, size, label, z-order, the dim rules and sigma's settings — so that `project.ts` is two loops with no opinions and
`renderer.ts` is a wire. That is §10's split, and it is what keeps the graph column's branches inside files a test can import.

**`multi: true` on the graphology instance is load-bearing, not a default.** graphology rejects parallel edges by **pair**, not by key, so a
simple graph *throws* the moment a second edge joins two nodes that are already joined. The model genuinely produces that shape: §4.4's
mention pass runs over the note body **independently of** the wikilink pass, so a note can both `links-to` and `mentions` the same module,
and `graph.model.ts` dedupes on `(source, target, kind)` rather than on the pair. Under `multi: false` the choices are a crash on real data
or silently discarding one of the two relationships — and the second is precisely the retired viewer's bug, "a link from a hidden file to a
visible note simply vanished" (§7.4).

The guard `multi: false` *looked* like it was providing is not lost, because it was never the one doing the work. `addDirectedEdgeWithKey`
still throws on a duplicate **key**, and `edgeKey` is `(source, target, kind)` — so a genuinely duplicated edge is still a loud mount-time
failure while two different relationships between one pair are still two edges. `multi` only ever governed the pair. Both halves are pinned
in `tests/web/client-graph.test.ts`: one test asserts two edges survive for `links-to` + `mentions`, another asserts a hand-forged duplicate
key still throws. The instance is also `type: "directed"`, because every kind in `WIRE_EDGE_KINDS` has a direction that means something —
`contains` is not symmetric and neither is `mentions` — and throwing the direction away at the projection would make an arrowhead a
re-derivation later.

`project.ts` deliberately does **not** re-validate what `renderGraph` guarantees (unique ids, unique keys, both endpoints present). A
second, quieter validation here would let a malformed model reach sigma with some of its edges silently missing, and "the graph drew but
three links vanished" is a far worse failure than a stack trace naming the id. `syncPositions` is the cheap path for a re-run — it writes
coordinates onto an existing projection instead of rebuilding, because `setGraph` would drop every WebGL buffer and reset the camera.
`positionsOf` is the one *read* from the projection, and it is not an exception to the rule: it exists so a re-run can warm-start from where
the graph currently is, and those values originated in `computeLayout`. Nothing user-authored ever enters the projection.

### 7.2 Why d3-force, mechanically

The retired sim collapsed to a vertical line because repulsion and collision compute direction as `dx/d`, `dy/d`; once two nodes share an
`x`, the x-component of the push is exactly zero forever, gravity pins x to `W/2`, and the anti-oscillation damping freezes it there.

d3-force fixes exactly this, in exactly those three forces:

```js
// d3-force/src/jiggle.js
export default function(random) { return (random() - 0.5) * 1e-6; }

// manyBody.js:67-68, 81-82   collide.js:50-51
if (x === 0) x = jiggle(random), l += x * x;
if (y === 0) y = jiggle(random), l += y * y;

// link.js:36-37
x = target.x + target.vx - source.x - source.vx || jiggle(random);
```

`random` is a **seeded LCG** (`lcg.js`: `a=1664525, c=1013904223, m=2^32`), not `Math.random`. So we get symmetry breaking *and*
reproducible layouts — which is what makes §8 a stable CI gate rather than a flaky one.

I checked the alternative: `graphology-layout-forceatlas2/iterate.js` contains **no** jiggle and no coincident-node special case. It would
reproduce our bug. Rejected.

**Big sibling branches get a second pass.** Single-centre gravity has a failure d3's example never faces: two blobs that share a root —
measured on this repository, a 195-node `module:.okf` and a 40-node `vfolder:sessions`, connected by almost nothing — interleave at the
same centre into one hairball (bounding-box gap **0** between their subtrees). When a model has depth-1 branches of ≥ 8 nodes
(`BIG_BRANCH_MIN`), the layout runs twice: pass 1 is the recipe unchanged (so the ring can measure each blob's *actual* spread), then every
branch is teleported onto its slot on a ring sized from those measurements — transport is arithmetic, not physics, because gravity alone
moved the smallest blob only 40 % of the way in 150 anchored ticks and the tick budget is a smoothness parameter, not a quality one — and
pass 2 relaxes the arrangement into place with each branch's gravity re-targeted onto its slot. The root group (roots, single notes, small
twigs) keeps the origin, preserving the no-component-escapes guarantee and the five-root separation the §8 gate asserts. Measured on the
real graph: gap **0 → 980** layout units between the summaries and sessions blobs; the gate lives in `layout.dynamics.test.ts`'s
sibling-blobs block over `tests/fixtures/graphShapes.ts`'s `siblingBlobsGraph()`. Graphs without big branches take the exact single-pass
path the §8 gate was written against. The live driver (`dynamics.ts`) seeds the same ring, so a released graph holds the separated
equilibrium instead of gliding back to one centre. The positions cache is versioned (`v2`) — the shape key cannot see a recipe change under
the same node and edge set, so the version is what discards the tangled `v1` arrangements.

### 7.3 Where layout runs

Server-side on first load (Node, ~300 ticks, tens of ms for this graph), shipped in `GraphPayload.positions`, so the graph appears already
laid out with no visible settling. The client re-runs the sim only on user drag or expand/collapse. `layout.ts` is identical code in both
places — that is why it lives in `shared/` and takes no DOM.

Seeding: none invented — d3 initializes nodes without positions on a deterministic phyllotaxis spiral, and the force-directed-tree recipe
(`forceLink` with `distance(0)` at full strength for containment, gentle `forceManyBody`, `forceX()`/`forceY()` centre gravity) does the
rest. New containment children on an expand start **at their parent's** warm position (d3's own collapse/expand pattern), and a warm
re-layout pins the nodes the client already positioned so the existing arrangement is the user's, not the sim's to re-mix.

**As built (P3): the layout runs client-side, and the cache replaces the server precompute.** `GraphPayload.positions` is `null` by design
(§5.3) — `shared/layout.ts` imports `d3-force` and the server tier's npm allowlist is empty — so the client runs the *identical* `shared`
code itself. That is exactly why the module lives in `shared/` and takes no DOM. The consequence §7.3 was trying to buy ("already laid out,
no visible settling") is bought instead by `src/web/client/graph/positions.ts`, and a cached layout is strictly *better* than a
server-computed one: it settles instantly **and** it is the arrangement the user already has a mental map of.

Four decisions in that file are worth stating, because each has a wrong-looking alternative:

- **The cache key is a digest of the graph's *shape* only.** `graphShapeKey(nodes, edges)` hashes which nodes and edges exist — never
  titles, tags, or `generatedAt`. Keying on the payload's `stamp` would invalidate on every edit, which is the same as not caching. The
  per-element hashes are combined by **XOR and sum** with the counts mixed in, so the key is order-independent (a reorder in core is not a
  layout change) while still able to see a duplicate, which XOR alone cannot (`x ^ x = 0`).
- **One storage slot, not one per shape.** `POSITIONS_STORAGE_KEY` is a single versioned `localStorage` entry holding `{v, key, at}` with
  coordinates rounded to one decimal. Accumulating a map per shape would put three multi-hundred-node position sets into a shared 5 MB
  budget to save a few hundred milliseconds on a switch back. Last graph wins.
- **A hit is used verbatim, never re-simulated from.** Re-running even from a perfect warm start moves every node slightly (§8 measures the
  drift as bounded but non-zero), so a user reopening the workspace would watch the graph shuffle for no reason — which is exactly the
  reshuffle §11 P3 forbids.
- **A key mismatch discards the whole slot rather than merging it.** The stored layout describes a graph with different nodes or edges in
  it, so it cannot be completed. A partial merge would place the old nodes and leave the new ones at the origin, which is the hairball §7.2
  exists to prevent. The same applies to a hit that is missing an id the current node set has: `resolveLayout` falls through to a real
  layout rather than dropping the node (which is what `renderGraph` would do with a missing position). Everything read back is untrusted —
  it lives in a devtools pane anyone can type into and it outlives the schema — so a bad version, a bad shape, a non-finite coordinate or an
  empty result all return `null` and lay out from scratch. There is no repair path, because a partially-repaired layout is a bug report that
  says "my graph is weird sometimes".

`shouldRelayout` is the rule for the case that is easy to get wrong in both directions: re-running on every payload makes the graph jump
whenever anyone saves a file, and never re-running leaves new nodes unplaced and therefore undrawn. The shape key is exactly that line — it
changes iff a node or an edge was added or removed. The viewport is deliberately *not* a layout parameter: sigma's camera fits whatever
extent it is handed, so feeding the real column width in would re-run the simulation on every divider drag to produce a picture the camera
immediately normalises away. A fixed nominal viewport is what makes the layout a function of the *graph*, and therefore cacheable at all.
`LAYOUT_TICKS` is 300 and `LAYOUT_SEED` is 1, matching §8's gate exactly — a different budget here would make the gate a statement about a
layout nobody renders.

### 7.4 What sigma gives us

| Need | Sigma API |
| --- | --- |
| Pan / zoom / fit | `camera`, `camera.animatedReset()`, `sigma.getCamera().animate()` |
| Hover / click | `on("enterNode" \| "leaveNode" \| "clickNode")` |
| Semantic zoom | `labelRenderedSizeThreshold`, `labelDensity`, `labelGridCellSize` |
| Neighborhood highlight | `setSetting("nodeReducer", …)` — return dimmed styles for nodes outside `focusNeighborhood(selectedId)` |
| Hide edges while moving | `hideEdgesOnMove: true` |
| Node colour by kind, ring by provenance | node attributes + a custom node program (only if the default is insufficient) |

Cluster collapse/expand is ours, but it is *graph reduction*, not rendering: `clusterAggregate` lives in `src/core/view/cluster.ts`,
unit-tested at 100%, shared with the TUI. **Built in P0**, and deliberately *not* a faithful port — the retired implementation was wrong in
two ways worth naming:

1. **Reduction, not masking.** The retired `clusterAggregate` computed a *visibility mask*: every node stayed in the graph, hidden ones got
   `display: none`, and no edge was ever rewritten — so a link from a hidden file to a visible note simply vanished. The version in core
   returns reduced node and edge arrays with boundary-crossing edges retargeted onto the standing-in cluster. A renderer should never be
   handed nodes it is expected to hide, and sigma in particular wants a graph it can consume verbatim (§7.1).
2. **Strict collapse.** The retired `reveal` recursed into *every* child cluster regardless of the expand set, gating only leaves — so
   collapsing `src/core` still drew all of its sub-clusters. That contradicts both the word "collapse" and `treeRows`, which recurses only
   into expanded nodes. Here a collapsed cluster hides its entire subtree, so the TUI tree and the web graph answer "what is visible?"
   identically.

Retained from the original: containment means `contains` **or** `anchored-at`; clusters are real model nodes rather than synthetic ones, so
ids stay stable and selection keeps working; and the per-cluster provenance rollup over all descendants. Dropped: the `expandChildren` /
`collapseChildren` set builders, which only re-walked the model to recompute what `ClusterInfo.descendants` already holds, and are each one
expression on the caller's side.

### 7.5 The renderer seam

The plan: `src/web/client/graph/renderer.ts` exposes a narrow interface — `mount`, `setGraph(nodes, edges, positions)`,
`setHighlight(Set<id>)`, `onSelect`, `fit`, `destroy` — with `SigmaRenderer` as the only implementation. If sigma ever stops being the right
answer, one file changes. This is handoff design goal #5 (decouple sim / rendering / interaction), satisfied structurally rather than by
discipline.

**As built, the seam is one interface plus an injected constructor, and the reason is measured rather than stylistic.** The literal shape
above — an interface, then a `createSigmaRenderer` in the same file that calls `new Sigma` — produces a file that reports **0 % coverage as
a whole, because no test can even import it**. Verified rather than assumed: `import Sigma from "sigma"` evaluates
`WebGL2RenderingContext.BOOL` at module scope while building its default program table, so in Node the import alone is a `ReferenceError`
before a line of ours runs. §10's rule is that untestable *lines* are kept to a handful, not that untestable *files* are excluded — the one
coverage exclusion that exists is a type-only module, and a blanket `src/web/client/**` exclude is explicitly "not acceptable". A whole
renderer outside the gate would be exactly the erosion that rule prevents.

So the dependency is inverted, and what exists is:

| | File | Coverage |
| --- | --- | ---: |
| `GraphRenderer` — the §7.5 interface | `renderer.ts` | — |
| `SigmaLike` / `CameraLike` — the six-method port sigma satisfies **structurally** (no cast, and a fake is an object literal) | `renderer.ts` | — |
| `SigmaFactory` — `new Sigma(graph, container, settings)` as a function type | `renderer.ts` | — |
| `sigmaRenderer(create, scheme)` — the entire renderer, written against the port | `renderer.ts` | **100 %** |
| `nullRenderer()` — a production null object, not a test double: the column renders before its container exists and may never mount at all | `renderer.ts` | **100 %** |
| `createSigma` / `createSigmaRenderer` — the adapter that names sigma | `renderer.dom.ts` | 0 % (lines 30–52) |

`renderer.ts` imports **no npm package at all**, which is what lets the root `tsconfig.json` project (no `DOM` lib) compile the tests that
import it; `RenderContainer` is a two-property structural stand-in for `HTMLElement` for the same reason, and the one cast lives in
`renderer.dom.ts`, compiled only by `tsconfig.web.json`. `tests/web/client-graph.test.ts` drives `sigmaRenderer` against a recording
`SigmaLike` fake and covers the lifecycle, the reducer installation, the idempotent mount and destroy, and the click wiring.

The untestable surface is therefore **~9 executable lines in one file** — an import, a type alias and two arrow functions — and **no
coverage exclusion was added for it**. Identical shape and identical reasoning to `api.dom.ts` for `fetch` and `domEventSource` for
`EventSource`. §7.5's promise is unaffected: "one file changes" is still true, and it is now true of a file with no branches in it.

**One deliberate deviation from the signature above: `setGraph` takes a `RenderGraph`, not a `(nodes, edges, positions)` triple.** The
triple would make every implementation re-derive colours, sizes and labels from raw wire nodes — i.e. it would put behind the seam exactly
the decisions §7.5 wants decoupled, in the one place tests cannot reach. Passing the already-decided model keeps the argument list at one
and keeps a second implementation, if there ever is one, honest. The seam also gained `setPositions` and `positions()`, because a re-run of
the simulation over an unchanged node set is the common case (drag, expand, resize) and rebuilding would drop the camera and every WebGL
buffer. `setHighlight(null)` is not the empty set: `null` means nothing is selected and everything renders normally, an empty set means
everything dims. The scheme is fixed at construction rather than settable — a `prefers-color-scheme` flip mid-session is rare enough that
rebuilding the renderer is the honest response, where a `setScheme` would be a second code path for a case nobody hits.

---

## 8. The dynamics smoke test — written first

Handoff improve #3, non-negotiable, and it lands **before any UI code**. The last attempt was green on 671 tests while visually broken,
because nothing tested the simulation's output.

```ts
// tests/web/layout.dynamics.test.ts     pure Node, no DOM, no browser
const positions = computeLayout(fixtureGraph, { ticks: 300, seed: 1, width: 1280, height: 800 });
const p = [...positions.values()];

expect(variance(p.map(n => n.x))).toBeGreaterThan(MIN_AXIS_VARIANCE);   // no vertical line
expect(variance(p.map(n => n.y))).toBeGreaterThan(MIN_AXIS_VARIANCE);   // no horizontal line
expect(minPairwiseDistance(p)).toBeGreaterThan(NODE_DIAMETER);          // no overlap
expect(bbox(p).w).toBeGreaterThan(1280);                                // spreads past one viewport
expect(bbox(p).h).toBeGreaterThan(800);
expect(clusterSeparation(positions, roots)).toBeGreaterThan(MIN_SEP);   // 5 roots stay distinct
expect(computeLayout(fixtureGraph, { ticks: 300, seed: 1 })).toEqual(positions);  // deterministic
```

**Fixture** = this repository's actual shape: 5 top-level roots (vault, repository, modules, git-state, external/package) where one has ~60
containment children. That hub is the hairball risk and the exact case that must look good. Build it with a generator in
`tests/fixtures/graphShapes.ts` so we can also assert on adversarial shapes:

**Built in P0.** `tests/fixtures/graphShapes.ts` ships **six** generators, one more than this section originally listed:

| Generator | Shape | Asserts |
| --- | --- | --- |
| `repoLikeGraph()` | 5 roots, 60-child hub, sparse wiki-link web, 3 cross-cluster edges | the real case |
| `coincidentGraph(n)` + `coincidentPositions` | all nodes seeded at one point | symmetry breaking actually works |
| `disconnectedGraph()` | two disconnected components | components separate, neither escapes to infinity |
| `starGraph(200)` | a 200-node star | leaves ring the hub, no line |
| `singleNodeGraph()` / `emptyGraph()` | a single node / an empty graph | no NaN, no crash |
| `pathologicalGraph()` | **undocumented in the original plan**: a self-edge, a duplicate edge, an edge whose source id does not exist, and an edge whose target id does not exist | `buildGraph` should never emit these, but the layout must not be the thing that throws if it does. A degenerate *input* and a degenerate *output* are different failures, and only the second one was being tested. |

Every one of the first five fails on the retired sim. That is the point. `REPO_LIKE_ROOTS` and `DISCONNECTED_ROOTS` are exported alongside,
so a test naming the anchors cannot drift from the generator that made them, and every fixture carries a fixed `generatedAt` stamp — never
the wall clock.

**The anchor-specific variance assertion.** The whole-cloud assertions above are necessary and were *not sufficient*. The literal reported
symptom was "5 cluster nodes collapsed onto a vertical line at exactly `x = W/2`" — and whole-cloud x-variance can stay perfectly healthy
while that is happening, because the hundreds of children spread out fine around anchors that are themselves squeezed onto one axis. A
centre-gravity regression during the build measured **5,000** anchor variance against **52,000** overall: the cloud assertion passed, the
bug was real, and only measuring the anchors caught it.

So the gate asserts, on the five roots specifically and in addition to the cloud:

```ts
const anchors = REPO_LIKE_ROOTS.map((id) => positions.get(id)!);
expect(variance(xs(anchors))).toBeGreaterThan(MIN_AXIS_VARIANCE);
expect(variance(ys(anchors))).toBeGreaterThan(MIN_AXIS_VARIANCE);
const box = bbox(anchors);                                     // …and roughly circular,
expect(Math.max(box.w, box.h) / Math.min(box.w, box.h)).toBeLessThan(MAX_ROOT_ASPECT);   // not merely non-degenerate
```

The general lesson: **assert on the subset the bug was reported about, not only on the aggregate.** An aggregate has enough slack to hide
the exact failure it was written to catch.

Thresholds are derived from geometry that is true before the simulation runs (`NODE_RADIUS`, the collision diameter, the viewport), never
reverse-engineered from a passing run — a tuned threshold passes the next bug too, which is how 671 tests stayed green. `metrics.test.ts`
tests the measuring instruments separately, because a gate is only as trustworthy as its ruler.

---

## 9. Build pipeline

`esbuild` as a **devDependency** (already present transitively via vitest; make it explicit).

```jsonc
"scripts": {
  "build:web":       "node scripts/build-web.mjs",
  "build:web:check": "node scripts/build-web.mjs --check",
  "check": "npm run typecheck && npm run build:web:check && npm run coverage"
}
```

```
esbuild src/web/client/main.tsx
  --bundle --format=iife --platform=browser --target=es2022
  --minify --jsx=automatic --jsx-import-source=preact
  --tsconfig=tsconfig.web.json --charset=utf8 --legal-comments=eof
  --outfile=src/web/client/dist/app.js
```

Two as-built details the plan did not anticipate, both load-bearing for the byte-comparison invariant:

- **`tsconfig` is pinned, not discovered.** esbuild otherwise walks *up* from the entry point looking for a `tsconfig.json`, which makes the
  output depend on a file that is not a declared input — and on whatever happens to sit in the ancestor directories of wherever the repo is
  checked out. This was a real divergence, not a hypothetical: without the pin, a build from a directory with no ancestor tsconfig dropped
  the `"use strict"` prologue, so two machines produced different bytes and `--check` would have failed on a clean tree.
- **The build runs twice.** The SPDX banner must list the dependencies *actually in the bundle*, and that set is only knowable from
  esbuild's metafile — so pass one discovers it, pass two applies the banner derived from it. A package that appears in the bundle but not
  in the licence table **fails the build**, which is what keeps the attribution honest rather than aspirational. The build also refuses to
  emit an artifact containing the building machine's absolute repository path.

**The artifact is committed.** Consequences, all deliberate:

- Installing pi-weave still requires no build step, matching how `pi.extensions` loads raw TS via jiti today.
- `package.json` keeps **zero** `dependencies`. sigma/graphology/d3-force/preact/marked/dompurify are `devDependencies` — they are inputs to
  a build artifact, not runtime requirements of the published package.
- `--check` rebuilds to a temp file and byte-compares against the committed one, failing on drift. This replaces the retired no-backticks
  source guard with a stronger invariant: *the shipped bundle provably matches the source*.
- The bundle carries an SPDX/licence header block generated from the dependency set.

The HTML shell (`src/web/server/page.ts`) is small — a nonce'd `<style>`, a `<div id=app>`, one `<script>` tag, one JSON bootstrap. The old
"no backticks / no `${` in rendered output" guard **stays** for this file, because it is still a template literal and still an injection
surface. It does not apply to `dist/app.js`, which is generated, not templated.

---

## 10. Testing strategy

The 95 % gate (lines, branches, functions, statements) is not negotiable, and a browser UI is where coverage projects go to die. The
strategy is: **push logic into pure modules, keep DOM shells trivial and excluded.**

| Layer | Location | How tested |
| --- | --- | --- |
| View-models | `src/core/view/**` | Existing TUI tests move with them. Pure in, pure out. |
| Cache | `src/core/cache/**` | Temp vault; assert `stats()` — no-change rebuild does 0 reads, 0 git spawns; mtime change re-reads exactly one note. |
| Layout | `src/web/shared/layout.ts` | §8 dynamics + determinism. Pure Node. |
| Wire codecs | `src/web/shared/wire.ts` | Round-trip; schema guards on malformed input. |
| Security | `src/web/server/security.ts` | Table-driven: good/bad Host, Origin present/absent × GET/POST, token valid/invalid/absent/wrong-length. |
| Routes | `src/web/server/routes.ts` | Real server on port 0 + `fetch`. Every route, 304 path, 403 path, 404 path. Assert the CSP header string. |
| Watcher | `src/web/server/watcher.ts` | Temp dirs; injected clock for the debounce; assert coalescing and the ignore list. |
| SSE | `src/web/server/sse.ts` | `fetch` the stream, parse frames, assert heartbeat and dedupe. |
| Client logic | `src/web/client/**/*.model.ts` | Pure: selection reducers, tree flattening, search ranking, markdown link rewriting. |
| Client DOM | `src/web/client/**/*.tsx` | **Outside the coverage set.** Kept to 30–50 lines each: props in, JSX out, no branching beyond rendering. |
| End-to-end | `tests/web/smoke.test.ts` | Boot the server, `fetch /`, assert shell + CSP + bundle integrity. **No browser, no screenshots.** |

Coverage excludes are listed explicitly in `vitest.config.ts` and justified in `docs/testing.md` — a blanket `src/web/client/**` exclude is
not acceptable.

**As built, this turned out cheaper than planned.** `vitest.config.ts` declares exactly **one** exclusion, `src/core/view/types.ts`, by
exact path and with its justification inline. No `.tsx` file is excluded, because none needs to be: the coverage set is `include:
["src/**/*.ts"]`, so `.tsx` view shells fall outside it *naturally* rather than by an exclusion rule. That is a better outcome than the plan
— an exclusion list that cannot grow to cover the client is one that cannot be abused — and it holds only as long as the shells stay
logic-free. The moment a `.tsx` file wants a branch, the branch belongs in a sibling `.model.ts`, which *is* in the set. Every
`src/web/client/**` `.ts` module is currently at 100%.

**The hard constraint stands: no screenshots, ever.** Any live-browser verification is JS-eval/DOM-measurement only, via the `/browse`
skill, and stays manual — it is not part of the CI gate.

**Manual checklist** (added to `docs/testing.md` §3 as UC11–UC16): open in a repo with no `.okf`; open with an empty vault; edit a note in
`$EDITOR` and watch it update live; run `/weave-scan` while open; kill the pi session and confirm the port closes; open two browser tabs.

---

## 11. Phases

Each phase ends green (`npm run check`) and is a separate PR off a feature branch. Never `main`.

**Status: P0 ✅ · P1 ✅ · P2 ✅ · P3 ✅ · P4 ✅ · P5 ✅ — every phase is built.** 2429 tests across 66 files; coverage 99.64 lines / 97.67
branches / 98.83 functions / 99.64 statements against a 95 % gate; bundle **341.9 KiB raw, 100.4 KiB gzip** (67 % of the 150 KiB budget),
and `build:web:check` confirms the committed artifact matches source. The only file with zero coverage is
`src/web/client/graph/renderer.dom.ts` (lines 30–52, ~9 executable lines), for the reason §7.5 records — and it carries **no** coverage
exclusion. Five phases of UI work have added **zero** coverage exclusions; `vitest.config.ts` still declares exactly one
(`src/core/view/types.ts`, type-only), and that record holds because the coverage set is `src/**/*.ts`, so the `.tsx` view shells fall
outside it *naturally* rather than by a rule that could be abused. Every `src/web/**/*.ts` module is at 100 %.

### P0 — Foundations (no UI) — ✅ **done**

1. ✅ View-models promoted into `src/core/view/` (`tree`, `detail`, `focus`, `links`, `health`, `time`, `cluster`, `types`, `index`);
   `TreeRow.meta` is now structured `TreeMeta` (§3). `src/pi/viewer/tui/model.ts` keeps only TUI-specific parts and re-exports the rest.
2. ✅ `WorkspaceCache` in `src/core/cache/workspace.ts`, 100% covered, with the double note read fixed (§4.1).
3. ✅ `src/web/shared/layout.ts` with d3-force, plus `src/web/shared/metrics.ts` — the measuring instruments, tested independently.
4. ✅ The dynamics gate and **six** fixtures (§8), written before any UI code.
5. ✅ `scripts/build-web.mjs` + `build:web:check` in `npm run check` (§9), with a generated SPDX banner and a byte-comparison invariant.
6. ✅ `engines` → `>=20.13.0`.
7. ✅ `tests/web/tiers.test.ts` — and it did its job immediately, catching the transitive core import described in §2.1.

*Exit met:* layout is provably non-degenerate on six graph shapes; the cache does zero note reads and zero git spawns on a no-change
rebuild.

**Deviations from plan.** `cluster.ts` was rebuilt rather than ported (§7.4). `src/core/view/types.ts` was added and is the single coverage
exclusion (it is type-only and erases to an empty module). The §2 tier rule for `shared` was tightened from "core types only" to "no core at
all" (§2.1).

### P1 — Server and shell — ✅ **done**

Server (`server.ts`, `routes.ts`, `security.ts`, `sse.ts`, `watcher.ts`, `page.ts`), all four security layers (§5.1), the nonce'd CSP
(§5.2), every route in §5.3, the SSE hub and the debounced watcher with a git poll (§6). HTML shell, Preact mount, the three-column layout
with drag and keyboard resizers persisted to `localStorage`, header with the connection indicator, status bar. `src/pi/viewer/web/run.ts`
wires it into the session: one cache, one hub, one watcher, singleton per session, idle shutdown, `session_shutdown` teardown.

*Exit met:* `/weave-view` opens a live, empty-but-correct workspace; a repo scan is picked up through the watcher, and a server restart is
distinguishable from missed frames via the bootstrap `session` id, so the client reloads rather than silently diverging.

**What P1 deliberately deferred.** All three columns rendered an **honest empty state** — `EmptyState.tsx` printed the column's purpose and
the phase it arrived in ("arrives in P2" / "arrives in P3"), driven by copy in `shell.model.ts`. There was no tree, no note rendering, no
graph renderer, and no context rail content. That was not an omission; it was §11's phase order working as designed, and the shell was the
correct destination for the bare command in the meantime. *(P2 and P3 have since filled all three columns. `EmptyState.tsx` had no caller
left and was deleted rather than kept warm; the `EMPTY_STATES` table in `shell.model.ts` survives because `title` is still each column's
heading and `aria-label`, and because `tests/web/client-shell.test.ts` asserts its `phase` values against this section — a column whose
phase silently disagreed with the doc would be the first sign the table had stopped tracking reality.)* `GraphPayload.positions` still ships
`null`, for the reason tabulated in §5.3; `.tags` and `.dangling` were filled in P2.

**Deviations from plan.** The web default flipped to bare `/weave-view` here rather than at P3 (§13). No d3-force on the server, so
`positions` is `null` and the client will compute layout itself (§5.3, §7.3).

### P2 — Tree and Note — ✅ **done**

1. ✅ **Tree column** (`tree/tree.model.ts` + `Tree.tsx`) — a mouse-driven port of `treeRows`'s semantics, not a re-implementation: the rows
   come from `src/core/view/tree.ts` through the `shared/view.ts` door (§2.1.1), so the TUI and the browser cannot disagree about what the
   tree contains. Expand/collapse, filter, provenance cycling, internals toggle, kind and provenance glyphs deliberately identical to the
   TUI's, plus `treeKey` — a pure keyboard reducer for arrows/Home/End that returns `handled: false` for keys it did not consume, so the
   column never swallows Tab.
2. ✅ **Note column** (`note/note.model.ts` + `Note.tsx`) — `marked` + `DOMPurify` (§0 V5), front-matter header with provenance badge,
   relative times over an injected clock, and tags. `[[wikilinks]]` are a custom marked extension resolved against a `WikiIndex` built from
   the payload: a resolved link renders as an `<a>` with **no `href`** (carrying `data-weave-target`, `role="link"` and `tabindex`) so the
   click routes onto §1.3's context bus instead of navigating, and an unresolved one renders as a ghost `<span>` — not a disabled anchor,
   because marking a name up as a link that refuses to work is worse than not marking it up at all. Three sanitisation layers, with the
   hostile-input cases pinned in `tests/web/client-note.test.ts`.
3. ✅ **Context rail** (`context/context.model.ts`) — LINKS, BACKLINKS, TAGS, MENTIONS. Links come from core's `detailModel` minus mentions;
   backlinks from one whole-graph `deriveBacklinks` pass rather than O(nodes × edges) per selection; tags from `GraphPayload.tags`, never
   from `detail.tags`, which is a display string; mentions in **both** directions — what a note names, and which notes name a file.
4. ✅ **The three core gaps closed**: dangling link targets retained rather than counted and discarded (§4.2), the tag index (§4.3), and
   `mentions` edges actually emitted (§4.4). §15.4 and §15.5 are the resolution records.

*Exit met:* the workspace is genuinely useful **with no graph at all** — the honest test of "notes are the product". The graph column was
still an empty state when P2 landed, and tree + note + rail were already a working reading environment over the vault and the repository.

### P3 — Graph — ✅ **done**

1. ✅ **The renderer behind a seam** — `GraphRenderer` plus a `SigmaFactory` port, `sigmaRenderer` unit-tested against a recording fake, and
   the real `new Sigma` isolated in `renderer.dom.ts`. §7.5 has the full account and the reason the literal plan was not buildable.
2. ✅ **graphology projection** (`project.ts`) — `multi: true`, `type: "directed"`, no re-validation, `syncPositions` as the cheap re-run
   path. §7.1 records why `multi` is load-bearing.
3. ✅ **d3-force positions client-side** (`positions.ts`) — `GraphPayload.positions` stays `null` (§5.3), the client runs the identical
   `shared/layout` code, and the result is persisted in one `localStorage` slot keyed by a **shape-only** digest, reused verbatim on a hit.
   §7.3 has the four decisions.
4. ✅ **Neighborhood highlight via reducers** — `highlightFor(edges, selectedId, depth)` computes the set, `nodeReducer`/`edgeReducer` dim
   everything outside it, and the reducers are re-installed via `setSetting` on every change because that is what tells sigma to repaint.
5. ✅ **Semantic zoom** — `labelRenderedSizeThreshold` derived from `nodeSize`'s own range rather than tuned, `labelGridCellSize` derived
   from the layout's `COLLIDE_RADIUS` so the label grid and the simulation talk about one distance, and `itemSizesReference: "positions"` so
   §8's provably non-overlapping layout does not render as a blob at low zoom.
6. ✅ **Cluster collapse/expand** via core's `clusterAggregate` (§7.4) — real graph *reduction*, with boundary-crossing edges retargeted onto
   the standing-in cluster, plus `fit` and a depth 1/2/3 control. The graph opens **fully expanded** — the auto-collapse that opened graphs
   over 120 nodes as their bare roots ("2 of 237 nodes") read as an empty column and was removed in favour of a whole first frame plus the
   one `[collapse]` press.

*Exit met:* `tests/web/client-graph-column.test.ts` carries the exit criterion directly — the repo fixture reduces to 5 distinct clusters
with the 60-child hub, and selecting anywhere highlights everywhere.

**Deviations from plan.** `setGraph` takes a `RenderGraph` rather than a triple, and the seam gained `setPositions`/`positions()` (§7.5).
Positions are computed on the client and cached rather than shipped in the payload (§7.3, §5.3). The palette is duplicated from the
stylesheet into `GRAPH_PALETTE`, because WebGL cannot read a CSS custom property — and the duplication is guarded by a test asserting every
hex literally appears in `shell/theme.ts`.

### P4 — Search and keyboard

`⌘K` palette over `searchNotes` + node labels, with keyboard-first results. Global keys: `⌘K` search, `⌘1/2/3` focus column, `/` filter
tree, `g` fit graph, `?` help, `Esc` clear selection. Vim-ish `j/k` in the tree. Accessible: real focus management, ARIA on the tree,
visible focus rings.

*Exit:* the whole workspace is drivable without a mouse.

### P5 — Editing (gated) — ✅ **done**

**It was blocked on core work, and that gate was the point.** `parseNoteFile` dropped unknown front-matter fields, so a naive browser save
would have silently destroyed user properties. P5a opened the gate in core; P5b built the server routes and the browser editor on top of it.

1. ✅ **Lossless front-matter round-trip** — `Note.frontMatter` carries the block verbatim, owned keys re-render in place, everything else is
   emitted as the exact bytes it was read as. `tests/core/frontmatterRoundTrip.test.ts` states it as a property over generated inputs.
2. ✅ **`updateNote` / `renameNote` / `deleteNote`** in `src/core/vault.ts`, through `withNoteLocks`. `getNoteWithRevision` is the read half
   of the conflict primitive; a `conflict` failure carries the current `RevisionedNote`, so a `409` body can offer reload-or-overwrite with
   no second round trip.
3. ✅ **Conflict handling** — the save carries the revision read at load; a mismatch is a `409` and the UI offers reload-or-overwrite.
   "Overwrite" is the same request re-sent **without** `expectedRevision`, which is how core spells last-write-wins — adopting the
   conflict's revision instead would look equivalent and would turn a second concurrent writer into a second surprise conflict.
4. ✅ **`<textarea>` editor**, `⌘S` save, `⌘E` toggle (§0 V10: CM6 is 118 KB gzip, more than the entire rest of the client). No live preview:
   piping the draft through `marked` + DOMPurify on every keystroke is a parse and a sanitise per character, and `⌘E` is instant and shows
   the text that actually exists.
5. ✅ **`POST /api/note/:slug`**, plus `/rename` and `DELETE`, all through the §5.1 gate — which they inherit rather than re-implement,
   because `handleRequest` authorizes before it routes. Each is tested against five rejection paths (absent Origin, foreign Origin, no
   token, foreign Host, `?t=` handoff on a write), and each asserts the file on disk is untouched as well as the status.

*Exit met:* `tests/web/editor.roundtrip.test.ts` drives the criterion through the code the browser actually runs — `editor.model.ts`
deciding, `editor.controller.ts` fetching, `api.ts` encoding, over a real socket into a real vault — and asserts the bytes afterwards. An
Obsidian-shaped block (an `aliases:` inline array, a `cssclass:`, a `tags:` **block list** with two children, a YAML comment, a blank line,
a nested map) comes back **array-equal**, in its original order, modulo the `updated:` line the save asked to move. Stated as an equality
rather than a `toContain` sweep, because a silently-sorted block would pass the latter and is still a diff the user did not make.

**The three ways an edit can be lost, and what stops each.** This is what the editor is actually for, and it is why the logic is a reducer
rather than a handful of `useState` calls — each guard is a statement about two or three fields moving together:

| Loss | Guard |
| --- | --- |
| Another writer overwrites you | `expectedRevision` on every save → `409` |
| You overwrite another writer | the same `409`, offered as a choice rather than taken as a default |
| You navigate away mid-edit | the navigation is refused *and* the **destination** is parked, so confirming costs one click, not two |
| You close the tab | `shouldBlockUnload` on `beforeunload` |
| A slow save's echo lands after you typed again | the echo is adopted only if the draft has not moved; the baseline advances either way |

**An SSE change to the note being edited: keep typing, offer the reload.** Three policies were available and only one is defensible.
Overwriting the draft destroys unsaved work in response to a background event the user did not cause. A modal steals focus mid-sentence,
from a notification rather than an action. So a load carrying a revision we do not hold, *while dirty*, is recorded rather than applied and
the draft is untouched. What makes that safe rather than merely polite is that it is not the last line of defence: the held revision is now
stale by construction, so the next `⌘S` produces a `409` carrying the current note — the same choice, re-offered at the moment the user is
actually about to write, and authoritative rather than a snapshot that may itself have aged. The marker is an early warning; the `409` is
the guarantee. When the note is *clean* the same load is adopted silently, because there is nothing to protect and a "changed on disk" badge
over a document someone is only reading is noise.

**Self-write suppression (§6) is wired.** Every write calls the watcher's `suppress(absPath)` **before** the mutation — `fs.watch` can
deliver an event while the write syscall is still returning, so a window opened afterwards is a window that opened second. A rename
suppresses both ends, with the destination `slugify`'d first: suppressing the requested string would open the window over `notes/Alpha
Renamed.md` while the write went to `notes/alpha-renamed.md`, which is a suppression that is present, plausible and useless.
`Watcher.suppress` is **optional** on the interface `routes.ts` declares, so a future poller or remote-FS watcher need not implement a
concept it does not have; `server.ts` bridges it when present and writes go unsuppressed when it is not, costing one spurious refetch rather
than a lost edit.

**Deviations from plan.** `GET /api/note/:slug` now serves `{ note, revision }` rather than a bare `ViewNote` — the revision must be read
*with* the body or the pair describes two different states of the file. The revision travels in the **body**, not an `ETag`: `api.ts`'s
`HttpResponse` port exposes `ok`, `status` and `json()` so a two-line fake can stand in for `fetch` (§10), and the revision is a property of
the note rather than of the HTTP representation — unlike `/api/graph`'s stamp, which really is a cache validator. `frontMatter` never
crosses the wire in either direction, and a test asserts it on both: a client that receives it is a client that might send it back, and
preservation would stop being something core enforces by re-reading the file and become something the browser is trusted to have got right.
The editor's controller is `editor.controller.ts` rather than the usual `editor.ts`, because `editor.ts` and `Editor.tsx` collide on a
case-insensitive filesystem (`TS1149`) and renaming the *component* would break the `.tsx` = view convention the client is read by.

### Not in scope

Multi-vault, remote/hosted access, collaboration, plugins, themes, mobile, canvas/whiteboard, and a dockable panel engine. Each is a real
product decision, and none is needed to prove this one.

---

## 12. Companion doc updates

These land **with** the phases that require them, not afterwards.

> **Status.** `docs/testing.md` and `docs/weave-view-handoff.md` are done. **`AGENTS.md` has not been updated** — it still describes only
> the TUI surface and still carries the stale runtime-dependency line — and `docs/design.md` §19 has not been reconciled either. Both are
> outstanding. **`README.md` is now overdue**: it was scheduled for P2, P2 and P3 have both landed, and it still says the browser viewer
> "has been retired and is being rebuilt on pixi.js" and that `/weave-view` opens the terminal explorer — which is wrong on both counts
> (§0.2 rejected pixi; §13 flipped the default to `web` in P1). The `.github/workflows/ci.yml` matrix is still `["20", "22"]` and needs the
> bump to 20.13 / 22 / 24 called for below.

**`AGENTS.md`** (P0) — **not yet applied**:

- Add `src/web/` to the repository layout with the §2 tier table. Rule 3 grows a clause: the client must never import `src/core` or
  `node:*`.
- Document the build step: `npm run build:web`, the committed artifact, `build:web:check` in `npm run check`, and that a PR touching
  `src/web/client/` must include the rebuilt bundle.
- Update the stale dependency line — it says *"Runtime deps today: typebox, @earendil-works/pi-ai"*, but `package.json` has **zero**
  `dependencies` and four peers. Then state the new rule: **UI dependencies are devDependencies that must bundle to a single IIFE with no
  `eval`, no `new Function`, no dynamic `import()`, and no network fetch.** Any addition needs the §0.1 measurements in the PR.
- Note that `/weave-view` opens the browser workspace and `/weave-view tui` the terminal explorer (§13).
- Note the second typecheck project: `npm run typecheck` is now `tsc --noEmit && tsc --noEmit -p tsconfig.web.json`, and the second one is
  what makes the client's core-freedom mechanical (§2.1).

**`docs/testing.md`** (P0 through P3) — ✅ **applied**:

- New layer **L5 — Web**, with the §10 table and a per-row "Built?" column.
- The dynamics smoke test documented as a first-class gate, with the graph-shape fixtures.
- `build:web:check` documented as a CI gate and why byte-comparison beats a source guard.
- The coverage-exclusion policy, with exact paths and no globs.
- UC11–UC16 (§10 manual checklist).
- CI matrix: bump Node 20 → **20.13** and 22, add 24. *(Documented; the workflow file itself is still `["20", "22"]`.)*

**`docs/design.md`** (P1) — **not yet applied**: §19's "Local Web Viewer" box is now real. Add a short subsection pointing here, and
reconcile the Phase 3 bullet ("Local web viewer; query lights up nodes") with the notes-first framing — the viewer is not the deliverable,
the workspace is.

**`docs/weave-view-handoff.md`** — ✅ **applied**: replaced by a stub pointing here. Its post-mortem value is preserved in §0.2 and §7.2.

**`README.md`** (P2, **overdue**): a screenshot-free description of `/weave-view` and what the three columns do. Today it still advertises
the retired viewer and a pixi.js rebuild that §0.2 rejected, and it tells the reader `/weave-view` opens the terminal explorer, which
stopped being true in P1.

---

## 13. Command surface

**Built in P1**, and this is the as-shipped behaviour of `parseWeaveViewArgs` in `src/pi/index.ts`:

| Command | Behaviour |
| --- | --- |
| `/weave-view` | **The browser workspace.** Starts the server (or reuses the running one), opens the browser, and notifies the URL. |
| `/weave-view tui` | The in-terminal explorer. Unchanged, permanent, and the right answer over SSH. |
| `/weave-view web` | Explicitly the browser. An alias of the bare form. |
| `/weave-view web --no-open` | Start the server and notify the URL; launch nothing. `--no-open` may also precede the surface. |
| `/weave-view --no-open` | Same — the surface defaults to `web`. |
| `/weave-view tui --no-open` | **Rejected.** The TUI never opens a browser, so accepting the flag would be a lie about what happened. |
| a repeated `--no-open`, a second surface token, or any unknown token | Rejected. |

The exact usage string, exported as `WEAVE_VIEW_USAGE` and notified as a warning on every rejection:

```text
usage: /weave-view [tui|web] [--no-open]
```

Rejection notifies the usage and starts **nothing**. Parsing is case-insensitive and whitespace-tolerant, and the parser is exported so it
can be tested as a table rather than through eight command invocations.

**The default is `web` as of P1**, ahead of the P3 flip this section originally scheduled — an explicit product decision by the user, not a
slip: the browser workspace is the thing the command is *for*, and `tui` is one word away for the case where it is not available. The
columns fill in over P2–P4; a workspace with honest empty states (§11) is still the right destination for the bare command.

Fallbacks, as implemented in `src/pi/viewer/web/run.ts`:

- **No UI** (`ctx.hasUI === false` — `--mode rpc`, or any headless session). No browser is attempted, because there is no desktop on this
  side of the connection and `xdg-open` would either fail or open a window nobody can see. The server still starts and the URL is still
  notified, which is what makes the workspace reachable over an SSH port-forward. Checked *before* spawning anything: `wantsBrowser =
  opts.open && ctx.hasUI`.
- **No browser could be launched** (`open` / `xdg-open` missing, or a non-zero exit). The server stays up and the notification carries the
  URL plus the reason, so the user can paste it anywhere. If the session is a TTY (`ctx.mode === "tui"`), the TUI opens on top of it as well
  — that is the `fallbackToTui` flag on the outcome, and it is only ever set when a browser was genuinely wanted and genuinely failed.
- **`--no-open`.** Identical minus the reason: server up, URL notified, nothing spawned.

The browser is spawned through `pi.exec` rather than `execFile`, because the harness already owns subprocess policy (cancellation, timeouts,
trust prompts) and it is the seam the mock harness records — so the test asserts the exact command the user's machine would run. It is
deliberately *not* `openNoteInEditor`: that path prefers `$EDITOR`/`$VISUAL`, which is right for a file and catastrophic for a URL (a user
with `EDITOR=vim` would get vim staring at `http://127.0.0.1:…`).

Every path notifies the URL. There is no combination of flags and environment that leaves a server running the user cannot find.

**Singleton per session.** At most one workspace server runs per pi session (§5.4). A second `/weave-view` reuses it — same port, same
watcher, same SSE hub — and only re-opens or re-prints the URL. `session_shutdown` closes the server, which closes the hub and awaits the
watcher. An idle shutdown (§5.4) clears the slot, so the next `/weave-view` boots fresh rather than handing out a dead port.

While a workspace is running, the status line carries a `· web:PORT` marker.

---

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Coverage gate blocks the UI work | §10: logic in pure modules, `.tsx` shells trivial and excluded. If a `.tsx` file exceeds ~50 lines, its logic belongs in a `.model.ts`. |
| Committed bundle rots or is forgotten | `build:web:check` in `npm run check`, which is already `prepublishOnly`. |
| Sigma turns out wrong for our shape | §7.5's renderer seam, and §8 keeps layout correctness independent of the renderer entirely. |
| `fs.watch` unreliable on some setup | Treat events as "re-read", never as deltas. Manual refresh (`r` / `⟳`) always available. Fall back to 3 s stamp polling if the watcher fails to start. |
| Scope creep back into a panel engine | §1.2 is a verdict. Revisit only with evidence from real use. |
| The graph column becomes the product again | Phase order enforces it: P2 must be useful with no graph at all. |
| Bundle size creeps | §0.1 measurements are required in any PR adding a client dependency. Budget: **150 KiB gzip**, hard, asserted by `tests/web/build.test.ts`. Baselines: P1 **14.8 KiB** gzip → P2 **44.8 KiB** → P3 **93.0 KiB** (318.4 KiB raw), 62 % of budget with every planned dependency now in. Measure growth against the last figure, not against the headroom. |

---

## 15. Known follow-ups

Real debt discovered while building P0–P3. None of it blocks the phases above; all of it is cheaper to fix knowingly than to rediscover.
Re-checked against the code at the end of P3:

| | Item | State |
| --- | --- | --- |
| 15.1 | Shell stylesheet ships in the JS bundle | **open** — still a template literal in `client/shell/theme.ts`; there is no `/app.css` route in `routes.ts` |
| 15.2 | `fs.watch` unverified on real hardware | **open** — unverifiable on this machine (launchd `maxfiles` = 256); only the degradation path is exercised |
| 15.3 | `__Host-` cookie unverified in a real browser | **open** — asserted structurally only; `UC17` on the manual checklist |
| 15.4 | `tags` / `dangling` shipped empty | ✅ resolved in P2 |
| 15.5 | `mentions` declared but never emitted | ✅ resolved in P2 |
| 15.6 | `stamp` a timestamp max, not a content digest | ✅ resolved |

### 15.1 The shell's stylesheet ships in the JS bundle — **open**

`src/web/client/shell/theme.ts` holds the workspace stylesheet as a template literal that self-installs at runtime, reading the per-response
nonce off an element the server already nonce'd (`el.nonce`, the IDL property — the content attribute is deliberately hidden by browsers).
It works and it is CSP-legal, but it has two costs: the CSS is carried as JavaScript, and **nothing is styled until the bundle has parsed**.

**The cost has grown.** This was ~5.5 KiB at P1; P2 and P3 added the tree rows, the note body, the context rail and the graph column's
chrome, and `THEME_CSS` is now roughly **12.8 KiB** of CSS inside the JS bundle. The recommendation below is unchanged and the case for it
is now more than twice as strong.

Meanwhile `page.ts`'s `THEME_CSS` — the block that *does* paint before the bundle arrives, and whose stated job is "a dark-mode user should
not get a white flash" — is still **light-first** (`--weave-bg:#f8ede3`, with dark behind a `prefers-color-scheme` media query) and knows
nothing about the grid the client actually renders. The two stylesheets also disagree: the shell's palette is dark-first with a light media
query, and defines variables (`--weave-panel`, `--weave-faint`, `--weave-line-strong`, `--weave-row`, `--weave-gutter`) that the server
block does not. A dark-mode user therefore gets a light flash from the very block written to prevent one.

Recommended, in order of preference:

1. Serve the shell CSS from a `/app.css` route with `<link nonce>` in the shell. It is a static byte string; the route is a dozen lines, it
   parallelises with the JS download, and it removes CSS-as-JS entirely.
2. Failing that, move the palette and the grid skeleton into `page.ts`'s `THEME_CSS` **dark-first**, so the pre-bundle paint matches the
   post-bundle one.

### 15.2 `fs.watch` is unverified on real hardware — **open**

The watcher's happy path could not be exercised on the development machine. macOS launchd caps `maxfiles` at 256 there, and FSEvents fails
with an **asynchronous** `EMFILE` on the watcher's `error` event rather than a synchronous throw — so what the local test run actually
exercises is the *graceful-degradation* path (§6, §14): the root is demoted, `available` is false, and the caller falls back to stamp
polling. That path is well covered and is the important one to get right, but "the watcher degrades correctly" is not the same claim as "the
watcher works". Recursive watch behaviour on a normal `maxfiles` limit — and on Linux, where recursive `fs.watch` needs the ≥20.13 floor
(§4.5) — needs verification on real hardware before we describe liveness as proven.

### 15.3 `__Host-` cookie prefix on `http://127.0.0.1` is untested in a browser — **open**

§5.1 relies on browsers accepting a `Secure` cookie on loopback because loopback is a secure context. That is asserted **structurally** —
`security.ts` emits `__Host-weave` with `Secure; HttpOnly; SameSite=Strict; Path=/`, a prefix-free fallback name exists for a browser that
disagrees, and the tests pin both shapes — but no real browser has ever been checked, because the no-screenshots constraint (§10) keeps
live-browser verification manual. If Chrome, Firefox or Safari rejects it, the symptom is a workspace that redirects and then 403s forever,
which is a bad way to find out. **Belongs on the `docs/testing.md` manual checklist** as an explicit item.

### 15.4 `GraphPayload.tags` and `.dangling` are shipped empty — ✅ **resolved**

Both now carry real data. `dangling` comes from `GraphModel.danglingLinks`, which the builder retains instead of counting and discarding
(§4.2); `tags` comes from `deriveTagIndex` (§4.3) in `src/core/view/links.ts`. The note column's tag navigation and the ghost-node
affordance are unblocked.

One design note worth keeping. `deriveTagIndex` takes **notes**, not a `GraphModel`, because the graph flattens tags to a comma-joined
display string and recovering an array from it would mean re-parsing `detail` into structure — the thing §4.2/§4.3 exist to prevent. To make
that safe, `WorkspaceCache` gained `snapshot()`, which returns the graph *and* the (already cap-truncated) notes it was built from, so a tag
can never name a slug the graph has no node for. `graph()` is now a memoized projection of it and keeps its promise-identity coalescing
contract.

### 15.5 `mentions` edges are declared but never emitted — ✅ **resolved**

`buildGraph` now emits them (§4.4): `src/core/graph/mentions.ts` runs a path regex over each note body and resolves each hit against a
`PathIndex` built from the same `RepoStructure` arrays the repository side walks, so a mention can only ever target a node that exists.

The granularity rule is the part to remember, because it is what keeps the edge count bounded. Resolution goes **exact match first, then at
most one step *upward*** to the longest enclosing module — and never downward. A note saying "see `src/core`" produces exactly one edge, not
one per file beneath it; a note naming `src/core/graph/build.ts` lands on `module:src/core`, because most repo files are not nodes and
exact-match-only would silently drop the majority of real mentions. Each distinct mentioned path therefore yields at most one target, and
same-module mentions dedupe into a single edge. URLs and email-like tokens are excluded by a lookbehind, so a note full of GitHub links
produces nothing.

### 15.6 `GraphPayload.stamp` is a timestamp max, not a content digest — ✅ **resolved**

`stamp` is now a **content digest of the serialized payload** (SHA-256, truncated to 128 bits, hex) rather than `model.generatedAt`. It
changes iff the served bytes change, which is what both of its consumers — the ETag and the SSE dedupe key — always needed.

**What was wrong.** `generatedAt` is the newest `updated` among the inputs, so the stamp was blind to any change that did not move that
maximum. Three reachable cases, each now a passing positive assertion in `routes.test.ts` (they replace the single "KNOWN LIMITATION" test
that used to pin the bug): editing a note's body or its front-matter tags without bumping `updated`, and deleting a note that is not the
newest. In each the payload differs, the digest moves with it, and the conditional GET answers `200`.

**The SSE half was broken too, contrary to what this section previously claimed.** The old text said the watcher "pushes on the *file event*
rather than on the stamp, so an out-of-band edit still triggers a refetch". That is not what the code did: `createLivenessBridge` broadcast
`model.generatedAt`, and the client dedupes frames on `stamp` (`live.model.ts`) against the stamp of the graph it last fetched — so for
exactly these three cases the frame was discarded *before* any refetch was attempted. The stale `304` was the second line of defence; the
dropped frame was the first. The bridge and the route now derive the stamp from one exported function (`graphStamp`), so they cannot drift.

**Determinism** needed no canonicalisation pass, which was checked rather than assumed. `buildGraph` is byte-deterministic, `deriveTagIndex`
sorts count-desc / tag-asc with **codepoint** tiebreaks (deliberately not `localeCompare`, §4.3), and `danglingLinks` follows the builder's
note order — itself a function of payload content. Two independently-built servers over identical input produce an identical stamp; a test
pins it. A stress check with `stalenessTtlMs: 0`, forcing a git re-assessment on every build, produced one distinct digest across five
rebuilds on both a clean and a dirty worktree, confirming nothing wall-clock-derived leaks into the payload.

**Cost.** The digest is computed once per *build*, not per request. `WorkspaceCache` now returns the identical snapshot object when a build
proves nothing moved, and `routes.ts` memoizes the serialized body and ETag against that identity in a `WeakMap`. This also removed a cost
that predated the digest: `/api/graph` used to re-run `buildGraph` on every request (~1.3 ms at 120 notes) even though §4.1 had already
eliminated the note reads and git spawns. Reuse is conservative — a read, a vanished note, a changed `.md` count, an expired staleness TTL,
or any invalidation landing mid-build all force a real rebuild.

**Two notes for future readers.** `generatedAt` stays on the model and keeps the data-as-of job; `Shell.tsx` was repointed at it, because a
status bar labelled "data as of" showing `a3f9c2…` would be a regression. And the ETag is now strong, which it has earned: the digest is
taken over the exact bytes written to the socket.

---

## 16. Current state

For someone picking this up cold. **Every phase, P0 through P5, is done and green.**

### What works today

`/weave-view` opens a live, three-column workspace over your vault and the repository you are standing in, served from loopback by the pi
session itself.

- **Tree** — the vault and the repository as one expandable containment outline, from core's `treeRows`, so the browser and the terminal
  explorer can never disagree about what the tree contains. Expand/collapse, a filter box, provenance cycling, an internals toggle, and
  arrow-key navigation.
- **Note** — the selected note rendered with `marked` + `DOMPurify`: front-matter header with a provenance badge and relative times, tags,
  and `[[wikilinks]]` rewritten into internal navigation. An unresolved wikilink renders as a ghost you can see but not follow.
- **Graph** — sigma over a graphology projection, laid out by d3-force in the browser and cached in `localStorage` so a reopened workspace
  does not reshuffle. Neighborhood highlight via reducers, semantic zoom, cluster collapse/expand, `fit`. The graph opens **expanded**; a
  first frame of bare roots for larger graphs was tried and removed — it read as an empty pane beside a tree showing the same knowledge
  whole, and `[collapse]` is one press when the overview is wanted.
- **Context rail** under the graph — LINKS, BACKLINKS, TAGS and MENTIONS for whatever is selected, every row clickable.
- **One selection, everywhere.** §1.3's context bus is a single Preact signal: click a tree row, a graph node, a wikilink or a rail entry
  and all four surfaces recompute. That is §1.1's principle — bring related information into the current view — and it is the thing to try
  first when evaluating whether this works.
- **Live updates.** A debounced `fs.watch` over the vault and `<repo>/.okf`, plus a 2 s git HEAD/index poll, pushes an SSE frame keyed by a
  content digest; the client refetches conditionally, so editing a note in `$EDITOR` updates the workspace with no manual refresh. The
  server is a singleton per pi session, shuts down 30 minutes after the last client leaves, and is torn down on `session_shutdown`.
- **Editing** (P5) — `⌘E` opens a `<textarea>` over the note body, `⌘S` saves. The save carries the revision read at load, so a write that
  raced another writer is a `409` offering reload-or-overwrite rather than a silent clobber, and the prompt is answerable from the `409`'s
  own body. Unsaved work is guarded on every exit: navigating away parks the destination and asks, `⌘E` out of a dirty editor is refused,
  and `beforeunload` blocks a tab close. An **Open in $EDITOR** button hands the note to `$EDITOR`. A note edited in the browser and a note
  edited in Obsidian are byte-compatible — unknown front-matter keys, key order, block lists and comments all survive a browser save
  identically, which is P5's exit criterion and is asserted end to end in `tests/web/editor.roundtrip.test.ts`.
- **Security**: a 256-bit per-session token handed off once via `/?t=…` into a `__Host-` cookie, loopback binding, a Host allowlist against
  DNS rebinding, an Origin rule on writes (required on **every** non-GET, which is what makes the three write routes CSRF-proof), and a
  nonce'd CSP with no `unsafe-inline`, no `unsafe-eval` and no `blob:`.

### How to run it

```bash
pi -e ./src/pi/index.ts     # load the extension into a pi session
```

Then, inside the session:

| | |
| --- | --- |
| `/weave-view` | the browser workspace — starts the server, opens a browser, notifies the URL |
| `/weave-view tui` | the in-terminal explorer; the right answer over SSH |
| `/weave-view --no-open` | server up, URL notified, nothing launched |

Every path notifies the URL, so there is no combination of flags that leaves a server the user cannot find. In a headless session — RPC
mode, or any session where `ctx.hasUI` is false — no browser is attempted but the server still starts, which is what makes it reachable over
an SSH port-forward. While a workspace is running the status line carries a `· web:PORT` marker.

Verification, before touching anything: `npm run check` (typecheck → `build:web:check` → coverage). A PR touching `src/web/client/` must
include the rebuilt bundle, or `build:web:check` fails.

### What remains

**No phase does.** P0–P5 are all built, and what is left is the follow-up debt in §15 plus the deliberate omissions below. Three items that
appeared here through P4 are now closed and are recorded rather than deleted, because each was a *specified* gap and knowing it was closed
on purpose is worth more than a shorter list:

- ~~**P4 — search and keyboard.**~~ Built: the `⌘K` palette, the global keymap and focus management. The header's search control is a live
  `<button>` rather than the `disabled` box it was through P3 — and a button, not an `<input>`, because the palette owns the only text field
  in the workspace and a header box you could type into whose contents were discarded when the overlay opened would be a worse lie than the
  disabled version it replaced.
- ~~**P5 — editing.**~~ Built, and the gate held: the lossless round trip landed in core *first* (P5a), then the routes and the editor
  (P5b). §11 P5 has the account.
- ~~**"Open in $EDITOR" is specified, plumbed and not wired up."**~~ Wired. The note column's toolbar has the button; it dispatches an
  `open` event into `editor.model.ts`, which returns an `open` effect, which `editor.controller.ts` turns into the `POST /api/open` that
  `api.ts` had been exporting uncalled since P2. Both outcomes — opened, and refused — surface in the toolbar's status line.

Genuinely absent, and deliberately:

- **Rename and delete have routes and client functions but no UI.** `POST /api/note/:slug/rename` and `DELETE /api/note/:slug` are
  implemented, covered and reachable through `api.ts`'s `renameNote`/`deleteNote`; nothing in the note column calls them. That is the same
  shape the "Open in $EDITOR" gap had, and it is left open on purpose rather than by omission: a delete button is a *destructive* affordance
  and the vault has **no trash** by design (`deleteNote`'s doc comment argues the case), so the confirmation flow around it is a real design
  decision and not a wiring task. Rename is milder but has the same tell — it deliberately does not rewrite inbound wikilinks, so the UI has
  to say something honest about the ghosts a rename creates.
- **No live preview while editing.** §11 P5.4 mentions one; the built answer is `⌘E`. Rendering the draft on every keystroke means a
  `marked` parse and a DOMPurify pass per character, and the toggle is instant and shows text that actually exists.
- **CodeMirror.** §0 V10 defers it until the textarea demonstrably fails. It has not.

### Open items a contributor should know about

- **§15.1 — the stylesheet ships inside the JS bundle.** ~12.8 KiB of CSS as a template literal in `client/shell/theme.ts`, so nothing is
  styled until `app.js` parses, and `page.ts`'s pre-paint block is still light-first while the shell is dark-first — a dark-mode user gets a
  light flash from the very block written to prevent one. Fix is an `/app.css` route.
- **§15.2 — `fs.watch` has never been verified on healthy hardware.** The development machine's launchd `maxfiles` is 256, so FSEvents fails
  with an asynchronous `EMFILE` and what the suite exercises is the *graceful-degradation* path (demote the root, fall back to stamp
  polling). That path is well covered; "the watcher degrades correctly" is not the same claim as "the watcher works". UC18.
- **§15.3 — the `__Host-weave` cookie has never been checked in a real browser.** It is asserted structurally and a prefix-free fallback
  name exists, but if Chrome, Firefox or Safari rejects a `Secure` cookie on loopback the symptom is a workspace that redirects and then
  403s forever. UC17.
- **The one uncovered file is deliberate.** `src/web/client/graph/renderer.dom.ts`, ~9 executable lines, 0 %. `import Sigma from "sigma"` is
  a `ReferenceError` in Node, so this is the smallest possible island of untestable code and it carries **no** coverage exclusion (§7.5). Do
  not "fix" it by adding one, and do not let it grow — anything with a branch belongs above the seam in `renderer.ts` or `graph.model.ts`.
- **Docs that lag the code**: `README.md` still describes the retired viewer and a pixi.js rebuild that §0.2 rejected; `AGENTS.md` still
  describes only the TUI and carries a stale runtime-dependency line; `docs/design.md` §19 is unreconciled; `.github/workflows/ci.yml` is
  still `["20", "22"]` against an `engines` floor of `>=20.13.0` (§12).
- **No screenshots, ever** (§10). Live-browser verification is JS-eval and DOM-measurement only, it is manual, and it is outside the CI
  gate. That is why the layout gate (§8) is numeric.
