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
 *  - {@link agentSearch}: the agent's newest search this turn, which the
 *    graph view lights up in its spotlight ({@link agentSpotlight}).
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
 * Node id → glow. A node touched several ways in one turn shows the strongest
 * kind (wrote > read > searched) at the freshest strength; a later turn's
 * touch replaces an earlier turn's, so a note read now is not still shown as
 * written a turn ago.
 *
 * Live, an event stamped slightly in the future (clock skew) glows at full
 * strength; in a replay a step whose moment has not come yet stays dark.
 */
export function trailMarks(trail: TrailPayload | null, now: number, replay: TrailReplay | null = null): ReadonlyMap<string, TrailMark> {
  if (trail === null) return NO_MARKS;
  const marks = new Map<string, TrailMark>();
  const turnOf = new Map<string, number>();
  for (const { event, at } of lightTimes(trail, replay)) {
    const age = now - at;
    if (replay !== null && age < 0) continue;
    const strength = Math.min(1, 1 - age / TRAIL_FADE_MS);
    if (!(strength > 0)) continue;
    for (const slug of event.slugs) {
      const id = `note:${slug}`;
      // A newer turn's touch replaces an older turn's; within a turn the strongest kind wins.
      const existing = turnOf.get(id) === event.turn ? marks.get(id) : undefined;
      const kind = existing === undefined || RANK[event.kind] > RANK[existing.kind] ? event.kind : existing.kind;
      marks.set(id, { kind, strength: Math.max(strength, existing?.strength ?? 0) });
      turnOf.set(id, event.turn);
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

function clock(iso: string, seconds = false): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const parts = [at.getHours(), at.getMinutes(), ...(seconds ? [at.getSeconds()] : [])];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
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
  const turns = [...byTurn.entries()].sort(([a], [b]) => b - a);
  // Turns in the same minute would get identical chips, so those show seconds.
  const minutes = turns.map(([, events]) => clock(events[0]!.at));
  const views = turns.map(([turn, events], index) => {
    const used = new Set(events.filter((event) => event.kind !== "searched").flatMap((event) => event.slugs));
    const shared = minutes.filter((minute) => minute === minutes[index]).length > 1;
    return { turn, time: clock(events[0]!.at, shared), steps: events.map((event) => stepView(event, labels)), used: used.size };
  });
  if (trail.turn > views[0]!.turn) views.unshift({ turn: trail.turn, time: "", steps: [], used: 0 });
  return views.slice(0, TRAIL_TURNS_SHOWN);
}

/** What the strip says for a turn with no steps yet. */
export const TRAIL_EMPTY_TURN = "Nothing recalled yet.";

/** The strip's heading for a turn: the latest is "This turn", older ones are their time. */
export function turnHeading(view: TrailTurnView, latest: boolean): string {
  return latest ? "This turn" : view.time === "" ? `Turn ${view.turn}` : view.time;
}

// --- the agent's search in the graph view's spotlight ----------------------------------

/** The agent's newest search this turn: what the graph view's spotlight lights. */
export interface AgentSearch {
  /** The event's `seq`, so a new search is a new number even for the same words. */
  seq: number;
  query: string;
  /** The notes the search returned, as node ids. */
  ids: readonly string[];
}

/**
 * The agent's newest search in the current turn, or `null`.
 *
 * Only the current turn counts, so the spotlight a search lit goes out when
 * the agent moves on to the next request. A search with no words (the wire
 * allows one) has nothing to spell in the field and is skipped.
 */
export function agentSearch(trail: TrailPayload | null): AgentSearch | null {
  if (trail === null) return null;
  for (let index = trail.events.length - 1; index >= 0; index--) {
    const event = trail.events[index]!;
    if (event.turn !== trail.turn) return null;
    if (event.kind !== "searched" || event.query === undefined || event.query.trim() === "") continue;
    return { seq: event.seq, query: event.query, ids: event.slugs.map((slug) => `note:${slug}`) };
  }
  return null;
}

/** What the spotlight becomes: its query, the ids lit alongside, and the agent search that set it (`null`: the person's). */
export interface AgentSpotlight {
  query: string;
  ids: readonly string[];
  agent: number | null;
}

/**
 * How the graph view's spotlight follows the agent's searches, when
 * {@link agentSearch} changes. `null` leaves the spotlight alone.
 *
 * A new search takes the spotlight over, the way the palette's "light up in
 * graph" does, unless the person is in the middle of a query of their own:
 * the field focused with words they typed. A focused field that is empty, or
 * still shows an earlier agent search, is not theirs and follows along, so a
 * field left focused never swallows a search. When the turn that searched is
 * over, the spotlight it lit goes out, unless the person has made it theirs
 * since by typing or lighting something up.
 */
export function agentSpotlight(
  /** The `seq` of the agent search the spotlight shows now, or `null` when it is the person's (or empty). */
  shown: number | null,
  search: AgentSearch | null,
  /** Whether the field has focus and holds words; `shown` says whose words they are. */
  composing: boolean,
): AgentSpotlight | null {
  if (search === null) return shown === null ? null : { query: "", ids: [], agent: null };
  if (search.seq === shown || (composing && shown === null)) return null;
  return { query: search.query, ids: search.ids, agent: search.seq };
}
