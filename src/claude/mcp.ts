import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * A minimal Model Context Protocol server over stdio: newline-delimited
 * JSON-RPC 2.0 with the `tools` capability and nothing else.
 *
 * Hand-rolled on purpose. pi-weave keeps runtime dependencies near zero, and
 * the slice Claude Code needs (initialize, tools/list, tools/call, ping) is a
 * few dozen lines; the official SDK would add more code than the adapter.
 */

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  call(args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  instructions?: string;
  tools: readonly McpTool[];
}

/** Newest first; an unknown requested version is answered with the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Id = string | number | null;
type Response = { jsonrpc: "2.0"; id: Id; result: unknown } | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const failure = (id: Id, code: number, message: string): Response => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Answer one parsed message; `null` for a notification, which gets no reply. */
export async function handleMcpMessage(server: McpServerInfo, raw: unknown): Promise<Response | null> {
  const message = record(raw);
  const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return failure(id, -32600, "Invalid request");
  if (!("id" in message)) return null;
  const params = record(message.params);
  const result = (value: unknown): Response => ({ jsonrpc: "2.0", id, result: value });
  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = MCP_PROTOCOL_VERSIONS.find((version) => version === requested) ?? MCP_PROTOCOL_VERSIONS[0];
      return result({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: // alwaysLoad keeps the tools out of Claude Code's deferred tool search: a
      // slash command would otherwise spend a model round trip finding them.
      server.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, _meta: { "anthropic/alwaysLoad": true } })) });
    case "tools/call": {
      const tool = server.tools.find((candidate) => candidate.name === params.name);
      if (!tool) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
      try {
        const output = await tool.call(record(params.arguments));
        return result({ content: [{ type: "text", text: output.text }], isError: output.isError === true });
      } catch (error) {
        // A failed tool is a result the model should read, not a protocol error.
        return result({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${message.method}`);
  }
}

/** Serve until `input` closes. Requests are answered as they finish, not in order. */
export async function serveMcp(server: McpServerInfo, input: Readable, output: Writable): Promise<void> {
  const pending = new Set<Promise<void>>();
  const write = (response: Response | null) => {
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      write(failure(null, -32700, "Parse error"));
      continue;
    }
    const task = handleMcpMessage(server, parsed).then(write);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}
