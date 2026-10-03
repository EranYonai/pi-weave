/** Parsing and formatting for Settings → Interface graph sliders. */
import { FORCE_DEFAULTS, type ForceConstants } from "../../shared/layout";
import { FORCE_SLIDERS } from "../../shared/preferences";
import type { SliderSpec } from "../../shared/preferences";
export { FORCE_SLIDERS };
export type { SliderSpec };

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

export function isDefault(forces: ForceConstants): boolean {
  return FORCE_SLIDERS.every((spec) => Object.is(forces[spec.key], FORCE_DEFAULTS[spec.key]));
}
