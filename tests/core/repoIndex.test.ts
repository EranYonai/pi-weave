import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessStaleness,
  buildRepoIndex,
  buildStructure,
  readRepoIndex,
  summarizeIndex,
  writeRepoIndex,
} from "../../src/core/repoIndex";
import { commitAll, gitExec, gitInit, makeTempDir, writeFixture } from "../helpers";

const NOW = new Date("2026-08-22T12:00:00.000Z");

describe("buildStructure (pure)", () => {
  it("counts languages sorted by frequency", () => {
    const structure = buildStructure(["a.ts", "b.ts", "c.py", "d.unknown"], NOW);
    expect(structure.fileCount).toBe(4);
    expect(structure.languages).toEqual({ TypeScript: 2, Python: 1 });
    expect(structure.capturedAt).toBe(NOW.toISOString());
  });

  it("detects manifests of several kinds with names", () => {
    const structure = buildStructure(
      ["package.json", "packages/api/package.json", "pyproject.toml", "crates/x/Cargo.toml", "go.mod", "app/Gemfile", "src/index.ts"],
      NOW,
    );
    expect(structure.packages).toEqual([
      { manifestPath: "app/Gemfile", kind: "ruby", name: "app" },
      { manifestPath: "crates/x/Cargo.toml", kind: "rust", name: "x" },
      { manifestPath: "go.mod", kind: "go", name: "(root)" },
      { manifestPath: "package.json", kind: "npm", name: "(root)" },
      { manifestPath: "packages/api/package.json", kind: "npm", name: "api" },
      { manifestPath: "pyproject.toml", kind: "python", name: "(root)" },
    ]);
  });

  it("groups modules by meaningful segments and skips node_modules/.git", () => {
    const structure = buildStructure(
      [
        "src/auth/a.ts",
        "src/auth/b.ts",
        "src/api/c.ts",
        "packages/core/x.ts",
        "lib/util/y.ts",
        "docs/readme.md",
        "root.ts",
        "node_modules/pkg/z.ts",
        ".git/hooks/pre",
      ],
      NOW,
    );
    expect(structure.modules).toEqual([
      { path: "src/auth", fileCount: 2 },
      { path: "(root)", fileCount: 1 },
      { path: "docs", fileCount: 1 },
      { path: "lib/util", fileCount: 1 },
      { path: "packages/core", fileCount: 1 },
      { path: "src/api", fileCount: 1 },
    ]);
  });

  it("finds likely entry points", () => {
    const structure = buildStructure(
      ["src/index.ts", "src/main.py", "cmd/server/main.go", "src/lib.rs", "src/other/util.ts", "main.py", "Sources/app/main.swift"],
      NOW,
    );
    expect(structure.entryPoints).toEqual([
      "Sources/app/main.swift",
      "cmd/server/main.go",
      "main.py",
      "src/index.ts",
      "src/lib.rs",
      "src/main.py",
    ]);
  });

  it("summarises top-level entries including root files", () => {
    const structure = buildStructure(["a.ts", "src/b.ts", "src/c.ts", "docs/d.md"], NOW);
    expect(structure.topLevel).toEqual([
      { name: "(root files)", fileCount: 1 },
      { name: "docs", fileCount: 1 },
      { name: "src", fileCount: 2 },
    ]);
  });
});

describe("buildRepoIndex (against a real git repo)", () => {
  async function makeRepo(): Promise<string> {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "package.json", JSON.stringify({ name: "fixture-app" }));
    await writeFixture(dir, "pyproject.toml", 'name = "py-fixture"\n');
    await writeFixture(dir, "src/index.ts", "export {};\n");
    await writeFixture(dir, "src/auth/tokens.ts", "export {};\n");
    await writeFixture(dir, "README.md", "# fixture\n");
    commitAll(dir, "initial");
    return dir;
  }

  it("builds a complete index with identity, git anchor, and structure", async () => {
    const dir = await makeRepo();
    const index = await buildRepoIndex(dir, { now: NOW });
    expect(index).not.toBeNull();
    expect(index?.okfVersion).toBe(1);
    expect(index?.scope).toBe("repository");
    expect(index?.generator).toBe("pi-weave");
    expect(index?.identity.name).toBe((await import("node:path")).basename(dir));
    expect(index?.identity.root).toBe(dir);
    expect(index?.git.branch).toBe("main");
    expect(index?.git.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(index?.git.changedFiles).toEqual([]);
    // package names were enriched from manifest contents
    const names = index?.structure.packages.map((p) => p.name).sort();
    expect(names).toEqual(["fixture-app", "py-fixture"]);
    expect(index?.structure.entryPoints).toContain("src/index.ts");
    expect(index?.created).toBe(NOW.toISOString());
  });

  it("falls back to dir name for unreadable/invalid manifests", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "packages/web/package.json", "not json at all{{{");
    await writeFixture(dir, "setup/pyproject.toml", "[project]\n");
    commitAll(dir, "initial");
    const index = await buildRepoIndex(dir);
    const names = index?.structure.packages.map((p) => p.name).sort();
    expect(names).toEqual(["setup", "web"]);
  });

  it("records remotes and default branch when present", async () => {
    const dir = await makeRepo();
    gitExec(dir, ["remote", "add", "origin", "git@github.com:acme/repo.git"]);
    gitExec(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    gitExec(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const index = await buildRepoIndex(dir);
    expect(index?.identity.remotes).toEqual(["git@github.com:acme/repo.git"]);
    expect(index?.identity.defaultBranch).toBe("main");
  });

  it("returns null outside a git repository", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, "file.txt", "x");
    expect(await buildRepoIndex(dir)).toBeNull();
  });

  it("returns null for a repo without commits", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "a.ts", "x");
    expect(await buildRepoIndex(dir)).toBeNull();
  });

  it("honours the maxFiles cap", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    for (let i = 0; i < 5; i++) await writeFixture(dir, `f${i}.txt`, "x");
    commitAll(dir, "initial");
    const index = await buildRepoIndex(dir, { maxFiles: 3 });
    expect(index?.structure.fileCount).toBe(3);
  });

  it("captures uncommitted changes in the git anchor", async () => {
    const dir = await makeRepo();
    await writeFixture(dir, "dirty-new.ts", "x");
    const index = await buildRepoIndex(dir);
    expect(index?.git.changedFiles).toEqual(["dirty-new.ts"]);
  });
});

describe("writeRepoIndex / readRepoIndex", () => {
  it("round-trips an index through .okf/", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "src/main.ts", "export {};\n");
    commitAll(dir, "initial");

    const index = (await buildRepoIndex(dir, { now: NOW }))!;
    const outDir = await writeRepoIndex(dir, index);
    expect(outDir).toBe(join(dir, ".okf"));

    const manifest = JSON.parse(await fs.readFile(join(dir, ".okf", "okf.json"), "utf8"));
    expect(manifest.scope).toBe("repository");
    expect(manifest.generator).toBe("pi-weave");

    const back = await readRepoIndex(dir);
    expect(back).toEqual(index);
  });

  it("persists generated provenance and round-trips it", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "src/main.ts", "export {};\n");
    commitAll(dir, "initial");

    const index = (await buildRepoIndex(dir, { now: NOW }))!;
    expect(index.source).toBe("generated");
    await writeRepoIndex(dir, index);

    const manifest = JSON.parse(await fs.readFile(join(dir, ".okf", "okf.json"), "utf8"));
    expect(manifest.source).toBe("generated");
    expect((await readRepoIndex(dir))?.source).toBe("generated");
  });

  it("defaults missing or unknown provenance to 'generated'", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "src/main.ts", "export {};\n");
    commitAll(dir, "initial");
    await writeRepoIndex(dir, (await buildRepoIndex(dir))!);

    const manifestPath = join(dir, ".okf", "okf.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    delete manifest.source; // indexes written before provenance existed
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    expect((await readRepoIndex(dir))?.source).toBe("generated");

    manifest.source = "sideways"; // unknown values don't masquerade
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    expect((await readRepoIndex(dir))?.source).toBe("generated");
  });

  it("writes indexes from linked worktrees (.git is a file)", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "src/main.ts", "export {};\n");
    commitAll(dir, "initial");
    const wt = join(await makeTempDir(), "wt");
    gitExec(dir, ["worktree", "add", wt, "-b", "wt-branch"]);
    expect((await fs.lstat(join(wt, ".git"))).isFile()).toBe(true);

    const index = (await buildRepoIndex(wt))!;
    await writeRepoIndex(wt, index);
    expect(await readRepoIndex(wt)).not.toBeNull();
    // exclusion landed in the shared git dir of the main worktree
    expect(await fs.readFile(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".okf/");
  });

  it("readRepoIndex returns null when nothing exists", async () => {
    const dir = await makeTempDir();
    expect(await readRepoIndex(dir)).toBeNull();
  });

  it("readRepoIndex returns null on corrupt files", async () => {
    const dir = await makeTempDir();
    await writeFixture(dir, ".okf/okf.json", "not json{{{");
    expect(await readRepoIndex(dir)).toBeNull();
  });
});

describe("assessStaleness", () => {
  async function indexedRepo(): Promise<string> {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "src/a.ts", "export {};\n");
    commitAll(dir, "initial");
    const index = (await buildRepoIndex(dir))!;
    await writeRepoIndex(dir, index);
    return dir;
  }

  it("is 'missing' without an index", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    commitAll(dir);
    const report = await assessStaleness(dir);
    expect(report.state).toBe("missing");
    expect(report.reasons[0]).toMatch(/no \.okf index/);
  });

  it("is 'fresh' right after indexing", async () => {
    const dir = await indexedRepo();
    expect(await assessStaleness(dir)).toEqual({ state: "fresh", reasons: [] });
  });

  it("is 'stale' after HEAD moves", async () => {
    const dir = await indexedRepo();
    await writeFixture(dir, "src/b.ts", "export {};\n");
    commitAll(dir, "second");
    const report = await assessStaleness(dir);
    expect(report.state).toBe("stale");
    expect(report.reasons.some((r) => r.includes("HEAD moved"))).toBe(true);
  });

  it("is 'stale' when the branch changes", async () => {
    const dir = await indexedRepo();
    gitExec(dir, ["checkout", "-b", "feature"]);
    const report = await assessStaleness(dir);
    expect(report.state).toBe("stale");
    expect(report.reasons.some((r) => r.includes("branch changed: main -> feature"))).toBe(true);
  });

  it("is 'stale' on new uncommitted changes, listing up to 5 files", async () => {
    const dir = await indexedRepo();
    for (let i = 0; i < 6; i++) await writeFixture(dir, `new-${i}.ts`, "x");
    const report = await assessStaleness(dir);
    expect(report.state).toBe("stale");
    expect(report.reasons.some((r) => r.includes("6 new uncommitted change(s)") && r.includes("…"))).toBe(true);
  });

  it("mentions resolved changes when HEAD is unchanged", async () => {
    const dir = await indexedRepo();
    await writeFixture(dir, "temp.ts", "x");
    const dirty = (await buildRepoIndex(dir))!;
    await writeRepoIndex(dir, dirty);
    await fs.rm(join(dir, "temp.ts"));
    const report = await assessStaleness(dir);
    expect(report.state).toBe("stale");
    expect(report.reasons.some((r) => r.includes("resolved"))).toBe(true);
  });

  it("is 'stale' when an already-dirty file is edited further", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "package.json", JSON.stringify({ name: "one" }));
    commitAll(dir, "initial");

    // dirty at capture time, then assessed without changes → fresh
    await writeFixture(dir, "package.json", JSON.stringify({ name: "two" }));
    await writeRepoIndex(dir, (await buildRepoIndex(dir))!);
    expect((await assessStaleness(dir)).state).toBe("fresh");

    // same path still dirty, but the content moved: membership-only
    // comparisons would (wrongly) stay fresh here
    await writeFixture(dir, "package.json", JSON.stringify({ name: "three" }));
    const report = await assessStaleness(dir);
    expect(report.state).toBe("stale");
    expect(report.reasons.some((r) => r.includes("edited since capture") && r.includes("package.json"))).toBe(true);
  });

  it("caps the edited-since-capture file list at 5", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    for (let i = 0; i < 6; i++) await writeFixture(dir, `f${i}.ts`, "v1");
    commitAll(dir, "initial");
    for (let i = 0; i < 6; i++) await writeFixture(dir, `f${i}.ts`, "v2"); // dirty at capture
    await writeRepoIndex(dir, (await buildRepoIndex(dir))!);
    for (let i = 0; i < 6; i++) await writeFixture(dir, `f${i}.ts`, "v3"); // re-edited
    const report = await assessStaleness(dir);
    expect(report.reasons.some((r) => r.includes("6 uncommitted file(s) edited since capture") && r.includes("…"))).toBe(true);
  });

  it("degrades to path comparison for indexes captured before content anchoring", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "package.json", JSON.stringify({ name: "one" }));
    commitAll(dir, "initial");
    await writeFixture(dir, "package.json", JSON.stringify({ name: "two" }));
    await writeRepoIndex(dir, (await buildRepoIndex(dir))!);

    // Simulate a pre-content-anchoring index: no changedHashes on disk.
    const gitJsonPath = join(dir, ".okf", "repository", "git.json");
    const raw = JSON.parse(await fs.readFile(gitJsonPath, "utf8"));
    delete raw.changedHashes;
    await fs.writeFile(gitJsonPath, JSON.stringify(raw, null, 2), "utf8");

    await writeFixture(dir, "package.json", JSON.stringify({ name: "three" }));
    expect((await assessStaleness(dir)).state).toBe("fresh");
  });

  it("is 'stale' when no longer inside a git repository", async () => {
    const dir = await indexedRepo();
    await fs.rm(join(dir, ".git"), { recursive: true, force: true });
    const report = await assessStaleness(dir);
    expect(report.state).toBe("stale");
    expect(report.reasons[0]).toMatch(/no longer inside a git repository/);
  });

  it("is 'stale' when HEAD has no commits anymore (edge)", async () => {
    // Simulate: index exists but git root cannot produce a HEAD — covered by
    // the branch-less path. We emulate by checking the plain unborn case.
    const dir = await makeTempDir();
    gitInit(dir);
    commitAll(dir, "one");
    const index = (await buildRepoIndex(dir))!;
    await writeRepoIndex(dir, index);
    // Move .git away and put back an unborn repo at the same path
    const gitBackup = `${dir}-git-backup`;
    await fs.rename(join(dir, ".git"), gitBackup);
    await fs.rm(gitBackup, { recursive: true, force: true });
    gitInit(dir); // no commits now
    const report = await assessStaleness(dir);
    expect(report.state).toBe("stale");
    expect(report.reasons.some((r) => r.includes("no commits"))).toBe(true);
  });
});

describe("summarizeIndex", () => {
  it("produces a compact summary", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "package.json", JSON.stringify({ name: "app" }));
    await writeFixture(dir, "src/index.ts", "export {};\n");
    commitAll(dir);
    const index = (await buildRepoIndex(dir, { now: NOW }))!;
    const lines = summarizeIndex(index);
    expect(lines[0]).toMatch(/^Repository: /);
    expect(lines.join("\n")).toContain("Git: main @");
    expect(lines.join("\n")).toContain("Languages: JSON (1), TypeScript (1)");
    expect(lines.join("\n")).toContain("Packages: app");
    expect(lines.join("\n")).toContain("Entry points: src/index.ts");
  });

  it("notes uncommitted changes and caps modules at 12", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    for (let i = 0; i < 15; i++) await writeFixture(dir, `d${String(i).padStart(2, "0")}/f.ts`, "x");
    commitAll(dir);
    await writeFixture(dir, "dirty.ts", "x");
    const index = (await buildRepoIndex(dir))!;
    const text = summarizeIndex(index).join("\n");
    expect(text).toContain("(1 uncommitted)");
    const moduleLine = summarizeIndex(index).find((l) => l.startsWith("Modules: "))!;
    expect(moduleLine.split(",").length).toBeLessThanOrEqual(13); // 12 entries + prefix
  });
});
