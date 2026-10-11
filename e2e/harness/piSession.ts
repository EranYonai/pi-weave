import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isolatedEnv, type Sandbox } from "./sandbox";

/** The checkout under test: the e2e run always loads *this* branch's extension. */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PI_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "pi");
const EXTENSION = resolve(REPO_ROOT, "src", "pi", "index.ts");

export interface WaitOptions {
  timeoutMs?: number;
  /** What we were waiting for, for the failure message. */
  label?: string;
}

/**
 * Real interactive pi, running in a detached tmux session with pi-weave
 * loaded from this checkout, driven by keystrokes and read back as rendered
 * screen text. tmux does the terminal emulation, so what `screen()` returns
 * is what a person would see.
 *
 * Each session uses its own tmux socket, so it never touches the developer's
 * own tmux server.
 */
export class PiSession {
  private readonly socket = `pi-weave-e2e-${process.pid}-${Date.now()}`;
  private readonly target = "pi";

  constructor(private readonly sandbox: Sandbox) {}

  start(opts: { cols?: number; rows?: number; extraArgs?: string[] } = {}): void {
    const env = isolatedEnv(this.sandbox.home, {
      PI_CODING_AGENT_DIR: this.sandbox.agentDir,
      PI_WEAVE_VAULT: this.sandbox.vault,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
    const piArgs = [
      "--provider",
      "stub",
      "--model",
      "stub-model",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "-e",
      EXTENSION,
      ...(opts.extraArgs ?? []),
    ];
    const command = ["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), PI_BIN, ...piArgs]
      .map(shellQuote)
      .join(" ");
    this.tmux(
      "new-session",
      "-d",
      "-s",
      this.target,
      "-x",
      String(opts.cols ?? 160),
      "-y",
      String(opts.rows ?? 48),
      "-c",
      this.sandbox.repo,
      command,
    );
    // Keep the pane after pi exits so a crash's last screen can be read.
    this.tmux("set-option", "-t", this.target, "remain-on-exit", "on");
  }

  /** The rendered screen plus scrollback, one terminal row per line. */
  screen(): string {
    return this.tmux("capture-pane", "-p", "-J", "-S", "-500", "-t", this.target);
  }

  /** Only what is on screen right now, without scrollback. */
  visible(): string {
    return this.tmux("capture-pane", "-p", "-J", "-t", this.target);
  }

  /** Type text into pi's editor without submitting it. */
  type(text: string): void {
    this.tmux("send-keys", "-t", this.target, "-l", text);
  }

  /** Send named keys, e.g. "Enter", "Escape", "C-c". */
  press(...keys: string[]): void {
    this.tmux("send-keys", "-t", this.target, ...keys);
  }

  /**
   * Type a line and submit it: a prompt for the agent or a /slash-command.
   * The short pause lets pi's autocomplete settle before Enter lands.
   */
  async submit(line: string): Promise<void> {
    this.type(line);
    await sleep(300);
    this.press("Enter");
  }

  /**
   * Poll until the screen (scrollback included) matches, or fail with the
   * last screen attached. Scrollback is searched so a notification that has
   * already scrolled up still counts; use a pattern unique to this step.
   */
  async waitFor(pattern: string | RegExp, opts: WaitOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      last = this.screen();
      if (typeof pattern === "string" ? last.includes(pattern) : pattern.test(last)) return last;
      await sleep(100);
    }
    throw new Error(
      `pi: timed out after ${timeoutMs}ms waiting for ${opts.label ?? String(pattern)}\n--- last screen ---\n${last}\n-------------------`,
    );
  }

  /** Poll until the *visible* screen no longer matches (e.g. a panel closed). */
  async waitForGone(pattern: string | RegExp, opts: WaitOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      last = this.visible();
      if (!(typeof pattern === "string" ? last.includes(pattern) : pattern.test(last))) return;
      await sleep(100);
    }
    throw new Error(
      `pi: timed out after ${timeoutMs}ms waiting for ${opts.label ?? String(pattern)} to go away\n--- last screen ---\n${last}\n-------------------`,
    );
  }

  /** True while pi is still running in the pane. */
  isRunning(): boolean {
    try {
      return this.tmux("display-message", "-p", "-t", this.target, "#{pane_dead}").trim() === "0";
    } catch {
      return false;
    }
  }

  /** Quit pi the way a person would (Ctrl+D on an empty editor), then tear tmux down. */
  async stop(): Promise<void> {
    if (this.isRunning()) {
      this.press("C-d");
      const deadline = Date.now() + 5_000;
      while (this.isRunning() && Date.now() < deadline) await sleep(100);
    }
    this.kill();
  }

  kill(): void {
    try {
      this.tmux("kill-server");
    } catch {
      // already gone
    }
  }

  private tmux(...args: string[]): string {
    return execFileSync("tmux", ["-u", "-L", this.socket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
