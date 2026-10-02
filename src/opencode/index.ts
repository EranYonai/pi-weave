import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatStatusLine, getWorkspaceStatus } from "../core";
import { parseFrontMatter, unquoteField } from "../core/frontmatter";
import { registerOpenCodeCommands } from "./commands";
import { weaveTools } from "./tools";
import { WEAVE_RPC } from "./rpc";
import { WorkspaceServerController } from "../web/server/controller";

async function packagedSkill(relativePath: string): Promise<import("@opencode/plugin").Skill.Info> {
  const path = fileURLToPath(new URL(`../../skills/${relativePath}/SKILL.md`, import.meta.url));
  const content = await readFile(path, "utf8");
  const parsed = parseFrontMatter(content);
  const name = parsed?.fields.get("name");
  if (!parsed || !name) throw new Error(`Invalid packaged skill: ${relativePath}`);
  return {
    id: name,
    name,
    description: unquoteField(parsed.fields.get("description") ?? ""),
    path,
    content: parsed.body,
  } as import("@opencode/plugin").Skill.Info;
}

const weave = {
  id: "pi-weave",
  server: async (input: import("@opencode-ai/plugin").PluginInput) => (await import("./v1")).server(input),
  async setup(context) {
    const toolRegistration = await context.tool.transform((editor) => {
      for (const tool of weaveTools) editor.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        options: { codemode: false },
        async execute(input, toolContext) {
          const session = await context.session.get({ sessionID: toolContext.sessionID });
          const result = await tool.execute(input, session.location.directory, (status) => toolContext.progress({ status }));
          await refreshStatus(toolContext.sessionID);
          return { content: result.text, metadata: result.details };
        },
      });
    });

    const skills = await Promise.all([packagedSkill("weave-notepad"), packagedSkill("weave-explore")]);
    const skillRegistration = await context.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill);
    });
    const viewer = new WorkspaceServerController();
    let status: { text: string; active: boolean; sessionID?: string; viewerUrl?: string } = {
      text: formatStatusLine(await getWorkspaceStatus(context.location.directory)),
      active: false,
    };
    const rpc = await context.rpc.register(WEAVE_RPC, {
      status: async () => status,
    });
    const publishStatus = (next: Partial<typeof status>) => {
      status = { ...status, ...next };
      void rpc.events.emit("status", status).catch(() => {});
    };
    const refreshStatus = async (sessionID: Parameters<typeof context.session.get>[0]["sessionID"]) => {
      const session = await context.session.get({ sessionID });
      const text = formatStatusLine(await getWorkspaceStatus(session.location.directory));
      if (!status.active) publishStatus({ sessionID, text, active: false });
    };
    const commands = await registerOpenCodeCommands(
      context,
      (next) => {
        publishStatus(next);
        if (!next.active) void refreshStatus(next.sessionID as Parameters<typeof context.session.get>[0]["sessionID"]).catch(() => {});
      },
      viewer,
      (event) => {
        status = { ...status, viewerUrl: event.url };
        void rpc.events.emit("viewer", event).catch(() => {});
        void rpc.events.emit("status", status).catch(() => {});
      },
    );
    return async () => {
      await commands.cleanup();
      await viewer.close();
      await rpc.dispose();
      await skillRegistration.dispose();
      await toolRegistration.dispose();
    };
  },
} satisfies import("@opencode/plugin").Plugin.Plugin & Pick<import("@opencode-ai/plugin").PluginModule, "server">;

export default weave;
