#!/usr/bin/env node
/**
 * Bundles Weave Capture into two **committed** files:
 *
 *   src/capture/dist/capture.mjs  the server and command line (Node), the `pi-weave-capture` bin
 *   src/capture/dist/app.js       the phone page (browser)
 *
 *   node scripts/build-capture.mjs           build and write both
 *   node scripts/build-capture.mjs --check   rebuild in memory, byte-compare, never write
 *
 * Committed for the same reason as the workspace client and the Claude Code
 * bundle: the npm package runs without a build step, and the passkey and UI
 * libraries are inputs to a build, never runtime dependencies. `--check` runs
 * in `npm run check`, so the files cannot drift from their source.
 */

import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** SPDX identifiers of every package allowed in either bundle, read from node_modules. */
const LICENCES = {
  "@simplewebauthn/server": "MIT",
  "@simplewebauthn/browser": "MIT",
  "@hexagon/base64": "MIT",
  "@levischuck/tiny-cbor": "MIT",
  "@peculiar/asn1-android": "MIT",
  "@peculiar/asn1-cms": "MIT",
  "@peculiar/asn1-csr": "MIT",
  "@peculiar/asn1-ecc": "MIT",
  "@peculiar/asn1-pfx": "MIT",
  "@peculiar/asn1-pkcs8": "MIT",
  "@peculiar/asn1-pkcs9": "MIT",
  "@peculiar/asn1-rsa": "MIT",
  "@peculiar/asn1-schema": "MIT",
  "@peculiar/asn1-x509": "MIT",
  "@peculiar/asn1-x509-attr": "MIT",
  "@peculiar/utils": "MIT",
  "@peculiar/x509": "MIT",
  asn1js: "BSD-3-Clause",
  pvtsutils: "MIT",
  pvutils: "MIT",
  "reflect-metadata": "Apache-2.0",
  tslib: "0BSD",
  tsyringe: "MIT",
  preact: "MIT",
};

const TARGETS = [
  {
    label: "server",
    outfile: "src/capture/dist/capture.mjs",
    options: {
      entryPoints: ["src/capture/server/cli.ts"],
      tsconfig: "tsconfig.json",
      format: "esm",
      platform: "node",
      target: "node20",
      // Some bundled CommonJS calls require() for node builtins.
      banner: { js: "#!/usr/bin/env node\nimport { createRequire as __weaveRequire } from 'node:module'; const require = __weaveRequire(import.meta.url);" },
    },
    rewriteUrls: true,
  },
  {
    label: "page",
    outfile: "src/capture/dist/app.js",
    options: {
      entryPoints: ["src/capture/client/main.tsx"],
      tsconfig: "tsconfig.web.json",
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: "preact",
    },
    rewriteUrls: false,
  },
];

/** Point `import.meta.url` in each source module at its own place, as seen from the bundle. */
function sourceUrls(outfile) {
  return {
    name: "source-relative-import-meta-url",
    setup(b) {
      b.onLoad({ filter: /\.ts$/ }, (args) => {
        const source = readFileSync(args.path, "utf8");
        if (!source.includes("import.meta.url") || args.path.includes("node_modules")) return undefined;
        const fromBundle = relative(dirname(join(ROOT, outfile)), args.path).split("\\").join("/");
        return {
          contents: source.replaceAll("import.meta.url", `new URL(${JSON.stringify(fromBundle)}, import.meta.url).href`),
          loader: "ts",
        };
      });
    },
  };
}

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

async function bundle(target) {
  const result = await build({
    absWorkingDir: ROOT,
    outfile: target.outfile,
    bundle: true,
    minify: true,
    charset: "utf8",
    legalComments: "eof",
    write: false,
    metafile: true,
    logLevel: "silent",
    ...target.options,
    plugins: target.rewriteUrls ? [sourceUrls(target.outfile)] : [],
  });
  const packages = packagesIn(result.metafile);
  const unknown = packages.filter((name) => !(name in LICENCES));
  if (unknown.length > 0) {
    throw new Error(`Unattributed dependencies in the capture ${target.label} bundle: ${unknown.join(", ")}.\nAdd each to LICENCES in scripts/build-capture.mjs.`);
  }
  const notice = `/*! Weave Capture ${target.label} — generated bundle. Do not edit. Source: src/capture/. Rebuild with \`npm run build:capture\`. pi-weave is MIT (see LICENSE). Bundled: ${packages.map((name) => `${name} (${LICENCES[name]})`).join(", ") || "none"}. */\n`;
  let text = Buffer.from(result.outputFiles[0].contents).toString("utf8");
  // Keep the shebang first: it must be the file's opening bytes.
  text = text.startsWith("#!") ? text.replace(/^(#![^\n]*\n)/, `$1${notice}`) : notice + text;
  if (text.includes(ROOT)) throw new Error(`The capture ${target.label} bundle contains this machine's repository path (${ROOT}).`);
  return Buffer.from(text, "utf8");
}

async function main() {
  const check = process.argv.includes("--check");
  for (const target of TARGETS) {
    const bytes = await bundle(target);
    const outPath = join(ROOT, target.outfile);
    if (!check) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, bytes, { mode: target.label === "server" ? 0o755 : 0o644 });
      process.stdout.write(`wrote ${target.outfile}: ${(bytes.length / 1024).toFixed(1)} KiB\n`);
      continue;
    }
    if (!existsSync(outPath) || !readFileSync(outPath).equals(bytes)) {
      throw new Error(`${target.outfile} is out of date with src/.\nRun \`npm run build:capture\` and commit the result.`);
    }
    process.stdout.write(`${target.outfile} matches source\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
