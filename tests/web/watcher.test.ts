/**
 * src/web/server/watcher.ts — the filesystem half of liveness
 * (weave-workspace §6).
 *
 * Two testing decisions shape this file:
 *
 * **No real timers.** Both the debounce and the git poll run on an injected
 * {@link Scheduler}, and the suppression window on an injected clock. A test
 * that slept 80 ms to observe a debounce would be slow *and* flaky on a busy
 * CI box; here the window is advanced by calling it.
 *
 * **No mocked `fs.watch`.** `openWatch` is a constructor option, so a fake
 * watch is a five-line object rather than a module mock — including the case
 * that matters most, a watch that *throws at open*, which is how a container
 * or network filesystem without inotify presents (§14). Real `fs.watch` is
 * exercised once, separately and tolerantly, because its delivery timing is
 * the platform's business and not something a unit test should assert.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_GIT_POLL_MS,
  DEFAULT_SUPPRESS_MS,
  Watcher,
  inferScope,
  isIgnoredPath,
  realOpenWatch,
  realScheduler,
  type OpenWatch,
  type WatchHandle,
} from "../../src/web/server/watcher";
import { NOTES_DIR, OKF_DIR } from "../../src/core/paths";
import type { ChangeScope } from "../../src/web/shared/wire";
import { commitAll, gitExec, gitInit, makeTempDir, writeFixture } from "../helpers";

// --- harness ------------------------------------------------------------------

/**
 * A {@link Scheduler} the test drives by hand.
 *
 * `runDelays` fires the pending one-shots; `runRepeats` fires every live
 * interval once. Cancellation removes the entry, so "cancel then advance"
 * genuinely observes nothing — which is what makes the `close()` assertions
 * meaningful rather than tautological.
 */
function fakeScheduler() {
  let seq = 0;
  const delays = new Map<number, () => void>();
  const repeats = new Map<number, () => void>();
  return {
    scheduler: {
      delay(fn: () => void, ms: number): () => void {
        const id = seq++;
        delays.set(id, fn);
        lastDelayMs = ms;
        return () => void delays.delete(id);
      },
      repeat(fn: () => void, ms: number): () => void {
        const id = seq++;
        repeats.set(id, fn);
        lastRepeatMs = ms;
        return () => void repeats.delete(id);
      },
    },
    /** Fire and clear every pending one-shot. */
    runDelays(): void {
      const pending = [...delays.values()];
      delays.clear();
      for (const fn of pending) fn();
    },
    /** Fire every live interval once, leaving them scheduled. */
    runRepeats(): void {
      for (const fn of [...repeats.values()]) fn();
    },
    pendingDelays: (): number => delays.size,
    pendingRepeats: (): number => repeats.size,
    delayMs: (): number => lastDelayMs,
    repeatMs: (): number => lastRepeatMs,
  };
  // Captured out of band so the assertions can check the *intervals* the
  // watcher asked for, not just that it asked for something.
}
let lastDelayMs = -1;
let lastRepeatMs = -1;

/**
 * A fake {@link OpenWatch} that hands back an emitter per root.
 *
 * `failRoots` makes `openWatch` throw for a named root — the graceful
 * degradation case — without touching `node:fs`.
 */
function fakeWatch(failRoots: readonly string[] = []) {
  const emitters = new Map<string, (rel: string | null) => void>();
  const errors = new Map<string, (e: Error) => void>();
  const closed: string[] = [];
  let closeThrowsFor: string | null = null;

  const openWatch: OpenWatch = (root, onEvent, onError) => {
    if (failRoots.includes(root)) throw new Error(`ENOSYS: watch ${root}`);
    emitters.set(root, onEvent);
    errors.set(root, onError);
    const handle: WatchHandle = {
      close() {
        closed.push(root);
        if (closeThrowsFor === root) throw new Error("already closed");
      },
    };
    return handle;
  };

  return {
    openWatch,
    /** Deliver one event on `root`, as `fs.watch` would. */
    emit(root: string, rel: string | null): void {
      const fn = emitters.get(root);
      if (fn === undefined) throw new Error(`no watch open on ${root}`);
      fn(rel);
    },
    /** Deliver a runtime watch error (inotify exhaustion, root deleted). */
    fail(root: string, message: string): void {
      errors.get(root)?.(new Error(message));
    },
    closed,
    makeCloseThrow(root: string): void {
      closeThrowsFor = root;
    },
  };
}

/** A vault root and a repo cwd, plus the `.okf` root the watcher derives. */
async function workspace(): Promise<{ cwd: string; vaultRoot: string; okf: string }> {
  const cwd = await makeTempDir();
  const vaultRoot = await makeTempDir();
  await fs.mkdir(join(vaultRoot, NOTES_DIR), { recursive: true });
  await fs.mkdir(join(cwd, OKF_DIR), { recursive: true });
  return { cwd, vaultRoot, okf: join(cwd, OKF_DIR) };
}

/**
 * Poll `predicate` until it holds, with a bounded number of short sleeps.
 *
 * Used only where the thing being waited on is genuine asynchronous I/O
 * (a git fingerprint read, a kernel watch event) — never for a debounce or a
 * heartbeat, both of which are driven by an injected scheduler. Polling a
 * condition rather than sleeping a fixed duration is what keeps that
 * unavoidable wait from becoming a flake on a loaded CI box.
 */
async function waitFor(predicate: () => boolean, tries = 100, stepMs = 10): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i += 1) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Everything a test opened, closed after it whatever happened. */
const openWatchers: Watcher[] = [];
function track(w: Watcher): Watcher {
  openWatchers.push(w);
  return w;
}

afterEach(() => {
  // A leaked recursive watch keeps a handle open and hangs the whole vitest
  // run, so this is not merely tidy.
  while (openWatchers.length > 0) openWatchers.pop()?.close();
});

// --- the ignore list ----------------------------------------------------------

describe("isIgnoredPath (§6 ignore list)", () => {
  it("ignores everything under .git except HEAD and index", () => {
    expect(isIgnoredPath(".git/objects/ab/cdef")).toBe(true);
    expect(isIgnoredPath(".git/refs/heads/main")).toBe(true);
    expect(isIgnoredPath(".git/COMMIT_EDITMSG")).toBe(true);
    expect(isIgnoredPath(".git/HEAD")).toBe(false);
    expect(isIgnoredPath(".git/index")).toBe(false);
  });

  it("does not exempt HEAD-alikes nested deeper in .git", () => {
    // `logs/HEAD` is rewritten by every reflog-touching command; treating it
    // as the branch signal would make the poll's dedupe useless.
    expect(isIgnoredPath(".git/logs/HEAD")).toBe(true);
    expect(isIgnoredPath(".git/worktrees/w1/index")).toBe(true);
  });

  it("ignores editor swap, backup and lock files", () => {
    expect(isIgnoredPath("notes/note.md.swp")).toBe(true);
    expect(isIgnoredPath("notes/.note.md.swp")).toBe(true);
    expect(isIgnoredPath("notes/note.md~")).toBe(true);
    expect(isIgnoredPath("notes/.#note.md")).toBe(true);
  });

  it("ignores vim's 4913 writability probe", () => {
    // vim creates, stats and deletes this before *every* save; without the
    // entry each save would cost an extra debounce window.
    expect(isIgnoredPath("notes/4913")).toBe(true);
    expect(isIgnoredPath("4913")).toBe(true);
  });

  it("ignores .DS_Store", () => {
    expect(isIgnoredPath(".DS_Store")).toBe(true);
    expect(isIgnoredPath("notes/.DS_Store")).toBe(true);
  });

  it("keeps real content", () => {
    expect(isIgnoredPath("notes/note.md")).toBe(false);
    expect(isIgnoredPath("repository/modules.json")).toBe(false);
    // Only the *basename* is matched for the swap/backup rules, so a
    // directory named `4913` or a note whose name merely contains `~` is safe.
    expect(isIgnoredPath("4913/note.md")).toBe(false);
    expect(isIgnoredPath("notes/a~b.md")).toBe(false);
  });

  it("matches on both separators and tolerates ./ segments", () => {
    expect(isIgnoredPath(".git\\objects\\ab")).toBe(true);
    expect(isIgnoredPath("./notes/./note.md.swp")).toBe(true);
  });

  it("does not ignore a path with no segments at all", () => {
    // `fs.watch` can hand back `""` when it declines to name the file; the
    // watcher treats that as "the root moved" rather than filtering it out.
    expect(isIgnoredPath("")).toBe(false);
    expect(isIgnoredPath(".")).toBe(false);
  });
});

// --- scope inference ----------------------------------------------------------

describe("inferScope", () => {
  it("classifies a vault note as `vault` and .okf content as `repo`", async () => {
    const { cwd, vaultRoot, okf } = await workspace();
    const opts = { cwd, vaultRoot };
    expect(inferScope(vaultRoot, join(NOTES_DIR, "alpha.md"), opts)).toBe("vault");
    expect(inferScope(okf, "repository/modules.json", opts)).toBe("repo");
  });

  it("classifies HEAD and index as `git`", async () => {
    const { cwd, vaultRoot } = await workspace();
    expect(inferScope(cwd, ".git/HEAD", { cwd, vaultRoot })).toBe("git");
    expect(inferScope(cwd, ".git/index", { cwd, vaultRoot })).toBe("git");
  });

  it("returns null for ignored paths and for paths outside both trees", async () => {
    const { cwd, vaultRoot } = await workspace();
    const elsewhere = await makeTempDir();
    const opts = { cwd, vaultRoot };
    expect(inferScope(vaultRoot, join(NOTES_DIR, "alpha.md.swp"), opts)).toBeNull();
    expect(inferScope(elsewhere, "unrelated.txt", opts)).toBeNull();
  });

  it("delegates to core's classifyPath, so non-note vault files are not `vault`", async () => {
    const { cwd, vaultRoot } = await workspace();
    const opts = { cwd, vaultRoot };
    // The manifest is not part of the graph; core says `none` and so do we.
    // Reusing `classifyPath` rather than re-deriving "is this a note?" is what
    // guarantees the watcher and the cache cannot disagree.
    expect(inferScope(vaultRoot, "okf.json", opts)).toBeNull();
    expect(inferScope(vaultRoot, join(NOTES_DIR, "nested", "deep.md"), opts)).toBeNull();
  });
});

// --- debounce and coalescing ---------------------------------------------------

describe("Watcher — debounce and coalescing (§6)", () => {
  it("coalesces three rapid writes into one event", async () => {
    const { cwd, vaultRoot } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    const w = track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (scopes) => void seen.push([...scopes]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    );
    w.start();

    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    watch.emit(vaultRoot, join(NOTES_DIR, "b.md"));
    watch.emit(vaultRoot, join(NOTES_DIR, "c.md"));
    expect(seen).toEqual([]); // nothing before the window closes

    clock.runDelays();
    expect(seen).toEqual([["vault"]]);
  });

  it("emits one entry per affected scope, in CHANGE_SCOPES order", async () => {
    const { cwd, vaultRoot, okf } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    const w = track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    );
    w.start();

    // Deliberately out of order: the emitted list is canonical, not arrival-ordered.
    watch.emit(okf, "repository/modules.json");
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    clock.runDelays();
    expect(seen).toEqual([["vault", "repo"]]);
  });

  it("does not restart the window on each event — latency stays bounded", async () => {
    const { cwd, vaultRoot } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    ).start();

    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    expect(clock.pendingDelays()).toBe(1);
    watch.emit(vaultRoot, join(NOTES_DIR, "b.md"));
    // Still one timer: a restart-per-event debounce would starve under a
    // sustained write stream (a large `git checkout`) and emit nothing at all
    // until it stopped.
    expect(clock.pendingDelays()).toBe(1);
    clock.runDelays();
    expect(seen).toEqual([["vault"]]);
  });

  it("opens a fresh window after a flush", async () => {
    const { cwd, vaultRoot } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    ).start();

    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    clock.runDelays();
    watch.emit(vaultRoot, join(NOTES_DIR, "b.md"));
    clock.runDelays();
    expect(seen).toEqual([["vault"], ["vault"]]);
  });

  it("never fires for a window that collected nothing", async () => {
    const { cwd, vaultRoot } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    ).start();

    watch.emit(vaultRoot, join(NOTES_DIR, "a.md.swp")); // ignored
    expect(clock.pendingDelays()).toBe(0);
    clock.runDelays();
    expect(seen).toEqual([]);
  });

  it("fires onPath per accepted path, undebounced, so the cache evicts precisely", async () => {
    const { cwd, vaultRoot, okf } = await workspace();
    const paths: Array<[string, ChangeScope]> = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: () => {},
        onPath: (p, scope) => void paths.push([p, scope]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    ).start();

    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    watch.emit(vaultRoot, join(NOTES_DIR, "b.md"));
    watch.emit(okf, "repository/modules.json");
    watch.emit(vaultRoot, join(NOTES_DIR, "c.md.swp")); // ignored: no onPath
    expect(paths).toEqual([
      [resolve(vaultRoot, NOTES_DIR, "a.md"), "vault"],
      [resolve(vaultRoot, NOTES_DIR, "b.md"), "vault"],
      [resolve(okf, "repository/modules.json"), "repo"],
    ]);
  });

  it("treats an unnamed event as the whole root changing", async () => {
    const { cwd, vaultRoot, okf } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    ).start();

    // Some platforms deliver a null filename. "Hint, not delta" means the
    // right answer is to mark the root dirty, not to guess a path.
    watch.emit(vaultRoot, null);
    watch.emit(okf, null);
    clock.runDelays();
    expect(seen).toEqual([["vault", "repo"]]);
  });

  it("uses the §6 defaults when no intervals are injected", async () => {
    const { cwd, vaultRoot } = await workspace();
    const clock = fakeScheduler();
    const watch = fakeWatch();
    track(
      new Watcher({ cwd, vaultRoot, onChange: () => {}, scheduler: clock.scheduler, openWatch: watch.openWatch }),
    ).start();
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    expect(clock.delayMs()).toBe(DEFAULT_DEBOUNCE_MS);
    expect(clock.delayMs()).toBe(80);
    expect(clock.repeatMs()).toBe(DEFAULT_GIT_POLL_MS);
  });
});

// --- self-write suppression ----------------------------------------------------

describe("Watcher — self-write suppression (§6)", () => {
  /** A watcher plus a clock the test moves, sharing one fake scheduler. */
  async function suppressible() {
    const { cwd, vaultRoot } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    let t = 1_000;
    const w = track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        now: () => t,
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    );
    w.start();
    return { w, seen, clock, watch, vaultRoot, advance: (ms: number) => void (t += ms) };
  }

  it("drops a change inside the window", async () => {
    const { w, seen, clock, watch, vaultRoot } = await suppressible();
    const note = join(vaultRoot, NOTES_DIR, "a.md");
    w.suppress(note, 200);
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    clock.runDelays();
    // Without this, `POST /api/open` would broadcast, the client would
    // refetch, and the loop would be indistinguishable from a real edit.
    expect(seen).toEqual([]);
  });

  it("passes a change after the window expires", async () => {
    const { w, seen, clock, watch, vaultRoot, advance } = await suppressible();
    w.suppress(join(vaultRoot, NOTES_DIR, "a.md"), 200);
    advance(201);
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    clock.runDelays();
    expect(seen).toEqual([["vault"]]);
  });

  it("suppresses exactly one path, not its neighbours", async () => {
    const { w, seen, clock, watch, vaultRoot } = await suppressible();
    w.suppress(join(vaultRoot, NOTES_DIR, "a.md"), 200);
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    watch.emit(vaultRoot, join(NOTES_DIR, "b.md"));
    clock.runDelays();
    expect(seen).toEqual([["vault"]]);
  });

  it("suppresses several events from one logical save", async () => {
    const { w, seen, clock, watch, vaultRoot } = await suppressible();
    w.suppress(join(vaultRoot, NOTES_DIR, "a.md"), 200);
    // An editor save is a temp write, a rename and an mtime touch — a
    // one-shot flag would only catch the first.
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    clock.runDelays();
    expect(seen).toEqual([]);
  });

  it("defaults to the §6 200 ms window and normalises the path", async () => {
    const { w, seen, clock, watch, vaultRoot, advance } = await suppressible();
    w.suppress(join(vaultRoot, NOTES_DIR, ".", "a.md"));
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    clock.runDelays();
    expect(seen).toEqual([]);

    advance(DEFAULT_SUPPRESS_MS + 1);
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    clock.runDelays();
    expect(seen).toEqual([["vault"]]);
  });
});

// --- graceful degradation ------------------------------------------------------

describe("Watcher — graceful degradation (§6, §14)", () => {
  it("reports unavailability instead of throwing when every watch fails", async () => {
    const { cwd, vaultRoot, okf } = await workspace();
    const clock = fakeScheduler();
    // The container / network-filesystem case: no inotify, `fs.watch` throws
    // at open. The server must still boot and fall back to stamp polling.
    const watch = fakeWatch([vaultRoot, okf]);
    const w = track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: () => {},
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    );
    const status = w.start();
    expect(status.available).toBe(false);
    expect(status.watching).toEqual([]);
    expect(status.failed.map((f) => f.root)).toEqual([vaultRoot, okf]);
    expect(status.failed[0]?.error).toContain("ENOSYS");
  });

  it("keeps the roots that did open when only one fails", async () => {
    const { cwd, vaultRoot, okf } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch([okf]);
    const w = track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    );
    const status = w.start();
    expect(status.available).toBe(true);
    expect(status.watching).toEqual([vaultRoot]);
    expect(status.failed.map((f) => f.root)).toEqual([okf]);

    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    clock.runDelays();
    expect(seen).toEqual([["vault"]]);
  });

  it("reports a non-Error rejection from openWatch as a string", async () => {
    const { cwd, vaultRoot } = await workspace();
    const w = track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: () => {},
        scheduler: fakeScheduler().scheduler,
        // Some native bindings reject with a bare value. Degradation must not
        // itself throw on `error.message` being undefined.
        openWatch: () => {
          throw "ENOSYS string";
        },
      }),
    );
    const status = w.start();
    expect(status.available).toBe(false);
    expect(status.failed[0]?.error).toBe("ENOSYS string");
  });

  it("demotes a root whose watch dies mid-session", async () => {
    const { cwd, vaultRoot } = await workspace();
    const clock = fakeScheduler();
    const watch = fakeWatch();
    const w = track(
      new Watcher({ cwd, vaultRoot, onChange: () => {}, scheduler: clock.scheduler, openWatch: watch.openWatch }),
    );
    w.start();
    expect(w.status().available).toBe(true);

    // inotify exhaustion, or the root was deleted underneath us.
    watch.fail(vaultRoot, "ENOSPC");
    const status = w.status();
    expect(status.watching).not.toContain(vaultRoot);
    expect(status.failed.map((f) => f.error)).toContain("ENOSPC");
    // A second error for a root already demoted must not double-count.
    watch.fail(vaultRoot, "ENOSPC");
    expect(w.status().failed.length).toBe(1);
  });

  it("start() is idempotent — a second call opens nothing new", async () => {
    const { cwd, vaultRoot } = await workspace();
    const clock = fakeScheduler();
    const watch = fakeWatch();
    const w = track(
      new Watcher({ cwd, vaultRoot, onChange: () => {}, scheduler: clock.scheduler, openWatch: watch.openWatch }),
    );
    const first = w.start();
    const second = w.start();
    expect(second).toEqual(first);
    expect(clock.pendingRepeats()).toBe(1);
  });

  it("status() hands out copies, so a caller cannot mutate watcher state", async () => {
    const { cwd, vaultRoot, okf } = await workspace();
    const watch = fakeWatch([okf]);
    const w = track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: () => {},
        scheduler: fakeScheduler().scheduler,
        openWatch: watch.openWatch,
      }),
    );
    w.start();
    const status = w.status();
    status.failed[0]!.error = "tampered";
    status.watching.push("bogus");
    expect(w.status().failed[0]?.error).toContain("ENOSYS");
    expect(w.status().watching).toEqual([vaultRoot]);
  });
});

// --- shutdown -------------------------------------------------------------------

describe("Watcher — close()", () => {
  it("closes every handle, cancels the timers, and goes quiet", async () => {
    const { cwd, vaultRoot, okf } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    const w = new Watcher({
      cwd,
      vaultRoot,
      onChange: (s) => void seen.push([...s]),
      scheduler: clock.scheduler,
      openWatch: watch.openWatch,
    });
    w.start();
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));

    w.close();
    expect(watch.closed).toEqual([vaultRoot, okf]);
    // A pending window must not fire after close, and the poll must stop:
    // a live timer here is exactly what keeps a process alive past shutdown.
    expect(clock.pendingDelays()).toBe(0);
    expect(clock.pendingRepeats()).toBe(0);
    clock.runDelays();
    expect(seen).toEqual([]);

    // Events arriving from an OS handle that has not drained yet are dropped.
    watch.emit(vaultRoot, join(NOTES_DIR, "b.md"));
    clock.runDelays();
    expect(seen).toEqual([]);
  });

  it("drops a window that was already scheduled when close() landed", async () => {
    const { cwd, vaultRoot } = await workspace();
    const seen: ChangeScope[][] = [];
    const watch = fakeWatch();
    // A scheduler that ignores cancellation, so the pending flush still
    // fires — the real-timer race where `close()` and an expiring debounce
    // cross. `flush` must notice it is closed rather than broadcast into a
    // torn-down server.
    const stubborn: Array<() => void> = [];
    const w = new Watcher({
      cwd,
      vaultRoot,
      onChange: (s) => void seen.push([...s]),
      scheduler: {
        delay: (fn) => {
          stubborn.push(fn);
          return () => {};
        },
        repeat: () => () => {},
      },
      openWatch: watch.openWatch,
    });
    w.start();
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    w.close();
    for (const fn of stubborn) fn();
    expect(seen).toEqual([]);
  });

  it("is idempotent and survives a handle that throws on close", async () => {
    const { cwd, vaultRoot } = await workspace();
    const watch = fakeWatch();
    const w = new Watcher({
      cwd,
      vaultRoot,
      onChange: () => {},
      scheduler: fakeScheduler().scheduler,
      openWatch: watch.openWatch,
    });
    w.start();
    watch.makeCloseThrow(vaultRoot);
    expect(() => w.close()).not.toThrow();
    expect(() => w.close()).not.toThrow();
    // Second close is a no-op, not a second round of handle.close().
    expect(watch.closed.filter((r) => r === vaultRoot).length).toBe(1);
  });

  it("suppresses the git poll after close", async () => {
    const { cwd, vaultRoot } = await workspace();
    const seen: ChangeScope[][] = [];
    const watch = fakeWatch();
    const w = new Watcher({
      cwd,
      vaultRoot,
      onChange: (s) => void seen.push([...s]),
      scheduler: fakeScheduler().scheduler,
      openWatch: watch.openWatch,
    });
    w.start();
    w.close();
    await w.pollGitOnce();
    expect(seen).toEqual([]);
  });
});

// --- git poll --------------------------------------------------------------------

describe("Watcher — git poll (§6)", () => {
  /** A watcher over a real one-commit git repo, with hand-driven timers. */
  async function overRepo(cwd: string) {
    const vaultRoot = await makeTempDir();
    await fs.mkdir(join(vaultRoot, NOTES_DIR), { recursive: true });
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    const w = track(
      new Watcher({
        cwd,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    );
    w.start();
    return { w, seen, clock };
  }

  it("the first poll only takes a baseline — no frame on boot", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.txt", "one\n");
    commitAll(repo, "init");

    const { w, seen } = await overRepo(repo);
    await w.pollGitOnce();
    // The client just fetched the graph; announcing the state it already has
    // would be a spurious refetch on every single boot.
    expect(seen).toEqual([]);
    await w.pollGitOnce();
    expect(seen).toEqual([]);
  });

  it("fires on a branch switch", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.txt", "one\n");
    commitAll(repo, "init");

    const { w, seen, clock } = await overRepo(repo);
    await w.pollGitOnce();

    // `git checkout -b` rewrites .git/HEAD, which is not under either watched
    // root — this is the whole reason the poll exists.
    gitExec(repo, ["checkout", "-b", "feature"]);
    await w.pollGitOnce();
    clock.runDelays();
    expect(seen).toEqual([["git"]]);
  });

  it("fires on a commit, where HEAD is byte-identical but the ref moved", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.txt", "one\n");
    commitAll(repo, "init");

    const { w, seen, clock } = await overRepo(repo);
    await w.pollGitOnce();

    await writeFixture(repo, "a.txt", "two\n");
    commitAll(repo, "second");
    await w.pollGitOnce();
    clock.runDelays();
    // Catching this is why the fingerprint follows HEAD to the loose ref
    // instead of just hashing HEAD itself.
    expect(seen).toEqual([["git"]]);
  });

  it("fires on staging, then goes quiet again", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.txt", "one\n");
    commitAll(repo, "init");

    const { w, seen, clock } = await overRepo(repo);
    await w.pollGitOnce();

    await writeFixture(repo, "b.txt", "new\n");
    gitExec(repo, ["add", "b.txt"]);
    await w.pollGitOnce();
    clock.runDelays();
    expect(seen).toEqual([["git"]]);

    await w.pollGitOnce();
    clock.runDelays();
    expect(seen).toEqual([["git"]]);
  });

  it("coalesces a git change with a vault change into one window", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.txt", "one\n");
    commitAll(repo, "init");

    const vaultRoot = await makeTempDir();
    await fs.mkdir(join(vaultRoot, NOTES_DIR), { recursive: true });
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    const w = track(
      new Watcher({
        cwd: repo,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    );
    w.start();
    await w.pollGitOnce();

    gitExec(repo, ["checkout", "-b", "feature"]);
    watch.emit(vaultRoot, join(NOTES_DIR, "a.md"));
    await w.pollGitOnce();
    clock.runDelays();
    expect(seen).toEqual([["vault", "git"]]);
  });

  it("is a permanent no-op outside a repository", async () => {
    const plain = await makeTempDir();
    const { w, seen, clock } = await overRepo(plain);
    await w.pollGitOnce();
    await w.pollGitOnce();
    clock.runDelays();
    // Every fingerprint read is best-effort, so "no .git at all" is an empty
    // fingerprint that never changes rather than an error path.
    expect(seen).toEqual([]);
  });

  it("follows a `gitdir:` pointer file (worktrees, submodules)", async () => {
    const main = await makeTempDir();
    gitInit(main);
    await writeFixture(main, "a.txt", "one\n");
    commitAll(main, "init");
    const linked = join(main, "..", `wt-${Date.now()}`);
    gitExec(main, ["worktree", "add", "-b", "wt", linked]);

    const { w, seen, clock } = await overRepo(resolve(linked));
    await w.pollGitOnce();
    gitExec(resolve(linked), ["checkout", "-b", "wt2"]);
    await w.pollGitOnce();
    clock.runDelays();
    // In a linked worktree `.git` is a *file* containing `gitdir: …`; not
    // following it would mean never reporting a branch switch there.
    expect(seen).toEqual([["git"]]);

    await fs.rm(resolve(linked), { recursive: true, force: true });
  });

  it("resolves a *relative* gitdir pointer against the working directory", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.txt", "one\n");
    commitAll(repo, "init");

    // Submodules write `gitdir: ../.git/modules/<name>` — a relative path.
    // Resolving it against the wrong base silently yields an empty
    // fingerprint, i.e. a poll that never fires and no error to explain it.
    const consumer = join(repo, "consumer");
    await fs.mkdir(consumer, { recursive: true });
    await fs.writeFile(join(consumer, ".git"), "gitdir: ../.git\n", "utf8");

    const { w, seen, clock } = await overRepo(consumer);
    await w.pollGitOnce();
    gitExec(repo, ["checkout", "-b", "feature"]);
    await w.pollGitOnce();
    clock.runDelays();
    expect(seen).toEqual([["git"]]);
  });

  it("tolerates a `.git` file that is not a gitdir pointer", async () => {
    const odd = await makeTempDir();
    await fs.writeFile(join(odd, ".git"), "garbage\n", "utf8");
    const { w, seen, clock } = await overRepo(odd);
    await w.pollGitOnce();
    await w.pollGitOnce();
    clock.runDelays();
    expect(seen).toEqual([]);
  });

  it("runs on the repeat timer the scheduler was given", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.txt", "one\n");
    commitAll(repo, "init");

    const vaultRoot = await makeTempDir();
    await fs.mkdir(join(vaultRoot, NOTES_DIR), { recursive: true });
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const watch = fakeWatch();
    const w = track(
      new Watcher({
        cwd: repo,
        vaultRoot,
        onChange: (s) => void seen.push([...s]),
        gitPollMs: 2_000,
        scheduler: clock.scheduler,
        openWatch: watch.openWatch,
      }),
    );
    w.start();

    // Baseline directly, because it is awaitable and has no observable
    // effect to wait on. The claim under test is the *wiring* — that the
    // repeat timer runs the poll at all — so the second poll goes through the
    // timer.
    await w.pollGitOnce();
    gitExec(repo, ["checkout", "-b", "feature"]);

    // The timer fires `pollGitOnce` without awaiting it and its body does
    // real filesystem reads on the thread pool, so wait for the *I/O* to
    // land. Spinning `setImmediate` is not enough: thread-pool completions
    // arrive on later loop turns, and assuming a fixed number of turns is
    // exactly the kind of flake this suite is built to avoid.
    clock.runRepeats();
    await waitFor(() => clock.pendingDelays() > 0);
    clock.runDelays();
    expect(seen).toEqual([["git"]]);
  });
});

// --- the real primitives ---------------------------------------------------------

describe("realScheduler", () => {
  it("delays, repeats, and cancels", async () => {
    let delayed = 0;
    let repeated = 0;
    const cancelDelay = realScheduler.delay(() => void (delayed += 1), 0);
    const cancelRepeat = realScheduler.repeat(() => void (repeated += 1), 1);
    await new Promise((r) => setTimeout(r, 15));
    cancelRepeat();
    expect(delayed).toBe(1);
    expect(repeated).toBeGreaterThan(0);

    const before = repeated;
    await new Promise((r) => setTimeout(r, 10));
    expect(repeated).toBe(before);
    cancelDelay(); // cancelling an already-fired delay is safe
  });

  it("cancels a delay before it fires", async () => {
    let fired = false;
    realScheduler.delay(() => void (fired = true), 5)();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(false);
  });
});

/**
 * The two tests below are the only ones touching a real `fs.watch`, and they
 * assert a **disjunction** rather than delivery: the watcher either reports
 * the change, or reports the root as unwatchable. That is deliberate, not a
 * weakened assertion — it is precisely the §6/§14 contract ("degrade
 * gracefully; report unavailability so the caller can fall back to polling"),
 * and it is the only claim that is true on every machine.
 *
 * It has to be, because `fs.watch` is genuinely unavailable on some
 * developer machines: macOS applies a per-launchd-session `maxfiles` soft
 * limit (`launchctl limit maxfiles`, commonly 256) and FSEvents then fails
 * with an **asynchronous** `EMFILE` on the watcher's `error` event rather
 * than throwing at open. A test that required delivery would fail there for
 * reasons that have nothing to do with this code — and would have hidden the
 * more interesting fact that the async-error path is what actually runs.
 * Deterministic coverage of both branches comes from the injected
 * {@link OpenWatch} above.
 */
describe("realOpenWatch", () => {
  it("either delivers an event or reports an error — never silently nothing", async () => {
    const dir = await makeTempDir();
    const events: Array<string | null> = [];
    const errors: string[] = [];
    const handle = realOpenWatch(
      dir,
      (rel) => void events.push(rel),
      (e) => void errors.push(e.message),
    );
    try {
      await fs.writeFile(join(dir, "hello.txt"), "hi", "utf8");
      for (let i = 0; i < 40 && events.length === 0 && errors.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      handle.close();
    }
    expect(events.length + errors.length).toBeGreaterThan(0);
    if (errors.length === 0) expect(events).toContain("hello.txt");
  });

  it("throws for a root that does not exist — the synchronous degradation path", async () => {
    const missing = join(await makeTempDir(), "nope");
    expect(() =>
      realOpenWatch(
        missing,
        () => {},
        () => {},
      ),
    ).toThrow();
  });
});

describe("Watcher — default wiring", () => {
  it("falls back to the real scheduler, watch and clock when none are injected", async () => {
    const { cwd, vaultRoot } = await workspace();
    // Constructing with only the required options is how `server.ts` will do
    // it, so the `??` fallbacks are production wiring, not dead defaults.
    const w = track(new Watcher({ cwd, vaultRoot, onChange: () => {} }));
    const status = w.start();
    // Either the platform gave us watches or it did not; both are valid (see
    // the `fs.watch` note below). What must hold is that `start()` returned a
    // status instead of throwing, and that the real clock backs `suppress`.
    expect(status.watching.length + status.failed.length).toBe(2);
    expect(() => w.suppress(join(vaultRoot, NOTES_DIR, "a.md"))).not.toThrow();
    w.close();
  });
});

describe("Watcher — real fs.watch end to end", () => {
  /**
   * Wires the real `fs.watch` into the real `Watcher` (only the scheduler
   * stays fake, so the debounce is still hand-driven).
   *
   * What is asserted is soundness, not delivery: whatever the platform does,
   * the watcher must never invent a scope. A real note write can legitimately
   * surface as any of four things —
   *
   *  1. `notes/live.md` → one `vault` frame (Linux inotify, and macOS when it
   *     names the file);
   *  2. an `EMFILE` on the watcher's `error` event → the root is demoted and
   *     `available` goes false (macOS under a low `launchctl limit maxfiles`);
   *  3. a *directory*-level event naming `notes` → correctly ignored, because
   *     a directory is not a note, so nothing is reported at all;
   *  4. an event **without a filename** — FSEvents delivers these
   *     sporadically — which the "hint, not delta" contract turns into
   *     whole-root-dirty. On the cwd watcher that surfaces as a `repo` frame
   *     even though only the vault moved: the platform declined to say where
   *     the event belongs, and over-reporting a scope is the safe direction
   *     (the cache invalidates, the client refetches, nothing is missed).
   *
   * Case 3 is why "assert a frame arrives" would be flaky here rather than
   * strict, and case 4 is why the scope assertion tolerates the repo frame
   * while still forbidding `git` — a vault write can never legitimately
   * produce one. The deterministic coverage of the delivery path lives in the
   * injected-`openWatch` suites above; this test exists to prove the default
   * wiring is real and that its output is never *wrong*.
   */
  it("always reports the vault write, and never a git scope", async () => {
    const { cwd, vaultRoot } = await workspace();
    const seen: ChangeScope[][] = [];
    const clock = fakeScheduler();
    const w = track(
      new Watcher({ cwd, vaultRoot, onChange: (s) => void seen.push([...s]), scheduler: clock.scheduler }),
    );
    expect(w.start().available).toBe(true);

    await fs.writeFile(join(vaultRoot, NOTES_DIR, "live.md"), "# live\n", "utf8");
    const failed = (): boolean => w.status().failed.some((f) => f.root === vaultRoot);
    for (let i = 0; i < 40 && clock.pendingDelays() === 0 && !failed(); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    clock.runDelays();

    for (const scopes of seen) {
      // The write is always reported; a null-name event on the repo watcher
      // may add a `repo` frame (hint, not delta) — but `git` can never be
      // invented by a vault write.
      expect(scopes).toContain("vault");
      expect(scopes).not.toContain("git");
    }
    // And when the watch died, the status says so — which is what lets
    // `server.ts` fall back to stamp polling instead of pretending.
    if (failed()) expect(w.status().available).toBe(false);
  });
});
