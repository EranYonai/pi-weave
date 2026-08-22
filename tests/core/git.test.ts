import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  currentBranch,
  defaultBranch,
  excludeOkfLocally,
  findGitRoot,
  hashWorktreeFiles,
  headSha,
  listFiles,
  remotes,
  snapshotGitState,
} from "../../src/core/git";
import { commitAll, gitExec, gitInit, makeTempDir, writeFixture } from "../helpers";

describe("git layer without a repository", () => {
  it("degrades to null/empty everywhere", async () => {
    const dir = await makeTempDir();
    expect(await findGitRoot(dir)).toBeNull();
    expect(await headSha(dir)).toBeNull();
    expect(await currentBranch(dir)).toBeNull();
    expect(await changedFiles(dir)).toEqual([]);
    expect(await listFiles(dir)).toBeNull();
    expect(await remotes(dir)).toEqual([]);
    expect(await defaultBranch(dir)).toBeNull();
    expect(await snapshotGitState(dir)).toBeNull();
  });
});

describe("git layer with a repository", () => {
  async function makeRepo(): Promise<string> {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "src/index.ts", "export {};\n");
    commitAll(dir, "initial");
    return dir;
  }

  it("finds the repo root from a subdirectory (canonicalized)", async () => {
    const dir = await makeRepo();
    const real = await fs.realpath(dir); // git resolves symlinks (macOS /var)
    expect(await findGitRoot(dir)).toBe(real);
    expect(await findGitRoot(join(dir, "src"))).toBe(real);
  });

  it("reads HEAD, branch, and file list", async () => {
    const dir = await makeRepo();
    expect(await headSha(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(await currentBranch(dir)).toBe("main");
    expect(await listFiles(dir)).toEqual(["src/index.ts"]);
  });

  it("tracks untracked-but-not-ignored files", async () => {
    const dir = await makeRepo();
    await writeFixture(dir, ".gitignore", "ignored.txt\n");
    await writeFixture(dir, "ignored.txt", "x");
    await writeFixture(dir, "new.ts", "x");
    expect(await listFiles(dir)).toEqual([".gitignore", "new.ts", "src/index.ts"]);
  });

  it("reports changed files: modified and untracked", async () => {
    const dir = await makeRepo();
    await writeFixture(dir, "src/index.ts", "export const a = 1;\n");
    await writeFixture(dir, "fresh.ts", "x");
    expect(await changedFiles(dir)).toEqual(["fresh.ts", "src/index.ts"]);
  });

  it("handles rename entries in porcelain output", async () => {
    const dir = await makeRepo();
    gitExec(dir, ["mv", "src/index.ts", "src/main.ts"]);
    expect(await changedFiles(dir)).toEqual(["src/main.ts"]);
  });

  it("lists deduplicated remotes when configured", async () => {
    const dir = await makeRepo();
    expect(await remotes(dir)).toEqual([]);
    gitExec(dir, ["remote", "add", "origin", "git@github.com:acme/repo.git"]);
    expect(await remotes(dir)).toEqual(["git@github.com:acme/repo.git"]);
  });

  it("reads the remote default branch via origin/HEAD", async () => {
    const dir = await makeRepo();
    expect(await defaultBranch(dir)).toBeNull();
    gitExec(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    gitExec(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    expect(await defaultBranch(dir)).toBe("main");
  });

  it("snapshots full git state", async () => {
    const dir = await makeRepo();
    const state = await snapshotGitState(dir);
    expect(state).not.toBeNull();
    expect(state?.branch).toBe("main");
    expect(state?.changedFiles).toEqual([]);
    expect(state?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns null snapshot for an unborn HEAD (no commits)", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    expect(await snapshotGitState(dir)).toBeNull();
  });

  it("labels detached HEAD as (detached)", async () => {
    const dir = await makeRepo();
    const sha = (await headSha(dir)) as string;
    gitExec(dir, ["checkout", sha]);
    const state = await snapshotGitState(dir);
    expect(state?.branch).toBe("(detached)");
  });
});

describe("excludeOkfLocally", () => {
  it("adds .okf/ to .git/info/exclude and is idempotent", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await excludeOkfLocally(dir);
    const content = await fs.readFile(join(dir, ".git", "info", "exclude"), "utf8");
    expect(content).toContain(".okf/");

    await excludeOkfLocally(dir);
    const again = await fs.readFile(join(dir, ".git", "info", "exclude"), "utf8");
    expect(again).toBe(content);
  });

  it("appends after existing content, inserting a newline when needed", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    const excludePath = join(dir, ".git", "info", "exclude");
    await fs.writeFile(excludePath, "*.log", "utf8"); // no trailing newline
    await excludeOkfLocally(dir);
    const content = await fs.readFile(excludePath, "utf8");
    expect(content).toBe("*.log\n.okf/\n");
  });

  it("accepts an existing bare '.okf' line as sufficient", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    const excludePath = join(dir, ".git", "info", "exclude");
    await fs.writeFile(excludePath, ".okf\n", "utf8");
    await excludeOkfLocally(dir);
    expect(await fs.readFile(excludePath, "utf8")).toBe(".okf\n");
  });

  it("resolves the real git dir in linked worktrees (.git is a file)", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "a.ts", "x");
    commitAll(dir, "initial");
    const wt = join(await makeTempDir(), "wt");
    gitExec(dir, ["worktree", "add", wt, "-b", "wt-branch"]);
    expect((await fs.lstat(join(wt, ".git"))).isFile()).toBe(true);

    await excludeOkfLocally(wt);
    // The exclusion lands in the shared git dir of the main worktree —
    // writing under wt/.git (a file) would have failed with ENOTDIR.
    expect(await fs.readFile(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".okf/");
    expect((await fs.lstat(join(wt, ".git"))).isFile()).toBe(true);
  });

  it("is a no-op outside a git repository", async () => {
    const dir = await makeTempDir();
    await excludeOkfLocally(dir);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });
});

describe("hashWorktreeFiles", () => {
  it("sha1-hashes file content; null for missing paths and directories", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "src/index.ts", "export {};\n");
    commitAll(dir, "initial");

    const hashes = await hashWorktreeFiles(dir, ["src/index.ts", "gone.ts", "src"]);
    const expected = createHash("sha1")
      .update(await fs.readFile(join(dir, "src", "index.ts")))
      .digest("hex");
    expect(hashes["src/index.ts"]).toBe(expected);
    expect(hashes["gone.ts"]).toBeNull();
    expect(hashes["src"]).toBeNull();
  });

  it("anchors dirty-file content in the git snapshot", async () => {
    const dir = await makeTempDir();
    gitInit(dir);
    await writeFixture(dir, "src/index.ts", "export {};\n");
    commitAll(dir, "initial");
    await writeFixture(dir, "dirty.ts", "v1");

    const state = await snapshotGitState(dir);
    expect(state?.changedFiles).toEqual(["dirty.ts"]);
    expect(state?.changedHashes["dirty.ts"]).toBe(createHash("sha1").update("v1").digest("hex"));
  });
});
