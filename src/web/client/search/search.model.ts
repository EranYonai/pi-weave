/**
 * Everything the ⌘K palette *decides* (weave-workspace §1.1, §1.3, §10, P4).
 *
 * The palette is the one surface in the workspace that spans both faces of
 * the product at once — the vault (notes, searched on the server by
 * `searchNotes`, with snippets) and the repository (modules, files, entry
 * points, which exist only as labels in the graph payload the client already
 * holds). §1.1 says the graph and the tree are *lenses onto the same
 * knowledge*; a search box that could only see one of them would contradict
 * that on the very first keystroke.
 *
 * So this module does four things and `SearchPalette.tsx` does none of them:
 *
 *  1. **Ranks** a note hit and a graph node on one comparable scale
 *     ({@link labelScore}, {@link noteScore}, {@link nodeScore}).
 *  2. **Merges and dedupes** the two sources into one ordered list
 *     ({@link mergeResults}), because a note is *both* a search hit and a
 *     graph node and must appear once.
 *  3. **Debounces** typing and **discards stale responses**
 *     ({@link reduceSearch}) — as a reducer over an injected clock, never a
 *     timer this module owns.
 *  4. **Moves the cursor** ({@link searchKey}), in the same
 *     `handled: false`-for-keys-we-did-not-consume shape as `treeKey`.
 *
 * ## Tier rules (§2)
 *
 * `src/web/client/**`: `src/web/shared` and browser deps only, never
 * `src/core` and never `node:*`. This file additionally names no DOM type at
 * all — the clock arrives as a number — which is what lets the root
 * `tsconfig.json` project (no `DOM` lib) compile the tests that import it.
 */

import type { GraphPayload, NoteSearchHit, WireGraphNode, WireNodeKind } from "../../shared/wire";

// --- results -------------------------------------------------------------------

/**
 * Which half of the workspace a row came from.
 *
 * Two values, not nine. The user is choosing between "a note I wrote" and "a
 * thing in the repository", and the node's precise kind is carried separately
 * in {@link SearchResult.badge} — collapsing that distinction into the kind
 * would make the two sources indistinguishable, and P4's brief is explicit
 * that they must be labelled distinctly.
 */
export type SearchResultKind = "note" | "node";

/** One row of the palette, fully resolved for rendering. */
export interface SearchResult {
  /** The graph node id. What gets written to §1.3's `selectedId`. */
  readonly id: string;
  readonly kind: SearchResultKind;
  /** The note's title, or the node's label. */
  readonly label: string;
  /**
   * The second line: the server's snippet for a note, the node's path (or
   * URL, or slug) for a node. Empty when the node carries none, in which case
   * the row is one line — better than a placeholder that says nothing.
   */
  readonly detail: string;
  /** The kind word shown beside the label: `note`, `module`, `file`, … */
  readonly badge: string;
  /** The rank. Higher first. See {@link labelScore}. */
  readonly score: number;
}

/**
 * How many rows the palette will show.
 *
 * A cap rather than a scroll region: a one-character query matches most of a
 * repository, and a palette that answers with four hundred rows has answered
 * with nothing. Twenty is roughly a screen, and the ranking below is what
 * makes the truncation safe — the rows that survive are the strongest
 * matches, not the first twenty in graph order.
 */
export const MAX_RESULTS = 20;

// --- ranking -------------------------------------------------------------------

/**
 * How well a label matches a query, 0 (not at all) to 100 (exactly).
 *
 * Four tiers, and the gaps between them are deliberate: they are wide enough
 * that no amount of secondary evidence ({@link evidenceScore}, capped at 20)
 * can lift a weaker *kind* of match above a stronger one. A note that merely
 * mentions "layout" in its body must never outrank the module actually called
 * `layout`, and the only way to guarantee that with a summed score is to make
 * the tiers further apart than the addend.
 *
 * Case-insensitive and trimmed, because the query comes from a text input and
 * a trailing space is a typo, not a filter.
 */
export function labelScore(label: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const l = label.toLowerCase();
  const at = l.indexOf(q);
  if (at === -1) return 0;
  if (l === q) return 100;
  if (at === 0) return 70;
  // A match after a separator — `graph/layout` for "layout", `note-model` for
  // "model" — is what a user means far more often than one in the middle of a
  // word, and path-shaped labels are most of this graph.
  return /[a-z0-9]/.test(l.charAt(at - 1)) ? 30 : 50;
}

/**
 * The most a server-side hit's own score may contribute.
 *
 * `searchNotes` scores title 3, tag 2 and up to 5 body occurrences, so its
 * range is 0–10; doubling it gives 0–20, which sits below the weakest
 * {@link labelScore} tier (30) by construction. That is the invariant: body
 * evidence *breaks ties* and surfaces notes whose title says nothing, but it
 * never overturns a label match.
 */
export const MAX_EVIDENCE = 10;

/** A server hit's score, clamped and weighted into the 0–20 band. */
export function evidenceScore(score: number): number {
  return Math.min(Math.max(score, 0), MAX_EVIDENCE) * 2;
}

/** The graph node id for a note slug. The one place this shape is written. */
export function noteNodeId(slug: string): string {
  return `note:${slug}`;
}

/** Rank a server-side note hit. */
export function noteScore(hit: NoteSearchHit, query: string): number {
  return labelScore(hit.summary.title, query) + evidenceScore(hit.score);
}

/** Rank a graph node. Label only — a node has no body to search. */
export function nodeScore(node: WireGraphNode, query: string): number {
  return labelScore(node.label, query);
}

/**
 * The second line for a graph node.
 *
 * `detail` is a display-only bag the graph builder fills differently per kind
 * (`path` for a module or a file, `url` for an external, `slug` for a note),
 * so this picks the first present in preference order rather than assuming a
 * key that half the kinds do not have. An empty string means "render one
 * line", which is what a `vault` or `gitState` row honestly is.
 */
export const NODE_DETAIL_KEYS: readonly string[] = ["path", "manifest", "url", "slug"];

/** The detail line for a node, or `""`. */
export function nodeDetail(node: WireGraphNode): string {
  for (const key of NODE_DETAIL_KEYS) {
    const value = node.detail[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** The badge word for a node kind. The wire kind, verbatim — it is the truth. */
export function nodeBadge(kind: WireNodeKind): string {
  return kind;
}

/**
 * Order two results.
 *
 * Score first, then notes ahead of nodes, then label, then id. The last two
 * exist so the list is **totally** ordered: a palette whose rows reshuffle
 * between two keystrokes that produced the same scores is one nobody can hit
 * Enter on with confidence, and `Array.prototype.sort` is only stable within
 * one call — the two input arrays are rebuilt from scratch every render.
 */
export function compareResults(a: SearchResult, b: SearchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.kind !== b.kind) return a.kind === "note" ? -1 : 1;
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

/**
 * Merge the two sources into the ordered, deduped, capped result list.
 *
 * **Notes win a collision.** Every note is also a graph node, so a query
 * matching a note's title matches twice; the hit is kept because it is
 * strictly richer — it carries a snippet and the server's body evidence,
 * where the node carries a label. Dropping the node rather than the hit is
 * also what keeps the counts honest: the palette says "8 results" and there
 * are eight distinct things to select.
 *
 * The two arguments are deliberately scored against *different* queries at
 * the call site — see {@link SearchState}. Graph labels are local and rank
 * against what the user has typed *now*; note hits arrived from a request and
 * rank against the query that request carried. That is the only way local
 * results can be instant while remote ones are debounced, and it is why the
 * query is a parameter here rather than read off the state.
 */
export function mergeResults(
  hits: readonly NoteSearchHit[],
  hitQuery: string,
  nodes: readonly WireGraphNode[],
  nodeQuery: string,
): SearchResult[] {
  const byId = new Map<string, SearchResult>();

  for (const hit of hits) {
    const id = noteNodeId(hit.summary.slug);
    byId.set(id, {
      id,
      kind: "note",
      label: hit.summary.title,
      detail: hit.snippet,
      badge: "note",
      score: noteScore(hit, hitQuery),
    });
  }

  for (const node of nodes) {
    if (byId.has(node.id)) continue;
    const score = nodeScore(node, nodeQuery);
    if (score === 0) continue;
    byId.set(node.id, { id: node.id, kind: "node", label: node.label, detail: nodeDetail(node), badge: nodeBadge(node.kind), score });
  }

  return [...byId.values()].sort(compareResults).slice(0, MAX_RESULTS);
}

// --- state ---------------------------------------------------------------------

/**
 * Everything the palette remembers.
 *
 * Three of these fields exist solely to make asynchrony correct, and they are
 * worth naming individually because each defends against a different bug:
 *
 * - `issued` — the query the most recent request carried. Guards against
 *   re-issuing an identical request when a stray timer fires.
 * - `seq` / `applied` — a monotonic request counter and the highest one whose
 *   response has been used. This is the stale-response guard: two requests in
 *   flight can complete in either order, and without `applied` the *slower,
 *   older* one overwrites the newer results with answers to a query the user
 *   has already finished typing past. That failure is intermittent, invisible
 *   in a fast test, and extremely obvious to a user typing at speed.
 * - `pending` — whether a debounce timer is already armed. One chain at a
 *   time, so a burst of keystrokes cannot accumulate one timer each.
 */
export interface SearchState {
  /** Live text in the input. */
  readonly query: string;
  /** Epoch ms of the most recent keystroke. The debounce reads this. */
  readonly typedAt: number;
  /** The query of the last issued request, or `""` when none has been. */
  readonly issued: string;
  /** The query the currently-held {@link hits} answer. */
  readonly answered: string;
  /** Monotonic request counter. */
  readonly seq: number;
  /** Highest `seq` whose response has been applied. */
  readonly applied: number;
  readonly hits: readonly NoteSearchHit[];
  /** Cursor into the merged result list. Clamped at render, not here. */
  readonly cursor: number;
  /** A debounce timer is armed. */
  readonly pending: boolean;
  /** A request is in flight. Drives the "searching…" line. */
  readonly loading: boolean;
  /** The last applied response was a failure. */
  readonly failed: boolean;
}

/** A palette that has never been used. */
export function initialSearchState(): SearchState {
  return { query: "", typedAt: 0, issued: "", answered: "", seq: 0, applied: 0, hits: [], cursor: 0, pending: false, loading: false, failed: false };
}

/**
 * How long after the last keystroke a request is issued.
 *
 * 140 ms is below the ~200 ms at which a delay starts reading as lag and
 * above a fast typist's inter-key interval, so a word typed at speed costs
 * one request rather than five. The tree's filter box deliberately has *no*
 * debounce (`setQuery` in `tree.model.ts`) and the difference is not
 * inconsistency: that filter is a synchronous walk over memory, this one is a
 * round trip that reads every note in the vault off disk.
 */
export const DEBOUNCE_MS = 140;

/** What the reducer wants done as a result of a transition. */
export interface SearchRequest {
  readonly seq: number;
  readonly query: string;
}

/**
 * The outcome of one transition.
 *
 * Effects are *returned*, never performed: this module cannot fetch and must
 * not own a timer, so it says what should happen and `search.ts` does it.
 * That is what makes the debounce testable without waiting 140 ms.
 */
export interface SearchTransition {
  readonly state: SearchState;
  /** Issue this request now. */
  readonly request: SearchRequest | null;
  /** Arm a timer for this many ms, then dispatch a `tick`. */
  readonly schedule: number | null;
}

/** Everything that can happen to the palette. */
export type SearchEvent =
  /** The text changed. `now` is the clock, injected. */
  | { readonly type: "query"; readonly query: string; readonly now: number }
  /** A debounce timer fired. May issue, may re-arm — see {@link reduceSearch}. */
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "response"; readonly seq: number; readonly query: string; readonly hits: readonly NoteSearchHit[] }
  | { readonly type: "failed"; readonly seq: number }
  /** Pointer hover, or a programmatic move. */
  | { readonly type: "cursor"; readonly cursor: number }
  /** The palette closed. Disarms the debounce; keeps the results. */
  | { readonly type: "dismiss" };

function idle(state: SearchState): SearchTransition {
  return { state, request: null, schedule: null };
}

/**
 * Whether a response may be applied.
 *
 * `>` and not `>=`: a duplicate delivery of the response already applied is
 * as unwelcome as an older one, and `applied` starts at 0 while `seq` starts
 * at 1, so the first response is never rejected.
 */
export function isFresh(state: SearchState, seq: number): boolean {
  return seq > state.applied;
}

/**
 * The palette's state machine.
 *
 * The debounce is the interesting part, and it is a **trailing** one built
 * from a single re-arming timer rather than a cancel-and-replace:
 *
 * ```text
 * query  → record `typedAt`; arm a timer only if none is armed
 * tick   → elapsed >= DEBOUNCE_MS ? issue : re-arm for the remainder
 * ```
 *
 * The re-arm branch is what makes one timer sufficient. A keystroke at t=0
 * arms a tick for t=140; a keystroke at t=100 does not arm anything, so the
 * t=140 tick fires with only 40 ms elapsed and re-arms itself for t=240. The
 * request goes out 140 ms after the *last* keystroke, exactly as intended,
 * and at no point are two timers alive. Cancelling would need a handle, which
 * means owning a timer id, which means this module could not be pure.
 *
 * An empty query is not a request. `GET /api/search?q=` is valid and answers
 * with no hits (`api.ts`), but spending a round trip to be told what we
 * already know is worse than clearing locally — and clearing must be
 * immediate, because the alternative is 140 ms of results for a query the box
 * no longer contains.
 */
export function reduceSearch(state: SearchState, event: SearchEvent): SearchTransition {
  switch (event.type) {
    case "query": {
      // The cursor goes home on every edit: the row under it was chosen from
      // a different result list, and silently re-pointing it at whatever is
      // now third is how a palette opens the wrong thing on Enter.
      const next = { ...state, query: event.query, typedAt: event.now, cursor: 0 };
      if (event.query.trim() === "") {
        // Local, immediate, and it also disarms: there is nothing to fetch.
        return idle({ ...next, hits: [], answered: "", issued: "", loading: false, failed: false, pending: false });
      }
      // Already armed → the running chain will pick this text up on its next
      // tick. That is the whole re-arm mechanism; see the doc comment.
      if (state.pending) return idle(next);
      return { state: { ...next, pending: true }, request: null, schedule: DEBOUNCE_MS };
    }

    case "tick": {
      if (!state.pending) return idle(state);
      const waited = event.now - state.typedAt;
      if (waited < DEBOUNCE_MS) return { state, request: null, schedule: DEBOUNCE_MS - waited };
      const query = state.query.trim();
      // A stray tick for text we have already asked about, or for an empty
      // box, costs nothing but must not cost a request either.
      if (query === "" || query === state.issued) return idle({ ...state, pending: false });
      const seq = state.seq + 1;
      return { state: { ...state, pending: false, loading: true, seq, issued: query }, request: { seq, query }, schedule: null };
    }

    case "response": {
      if (!isFresh(state, event.seq)) return idle(state);
      return idle({
        ...state,
        applied: event.seq,
        hits: event.hits,
        answered: event.query,
        // Still loading if a *newer* request is out; the response we just
        // applied is not the one the box is waiting for.
        loading: event.seq < state.seq,
        failed: false,
        cursor: 0,
      });
    }

    case "failed": {
      if (!isFresh(state, event.seq)) return idle(state);
      // The hits are left alone. Stale results beside a failure notice are
      // more useful than a blank palette, and `api.ts` returns failures as
      // values precisely so this layer can make that choice.
      return idle({ ...state, applied: event.seq, loading: event.seq < state.seq, failed: true });
    }

    case "cursor":
      return idle({ ...state, cursor: event.cursor });

    case "dismiss":
      // Disarm, so a timer already in flight lands on `pending: false` and
      // no-ops instead of firing a request at a palette nobody is looking at.
      return idle({ ...state, pending: false });
  }
}

// --- keyboard ------------------------------------------------------------------

/** What a key did in the palette. */
export interface SearchKeyResult {
  readonly state: SearchState;
  /** The result index to open, or `null`. */
  readonly activate: number | null;
  /** The palette should close. */
  readonly dismiss: boolean;
  /** `false` when the key meant nothing here and the browser should keep it. */
  readonly handled: boolean;
}

/**
 * Keep a cursor inside a list.
 *
 * Applied at render rather than stored, for `indexOfRow`'s reason: the result
 * list is rebuilt from a query and a payload that both change underneath the
 * cursor, so an index validated when it was set is not an index that is still
 * valid now.
 */
export function clampCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(cursor, 0), count - 1);
}

/**
 * Move the cursor, **wrapping** at both ends.
 *
 * The opposite of `moveSelection` in `tree.model.ts`, which clamps, and the
 * difference is a real one rather than an oversight. A tree is spatial —
 * position carries meaning and jumping from the last note to `vault` is
 * disorienting. A ranked result list is not: it is short, it has no
 * structure, and ↑ from the top to reach the last row is what every palette a
 * user has ever used does.
 */
export function wrapCursor(cursor: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((cursor + delta) % count) + count) % count;
}

/** The id at a result index, or `null`. Exists for `idAt`'s reason. */
export function resultIdAt(results: readonly SearchResult[], index: number | null): string | null {
  return index === null ? null : (results[index]?.id ?? null);
}

/**
 * Apply a key inside the palette.
 *
 * `handled: false` for everything else — the same contract `treeKey` states,
 * and for the same reason: this handler sits on an overlay containing a text
 * input, so swallowing anything it did not consume would break typing, Tab,
 * ⌘R and text selection in one go.
 *
 * `Tab` is *deliberately* not listed. The focus trap owns it (`focus.model.ts`),
 * because trapping is a property of the dialog and not of the result list, and
 * two handlers both claiming Tab is how a trap ends up moving focus twice.
 */
export function searchKey(state: SearchState, key: string, count: number): SearchKeyResult {
  const unchanged: SearchKeyResult = { state, activate: null, dismiss: false, handled: false };
  const at = (cursor: number): SearchKeyResult => ({ state: { ...state, cursor }, activate: null, dismiss: false, handled: true });
  const here = clampCursor(state.cursor, count);

  if (key === "ArrowDown") return at(wrapCursor(here, 1, count));
  if (key === "ArrowUp") return at(wrapCursor(here, -1, count));
  if (key === "Home") return at(0);
  if (key === "End") return at(clampCursor(count - 1, count));
  if (key === "Escape") return { state, activate: null, dismiss: true, handled: true };
  if (key !== "Enter") return unchanged;
  // Enter on an empty list is not "handled": there is nothing to open, and
  // eating the key would break a form submit if this palette ever sits in one.
  if (count === 0) return unchanged;
  return { state, activate: here, dismiss: true, handled: true };
}

// --- copy ----------------------------------------------------------------------

/** The dialog's accessible name, and its visible heading. */
export const PALETTE_TITLE = "Search the workspace";

/** The input's placeholder and `aria-label`. */
export const PALETTE_PLACEHOLDER = "Search notes and repository…";

/** The footer hint, teaching the keys the palette responds to. */
export const PALETTE_HINT = "↑↓ move · ↵ open · esc close";

/**
 * What the palette says instead of rows.
 *
 * Five situations, and conflating them is how a search box ends up telling a
 * user there is nothing in their vault because the server restarted.
 * `null` means "there are rows — render them".
 */
export function searchStatus(state: SearchState, count: number): string | null {
  if (state.query.trim() === "") return "Type to search notes, modules, files and entry points.";
  if (count > 0) return null;
  if (state.failed) return "search failed — the workspace server may be gone";
  if (state.loading || state.pending) return "searching…";
  return `no matches for “${state.query.trim()}”`;
}

/** `8 results` / `1 result`, for the footer count. */
export function resultCountLabel(count: number): string {
  return count === 1 ? "1 result" : `${count} results`;
}

// --- the whole palette, resolved ------------------------------------------------

/** One row, with the presentation flags a list item needs. */
export interface SearchRowView extends SearchResult {
  readonly active: boolean;
  /** `id` of the `<li>`, so `aria-activedescendant` can point at it. */
  readonly domId: string;
}

/** Everything `SearchPalette.tsx` renders. Built by {@link paletteModel}. */
export interface PaletteModel {
  readonly rows: readonly SearchRowView[];
  /** The message shown instead of rows, or `null`. */
  readonly status: string | null;
  readonly count: number;
  readonly countLabel: string;
  /** The clamped cursor. */
  readonly cursor: number;
  /** `aria-activedescendant`, or `null` when there is no active row. */
  readonly activeDomId: string | null;
}

/**
 * The `id` attribute for a result row.
 *
 * A listbox announces its selection through `aria-activedescendant`, which is
 * an **id reference** — so the rows need ids, and they need to be derived
 * from the index rather than from the node id: a graph id contains `:` and
 * `/` (`module:src/web/client`), which are legal in an HTML `id` but not in
 * the CSS selector a screen reader's implementation may build from it.
 */
export function rowDomId(index: number): string {
  return `weave-search-row-${index}`;
}

/**
 * Resolve the whole palette from its state and the graph the client holds.
 *
 * The one function `SearchPalette.tsx` calls, and the reason that component
 * has no branch in it: ranking, merging, clamping, the empty-state choice and
 * the ARIA id all happen here, where a test can reach them.
 *
 * Note the two queries handed to {@link mergeResults}: `state.answered` for
 * the server hits (the query they actually answer) and `state.query` for the
 * graph nodes (which are local and rank against what is on screen right now).
 * That is what makes the repository half of the palette feel instant while
 * the vault half is debounced, and it is why a mid-flight palette shows
 * matching modules immediately with the notes arriving a moment later rather
 * than showing nothing at all.
 */
export function paletteModel(state: SearchState, payload: GraphPayload | null): PaletteModel {
  const results = mergeResults(state.hits, state.answered, payload?.model.nodes ?? [], state.query);
  const cursor = clampCursor(state.cursor, results.length);
  const rows = results.map((result, index) => ({ ...result, active: index === cursor, domId: rowDomId(index) }));
  return {
    rows,
    status: searchStatus(state, results.length),
    count: results.length,
    countLabel: resultCountLabel(results.length),
    cursor,
    activeDomId: results.length === 0 ? null : rowDomId(cursor),
  };
}
