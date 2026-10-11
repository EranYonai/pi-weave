import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway world for one pi run: its own $HOME, pi agent dir (settings,
 * models.json, sessions), notes vault and a small git repository to stand in.
 * Nothing reads or writes the developer's real ~/.pi or ~/.okf.
 */
export interface Sandbox {
  root: string;
  home: string;
  agentDir: string;
  vault: string;
  /** A git repo with one commit; pi is launched here. */
  repo: string;
  /** Delete everything (skipped when PI_WEAVE_E2E_KEEP=1, for debugging). */
  cleanup: () => void;
}

export function createSandbox(opts: { modelBaseUrl: string }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-weave-e2e-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const vault = join(root, "vault");
  const repo = join(root, "demo-repo");
  for (const dir of [agentDir, vault, repo]) mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          stub: {
            baseUrl: opts.modelBaseUrl,
            api: "openai-completions",
            apiKey: "stub",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [{ id: "stub-model", name: "Stub", reasoning: false, contextWindow: 128000, maxTokens: 4096 }],
          },
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(join(repo, "README.md"), "# demo-repo\n\nA tiny repository for pi-weave end-to-end runs.\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "index.ts"), 'export const hello = (name: string) => `hello ${name}`;\n');
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", ...args], {
      cwd: repo,
      env: isolatedEnv(home),
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "initial commit");

  return {
    root,
    home,
    agentDir,
    vault,
    repo,
    cleanup: () => {
      if (process.env.PI_WEAVE_E2E_KEEP === "1") {
        console.log(`[e2e] sandbox kept at ${root}`);
        return;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The environment pi runs with: only what a terminal program needs, plus the
 * sandbox paths. Built from scratch, not inherited, so a real provider API
 * key or a GIT_CONFIG_* override in the caller's shell can't leak in.
 */
export function isolatedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TERM: "xterm-256color",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...extra,
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}
