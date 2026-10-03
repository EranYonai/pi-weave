/** Native graph layout sliders, available under Settings → Interface. */
import { FORCE_DEFAULTS, type ForceConstants } from "../../shared/layout";
import { FORCE_SLIDERS, formatValue, isDefault, parseSlider, sliderValue } from "./tuner.model";

export function ForceTuner(props: { forces: ForceConstants; onChange: (forces: ForceConstants) => void }) {
  return <div class="weave-settings-forces">
    {FORCE_SLIDERS.map((spec) => <label class="weave-setting-row" key={spec.key}>
      <span><strong>{spec.label}</strong><small>{spec.hint}</small></span>
      <span class="weave-setting-range"><input aria-label={spec.label} type="range" min={spec.min} max={spec.max} step={spec.step}
        value={sliderValue(props.forces, spec)} onInput={(event) => props.onChange({ ...props.forces, [spec.key]: parseSlider(spec, event.currentTarget.value) })} />
        <output>{formatValue(props.forces[spec.key])}</output></span>
    </label>)}
    <button type="button" disabled={isDefault(props.forces)} onClick={() => props.onChange({ ...FORCE_DEFAULTS })}>Reset graph layout</button>
  </div>;
}
