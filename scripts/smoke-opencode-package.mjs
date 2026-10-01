import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Host } from "@opencode/plugin/host";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "pi-weave-opencode-"));
try {
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
    { cwd: root, encoding: "utf8" },
  ));
  const project = join(temp, "project");
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", project, join(temp, packed[0].filename)],
    { stdio: "pipe" },
  );
  const manifest = JSON.parse(await readFile(join(project, "node_modules", "pi-weave", "package.json"), "utf8"));
  if (manifest.dependencies?.["@opencode/plugin"]) throw new Error("@opencode/plugin must remain host-provided");

  const entries = Host.resolve({ directory: project, name: "pi-weave" });
  if (!entries.server || !entries.tui || !entries.rpc) throw new Error(`missing entrypoint: ${JSON.stringify(entries)}`);
  execFileSync("bun", [
    "-e",
    [
      "const [server,tui,rpc]=await Promise.all(Bun.argv.slice(1).map((entry)=>import(entry)));",
      "if(server.default?.id!==\"pi-weave\")throw new Error(\"server plugin did not activate\");",
      "if(tui.default?.id!==\"pi-weave.tui\")throw new Error(\"terminal companion did not activate\");",
      "if(rpc.WEAVE_RPC?.id!==\"pi-weave\")throw new Error(\"RPC contract did not activate\");",
    ].join(""),
    entries.server,
    entries.tui,
    entries.rpc,
  ], { stdio: "pipe" });
  const pluginRepo = join(temp, "plugin-repo");
  await cp(join(project, "node_modules", "pi-weave"), pluginRepo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: pluginRepo });
  execFileSync("git", ["add", "."], { cwd: pluginRepo });
  execFileSync("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "packed package"], { cwd: pluginRepo });
  const password = randomBytes(16).toString("hex");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_CACHE_HOME: join(temp, "cache"),
    PI_WEAVE_VAULT: join(temp, "vault"),
    OPENCODE_PASSWORD: password,
  };
  execFileSync(join(root, "node_modules", ".bin", "opencode"), ["plugin", "add", `git+${pathToFileURL(pluginRepo).href}`], {
    cwd: project,
    env,
    stdio: "pipe",
  });
  const server = spawn(join(root, "node_modules", ".bin", "opencode"), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  let output = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`OpenCode did not start: ${output}`)), 30_000);
      server.stdout.setEncoding("utf8");
      server.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`OpenCode exited (${code}): ${output}`));
      });
    });
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const request = async (path, options = {}) => {
      const response = await fetch(`${url}${path}`, {
        ...options,
        headers: { authorization: auth, "content-type": "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    };
    let commands;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      commands = await request("/api/command").catch(() => null);
      if (commands?.data?.some((command) => command.name === "weave-view")) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    for (const name of ["weave", "weave-scan", "weave-scan-cancel", "weave-view"]) {
      if (!commands?.data?.some((command) => command.name === name)) {
        const log = await readFile(join(temp, "data", "opencode", "log", "opencode.log"), "utf8").catch(() => "");
        throw new Error(`OpenCode did not register /${name}: ${JSON.stringify(commands)}\n${output.slice(-3_000)}\n${log.slice(-6_000)}`);
      }
    }
    const skills = await request("/api/skill");
    for (const id of ["weave-notepad", "weave-explore"]) {
      if (!skills.data.some((skill) => skill.id === id)) throw new Error(`OpenCode did not register ${id}`);
    }
    const status = await request("/api/rpc/pi-weave/status", { method: "POST", body: '{"input":{}}' });
    if (!status.output?.text?.includes("vault:")) throw new Error("OpenCode status RPC did not activate");
    console.log("packed OpenCode plugin: server commands, skills, RPC, and terminal entrypoint loaded");
  } finally {
    server.kill();
    let timeout;
    await Promise.race([exited, new Promise((resolve) => { timeout = setTimeout(resolve, 5_000); })]);
    clearTimeout(timeout);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    await exited;
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
