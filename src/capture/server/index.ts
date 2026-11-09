import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { AuthStore } from "./auth";
import { MODEL_URL, resolveConfig, type CaptureConfig } from "./config";
import { Recordings } from "./recordings";
import { defaultAppPath, startCaptureServer, type CaptureServer } from "./server";
import { simpleWebAuthn } from "./webauthn";
import { runProgram, whisperTranscriber, type RunProgram } from "./whisper";

/**
 * `pi-weave-capture`: the command line for Weave Capture.
 *
 *   pi-weave-capture [serve]   run the server (what the launch agent runs)
 *   pi-weave-capture doctor    check ffmpeg, whisper.cpp, the model and the tunnel steps
 *   pi-weave-capture install   start the server at login (macOS launch agent)
 *   pi-weave-capture uninstall stop starting it at login
 *
 * Settings come from flags or environment variables; see `server/config.ts`.
 */

export const LAUNCH_LABEL = "dev.pi-weave.capture";

export interface CaptureIo {
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  /** Absolute path of the running script, for the launch agent. */
  script: string;
  run?: RunProgram;
  /** Keep the server running until the process ends. Tests pass a resolved promise. */
  wait?: (server: CaptureServer) => Promise<void>;
  home?: string;
  uid?: number;
}

const USAGE = "usage: pi-weave-capture [serve | doctor | install | uninstall] [--origin URL] [--port N] [--dir PATH]\n";

export async function main(argv: readonly string[], io: CaptureIo): Promise<number> {
  const [first = "serve", ...rest] = argv;
  const command = first.startsWith("--") ? "serve" : first;
  const args = first.startsWith("--") ? argv : rest;
  const write = (line: string) => io.stdout.write(`${line}\n`);
  let config: CaptureConfig;
  try {
    config = resolveConfig(args, io.env);
  } catch (error) {
    write((error as Error).message);
    return 2;
  }
  const run = io.run ?? runProgram;
  const home = io.home ?? homedir();
  const plist = join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
  const domain = `gui/${io.uid ?? process.getuid?.() ?? 501}`;

  if (command === "serve") {
    const recordings = new Recordings(config.dir, config.vaultRoot, whisperTranscriber(config, run), config.keepAudioDays, undefined, (line) =>
      write(`[${new Date().toISOString()}] ${line}`),
    );
    await recordings.resume();
    const appPath = defaultAppPath();
    const server = await startCaptureServer({
      config,
      auth: new AuthStore(config.dir),
      webauthn: simpleWebAuthn,
      recordings,
      appJs: () => fs.readFile(appPath),
    });
    write(`Weave Capture on ${server.url}, published as ${config.origin}`);
    write(`Vault: ${config.vaultRoot}`);
    await (io.wait ?? (() => new Promise<void>(() => {})))(server);
    return 0;
  }

  if (command === "doctor") {
    let ok = true;
    const check = async (label: string, test: () => Promise<unknown>, fix: string) => {
      try {
        await test();
        write(`ok    ${label}`);
      } catch {
        ok = false;
        write(`MISS  ${label}\n      ${fix}`);
      }
    };
    await check(`ffmpeg (${config.ffmpeg})`, () => run(config.ffmpeg, ["-version"]), "brew install ffmpeg");
    await check(`whisper.cpp (${config.whisper})`, () => run(config.whisper, ["--help"]), "brew install whisper-cpp");
    await check(`model (${config.model})`, () => fs.access(config.model), `mkdir -p "${join(config.dir, "models")}" && curl -L -o "${config.model}" ${MODEL_URL}`);
    write("");
    write(`Tunnel: point ${config.origin} at http://localhost:${config.port}, for example:`);
    write(`  cloudflared tunnel create weave`);
    write(`  cloudflared tunnel route dns weave ${config.rpId}`);
    write(`  ingress in ~/.cloudflared/config.yml: hostname ${config.rpId} -> service http://localhost:${config.port}`);
    write(`  sudo cloudflared service install`);
    write("");
    write(`Then open ${config.origin} on your phone, set up your passkey, and add it to the home screen.`);
    return ok ? 0 : 1;
  }

  if (command === "install") {
    const path = io.env.PATH ?? "";
    const env: Record<string, string> = { PATH: `/opt/homebrew/bin:/usr/local/bin:${path}` };
    for (const key of ["PI_WEAVE_VAULT", "PI_WEAVE_CAPTURE_ORIGIN", "PI_WEAVE_CAPTURE_PORT", "PI_WEAVE_CAPTURE_DIR", "PI_WEAVE_WHISPER", "PI_WEAVE_WHISPER_MODEL", "PI_WEAVE_WHISPER_LANG", "PI_WEAVE_FFMPEG"]) {
      const value = io.env[key];
      if (value) env[key] = value;
    }
    await fs.mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await fs.mkdir(config.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(plist, launchAgent(process.execPath, io.script, args, env, join(config.dir, "capture.log")));
    await run("launchctl", ["bootout", domain, plist]).catch(() => undefined);
    await run("launchctl", ["bootstrap", domain, plist]);
    write(`Installed ${plist}. Weave Capture now starts at login; log: ${join(config.dir, "capture.log")}`);
    return 0;
  }

  if (command === "uninstall") {
    await run("launchctl", ["bootout", domain, plist]).catch(() => undefined);
    await fs.rm(plist, { force: true });
    write(`Removed ${plist}.`);
    return 0;
  }

  io.stdout.write(USAGE);
  return 2;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The launch agent: run the server at login and restart it if it stops. */
export function launchAgent(node: string, script: string, args: readonly string[], env: Record<string, string>, log: string): string {
  const program = [node, script, "serve", ...args].map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
  const vars = Object.entries(env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}
