/**
 * The recall trail: which notes the agent searched, read and wrote, in order.
 *
 * Agent memory is normally invisible — you cannot tell whether the agent
 * remembered, guessed, or missed the note you wrote last week. Every vault
 * operation already passes through `executeNoteAction`, so recording there
 * gives both harnesses (Pi and OpenCode) the same trail with no hooks.
 *
 * Deliberately **in memory only**. The trail is session presentation, not
 * knowledge: nothing here touches the vault, and a restart forgets it. The
 * browser workspace runs in the same process as the tools, so it reads the
 * buffer directly (`GET /api/trail`).
 *
 * ## Turns
 *
 * A turn is one user prompt's worth of agent work. Pi says so explicitly
 * (`agent_start` calls {@link RecallTrail.beginTurn}); a harness that never
 * does falls back to a time gap, so a pause of {@link TURN_GAP_MS} between
 * operations starts a new turn.
 */

/** How the agent touched a note. */
export type TrailKind = "searched" | "read" | "wrote";

/** One recorded operation. `slugs` may be empty for a search with no hits. */
export interface TrailEvent {
  /** Monotonic per buffer; the client's stable key. */
  seq: number;
  turn: number;
  /** ISO timestamp. */
  at: string;
  kind: TrailKind;
  /** The `weave_note` action that produced it (`search`, `append`, …). */
  action: string;
  slugs: string[];
  query?: string;
  /** The vault the operation ran against, so a server can filter to its own. */
  vault: string;
}

/** What a reader gets: the buffer plus a stamp that moves whenever it does. */
export interface TrailSnapshot {
  stamp: string;
  turn: number;
  events: TrailEvent[];
}

/** What a caller hands to {@link RecallTrail.record}. */
export interface TrailEntry {
  kind: TrailKind;
  action: string;
  slugs: readonly string[];
  query?: string | undefined;
  vault: string;
  at: Date;
}

/** Old events fall off the front; a few hundred is far more than any viewer shows. */
export const TRAIL_CAPACITY = 200;

/** Without explicit turn boundaries, this much quiet starts a new turn. */
export const TURN_GAP_MS = 120_000;

export class RecallTrail {
  private events: TrailEvent[] = [];
  private seq = 0;
  private turn = 0;
  private explicit = false;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly capacity = TRAIL_CAPACITY,
    private readonly gapMs = TURN_GAP_MS,
  ) {}

  /** Start a new turn. Once called, the time-gap fallback is off for good. */
  beginTurn(): void {
    this.explicit = true;
    this.turn += 1;
  }

  record(entry: TrailEntry): void {
    const at = entry.at.getTime();
    if (this.turn === 0 || (!this.explicit && at - this.lastAt > this.gapMs)) this.turn += 1;
    this.lastAt = at;
    this.seq += 1;
    this.events.push({
      seq: this.seq,
      turn: this.turn,
      at: entry.at.toISOString(),
      kind: entry.kind,
      action: entry.action,
      slugs: [...new Set(entry.slugs)],
      ...(entry.query !== undefined ? { query: entry.query } : {}),
      vault: entry.vault,
    });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
  }

  /** Distinct notes read or written in the current turn — the "used N notes" count. */
  usedThisTurn(): number {
    const used = new Set<string>();
    for (const event of this.events) {
      if (event.turn === this.turn && event.kind !== "searched") for (const slug of event.slugs) used.add(`${event.vault}\0${slug}`);
    }
    return used.size;
  }

  snapshot(): TrailSnapshot {
    return { stamp: `${this.turn}.${this.seq}`, turn: this.turn, events: this.events.map((event) => ({ ...event, slugs: [...event.slugs] })) };
  }

  /** Forget everything. For tests and a fresh session. */
  clear(): void {
    this.events = [];
    this.seq = 0;
    this.turn = 0;
    this.explicit = false;
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}

/** The process-wide trail the tools write and the workspace server reads. */
export const recallTrail = new RecallTrail();
