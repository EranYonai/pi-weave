import { describe, expect, it } from "vitest";
import { addNote } from "../../src/core/vault";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import { formatDashboard, formatStatusLine, getWorkspaceStatus } from "../../src/core/workspace";
import { writeSummary } from "../../src/core/summaries";
import { commitAll, gitInit, makeTempDir, writeFixture } from "../helpers";

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

  it("names a repository without an index after its folder and counts no summaries", async () => {
    const repo = await makeRepo();
    const status = await getWorkspaceStatus(repo, { vaultRoot: await makeTempDir() });
    expect(status.repository?.name).toMatch(/piweave-test-/);
    expect(status.repository?.summaryCount).toBe(0);
  });

  it("uses the indexed name and counts summaries, discovering from a subdirectory", async () => {
    const repo = await makeRepo();
    const index = (await buildRepoIndex(repo))!;
    await writeRepoIndex(repo, index);
    await writeSummary(repo, {
      target: "src/index.ts",
      source: "generated",
      contentHash: "abc",
      model: "fake/model",
      at: "2026-10-11T00:00:00.000Z",
      summary: "Entry point.",
    });
    const status = await getWorkspaceStatus(`${repo}/src`, { vaultRoot: await makeTempDir() });
    expect(status.repository?.name).toBe(index.identity.name);
    expect(status.repository?.summaryCount).toBe(1);
  });
});

describe("formatStatusLine", () => {
  const vault = { root: "/v", exists: true, noteCount: 3 };

  it("counts notes outside a repository", () => {
    expect(formatStatusLine({ cwd: "/x", vault, repository: null })).toBe("🕸️ 3 notes");
  });

  it("uses the singular for one note", () => {
    expect(formatStatusLine({ cwd: "/x", vault: { ...vault, noteCount: 1 }, repository: null })).toBe("🕸️ 1 note");
  });

  it("says nothing about a repository without summaries", () => {
    const repo = { root: "/r", name: "r", summaryCount: 0 };
    expect(formatStatusLine({ cwd: "/r", vault, repository: repo })).toBe("🕸️ 3 notes");
  });

  it("adds the summary count once a deep scan has written some", () => {
    const repo = { root: "/r", name: "r", summaryCount: 40 };
    expect(formatStatusLine({ cwd: "/r", vault, repository: repo })).toBe("🕸️ 3 notes · 40 summaries");
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
    expect(text).not.toContain("Repository");
  });

  it("points a repository without summaries at /weave-scan", () => {
    const text = formatDashboard({
      cwd: "/r",
      vault: { root: "/v", exists: true, noteCount: 5 },
      repository: { root: "/r", name: "r", summaryCount: 0 },
    });
    expect(text).toContain("5 note(s)");
    expect(text).toContain("no file summaries yet — run /weave-scan");
    expect(text).not.toMatch(/index|stale/);
  });

  it("counts summaries when present", () => {
    const text = formatDashboard({
      cwd: "/r",
      vault: { root: "/v", exists: true, noteCount: 1 },
      repository: { root: "/r", name: "r", summaryCount: 2 },
    });
    expect(text).toContain("summaries: 2 file(s) — run /weave-scan to refresh");
  });
});
