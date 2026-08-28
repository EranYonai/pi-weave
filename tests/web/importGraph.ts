/**
 * Import-graph machinery shared by the tier guard and the purity guard.
 *
 * This is **not** a test file (no `.test.ts`, so vitest's `include` skips it)
 * and it holds no assertions. It exists because `tests/web/tiers.test.ts` and
 * `tests/web/view.purity.test.ts` ask two different questions of the same
 * object — "which tier does this edge cross?" and "is this closure
 * browser-safe?" — and a second, subtly-different walker is how two guards
 * end up disagreeing about what is reachable. The scanning quirks below
 * (side-effect imports count, comments do not) are load-bearing and should be
 * fixed in exactly one place.
 *
 * `tests/web/tiers.test.ts` remains the source of truth for the *rules*; this
 * module only knows how to read the graph they are stated over. The one
 * exception is {@link NODE_FREE_CORE_MODULES}, which lives here because both
 * suites consume it and neither owns it — see its own doc comment.
 */

import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const ROOT = resolve(new URL("../../", import.meta.url).pathname);
export const SRC = join(ROOT, "src");

/** Every declared tier directory, longest-prefix-wins when classifying. */
export const ALL_TIERS = ["src/core", "src/web/shared", "src/web/server", "src/web/client", "src/pi"] as const;

/** Generated output, not source. Walked by `tests/web/build.test.ts` instead. */
const SKIP_DIRS = new Set(["dist", "node_modules"]);

/** Globals that only exist in a browser. Word-bounded, so `documented` is fine. */
export const DOM_GLOBALS = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "requestAnimationFrame",
  "HTMLElement",
  "SVGElement",
  "getComputedStyle",
  "EventSource",
];

/** Globals that only exist in Node. The companion to a `node:*` import ban. */
export const NODE_GLOBALS = ["process", "Buffer", "__dirname", "__filename"];

/**
 * The `src/core` modules `src/web/shared/` — and therefore, transitively, the
 * browser — is permitted to reach (weave-workspace §2, §2.1).
 *
 * ## Why an allowlist of modules and not a directory
 *
 * §2.1's rule was "nothing under `src/web/shared/` imports `src/core` at all",
 * written after an `import type` of `GraphModel` broke
 * `tsc -p tsconfig.web.json` with 24 `Cannot find module 'node:fs'` errors.
 * That reasoning was about a *node-flavoured* closure and it was right about
 * that closure. The `src/core/view/` closure is a different object: eleven
 * modules of pure functions over plain data, no `node:*`, no npm, no Node
 * globals. §3's entire purpose is that the TUI and the browser share one
 * implementation of the tree and detail projections, and a blanket ban forced
 * either a second implementation or server-side pre-rendering.
 *
 * So the rule is narrowed rather than dropped. Writing it as
 * "`src/web/shared` may import `src/core`" would re-open exactly the hole
 * §2.1 closed — `core/vault.ts`, `core/git.ts`, `core/repoIndex.ts`,
 * `core/summaries.ts`, `core/paths.ts`, `core/cache/` and
 * `core/graph/current.ts` all read the filesystem or spawn git, and every one
 * of them is one `import type` away from a browser typecheck failure. Listed
 * as modules, adding one more is a visible, reviewable edit here with a purity
 * proof attached.
 *
 * `src/core/view/cluster.ts` is P3's addition, made in the commit that first
 * calls `clusterAggregate` (§7.4) — the edit §2.1.1 predicted in as many
 * words. It adds nothing new to the closure: its own imports are
 * `graph/model.ts`, `types.ts` and `view/tree.ts`, all of which the door
 * already reached, so the node-free proof below covers it unchanged.
 * `core/view/health.ts` and `core/view/index.ts` stay out — the barrel because
 * it re-exports `health.ts`, and `health.ts` because it is a TUI surface no
 * browser column consumes.
 *
 * ## Why it is exact rather than generous
 *
 * `view.purity.test.ts` asserts this set is *equal* to the core portion of the
 * closure reachable from `src/web/shared/view.ts`, in both directions. A stale
 * entry — a module the door no longer reaches — is a rule still granting
 * access nobody audits, so it fails too.
 */
export const NODE_FREE_CORE_MODULES: ReadonlySet<string> = new Set([
  "src/core/graph/model.ts",
  "src/core/types.ts",
  "src/core/view/cluster.ts",
  "src/core/view/detail.ts",
  "src/core/view/focus.ts",
  "src/core/view/links.ts",
  "src/core/view/time.ts",
  "src/core/view/tree.ts",
  "src/core/view/types.ts",
]);

// --- source scanning ----------------------------------------------------------

/** Recursive file walk. Returns `[]` for a directory that does not exist yet. */
export async function walk(dir: string, extensions: readonly string[]): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await walk(abs, extensions)));
    } else if (extensions.some((e) => entry.name.endsWith(e))) {
      out.push(abs);
    }
  }
  return out;
}

/** Strip comments — module headers legitimately discuss the DOM and Node. */
export function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every module specifier: static `from "…"`, bare side-effect `import "…"`,
 * and dynamic `import("…")`.
 *
 * The last two matter — `import "node:fs"` executes for its side effects and
 * would sail straight past a `from`-only scan into the browser bundle.
 *
 * Comments are stripped first, for the same reason {@link code} exists at all:
 * a module header that *documents* a forbidden import — "this used to be
 * `import type { GraphModel } from "../../core/graph/model"`, and here is why
 * it no longer is" — is the most useful comment such a file can carry, and
 * scanning raw text turns it into a self-inflicted failure. A commented-out
 * import is also, by definition, not an import.
 */
export function specifiers(source: string): string[] {
  const text = code(source);
  const out: string[] = [];
  for (const m of text.matchAll(/\bfrom\s+"([^"]+)"/g)) out.push(m[1]!);
  for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) out.push(m[1]!);
  return out;
}

/**
 * Static import/export statements, as (clause, specifier) pairs.
 *
 * Comment-stripped, matching {@link specifiers} — a prose example of an
 * import in a module header is documentation, not a dependency.
 */
export function statements(source: string): Array<{ clause: string; spec: string }> {
  const out: Array<{ clause: string; spec: string }> = [];
  for (const line of code(source).split("\n")) {
    const m = /^\s*(?:import|export)\s+(.*?)\bfrom\s+"([^"]+)"/.exec(line);
    if (m !== null) out.push({ clause: (m[1] ?? "").trim(), spec: m[2] ?? "" });
  }
  return out;
}

/**
 * The tier a resolved absolute path belongs to, or `null` if it is outside
 * every declared tier. Longest prefix wins, so `src/web/shared` is not
 * swallowed by a hypothetical `src/web`.
 *
 * The tier directory itself counts: `import … from "../core"` resolves to
 * `src/core` exactly and means the barrel, `src/core/index.ts`.
 */
export function tierOf(abs: string): string | null {
  let best: string | null = null;
  for (const id of ALL_TIERS) {
    const dir = join(ROOT, id);
    const inside = abs === dir || abs.startsWith(dir + sep);
    if (inside && (best === null || id.length > best.length)) best = id;
  }
  return best;
}

/** Resolve a relative specifier against the importing module. */
export function resolveSpec(from: string, spec: string): string {
  return resolve(dirname(from), spec);
}

/**
 * Resolve a specifier to a file on disk, the way the bundler and the compiler
 * both would: an exact path, then `.ts`/`.tsx`, then the directory's barrel.
 *
 * Extensionless relative imports are the house style (AGENTS.md), so
 * `"./graph"` may mean `graph.ts` *or* `graph/index.ts`, and the transitive
 * walk cannot follow an edge it fails to resolve. Returns `null` for a
 * specifier with no file behind it, which the caller reports rather than
 * skips — a silently unresolvable import is a hole in the traversal, and a
 * hole in the traversal is how the original bug survived.
 */
export async function resolveModuleFile(from: string, spec: string): Promise<string | null> {
  const base = resolveSpec(from, spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile() === true) return candidate;
  }
  return null;
}

/** One hop in an import chain, for a readable failure message. */
export interface Hop {
  readonly from: string;
  readonly spec: string;
}

/**
 * Walk the **transitive** relative-import graph from a set of entry files.
 *
 * Returns every reachable module keyed by absolute path, with the chain that
 * first reached it so a violation can be reported as
 * `client/api.ts → ../shared/wire → ../../core/graph/model` rather than as a
 * bare "client imports core", which tells you nothing about which edge to
 * cut.
 *
 * Bare specifiers are not followed — an npm package is the `npm` allowlist's
 * problem, and walking into `node_modules` would be both enormous and beside
 * the point. `node:*` specifiers *are* recorded, because "does a `node:`
 * import exist anywhere in the client's reachable set" is exactly one of the
 * questions being asked.
 */
export async function reachableFrom(entries: readonly string[]): Promise<Map<string, Hop[]>> {
  const seen = new Map<string, Hop[]>();
  const unresolved: string[] = [];
  const queue: Array<{ abs: string; chain: Hop[] }> = [];

  for (const abs of entries) {
    seen.set(abs, []);
    queue.push({ abs, chain: [] });
  }

  while (queue.length > 0) {
    const { abs, chain } = queue.shift()!;
    const text = await fs.readFile(abs, "utf8").catch(() => null);
    if (text === null) continue;

    for (const spec of specifiers(text)) {
      if (!spec.startsWith(".")) continue;
      const next = await resolveModuleFile(abs, spec);
      if (next === null) {
        unresolved.push(`${relative(ROOT, abs)} → ${spec}`);
        continue;
      }
      if (seen.has(next)) continue;
      const nextChain = [...chain, { from: relative(ROOT, abs), spec }];
      seen.set(next, nextChain);
      queue.push({ abs: next, chain: nextChain });
    }
  }

  // Surfaced as a thrown error rather than a silent skip: an import the walk
  // cannot resolve is a blind spot, and this guard is only worth what its
  // coverage is.
  if (unresolved.length > 0) {
    throw new Error(`tier walk could not resolve:\n  ${unresolved.join("\n  ")}`);
  }
  return seen;
}

/** Render a chain as `a.ts → ./b → ./c` for a failure message. */
export function renderChain(entry: string, chain: readonly Hop[]): string {
  return [entry, ...chain.map((h) => h.spec)].join(" → ");
}

/** Repo-relative path, always with `/` separators, for messages and allowlists. */
export function rel(abs: string): string {
  return relative(ROOT, abs).split(sep).join("/");
}
