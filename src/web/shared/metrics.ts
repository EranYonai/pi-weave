/**
 * Pure geometry over a laid-out point set (weave-workspace §8).
 *
 * These are the measurements the dynamics gate asserts on, and the same
 * measurements the graph column needs at runtime (`bbox` is what "fit to
 * view" is built from). They live in `src/web/shared` rather than in the
 * test tree so they are covered code, not untested test scaffolding.
 *
 * Isomorphic: no `node:*`, no DOM.
 */

export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/** The empty bounding box: zero-sized at the origin. */
const EMPTY_BBOX: BBox = { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, cx: 0, cy: 0 };

/**
 * Population variance. Zero for an empty or single-element sample, and — the
 * case that matters — exactly zero for the degenerate "every node on one
 * vertical line" layout that the retired simulation produced.
 */
export function variance(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let acc = 0;
  for (const v of values) {
    const d = v - mean;
    acc += d * d;
  }
  return acc / n;
}

/**
 * Smallest Euclidean distance between any two distinct points. `Infinity` for
 * fewer than two points (vacuously non-overlapping).
 *
 * O(n²). The gate runs it on a few hundred points, which is microseconds; if
 * a caller ever needs it on tens of thousands, sort-and-sweep it then.
 */
export function minPairwiseDistance(points: readonly Point[]): number {
  let min = Infinity;
  let i = 0;
  // `for…of` over a slice rather than indexing: `noUncheckedIndexedAccess`
  // would otherwise force an `undefined` guard on every access that can never
  // fire, and an untestable branch is worse than a copy of a few hundred refs.
  for (const a of points) {
    i++;
    for (const b of points.slice(i)) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < min) min = d;
    }
  }
  return min;
}

/** Axis-aligned bounding box, with width/height/centre precomputed. */
export function bbox(points: readonly Point[]): BBox {
  if (points.length === 0) return EMPTY_BBOX;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * How far apart the cluster anchors ended up: the smallest distance between
 * any two of `ids` in `positions`. Ids with no position are skipped; fewer
 * than two resolvable anchors yields `Infinity`.
 *
 * "The five roots stay distinct" is exactly this number staying large — if two
 * clusters merge, their anchors are the first thing to collide.
 */
export function clusterSeparation(positions: ReadonlyMap<string, Point>, ids: readonly string[]): number {
  const anchors: Point[] = [];
  for (const id of ids) {
    const p = positions.get(id);
    if (p !== undefined) anchors.push(p);
  }
  return minPairwiseDistance(anchors);
}

/**
 * How many of `sectors` equal angular slices around `center` contain at least
 * one of `points`. Points at the exact centre have no angle and are skipped.
 *
 * This is the difference between "a hub's leaves ring it" (occupancy →
 * `sectors`) and "a hub's leaves fell into a line" (occupancy → 2). A count,
 * not a ratio, because the interesting failure is whole sectors being empty.
 */
export function angularOccupancy(center: Point, points: readonly Point[], sectors: number): number {
  const hit = new Set<number>();
  const TAU = Math.PI * 2;
  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    if (dx === 0 && dy === 0) continue;
    // atan2 ∈ (-π, π] → [0, 1) → sector index, clamped against the +π edge.
    const unit = (Math.atan2(dy, dx) + Math.PI) / TAU;
    hit.add(Math.min(sectors - 1, Math.floor(unit * sectors)));
  }
  return hit.size;
}

/** True when every coordinate of every point is a finite number. */
export function allFinite(points: readonly Point[]): boolean {
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return true;
}
