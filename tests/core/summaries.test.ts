import * as fs from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  DEEP_SCAN_MAX_FILE_BYTES,
  hashContent,
  isSummarizablePath,
  parseSummaryFile,
  pruneSummaries,
  readSummaries,
  readSummaryMap,
  runDeepScan,
  serializeSummary,
  summaryFileName,
  summaryPath,
  writeSummary,
  type SummaryRecord,
} from "../../src/core/summaries";
import { commitAll, gitInit, makeTempDir, writeFixture } from "../helpers";

function rec(over: Partial<SummaryRecord> = {}): SummaryRecord {
  return {
    target: "src/a.ts",
    contentHash: "abc123",
    summary: "Does a thing.",
    model: "test/model",
    at: "2026-08-23T09:00:00.000Z",
    source: "generated",
    ...over,
  };
}

describe("summaryFileName / summaryPath", () => {
  it("maps paths deterministically and reversibly-in-practice", () => {
    expect(summaryFileName("src/core/vault.ts")).toBe("src--core--vault.ts.summary.md");
    expect(summaryFileName("index.ts")).toBe("index.ts.summary.md");
  });

  it("lives under .okf/repository/summaries", () => {
    expect(summaryPath("/repo", "src/a.ts")).toBe(join("/repo", ".okf", "repository", "summaries", "src--a.ts.summary.md"));
  });
});

describe("serializeSummary / parseSummaryFile", () => {
  it("round-trips all fields including quoted paths and null model", () => {
    const withModel = rec({ summary: "Line one.\n\nLine two with \"quotes\"." });
    const parsed = parseSummaryFile(serializeSummary(withModel));
    expect(parsed).toEqual(withModel);

    const nullModel = rec({ model: null, target: "docs/guide v2.md" });
    const parsed2 = parseSummaryFile(serializeSummary(nullModel));
    expect(parsed2).toEqual(nullModel);
  });

  it("defaults missing/unknown source to generated", () => {
    const text = serializeSummary(rec()).replace("source: generated", "source: mysterious");
    expect(parseSummaryFile(text)?.source).toBe("generated");
  });

  it("returns null on missing front matter or missing required fields", () => {
    expect(parseSummaryFile("no front matter here")).toBeNull();
    expect(parseSummaryFile("---\nsource: generated\n---\nbody")).toBeNull(); // no target
    expect(parseSummaryFile("---\ntarget: a.ts\ncontent_hash: x\n---\nbody")).toBeNull(); // no at
  });
});

describe("read/write summaries on disk", () => {
  let root: string;
  beforeAll(async () => { root = await makeTempDir(); });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("writeSummary + readSummaries round-trip through the summaries dir", async () => {
    await writeSummary(root, rec({ target: "b.ts" }));
    await writeSummary(root, rec({ target: "a.ts" }));
    const all = await readSummaries(root);
    expect(all.map((r) => r.target)).toEqual(["a.ts", "b.ts"]); // sorted
    const map = await readSummaryMap(root);
    expect(map.get("b.ts")?.summary).toBe("Does a thing.");
  });

  it("skips unreadable/corrupt sidecars instead of failing", async () => {
    await fs.writeFile(join(summaryPath(root, "x.ts")), "garbage", "utf8"); // no front matter
    const all = await readSummaries(root);
    expect(all.find((r) => r.target === "x.ts")).toBeUndefined();
  });

  it("skips a sidecar whose read throws (e.g. a directory in its place)", async () => {
    const dir = join(root, ".okf", "repository", "summaries");
    await fs.mkdir(join(dir, "dir.summary.md"), { recursive: true }); // readFile on a dir throws EISDIR
    try {
      const all = await readSummaries(root);
      expect(all.find((r) => r.target === "dir")).toBeUndefined();
    } finally {
      await fs.rm(join(dir, "dir.summary.md"), { recursive: true, force: true });
    }
  });

  it("readSummaries returns [] when the directory doesn't exist", async () => {
    const empty = await makeTempDir();
    try {
      expect(await readSummaries(empty)).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("pruneSummaries removes sidecars the predicate rejects", async () => {
    const dir = join(root, ".okf", "repository", "summaries");
    const before = await readSummaries(root);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const removed = await pruneSummaries(root, (r) => r.target === "a.ts");
    expect(removed).toBeGreaterThanOrEqual(1);
    const after = await readSummaries(root);
    expect(after.map((r) => r.target)).toEqual(["a.ts"]);
    // deleting again is a no-op (tolerates already-gone files)
    expect(await pruneSummaries(root, () => false)).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("isSummarizablePath", () => {
  it("keeps source files and rejects lock/minified/snapshot/media/binary extensions", () => {
    expect(isSummarizablePath("src/core/vault.ts")).toBe(true);
    expect(isSummarizablePath("README.md")).toBe(true);
    expect(isSummarizablePath("package-lock.json")).toBe(false);
    expect(isSummarizablePath("frontend/yarn.lock")).toBe(false);
    expect(isSummarizablePath("dist/bundle.min.js")).toBe(false);
    expect(isSummarizablePath("assets/logo.png")).toBe(false);
    expect(isSummarizablePath("__snapshots__/t.snap")).toBe(false);
    expect(isSummarizablePath("bin/tool.EXE")).toBe(false);
    expect(isSummarizablePath(".okf/repository/summaries/src--a.ts.summary.md")).toBe(false);
  });
});

describe("runDeepScan", () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempDir();
    gitInit(root);
    await writeFixture(root, "src/alpha.ts", "export const alpha = 1;\n");
    await writeFixture(root, "src/beta.ts", "export const beta = 2;\n");
    await writeFixture(root, "README.md", "# fixture\n");
    await writeFixture(root, "package-lock.json", "{}");
    await commitAll(root);
  });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("returns null outside a git repository", async () => {
    const plain = await makeTempDir();
    try {
      expect(await runDeepScan(plain, { summarize: async () => "x" })).toBeNull();
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it("summarizes tracked files, skips non-summarizable ones, and is incremental", async () => {
    const calls: string[] = [];
    const at = () => new Date("2026-08-23T10:00:00.000Z");
    const first = await runDeepScan(root, {
      summarize: async ({ path }) => { calls.push(path); return `Summary of ${path}`; },
      at,
      model: "fake/llm",
    });
    expect(first).not.toBeNull();
    expect(first!.written).toBe(3);
    expect(first!.skippedFresh).toBe(0);
    expect(calls.sort()).toEqual(["README.md", "src/alpha.ts", "src/beta.ts"]);
    expect(first!.failed).toEqual([]);

    // sidecars are on disk with provenance + content hash
    const map = await readSummaryMap(root);
    expect(map.get("src/alpha.ts")?.source).toBe("generated");
    expect(map.get("src/alpha.ts")?.model).toBe("fake/llm");
    expect(map.get("src/alpha.ts")?.summary).toBe("Summary of src/alpha.ts");

    // second run with no changes: everything fresh, zero LLM calls
    calls.length = 0;
    const second = await runDeepScan(root, { summarize: async ({ path }) => { calls.push(path); return "new"; }, at });
    expect(second!.skippedFresh).toBe(3);
    expect(second!.written).toBe(0);
    expect(calls).toEqual([]);

    // edit one file → only it is re-summarized
    await writeFixture(root, "src/alpha.ts", "export const alpha = 100;\n");
    await commitAll(root);
    calls.length = 0;
    const third = await runDeepScan(root, { summarize: async ({ path }) => { calls.push(path); return "updated"; }, at });
    expect(third!.written).toBe(1);
    expect(third!.skippedFresh).toBe(2);
    calls.length = 0;
  });

  it("records a file as failed when it cannot be read", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return; // root ignores file permissions — nothing to assert
    }
    const repo = await makeTempDir();
    gitInit(repo);
    try {
      await writeFixture(repo, "src/locked.ts", "export const locked = 1;\n");
      await commitAll(repo);
      await fs.chmod(join(repo, "src", "locked.ts"), 0o000);
      try {
        const result = await runDeepScan(repo, { summarize: async () => "s" });
        expect(result!.failed).toEqual([{ path: "src/locked.ts", error: "unreadable" }]);
      } finally {
        await fs.chmod(join(repo, "src", "locked.ts"), 0o644);
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("collects per-file failures without aborting the whole scan", async () => {
    await writeFixture(root, "src/gamma.ts", "export const gamma = 3;\n");
    await commitAll(root);
    const result = await runDeepScan(root, {
      summarize: async ({ path }) => {
        if (path === "src/gamma.ts") throw new Error("model exploded");
        return "ok";
      },
    });
    expect(result!.failed).toEqual([{ path: "src/gamma.ts", error: "model exploded" }]);
    expect(result!.skippedFresh).toBeGreaterThanOrEqual(2); // others unchanged
  });

  it("pruneSummaries tolerates a sidecar that disappears mid-prune", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return; // root ignores file permissions — nothing to assert
    }
    const repo = await makeTempDir();
    try {
      await writeSummary(repo, rec({ target: "src/gone.ts" }));
      const dir = join(repo, ".okf", "repository", "summaries");
      await fs.chmod(dir, 0o555); // read-only dir → unlink throws EPERM
      try {
        const removed = await pruneSummaries(repo, () => false);
        expect(removed).toBe(0); // the unlink threw, so nothing counted
      } finally {
        await fs.chmod(dir, 0o755);
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("prunes sidecars for files that left the repository", async () => {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((res, rej) =>
      execFile("git", ["rm", "-q", "--cached", "src/gamma.ts"], { cwd: root }, (e) => (e ? rej(e) : res())),
    );
    await fs.rm(join(root, "src", "gamma.ts"));
    await commitAll(root);
    // gamma had no sidecar (it failed); add one manually then expect pruning
    await writeSummary(root, rec({ target: "src/gamma.ts" }));
    const result = await runDeepScan(root, { summarize: async () => "ok" });
    expect(result!.pruned).toBe(1);
    expect(await readSummaryMap(root).then((m) => m.has("src/gamma.ts"))).toBe(false);
  });

  it("respects maxFiles and the byte cap (binary and oversized skipped)", async () => {
    const tiny = await makeTempDir();
    gitInit(tiny);
    try {
      await writeFixture(tiny, "big.txt", "x".repeat(DEEP_SCAN_MAX_FILE_BYTES + 1));
      await writeFixture(tiny, "tiny.ts", "export {};\n");
      await writeFixture(tiny, "a.ts", "export const a = 1;\n");
      await writeFixture(tiny, "b.ts", "export const b = 2;\n");
      await commitAll(tiny);
      const result = await runDeepScan(tiny, {
        summarize: async () => "s",
        maxFiles: 3,
        maxFileBytes: 100,
      });
      expect(result!.considered).toBe(3); // capped
      expect(result!.skippedTooBig + result!.written).toBe(3);
      expect(result!.written).toBeLessThan(3); // at least one skipped for size
    } finally {
      await fs.rm(tiny, { recursive: true, force: true });
    }
  });

  it("caps concurrency at the requested level", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    try {
      for (let i = 0; i < 6; i++) await writeFixture(repo, `f${i}.ts`, `export const x${i} = ${i};\n`);
      await commitAll(repo);
      let active = 0, maxActive = 0;
      await runDeepScan(repo, {
        concurrency: 2,
        summarize: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 15));
          active -= 1;
          return "s";
        },
      });
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(maxActive).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("hashContent is stable sha1", () => {
    expect(hashContent("hello")).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
  });
});
