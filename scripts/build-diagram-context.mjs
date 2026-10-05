import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = "skills/weave-excalidraw/scripts/diagram-context.mjs";
const result = await build({
  absWorkingDir: root, entryPoints: ["src/web/server/diagram-context.ts"], outfile,
  tsconfig: "tsconfig.json", bundle: true, platform: "node", format: "esm", target: "node20",
  charset: "utf8", legalComments: "eof", write: false, metafile: true,
  banner: { js: "// Generated from src/web/server/diagram-context.ts; npm run build:diagram-context. pi-weave MIT; Catppuccin palette MIT." },
  footer: { js: "runDiagramContext(process.argv.slice(2)).catch(error => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; });" },
});
if (Object.keys(result.metafile.inputs).some((path) => path.includes("node_modules/"))) throw new Error("Diagram context must use Node built-ins only");
const bytes = result.outputFiles[0].contents;
if (new TextDecoder().decode(bytes).includes(root)) throw new Error("Absolute build path in diagram context");
const path = resolve(root, outfile);
if (process.argv.includes("--check")) {
  if (!Buffer.from(bytes).equals(await readFile(path))) throw new Error("Diagram context is stale; run npm run build:diagram-context");
} else {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
