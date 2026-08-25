/**
 * WorkspaceCache (weave-workspace §4.1).
 *
 * The headline claim under test is the last line of §4.1: "no-change rebuild
 * does **zero** note reads and **zero** git spawns". `gitCalls` is sampled
 * from the real spawn counter in `src/core/git`, so that assertion is about
 * observed subprocesses, not a model of them.
 *
 * The other load-bearing test is `equivalence`: the cache must never be a
 * different answer from `buildCurrentGraph`, only a faster one.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceCache, classifyPath, DEFAULT_STALENESS_TTL_MS } from "../../../src/core/cache/workspace";
import { buildCurrentGraph } from "../../../src/core/graph/current";
import { buildRepoIndex, writeRepoIndex } from "../../../src/core/repoIndex";
import { addNote, resolveNotePath } from "../../../src/core/vault";
import { NOTES_DIR } from "../../../src/core/paths";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../../helpers";

/** A vault with `titles.length` notes; returns the vault root. */
async function vaultWith(titles: string[]): Promise<string> {
  const vault = await makeTempDir();
  for (const title of titles) {
    await addNote(vault, { title, body: `body of ${title}`, source: "human" });
  }
  return vault;
}

/** An indexed git repo (one commit, `.okf` written). */
async function indexedRepo(): Promise<string> {
  const repo = await makeTempDir();
  gitInit(repo);
  await writeFixture(repo, "src/index.ts", "export const x = 1;\n");
  commitAll(repo, "init");
  const index = await buildRepoIndex(repo);
  await writeRepoIndex(repo, index!);
  return repo;
}

/**
 * Rewrite a note's file so both its mtime and its size change.
 * Size alone is enough for the cache; changing both keeps the test honest on
 * filesystems with coarse mtime granularity.
 */
async function touchNote(vault: string, slug: string, extra: string): Promise<void> {
  const path = resolveNotePath(vault, slug)!;
  await fs.writeFile(path, (await fs.readFile(path, "utf8")) + extra, "utf8");
}

/** A clock the test advances by hand — no wall-clock dependence. */
function fakeClock(startMs = 1_700_000_000_000): { now: () => Date; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms) => void (t += ms) };
}

describe("WorkspaceCache — cold build", () => {
  it("populates the cache: notesRead === N, nothing cached yet", async () => {
    const vault = await vaultWith(["Alpha", "Beta", "Gamma"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const model = await cache.graph();
    const stats = cache.stats();

    expect(stats.notesRead).toBe(3);
    expect(stats.notesCached).toBe(0);
    expect(model.nodes.filter((n) => n.kind === "note")).toHaveLength(3);
  });

  it("records builtAt from the injected clock", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const clock = fakeClock();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault, now: clock.now });

    expect(cache.stats().builtAt).toBe("");
    await cache.graph();
    expect(cache.stats().builtAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("counts a malformed note in the vault total but omits it from the graph", async () => {
    const vault = await vaultWith(["Good"]);
    // A .md file with no parseable front matter: getNote returns null.
    await fs.writeFile(join(vault, NOTES_DIR, "broken.md"), "not a note at all", "utf8");
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const model = await cache.graph();
    expect(model.nodes.filter((n) => n.kind === "note")).toHaveLength(1);
    // fileCount includes the unparseable file — matches readVault().
    expect(model.nodes.find((n) => n.id === "vault")?.detail.notes).toBe("2");

    // It is never cached, so it is re-read (and re-rejected) every build.
    const readAfterFirst = cache.stats().notesRead;
    await cache.graph();
    expect(cache.stats().notesRead).toBe(readAfterFirst + 1);
  });
});

describe("WorkspaceCache — the no-change rebuild (§4.1 headline)", () => {
  it("does ZERO note reads and ZERO git spawns when nothing changed", async () => {
    const vault = await vaultWith(["Alpha", "Beta", "Gamma", "Delta"]);
    const repo = await indexedRepo();
    const clock = fakeClock();
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault, now: clock.now });

    await cache.graph();
    const cold = cache.stats();
    expect(cold.notesRead).toBe(4);
    expect(cold.gitCalls).toBeGreaterThan(0); // the cold build really did spawn git

    await cache.graph();
    const warm = cache.stats();

    expect(warm.notesRead).toBe(cold.notesRead); // zero further reads
    expect(warm.gitCalls).toBe(cold.gitCalls); // zero further spawns
    expect(warm.notesCached).toBe(4); // all four served from cache
  });

  it("keeps returning an equal graph across repeated no-change rebuilds", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = await cache.graph();
    const second = await cache.graph();
    const third = await cache.graph();

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(cache.stats().notesRead).toBe(2);
  });
});

describe("WorkspaceCache — snapshot reuse (the memo the ETag digest rides on)", () => {
  // `buildGraph` is pure and byte-deterministic, so rebuilding unchanged
  // inputs produces an object that is deep-equal to the last one and nothing
  // else. Returning the *identical* object instead skips the build entirely
  // and — the reason this exists — gives `src/web/server/routes` a stable
  // identity to memoize the serialized payload and its digest against
  // (weave-workspace §4.1, §15.6).

  it("hands back the identical snapshot object when nothing moved", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = await cache.snapshot();
    const second = await cache.snapshot();

    expect(second).toBe(first);
    expect(second.model).toBe(first.model);
  });

  it("builds a fresh snapshot when a note changes", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = await cache.snapshot();
    await touchNote(vault, "alpha", "\nmore text\n");
    const second = await cache.snapshot();

    expect(second).not.toBe(first);
    expect(second.model).not.toBe(first.model);
  });

  it("builds a fresh snapshot when a note is deleted", async () => {
    // The reuse guard has to notice a *disappearance*, which costs no read
    // and would otherwise look exactly like a quiet build.
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = await cache.snapshot();
    await fs.rm(resolveNotePath(vault, "alpha")!);
    const second = await cache.snapshot();

    expect(second).not.toBe(first);
    expect(second.notes).toHaveLength(1);
  });

  it("builds a fresh snapshot when an unparseable .md appears", async () => {
    // Never cached and never in `notes`, but it moves the vault node's note
    // count — so a build that only watched the parsed notes would wrongly
    // reuse and serve a stale count under an unchanged ETag.
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = await cache.snapshot();
    await fs.writeFile(join(vault, NOTES_DIR, "broken.md"), "not a note at all", "utf8");
    const second = await cache.snapshot();

    expect(second).not.toBe(first);
    expect(second.model.nodes.find((n) => n.id === "vault")?.detail.notes).toBe("2");
  });

  it("builds a fresh snapshot when the repository side is re-assessed", async () => {
    // A staleness re-assessment can move the git node or the staleness
    // report with no note touched, so the TTL expiring must defeat reuse.
    const vault = await vaultWith(["Alpha"]);
    const repo = await indexedRepo();
    const clock = fakeClock();
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault, now: clock.now, stalenessTtlMs: 1_000 });

    const first = await cache.snapshot();
    expect(await cache.snapshot()).toBe(first); // inside the TTL

    clock.advance(2_000);
    expect(await cache.snapshot()).not.toBe(first);
  });

  it("builds a fresh snapshot after a single-note invalidate", async () => {
    // The watcher's precise eviction. Even though the file on disk is
    // untouched, the entry was dropped, so the note is re-read and the
    // build is a real one rather than a reuse.
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = await cache.snapshot();
    cache.invalidate(resolveNotePath(vault, "alpha")!);
    const second = await cache.snapshot();

    expect(second).not.toBe(first);
    expect(second.model).toEqual(first.model); // nothing actually changed
  });

  it("builds a fresh snapshot after invalidateAll", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = await cache.snapshot();
    cache.invalidateAll();
    const second = await cache.snapshot();

    // A different object, but — since nothing on disk actually changed —
    // an equal one. That pairing is what keeps the ETag stable across a
    // forced rebuild while still never masking a real change.
    expect(second).not.toBe(first);
    expect(second.model).toEqual(first.model);
  });
});

describe("WorkspaceCache — incremental note changes", () => {
  it("re-reads exactly one note when one note changes", async () => {
    const vault = await vaultWith(["Alpha", "Beta", "Gamma"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    await cache.graph();
    expect(cache.stats().notesRead).toBe(3);

    await touchNote(vault, "beta", "\nappended line\n");
    const model = await cache.graph();

    expect(cache.stats().notesRead).toBe(4); // 3 + exactly one re-read
    expect(cache.stats().notesCached).toBe(2); // the other two were cached
    expect(model.nodes.find((n) => n.id === "note:beta")?.detail.preview).toContain("appended line");
  });

  it("picks up an added note without re-reading the existing ones", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    await cache.graph();
    await addNote(vault, { title: "Gamma", body: "new", source: "agent" });
    const model = await cache.graph();

    expect(cache.stats().notesRead).toBe(3); // 2 cold + 1 new
    expect(cache.stats().notesCached).toBe(2);
    expect(model.nodes.some((n) => n.id === "note:gamma")).toBe(true);
  });

  it("drops a deleted note from the graph and evicts it from the cache", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    await cache.graph();
    await fs.unlink(resolveNotePath(vault, "beta")!);
    const model = await cache.graph();

    expect(model.nodes.some((n) => n.id === "note:beta")).toBe(false);
    expect(model.nodes.filter((n) => n.kind === "note")).toHaveLength(1);
    // Only alpha was validated on the second pass.
    expect(cache.stats().notesCached).toBe(1);
    expect(cache.stats().notesRead).toBe(2);
  });

  it("re-reads a note whose size changed even at an identical mtime", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });
    await cache.graph();

    const path = resolveNotePath(vault, "alpha")!;
    const { atime, mtime } = await fs.stat(path);
    await fs.writeFile(path, (await fs.readFile(path, "utf8")) + "grew\n", "utf8");
    await fs.utimes(path, atime, mtime); // pin mtime back: only size differs

    await cache.graph();
    expect(cache.stats().notesRead).toBe(2);
  });
});

describe("WorkspaceCache — invalidate() scope inference", () => {
  it("a vault note path invalidates just that note", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });
    await cache.graph();

    cache.invalidate(resolveNotePath(vault, "alpha")!);
    await cache.graph();

    expect(cache.stats().notesRead).toBe(3); // 2 cold + alpha re-read
    expect(cache.stats().notesCached).toBe(1); // beta still cached
  });

  it("an .okf path invalidates the repository side, not the notes", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const repo = await indexedRepo();
    const clock = fakeClock();
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault, now: clock.now });
    await cache.graph();
    const cold = cache.stats();

    cache.invalidate(join(repo, ".okf", "repository", "structure.json"));
    await cache.graph();
    const after = cache.stats();

    expect(after.gitCalls).toBeGreaterThan(cold.gitCalls); // repo re-assessed
    expect(after.notesRead).toBe(cold.notesRead); // notes untouched
    expect(after.notesCached).toBe(2); // both notes served from cache
  });

  it("an unrelated path invalidates nothing", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const repo = await indexedRepo();
    const clock = fakeClock();
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault, now: clock.now });
    await cache.graph();
    const cold = cache.stats();

    const elsewhere = await makeTempDir();
    cache.invalidate(join(elsewhere, "somefile.txt"));
    await cache.graph();
    const after = cache.stats();

    expect(after.notesRead).toBe(cold.notesRead);
    expect(after.gitCalls).toBe(cold.gitCalls);
  });

  it("a non-.md file inside the notes dir invalidates nothing", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });
    await cache.graph();

    cache.invalidate(join(vault, NOTES_DIR, "scratch.txt"));
    await cache.graph();

    expect(cache.stats().notesRead).toBe(1); // no re-read
    expect(cache.stats().notesCached).toBe(1);
  });

  it("invalidating an unknown slug is a no-op, not an error", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });
    await cache.graph();

    cache.invalidate(join(vault, NOTES_DIR, "never-existed.md"));
    await cache.graph();

    expect(cache.stats().notesRead).toBe(1);
  });
});

describe("classifyPath", () => {
  const opts = { cwd: "/work/repo", vaultRoot: "/home/u/.okf" };

  it("classifies vault notes, repo files, and outsiders", () => {
    expect(classifyPath("/home/u/.okf/notes/a.md", opts)).toBe("vault");
    expect(classifyPath("/work/repo/.okf/repository/git.json", opts)).toBe("repo");
    expect(classifyPath("/work/repo/src/index.ts", opts)).toBe("repo");
    expect(classifyPath("/work/repo/.git/HEAD", opts)).toBe("repo");
    expect(classifyPath("/somewhere/else/file.txt", opts)).toBe("none");
  });

  it("ignores non-markdown files in the notes directory", () => {
    expect(classifyPath("/home/u/.okf/notes/.DS_Store", opts)).toBe("none");
    expect(classifyPath("/home/u/.okf/okf.json", opts)).toBe("none");
  });

  it("resolves a vault nested inside the repo as vault, not repo", () => {
    const nested = { cwd: "/work/repo", vaultRoot: "/work/repo/vault" };
    expect(classifyPath("/work/repo/vault/notes/a.md", nested)).toBe("vault");
    expect(classifyPath("/work/repo/src/a.ts", nested)).toBe("repo");
  });

  it("is not fooled by a sibling directory sharing a name prefix", () => {
    expect(classifyPath("/work/repo-other/src/a.ts", opts)).toBe("none");
    expect(classifyPath("/home/u/.okf/notes-archive/a.md", opts)).toBe("none");
  });

  it("treats the repo root itself as a repo event", () => {
    // fs.watch reports the watched directory itself on some rename events.
    expect(classifyPath("/work/repo", opts)).toBe("repo");
  });

  it("normalizes non-canonical paths before classifying", () => {
    expect(classifyPath("/home/u/.okf/notes/../notes/a.md", opts)).toBe("vault");
    expect(classifyPath("/work/repo/src/../src/a.ts", opts)).toBe("repo");
  });

  it("ignores a note in a subdirectory — the vault is flat", () => {
    expect(classifyPath("/home/u/.okf/notes/nested/a.md", opts)).toBe("none");
  });
});

describe("WorkspaceCache — invalidateAll", () => {
  it("forces a full rebuild of notes and the repository side", async () => {
    const vault = await vaultWith(["Alpha", "Beta", "Gamma"]);
    const repo = await indexedRepo();
    const clock = fakeClock();
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault, now: clock.now });
    await cache.graph();
    const cold = cache.stats();

    cache.invalidateAll();
    const model = await cache.graph();
    const after = cache.stats();

    expect(after.notesRead).toBe(cold.notesRead * 2); // every note read again
    expect(after.notesCached).toBe(0); // nothing was served from cache
    expect(after.gitCalls).toBeGreaterThan(cold.gitCalls);
    expect(model.nodes.filter((n) => n.kind === "note")).toHaveLength(3);
  });
});

describe("WorkspaceCache — concurrency", () => {
  it("coalesces concurrent graph() calls into a single build", async () => {
    const vault = await vaultWith(["Alpha", "Beta", "Gamma"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const [a, b, c] = await Promise.all([cache.graph(), cache.graph(), cache.graph()]);

    // One build's worth of reads, and every caller got the same object.
    expect(cache.stats().notesRead).toBe(3);
    expect(cache.stats().notesCached).toBe(0);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("snapshot() returns the graph and the notes it was built from", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const snap = await cache.snapshot();
    // Every note in the snapshot has a node in the model, and vice versa —
    // the invariant the tag index (§4.3) depends on.
    const nodeSlugs = new Set(snap.model.nodes.filter((n) => n.kind === "note").map((n) => n.detail.slug));
    expect(new Set(snap.notes.map((n) => n.slug))).toEqual(nodeSlugs);
    expect(snap.notes).toHaveLength(2);
  });

  it("snapshot() and graph() share one build", async () => {
    const vault = await vaultWith(["Alpha", "Beta", "Gamma"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const [snap, model] = await Promise.all([cache.snapshot(), cache.graph()]);
    expect(model).toBe(snap.model);
    expect(cache.stats().notesRead).toBe(3); // one build, not two
  });

  it("graph() still hands concurrent callers the identical promise", async () => {
    // `graph()` became a projection of `snapshot()`; the coalescing contract
    // is promise *identity*, which a naive `async` wrapper would break by
    // allocating a new promise per call.
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = cache.graph();
    expect(cache.graph()).toBe(first);
    await first;
    // …and once the build has settled, the slot is released so the next call
    // is a fresh build rather than a permanently cached promise.
    expect(cache.graph()).not.toBe(first);
  });

  it("the notes array is frozen — a caller cannot corrupt the next build", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });
    const snap = await cache.snapshot();
    expect(Object.isFrozen(snap.notes)).toBe(true);
  });

  it("returns the identical in-flight promise to a second caller", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const first = cache.graph();
    const second = cache.graph();
    expect(second).toBe(first);
    await first;
  });

  it("builds again after the in-flight promise settles", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    await cache.graph();
    const next = cache.graph();
    await next;
    // A fresh promise, and a real (if fully-cached) second pass.
    expect(cache.stats().notesCached).toBe(1);
  });

  /**
   * The SSE case, at the one timing that is actually dangerous.
   *
   * A build consults the note map, then replaces it wholesale at the end. An
   * `invalidate` arriving *after* the map was consulted but *before* the swap
   * would be undone by the swap, and the cache would serve that stale note
   * forever. The window is precisely `refreshRepo`, which runs after
   * `refreshNotes` — so the injected clock (called there) is the deterministic
   * hook into it. Invalidating earlier than this is honoured for free, which
   * is why a naive test passes against the buggy version.
   */
  function cacheWithMidBuildHook(
    cwd: string,
    vaultRoot: string,
    hook: (cache: WorkspaceCache) => void,
  ): WorkspaceCache {
    let fired = false;
    const cache: WorkspaceCache = new WorkspaceCache({
      cwd,
      vaultRoot,
      now: () => {
        // Called by refreshRepo: notes are read, the swap has not happened.
        if (!fired) {
          fired = true;
          hook(cache);
        }
        return new Date(1_700_000_000_000);
      },
    });
    return cache;
  }

  /**
   * Run `graph()` with `hook` fired during the note-reading loop — the one
   * window the wholesale map swap can swallow.
   *
   * `refreshNotes` collects survivors into a fresh map and installs it at the
   * end, so an eviction that lands *after* a note was carried over but
   * *before* the swap is undone by the swap. Firing on a `readFile` inside
   * the loop lands exactly there. (An eviction during `refreshRepo` is
   * already too late to be lost — the map is installed by then — which is why
   * the clock hook above cannot exercise this case.)
   */
  async function graphWithHookDuringNoteRead(
    cache: WorkspaceCache,
    hook: () => void,
  ): Promise<void> {
    const realReadFile = fs.readFile;
    let fired = false;
    (fs as unknown as { readFile: unknown }).readFile = async (...args: unknown[]) => {
      const result = await (realReadFile as (...a: unknown[]) => Promise<unknown>)(...args);
      if (!fired && String(args[0]).endsWith(".md")) {
        fired = true;
        hook();
      }
      return result;
    };
    try {
      await cache.graph();
    } finally {
      (fs as unknown as { readFile: unknown }).readFile = realReadFile;
    }
    expect(fired).toBe(true); // the hook really did land inside the loop
  }

  it("honours a note invalidate() that lands mid-build", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    // Fires while the first note is being read, i.e. before the map swap.
    await graphWithHookDuringNoteRead(cache, () => cache.invalidate(resolveNotePath(vault, "alpha")!));
    const cold = cache.stats();
    expect(cold.notesRead).toBe(2);

    await cache.graph();
    expect(cache.stats().notesRead).toBe(cold.notesRead + 1); // alpha only
    expect(cache.stats().notesCached).toBe(1); // beta survived
  });

  it("honours an invalidateAll() that lands mid-build", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    await graphWithHookDuringNoteRead(cache, () => cache.invalidateAll());
    const cold = cache.stats();
    expect(cold.notesRead).toBe(2);

    await cache.graph();
    expect(cache.stats().notesRead).toBe(cold.notesRead + 2); // both re-read
    expect(cache.stats().notesCached).toBe(0);
  });

  it("honours a repo invalidate() that lands mid-build", async () => {
    const vault = await vaultWith(["Alpha"]);
    const repo = await indexedRepo();
    const gitJson = join(repo, ".okf", "repository", "git.json");

    const cache = cacheWithMidBuildHook(repo, vault, (c) => c.invalidate(gitJson));
    await cache.graph();
    const cold = cache.stats();

    // The clock never advances, so the TTL alone would suppress this — only
    // the deferred eviction can force the re-assessment.
    await cache.graph();
    expect(cache.stats().gitCalls).toBeGreaterThan(cold.gitCalls);
  });

  it("does not wedge when a build fails: the next call retries", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    // The injected clock is the one dependency that can fail a build outright
    // (every disk path in core degrades instead of throwing), so it is the
    // honest way to prove a rejection does not leave `inFlight` latched.
    const boom = new Error("clock exploded");
    let failNext = true;
    const cache = new WorkspaceCache({
      cwd,
      vaultRoot: vault,
      now: () => {
        if (failNext) {
          failNext = false;
          throw boom;
        }
        return new Date(1_700_000_000_000);
      },
    });

    await expect(cache.graph()).rejects.toThrow("clock exploded");

    // The failed promise was cleared, so this is a fresh build, not a replay.
    const model = await cache.graph();
    expect(model.nodes.some((n) => n.id === "vault")).toBe(true);
    expect(cache.stats().builtAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe("WorkspaceCache — staleness TTL", () => {
  it("does not spawn git again within the TTL", async () => {
    const vault = await vaultWith(["Alpha"]);
    const repo = await indexedRepo();
    const clock = fakeClock();
    const cache = new WorkspaceCache({
      cwd: repo,
      vaultRoot: vault,
      now: clock.now,
      stalenessTtlMs: 2_000,
    });

    await cache.graph();
    const cold = cache.stats();

    clock.advance(1_999); // still inside the window
    await cache.graph();

    expect(cache.stats().gitCalls).toBe(cold.gitCalls);
  });

  it("re-assesses once the TTL has elapsed", async () => {
    const vault = await vaultWith(["Alpha"]);
    const repo = await indexedRepo();
    const clock = fakeClock();
    const cache = new WorkspaceCache({
      cwd: repo,
      vaultRoot: vault,
      now: clock.now,
      stalenessTtlMs: 2_000,
    });

    await cache.graph();
    const cold = cache.stats();

    clock.advance(2_001); // past the window
    await cache.graph();

    expect(cache.stats().gitCalls).toBeGreaterThan(cold.gitCalls);
  });

  it("a zero TTL re-assesses on every build", async () => {
    const vault = await vaultWith(["Alpha"]);
    const repo = await indexedRepo();
    const clock = fakeClock();
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault, now: clock.now, stalenessTtlMs: 0 });

    await cache.graph();
    const cold = cache.stats();
    await cache.graph(); // clock has not moved at all
    expect(cache.stats().gitCalls).toBeGreaterThan(cold.gitCalls);
  });

  it("defaults to a 2s TTL", () => {
    expect(DEFAULT_STALENESS_TTL_MS).toBe(2_000);
  });

  it("caches the 'not a repo' answer too, so a bare cwd stops spawning git", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir(); // no git repo here
    const clock = fakeClock();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault, now: clock.now });

    await cache.graph();
    const cold = cache.stats();
    expect(cold.gitCalls).toBeGreaterThan(0); // findGitRoot ran once

    await cache.graph();
    expect(cache.stats().gitCalls).toBe(cold.gitCalls); // and not again
  });
});

describe("WorkspaceCache — equivalence with buildCurrentGraph (the safety net)", () => {
  it("matches the uncached build for a vault-only workspace", async () => {
    const vault = await vaultWith(["Alpha", "Beta"]);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    expect(await cache.graph()).toEqual(await buildCurrentGraph(cwd, vault));
  });

  it("matches the uncached build inside an indexed repo", async () => {
    const vault = await vaultWith(["Alpha", "Beta", "Gamma"]);
    const repo = await indexedRepo();
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault });

    expect(await cache.graph()).toEqual(await buildCurrentGraph(repo, vault));
  });

  it("matches after incremental churn — add, edit, and delete", async () => {
    const vault = await vaultWith(["Alpha", "Beta", "Gamma"]);
    const repo = await indexedRepo();
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault, stalenessTtlMs: 0 });
    await cache.graph();

    await addNote(vault, { title: "Delta", body: "links [[alpha]]", source: "agent" });
    await touchNote(vault, "beta", "\nmore text\n");
    await fs.unlink(resolveNotePath(vault, "gamma")!);

    expect(await cache.graph()).toEqual(await buildCurrentGraph(repo, vault));
  });

  it("matches on an empty vault", async () => {
    const vault = await makeTempDir();
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    expect(await cache.graph()).toEqual(await buildCurrentGraph(cwd, vault));
  });

  it("matches when notes share an updated timestamp (tie-break ordering)", async () => {
    const vault = await makeTempDir();
    const at = new Date("2026-02-02T00:00:00.000Z");
    for (const title of ["Zulu", "Alpha", "Mike"]) {
      await addNote(vault, { title, body: "same instant", source: "human", now: at });
    }
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: vault });

    const cached = await cache.graph();
    const uncached = await buildCurrentGraph(cwd, vault);
    expect(cached).toEqual(uncached);
    // Order is total, not just set-equal.
    expect(cached.nodes.map((n) => n.id)).toEqual(uncached.nodes.map((n) => n.id));
  });

  it("matches for a repo whose index is missing", async () => {
    const vault = await vaultWith(["Alpha"]);
    const repo = await makeTempDir();
    gitInit(repo);
    commitAll(repo, "init"); // git repo, no .okf
    const cache = new WorkspaceCache({ cwd: repo, vaultRoot: vault });

    expect(await cache.graph()).toEqual(await buildCurrentGraph(repo, vault));
  });

  it("resolves the vault root from the environment like the uncached path", async () => {
    const vault = await vaultWith(["Alpha"]);
    const cwd = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const cache = new WorkspaceCache({ cwd, vaultRoot: vault });
      // buildCurrentGraph defaults vaultRoot from PI_WEAVE_VAULT.
      expect(await cache.graph()).toEqual(await buildCurrentGraph(cwd));
    });
  });
});
