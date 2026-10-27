#!/usr/bin/env node
/**
 * Bundles the Claude Code plugin's entry (`src/claude/cli.ts`) into one
 * committed file, `claude/dist/weave.mjs`.
 *
 * Why committed: Claude Code installs plugins straight from the git repo, and
 * Node cannot run the TypeScript sources (extensionless imports, directory
 * imports). So the plugin ships this file the way the browser workspace ships
 * `src/web/client/dist/app.js`, and `--check` keeps it honest in CI.
 *
 * `import.meta.url` is rewritten per module to the URL that module would have
 * had at its source path, so code that finds files relative to itself (the
 * web client bundle, package.json) works unchanged from the bundle.
 *
 *   node scripts/build-claude.mjs          write the bundle
 *   node scripts/build-claude.mjs --check  fail if the committed bundle is stale
 */

import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/claude/cli.ts";
const OUTFILE = "claude/dist/weave.mjs";

/** SPDX identifiers of every package allowed in the bundle. */
const LICENCES = { fflate: "MIT", zod: "MIT" };

const sourceUrls = {
  name: "source-relative-import-meta-url",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (!source.includes("import.meta.url")) return undefined;
      const fromBundle = relative(dirname(join(ROOT, OUTFILE)), args.path).split("\\").join("/");
      return {
        contents: source.replaceAll("import.meta.url", `new URL(${JSON.stringify(fromBundle)}, import.meta.url).href`),
        loader: "ts",
      };
    });
  },
};

function packagesIn(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");
    if (at === -1) continue;
    const [first, second] = input.slice(at + "node_modules/".length).split("/");
    names.add(first.startsWith("@") ? `${first}/${second}` : first);
  }
  return [...names].sort();
}

async function bundle() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    tsconfig: "tsconfig.json",
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    minify: true,
    charset: "utf8",
    legalComments: "eof",
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [sourceUrls],
  });
  const packages = packagesIn(result.metafile);
  const unknown = packages.filter((name) => !(name in LICENCES));
  if (unknown.length > 0) {
    throw new Error(`Unattributed dependencies in the Claude Code bundle: ${unknown.join(", ")}.\nAdd each to LICENCES in scripts/build-claude.mjs.`);
  }
  const banner = [
    "/*!",
    " * pi-weave Claude Code plugin — generated bundle. Do not edit.",
    " * Source: src/claude/. Rebuild with `npm run build:claude`.",
    " * pi-weave is MIT (see LICENSE). Bundled: " + (packages.map((name) => `${name} (${LICENCES[name]})`).join(", ") || "none") + ".",
    " */",
    "",
  ].join("\n");
  const text = banner + Buffer.from(result.outputFiles[0].contents).toString("utf8");
  if (text.includes(ROOT)) throw new Error(`The bundle contains this machine's repository path (${ROOT}).`);
  return Buffer.from(text, "utf8");
}

async function main() {
  const bytes = await bundle();
  const outPath = join(ROOT, OUTFILE);
  if (!process.argv.includes("--check")) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, bytes);
    process.stdout.write(`wrote ${OUTFILE}: ${(bytes.length / 1024).toFixed(1)} KiB\n`);
    return;
  }
  if (!existsSync(outPath) || !readFileSync(outPath).equals(bytes)) {
    throw new Error(`${OUTFILE} is out of date with src/.\nRun \`npm run build:claude\` and commit the result.`);
  }
  process.stdout.write(`${OUTFILE} matches source\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
