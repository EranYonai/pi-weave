/**
 * The history slider's controls, and the one DOM step the replay needs.
 *
 * Everything that can be decided without a DOM is in `replay.model.ts`.
 */

import type { HistoryRevision } from "../../shared/wire";
import { HISTORY_EMPTY, HISTORY_OFF_HINT, MARK_CLOSE, MARK_OPEN, replayStep, splitMarked } from "./replay.model";

/** What the column holds while replaying. `null` revisions means still loading. */
export interface ReplayState {
  revisions: HistoryRevision[] | null;
  enabled: boolean;
  index: number;
  playing: boolean;
  error: string | null;
}

/**
 * Turn the marker characters in rendered note HTML into `<mark>` elements.
 * Text nodes are created with `createTextNode`, so nothing here parses HTML.
 */
export function wrapMarks(root: HTMLElement): HTMLElement | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
  let inside = false;
  let first: HTMLElement | null = null;
  for (const node of nodes) {
    const text = node.data;
    if (!inside && !text.includes(MARK_OPEN) && !text.includes(MARK_CLOSE)) continue;
    const split = splitMarked(text, inside);
    inside = split.inside;
    const fragment = root.ownerDocument.createDocumentFragment();
    for (const part of split.parts) {
      const textNode = root.ownerDocument.createTextNode(part.text);
      if (!part.marked) {
        fragment.append(textNode);
        continue;
      }
      const mark = root.ownerDocument.createElement("mark");
      mark.className = "weave-replay-mark";
      mark.append(textNode);
      fragment.append(mark);
      first ??= mark;
    }
    node.replaceWith(fragment);
  }
  return first;
}

export function ReplayBar(props: {
  state: ReplayState;
  onIndex: (index: number) => void;
  onPlay: () => void;
}) {
  const { revisions, index, playing, enabled, error } = props.state;
  if (error !== null) return <div class="weave-replay" role="status">{error}</div>;
  if (revisions === null) return <div class="weave-replay" role="status">Loading history…</div>;
  const step = replayStep(revisions, index);
  if (step === null) return <div class="weave-replay" role="status">{enabled ? HISTORY_EMPTY : HISTORY_OFF_HINT}</div>;
  const last = revisions.length - 1;
  return (
    <div class="weave-replay" role="group" aria-label="Note history">
      <div class="weave-replay-controls">
        <button type="button" aria-label="Previous version" disabled={index <= 0} onClick={() => props.onIndex(index - 1)}>‹</button>
        <button type="button" class="weave-replay-play" aria-label={playing ? "Pause replay" : "Play replay"} disabled={last === 0} onClick={props.onPlay}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" aria-label="Next version" disabled={index >= last} onClick={() => props.onIndex(index + 1)}>›</button>
        <input
          class="weave-replay-slider"
          type="range"
          aria-label="Version"
          aria-valuetext={`${step.position}: ${step.action}`}
          min={0}
          max={last}
          step={1}
          value={index}
          disabled={last === 0}
          onInput={(event) => props.onIndex(Number(event.currentTarget.value))}
        />
        <span class="weave-replay-position">{step.position}</span>
      </div>
      <p class="weave-replay-caption" aria-live="polite">
        <span class={`weave-replay-who weave-replay-${step.by}`}>{step.action}</span>
        <span title={step.atIso}>{step.at}</span>
        {step.change === "" ? null : <span class="weave-replay-change">{step.change}</span>}
      </p>
      {enabled ? null : <p class="weave-replay-hint">{HISTORY_OFF_HINT}</p>}
    </div>
  );
}
