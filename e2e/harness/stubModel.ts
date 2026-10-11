import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted stand-in for an LLM, speaking the OpenAI chat-completions
 * streaming protocol that pi's `openai-completions` provider uses.
 *
 * No API key, no network, fully deterministic. Each request is answered by
 * the first rule whose `match` accepts it; a request that no rule claims gets
 * a plain "stub: ok" text reply so an unscripted turn still ends cleanly.
 *
 * Rules see the parsed request body. The usual shapes:
 *   - the newest message is from the user and contains a marker phrase
 *     → answer with a tool call (`{ tool: { name, args } }`)
 *   - the newest message is a tool result → answer with text to end the turn
 */
export interface StubRequest {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}

export type StubReply = { text: string } | { tool: { name: string; args: Record<string, unknown> } };

export interface StubRule {
  match: (req: StubRequest) => boolean;
  reply: StubReply | ((req: StubRequest) => StubReply);
}

export interface StubModel {
  /** Base URL for models.json, e.g. http://127.0.0.1:1234/v1 */
  baseUrl: string;
  /** Every request body received, oldest first. */
  requests: StubRequest[];
  close: () => Promise<void>;
}

/** Text of the newest message, flattened, or "" when it has none. */
export function lastMessageText(req: StubRequest): string {
  const last = req.messages.at(-1);
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/** The newest message is a tool result (the model already acted this turn). */
export function lastIsToolResult(req: StubRequest): boolean {
  return req.messages.at(-1)?.role === "tool";
}

/**
 * Built-in rules every scenario gets, after its own:
 *   - after any tool result, say "stub: done" so the turn ends
 */
const DEFAULT_RULES: StubRule[] = [{ match: lastIsToolResult, reply: { text: "stub: done" } }];

export async function startStubModel(rules: StubRule[] = []): Promise<StubModel> {
  const all = [...rules, ...DEFAULT_RULES];
  const requests: StubRequest[] = [];
  let callSeq = 0;

  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as StubRequest;
    requests.push(body);
    const rule = all.find((r) => r.match(body));
    const reply = rule ? (typeof rule.reply === "function" ? rule.reply(body) : rule.reply) : { text: "stub: ok" };

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const id = `chatcmpl-stub-${requests.length}`;
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 0,
        model: "stub-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;

    if ("tool" in reply) {
      callSeq += 1;
      res.write(chunk({ role: "assistant", content: null }, null));
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: `call_stub_${callSeq}`,
                type: "function",
                function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
              },
            ],
          },
          null,
        ),
      );
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: reply.text }, null));
      res.write(chunk({}, "stop"));
    }
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 0,
        model: "stub-model",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolveBody(data));
    req.on("error", reject);
  });
}
