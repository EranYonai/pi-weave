import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendToNote, getNote } from "../../src/core";
import {
  openCodeSessionDigest,
  registerOpenCodeCommands,
  type OpenCodeScanStatus,
} from "../../src/opencode/commands";
import { WorkspaceServerController } from "../../src/web/server/controller";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";

interface Command {
  execute(input: { sessionID: string; prompt: { text: string }; delivery: "queue" }): Promise<void>;
}

function mockContext(cwd: string) {
  const commands = new Map<string, Command>();
  const output: string[] = [];
  const generated: string[] = [];
  const messages: Record<string, unknown>[] = [
    { type: "user", text: "Build the adapter", time: { created: 1 } },
    {
      type: "assistant",
      model: { providerID: "test", id: "model" },
      finish: "stop",
      time: { created: 2 },
      content: [
        { type: "text", text: "Implemented it." },
        { type: "tool", name: "edit", state: { status: "completed" } },
      ],
    },
  ];
  const session = {
    id: "session-1",
    title: "OpenCode adapter",
    parentID: "parent-1",
    location: { directory: cwd },
    model: { providerID: "test", id: "model" } as { providerID: string; id: string } | undefined,
    time: { created: 1, updated: 2 },
  };
  const registration = { dispose: async () => {} };
  const context = {
    location: { directory: cwd },
    command: {
      async transform(transform: (editor: { add(command: Command & { name: string }): void }) => void) {
        transform({ add: (command) => commands.set(command.name, command) });
        return registration;
      },
    },
    session: {
      async get() { return session; },
      async context(_input?: unknown, _options?: { signal?: AbortSignal }) { return messages; },
      async synthetic(input: { text: string }) { output.push(input.text); },
      async generate(input: { prompt: string }, _options?: { signal?: AbortSignal }) {
        generated.push(input.prompt);
        return { text: `Summary ${generated.length}` };
      },
    },
  };
  return { context, commands, generated, messages, output, session };
}

function invoke(command: Command, text = ""): Promise<void> {
  return command.execute({ sessionID: "session-1", prompt: { text }, delivery: "queue" });
}

describe("OpenCode commands", () => {
  it("maps public session context to the portable digest", () => {
    const digest = openCodeSessionDigest(
      {
        id: "s1",
        title: "A session",
        parentID: "p1",
        location: { directory: "/repo" },
        time: { created: 1, updated: 4 },
      },
      [
        { type: "synthetic", text: "ignored" },
        { type: "user", text: " hello " },
        { type: "shell" },
        { type: "compaction", summary: "compact" },
        {
          type: "assistant",
          model: { providerID: "p", id: "m" },
          finish: "error",
          content: [
            { type: "text", text: "answer" },
            { type: "tool", name: "bash", state: { status: "error" } },
          ],
        },
      ],
    );
    expect(digest).toMatchObject({
      id: "s1",
      cwd: "/repo",
      parentSession: "p1",
      name: "A session",
      userCount: 1,
      assistantCount: 1,
      toolResultCount: 1,
      bashCount: 1,
      errors: 2,
      models: ["p/m"],
      tools: { bash: 1 },
      firstUserMessage: "hello",
      lastAssistantText: "answer",
      compactions: ["compact"],
    });
  });

  it("tolerates sparse and long public session records", () => {
    const messages: Record<string, unknown>[] = Array.from({ length: 61 }, (_, index) => ({
      type: "user",
      text: index === 0 ? "x".repeat(500) : index === 1 ? 42 : `message ${index}`,
    }));
    messages.push(
      ...Array.from({ length: 4 }, (_, index) => ({ type: "compaction", summary: index === 0 ? null : `summary ${index}` })),
      { type: "assistant", model: {}, content: "not-an-array" },
      { type: "assistant", model: { providerID: "p", id: "m" }, content: [{ type: "tool", state: {} }] },
      { type: "assistant", model: { providerID: "p", id: "m" }, content: [] },
    );
    const result = openCodeSessionDigest(null, messages);
    expect(result.id).toBe("");
    expect(result.startedAt).toBe("");
    expect(result.userMessages).toHaveLength(60);
    expect(result.compactions).toEqual(["summary 1", "summary 2", "summary 3"]);
    expect(result.models).toEqual(["p/m"]);
    expect(result.tools.unknown).toBe(1);
  });

  it("runs dashboard, shallow/deep, and current-session scans", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    gitInit(cwd);
    await writeFixture(cwd, "src.ts", "export const answer = 42;\n");
    commitAll(cwd);
    const mock = mockContext(cwd);
    const statuses: OpenCodeScanStatus[] = [];
    const viewer = new WorkspaceServerController({ vaultRoot: () => vault });
    const viewerEvents: { url: string; open: boolean; started: boolean }[] = [];

    await withVaultEnv(vault, async () => {
      const registered = await registerOpenCodeCommands(
        mock.context as never,
        (status) => statuses.push(status),
        viewer,
        (event) => viewerEvents.push(event),
      );
      await invoke(mock.commands.get("weave")!);
      expect(mock.output.at(-1)).toContain("Vault");

      await invoke(mock.commands.get("weave-scan")!);
      expect(mock.output.at(-1)).toContain("index refreshed");

      await invoke(mock.commands.get("weave-scan")!, "deep");
      await registered.done("session-1");
      expect(mock.output.at(-1)).toContain("deep scan complete");
      expect(mock.generated.some((prompt) => prompt.includes("source files for a codebase index"))).toBe(true);

      await invoke(mock.commands.get("weave-scan")!, "sessions");
      await registered.done("session-1");
      expect(mock.output.at(-1)).toContain("session scan complete");
      expect(mock.generated.some((prompt) => prompt.includes("durable memory notes"))).toBe(true);

      const note = await getNote(vault, "sessions/opencode-adapter");
      expect(note?.source).toBe("generated");
      expect(note?.body).toContain("Summary");
      expect(note?.body).toContain("opencode:session:session-1");

      await appendToNote(vault, "sessions/opencode-adapter", "human tail", new Date(10), { raw: true });
      mock.messages.push({ type: "user", text: "One more change", time: { created: 3 } });
      await invoke(mock.commands.get("weave-scan")!, "sessions");
      await registered.done("session-1");
      expect((await getNote(vault, "sessions/opencode-adapter"))?.body).toContain("human tail");
      expect(statuses.some((status) => status.active)).toBe(true);

      await invoke(mock.commands.get("weave-scan-cancel")!);
      expect(mock.output.at(-1)).toContain("no scan");

      await invoke(mock.commands.get("weave-view")!, "bad");
      expect(mock.output.at(-1)).toContain("usage:");
      await invoke(mock.commands.get("weave-view")!, "--no-open");
      expect(viewerEvents.at(-1)).toMatchObject({ open: false, started: true });
      await invoke(mock.commands.get("weave-view")!);
      expect(viewerEvents.at(-1)).toMatchObject({ open: true, started: false });
      const firstUrl = viewerEvents.at(-1)!.url;
      mock.session.location.directory = await makeTempDir();
      await invoke(mock.commands.get("weave-view")!, "--no-open");
      expect(viewerEvents.at(-1)).toMatchObject({ open: false, started: true });
      expect(viewerEvents.at(-1)!.url).not.toBe(firstUrl);
      await registered.cleanup();
      await viewer.close();
    });
  });

  it("scans an explicit exported-session path and cancels active work", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const exported = join(cwd, "session.json");
    await fs.writeFile(exported, "exported OpenCode session", "utf8");
    const mock = mockContext(cwd);

    await withVaultEnv(vault, async () => {
      const registered = await registerOpenCodeCommands(mock.context as never);
      await invoke(mock.commands.get("weave-scan")!, `sessions ${exported}`);
      await registered.done("session-1");
      expect(mock.output.at(-1)).toContain("1 summarized");

      await fs.appendFile(exported, " changed", "utf8");
      mock.context.session.generate = async (_input: { prompt: string }, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason)));
      await invoke(mock.commands.get("weave-scan")!, `sessions ${exported}`);
      await invoke(mock.commands.get("weave-scan")!, `sessions ${exported}`);
      expect(mock.output.at(-1)).toContain("already running");
      await invoke(mock.commands.get("weave-scan-cancel")!);
      expect(mock.output.at(-1)).toContain("cancellation requested");
      await registered.done("session-1");
      expect(mock.output.at(-1)).toContain("cancelled");
      await registered.cleanup();
    });
  });

  it("reports missing repositories and models", async () => {
    const cwd = await makeTempDir();
    const mock = mockContext(cwd);
    const registered = await registerOpenCodeCommands(mock.context as never);
    await invoke(mock.commands.get("weave-scan")!);
    expect(mock.output.at(-1)).toContain("not inside a git repository");

    gitInit(cwd);
    await invoke(mock.commands.get("weave-scan")!);
    expect(mock.output.at(-1)).toContain("no commits");

    await writeFixture(cwd, "file.ts", "x\n");
    commitAll(cwd);
    mock.session.model = undefined;
    await invoke(mock.commands.get("weave-scan")!, "deep");
    expect(mock.output.at(-1)).toContain("needs an active session model");
    await invoke(mock.commands.get("weave-scan")!, "sessions");
    expect(mock.output.at(-1)).toContain("needs an active session model");

    mock.session.model = { providerID: "test", id: "model" };
    mock.context.session.context = async () => { throw new Error("public context unavailable"); };
    await invoke(mock.commands.get("weave-scan")!, "sessions");
    await registered.done("session-1");
    expect(mock.output.at(-1)).toContain("scan failed — public context unavailable");

    mock.context.session.context = async () => { throw "context offline"; };
    await invoke(mock.commands.get("weave-scan")!, "sessions");
    await registered.done("session-1");
    expect(mock.output.at(-1)).toContain("scan failed — context offline");

    mock.context.session.context = async (_input?: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await invoke(mock.commands.get("weave-scan")!, "sessions");
    await invoke(mock.commands.get("weave-scan-cancel")!);
    await registered.done("session-1");
    expect(mock.output.at(-1)).toContain("cancelled");
    await registered.cleanup();
  });

  it("scans with an active model even when its provenance label is unavailable", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const mock = mockContext(cwd);
    mock.session.model = { providerID: 1, id: "model" } as never;
    await withVaultEnv(vault, async () => {
      const registered = await registerOpenCodeCommands(mock.context as never);
      await invoke(mock.commands.get("weave-scan")!, "sessions");
      await registered.done("session-1");
      expect(mock.output.at(-1)).toContain("session scan complete");
      await registered.cleanup();
    });
  });
  it("does not save a late model response after cancellation", async () => {
    const mock = mockContext(await makeTempDir());
    const vault = await makeTempDir();
    let resolveModel: ((value: { text: string }) => void) | undefined;
    mock.context.session.generate = async () => new Promise((resolve) => { resolveModel = resolve; });
    await withVaultEnv(vault, async () => {
      const registered = await registerOpenCodeCommands(mock.context as never);
      await invoke(mock.commands.get("weave-scan")!, "sessions");
      await vi.waitFor(() => expect(resolveModel).toBeDefined());
      await invoke(mock.commands.get("weave-scan-cancel")!);
      resolveModel!({ text: "Late summary" });
      await registered.done("session-1");
      expect(mock.output.at(-1)).toContain("cancelled");
      expect(await getNote(vault, "sessions/opencode-adapter")).toBeNull();
      await registered.cleanup();
    });
  });

});
