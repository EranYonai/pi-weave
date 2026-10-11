/**
 * The "This turn" strip at the top of the context rail (issue #78).
 *
 * Every string and every grouping comes from `trail.model.ts`; this renders
 * the newest turn's steps as `searched "auth" → read Auth migration → …`,
 * with each note a link, and the earlier turns as small time chips that
 * replay their glow when clicked.
 */

import type { TrailTurnView } from "./trail.model";
import { TRAIL_EMPTY_TURN, turnHeading } from "./trail.model";

export interface TrailStripProps {
  turns: readonly TrailTurnView[];
  /** The turn whose steps are listed — the replayed one, or `null` for the newest. */
  shownTurn: number | null;
  onSelect: (id: string, newTab?: boolean) => void;
  onReplay: (turn: number) => void;
}

export function TrailStrip(props: TrailStripProps) {
  const latest = props.turns[0];
  if (latest === undefined) return null;
  const shown = props.turns.find((view) => view.turn === props.shownTurn) ?? latest;
  return (
    <section class="weave-ctx-group weave-trail" aria-label="What your agent recalled">
      <h4 class="weave-ctx-head weave-trail-head">
        <span class="weave-trail-title">{turnHeading(shown, shown === latest)}</span>
        <span class="weave-ctx-count" title="Notes read or written">{shown.used}</span>
        {shown.steps.length === 0 ? null : <button type="button" class="weave-trail-replay" title="Replay this turn's glow" onClick={() => props.onReplay(shown.turn)}>Replay</button>}
      </h4>
      {shown.steps.length === 0 ? <p class="weave-trail-empty">{TRAIL_EMPTY_TURN}</p> : null}
      <ol class="weave-trail-steps">
        {shown.steps.map((step) => (
          <li key={step.key} class={`weave-trail-step weave-trail-${step.kind}`}>
            <span class="weave-trail-verb">{step.verb}</span>
            {step.notes.map((note) => (
              <button key={note.id} type="button" class="weave-trail-note" onClick={(event) => props.onSelect(note.id, event.metaKey || event.ctrlKey)}>{note.label}</button>
            ))}
            {step.detail === null ? null : <span class="weave-trail-detail">{step.detail}</span>}
          </li>
        ))}
      </ol>
      {props.turns.length < 2 ? null : (
        <div class="weave-trail-turns" role="group" aria-label="Earlier turns">
          {props.turns.map((view, index) => (
            <button key={view.turn} type="button" class={`weave-trail-turn${view.turn === shown.turn ? " weave-trail-turn-on" : ""}`} aria-pressed={view.turn === shown.turn} onClick={() => props.onReplay(view.turn)}>
              {turnHeading(view, index === 0)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
