import { describe, expect, it } from "vitest";
import { getNote, runSessionDigestScan, type SessionDigest } from "../../src/core";
import { makeTempDir } from "../helpers";

function digest(userCount = 1): SessionDigest {
  return {
    id: "session-1",
    cwd: "/project",
    parentSession: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    name: "Digest scan",
    models: ["test/model"],
    userCount,
    assistantCount: 1,
    toolResultCount: 0,
    errors: 0,
    bashCount: 0,
    tools: {},
    firstUserMessage: userCount ? "Do the work" : null,
    userMessages: userCount ? ["Do the work"] : [],
    compactions: [],
    branchSummaries: [],
    lastAssistantText: userCount ? "Done" : null,
  };
}

describe("runSessionDigestScan", () => {
  it("skips empty and hash-fresh public sessions", async () => {
    const vault = await makeTempDir();
    const empty = await runSessionDigestScan({
      vaultRoot: vault,
      digest: digest(0),
      content: "empty",
      source: "opencode:session:session-1",
      hash: "empty",
      summarize: async () => "unused",
    });
    expect(empty.skippedEmpty).toBe(1);

    const first = await runSessionDigestScan({
      vaultRoot: vault,
      digest: digest(),
      content: "content",
      source: "opencode:session:session-1",
      hash: "same",
      summarize: async () => "Summary",
      model: "test/model",
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(first.created).toBe(1);
    const fresh = await runSessionDigestScan({
      vaultRoot: vault,
      digest: digest(),
      content: "content",
      source: "opencode:session:session-1",
      hash: "same",
      summarize: async () => "unused",
    });
    expect(fresh.skippedFresh).toBe(1);

    const updated = await runSessionDigestScan({
      vaultRoot: vault,
      digest: digest(),
      content: "changed",
      source: "opencode:session:session-1",
      hash: "changed",
      summarize: async () => "Updated",
    });
    expect(updated.updated).toBe(1);
    expect((await getNote(vault, "sessions/digest-scan"))?.body).toContain("Updated");
  });

  it("records empty and thrown summarizer failures", async () => {
    const vault = await makeTempDir();
    const base = {
      vaultRoot: vault,
      digest: digest(),
      content: "content",
      source: "opencode:session:session-1",
      hash: "hash",
    };
    const empty = await runSessionDigestScan({ ...base, summarize: async () => "  " });
    expect(empty.failed[0]?.error).toContain("empty summary");
    const thrown = await runSessionDigestScan({ ...base, summarize: async () => { throw "nope"; } });
    expect(thrown.failed[0]?.error).toBe("nope");
  });
});
