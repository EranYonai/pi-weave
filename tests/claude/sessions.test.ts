import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProjectDir, findTranscript, parseClaudeTranscript, readClaudeTranscript, transcriptSessionId } from "../../src/claude/sessions";
import { makeTempDir } from "../helpers";

const line = (value: object) => JSON.stringify(value);

const transcript = [
  line({ type: "ai-title", aiTitle: "  Fix retries  ", sessionId: "s1" }),
  line({ type: "user", sessionId: "s1", cwd: "/repo", timestamp: "2026-10-24T10:00:00Z", isMeta: true, message: { role: "user", content: "<local-command-caveat>" } }),
  line({ type: "user", sessionId: "s1", cwd: "/repo", timestamp: "2026-10-24T10:00:01Z", message: { role: "user", content: "  Why do webhooks retry forever?  " } }),
  "{cut off mid-wri",
  line({ type: "assistant", timestamp: "2026-10-24T10:00:02Z", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "" }] } }),
  line({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }),
  line({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t2", name: "Read" }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }, { type: "tool_result", tool_use_id: "t2" }] } }),
  line({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "The cap is missing." }] } }),
  line({ type: "user", message: { content: "<bash-input>npm test</bash-input>" } }),
  line({ type: "user", message: { content: "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>" } }),
  line({ type: "user", message: { content: "<command-message>weave</command-message>\n<command-name>/weave-scan</command-name>\n<command-args>sessions</command-args>" } }),
  line({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
  line({ type: "user", message: { content: "<local-command-stdout>cleared</local-command-stdout>" } }),
  line({ type: "user", message: { content: [{ type: "text", text: "Add a cap" }, { type: "image" }] } }),
  line({ type: "user", message: { content: [] } }),
  line({ type: "user", isCompactSummary: true, message: { content: "Earlier: found the retry loop." } }),
  line({ type: "user", isSidechain: true, message: { content: "subagent prompt" } }),
  line({ type: "assistant", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } }),
  line({ type: "custom-title", customTitle: "Webhook retry cap" }),
  line({ type: "attachment", attachment: {} }),
  line({ type: "user", timestamp: "2026-10-24T10:05:00Z", message: "not an object" }),
  "",
].join("\n");

describe("Claude Code transcripts", () => {
  it("finds the project folder the way Claude Code names it", () => {
    expect(claudeProjectDir("/Users/eran/my.repo", "/home/x")).toBe("/home/x/.claude/projects/-Users-eran-my-repo");
    expect(transcriptSessionId("/a/b/abc-123.jsonl")).toBe("abc-123");
  });

  it("maps a transcript onto the shared digest", () => {
    const { digest, hash } = parseClaudeTranscript(transcript);
    expect(digest).toMatchObject({
      id: "s1",
      cwd: "/repo",
      parentSession: null,
      name: "Webhook retry cap",
      startedAt: "2026-10-24T10:00:00Z",
      endedAt: "2026-10-24T10:05:00Z",
      userMessages: ["Why do webhooks retry forever?", "/weave-scan sessions", "/clear", "Add a cap"],
      firstUserMessage: "Why do webhooks retry forever?",
      bashCount: 1,
      assistantCount: 2,
      toolResultCount: 2,
      tools: { Bash: 1, Read: 1 },
      errors: 2,
      models: ["anthropic/claude-opus-5-5"],
      compactions: ["Earlier: found the retry loop."],
      lastAssistantText: "API Error",
    });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(parseClaudeTranscript(transcript).hash).toBe(hash);
    expect(parseClaudeTranscript(`${transcript}\n${line({ type: "user", message: { content: "more" } })}`).hash).not.toBe(hash);
  });

  it("falls back to the file name and the AI title", () => {
    const { digest } = parseClaudeTranscript(line({ type: "ai-title", aiTitle: "Only a title" }), "from-file");
    expect(digest).toMatchObject({ id: "from-file", cwd: "", startedAt: "", endedAt: "", name: "Only a title", userCount: 0 });
  });

  it("picks the named session's transcript, else the project's newest", async () => {
    const home = await makeTempDir();
    expect(await findTranscript("/repo", "s1", home)).toBeNull();
    const dir = claudeProjectDir("/repo", home);
    await mkdir(join(dir, "folder.jsonl"), { recursive: true });
    await writeFile(join(dir, "notes.txt"), "");
    await writeFile(join(dir, "old.jsonl"), "");
    await writeFile(join(dir, "new.jsonl"), transcript);
    await utimes(join(dir, "old.jsonl"), new Date(1_000), new Date(1_000));
    expect(await findTranscript("/repo", undefined, home)).toBe(join(dir, "new.jsonl"));
    expect(await findTranscript("/repo", "old", home)).toBe(join(dir, "old.jsonl"));
    expect(await findTranscript("/repo", "missing", home)).toBe(join(dir, "new.jsonl"));
    expect((await readClaudeTranscript(join(dir, "old.jsonl"))).digest.id).toBe("old");
  });
});
