import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Create an isolated temp directory for a test. */
export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "piweave-test-"));
}

/** Write a file inside a fixture directory, creating parents. */
export async function writeFixture(root: string, relPath: string, content: string): Promise<void> {
  const abs = join(root, relPath);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** Run a git command synchronously inside a fixture repo (setup-only). */
export function gitExec(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** git init with a deterministic default branch. */
export function gitInit(dir: string): void {
  gitExec(dir, ["init", "-b", "main"]);
}

/** Stage everything and commit with a fixed identity. Returns the sha. */
export function commitAll(dir: string, message = "commit"): string {
  gitExec(dir, ["add", "-A"]);
  gitExec(dir, ["-c", "user.name=Weave Test", "-c", "user.email=weave@test.dev", "commit", "--allow-empty", "-m", message]);
  return gitExec(dir, ["rev-parse", "HEAD"]).trim();
}

// ---------------------------------------------------------------------------
// Mock pi harness
// ---------------------------------------------------------------------------

export interface MockCall {
  name: string;
  args: unknown[];
}

export interface MockToolDef {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: MockCtx,
  ) => Promise<MockToolResult>;
}

export interface MockToolResult {
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
}

export interface MockUi {
  notifications: { message: string; level: string }[];
  statuses: Record<string, string | undefined>;
  notify(message: string, level: string): void;
  setStatus(key: string, value: string | undefined): void;
}

export interface MockCtx {
  cwd: string;
  hasUI: boolean;
  mode: string;
  ui: MockUi;
  /** Present only when the session has an active model (deep scans). */
  model?: { provider: string; id: string };
  modelRegistry?: { complete: (model: unknown, context: unknown, options?: unknown) => Promise<unknown> };
}

export interface MockCtxOptions {
  mode?: string;
  model?: { provider: string; id: string };
  /** Stub LLM completion handler; defaults to a no-model context. */
  complete?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;
}

export function createMockCtx(cwd: string, hasUI = true, modeOrOptions: string | MockCtxOptions = "tui"): MockCtx {
  const opts: MockCtxOptions = typeof modeOrOptions === "string" ? { mode: modeOrOptions } : modeOrOptions;
  const notifications: { message: string; level: string }[] = [];
  const statuses: Record<string, string | undefined> = {};
  const ctx: MockCtx = {
    cwd,
    hasUI,
    mode: opts.mode ?? "tui",
    ui: {
      notifications,
      statuses,
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses[key] = value;
      },
    },
  };
  if (opts.model) {
    ctx.model = opts.model;
    ctx.modelRegistry = {
      complete: opts.complete ?? (async () => {
        throw new Error("mock ctx: no complete() stub configured");
      }),
    };
  }
  return ctx;
}

type EventHandler = (event: unknown, ctx: MockCtx) => Promise<unknown>;

/** Minimal stand-in for pi's ExtensionAPI, recording registrations. */
export function createMockPi() {
  const tools = new Map<string, MockToolDef>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: MockCtx) => Promise<void> }>();
  const handlers = new Map<string, EventHandler[]>();

  const pi = {
    registerTool(def: MockToolDef) {
      tools.set(def.name, def);
    },
    registerCommand(
      name: string,
      opts: { description: string; handler: (args: string, ctx: MockCtx) => Promise<void> },
    ) {
      commands.set(name, opts);
    },
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    /** Recorded browser/exec calls (ExtensionAPI.exec). */
    execCalls: [] as MockCall[],
    async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
      pi.execCalls.push({ name: command, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  return {
    /** Cast to the real ExtensionAPI when calling the factory. */
    api: pi,
    tools,
    commands,
    async emit(event: string, payload: unknown, ctx: MockCtx): Promise<void> {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
    /** Convenience: execute a registered tool. */
    async runTool(
      name: string,
      params: Record<string, unknown>,
      ctx: MockCtx,
      onUpdate?: (update: unknown) => void,
    ): Promise<MockToolResult> {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool.execute("test-call", params, undefined, onUpdate, ctx);
    },
  };
}

export type MockPi = ReturnType<typeof createMockPi>;

/** Set PI_WEAVE_VAULT for the duration of a test body, then restore. */
export async function withVaultEnv<T>(vaultRoot: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PI_WEAVE_VAULT;
  process.env.PI_WEAVE_VAULT = vaultRoot;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.PI_WEAVE_VAULT;
    else process.env.PI_WEAVE_VAULT = before;
  }
}
