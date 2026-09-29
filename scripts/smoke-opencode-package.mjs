import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  await writeFile(join(temp, "package.json"), '{"private":true,"type":"module"}\n');
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
  console.log("packed OpenCode plugin: server, terminal companion, and RPC entrypoints loaded");
} finally {
  await rm(temp, { recursive: true, force: true });
}
