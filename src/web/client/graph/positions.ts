/**
 * Computing the layout, and keeping it across sessions
 * (weave-workspace §7.3, §11 P3).
 *
 * ## Where layout runs, as built
 *
 * §7.3 plans for the server to precompute positions and ship them in
 * `GraphPayload.positions`. That is **not** what happens: `positions` is
 * `null` by design (§5.3), because `shared/layout.ts` imports `d3-force` and
 * the server tier's npm allowlist is empty. So the client runs the identical
 * `shared/layout` code itself, which is exactly why that module lives in
 * `shared/` and takes no DOM.
 *
 * The consequence §7.3 was trying to avoid — "the graph appears already laid
 * out with no visible settling" — is what {@link loadPositions} is for. A
 * cached layout from the last session is *better* than a server-computed one:
 * it settles instantly **and** it is the arrangement the user already has a
 * mental map of.
 *
 * ## When the simulation re-runs
 *
 * §7.3: "The client re-runs the sim only on user drag or expand/collapse." Not
 * every frame, not on every SSE tick, and not on a resize. {@link layoutFor}
 * is the single entry point and it is called from exactly those places;
 * {@link shouldRelayout} is the rule for the case that is easy to get wrong —
 * a new payload arriving over the wire.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`. `localStorage` arrives as a two-method port, not as the
 * global, for the reason `layout.model.ts`'s `LayoutStorage` records: the real
 * one *throws* in partitioned-storage contexts, and a narrow injected port is
 * a better place for that wrapper than a component. No DOM type is named, so
 * the root `tsconfig.json` project compiles the tests.
 */

import { computeLayout, hashId } from "../../shared/layout";
import type { LayoutOptions, Point } from "../../shared/layout";
import type { WireGraphEdge, WireGraphNode } from "../../shared/wire";

// --- computing ----------------------------------------------------------------------

/**
 * Tick budget for a layout run.
 *
 * `shared/layout.ts` derives its alpha decay from this, so the simulation
 * reaches the same convergence at any budget — the number buys smoothness of
 * the *path*, not quality of the result. 300 is the value §8's gate asserts
 * against, and matching it means the graph a user sees is the graph the
 * dynamics test proved non-degenerate. A different budget here would make the
 * gate a statement about a layout nobody renders.
 */
export const LAYOUT_TICKS = 300;

/** The seed. Fixed, so two loads of one vault produce one arrangement. */
export const LAYOUT_SEED = 1;

/**
 * Lay out a node/edge set.
 *
 * `warm` is `computeLayout`'s `initial`: positions to start from rather than
 * the deterministic seeding. Passed on a re-run so the picture *moves* to its
 * new arrangement instead of being replaced by an unrelated one — §8 pins that
 * re-running from a settled state is a near-fixed-point, which is the property
 * that makes an expand feel like an expand.
 *
 * The viewport is **not** a parameter, deliberately. `computeLayout` centres
 * its output on the width and height it is given, and sigma's camera fits
 * whatever extent it is handed — so feeding the real column width in would
 * re-run the simulation on every divider drag to produce a picture the camera
 * immediately normalises away. A fixed nominal viewport keeps the layout a
 * function of the *graph*, which is what makes it cacheable at all.
 */
export function layoutFor(
  nodes: readonly WireGraphNode[],
  edges: readonly WireGraphEdge[],
  warm?: ReadonlyMap<string, Point>,
): Map<string, Point> {
  const options: LayoutOptions = { ticks: LAYOUT_TICKS, seed: LAYOUT_SEED };
  return computeLayout(
    { generatedAt: "", staleness: null, nodes: [...nodes], edges: [...edges], contentDigest: "" },
    warm === undefined ? options : { ...options, initial: warm },
  );
}

// --- the cache key ---------------------------------------------------------------------

/**
 * A digest of the graph's *shape* — which nodes and edges exist, not where
 * they are or what they say.
 *
 * This is the "repo hash" §11 P3 keys position persistence by, and what it
 * hashes is the whole design. Three properties matter:
 *
 * 1. **Shape only.** A note's title changing, a tag being added, `generatedAt`
 *    advancing — none of those move a node, so none of them should throw away
 *    a layout the user has built a mental map of. Hashing the payload's
 *    `stamp` instead would invalidate on every edit, which is the same as not
 *    caching.
 * 2. **Order-independent.** Node and edge order is stable today
 *    (`buildGraph` is byte-deterministic), but a cache that silently
 *    invalidates when core reorders its output would be a mystery, so the
 *    per-element hashes are combined by **XOR and sum** rather than by
 *    concatenation. Two graphs with the same elements in a different order
 *    share a key, which is correct: the layout does not depend on the order.
 * 3. **Cheap.** One `hashId` per node and per edge, no string building. This
 *    runs on every payload arrival.
 *
 * The count is mixed in alongside the accumulators because XOR alone cannot
 * see a duplicate (`x ^ x = 0`) and a sum alone collides too easily.
 */
export function graphShapeKey(nodes: readonly WireGraphNode[], edges: readonly WireGraphEdge[]): string {
  let xor = 0;
  let sum = 0;
  for (const node of nodes) {
    const h = hashId(node.id);
    xor ^= h;
    sum = (sum + h) >>> 0;
  }
  for (const edge of edges) {
    const h = hashId(`${edge.source}\u0000${edge.target}\u0000${edge.kind}`);
    xor ^= h;
    sum = (sum + h) >>> 0;
  }
  const parts = [nodes.length, edges.length, xor >>> 0, sum].map((n) => n.toString(16));
  return parts.join("-");
}

/**
 * Whether a new payload needs the simulation re-run.
 *
 * The one decision that is easy to get wrong in both directions. Re-running on
 * every payload makes the graph jump whenever anyone saves a file — the
 * watcher fires, the graph refetches, and a picture the user was reading
 * rearranges itself for no visible reason. Never re-running leaves new nodes
 * unplaced and therefore undrawn (`renderGraph` drops a node with no
 * position), so a note created in Obsidian would never appear.
 *
 * The shape key is exactly the line between those: it changes iff a node or an
 * edge was added or removed, which is precisely when the existing positions
 * are no longer a complete answer.
 */
export function shouldRelayout(previous: string | null, next: string): boolean {
  return previous !== next;
}

// --- persistence (§7.4, §11 P3) ------------------------------------------------------------

/**
 * The slice of `Storage` this module uses.
 *
 * Same two-method port as `layout.model.ts`'s `LayoutStorage`, and declared
 * separately rather than imported from it because the two are unrelated
 * concerns that merely happen to share a shape — coupling the graph's cache to
 * the column-width persistence would mean one cannot change without the other.
 */
export interface PositionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The `localStorage` key. Namespaced and versioned, like the layout's. */
export const POSITIONS_STORAGE_KEY = "pi-weave.graph.positions.v1";

/**
 * Coordinates are rounded to **one** decimal before storage.
 *
 * The layout spans thousands of units, so a tenth of a unit is far below one
 * screen pixel at any zoom a person uses. It roughly halves the stored string
 * and, more usefully, makes a hand-inspected entry readable. The rounding is
 * *not* fed back into the simulation as a warm start's only source — it is a
 * near-fixed-point either way (§8 pins re-running from settled positions moves
 * nothing by more than `CONTAINS_DISTANCE`), and a tenth of a unit is orders
 * of magnitude inside that.
 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Serialize a layout for storage.
 *
 * `[x, y]` pairs rather than `{x, y}` objects: same information, about 40 %
 * fewer bytes, and `localStorage` is a shared 5 MB budget this is not the only
 * consumer of.
 */
export function serializePositions(key: string, positions: ReadonlyMap<string, Point>): string {
  const at: Record<string, [number, number]> = {};
  for (const [id, point] of positions) at[id] = [round1(point.x), round1(point.y)];
  return JSON.stringify({ v: 1, key, at });
}

/**
 * Parse stored positions for a shape key, or `null`.
 *
 * Everything here is untrusted: the string is user-editable by construction
 * (it lives in a devtools pane anyone can type into) and it outlives the
 * schema, so a v1 reader will one day meet a v2 entry written by a newer build
 * the user ran yesterday. Both have the same correct answer — return `null`
 * and let the caller lay out from scratch. There is no repair path, because a
 * partially-repaired layout is a bug report that says "my graph is weird
 * sometimes".
 *
 * **A key mismatch is a miss, not an error.** That is the invalidation §11 P3
 * asks for, and it is one comparison: the stored layout describes a graph with
 * different nodes or edges in it, so it cannot be completed and is discarded
 * whole rather than merged. A partial merge would place the old nodes and
 * leave the new ones at the origin, which is the hairball §7.2 exists to
 * prevent.
 */
export function deserializePositions(raw: string | null, key: string): Map<string, Point> | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record["v"] !== 1) return null;
  if (record["key"] !== key) return null;

  const at = record["at"];
  if (typeof at !== "object" || at === null || Array.isArray(at)) return null;

  const out = new Map<string, Point>();
  for (const [id, value] of Object.entries(at as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [x, y] = value as [unknown, unknown];
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.set(id, { x, y });
  }
  // An entry that parsed to nothing is indistinguishable from no entry, and
  // returning an empty map would make the caller warm-start from nowhere while
  // believing it had a cache hit.
  return out.size === 0 ? null : out;
}

/**
 * Read the cached layout for a shape, or `null`.
 *
 * A throwing `getItem` — Safari private browsing, partitioned storage — is
 * indistinguishable from a miss as far as the graph is concerned, and a
 * workspace that lays out from scratch is not an error worth surfacing.
 */
export function loadPositions(storage: PositionStorage, key: string): Map<string, Point> | null {
  let raw: string | null;
  try {
    raw = storage.getItem(POSITIONS_STORAGE_KEY);
  } catch {
    return null;
  }
  return deserializePositions(raw, key);
}

/**
 * Persist a layout, best-effort. Returns whether it stuck.
 *
 * `setItem` fails on quota exhaustion and in partitioned-storage contexts, and
 * neither is a reason to break a graph that is already on screen — the user's
 * layout is correct, it just does not survive a reload.
 *
 * Only **one** layout is stored, keyed by shape rather than accumulated per
 * shape. A user with three repositories open over a week would otherwise
 * accumulate three multi-hundred-node position maps in a 5 MB budget shared
 * with every other pi-weave key, to save a few hundred milliseconds on a
 * switch back. One slot, last graph wins.
 */
export function savePositions(storage: PositionStorage, key: string, positions: ReadonlyMap<string, Point>): boolean {
  try {
    storage.setItem(POSITIONS_STORAGE_KEY, serializePositions(key, positions));
    return true;
  } catch {
    return false;
  }
}

/** Drop the cache. The escape hatch behind a re-layout control. */
export function clearPositions(storage: PositionStorage): boolean {
  try {
    storage.removeItem(POSITIONS_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// --- the whole resolution -------------------------------------------------------------------

/** A layout, and where it came from. */
export interface ResolvedLayout {
  readonly key: string;
  readonly positions: Map<string, Point>;
  /**
   * `true` when the cache answered and the simulation did not run.
   *
   * Reported rather than inferred so a test can assert the cache is actually
   * being used — a persistence layer that silently always misses is a
   * persistence layer that passes every test about its serializer.
   */
  readonly cached: boolean;
}

/**
 * The layout for a graph: cache first, simulation second.
 *
 * This is the whole of §11 P3's "position persistence in `localStorage` keyed
 * by repo hash", and the order is the point. A hit is instant and is the
 * arrangement the user already knows; a miss pays ~300 ticks once and is then
 * written back, so the second load of any graph is free.
 *
 * A cache hit is **used verbatim**, not re-simulated from. Re-running even
 * from a perfect warm start would move every node slightly (§8 measures the
 * drift as bounded but non-zero), so a user reopening the workspace would
 * watch the graph shuffle for no reason — which is exactly the "reshuffle
 * between sessions" §11 P3 asks to prevent.
 */
export function resolveLayout(
  storage: PositionStorage,
  nodes: readonly WireGraphNode[],
  edges: readonly WireGraphEdge[],
): ResolvedLayout {
  const key = graphShapeKey(nodes, edges);
  const cached = loadPositions(storage, key);
  // A cached map that is missing an id cannot be trusted as complete — the
  // shape key says the node set matches, so a gap means a truncated or
  // hand-edited entry. Fall through to a real layout rather than dropping the
  // node (which is what `renderGraph` would do with a missing position).
  if (cached !== null && nodes.every((node) => cached.has(node.id))) {
    return { key, positions: cached, cached: true };
  }
  const positions = layoutFor(nodes, edges);
  savePositions(storage, key, positions);
  return { key, positions, cached: false };
}
