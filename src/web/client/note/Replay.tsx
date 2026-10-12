/**
 * The history slider's controls, and the one DOM step the replay needs.
 *
 * Everything that can be decided without a DOM is in `replay.model.ts`.
 */

import { useLayoutEffect, useRef } from "preact/hooks";
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

/** Past this many versions the track shows no per-version dots: they would touch. */
const MAX_TICKS = 80;

const Icon = (props: { d: string; fill?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true"
    fill={props.fill ? "currentColor" : "none"} stroke={props.fill ? "none" : "currentColor"}
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d={props.d} />
  </svg>
);

export function ReplayBar(props: {
  state: ReplayState;
  onIndex: (index: number) => void;
  onPlay: () => void;
}) {
  const { revisions, index, playing, enabled, error } = props.state;
  const track = useRef<HTMLDivElement>(null);
  const last = revisions === null ? 0 : revisions.length - 1;
  // CSSOM, not a style attribute (the CSP forbids those): how far along the
  // track the filled part reaches.
  useLayoutEffect(() => {
    track.current?.style.setProperty("--weave-replay-at", `${last === 0 ? 100 : (index / last) * 100}%`);
  }, [index, last]);
  if (error !== null) return <div class="weave-replay weave-replay-note" role="status">{error}</div>;
  if (revisions === null) return <div class="weave-replay weave-replay-note" role="status">Loading history…</div>;
  const step = replayStep(revisions, index);
  if (step === null) return <div class="weave-replay weave-replay-note" role="status">{enabled ? HISTORY_EMPTY : HISTORY_OFF_HINT}</div>;
  return (
    <div class="weave-replay" role="group" aria-label="Note history">
      <p class="weave-replay-caption" aria-live="polite">
        <span class="weave-replay-clock"><Icon d="M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3zM9 5.5V9l2.5 1.5" /></span>
        <span class="weave-replay-position">Version {step.position}</span>
        <span class={`weave-replay-who weave-replay-${step.by}`}>{step.action}</span>
        <span class="weave-replay-time" title={step.atIso}>{step.at}</span>
        {step.change === "" ? null : <span class="weave-replay-change">{step.change}</span>}
      </p>
      <div class="weave-replay-controls">
        <button type="button" aria-label="Previous version" disabled={index <= 0} onClick={() => props.onIndex(index - 1)}>
          <Icon d="m11 4-5 5 5 5" />
        </button>
        <button type="button" class="weave-replay-play" aria-label={playing ? "Pause replay" : "Play replay"} disabled={last === 0} onClick={props.onPlay}>
          {playing ? <Icon d="M5 4h3v10H5zM10 4h3v10h-3z" fill /> : <Icon d="M6 4v10l8-5z" fill />}
        </button>
        <button type="button" aria-label="Next version" disabled={index >= last} onClick={() => props.onIndex(index + 1)}>
          <Icon d="m7 4 5 5-5 5" />
        </button>
        <div class="weave-replay-track" ref={track}>
          {revisions.length > MAX_TICKS || last === 0 ? null : (
            <span class="weave-replay-ticks" aria-hidden="true">
              {revisions.map((revision, at) => (
                <span key={at} class={`weave-replay-tick weave-replay-${revision.by}${at > index ? " weave-replay-ahead" : ""}`} />
              ))}
            </span>
          )}
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
        </div>
      </div>
      {enabled ? null : <p class="weave-replay-hint">{HISTORY_OFF_HINT}</p>}
    </div>
  );
}
