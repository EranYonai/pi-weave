import { describe, expect, it } from "vitest";
import { addNote } from "../../src/core/vault";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import { formatDashboard, formatStatusLine, getWorkspaceStatus } from "../../src/core/workspace";
import { commitAll, gitExec, gitInit, makeTempDir, writeFixture } from "../helpers";

async function makeRepo(): Promise<string> {
  const dir = await makeTempDir();
  gitInit(dir);
  await writeFixture(dir, "src/index.ts", "export {};\n");
  commitAll(dir, "initial");
  return dir;
}

describe("getWorkspaceStatus", () => {
  it("reports vault-only status outside any repository", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const status = await getWorkspaceStatus(cwd, { vaultRoot: vault });
    expect(status.repository).toBeNull();
    expect(status.vault.exists).toBe(false);
    expect(status.vault.noteCount).toBe(0);
    expect(status.vault.root).toBe(vault);
  });

  it("counts vault notes", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    await addNote(vault, { title: "A", body: "x" });
    await addNote(vault, { title: "B", body: "y" });
    const status = await getWorkspaceStatus(cwd, { vaultRoot: vault });
    expect(status.vault.exists).toBe(true);
    expect(status.vault.noteCount).toBe(2);
  });

  it("reports an unindexed repository", async () => {
    const repo = await makeRepo();
    const status = await getWorkspaceStatus(repo, { vaultRoot: await makeTempDir() });
    expect(status.repository?.indexed).toBe(false);
    expect(status.repository?.staleness.state).toBe("missing");
    expect(status.repository?.name).toMatch(/piweave-test-/);
  });

  it("reports an indexed fresh repository, discovering from a subdirectory", async () => {
    const repo = await makeRepo();
    const index = (await buildRepoIndex(repo))!;
    await writeRepoIndex(repo, index);
    const status = await getWorkspaceStatus(`${repo}/src`, { vaultRoot: await makeTempDir() });
    expect(status.repository?.indexed).toBe(true);
    expect(status.repository?.staleness.state).toBe("fresh");
    expect(status.repository?.name).toBe(index.identity.name);
  });

  it("reports staleness once the repo moves", async () => {
    const repo = await makeRepo();
    await writeRepoIndex(repo, (await buildRepoIndex(repo))!);
    gitExec(repo, ["checkout", "-b", "feature"]);
    const status = await getWorkspaceStatus(repo, { vaultRoot: await makeTempDir() });
    expect(status.repository?.staleness.state).toBe("stale");
  });
});

describe("formatStatusLine", () => {
  const vault = { root: "/v", exists: true, noteCount: 3 };

  it("vault only", () => {
    expect(formatStatusLine({ cwd: "/x", vault, repository: null })).toBe("🕸️ vault:3");
  });

  it("unindexed repo", () => {
    const repo = { root: "/r", name: "r", indexed: false, staleness: { state: "missing" as const, reasons: [] }, summaryCount: 0 };
    expect(formatStatusLine({ cwd: "/r", vault, repository: repo })).toBe("🕸️ vault:3 · repo:unindexed");
  });

  it("indexed fresh repo", () => {
    const repo = { root: "/r", name: "r", indexed: true, staleness: { state: "fresh" as const, reasons: [] }, summaryCount: 0 };
    expect(formatStatusLine({ cwd: "/r", vault, repository: repo })).toBe("🕸️ vault:3 · r:ok");
  });

  it("indexed stale repo", () => {
    const repo = { root: "/r", name: "r", indexed: true, staleness: { state: "stale" as const, reasons: [] }, summaryCount: 0 };
    expect(formatStatusLine({ cwd: "/r", vault, repository: repo })).toBe("🕸️ vault:3 · r:stale");
  });
});

describe("formatDashboard", () => {
  it("covers the no-repo case with an uninitialized vault", () => {
    const text = formatDashboard({
      cwd: "/x",
      vault: { root: "/v", exists: false, noteCount: 0 },
      repository: null,
    });
    expect(text).toContain("not initialized");
    expect(text).toContain("not inside a git repository");
  });

  it("covers the unindexed repo case", () => {
    const text = formatDashboard({
      cwd: "/r",
      vault: { root: "/v", exists: true, noteCount: 5 },
      repository: { root: "/r", name: "r", indexed: false, staleness: { state: "missing", reasons: [] }, summaryCount: 0 },
    });
    expect(text).toContain("5 note(s)");
    expect(text).toContain("not indexed");
  });

  it("covers the indexed case with staleness reasons", () => {
    const text = formatDashboard({
      cwd: "/r",
      vault: { root: "/v", exists: true, noteCount: 1 },
      repository: {
        root: "/r",
        name: "r",
        indexed: true,
        staleness: { state: "stale", reasons: ["HEAD moved: a -> b"] },
        summaryCount: 2,
      },
    });
    expect(text).toContain("index: stale");
    expect(text).toContain("summaries: 2 file(s)");
    expect(text).toContain("HEAD moved");
  });
});
