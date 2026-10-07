import { build } from "esbuild";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = "src/web/client/dist/scene-assets";
const packageRoot = resolve(root, "node_modules/@excalidraw/excalidraw");
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (manifest.version !== "0.18.1") throw new Error("Review renderer exports before changing Excalidraw 0.18.1");
const index = await readFile(join(packageRoot, "dist/prod/index.js"), "utf8");
const binding = index.match(/([\w$]+) as exportToBlob[,}]/)?.[1];
let exportModule;
let exportChunk;
for (const match of index.matchAll(/import\{([^}]+)\}from"([^\"]+)"/g)) {
  const original = match[1].match(new RegExp(`(?:^|,)([\\w$]+) as ${binding}(?:,|$)`))?.[1];
  if (original) {
    exportChunk = resolve(packageRoot, "dist/prod", match[2]);
    exportModule = `export { ${original} as exportToBlob } from ${JSON.stringify(exportChunk)};`;
  }
}
if (!exportModule) throw new Error("Official exportToBlob reexport changed; inspect the pinned renderer");
const result = await build({
  absWorkingDir: root, entryPoints: ["src/web/client/note/scene-renderer.ts"], outfile: `${out}/renderer.js`,
  tsconfig: "tsconfig.web.json", bundle: true, format: "iife", platform: "browser", target: "es2022",
  minify: true, charset: "utf8", legalComments: "eof", write: false, metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  // Use the identical public utility function without editor-index side effects.
  plugins: [{ name: "official-export-only", setup(builder) {
    builder.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({ path: "exportToBlob", namespace: "official-export-only" }));
    builder.onLoad({ filter: /.*/, namespace: "official-export-only" }, () => ({ contents: exportModule, resolveDir: root }));
    // FontFace registers every fallback URL even when local fonts load first.
    // Keep the pinned renderer offline without relaxing the viewer's CSP.
    builder.onLoad({ filter: /chunk-.*\.js$/ }, async ({ path }) => {
      if (path !== exportChunk) return;
      const contents = await readFile(path, "utf8");
      const fallback = '`https://esm.sh/${M.PKG_NAME?`${M.PKG_NAME}@${M.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`';
      if (contents.split(fallback).length !== 2) throw new Error("Pinned Excalidraw font fallback changed; inspect it before building");
      return { contents: contents.replace(fallback, 'new URL("/scene-assets/",window.location.origin).href'), loader: "js" };
    });
  } }],
});
const bytes = Buffer.from(result.outputFiles[0].text.replace(/[ \t]+$/gm, "").trimEnd() + "\n");
console.log(`renderer: ${bytes.length} raw, ${gzipSync(bytes).length} gzip`);
if (gzipSync(bytes).length > 1024 * 1024) throw new Error("Lazy renderer exceeds its 1 MiB gzip budget");
if (new TextDecoder().decode(bytes).includes(root)) throw new Error("Absolute build path in scene renderer");
if (new TextDecoder().decode(bytes).includes("https://esm.sh/")) throw new Error("Remote font fallback in scene renderer");
const packages = [...new Set(Object.keys(result.metafile.inputs).filter((name) => name.includes("node_modules/")).map((name) => {
  const parts = name.slice(name.lastIndexOf("node_modules/") + 13).split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}))].sort();
console.log("renderer packages:", packages.join(", "));
const artifacts = new Map([[`${out}/renderer.js`, Buffer.from(bytes)]]);
const notices = ["pi-weave diagram renderer — generated from official Excalidraw 0.18.1 exports.\n"];
notices.push(await readFile(resolve(root, "scripts/excalidraw-font-notices.txt"), "utf8"));
for (const name of packages) {
  const directory = resolve(root, "node_modules", name);
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (!pkg.license) throw new Error(`No declared license for ${name}`);
  notices.push(`${name}@${pkg.version} — ${pkg.license}\n`);
  for (const file of (await readdir(directory)).filter((file) => /^(?:licen[sc]e|copying)(?:\.|$)/i.test(file)).sort()) {
    notices.push(await readFile(join(directory, file), "utf8"));
  }
}
artifacts.set(`${out}/licenses.txt`, Buffer.from(notices.join("\n").replace(/[ \t]+$/gm, "")));
const fontsRoot = resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
// Liberation is marked serverSide in Excalidraw's font metadata. The browser
// uses system Helvetica/Arial instead; do not ship this unused historical font.
const obsoleteFont = resolve(root, out, "fonts/Liberation/LiberationSans-Regular.woff2");
if (existsSync(obsoleteFont)) {
  if (process.argv.includes("--check")) throw new Error("Unused Liberation font remains; run npm run build:scene-renderer");
  await unlink(obsoleteFont);
}
async function fonts(directory, relative = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(relative, entry.name);
    if (entry.isDirectory() && name !== "Liberation") await fonts(join(directory, entry.name), name);
    else if (entry.name.endsWith(".woff2")) artifacts.set(`${out}/fonts/${name}`, await readFile(join(directory, entry.name)));
  }
}
await fonts(fontsRoot);
for (const [name, content] of artifacts) {
  const path = resolve(root, name);
  if (process.argv.includes("--check")) {
    if (!content.equals(await readFile(path))) throw new Error(`Stale ${name}; run npm run build:scene-renderer`);
  } else {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
  }
}
