/**
 * The hidden force tuner panel (docs/weave-workspace.md §15.7).
 *
 * Props in, JSX out. Every range, label, parse and clamp comes from
 * `tuner.model.ts`; what is left here is seven `<input type="range">` elements
 * and two buttons. Native range inputs rather than a slider component, for the
 * obvious reason: the platform has had this element since 2011.
 *
 * Rendered only when `Graph.tsx` was handed `tuner` — that is, only when
 * `?sliders=1` was on the URL. See `slidersFlag`.
 */

import { useState } from "preact/hooks";
import { FORCES, FORCE_DEFAULTS, setForces } from "../../shared/layout";
import type { SliderSpec } from "./tuner.model";
import { FORCE_SLIDERS, HAIRBALL, forcesSnippet, formatValue, isDefault, parseSlider, sliderValue } from "./tuner.model";

export interface ForceTunerProps {
  /**
   * Called after every write to `FORCES`, so the column can drop its cached
   * layout and re-run the simulation. The panel never lays out anything
   * itself — it mutates the constants and says so.
   */
  onChange: () => void;
  /** Whether nodes are coloured by group hue (§15.8). */
  groupColors: boolean;
  /** Toggle that. Owned by the column, which persists it. */
  onGroupColors: (next: boolean) => void;
}

export function ForceTuner(props: ForceTunerProps) {
  // The panel's own re-render trigger. `FORCES` is a plain mutable object, so
  // preact cannot observe it; a counter is the whole subscription.
  const [, bump] = useState(0);
  const [copied, setCopied] = useState(false);

  const apply = (spec: SliderSpec, raw: string): void => {
    setForces({ [spec.key]: parseSlider(spec, raw) });
    setCopied(false);
    bump((n) => n + 1);
    props.onChange();
  };

  const applyAll = (next: Partial<typeof FORCES>): void => {
    setForces(next);
    setCopied(false);
    bump((n) => n + 1);
    props.onChange();
  };

  return (
    <div class="weave-tuner">
      <p class="weave-tuner-title">graph forces · ?sliders=1</p>
      <label class="weave-tuner-toggle" title="hue per containment group, shade per kind">
        <input type="checkbox" checked={props.groupColors} onChange={(event) => props.onGroupColors((event.currentTarget as HTMLInputElement).checked)} />
        <span>colour by group</span>
      </label>
      {FORCE_SLIDERS.map((spec) => (
        <label class="weave-tuner-row" key={spec.key} title={spec.hint}>
          <span class="weave-tuner-label">
            {spec.label}
            <b>{formatValue(FORCES[spec.key])}</b>
          </span>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={sliderValue(FORCES, spec)}
            onInput={(event) => apply(spec, (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
      ))}
      <div class="weave-tuner-actions">
        <button type="button" class="weave-chip" disabled={isDefault(FORCES)} onClick={() => applyAll(FORCE_DEFAULTS)}>
          reset
        </button>
        <button type="button" class="weave-chip" title="the pre-tuner constants, for comparison — see HAIRBALL" onClick={() => applyAll(HAIRBALL)}>
          before
        </button>
        <button
          type="button"
          class="weave-chip"
          onClick={() => {
            // Best-effort: `navigator.clipboard` is absent over plain HTTP in
            // some browsers, and the snippet is on screen in the panel anyway.
            void navigator.clipboard?.writeText(forcesSnippet(FORCES)).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "copied ✓" : "copy values"}
        </button>
      </div>
      <pre class="weave-tuner-snippet">{forcesSnippet(FORCES)}</pre>
    </div>
  );
}
