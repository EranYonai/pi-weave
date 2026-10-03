/** Graph force settings shared without loading the d3 simulation. */

/**
 * The force constants, as one **mutable** record.
 *
 * Mutable because picking these numbers is an act of taste, not of
 * derivation: the difference between "one hairball" and "legible groups" is a
 * ratio between containment cohesion, charge and centre gravity that is far
 * easier to *see* than to reason about. The settings sliders (see
 * `client/graph/tuner.model.ts` and docs/weave-workspace.md §15.7) update this record
 * and re-run the layout live, so a human can find the values by eye and they then
 * get frozen back into {@link FORCE_DEFAULTS}.
 *
 * `computeLayout(model, { seed })` stays deterministic for a given set of forces.
 * Settings are the production writer of this record.
 *
 * ponytail: module-level mutable state, fine at one graph per page — thread it
 * as a `LayoutOptions` field if a second concurrent consumer ever appears.
 */
export interface ForceConstants {
  /** Rest length of a `contains` / `anchored-at` spring: a rosette's radius. */
  containsRest: number;
  /** Stiffness of that spring. This is what makes a group *be* a group. */
  containsStrength: number;
  /** Rest length of a `links-to` / `mentions` spring: the inter-group reach. */
  relationDistance: number;
  /** Stiffness of that spring. Weak, so associations bend without merging. */
  relationStrength: number;
  /** `forceManyBody` strength. Negative is repulsion. */
  charge: number;
  /**
   * Distance past which charge is ignored (`forceManyBody.distanceMax`).
   *
   * A cap rather than `Infinity` is what keeps a strong charge from simply
   * inflating the whole graph uniformly: beyond it, neighbours stop pushing
   * and only the springs and centre gravity speak, so groups separate at
   * local scale without the picture growing without bound.
   */
  chargeMax: number;
  /** `forceX`/`forceY` pull toward the origin. The no-escape guarantee. */
  center: number;
}

/**
 * The live constants. See {@link ForceConstants} for why this is mutable.
 *
 * These values were **found by eye** through the `?sliders=1` tuner and then
 * frozen here, which is the loop §15.7 describes working as intended. They are
 * not derived and should not be "corrected" toward rounder numbers: the
 * previous set (`containsStrength: 0.02`, `charge: -50`, `center: 0.09`) was
 * defensible on paper and produced a single hairball on screen.
 */
export const FORCES: ForceConstants = {
  containsRest: 55,
  containsStrength: 0.12,
  relationDistance: 50,
  relationStrength: 0.07,
  charge: -200,
  chargeMax: 800,
  center: 0.05,
};

/** The shipped values, for the tuner's reset and for a test to restore from. */
export const FORCE_DEFAULTS: Readonly<ForceConstants> = { ...FORCES };

/** Overwrite the live constants in place. The tuner's one write. */
export function setForces(next: Partial<ForceConstants>): void {
  Object.assign(FORCES, next);
}

