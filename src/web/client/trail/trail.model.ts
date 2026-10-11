/**
 * The recall trail, decided (issue #78).
 *
 * `GET /api/trail` lists the notes the agent searched, read and wrote. This
 * module turns that list into the two things the workspace draws:
 *
 *  - {@link trailMarks}: which nodes glow right now, how, and how strongly.
 *    The glow fades over {@link TRAIL_FADE_MS}; a replayed turn relights its
 *    steps one after another from the moment it was clicked.
 *  - {@link trailTurns}: the "This turn" strip — each turn's steps in order,
 *    worded as `searched "auth" → read Auth migration → appended Auth migration`.
 *
 * Pure, DOM-free and clock-free (every function takes `now`), like the other
 * `*.model.ts` files, so the whole feature is covered by unit tests.
 */

import type { GraphPayload, TrailPayload, WireTrailEvent, WireTrailKind } from "../../shared/wire";

/** How long a glow takes to fade out completely. */
export const TRAIL_FADE_MS = 60_000;

/** How often the fade repaints while something is glowing. */
export const TRAIL_TICK_MS = 1_000;

/** In a replay, the gap between one step lighting and the next. */
export const REPLAY_STEP_MS = 700;

/** How many turns the strip lists. */
export const TRAIL_TURNS_SHOWN = 5;

/** One glowing node. `strength` runs 1 (just happened) → 0 (faded). */
export interface TrailMark {
  kind: WireTrailKind;
  strength: number;
}

/** A replay in progress: which turn, and when it was clicked. */
export interface TrailReplay {
  turn: number;
  startedAt: number;
}

/** A write outranks a read, which outranks a search hit. */
const RANK: Readonly<Record<WireTrailKind, number>> = { searched: 0, read: 1, wrote: 2 };

const NO_MARKS: ReadonlyMap<string, TrailMark> = new Map();

/** When each event lights, or `null` if it is not part of what is shown. */
function lightTimes(trail: TrailPayload, replay: TrailReplay | null): Array<{ event: WireTrailEvent; at: number }> {
  if (replay === null) return trail.events.map((event) => ({ event, at: Date.parse(event.at) }));
  return trail.events
    .filter((event) => event.turn === replay.turn)
    .map((event, index) => ({ event, at: replay.startedAt + index * REPLAY_STEP_MS }));
}

/**
 * Node id → glow. A node touched several ways shows the strongest kind
 * (wrote > read > searched) at the freshest strength.
 *
 * Live, an event stamped slightly in the future (clock skew) glows at full
 * strength; in a replay a step whose moment has not come yet stays dark.
 */
export function trailMarks(trail: TrailPayload | null, now: number, replay: TrailReplay | null = null): ReadonlyMap<string, TrailMark> {
  if (trail === null) return NO_MARKS;
  const marks = new Map<string, TrailMark>();
  for (const { event, at } of lightTimes(trail, replay)) {
    const age = now - at;
    if (replay !== null && age < 0) continue;
    const strength = Math.min(1, 1 - age / TRAIL_FADE_MS);
    if (!(strength > 0)) continue;
    for (const slug of event.slugs) {
      const id = `note:${slug}`;
      const existing = marks.get(id);
      const kind = existing === undefined || RANK[event.kind] > RANK[existing.kind] ? event.kind : existing.kind;
      marks.set(id, { kind, strength: Math.max(strength, existing?.strength ?? 0) });
    }
  }
  return marks.size === 0 ? NO_MARKS : marks;
}

/** Whether anything is still glowing or still to light — i.e. whether the fade clock should run. */
export function trailLive(trail: TrailPayload | null, now: number, replay: TrailReplay | null = null): boolean {
  if (trail === null) return false;
  return lightTimes(trail, replay).some(({ at }) => now - at < TRAIL_FADE_MS);
}

/** One note named in a step, ready to be a link. */
export interface TrailNoteView {
  id: string;
  label: string;
}

/** One step of a turn. */
export interface TrailStepView {
  key: string;
  kind: WireTrailKind;
  /** `searched "auth"`, `read`, `appended`, … */
  verb: string;
  /** The notes to link. Empty for a search, which names its hit count in `detail` instead. */
  notes: TrailNoteView[];
  detail: string | null;
}

/** One turn in the strip, newest first. */
export interface TrailTurnView {
  turn: number;
  /** Local `HH:MM` of the turn's first step. */
  time: string;
  steps: TrailStepView[];
  /** Distinct notes read or written. */
  used: number;
}

const WROTE_VERB: Readonly<Record<string, string>> = {
  add: "created",
  append: "appended",
  finalize: "finalized",
  links: "fixed links in",
};

function stepView(event: WireTrailEvent, labels: ReadonlyMap<string, string>): TrailStepView {
  const notes = event.slugs.map((slug) => ({ id: `note:${slug}`, label: labels.get(`note:${slug}`) ?? slug }));
  if (event.kind === "searched") {
    const hits = event.slugs.length;
    return {
      key: `${event.seq}:s`,
      kind: "searched",
      verb: event.query === undefined ? "searched" : `searched "${event.query}"`,
      notes: [],
      detail: hits === 0 ? "no hits" : `${hits} hit${hits === 1 ? "" : "s"}`,
    };
  }
  return {
    key: `${event.seq}:${event.kind}`,
    kind: event.kind,
    verb: event.kind === "read" ? "read" : WROTE_VERB[event.action] ?? "wrote",
    notes,
    detail: null,
  };
}

function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The strip: the newest {@link TRAIL_TURNS_SHOWN} turns, each with its steps in order.
 *
 * When the harness has started a turn that has not touched a note yet (Pi's
 * `agent_start` moves `trail.turn` ahead of the newest event), that empty
 * turn leads the list, so the previous turn is never presented as current.
 */
export function trailTurns(trail: TrailPayload | null, graph: GraphPayload | null): TrailTurnView[] {
  if (trail === null || trail.events.length === 0) return [];
  const labels = new Map<string, string>((graph?.model.nodes ?? []).map((node) => [node.id, node.label]));
  const byTurn = new Map<number, WireTrailEvent[]>();
  for (const event of trail.events) {
    const events = byTurn.get(event.turn);
    if (events === undefined) byTurn.set(event.turn, [event]);
    else events.push(event);
  }
  const views = [...byTurn.entries()]
    .sort(([a], [b]) => b - a)
    .map(([turn, events]) => {
      const used = new Set(events.filter((event) => event.kind !== "searched").flatMap((event) => event.slugs));
      return { turn, time: clock(events[0]!.at), steps: events.map((event) => stepView(event, labels)), used: used.size };
    });
  if (trail.turn > views[0]!.turn) views.unshift({ turn: trail.turn, time: "", steps: [], used: 0 });
  return views.slice(0, TRAIL_TURNS_SHOWN);
}

/** The strip's heading for a turn: the latest is "This turn", older ones are their time. */
/** What the strip says for a turn with no steps yet. */
export const TRAIL_EMPTY_TURN = "Nothing recalled yet.";

export function turnHeading(view: TrailTurnView, latest: boolean): string {
  return latest ? "This turn" : view.time === "" ? `Turn ${view.turn}` : view.time;
}

/** The tree row's class for a glow, or `""`. Strength is bucketed so the class list stays small. */
export function trailRowClass(mark: TrailMark | undefined): string {
  if (mark === undefined) return "";
  const level = mark.strength > 0.66 ? 3 : mark.strength > 0.33 ? 2 : 1;
  return ` weave-row-trail weave-row-trail-${mark.kind} weave-row-trail-${level}`;
}
