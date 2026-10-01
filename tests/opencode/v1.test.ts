import { describe, expect, it, vi } from "vitest";
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin";
import weave from "../../src/opencode";
import weaveTui from "../../src/opencode/tui";
import { v1SessionDigest } from "../../src/opencode/v1";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";

function host(cwd: string) {
  const session = { id: "s1", directory: cwd, title: "V1 memory", time: { created: 1, updated: 2 } };
  const messages = [
    { info: { role: "user", model: { providerID: "test", modelID: "chosen" } }, parts: [{ type: "text", text: "Use local Markdown." }] },
    { info: { role: "assistant", providerID: "test", modelID: "chosen" }, parts: [{ type: "text", text: "Agreed." }] },
  ];
  const notices: string[] = [];
  const client = {
    session: {
      get: vi.fn(async () => ({ data: session })),
      messages: vi.fn(async () => ({ data: messages })),
      create: vi.fn(async (_input: unknown) => ({ data: { id: "child" } })),
      prompt: vi.fn(async (_input: { body: { noReply?: boolean }; signal?: AbortSignal }): Promise<any> => ({ data: { info: {}, parts: [{ type: "text", text: "A durable summary." }] } })),
      abort: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    tui: { showToast: vi.fn(async ({ body }: { body: { message: string } }) => { notices.push(body.message); }) },
  };
  return { input: { client } as unknown as PluginInput, client, messages, session, notices };
}

async function invoke(hooks: Hooks, command: string, args = "") {
  // V1 passes a wrapper to the hook, then sends the original array to the model.
  const parts = [{ type: "text", text: "template" }, { type: "file", url: "unchanged" }];
  await hooks["command.execute.before"]!({ command, sessionID: "s1", arguments: args }, { parts } as never);
  expect(parts[1]).toEqual({ type: "file", url: "unchanged" });
  return parts[0]!.text!;
}

async function fixture() {
  const cwd = await makeTempDir();
  gitInit(cwd);
  await writeFixture(cwd, "file.ts", "export const answer = 42;\n");
  commitAll(cwd);
  return cwd;
}

describe("OpenCode V1 1.18.29", () => {
  it("shares tools and workflows, discovers packaged skills, and cleans up the viewer", async () => {
    const cwd = await fixture();
    const vault = await makeTempDir();
    const mock = host(cwd);
    await withVaultEnv(vault, async () => {
      const hooks = await weave.server(mock.input);
      await weaveTui.tui();
      const config = { command: {}, skills: { paths: ["/existing"] } };
      await hooks.config!(config);
      await hooks.config!(config);
      expect(config.skills.paths).toHaveLength(2);
      expect(config.skills.paths[1]).toMatch(/pi-weave\/skills$/);
      const empty = {};
      await hooks.config!(empty);
      expect(Object.keys((empty as any).command)).toEqual(["weave", "weave-scan", "weave-scan-cancel", "weave-view"]);
      expect(await invoke(hooks, "unrelated")).toBe("template");
      expect(await invoke(hooks, "weave")).toContain("Vault");
      expect(await invoke(hooks, "weave-scan")).toContain("index refreshed");
      expect(await invoke(hooks, "weave-scan-cancel")).toContain("no scan");
      const toolContext = { directory: cwd, metadata: vi.fn() } as never;
      const note = hooks.tool!.weave_note!;
      const schema = tool.schema.object(note.args);
      expect(schema.safeParse({ action: "bad" }).success).toBe(false);
      expect(schema.safeParse({ action: "add", raw: "true" }).success).toBe(false);
      const result = await note.execute(schema.parse({ action: "add", title: "V1", text: "Shared", tags: ["e2e"], source: "agent" }), toolContext);
      expect(result).toMatchObject({ output: expect.stringContaining("Note created"), metadata: { action: "add" } });
      const repo = await hooks.tool!.weave_repo!.execute({ action: "scan" }, toolContext);
      expect(repo).toMatchObject({ output: expect.stringContaining(cwd) });
      const view = await invoke(hooks, "weave-view");
      expect(view).not.toContain("opening when");
      const url = view.match(/http:\/\/\S+/)![0];
      expect((await fetch(url, { redirect: "manual" })).status).toBe(302);
      await hooks.dispose!();
      await expect(fetch(url)).rejects.toThrow();
    });
  });

  it("uses isolated, permission-denied model sessions for deep and current-session scans", async () => {
    const mock = host(await fixture());
    mock.client.session.create.mockImplementation(async () => {
      mock.messages.push({ info: { role: "user", model: { providerID: "other", modelID: "next" } }, parts: [{ type: "text", text: "Changed model during generation" }] });
      return { data: { id: "child" } };
    });
    await withVaultEnv(await makeTempDir(), async () => {
      const hooks = await weave.server(mock.input);
      await invoke(hooks, "weave-scan", "deep");
      await vi.waitFor(() => expect(mock.notices.some((text) => text.includes("deep scan complete"))).toBe(true));
      expect(mock.client.session.create).toHaveBeenCalledWith(expect.objectContaining({ body: {
        parentID: "s1", title: "pi-weave scan", permission: [{ permission: "*", pattern: "*", action: "deny" }],
      } }));
      expect(mock.client.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "child" }, body: expect.objectContaining({ model: { providerID: "test", modelID: "chosen" } }) }));
      expect(mock.client.session.delete).toHaveBeenCalled();
      await invoke(hooks, "weave-scan", "sessions");
      await vi.waitFor(() => expect(mock.notices.some((text) => text.includes("session scan complete"))).toBe(true));
      expect(mock.client.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "s1" }, body: expect.objectContaining({ noReply: true }) }));
      await hooks.dispose!();
    });
  });

  it("cancels only the temporary generation session and deletes it even on provider failure", async () => {
    const mock = host(await fixture());
    let generating = false;
    mock.client.session.prompt.mockImplementation(async (input) => {
      if (input.body.noReply) return { data: {} };
      generating = true;
      return new Promise((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    await withVaultEnv(await makeTempDir(), async () => {
      const hooks = await weave.server(mock.input);
      await invoke(hooks, "weave-scan", "sessions");
      await vi.waitFor(() => expect(generating).toBe(true));
      expect(await invoke(hooks, "weave-scan", "sessions")).toContain("already running");
      await invoke(hooks, "weave-scan-cancel");
      await vi.waitFor(() => expect(mock.notices.some((text) => text.includes("cancelled"))).toBe(true));
      expect(mock.client.session.abort).toHaveBeenCalledWith({ path: { id: "child" }, query: { directory: mock.session.directory }, throwOnError: true });
      expect(mock.client.session.delete).toHaveBeenCalled();
      mock.client.session.prompt.mockImplementation(async (input) => input.body.noReply ? { data: {} } : { data: { info: { error: "provider offline" }, parts: [] } });
      await invoke(hooks, "weave-scan", "sessions");
      await vi.waitFor(() => expect(mock.notices.some((text) => text.includes("provider offline"))).toBe(true));
      expect(mock.client.session.delete).toHaveBeenCalledTimes(2);
      await hooks.dispose!();
    });
  });

  it("reports missing models, preserves command errors, and maps V1 transcript parts", async () => {
    const mock = host(await makeTempDir());
    mock.messages.length = 0;
    const hooks = await weave.server(mock.input);
    expect(await invoke(hooks, "weave-scan", "sessions")).toContain("needs an active session model");
    mock.client.session.get.mockRejectedValueOnce(new Error("session unavailable"));
    await expect(invoke(hooks, "weave")).rejects.toThrow("session unavailable");
    await hooks.dispose!();
    const digest = v1SessionDigest(mock.session, [
      { info: { role: "user" }, parts: [{ type: "text", text: "real" }, { type: "text", text: "hidden", synthetic: true }, { type: "file" }] },
      { info: { role: "assistant", providerID: "p", modelID: "m", error: "error" }, parts: [{ type: "tool", tool: "bash", state: { status: "error" } }] },
    ] as never);
    expect(digest).toMatchObject({ cwd: mock.session.directory, firstUserMessage: "real", tools: { bash: 1 }, errors: 2, models: ["p/m"] });
  });
});
