/**
 * WorkspaceCache — an mtime-keyed cache over `buildCurrentGraph`
 * (weave-workspace §4.1).
 *
 * The browser workspace pushes a graph over SSE on every file event, so the
 * uncached path — N note reads plus ~5 git spawns per graph — becomes the
 * bottleneck immediately. This layer keeps the parsed notes and the
 * staleness report between builds and re-reads only what actually changed:
 *
 *  - notes: one `stat` per file per build; a note is re-read only when its
 *    `mtimeMs` or `size` moved. A no-change rebuild costs N stats, zero
 *    reads, and zero git spawns — the headline target of §4.1.
 *  - repository side (index + staleness + summaries): held behind a short
 *    TTL because assessing staleness spawns git and sha1s every dirty file.
 *
 * Correctness contract: for the same on-disk inputs, `graph()` returns a
 * model deep-equal to `buildCurrentGraph(cwd, vaultRoot)`. The cache is an
 * optimisation, never a different answer — `tests/core/cache/workspace.test`
 * asserts that equivalence directly.
 *
 * Stale-read hazard: mtime has coarse resolution on some filesystems, so a
 * write landing in the same millisecond as the previous one with an
 * identical size would be missed. The watcher closes that gap by calling
 * `invalidate(path)`, which drops the entry unconditionally; mtime+size is
 * the fallback for changes that arrive without an event (or before the
 * watcher starts).
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitSpawnCount } from "../git";
import { NOTES_DIR } from "../paths";
import { buildGraph, DEFAULT_MAX_NOTES, type BuildGraphInput } from "../graph/build";
import type { GraphModel } from "../graph/model";
import { readRepositorySide } from "../graph/current";
import { withMutationQueue } from "../mutex";
import { getNote, statNotes } from "../vault";
import type { Note } from "../types";

/**
 * One build's outputs: the graph, and the notes it was built from.
 *
 * The two travel together because a caller deriving anything per-note — the
 * tag index (§4.3) is the motivating case — must use *the same* list the
 * graph used, including the `DEFAULT_MAX_NOTES` truncation. Reading the notes
 * from a second call would let the cap fall between them and produce a tag
 * pointing at a slug the graph has no node for.
 */
export interface WorkspaceSnapshot {
  model: GraphModel;
  /**
   * Exactly the notes `buildGraph` saw: newest-updated first and already
   * truncated to the cap. Frozen — this is the cache's own array and a
   * caller mutating it would corrupt the next build.
   */
  notes: readonly Note[];
}

/** Cumulative counters, from construction. Callers take deltas. */
export interface CacheStats {
  /** Note files actually read and parsed. */
  notesRead: number;
  /** Note reads avoided because mtime+size were unchanged. */
  notesCached: number;
  /** git subprocesses spawned by builds this cache performed. */
  gitCalls: number;
  /** ISO timestamp of the last completed build; empty before the first. */
  builtAt: string;
}

/** What a cached note costs to validate: its change stamp plus the parse. */
interface CachedNote {
  mtimeMs: number;
  size: number;
  note: Note;
}

/** The repository half, held behind a TTL because assessing it spawns git. */
interface CachedRepo {
  /** Wall-clock ms (from the injected clock) when this was captured. */
  at: number;
  value: Pick<BuildGraphInput, "repository" | "summaries"> | null;
}

/**
 * How long a staleness assessment is trusted. Short enough that a `git
 * commit` in another terminal shows up promptly, long enough that a burst of
 * SSE-triggered rebuilds costs one assessment rather than one each.
 */
export const DEFAULT_STALENESS_TTL_MS = 2_000;

export interface WorkspaceCacheOptions {
  cwd: string;
  vaultRoot: string;
  /** Injected clock (project convention: never read the wall clock directly). */
  now?: () => Date;
  /** Staleness TTL in ms. 0 disables caching of the repository side. */
  stalenessTtlMs?: number;
}

/** Which half of the workspace a changed path belongs to. */
export type InvalidationScope = "vault" | "repo" | "none";

/**
 * Classify an absolute path into the cache scope it invalidates.
 *
 * Exported because the watcher wants the same classification to decide
 * whether an event is worth forwarding at all, and one implementation means
 * the two can never disagree.
 *
 *  - `vault`: a `*.md` under `<vaultRoot>/notes/`. Only note files count —
 *    the vault manifest does not participate in the graph.
 *  - `repo`:  anything under `<cwd>/.okf/` (the derived index and its summary
 *    sidecars) or under `<cwd>/.git/` (HEAD moves, staged changes), plus any
 *    tracked file in the repo, since editing one makes the index stale.
 *  - `none`:  outside both trees.
 *
 * A vault that lives *inside* the repo is deliberately resolved vault-first:
 * a note write should not force a git re-assessment.
 */
export function classifyPath(
  absPath: string,
  opts: { cwd: string; vaultRoot: string },
): InvalidationScope {
  return classify(absPath, opts).scope;
}

/**
 * The classification plus, for a vault note, the slug it identifies —
 * `invalidate` needs both and deriving them separately would mean resolving
 * the same path twice and re-deriving a guard the classification already
 * proved.
 */
function classify(
  absPath: string,
  opts: { cwd: string; vaultRoot: string },
): { scope: InvalidationScope; slug: string | null } {
  const path = resolve(absPath);
  const rel = relative(resolve(opts.vaultRoot, NOTES_DIR), path);
  // Directly inside the notes dir (flat vault: no separator in the relative
  // path) and Markdown — anything else in there is not a note.
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep)) {
    if (rel.endsWith(".md")) return { scope: "vault", slug: rel.slice(0, -".md".length) };
    return { scope: "none", slug: null };
  }
  return { scope: within(path, resolve(opts.cwd)) ? "repo" : "none", slug: null };
}

/** True when `path` is `root` itself or sits underneath it. */
function within(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * A cached view of one workspace.
 *
 * A class rather than the plain async functions used elsewhere in core: this
 * is the first thing in the tree with a lifetime and mutable identity. The
 * watcher holds a reference and calls `invalidate` between reads, so the
 * state *is* the object — a factory returning closures would be the same
 * design wearing a different hat, with worse stack traces. Every method
 * stays a plain async function over injected inputs, so it is as testable as
 * the rest of core.
 *
 * Not safe to share across different `cwd`/`vaultRoot` pairs — construct one
 * per workspace.
 */
export class WorkspaceCache {
  private readonly cwd: string;
  private readonly vaultRoot: string;
  private readonly now: () => Date;
  private readonly stalenessTtlMs: number;

  private notes = new Map<string, CachedNote>();
  /**
   * `.md` files present at the last refresh, including ones too malformed to
   * parse — mirrors `readVault().fileCount` so the vault node's note count
   * matches the uncached build exactly.
   */
  private fileCount = 0;
  private repo: CachedRepo | null = null;
  /**
   * The last snapshot handed out, reused verbatim when a build proves nothing
   * moved.
   *
   * `buildGraph` is pure and byte-deterministic, so rebuilding unchanged
   * inputs allocates a fresh object that is deep-equal to this one and
   * nothing else. Returning the *identical* object instead buys two things:
   * the graph construction itself is skipped on the warm path (it was the
   * only remaining per-request cost once note reads and git spawns were
   * eliminated), and downstream consumers gain a stable identity they can
   * memoize against — `src/web/server/routes` keys its serialized-payload
   * and ETag cache off exactly this reference.
   *
   * Reuse is deliberately conservative: see {@link build} for the four
   * conditions, all of which must hold.
   */
  private lastSnapshot: WorkspaceSnapshot | null = null;
  /** The single in-flight build, so concurrent callers coalesce. */
  private inFlight: Promise<WorkspaceSnapshot> | null = null;
  /**
   * The `.model` projection of {@link inFlight}, memoized.
   *
   * Derived once rather than per call so `graph()` keeps its documented
   * contract of handing *the identical promise* to concurrent callers. A
   * bare `async graph()` would allocate a fresh promise each time — the same
   * build, but no longer the same object, which is a coalescing guarantee
   * the tests pin directly.
   */
  private inFlightGraph: Promise<GraphModel> | null = null;
  /**
   * Slugs invalidated while a build was in flight.
   *
   * A build ends by replacing the note map wholesale, which would otherwise
   * resurrect an entry the watcher dropped mid-flight and leave the cache
   * serving a stale note indefinitely. Collecting them here and applying the
   * eviction after the swap means the change is picked up by the *next*
   * build instead of being lost. Same reasoning for `repoDirtiedDuringBuild`.
   */
  private evictedDuringBuild = new Set<string>();
  private allEvictedDuringBuild = false;
  private repoDirtiedDuringBuild = false;
  private building = false;
  /**
   * Whether the last {@link refreshNotes} observed any note-side movement:
   * a file read, a note that disappeared, or a change in the raw `.md` count.
   * Read by {@link build} to decide whether {@link lastSnapshot} is reusable.
   */
  private notesChanged = true;

  private notesRead = 0;
  private notesCached = 0;
  private gitCalls = 0;
  private builtAt = "";

  constructor(opts: WorkspaceCacheOptions) {
    this.cwd = opts.cwd;
    this.vaultRoot = opts.vaultRoot;
    this.now = opts.now ?? (() => new Date());
    this.stalenessTtlMs = opts.stalenessTtlMs ?? DEFAULT_STALENESS_TTL_MS;
  }

  /**
   * The current graph, rebuilt from whatever changed since the last call.
   *
   * Concurrent callers share one build: a second `graph()` arriving while a
   * build is in flight receives the same promise rather than starting a
   * second pass over the disk.
   */
  graph(): Promise<GraphModel> {
    if (this.inFlightGraph !== null) return this.inFlightGraph;
    const projected = this.snapshot().then((s) => s.model);
    // `snapshot()` may have completed synchronously-enough to have already
    // cleared the slots; only claim the slot if a build is still in flight,
    // so a later caller starts a fresh build rather than reusing this one.
    if (this.inFlight !== null) this.inFlightGraph = projected;
    return projected;
  }

  /**
   * The graph **and** the notes it was built from, from a single build.
   *
   * `graph()` is this with the notes dropped. Callers that derive anything
   * per-note (the tag index, §4.3) must use this instead of pairing `graph()`
   * with a separate vault read, or the two can disagree about which notes
   * exist — see {@link WorkspaceSnapshot}.
   */
  snapshot(): Promise<WorkspaceSnapshot> {
    if (this.inFlight !== null) return this.inFlight;
    // Serialized against note writes on the same vault (src/core/mutex), so
    // a build cannot read a note file mid-rewrite and cache a torn parse.
    const build = withMutationQueue(join(this.vaultRoot, NOTES_DIR), () => this.build());
    this.inFlight = build;
    // Clear the slots however the build ends, so a failure does not wedge the
    // cache into permanently replaying a rejected promise. Both slots are
    // released together: `inFlightGraph` is only ever a projection of this
    // build, so outliving it would hand the next caller a stale model.
    const clear = (): void => {
      if (this.inFlight === build) {
        this.inFlight = null;
        this.inFlightGraph = null;
      }
    };
    build.then(clear, clear);
    return build;
  }

  /**
   * Drop the cache entries a changed path affects. Cheap and synchronous:
   * the watcher calls this per event, and the next `graph()` pays for it.
   */
  invalidate(absPath: string): void {
    const { scope, slug } = classify(absPath, { cwd: this.cwd, vaultRoot: this.vaultRoot });
    if (scope === "vault" && slug !== null) {
      this.notes.delete(slug);
      if (this.building) this.evictedDuringBuild.add(slug);
    } else if (scope === "repo") {
      this.repo = null;
      if (this.building) this.repoDirtiedDuringBuild = true;
    }
  }

  /** Drop everything: a repo scan landed, or the vault root moved. */
  invalidateAll(): void {
    this.notes.clear();
    this.repo = null;
    if (this.building) {
      // Whatever the in-flight build writes back was read before this call,
      // so none of it may count as fresh.
      this.allEvictedDuringBuild = true;
      this.repoDirtiedDuringBuild = true;
    }
  }

  stats(): CacheStats {
    return {
      notesRead: this.notesRead,
      notesCached: this.notesCached,
      gitCalls: this.gitCalls,
      builtAt: this.builtAt,
    };
  }

  /** One full pass: refresh what changed, then run the pure builder. */
  private async build(): Promise<WorkspaceSnapshot> {
    const spawnsBefore = gitSpawnCount();
    this.building = true;
    this.evictedDuringBuild.clear();
    this.allEvictedDuringBuild = false;
    this.repoDirtiedDuringBuild = false;
    try {
      const notes = await this.refreshNotes();
      const repoFresh = this.repoNeedsRefresh();
      const repo = await this.refreshRepo();

      // Nothing moved on either side, so the builder would reproduce the
      // previous model byte for byte (`buildGraph` is pure and
      // byte-deterministic for identical inputs). Hand back the *identical*
      // object rather than an equal one — see {@link lastSnapshot}.
      //
      // All four conditions are required, and each one is a way the inputs
      // can differ while the others look quiet:
      //
      //  - a previous snapshot exists at all;
      //  - `refreshNotes` read nothing and lost nothing (`notesChanged`);
      //  - the repository side came from the TTL cache rather than a fresh
      //    assessment — a re-assessment can move `staleness` or the git node
      //    with no note touched;
      //  - no invalidation landed *while* this build was reading, which the
      //    deferred-eviction machinery would otherwise apply only after the
      //    swap, leaving this snapshot describing inputs already known stale.
      const quiet =
        this.lastSnapshot !== null &&
        !this.notesChanged &&
        !repoFresh &&
        !this.allEvictedDuringBuild &&
        !this.repoDirtiedDuringBuild &&
        this.evictedDuringBuild.size === 0;
      if (quiet && this.lastSnapshot !== null) {
        this.gitCalls += gitSpawnCount() - spawnsBefore;
        this.builtAt = this.now().toISOString();
        return this.lastSnapshot;
      }

      // Truncated once, here, and then handed to *both* the builder and the
      // snapshot — so a caller deriving per-note data cannot see a note the
      // graph has no node for (§4.3).
      const kept = notes.slice(0, DEFAULT_MAX_NOTES);
      const input: BuildGraphInput = {
        vault: { root: this.vaultRoot, exists: true, noteCount: this.fileCount },
        notes: kept,
        repository: repo?.repository ?? null,
      };
      if (repo?.summaries !== undefined) input.summaries = repo.summaries;

      this.gitCalls += gitSpawnCount() - spawnsBefore;
      this.builtAt = this.now().toISOString();
      const snapshot: WorkspaceSnapshot = { model: buildGraph(input), notes: Object.freeze(kept) };
      this.lastSnapshot = snapshot;
      return snapshot;
    } finally {
      this.building = false;
      this.applyDeferredInvalidations();
    }
  }

  /**
   * Whether the next {@link refreshRepo} will actually re-assess.
   *
   * Sampled *before* the refresh, because the refresh overwrites the very
   * timestamp the question is about. A fresh assessment can move the git node
   * or the staleness report without any note changing, so it is one of the
   * conditions that forbids snapshot reuse.
   */
  private repoNeedsRefresh(): boolean {
    if (this.repo === null) return true;
    return this.now().getTime() - this.repo.at >= this.stalenessTtlMs;
  }

  /**
   * Re-apply invalidations that arrived while the build was reading, which
   * the wholesale map/TTL replacement at the end of a build would otherwise
   * have undone. Without this, a note written mid-build stays stale until
   * something else touches it.
   */
  private applyDeferredInvalidations(): void {
    if (this.allEvictedDuringBuild) this.notes.clear();
    else for (const slug of this.evictedDuringBuild) this.notes.delete(slug);
    if (this.repoDirtiedDuringBuild) this.repo = null;
    this.evictedDuringBuild.clear();
    this.allEvictedDuringBuild = false;
    this.repoDirtiedDuringBuild = false;
  }

  /**
   * Stat every note; re-read only the ones whose mtime or size moved. Notes
   * that disappeared are evicted, so the map never outgrows the vault.
   */
  private async refreshNotes(): Promise<Note[]> {
    const stats = await statNotes(this.vaultRoot);
    const previousCount = this.notes.size;
    const previousFileCount = this.fileCount;
    this.fileCount = stats.length;
    let read = 0;

    const next = new Map<string, CachedNote>();
    const out: Note[] = [];
    for (const st of stats) {
      const hit = this.notes.get(st.slug);
      if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        this.notesCached += 1;
        next.set(st.slug, hit);
        out.push(hit.note);
        continue;
      }
      this.notesRead += 1;
      read += 1;
      const note = await getNote(this.vaultRoot, st.slug);
      // Unreadable/malformed notes are skipped but still counted in
      // fileCount, exactly as `readVault` does.
      if (note === null) continue;
      next.set(st.slug, { mtimeMs: st.mtimeMs, size: st.size, note });
      out.push(note);
    }
    // A note vanished if the map shrank without a compensating read; the
    // file count moving covers a malformed file appearing or disappearing,
    // which changes the vault node's `notes` detail without ever parsing.
    this.notesChanged = read > 0 || next.size !== previousCount || this.fileCount !== previousFileCount;
    this.notes = next;
    // `statNotes` yields readdir (slug-ascending) order and sort is stable,
    // so ties break by slug — identical to `readVault`.
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** The repository half, re-assessed only when the TTL has expired. */
  private async refreshRepo(): Promise<Pick<BuildGraphInput, "repository" | "summaries"> | null> {
    const at = this.now().getTime();
    if (this.repo !== null && at - this.repo.at < this.stalenessTtlMs) {
      return this.repo.value;
    }
    const value = await readRepositorySide(this.cwd);
    this.repo = { at, value };
    return value;
  }
}
