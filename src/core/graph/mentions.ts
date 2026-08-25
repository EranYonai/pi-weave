/**
 * `mentions` edges: a note body that names a repository path → note → node
 * (weave-workspace §4.4, §15.5).
 *
 * `EdgeKind` has declared `"mentions"` since the graph model was written and
 * `buildGraph` had never emitted one, so every consumer carried a branch that
 * could not be taken and the legend advertised a relationship the product did
 * not have. This module is the implementation side of that choice.
 *
 * Pure and I/O-free, like its sibling `wikilinks.ts`: a regex over a string
 * and a lookup in a map built from the repo index. No parsing, no LLM, no
 * new dependency (§4.4 is explicit about all three).
 */

import type { RepoStructure } from "../types";

/**
 * A repo-relative path candidate: two or more `/`-joined segments of word
 * characters, dots and dashes.
 *
 * The lookbehind is the part doing real work. `(?<![\w/.@:-])` refuses to
 * start a match immediately after a character that would make this the *tail*
 * of something longer, which is what keeps `https://github.com/org/repo/src`
 * and `user@host.com/path` from being read as repo paths. Without it every
 * URL in every note becomes a candidate, and since candidates are only kept
 * when they hit a real node the damage would be invisible until the day
 * someone's repo happened to contain `org/repo`.
 *
 * At least one slash is required, so prose words are not candidates. Trailing
 * sentence punctuation is stripped by {@link extractPathMentions} rather than
 * excluded here, because `src/core.` at the end of a sentence should match
 * `src/core` and a regex that refuses the dot cannot also accept
 * `src/core/vault.ts`.
 */
const PATH_RE = /(?<![\w/.@:-])([\w.-]+(?:\/[\w.-]+)+)/g;

/** Punctuation that ends a sentence rather than a path. */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

/**
 * Repo path → graph node id, for every path-addressable node the builder
 * emits.
 *
 * Deliberately built from {@link RepoStructure} rather than by scanning the
 * finished node list: both are derived from the same arrays, so mirroring the
 * id construction here keeps the invariant that *every* value in this map is
 * a node that exists, while reading it back off `GraphNode.detail.path` would
 * mean re-parsing a display-only field (§4.2) to recover something structured
 * we already had.
 */
export type PathIndex = ReadonlyMap<string, string>;

/**
 * Index the path-bearing nodes of a repository, exactly mirroring the ids
 * `buildRepositorySide` emits.
 *
 * Insertion order is modules, then entry points, then packages, then `.okf`
 * files. Later kinds do **not** overwrite earlier ones: a path that is both a
 * module and an entry point resolves to the module, which is the coarser and
 * more navigable of the two. The choice only has to be *stable*, and pinning
 * it here is what makes it so.
 *
 * `(root)` is skipped. It is a display label for "files directly in the repo
 * root", not a path, and no note body can spell it in a way that reaches
 * here anyway.
 */
export function buildPathIndex(structure: RepoStructure): PathIndex {
  const index = new Map<string, string>();
  const put = (path: string, id: string): void => {
    if (path.length > 0 && !index.has(path)) index.set(path, id);
  };
  for (const mod of structure.modules) {
    if (mod.path === "(root)") continue;
    put(mod.path, `module:${mod.path}`);
  }
  for (const entry of structure.entryPoints) put(entry, `entryPoint:${entry}`);
  for (const pkg of structure.packages) put(pkg.manifestPath, `package:${pkg.manifestPath}`);
  // `.okf` files are addressed by their repo-relative path (".okf/…"), while
  // their node ids drop the prefix — the same rename `buildRepositorySide`
  // performs.
  for (const file of structure.okFiles ?? []) {
    put(file, `okf:${file.replace(/^\.okf\//, "")}`);
  }
  return index;
}

/**
 * Every distinct path-like token in a note body, in order of first
 * appearance, with trailing sentence punctuation and trailing slashes
 * removed.
 *
 * Exported for its own tests: the regex is the part of this feature most
 * likely to be wrong, and testing it through `buildGraph` alone would mean
 * every false-positive case needed a whole repo fixture.
 */
export function extractPathMentions(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(PATH_RE)) {
    // `?? ""` rather than an `undefined` guard: the group is mandatory, so it
    // always participates and a guard would be a branch no input can take.
    // An empty string falls out at the `includes("/")` check just below.
    const path = (match[1] ?? "").replace(TRAILING_PUNCT_RE, "").replace(/\/+$/, "");
    if (!path.includes("/") || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Resolve the repo nodes a note body mentions, as node ids in first-appearance
 * order, deduplicated.
 *
 * ## Granularity: exact match, else the longest **enclosing** module
 *
 * This is the decision that keeps the edge count sane, and it runs in exactly
 * one direction.
 *
 * *Never downward.* A note saying "see `src/core`" produces **one** edge, to
 * `module:src/core`. It does not fan out to the files beneath it. Expanding a
 * prefix downward is how a three-word sentence turns into forty edges and the
 * graph column becomes unreadable — the explicit failure mode §4.4 warns
 * about.
 *
 * *Upward, at most one step.* A note saying `src/core/vault.ts` is making a
 * genuine reference, but most repository files are not graph nodes (only
 * modules, entry points, packages and `.okf` files are), so an exact-match-only
 * rule would silently drop the majority of real mentions and leave the feature
 * looking broken. The fallback walks the path's ancestors longest-first and
 * takes the first that is a **module**, so the mention lands on the nearest
 * indexed container: `src/core/graph/build.ts` → `module:src/core`.
 *
 * The asymmetry is what makes this safe. Each distinct mentioned path resolves
 * to **at most one** node, so the edges a note can contribute are bounded by
 * the number of distinct paths it names, and the collapse only ever reduces
 * that further — two files in the same module fold into a single edge because
 * the result is deduplicated by target.
 *
 * The ancestor walk is restricted to modules on purpose: an entry point or a
 * manifest is a *file*, and "this note mentions a path inside `package.json`"
 * is not a relationship that exists.
 */
export function resolveMentions(body: string, paths: PathIndex): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of extractPathMentions(body)) {
    const id = paths.get(path) ?? enclosingModule(path, paths);
    if (id === null || id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The nearest ancestor directory of `path` that is an indexed module, or
 * `null`. Longest first, so `src/core/graph/x.ts` prefers `src/core/graph`
 * over `src/core` when both are modules.
 */
function enclosingModule(path: string, paths: PathIndex): string | null {
  const segments = path.split("/");
  for (let cut = segments.length - 1; cut > 0; cut--) {
    const ancestor = segments.slice(0, cut).join("/");
    const id = paths.get(ancestor);
    // Only a module may absorb a mention of something inside it.
    if (id !== undefined && id.startsWith("module:")) return id;
  }
  return null;
}
