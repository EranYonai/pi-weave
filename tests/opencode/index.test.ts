import { describe, expect, it } from "vitest";
import weave from "../../src/opencode";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";

interface RegisteredTool {
  name: string;
  execute(input: unknown, context: { progress(update: Record<string, unknown>): Promise<void> }): Promise<{
    content?: string;
    metadata?: Record<string, unknown>;
  }>;
}

describe("OpenCode plugin", () => {
  it("registers shared tools and packaged skills", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    gitInit(cwd);
    await writeFixture(cwd, "README.md", "# fixture\n");
    commitAll(cwd);

    const tools = new Map<string, RegisteredTool>();
    const skills = new Map<string, { id: string; path: string; content: string }>();
    const commands = new Map<string, unknown>();
    const registration = { dispose: async () => {} };
    const context = {
      location: { directory: cwd },
      tool: {
        transform(transform: (editor: { add(tool: RegisteredTool): void }) => void) {
          transform({ add: (tool) => tools.set(tool.name, tool) });
          return registration;
        },
      },
      skill: {
        transform(transform: (editor: { add(skill: { id: string; path: string; content: string }): void }) => void) {
          transform({ add: (skill) => skills.set(skill.id, skill) });
          return registration;
        },
      },
      command: {
        transform(transform: (editor: { add(command: { name: string }): void }) => void) {
          transform({ add: (command) => commands.set(command.name, command) });
          return registration;
        },
      },
      rpc: {
        async register() {
          return { dispose: async () => {}, events: { emit: async () => {} } };
        },
      },
      session: {},
    };

    await withVaultEnv(vault, async () => {
      const cleanup = await weave.setup(context as never);

      expect([...tools.keys()].sort()).toEqual(["weave_note", "weave_repo"]);
      expect([...skills.keys()].sort()).toEqual(["weave-explore", "weave-notepad"]);
      expect([...commands.keys()].sort()).toEqual(["weave", "weave-scan", "weave-scan-cancel", "weave-view"]);
      expect(skills.get("weave-notepad")?.path).toMatch(/skills\/weave-notepad\/SKILL\.md$/);
      expect(skills.get("weave-notepad")?.content).toContain("# Weave Notepad");

      const toolContext = { progress: async () => {} };
      const added = await tools.get("weave_note")!.execute(
        { action: "add", title: "OpenCode", text: "Shared core." },
        toolContext,
      );
      expect(added.content).toContain("Note created: opencode");
      expect(added.metadata?.action).toBe("add");

      const repo = await tools.get("weave_repo")!.execute({ action: "status" }, toolContext);
      expect(repo.content).toMatch(/^Repository .*piweave-test-/);
      expect(repo.metadata?.inRepo).toBe(true);
      await cleanup?.();
    });
  });
});
