# Testing, Use Cases & Evaluation

Testing strategy for pi-weave: what we test, at which layer, with which fixtures — plus the evaluation harness we use to A/B-compare prompt
and context variants once the tools are live.

> Status: part record, part plan. L1–L3 are built and green (`tests/core`, `tests/pi`). **L5 (§1) is built through P3**: layout, metrics,
> view-models, cache, tier imports, the wire contract, the bundle, every server row, and every client row including the tree, note, context
> and graph columns (`tests/web/`, **25 test files** plus one shared helper module). L4 (eval, §4) is unbuilt. Rows and paragraphs
> describing something that does not exist yet say so explicitly — do not cite them as coverage.
>
> Current numbers: **2068 tests across 59 files**; coverage **99.6** lines / **97.37** branches / **98.67** functions / **99.6** statements
> against a 95% gate; bundle 318.4 KiB raw / 93.0 KiB gzip against a 150 KiB budget. Exactly one file in `src/` has zero coverage —
> `src/web/client/graph/renderer.dom.ts`, ~9 executable lines, **no exclusion added** (§L5.2).

## 1. Layers

```
L1 unit          pure functions, no fs / no git          tests/core/
L2 integration   temp dirs + temp git repositories       tests/core/
L3 adapter       src/pi with a mocked ExtensionAPI       tests/pi/
L4 eval          scripted pi runs, variant comparison    tests/eval/          (not built)
L5 web           the src/web tier: layout, wire, server  tests/web/
```

The layer names describe a *kind* of test, not a directory. On disk the suites are consolidated: `tests/core/` (L1 + L2, mirroring
`src/core/`), `tests/pi/` (L3), `tests/web/` (L5), with shared machinery in `tests/helpers.ts` and graph fixtures in `tests/fixtures/`. The
`tests/unit`, `tests/integration`, `tests/adapter` split named in earlier drafts of this doc was never built.

### L1 — Unit (fast, deterministic, the bulk of the suite)

Pure functions take data in, return data out. No filesystem, no git. Target them first; they carry the coverage thresholds.

| Module | What to test |
| --- | --- |
| `slug.ts` | `slugify`: case folding, whitespace→dash, punctuation stripping, unicode/emoji input, empty/garbage titles (fallback), idempotence. `uniqueSlug`: `-2`, `-3` suffixes on collision, base-free-when-possible. |
| `frontmatter.ts` | `serializeNote` → `parseNoteFile` roundtrip (property: parse(serialize(x)) ≡ x). Malformed files: no front matter, unclosed fence, bad timestamp, unknown `source` value, tags missing. |
| `languages.ts` | Known extensions map, unknown → `undefined`, case handling, `.dockerfile`/extensionless special cases. |
| `repoIndex.ts` (pure halves) | `buildStructure` on synthetic file lists: language ordering (count desc, name asc tiebreak), manifest detection per kind, fallback package names, module grouping (`src/x`, `packages/x`, `(root)`), entry-point regexes per language. `summarizeIndex` output shape. |
| `workspace.ts` (pure halves) | `formatStatusLine` / `formatDashboard` for all `WorkspaceStatus` shapes (vault present/absent, repository `null`, staleness states). |
| `vault.ts` (pure halves) | `formatNote` rendering. |

### L2 — Integration (temp filesystem + temp git repos)

Everything under `src/core` that touches disk or shells out to git.

**Vault** (`tests/core/vault.test.ts`) — temp root per test: `ensureVault` creates layout; `addNote` writes `<slug>.md` with valid front
matter; slug collisions resolve via `uniqueSlug`; `getNote`/`appendToNote` update `updated` and preserve `created`; `listNotes`
chronological order; `searchNotes` ranks title hits over body hits; missing vault → `vaultExists`/`noteCount` degrade, no throw.

**Git wrappers** (`tests/core/git.test.ts`) — fixture repos built by a helper (§2): `findGitRoot` from a nested dir;
`headSha`/`currentBranch`; `changedFiles` reflects porcelain state (new file, modified, staged); `listFiles` excludes `.git` &
untracked-ignored; `remotes`; `defaultBranch`; unborn HEAD → `null` (not throw); non-git dir → `null` (not throw); `excludeOkfLocally`
writes `.git/info/exclude` exactly once (repeat call is idempotent).

**Repo index** (`tests/core/repoIndex.test.ts`): `buildRepoIndex` on a committed fixture → identity/git/structure all sane; uncommitted file
appears in `git.changedFiles`; `maxFiles` cap respected; unborn HEAD → `null`. `writeRepoIndex` → `readRepoIndex` roundtrip preserves
identity/git/structure. Malformed/missing JSON on disk → `readRepoIndex` returns `null`.

**Staleness matrix** (same file, looped table):

| Setup | Expected state |
| --- | --- |
| no `.okf` | `missing` |
| index written, nothing touched | `fresh` |
| new commit after capture | `stale` ("HEAD moved") |
| branch switch | `stale` ("branch changed") |
| dirty a tracked file | `stale` ("new uncommitted change") |
| resolve the dirty file, same HEAD | `stale` ("resolved") |

**Workspace** (`tests/core/workspace.test.ts`): `getWorkspaceStatus` in (a) git repo with index, (b) git repo without index, (c) non-git dir
(repository `null`), (d) each × vault present/absent via `PI_WEAVE_VAULT` pointed at a temp dir.

### L3 — Adapter (`src/pi` with a mocked pi)

No real pi needed: build a `MockExtensionAPI` test double that records `registerTool` / `registerCommand` / `on` calls, run the default
export from `src/pi/index.ts` against it, then invoke the captured handlers directly.

- Factory registers: the note tool, the repo tool, `/weave`, `/weave-scan`, one `session_start` handler. (Assert names — they're the
  LLM-facing contract.)
- Tool `execute()` with a mock `ctx` (`ctx.cwd` → fixture repo, `ctx.ui` stubbed) drives the real core against L2-style temp repos and
  asserts the returned `content`/`details` shapes.
- Command handlers: `/weave` status output on indexed vs unindexed repos; no-UI modes (`ctx.hasUI === false`) never call `ui.*` prompt
  methods.
- Error paths: tool execution in non-git dir reports cleanly (not throws).

Keep harness imports confined to `src/pi` — an L3 test importing `@earendil-works/*` types into `src/core` test helpers is a red flag
(design §21).

### L4 — Eval / E2E smoke

See §4. Interactive TUI testing stays manual (checklist below); scripted behavioral checks use print/json mode.

### L5 — Web (`src/web`, the browser workspace tier)

Design: `docs/weave-workspace.md` §10. A browser UI is where coverage projects go to die, so the strategy is structural rather than heroic:
**push logic into pure modules and keep the DOM shells trivial and excluded.** Every row below is a pure-Node test — there is no jsdom, no
headless browser, and (§10, a hard project constraint) **no screenshots, ever**.

| Layer | Location | How tested | Built? |
| --- | --- | --- | --- |
| View-models | `src/core/view/**` | Promoted out of the TUI; the existing TUI tests moved with them. Pure in, pure out. | yes — `tests/core/view/` |
| Cache | `src/core/cache/**` | Temp vault + temp git repo; assert `stats()` — a no-change rebuild does 0 note reads and 0 git spawns, an mtime change re-reads exactly one note. Plus an equivalence net against `buildCurrentGraph`. | yes — `tests/core/cache/` |
| Layout | `src/web/shared/layout.ts` | The dynamics gate (§L5.1 below) + determinism. Pure Node. | yes — `tests/web/layout.dynamics.test.ts` |
| Layout metrics | `src/web/shared/metrics.ts` | The measuring instruments the gate depends on, tested independently so a green gate cannot be an artefact of a broken metric. | yes — `tests/web/metrics.test.ts` |
| Tier import rules | all five tiers | Executable AGENTS.md rule 3 and weave-workspace §2: walk every tier, resolve every specifier, classify it by target tier, and check it against a per-tier allowlist (permitted tiers, npm packages, node builtins, node/DOM globals, type-only reach). A tier directory that does not exist yet passes vacuously and is covered automatically the day it appears; a source file under `src/` that no tier claims fails the suite. | yes — `tests/web/tiers.test.ts` |
| Wire codecs | `src/web/shared/wire.ts` | Round-trip and schema guards on malformed input (`wire.test.ts`), **plus** the compile-time DTO contract against core (`wire.contract.test.ts`, §L5.3 below). | yes — `tests/web/wire.test.ts`, `wire.contract.test.ts` |
| Security | `src/web/server/security.ts` | Table-driven: good/bad Host, Origin present/absent × GET/POST, token valid/invalid/absent/wrong-length. | yes — `tests/web/security.test.ts` |
| Routes | `src/web/server/routes.ts` | Real server on port 0 + `fetch`. Every route, the 304/403/404 paths, the token handoff redirect, and the exact CSP header string. | yes — `tests/web/routes.test.ts` |
| HTML shell | `src/web/server/page.ts` | Escaping, per-response nonces, and the retained no-backtick source guard (§L5.4). | yes — `tests/web/page.test.ts` |
| Watcher | `src/web/server/watcher.ts` | Temp dirs; injected clock for the debounce; coalescing, the ignore list, the git poll, and the graceful-degradation path. | yes — `tests/web/watcher.test.ts` |
| SSE | `src/web/server/sse.ts` | `fetch` the stream, parse frames, assert heartbeat and dedupe. | yes — `tests/web/sse.test.ts` |
| Client logic | `src/web/client/**` (`.ts`) | Pure, with `fetch`, the socket factory, `localStorage`, `matchMedia` and the sigma constructor all injected: the HTTP layer and its 304/403/404/malformed paths, the layout and drag arithmetic, both breakpoints, the liveness reducer and its three connection states, the signal bus, the theme installer, and the tree / note / context / graph column models. | yes — see the enumeration below |
| Client DOM | `src/web/client/**/*.tsx` | **Outside the coverage set** (§L5.2 below) — not by an exclusion rule but because `include` is `src/**/*.ts`. Props in, JSX out, no branching beyond rendering. | yes — the shells exist and are trivial |
| Bundle invariants | `src/web/client/dist/app.js` | The artifact exists, is attributed, parses, is CSP-clean (no `eval`, no `new Function`, no `createObjectURL`, no *dynamic* `import()`), and is inside the 150 KiB gzip budget. Does not run a build — that is `build:web:check`'s job (§L5.4). | yes — `tests/web/build.test.ts` |

The "Built?" column is load-bearing. P0 shipped the layout, metrics, view-model, cache and import-rule rows; **P1 shipped every remaining
server row**; P2 and P3 filled the client rows out. There is no `tests/web/smoke.test.ts`: the end-to-end shell assertions this doc once
scheduled for one file are covered where they belong — `routes.test.ts` boots a real server on port 0 and asserts the shell, the CSP header
and the security layers over a real socket, and `build.test.ts` asserts bundle integrity without paying for a build on every run. A single
`smoke.test.ts` would have duplicated both.

Two rows in the L5 table were added during the build rather than planned: the HTML-shell row (`page.test.ts`) and the bundle-invariants row
(`build.test.ts`).

**What is actually in `tests/web/`.** 26 files: 25 suites and one shared, non-test helper module. Enumerated rather than summarised, because
the table above groups by *layer* and the split on disk is by *question asked*:

| File | Tests | Covers |
| --- | ---: | --- |
| `layout.dynamics.test.ts` | 45 | §L5.1. The force simulation's output on six graph shapes; determinism. |
| `metrics.test.ts` | 20 | The measuring instruments the gate above depends on. |
| `tiers.test.ts` | 44 | The §2 tier table, executable: resolve every specifier in every tier, check against a per-tier allowlist. |
| `view.purity.test.ts` | 11 | The `shared/view.ts` door: the core closure behind it is node-free, both by text scan and by typecheck. |
| `wire.test.ts` | 22 | The two runtime exports of `shared/wire.ts` (`CHANGE_SCOPES`, the type guards); malformed input. |
| `wire.contract.test.ts` | 8 | §L5.3. The wire DTOs vs. core, as a **compile-time** gate plus enum equality. |
| `security.test.ts` | 96 | The four security layers as a table over (Host × Origin × method × token). |
| `routes.test.ts` | 118 | Every route over a real socket on port 0: 304/403/404, the token handoff redirect, the exact CSP string. |
| `page.test.ts` | 64 | The HTML shell: escaping, per-response nonces, the retained no-backtick source guard (§L5.4). |
| `watcher.test.ts` | 51 | Debounce coalescing, the ignore list, the git poll, and the graceful-degradation path. Injected clock and scheduler. |
| `sse.test.ts` | 28 | The broadcast hub over a real server: frame format, heartbeat, dedupe. |
| `build.test.ts` | 11 | Bundle invariants and the 150 KiB budget. |
| `state.test.ts` | 12 | §1.3's signal bus. Browser-tier but DOM-free, so covered like any other module. |
| `client-api.test.ts` | 78 | The HTTP layer with `fetch` injected: 200, 304, 403, 404, non-JSON, wrong-shape JSON, and a rejecting `fetch`. |
| `client-live.test.ts` | 41 | `live.model.ts`'s reconnect rule, dedupe and three connection states; `live.ts` against a nine-line fake `EventSource`. |
| `client-workspace.test.ts` | 29 | Where fetching, liveness and the bus meet: mount ordering, reconnect refetch, a `304` not churning subscribers. |
| `client-layout.test.ts` | 110 | The three-column model: drag arithmetic, both breakpoints, every malformed stored layout. |
| `client-shell.test.ts` | 60 | `shell.model.ts`, `drag.model.ts`, `cssvars.ts`, `bootstrap.ts` — every decision the `.tsx` shell appears to make. |
| `client-theme.test.ts` | 24 | The stylesheet as text (every class the `.tsx` files use is defined) and the CSP-legal nonce-copying installer. |
| `client-tree.test.ts` | 74 | P2's tree column: rows, filter, provenance cycle, internals toggle, `treeKey`'s keyboard reducer, glyphs. |
| `client-note.test.ts` | 103 | P2's note column, and **the only place the three sanitisation layers meet hostile input**. Wikilink resolution and ghosts. |
| `client-context.test.ts` | 33 | P2.5's context rail: all four relationship kinds present at once, asserted as "standing here, you can see there". |
| `client-graph.test.ts` | 70 | P3's `graph.model.ts` decisions, the graphology projection, and `sigmaRenderer` against a recording `SigmaLike` fake. |
| `client-graph-column.test.ts` | 61 | P3's column state — highlight, clusters, controls. Carries the **P3 exit criterion** directly. |
| `client-graph-positions.test.ts` | 39 | P3's layout resolution and `localStorage` persistence: the "must not reshuffle between sessions" requirement. |
| `importGraph.ts` | — | Not a suite. The shared module walker and `NODE_FREE_CORE_MODULES`, consumed by `tiers` and `view.purity` so the two guards cannot disagree about what is reachable. |

Three splits are deliberate and worth preserving. `client-graph*` is three files because they ask different questions ("what does the column
decide", "what does it draw", "where does the layout come from"). `tiers` and `view.purity` share `importGraph.ts` but keep their *rules*
separate. And `metrics` is separate from `layout.dynamics` because a gate is only as trustworthy as its ruler.

#### L5.0 The one module no test can load

`src/web/client/graph/renderer.dom.ts` is the single file in `src/` at 0 % coverage: **lines 30–52, about nine executable lines** — an
import, a type alias, and two arrow functions with no branch between them.

The cause is not laziness, and it was verified rather than assumed: `import Sigma from "sigma"` evaluates `WebGL2RenderingContext.BOOL` at
module scope while building sigma's default program table, so in Node the *import alone* throws a `ReferenceError` before any of our code
runs. There is no DOM test environment in this repository and §L5.5 forbids adding one, so a file that names sigma is a file no test can
even import — which means it reports 0 % **as a whole**, not line by line.

The response was to shrink the island rather than to hide it. `renderer.ts` declares `SigmaLike` (a six-method structural port the real
`Sigma` satisfies without a cast) and `SigmaFactory` (`new Sigma(...)` as a function type); `sigmaRenderer(create, scheme)` is the entire
renderer written against that port, and `client-graph.test.ts` drives it with a recording fake through mount, reducer installation,
`setGraph`, `setPositions`, `setHighlight`, `fit`, selection and a double `destroy`. What is left in `renderer.dom.ts` is the constructor
call and the container cast. `renderer.ts` imports **no npm package at all**, which is what lets the root `tsconfig.json` project — no `DOM`
lib — compile the tests that import it.

**No coverage exclusion was added, and that is the point.** §L5.2's rule is that untestable *lines* are kept to a handful, not that
untestable *files* are excluded; the one exclusion that exists is a type-only module and a blanket `src/web/client/**` exclude is explicitly
not acceptable. Nine uncovered lines drag the global figure down by a fraction of a percent, which the 95 % gate absorbs — and leaving them
visible is what stops the file growing. The same shape and the same reasoning as `api.dom.ts` for `fetch` and `domEventSource` for
`EventSource`: anything with a branch belongs above the seam, where a test can reach it.

#### L5.1 The dynamics smoke test — the gate this tier exists for

`tests/web/layout.dynamics.test.ts` is a first-class CI gate, not a nicety. The retired viewer shipped **671 green tests** with a visually
broken layout: five cluster nodes collapsed onto a vertical line at exactly `x = W/2`. Nothing tested the *output* of the force simulation,
so nothing caught it. This file tests the output — numerically, from the position map, with no rendering involved — and by project rule it
lands before any UI code, not after.

The graph-shape generators live in `tests/fixtures/graphShapes.ts`. Each emits a real `GraphModel` (the same type `buildGraph` produces), so
the layout engine is exercised through its actual contract, and each shape is one of the ways the retired simulation degenerated:

| Shape | Generator | What it proves |
| --- | --- | --- |
| repo-like | `repoLikeGraph()` | The real case: 5 containment roots (vault, repository, modules, gitState, external) where `repository` fans out to 60 children, plus a sparse wiki-link web and three cross-cluster edges. That hub is the hairball risk. |
| coincident | `coincidentGraph(40)` + `coincidentPositions` | Symmetry breaking from an *exactly* shared start point — the state where a `dx / d` repulsion term is identically zero and the retired sim froze. |
| disconnected | `disconnectedGraph()` | Two containment trees, no edge between them: they must separate and neither may escape to infinity. |
| star-200 | `starGraph(200)` | The pure high-degree hub: leaves ring the hub rather than forming a line. |
| single / empty | `singleNodeGraph()`, `emptyGraph()` | No NaN, no crash; the single node lands at the viewport centre. |
| pathological | `pathologicalGraph()` | Self-edges, duplicate edges, and edges naming ids that do not exist. `buildGraph` should never emit these; the layout must not be what throws if it does. |

What the gate asserts, on the repo-like shape:

- every node placed exactly once, every coordinate finite;
- per-axis variance above `(min(W, H) / 10)²` — the degenerate case scores exactly 0 on one axis, so the margin is enormous;
- minimum pairwise distance above one node diameter (`2 × NODE_RADIUS`) — no visual overlap;
- bounding box wider and taller than one 1280×800 viewport;
- cluster separation between the five root anchors above `2 × CONTAINS_DISTANCE`;
- **the anchors specifically** are two-dimensional and roughly circular (aspect ratio < 2). This is the assertion that catches the actual
  historical bug: whole-cloud variance can look healthy on the children while the anchors are squeezed onto one axis — a centre-gravity
  regression measured 5,000 anchor variance against 52,000 overall;
- the 60-child hub occupies ≥ 9 of 12 30° sectors (a ring hits 12, a line hits 2) and every leaf sits within a factor of two of the ring
  radius the geometry asked for;
- determinism: same seed, same input ⇒ deep-equal position map, including via a freshly constructed but structurally identical model.

**Thresholds are derived, not tuned.** Each constant comes from geometry that is true before the simulation runs (`NODE_RADIUS`,
`CONTAINS_DISTANCE`, the viewport). A threshold reverse-engineered from a passing run is a threshold that will pass the next bug too — that
is precisely how 671 tests stayed green.

Two supporting properties are worth keeping honest. `tests/web/metrics.test.ts` tests the measuring instruments themselves (`variance` is
exactly 0 for a constant sample; `angularOccupancy` reports 2 sectors for a line through the centre — the failure signature), because a gate
is only as trustworthy as its ruler. And the seed is asserted to be a *no-op* on well-separated graphs and decisive on the coincident
fixture, because d3's jiggle fires only on an exactly-zero separation; without that pairing, "seeded LCG" would be a claim rather than a
fact.

#### L5.2 Coverage exclusions

The 95% gate applies to `src/**/*.ts` and is not negotiable. `vitest.config.ts` declares exactly **one** exclusion, by exact path:

```ts
include: ["src/**/*.ts"],
exclude: ["src/core/view/types.ts"],
```

- **Type-only modules.** A module that declares only interfaces and type aliases erases to an empty module, so v8 reports `0/0/0/0` — zero
  covered of zero coverable — and the reporter averages that in as a literal 0%. That is a **v8 type-erasure artefact, not a gap**: there is
  no runtime behaviour, so there is nothing a test could assert. `src/core/view/types.ts` is the only one, and the only one there has ever
  been.

The alternative — a test that imports the module purely to touch it — is rejected on purpose. It asserts nothing, and a green tick beside a
file with no executable code is worth less than an honest absence.

**Client view shells (`.tsx`) are not excluded, and never were.** An earlier draft of this doc planned a second exclusion category for them.
It turned out to be unnecessary: the coverage `include` is `src/**/*.ts`, so `.tsx` files fall outside the measured set *naturally*, with no
rule to write and no rule to abuse. That is a strictly better outcome — an exclusion list that cannot grow to cover the client cannot be
stretched to cover it later — but it holds only while the shells stay logic-free. Props in, JSX out, no branching beyond rendering; any
`.tsx` over ~50 lines has logic in it, and that logic belongs in a sibling `.ts` module that *is* measured.

**Verified against `vitest.config.ts` at the end of P3: still exactly one entry, still `src/core/view/types.ts`, still by exact path, still
with its justification inline.** Three phases of UI work — a tree, a markdown renderer, a context rail and a WebGL graph — added **zero**
exclusions. Every `src/web/client/**` `.ts` module is at 100 % except `graph/renderer.dom.ts` (§L5.0), which is uncovered *and unexcluded*
on purpose.

Two rules govern how exclusions are written:

- **Exact paths, never globs.** `src/core/view/types.ts`, not `**/types.ts`. A pattern would silently swallow the next `types.ts` that
  *does* carry a runtime guard or a constant — the exclusion list must not be able to grow on its own.
- **Each entry carries its justification** in a comment in `vitest.config.ts`, and adding one means demonstrating the module is genuinely
  type-only. A blanket `src/web/client/**` exclude is not acceptable, and is not needed.

Verify an exclusion hid only what was intended by comparing the file count in the coverage table against the `.ts` files under `src/`; the
difference must equal the number of excluded entries.

#### L5.3 The wire contract — drift as a compile error

`src/web/shared/graph.ts` declares the graph DTOs **structurally** rather than importing them from `src/core`, because the `shared` tier is
now fully core-free (weave-workspace §2.1). The short version of why: `import type` erases from the *bundle* but not from the *typecheck* —
the compiler still resolves the target module and walks its whole closure, so one core type here dragged `node:fs` into `tsconfig.web.json`
(which has `"types": []`) and produced 24 errors.

Declaring a shape twice invites drift, and drift in a serialization boundary is the quiet kind: the server keeps sending a field, the client
keeps not knowing about it, and nothing fails until someone notices a column that has been blank for a month. So
`tests/web/wire.contract.test.ts` makes drift a **build error**, not a test failure:

- A type-level `Exact<A, B>` witness (`[A] extends [B]` *and* `[B] extends [A]`) asserts mutual assignability between every wire DTO and its
  core counterpart. Almost nothing in the file executes — the enforcement is `tsc --noEmit`, which covers `tests/**` under the root project,
  the one project where importing core is legal and free. The `it()` blocks exist so the assertions show up in the run.
- The runtime enumerations get ordinary `toEqual` checks (`WIRE_NODE_KINDS` vs `NODE_KINDS`, `WIRE_EDGE_KINDS` vs `EDGE_KINDS`) plus a
  no-duplicates check, because a *value* can drift without a type error: core gains a kind, the union assertion forces `graph.ts` to add it,
  and the array is still forgotten — producing a legend with a missing colour and no failing test anywhere.

Add a field to core's `GraphNode` and this file stops compiling until `graph.ts` agrees. Narrowing the wire type deliberately is allowed —
relax the assertion to a one-directional `Extends` and say why in a comment. Silent divergence is not.

This is why `npm run typecheck` runs **two** projects: `tsc --noEmit && tsc --noEmit -p tsconfig.web.json`. The first enforces the contract
above; the second enforces the client's freedom from core and `node:*` mechanically, via a `lib` with no node types and `"types": []`.

#### L5.4 `build:web:check` — the committed-bundle gate

The client bundle (`src/web/client/dist/app.js`) is a **committed build artifact**, so that installing pi-weave still requires no build
step, matching how `pi.extensions` loads raw TS via jiti today. `npm run build:web:check` rebuilds to a temp file and byte-compares against
the committed one, failing on drift; it sits in `npm run check` between `typecheck` and `coverage`, and `check` is already `prepublishOnly`.

Byte-comparison beats the source guard it replaces. The retired viewer defended its HTML template with a "no backticks, no `${`" lint over
the source — a proxy that could be satisfied while the shipped file said something else entirely. The rebuild-and-compare invariant is
stronger and simpler: *the shipped bundle provably matches the source it claims to be built from.* A PR touching `src/web/client/` that
forgets to rebuild fails CI rather than shipping a stale UI. The old template guard still applies to `src/web/server/page.ts`, which remains
a hand-written template literal and therefore a real injection surface; it does not apply to `dist/app.js`, which is generated.

**Built in P0.** `scripts/build-web.mjs` exists, the bundle is committed, and `npm run check` runs end to end. `--check` prints both sizes
on every run — as of P3, `318.4 KiB raw · 93.0 KiB gzip (budget 150.0 KiB gzip)` — which is the number to quote when measuring growth. The
baseline moved twice: **14.8 KiB** gzip at P1 (preact + signals), **44.8 KiB** at P2 (+ marked, dompurify), **93.0 KiB** at P3 (+ sigma,
graphology, d3-force and their transitive `graphology-utils`, `d3-quadtree`, `d3-dispatch`, `d3-timer`, `events`). That is 62 % of the
budget with every planned dependency now in, and it lands within a rounding error of the ~93 KB weave-workspace §0.1 projected before any of
it was written.

Two properties of the script are load-bearing for the byte-comparison invariant and are worth knowing before touching it:

- **The tsconfig is pinned** (`tsconfig: "tsconfig.web.json"`), not discovered. esbuild otherwise walks *up* from the entry point looking
  for a `tsconfig.json`, making the output depend on a file that is not a declared input and on whatever sits in the ancestor directories of
  the checkout. This was a real divergence: without the pin, a build from a directory with no ancestor tsconfig dropped the `"use strict"`
  prologue, so two machines produced different bytes and `--check` would have failed on a clean tree.
- **The build runs twice.** The SPDX banner must list the packages *actually* in the bundle, which is only knowable from esbuild's metafile,
  so pass one discovers the set and pass two applies the banner. A package in the bundle but absent from the licence table **fails the
  build**, and the script also refuses to emit an artifact containing the building machine's absolute repository path.

`tests/web/build.test.ts` complements the gate without duplicating it: it deliberately does *not* run a build (that would make every
unrelated test run pay for esbuild) and instead asserts the properties a reader of the repository should be able to rely on without
rebuilding — the artifact exists, is attributed, parses, is CSP-clean, and is inside budget.

#### L5.5 Browser verification stays manual

No screenshots, ever — the constraint is absolute and it applies to CI and to agents equally. Live-browser verification is JS-eval and
DOM-measurement only, driven by hand through the `/browse` skill, and it is **outside the CI gate**. Nothing in `tests/web/` opens a
browser. This is why the layout gate is numeric: correctness of the thing that historically broke has to be provable without rendering it.

## 2. Test infrastructure

**Fixture helpers** (`tests/helpers.ts`, one module — the `tests/helpers/` directory this doc once planned was never split out):

- `makeTempDir()` — `fs.mkdtemp` under `os.tmpdir()`.
- `gitInit(dir)` / `writeFixture(root, relPath, content)` / `commitAll(dir, message)` — build a real fixture repo step by step, rather than
  one `makeTempRepo({ files, commits })` builder as earlier drafts of this doc proposed. Commits run with fixed `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` env and `-c init.defaultBranch=main`, so hashes and branches are deterministic across machines.
- `withVaultEnv(vaultRoot, fn)` — scoped `PI_WEAVE_VAULT` override; vitest files run in parallel workers, so **no global env mutation and no
  shared temp dirs**.
- `createMockPi()` / `createMockCtx(cwd, hasUI, mode)` — the L3 harness double, recording `registerTool` / `registerCommand` / `on`.
- `tests/fixtures/graphShapes.ts` — the L5 graph-shape generators (§1 L5.1). Fixed `generatedAt` stamp; never the wall clock.

**Determinism rules:**

- Always inject `now` where the API offers it (`ScanOptions.now`, and any vault/build helpers that accept timestamps). Assert timestamps by
  ISO shape, not exact values, when injection isn't available.
- **No snapshot tests over raw JSON** — outputs contain absolute paths and timestamps. Normalize first, or assert structurally.
- Never run git against the developer's real repo; every git call targets a temp fixture root.

**Optional, deferred:** property-based testing (`fast-check`) for the frontmatter roundtrip and `slugify` idempotence. Worth it once formats
stabilize; not now.

## 3. Use cases (acceptance scenarios)

Each scenario maps to a layer; the list doubles as the pre-release manual checklist (L4 column = human in the TUI).

| # | Scenario | Expected behavior | Layer |
| --- | --- | --- | --- |
| UC1 | `pi` in a git repo with no `.okf` | Repo tool/command offers/builds index; `.okf/` contains `okf.json` + `repository/{identity,git,structure}.json`; `.git/info/exclude` updated | L2, L3, L4 |
| UC2 | Session in a non-git directory | Repository scope reports "not a git repository", no crash; vault features unaffected | L2, L3 |
| UC3 | Nothing changed since scan | Staleness `fresh` | L2 |
| UC4 | New commit / branch switch / dirty file | Staleness `stale` with the right reason strings | L2 |
| UC5 | Vault note lifecycle | add → get → append → search finds it; two same-title notes get distinct slugs | L2, L3 |
| UC6 | Cross-scope reasoning | A note can reference repo structure the index knows about (manual: ask pi "what do we know about auth?") | L4 |
| UC7 | `rm -rf .okf` then rescan | Rebuilt index matches the previous one modulo timestamps (derived, disposable — design §4) | L2 |
| UC8 | Huge repo | Scan respects `maxFiles` cap; summary notes the cap | L2 |
| UC9 | `git init`, zero commits | `buildRepoIndex` → `null`; surfaces as "nothing to anchor to" | L2 |
| UC10 | `/weave` dashboard | Renders vault + repository status lines; stale index is visibly marked | L3, L4 |

The web workspace adds eight more. All eight are **manual** — they exercise a live server, a real browser, and process lifecycle, none of
which the CI gate touches (§1 L5.5). Verify by JS-eval / DOM measurement, never by screenshot.

All eight are now fully in scope: P2 and P3 filled the three columns, so UC11–UC16 can be checked against real content rather than against
the honest empty states P1 shipped. UC17 and UC18 were added after P1 because they are the two places the automated suite provably cannot
reach, and both are still unchecked (weave-workspace §15.3, §15.2).

| # | Scenario | Expected behavior | Layer |
| --- | --- | --- | --- |
| UC11 | Open the workspace in a repo with no `.okf` | Loads; repository column reports "unindexed" and offers a scan; the vault half is fully usable; no error, no empty white page | L5 manual |
| UC12 | Open with an empty vault | Loads; tree shows the empty hint rather than a blank column; the graph renders the repository side alone with no NaN positions | L5 manual |
| UC13 | Edit a note in `$EDITOR` while the workspace is open | The watcher fires, the SSE frame arrives, and the note + tree + graph update live without a manual refresh | L5 manual |
| UC14 | Run `/weave-scan` while the workspace is open | The index rebuild is picked up; staleness clears in the status bar; the graph reflects the new structure; the client does not desync | L5 manual |
| UC15 | Kill the pi session with the browser still open | The server shuts down and the port is released (`lsof -i` clean); the browser shows a disconnected state rather than hanging | L5 manual |
| UC16 | Open two browser tabs against the same server | Both receive the same SSE stream; selection is per-tab; neither starves the other; closing one leaves the other live | L5 manual |
| UC17 | **The `__Host-weave` cookie in Chrome, Firefox and Safari** | The `Secure` cookie is accepted on `http://127.0.0.1` (loopback is a secure context), so the `/?t=…` handoff redirects once and every later request — including the `EventSource` stream — carries it. If any browser rejects the `__Host-` prefix, the symptom is a workspace that redirects and then 403s forever; the prefix-free fallback name in `security.ts` exists for exactly that. Asserted structurally in `security.test.ts`, **never checked in a real browser** — weave-workspace §15.3 | L5 manual |
| UC18 | **`fs.watch` on a machine with a normal `maxfiles` limit** | Editing a note fires the watcher rather than the degradation path. On the development machine (macOS launchd `maxfiles` = 256) FSEvents fails with an asynchronous `EMFILE`, so what the local suite exercises is graceful degradation — correct, well covered, and not the same claim as "the watcher works". Also verify on Linux, where recursive `fs.watch` needs the ≥ 20.13 floor — weave-workspace §15.2 | L5 manual |

## 4. Evaluation & A/B testing

Classic web A/B doesn't apply to an agent extension — there is no traffic to split. What we can and should do is **controlled variant
comparison over a fixed harness**: same repo, same questions, same model; one variable changed; metrics compared.

### 4.1 What varies (the "arms")

- **Context depth** — what the repo tool injects: (a) nothing (control), (b) `summarizeIndex` lines only, (c) full `structure.json`
  projection. This is the central tradeoff: knowledge vs. token cost.
- **Tool surface wording** — tool `description`/`promptGuidelines` variants; measures how wording changes tool-selection behavior.
- **Search scoring** — vault `searchNotes` ranking variants (title weight, snippet window).
- **Staleness posture** — auto-refresh vs. ask-first (manual only, UX study).

### 4.2 The harness

```
tests/eval/
├── repos/          # fixture repos, git-submodule'd or generated, PINNED to a commit
├── questions/      # repo-QA sets: ~30 questions with known answers per repo
├── runners/        # scripts driving pi in --mode json / -p
└── results/        # JSONL output per run — gitignored except aggregate reports
```

Protocol per run:

1. Pin: repo commit, model, thinking level, temperature (as far as the provider allows).
2. Enable exactly one variant (env var or extension flag — keep this surface tiny and explicit).
3. Ask each question non-interactively (`pi -p` / json mode), capture the full event stream as JSONL.
4. Repeat N ≥ 10 per arm — LLM output is stochastic; report mean and spread, never a single run.

### 4.3 Metrics

| Metric | How captured |
| --- | --- |
| Answer correctness | exact match where possible; otherwise rubric-graded LLM judge (pinned judge model, recorded prompt) |
| Token cost | input/output/cache tokens from `usage` in the event stream |
| Latency | wall time per question |
| Tool behavior | count + names of tool calls (did it call the repo tool? did it waste scans?) |
| Staleness hygiene | false "fresh" / false "stale" events |

**Primary decision metric: answer quality per input token.** A variant that adds 2k tokens for +2% correctness loses; one that cuts tokens
at equal quality wins. Guardrails: latency and wasted tool calls.

### 4.4 Process

- A experiment config = one JSON file naming: arm definition, question set, repo pin, model pin, N. Reproducible by construction.
- Results committed only as aggregate reports (`results/*/REPORT.md`); raw JSONL stays local (gitignored).
- Variant merges require: quality-per-token not worse, guardrails not regressed, and the losing arm's config kept for the record.

Human-facing A/B (viewer UX, notification wording) comes later, once the viewer exists — manual side-by-side sessions until we have real
users.

## 5. CI (when the repo goes public)

GitHub Actions, one job: `npm ci && npm run check` on Node **20.13**, **22**, and **24**. The floor moved off bare `20` because
`package.json` `engines` now requires `>=20.13.0` — recursive `fs.watch` on Linux landed there, and the workspace watcher depends on it, so
CI must fail on the oldest version we actually claim to support rather than on a newer one that happens to work.

`npm run check` is `typecheck && build:web:check && coverage`, so the committed-bundle gate (§1 L5.4) and the layout dynamics gate (§1 L5.1)
are both enforced on every matrix leg. Nothing in CI opens a browser.

Eval harness stays out of CI gating (needs model keys; runs on demand via `workflow_dispatch` with secrets). Add a weekly scheduled eval
once the question sets stabilize, so silent quality drift surfaces early.

> **Not applied yet.** `.github/workflows/ci.yml` still says `node: ["20", "22"]`. Bumping it is a one-line change to that file, out of
> scope for the doc-only change that introduced this paragraph.

## 6. Order of operations

Done (L1–L3):

1. L2 helpers (`makeTempDir`, `gitInit`/`writeFixture`/`commitAll`) — everything else imports them.
2. L1 suite for `slug`, `frontmatter`, `languages`, pure `repoIndex` halves.
3. L2 suites: git → vault → repoIndex/staleness → workspace.
4. L3 adapter double + tool/command assertions.
5. CI on.

Done (L5, P0):

6. ✅ **The dynamics gate first**, before any UI code. Its fixtures, then its thresholds, then the layout it grades — and the ordering is the
   point: the retired viewer wrote the tests last and shipped a broken layout past 671 of them.
7. ✅ `scripts/build-web.mjs` and the committed bundle, so `npm run check` runs end to end.
8. ✅ The tier-import gate, which caught a transitive `client → shared → core` import that both single-hop checks had passed (§L5.3).

Done (L5, P1):

9. ✅ Server rows: security table → routes → page → watcher → SSE, all over real sockets and temp fixtures.
10. ✅ Client rows: every `.ts` module covered with `fetch` and the socket factory injected; `.tsx` shells kept trivial and therefore outside
    the measured set with no exclusion rule.
11. ✅ The wire contract as a compile-time gate (§L5.3) and the bundle-invariants suite.

Done (L5, P2):

12. ✅ Content rows: `client-tree`, `client-note`, `client-context`, and the core work that unblocked them — `deriveTagIndex`,
    dangling-target retention and `mentions` edges (weave-workspace §15.4, §15.5, both now resolved). The bundle gained marked + dompurify;
    the baseline moved 14.8 → 44.8 KiB gzip.

Done (L5, P3):

13. ✅ Graph rows: `client-graph` (decisions, projection, and `sigmaRenderer` against a recording fake), `client-graph-column` (which carries
    the P3 exit criterion) and `client-graph-positions` (the no-reshuffle requirement). The bundle gained sigma + graphology + d3-force;
    44.8 → 93.0 KiB gzip.
14. ✅ The renderer seam, so that a WebGL phase cost the coverage gate **nine lines and no exclusion** (§L5.0) rather than a whole file.

Next:

15. The manual browser checklist, UC17 and UC18 first — they are the two claims the automated suite cannot make.
16. P4 rows: the search palette over `/api/search` (the route and the client call already exist and are covered; nothing invokes them yet)
    and global keyboard handling. `treeKey` is already built and tested, so it is the model for the rest.
17. P5 is gated on a **lossless front-matter round-trip** in `src/core/frontmatter.ts`. `parseNoteFile` currently reads five fields and
    discards every other key, so the first test to write is the property one: unknown fields survive byte-identically. No editing UI before
    that test is green.
18. Only then eval arms (L4) — A/B against an untested core measures noise.
