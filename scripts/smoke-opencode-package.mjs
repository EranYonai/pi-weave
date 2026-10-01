import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Host } from "@opencode/plugin/host";
import { OpenCode } from "@opencode/client/promise";

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
  // A local deterministic model exercises host execution without accounts or API spend.
  const prompts = [];
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const last = input.messages.at(-1);
    prompts.push(JSON.stringify(last.content));
    const calls = input.tools?.length && last.role === "user" && JSON.stringify(last.content).includes("WEAVE_SMOKE_TOOLS") && !JSON.stringify(last.content).includes("File:")
      ? [
        { index: 0, id: "call_note", type: "function", function: { name: "weave_note", arguments: JSON.stringify({ action: "add", title: "Smoke memory", text: "Shared tools work." }) } },
        { index: 1, id: "call_repo", type: "function", function: { name: "weave_repo", arguments: '{"action":"scan"}' } },
      ] : undefined;
    const content = "Smoke summary.";
    if (!input.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "smoke", object: "chat.completion", created: 1, model: "smoke", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.end(chunk(calls ? { role: "assistant", tool_calls: calls } : { role: "assistant", content }, null) + chunk({}, calls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  try {
    for (const version of ["v1", "v2"]) {
      const cli = join(root, "node_modules", version === "v1" ? "@opencode-v1/cli" : "@opencode/cli", "bin", "opencode.exe");
      const password = randomBytes(16).toString("hex");
      const env = {
        ...process.env,
        XDG_CONFIG_HOME: join(temp, version, "config"),
        XDG_DATA_HOME: join(temp, version, "data"),
        XDG_CACHE_HOME: join(temp, version, "cache"),
        PI_WEAVE_VAULT: join(temp, version, "vault"),
        OPENCODE_PASSWORD: password,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
      };
      const configPath = join(env.XDG_CONFIG_HOME, "opencode", "opencode.json");
      if (version === "v2") {
        execFileSync(cli, ["plugin", "add", `git+${pathToFileURL(pluginRepo).href}`], { cwd: project, env, stdio: "pipe", timeout: 60_000, killSignal: "SIGKILL" });
      } else {
        execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", join(env.XDG_CONFIG_HOME, "opencode"), "@opencode-ai/plugin@1.18.29"], { stdio: "pipe" });
        await writeFile(configPath, JSON.stringify({ plugin: [pathToFileURL(join(project, "node_modules", "pi-weave")).href] }));
      }
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.model = "weave-smoke/model";
      config.provider = { "weave-smoke": { npm: "@ai-sdk/openai-compatible", name: "Smoke", options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "smoke" }, models: { model: { name: "Smoke", limit: { context: 32768, output: 4096 } } } } };
      await writeFile(configPath, JSON.stringify(config));
      execFileSync("git", ["init", "-q"], { cwd: project });
      await writeFile(join(project, ".gitignore"), "node_modules/\n.okf/\n");
      await writeFile(join(project, "sample.ts"), "export const answer = 42;\n");
      execFileSync("git", ["add", "sample.ts", ".gitignore"], { cwd: project });
      execFileSync("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: project });
      const server = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
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
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
          return response.json();
        };
        let commands;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          commands = await request(version === "v1" ? "/command" : "/api/command").then((result) => version === "v1" ? result : result.data).catch(() => null);
          if (commands?.some((command) => command.name === "weave-view")) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        for (const name of ["weave", "weave-scan", "weave-scan-cancel", "weave-view"]) {
          if (!commands?.some((command) => command.name === name)) {
            const log = await readFile(join(env.XDG_DATA_HOME, "opencode", "log", "opencode.log"), "utf8").catch(() => "");
            throw new Error(`OpenCode did not register /${name}: ${JSON.stringify(commands?.map((command) => command.name))}\n${output.slice(-3_000)}\n${log.slice(-6_000)}`);
          }
        }
        const skills = await request(version === "v1" ? "/skill" : "/api/skill").then((result) => version === "v1" ? result : result.data);
        for (const id of ["weave-notepad", "weave-explore"]) {
          if (!skills.some((skill) => (skill.id ?? skill.name) === id)) throw new Error(`OpenCode did not register ${id}`);
        }
        if (version === "v2") {
          const status = await request("/api/rpc/pi-weave/status", { method: "POST", body: '{"input":{}}' });
          if (!status.output?.text?.includes("vault:")) throw new Error("OpenCode status RPC did not activate");
        }
        const client = version === "v2" ? OpenCode.make({ baseUrl: url, headers: { authorization: auth } }) : undefined;
        const session = client
          ? await client.session.create({ title: "Packed smoke session", location: { directory: project }, model: { providerID: "weave-smoke", id: "model" } })
          : await request("/session", { method: "POST", body: '{"title":"Packed smoke session"}' });
        if (client) {
          await client.session.prompt({ sessionID: session.id, text: "WEAVE_SMOKE_TOOLS" });
          await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        } else {
          const result = await request(`/session/${session.id}/message`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "WEAVE_SMOKE_TOOLS" }] }) });
          if (result.info.error) throw new Error(JSON.stringify(result.info.error));
        }
        const note = await readFile(join(env.PI_WEAVE_VAULT, "notes", "smoke-memory.md"), "utf8");
        if (!note.includes("Shared tools work.")) throw new Error(`${version} tool did not write note`);
        for (const [command, args, expectedResult] of [
          ["weave", "", "Vault"],
          ["weave-scan", "", "index refreshed"],
          ["weave-scan-cancel", "", "no scan is currently running"],
          ["weave-scan", "deep", "index refreshed"],
          ["weave-scan", "sessions", "Scan started"],
          ["weave-view", "--no-open", "http://127.0.0.1:"],
        ]) {
          const promptOffset = prompts.length;
          if (client) await client.session.command({ sessionID: session.id, name: command, text: args });
          else {
            const result = await request(`/session/${session.id}/command`, { method: "POST", body: JSON.stringify({ command, arguments: args }) });
            if (result.info.error) throw new Error(JSON.stringify(result.info.error));
            if (!prompts.slice(promptOffset).some((text) => text.includes("Report this pi-weave result") && text.includes(expectedResult))) {
              throw new Error(`V1 /${command} ${args}: command result never reached the model`);
            }
            const messages = await request(`/session/${session.id}/message`);
            const resultPart = messages.flatMap((message) => message.parts).findLast((part) => part.metadata?.["pi-weave-result"]);
            const native = resultPart?.metadata["pi-weave-result"];
            if (!resultPart?.synthetic || !native.text.includes(expectedResult)) throw new Error(`V1 /${command}: native result missing`);
            if (command === "weave-view" && (native.viewer.open !== false || !native.text.includes(native.viewer.url))) {
              throw new Error("V1 viewer handoff lost its exact URL or --no-open flag");
            }
          }
          if (command === "weave-scan" && args) {
            const expected = args === "deep" ? "deep scan complete" : "session scan complete";
            let complete = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const messages = client ? await client.session.inbox.list({ sessionID: session.id }) : await request(`/session/${session.id}/message`);
              complete = JSON.stringify(messages).includes(expected);
              if (complete) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!complete) throw new Error(`${version}: ${expected} was not reported`);
          }
        }
        const memory = await readFile(join(env.PI_WEAVE_VAULT, "notes", "sessions", "packed-smoke-session.md"), "utf8");
        if (!memory.includes("Smoke summary.")) throw new Error(`${version}: model scan did not write memory`);
        if (!client && (await request(`/session/${session.id}/children`)).length) throw new Error("V1 leaked temporary scan sessions");
        console.log(`packed OpenCode ${version}: installed package activated; commands and skills registered; tools, commands, deep and session scans executed`);
      } finally {
        server.kill();
        let timeout;
        await Promise.race([exited, new Promise((resolve) => { timeout = setTimeout(resolve, 5_000); })]);
        clearTimeout(timeout);
        if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
        await exited;
      }
    }
  } finally {
    await new Promise((resolve) => model.close(resolve));
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
