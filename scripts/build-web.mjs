#!/usr/bin/env node
/**
 * Bundles the browser client into a **committed** artifact (weave-workspace §9).
 *
 *   node scripts/build-web.mjs           build and write src/web/client/dist/app.js
 *   node scripts/build-web.mjs --check   rebuild in memory, byte-compare, never write
 *
 * ## Why an artifact is committed
 *
 * pi loads `src/pi/index.ts` as raw TypeScript through jiti, so installing
 * pi-weave requires no build step and `dependencies` stays empty. The browser
 * client cannot work that way — it needs bundling. Committing the bundle keeps
 * both properties: preact/sigma/graphology/d3-force/marked/dompurify are
 * *inputs to a build artifact*, not runtime requirements of the package.
 *
 * The cost of that choice is drift: a committed artifact can silently stop
 * matching its source. `--check` is the answer, and it is wired into
 * `npm run check` (hence `prepublishOnly`). It only works if the build is
 * byte-reproducible, which drives most of the decisions below.
 *
 * ## Determinism
 *
 * 1. `absWorkingDir` is pinned to the repository root and every path handed to
 *    esbuild is **relative** to it, so no machine-specific absolute path can
 *    reach the output or the metafile.
 * 2. `write: false` — the bytes are produced once, in memory, and then either
 *    written or compared. Build and check therefore cannot diverge in how the
 *    artifact is produced; there is exactly one code path.
 * 3. `charset: "utf8"` and `legalComments: "eof"` are set explicitly rather
 *    than inherited, so an esbuild default change is a visible diff, not a
 *    silent one.
 * 4. No sourcemap, no timestamp, no version string, no `define` of anything
 *    environment-derived. The banner is derived from the dependency set, which
 *    is pinned by `package-lock.json`.
 * 5. `tsconfig` is **pinned**, not auto-discovered. See the note at the option
 *    itself — this one was found the hard way.
 * 6. {@link assertNoAbsolutePaths} fails the build if the repo root ever
 *    appears in the output — a regression guard for (1).
 *
 * The property that matters is stronger than "twice in a row gives the same
 * bytes": it is "the same source gives the same bytes *from any directory, on
 * any machine*". Verify a change to this file against that, by copying `src/`,
 * `scripts/`, `tsconfig.web.json` and `node_modules/` somewhere else and
 * comparing hashes. Two runs in the same checkout will not catch (5).
 *
 * ## Two passes
 *
 * The banner must list the dependencies *actually in the bundle*, and that set
 * is only known from esbuild's metafile. So we bundle once to learn it, build
 * the banner, then bundle again with the banner applied. esbuild is fast
 * enough that this is not worth optimising around, and the alternative — a
 * hand-maintained list — rots.
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gzipSync, constants as zlibConstants } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo-relative, and kept relative — see determinism note (1). */
const ENTRY = "src/web/client/main.tsx";
const OUTFILE = "src/web/client/dist/app.js";

/** Hard budget from weave-workspace §14. 150 KiB. */
const GZIP_BUDGET_BYTES = 150 * 1024;

/**
 * SPDX identifiers for every dependency permitted in the bundle.
 *
 * A package that appears in the bundle but not here **fails the build**. That
 * is deliberate: shipping an unattributed dependency is a licence problem, and
 * the moment to catch it is the moment it first gets imported.
 *
 * `dompurify` is dual-licensed **MPL-2.0 OR Apache-2.0** — not MIT, despite
 * every other entry here being MIT or ISC. Do not "tidy" it.
 *
 * Every value below was read from `node_modules/<pkg>/package.json`. The
 * entries beyond preact/signals are the P2–P3 dependencies (§7, §11) and their
 * transitive closure; they are listed ahead of use so that the first PR to
 * import sigma or marked is a code change, not a licence review.
 */
const LICENCES = {
  preact: "MIT",
  "@preact/signals": "MIT",
  "@preact/signals-core": "MIT",
  sigma: "MIT",
  graphology: "MIT",
  "graphology-utils": "MIT",
  "d3-force": "ISC",
  "d3-quadtree": "ISC",
  "d3-dispatch": "ISC",
  "d3-timer": "ISC",
  marked: "MIT",
  dompurify: "MPL-2.0 OR Apache-2.0",
  events: "MIT",
};

// --- helpers ----------------------------------------------------------------

/**
 * Maps a metafile input path to its npm package name.
 *
 * Inputs are relative to `absWorkingDir`, so third-party modules look like
 * `node_modules/preact/dist/preact.module.js` or
 * `node_modules/@preact/signals/dist/signals.mjs`. First-party sources (`src/…`)
 * return `null`. Nested `node_modules` resolve to the innermost package, which
 * is the one actually contributing bytes.
 */
function packageOf(inputPath) {
  const marker = "node_modules/";
  const at = inputPath.lastIndexOf(marker);
  if (at === -1) return null;
  const parts = inputPath.slice(at + marker.length).split("/");
  const [first, second] = parts;
  if (first === undefined) return null;
  if (first.startsWith("@")) return second === undefined ? null : `${first}/${second}`;
  return first;
}

/** Sorted, de-duplicated package names contributing to the bundle. */
function bundledPackages(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const name = packageOf(input);
    if (name !== null) names.add(name);
  }
  return [...names].sort();
}

/** Installed version of a package, or `null` if it cannot be read. */
function versionOf(name) {
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Builds the licence header.
 *
 * Written as a `/*! … *​/` legal comment so that esbuild's own
 * `legalComments: "eof"` handling and any downstream minifier both preserve
 * it. Content is a pure function of the package set, so it is deterministic.
 *
 * @param packages sorted package names, from {@link bundledPackages}
 */
function licenceBanner(packages) {
  const unknown = packages.filter((name) => !(name in LICENCES));
  if (unknown.length > 0) {
    throw new Error(
      `Unattributed dependencies in the bundle: ${unknown.join(", ")}.\n` +
        `Add each to the LICENCES table in scripts/build-web.mjs with its SPDX identifier,\n` +
        `after confirming the licence in node_modules/<pkg>/package.json.`,
    );
  }
  const lines = [
    "/*!",
    " * pi-weave web client — generated bundle. Do not edit.",
    " * Source: src/web/client/. Rebuild with `npm run build:web`.",
    " *",
    " * pi-weave itself is MIT (see LICENSE).",
    " *",
    " * Bundled dependencies and their licences:",
  ];
  for (const name of packages) {
    const version = versionOf(name);
    const label = version === null ? name : `${name}@${version}`;
    lines.push(` *   ${label} — ${LICENCES[name]}`);
  }
  lines.push(" */");
  return lines.join("\n") + "\n";
}

/** Bytes → a short human string, in KiB with one decimal. */
function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Deterministic gzip measurement — level is pinned so the number is comparable. */
function gzipSize(bytes) {
  return gzipSync(bytes, { level: zlibConstants.Z_BEST_COMPRESSION }).length;
}

/**
 * Guards determinism note (1): no absolute path from this machine may appear
 * in the artifact, or `--check` becomes machine-dependent and useless.
 */
function assertNoAbsolutePaths(text) {
  if (text.includes(ROOT)) {
    throw new Error(
      `The bundle contains this machine's absolute repository path (${ROOT}).\n` +
        `That makes the artifact non-reproducible across machines and breaks build:web:check.`,
    );
  }
}

// --- the build ---------------------------------------------------------------

/** esbuild options shared by both passes. Banner is the only difference. */
function esbuildOptions(banner) {
  return {
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    // Pinned, not discovered. esbuild otherwise walks up from the entry point
    // looking for a `tsconfig.json`, which makes the output depend on a file
    // that is not a declared input — and on whatever happens to sit in the
    // parent directories of wherever the repo is checked out. That was a real
    // divergence: without it, a build from a directory with no ancestor
    // tsconfig dropped the `"use strict"` prologue, so two machines produced
    // different bytes and `--check` would have failed on a clean tree.
    tsconfig: "tsconfig.web.json",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    jsxImportSource: "preact",
    charset: "utf8",
    legalComments: "eof",
    sourcemap: false,
    write: false,
    metafile: true,
    logLevel: "silent",
    ...(banner === null ? {} : { banner: { js: banner } }),
  };
}

/**
 * Produces the artifact bytes.
 *
 * Pass one discovers the dependency set; pass two applies the banner derived
 * from it. See the two-pass note in the module header.
 */
async function bundle() {
  const probe = await build(esbuildOptions(null));
  const banner = licenceBanner(bundledPackages(probe.metafile));

  const final = await build(esbuildOptions(banner));
  const file = final.outputFiles[0];
  if (file === undefined) throw new Error("esbuild produced no output file");

  const bytes = Buffer.from(file.contents);
  assertNoAbsolutePaths(bytes.toString("utf8"));
  return bytes;
}

/** Reports size and enforces the §14 budget. Returns the gzip size. */
function reportSize(bytes, label) {
  const gzip = gzipSize(bytes);
  process.stdout.write(`${label}: ${formatKiB(bytes.length)} raw · ${formatKiB(gzip)} gzip ` + `(budget ${formatKiB(GZIP_BUDGET_BYTES)} gzip)\n`);
  if (gzip > GZIP_BUDGET_BYTES) {
    throw new Error(
      `Bundle exceeds the hard gzip budget: ${formatKiB(gzip)} > ${formatKiB(GZIP_BUDGET_BYTES)}.\n` +
        `weave-workspace §14 makes this budget non-negotiable. Remove or lazy-load a dependency.`,
    );
  }
  return gzip;
}

async function main() {
  const check = process.argv.includes("--check");
  const bytes = await bundle();
  const outPath = join(ROOT, OUTFILE);

  if (!check) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, bytes);
    reportSize(bytes, `wrote ${OUTFILE}`);
    return;
  }

  if (!existsSync(outPath)) {
    throw new Error(`Missing committed bundle ${OUTFILE}.\nRun \`npm run build:web\` and commit the result.`);
  }
  const committed = readFileSync(outPath);
  reportSize(bytes, `checked ${OUTFILE}`);
  if (!committed.equals(bytes)) {
    throw new Error(
      `${OUTFILE} is out of date: it does not match a fresh build of src/web/client/.\n` +
        `  committed: ${committed.length} bytes\n` +
        `  rebuilt:   ${bytes.length} bytes\n` +
        `Run \`npm run build:web\` and commit the updated artifact.`,
    );
  }
  process.stdout.write("bundle matches source\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
