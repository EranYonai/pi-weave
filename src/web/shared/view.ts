/**
 * The browser's legal door onto the core view-models (weave-workspace §3, §2.1).
 *
 * ## What this is
 *
 * `src/core/view/` holds the one implementation of the tree, detail and focus
 * projections — the whole point of §3 being that the TUI and the browser
 * workspace *cannot drift*, because there is nothing to drift from. The tier
 * table (§2) forbids `src/web/client/**` from reaching `src/core`, transitively
 * included, so without a door the client's only options were to re-implement
 * those projections or to have the server pre-render them. Both defeat §3.
 *
 * This module is the door. It contains **no logic**: every line below is an
 * `export … from`, so the client and the TUI call the same function object
 * defined in the same file. A wrapper would be a second implementation with a
 * second set of edge cases, which is the failure mode §3 exists to prevent.
 *
 * ## Why this is allowed to import `src/core` when `wire.ts` is not
 *
 * §2.1 records a hard-won rule: *nothing under `src/web/shared/` imports
 * `src/core`, not even as a type*. That rule was written after
 * `import type { GraphModel }` in `wire.ts` broke `tsc -p tsconfig.web.json`
 * with 24 `Cannot find module 'node:fs'` errors — because type erasure happens
 * in the bundler and not in the typechecker, so the compiler still walked the
 * whole Node-flavoured core type graph.
 *
 * The reasoning was correct about *that* closure. `src/core/graph/model.ts` was
 * reached from a barrel whose neighbours read the filesystem. It was not a
 * claim about core in general, and it is not true of this closure:
 *
 * ```text
 * shared/view.ts
 *   → core/view/{tree,detail,focus,links,time,types}.ts
 *     → core/graph/model.ts → core/types.ts
 * ```
 *
 * Eleven modules, zero `node:*` imports, zero Node globals, zero npm
 * dependencies, all pure functions over plain data. They are genuinely
 * browser-portable; only the blanket tier rule stood in the way.
 *
 * Two guards keep that a fact rather than an assumption, and they are what
 * makes the exception sound rather than merely convenient:
 *
 * 1. `tests/web/view.purity.test.ts` walks the transitive closure reachable
 *    from this file and fails if any module in it acquires a `node:*` import,
 *    a Node global, or an npm dependency. Add `node:fs` to
 *    `src/core/view/tree.ts` and the suite goes red immediately — not silently
 *    at runtime in someone's browser.
 * 2. `tsconfig.web.json` includes `src/web/shared/**`, so the same closure is
 *    typechecked with `"types": []` and a `lib` with no Node types. That is
 *    the check that caught the original 24 errors, now aimed here on purpose.
 *
 * The narrow, precise version of the §2.1 rule is therefore: *`src/web/shared/`
 * may import the modules of `src/core` that are proven node-free, and nothing
 * else.* `tests/web/tiers.test.ts` encodes that as a **module allowlist**, not
 * a directory one — `core/vault.ts`, `core/git.ts`, `core/repoIndex.ts`,
 * `core/summaries.ts`, `core/paths.ts`, `core/cache/` and
 * `core/graph/current.ts` all remain forbidden here, because reopening the
 * door as "shared may import core" would reopen the exact hole §2.1 closed.
 *
 * ## Why this is a small list
 *
 * Deliberately not `export * from "../../core/view"`. The barrel pulls in
 * `health.ts` (a TUI surface) and `links.ts`'s tag index (derived server-side
 * into `GraphPayload.tags`), neither of which any browser column consumes
 * today — and each one it pulled in would be a module the purity guard then
 * has to defend forever.
 *
 * So this is an allowlist, on the same principle as the `npm` column in
 * `tests/web/tiers.test.ts`: the surface the columns actually use, and nothing
 * more. **P3 added `focusNeighborhood`, `degreeOf` and `clusterAggregate`**,
 * in the commit that first calls them, exactly as this paragraph promised —
 * along with `src/core/view/cluster.ts` in `NODE_FREE_CORE_MODULES`, which is
 * the reviewed edit that grants the permission. `cluster.ts`'s closure adds
 * nothing new (it reaches only `graph/model.ts`, `types.ts` and `view/tree.ts`,
 * all already permitted), so the node-free proof `view.purity.test.ts` runs is
 * unchanged in kind.
 *
 * ## Wire types vs. view types
 *
 * The view-models were written against core's `GraphModel`, and the client
 * holds `GraphPayload` from `./wire`. The two disagree by exactly one field:
 * `WireGraphModel` is `Omit<GraphModel, "danglingLinks">`, because the payload
 * hoists that map to its own top-level `dangling` rather than shipping it
 * twice (§4.2). A caller therefore reassembles
 * `{ ...payload.model, danglingLinks: payload.dangling }` before calling
 * {@link treeRows} or {@link detailModel}. That reassembly is not done here on
 * purpose: it is a wire concern with exactly one correct spelling, and putting
 * it in this file would make the door carry a transformation instead of just
 * being a door.
 *
 * The node and edge types need no such care. `WireGraphNode` / `WireGraphEdge`
 * are asserted mutually assignable with their core counterparts by
 * `tests/web/wire.contract.test.ts`, so a `WireGraphNode` may be passed to
 * {@link listLabel} and a `WireGraphEdge[]` to {@link deriveBacklinks} with no
 * cast. Likewise `WireNodeKind` / `WireNoteSource` are the same unions as
 * core's `NodeKind` / `NoteSource`, which is why this module does not
 * re-export a second name for either.
 */

// --- tree column (§1.2, P2) ---------------------------------------------------

/**
 * The tree column *is* `treeRows` with a different renderer (§3).
 *
 * `listLabel` is exported alongside it because the browser has places that
 * hold a node but not a row — a graph tooltip, a dangling-link ghost — and a
 * second label rule for those is precisely the drift §3 forbids.
 * `treeEmptyHint` is the tree's honest empty state, for the same reason.
 */
export { listLabel, treeEmptyHint, treeRows } from "../../core/view/tree";

/**
 * `TreeState` here is **core's**, not the placeholder in
 * `src/web/client/state.ts`: it carries the filter, the provenance cycle and
 * the internals toggle that `treeRows` actually reads, where the client's
 * P1 stand-in carries only an expanded-id list. P2 replaces the latter with
 * this.
 */
export type { TreeRow, TreeState } from "../../core/view/tree";

// --- note column (§1.2, P2) ---------------------------------------------------

/**
 * `relTime` renders the note header's "updated 12m ago"; `formatTreeMeta`
 * renders a `TreeMeta` as plain text.
 *
 * A richer renderer is expected to switch on the {@link TreeMeta} union itself
 * (a `<time>` element wants the ISO string, not a pre-formatted one), which is
 * why the structured type comes across too and not only the formatter.
 */
export { formatTreeMeta, relTime } from "../../core/view/time";

// --- context rail (§1.2, P2) --------------------------------------------------

/** Links, backlinks and the ordered meta block for the selected node. */
export { detailModel } from "../../core/view/detail";
export type { DetailLinkRow, DetailMetaRow, DetailModel } from "../../core/view/detail";

/** "Related": the 1-hop neighborhood, grouped by relationship. */
export { focusModel } from "../../core/view/focus";
export type { FocusGroup, FocusModel, FocusRow } from "../../core/view/focus";

// --- graph column (§1.2, §7, P3) ------------------------------------------------

/**
 * The graph's neighborhood highlight (§7.4) and its node sizing.
 *
 * `focusNeighborhood` is the set sigma's `nodeReducer` dims *outside* of, and
 * it must be the same set the context rail's "Related" is built from — a graph
 * that highlights one neighbourhood while the rail lists another is two
 * answers to one question, which is the drift §3 exists to prevent.
 *
 * `degreeOf` comes across alongside it because the graph column needs a
 * *single* node's degree in one place (a tooltip, a collapsed cluster's
 * badge). The bulk case — a degree for every node at once — is `degrees` in
 * `client/graph/graph.model.ts`, which is O(edges) rather than
 * O(nodes × edges); that is a different algorithm for a different question,
 * not a second implementation of this one.
 */
export { degreeOf, focusNeighborhood } from "../../core/view/focus";

/**
 * Cluster collapse/expand, as **graph reduction** rather than masking (§7.4).
 *
 * Built in P0 and deliberately not a port of the retired viewer's function of
 * the same name: that one computed a visibility mask, left every node in the
 * graph, and never rewrote an edge — so a link from a hidden file to a visible
 * note simply vanished. This returns reduced node and edge arrays with
 * boundary-crossing edges retargeted onto the standing-in cluster, which is
 * what sigma wants (§7.1: a graph it can consume verbatim) and what keeps the
 * TUI tree and the web graph answering "what is visible?" identically.
 */
export { clusterAggregate } from "../../core/view/cluster";
export type { ClusterAggregate, ClusterInfo, ProvenanceSplit } from "../../core/view/cluster";

/**
 * Backlinks for the whole graph in one pass — the rail renders one node's, but
 * the tree wants "does this note have any?" without an O(nodes × edges) scan.
 */
export { deriveBacklinks } from "../../core/view/links";

// --- shared row/meta types ----------------------------------------------------

/**
 * `SelectableRow` is the base of `TreeRow`, `DetailLinkRow` and `FocusRow`, so
 * a single "render a selectable row" component can be typed against it rather
 * than against a union of three.
 */
export type { SelectableRow, TreeMeta } from "../../core/view/types";

/**
 * The input type every function above takes.
 *
 * Renamed rather than re-exported as `GraphModel`, because `./wire` already
 * exports that name for the *wire* model and the two are one field apart (see
 * the module header). Two different `GraphModel`s in one tier is a trap; a
 * name that says which side of the boundary it belongs to is not.
 */
export type { GraphModel as ViewGraphModel } from "../../core/graph/model";
