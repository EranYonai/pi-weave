/**
 * The hidden force tuner's logic (docs/weave-workspace.md §15.7).
 *
 * The graph's arrangement is decided by six numbers in `shared/layout.ts`, and
 * the difference between "one hairball" and "legible groups" is a *ratio*
 * between them that is far easier to see than to derive. So there is a panel
 * of sliders behind a URL flag, and everything about it that is not a DOM node
 * lives here — §10's rule, the same split `Graph.tsx` / `column.model.ts`
 * already uses.
 *
 * ## Why a query flag and not a setting
 *
 * The tuner is a *developer* affordance with a human in the loop; it is not a
 * feature and must not read as one. A URL string is the cheapest gate that is
 * genuinely hidden (no menu entry, no chord to collide with §11 P4's
 * keymap, no persisted state to leak into a normal session) while staying
 * reachable on a running workspace with no rebuild. A build-time `define`
 * would have been more hidden still and was rejected: it breaks the
 * byte-reproducible `build:web:check` contract for a panel that is already
 * unreachable without the flag.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`, but nothing here touches the DOM or npm — the flag
 * arrives as a `location.search` *string*, so this module compiles under the
 * root `tsconfig.json` and its tests are ordinary ones.
 */

import type { ForceConstants } from "../../shared/layout";
import { FORCE_DEFAULTS } from "../../shared/layout";

// --- the gate ----------------------------------------------------------------------

/** The query parameter that opens the panel. Documented in §15.7. */
export const FORCES_FLAG = "forces";

/**
 * Whether `location.search` asks for the tuner.
 *
 * `?forces`, `?forces=1` and `?forces=true` all open it; `?forces=0` and
 * `?forces=false` do not, so a bookmarked URL can carry the parameter in the
 * off position. Anything unparseable is off — a typo must not silently put a
 * debug panel over a user's graph.
 *
 * Hand-parsed rather than via `URLSearchParams`, which is a DOM/Node global
 * this tier's `tsconfig` does not provide.
 */
export function forcesFlag(search: string): boolean {
  for (const pair of search.replace(/^\?/, "").split("&")) {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (name !== FORCES_FLAG) continue;
    const value = eq === -1 ? "" : pair.slice(eq + 1).toLowerCase();
    return value !== "0" && value !== "false";
  }
  return false;
}

// --- the sliders --------------------------------------------------------------------

/** One slider: which constant it drives, and the range it may drive it over. */
export interface SliderSpec {
  readonly key: keyof ForceConstants;
  readonly label: string;
  /** One line under the label saying what moving it does. */
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/**
 * The panel, in the order the forces actually fight each other: cohesion
 * first (what holds a group together), then repulsion (what pushes groups
 * apart), then gravity (what pulls everything back in). Reading top to bottom
 * is reading the tug-of-war.
 *
 * Ranges are generous on purpose — the point of the exercise is that the
 * shipped values are in the wrong region, so a range hugging them would hide
 * the answer. `chargeMax` tops out at 4000, which is past any useful value on
 * a graph that spans a few thousand units; that top of the range is
 * effectively "uncapped".
 */
export const FORCE_SLIDERS: readonly SliderSpec[] = [
  { key: "containsStrength", label: "contains strength", hint: "how hard a parent holds its children — group cohesion", min: 0, max: 1, step: 0.01 },
  { key: "containsRest", label: "contains rest", hint: "how far children sit from their parent — rosette radius", min: 10, max: 300, step: 5 },
  { key: "relationStrength", label: "relation strength", hint: "pull of links-to / mentions across groups", min: 0, max: 1, step: 0.01 },
  { key: "relationDistance", label: "relation distance", hint: "how long those cross-group springs are", min: 20, max: 600, step: 10 },
  { key: "charge", label: "charge", hint: "node-to-node repulsion — more negative pushes harder", min: -1200, max: 0, step: 10 },
  { key: "chargeMax", label: "charge range", hint: "distance past which repulsion stops — caps overall spread", min: 100, max: 4000, step: 50 },
  { key: "center", label: "centre gravity", hint: "pull toward the origin — too much makes one blob", min: 0, max: 0.3, step: 0.005 },
];

/**
 * A starting point that is already *in the right region*, so the search does
 * not begin from the arrangement being complained about.
 *
 * Measured on `siblingBlobsGraph` at 300 ticks, worst-case gap between the
 * three big branches' bounding boxes: the shipped constants give **−312**
 * (the branches interleave — the hairball), these give **+221** (a visible
 * corridor). On `repoLikeGraph`, −274 → +315. Not proposed as the answer;
 * proposed as somewhere worth looking from.
 */
export const SUGGESTED: Readonly<ForceConstants> = {
  containsRest: 55,
  containsStrength: 0.8,
  relationDistance: 170,
  relationStrength: 0.05,
  charge: -250,
  chargeMax: 700,
  center: 0.02,
};

/**
 * A slider's value for `<input type="range">`.
 *
 * `chargeMax` defaults to `Infinity`, which is not a number a range input can
 * hold, so it reads as the top of its range — the position that means "no
 * meaningful cap", which is what `Infinity` is.
 */
export function sliderValue(forces: ForceConstants, spec: SliderSpec): number {
  const raw = forces[spec.key];
  if (!Number.isFinite(raw)) return spec.max;
  return Math.min(spec.max, Math.max(spec.min, raw));
}

/**
 * Parse and clamp what a slider reported.
 *
 * An `<input>`'s `value` is a string, and a non-numeric one (which the
 * platform should never produce, but a synthetic event can) falls back to the
 * shipped default rather than poisoning the simulation with a `NaN` that would
 * propagate to every node position in one tick.
 */
export function parseSlider(spec: SliderSpec, raw: string): number {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return FORCE_DEFAULTS[spec.key];
  return Math.min(spec.max, Math.max(spec.min, parsed));
}

/** A slider's readout. Short, and never `0.8500000000000001`. */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

// --- handing the numbers back ----------------------------------------------------------

/**
 * The current constants as the literal that belongs in `shared/layout.ts`.
 *
 * The whole point of the tuner is that a human finds the values and they then
 * get *frozen into the source*, so the last step of the loop is transcription
 * — and transcribing seven floats by eye off a panel is exactly where a digit
 * gets dropped. The Copy button emits the block verbatim.
 */
export function forcesSnippet(forces: ForceConstants): string {
  const line = (key: keyof ForceConstants): string => `  ${key}: ${Number.isFinite(forces[key]) ? forces[key] : "Infinity"},`;
  return ["export const FORCES: ForceConstants = {", ...FORCE_SLIDERS.map((spec) => line(spec.key)), "};"].join("\n");
}

/** True when nothing has been moved off the shipped values. Drives "Reset". */
export function isDefault(forces: ForceConstants): boolean {
  return FORCE_SLIDERS.every((spec) => Object.is(forces[spec.key], FORCE_DEFAULTS[spec.key]));
}
