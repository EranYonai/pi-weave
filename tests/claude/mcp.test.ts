import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { handleMcpMessage, MCP_PROTOCOL_VERSIONS, serveMcp, type McpServerInfo } from "../../src/claude/mcp";

const server: McpServerInfo = {
  name: "test",
  version: "1.2.3",
  instructions: "use the tools",
  tools: [
    { name: "echo", description: "echo", inputSchema: { type: "object" }, call: async (args) => ({ text: String(args.text) }) },
    { name: "fails", description: "fails", inputSchema: { type: "object" }, call: async () => ({ text: "bad input", isError: true }) },
    { name: "throws", description: "throws", inputSchema: { type: "object" }, call: async () => { throw new Error("boom"); } },
    { name: "throwsString", description: "throws", inputSchema: { type: "object" }, call: async () => { throw "raw"; } },
  ],
};

const request = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("MCP message handling", () => {
  it("negotiates the protocol version and announces the tools capability", async () => {
    expect(await handleMcpMessage(server, request("initialize", { protocolVersion: "2025-03-26" }))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "test", version: "1.2.3" },
        instructions: "use the tools",
      },
    });
    const unknown = await handleMcpMessage({ ...server, instructions: "" }, request("initialize", { protocolVersion: "1999-01-01" }, "a"));
    expect(unknown).toMatchObject({ id: "a", result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0] } });
    expect((unknown as { result: object }).result).not.toHaveProperty("instructions");
  });

  it("ignores notifications and rejects malformed requests", async () => {
    expect(await handleMcpMessage(server, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handleMcpMessage(server, { jsonrpc: "1.0", id: 4, method: "ping" })).toEqual({
      jsonrpc: "2.0", id: 4, error: { code: -32600, message: "Invalid request" },
    });
    expect(await handleMcpMessage(server, [1, 2])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await handleMcpMessage(server, request("resources/list"))).toMatchObject({ error: { code: -32601 } });
  });

  it("answers ping and lists tools without their handlers", async () => {
    expect(await handleMcpMessage(server, request("ping"))).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const list = await handleMcpMessage(server, request("tools/list"));
    expect((list as { result: { tools: object[] } }).result.tools[0]).toEqual({ name: "echo", description: "echo", inputSchema: { type: "object" } });
  });

  it("calls tools and turns failures into tool errors", async () => {
    expect(await handleMcpMessage(server, request("tools/call", { name: "echo", arguments: { text: "hi" } }))).toMatchObject({
      result: { content: [{ type: "text", text: "hi" }], isError: false },
    });
    expect(await handleMcpMessage(server, request("tools/call", { name: "echo" }))).toMatchObject({ result: { content: [{ text: "undefined" }] } });
    expect(await handleMcpMessage(server, request("tools/call", { name: "fails" }))).toMatchObject({ result: { isError: true } });
    expect(await handleMcpMessage(server, request("tools/call", { name: "throws" }))).toMatchObject({ result: { content: [{ text: "boom" }], isError: true } });
    expect(await handleMcpMessage(server, request("tools/call", { name: "throwsString" }))).toMatchObject({ result: { content: [{ text: "raw" }] } });
    expect(await handleMcpMessage(server, request("tools/call", { name: "nope" }))).toMatchObject({ error: { code: -32602, message: "Unknown tool: nope" } });
  });
});

describe("serveMcp", () => {
  it("answers newline-delimited JSON-RPC until stdin closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const done = serveMcp(server, input, output);
    input.write(`${JSON.stringify(request("ping", undefined, 7))}\n\n{not json\n`);
    input.end(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await done;
    const lines = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toContainEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(lines).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(lines).toHaveLength(2);
  });
});
