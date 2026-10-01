import { fileURLToPath } from "node:url";
import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";
import type { SessionMessagesResponse } from "@opencode-ai/sdk";
import { hashContent } from "../core";
import { createWorkspaceCommands } from "../core/workspaceCommands";
import { WorkspaceServerController } from "../web/server/controller";
import { openCodeSessionDigest } from "./commands";
import { weaveTools } from "./tools";

type Client = Parameters<Plugin>[0]["client"];

// ponytail: only our flat tool schemas; use a converter if nested inputs are added.
function legacyArgs(input: (typeof weaveTools)[number]["input"]) {
  return Object.fromEntries(Object.entries(input.properties).map(([name, definition]) => {
    const schema = "enum" in definition ? z.enum(definition.enum)
      : definition.type === "array" ? z.array(z.string())
      : definition.type === "boolean" ? z.boolean()
      : definition.type === "number" ? z.number()
      : z.string();
    const described = "description" in definition ? schema.describe(definition.description) : schema;
    return [name, (input.required as readonly string[]).includes(name) ? described : described.optional()];
  }));
}

function modelOf(messages: SessionMessagesResponse) {
  for (const { info, parts } of [...messages].reverse()) {
    if (info.role === "user" && !parts.some((part) => part.type === "text" && part.metadata?.["pi-weave"])) return info.model;
  }
  return null;
}

export function v1SessionDigest(session: { id: string; directory: string }, messages: SessionMessagesResponse) {
  return openCodeSessionDigest({ ...session, location: { directory: session.directory } }, messages.map(({ info, parts }) => {
    const text = parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.type === "text" ? part.text : "").join("\n");
    if (info.role === "user") return { type: "user", text };
    return {
      type: "assistant",
      model: { providerID: info.providerID, id: info.modelID },
      error: info.error,
      content: parts.map((part) => part.type === "tool" ? { ...part, name: part.tool } : part),
    };
  }));
}

async function generate(client: Client, sessionID: string, prompt: string, signal: AbortSignal, selectedModel: string) {
  const separator = selectedModel.indexOf("/");
  const model = { providerID: selectedModel.slice(0, separator), modelID: selectedModel.slice(separator + 1) };
  const { data: session } = await client.session.get({ path: { id: sessionID }, signal, throwOnError: true });
  // The V1 SDK's legacy types omit permission, but 1.18.29's session API accepts it.
  const body = { parentID: sessionID, title: "pi-weave scan", permission: [{ permission: "*", pattern: "*", action: "deny" }] };
  const query = { directory: session.directory };
  const { data: child } = await client.session.create({ body, query, throwOnError: true });
  const path = { id: child.id };
  let aborting: Promise<unknown> | undefined;
  const abort = () => { aborting = client.session.abort({ path, query, throwOnError: true }).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const { data } = await client.session.prompt({
      path, query,
      body: { model, parts: [{ type: "text", text: prompt }] },
      signal,
      throwOnError: true,
    });
    if (data.info.error) throw new Error(JSON.stringify(data.info.error));
    return data.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  } finally {
    signal.removeEventListener("abort", abort);
    await aborting;
    await client.session.delete({ path, query, throwOnError: true });
  }
}

export const server: Plugin = async ({ client }) => {
  const viewer = new WorkspaceServerController();
  const collected = new Map<string, string[]>();
  const toast = (message: string, variant: "info" | "success" | "error" = "info") =>
    client.tui.showToast({ body: { title: "pi-weave", message, variant } }).catch(() => {});
  let lastProgress = 0;
  const shared = createWorkspaceCommands({
    async getSession(sessionID) {
      const { data: session } = await client.session.get({ path: { id: sessionID }, throwOnError: true });
      const { data: messages } = await client.session.messages({ path: { id: sessionID }, throwOnError: true });
      const model = modelOf(messages);
      return { id: session.id, cwd: session.directory, model: model ? `${model.providerID}/${model.modelID}` : null };
    },
    async getDigest(sessionID, signal) {
      const { data: session } = await client.session.get({ path: { id: sessionID }, signal, throwOnError: true });
      const { data: messages } = await client.session.messages({ path: { id: sessionID }, signal, throwOnError: true });
      const relevant = messages.filter(({ parts }) => !parts.some((part) => part.type === "text" && part.metadata?.["pi-weave"]));
      return { digest: v1SessionDigest(session, relevant), hash: hashContent(JSON.stringify(relevant)) };
    },
    sessionSource: (id) => `opencode:session:${id}`,
    generate: (id, prompt, signal, model) => generate(client, id, prompt, signal, model),
    async output(sessionID, text) {
      const output = collected.get(sessionID);
      if (output) { output.push(text); return; }
      await client.session.prompt({
        path: { id: sessionID },
        body: { noReply: true, parts: [{ type: "text", text, synthetic: true, metadata: { "pi-weave": true } }] },
        throwOnError: true,
      });
    },
  }, (status) => {
    if (status.active && Date.now() - lastProgress < 2_000) return;
    lastProgress = Date.now();
    void toast(status.text, status.active ? "info" : status.text.includes("failed") ? "error" : "success");
  }, viewer);

  return {
    tool: Object.fromEntries(weaveTools.map((definition) => [definition.name, {
      description: definition.description,
      args: legacyArgs(definition.input),
      async execute(input, context) {
        const result = await definition.execute(input, context.directory, async (title) => context.metadata({ title }));
        return { output: result.text, metadata: result.details };
      },
    } satisfies ToolDefinition])),
    async config(config) {
      // V1's public runtime supports skills.paths; its legacy SDK Config omits it.
      const extended = config as typeof config & { skills?: { paths?: string[] } };
      extended.skills ??= {};
      extended.skills.paths = [...new Set([...(extended.skills.paths ?? []), fileURLToPath(new URL("../../skills", import.meta.url))])];
      config.command ??= {};
      for (const command of shared.commands) config.command[command.name] = {
        description: command.description,
        template: "Report the pi-weave command result below. Do not run additional tools. $ARGUMENTS",
      };
    },
    async "command.execute.before"(input, output) {
      const command = shared.commands.find((command) => command.name === input.command);
      if (!command) return;
      const lines: string[] = [];
      collected.set(input.sessionID, lines);
      try {
        // V1 cannot suppress the normal model reply after this hook.
        await command.execute(input.sessionID, input.arguments);
        // V1 retains the original parts array after this hook; mutate it in place.
        for (const part of output.parts) {
          if (part.type !== "text") continue;
          part.text = `Report this pi-weave result without running tools:\n${lines.join("\n") || "Scan started; completion will be reported separately."}`;
          part.synthetic = true;
          part.metadata = { "pi-weave": true };
        }
      } finally {
        collected.delete(input.sessionID);
      }
    },
    async dispose() {
      await shared.cleanup();
      await viewer.close();
    },
  };
};
