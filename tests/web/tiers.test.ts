/**
 * The tier import guard — an executable form of the weave-workspace §2 table
 * and AGENTS.md rule 3.
 *
 * | Tier                | May import                            | Must never import                                   |
 * | ------------------- | ------------------------------------- | --------------------------------------------------- |
 * | `src/core/**`       | node builtins, itself                 | `@earendil-works/*`, typebox, `src/web`, `src/pi`, npm UI deps |
 * | `src/web/shared/**` | itself, the node-free core modules    | `node:*`, DOM globals, `src/pi`, **the rest of `src/core`** |
 * | `src/web/server/**` | node builtins, `src/core`, `…/shared` | DOM, `src/web/client`, `@earendil-works/*`          |
 * | `src/web/client/**` | `src/web/shared`, browser deps        | `node:*`, `src/core`, `src/pi`                      |
 * | `src/pi/**`         | everything                            | —                                                    |
 *
 * This file is the **single source of truth** for those rules; it absorbed the
 * former `tests/core/purity.test.ts` and the tier half of
 * `tests/web/isomorphism.test.ts`. Splitting the table across three files made
 * it easy to add a tier and enforce two thirds of it, which is how the client
 * rules went unenforced for a phase.
 *
 * The graph machinery it is stated over lives in `./importGraph`, shared with
 * `./view.purity.test.ts` so the two guards cannot disagree about what is
 * reachable. The rules stay here.
 *
 * ## Two properties worth stating explicitly
 *
 * **Not-yet-existing tiers cost nothing and are covered the moment they
 * land.** {@link walk} returns `[]` for a missing directory and the per-tier
 * assertions pass vacuously. Nothing is hardcoded — the day the directory is
 * created it is walked and checked, with no edit here.
 *
 * **A new tier cannot appear unnoticed.** "every source file belongs to a
 * declared tier" fails on any `.ts`/`.tsx` under `src/` that {@link TIERS}
 * does not claim, so `src/opencode/` (or a stray `src/util.ts`) is a red test
 * until the table grows to describe it. Together those two properties are what
 * make a directory walk stronger than a file list: coverage grows with the
 * tree in one direction and refuses to grow silently in the other.
 *
 * ## Imports are resolved, not pattern-matched
 *
 * A relative specifier is resolved against the importing file and then
 * classified by which tier's directory it lands in. `../../core/graph/model`
 * from `src/web/client/graph/` is therefore identified as a core import even
 * though the string contains no tier name, and renaming a directory can never
 * quietly disarm a rule.
 *
 * ## Direct rules are not enough
 *
 * Every per-tier check below is single-hop, and single-hop checks were all
 * green while `src/web/client/api.ts` reached `src/core` through
 * `src/web/shared/wire.ts` — two individually-legal edges composing into a
 * violation that broke `tsc -p tsconfig.web.json` with 24 errors. The
 * "client bundle is transitively free of core and node" block walks the
 * **closure**, which is the form the §2 table was always making a claim
 * about.
 *
 * ## The `src/web/shared` → `src/core/view` exception
 *
 * §2.1 originally read "nothing under `src/web/shared/` imports `src/core` at
 * all". That is now narrowed to a **module allowlist**
 * ({@link NODE_FREE_CORE_MODULES}) rather than dropped: `src/web/shared/view.ts`
 * re-exports the §3 view-models so the browser and the TUI share one
 * implementation, and every other core module — anything that touches the
 * filesystem or spawns git — stays as forbidden as it was. See
 * `./view.purity.test.ts` for the proof that the permitted closure is
 * node-free, and `importGraph.ts` for why the list is spelled as modules.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALL_TIERS,
  DOM_GLOBALS,
  NODE_FREE_CORE_MODULES,
  NODE_GLOBALS,
  reachableFrom,
  rel,
  renderChain,
  resolveSpec,
  ROOT,
  SRC,
  code,
  specifiers,
  statements,
  tierOf,
  walk,
} from "./importGraph";

// --- the table ---------------------------------------------------------------

interface Tier {
  /** Repo-relative directory, and the name used in failure messages. */
  readonly id: string;
  /**
   * Bare (npm) specifiers this tier may import, or `null` for "anything".
   *
   * Deliberately an allowlist, not a denylist: a new runtime dependency should
   * be a visible edit to this table with the §0.1 measurements in the PR, not
   * something that arrives with an `npm install`. That mechanism has now been
   * exercised twice as designed: P2.4's note column needed `marked` and
   * `dompurify` (§0 V5), and P3's graph column needs `sigma` and `graphology`
   * (§0 V1, V3) — so the commit that first imports each is also the commit
   * that adds it below, with the bundle delta measured against P1's 14.8 KiB
   * gzip baseline.
   */
  readonly npm: ReadonlySet<string> | null;
  /** Tiers whose modules this one may import as values. Includes itself. */
  readonly imports: readonly string[];
  /**
   * Tiers this one may reference for **types only**. A value import from core
   * into an isomorphic module would drag `node:fs` into the browser bundle;
   * `import type` erases at compile time and cannot.
   */
  readonly typeOnly: readonly string[];
  /**
   * Individual modules of an otherwise-forbidden tier this one may import.
   *
   * The escape hatch that keeps a narrowed rule from becoming a blanket one.
   * `src/web/shared` may reach `src/core/view/tree.ts`; it may not reach
   * `src/core/vault.ts`, and the difference has to be expressible or the
   * exception is not worth having.
   */
  readonly moduleExceptions: ReadonlySet<string>;
  readonly nodeBuiltins: boolean;
  readonly domGlobals: boolean;
  readonly extensions: readonly string[];
}

const NO_EXCEPTIONS: ReadonlySet<string> = new Set();

const TIERS: readonly Tier[] = [
  {
    id: "src/core",
    npm: new Set(),
    imports: ["src/core"],
    typeOnly: [],
    moduleExceptions: NO_EXCEPTIONS,
    nodeBuiltins: true,
    domGlobals: false,
    extensions: [".ts"],
  },
  {
    id: "src/web/shared",
    // d3-force is the sole permitted npm import (§0 V2).
    npm: new Set(["d3-force"]),
    imports: ["src/web/shared"],
    // Still empty, and still deliberately stricter than the §2 table's
    // original "core types only". `import type` erases from the bundle but
    // **not** from the typecheck: the compiler resolves the target module
    // either way, so a *type-only* concession would not have prevented the 24
    // errors and does not describe what makes the view closure safe. What
    // makes it safe is that the modules themselves are node-free — a property
    // of the target, not of the import keyword — so the concession is spelled
    // as {@link Tier.moduleExceptions} below.
    typeOnly: [],
    // The §2.1 narrowing. `src/web/shared/view.ts` re-exports the §3
    // view-models; `./view.purity.test.ts` proves this exact set stays free of
    // `node:*`, node globals and npm, and fails if it stops being.
    moduleExceptions: NODE_FREE_CORE_MODULES,
    nodeBuiltins: false,
    domGlobals: false,
    extensions: [".ts"],
  },
  {
    id: "src/web/server",
    // Node builtins and first-party code only. No harness, no npm.
    npm: new Set(),
    imports: ["src/web/server", "src/web/shared", "src/core"],
    typeOnly: [],
    moduleExceptions: NO_EXCEPTIONS,
    nodeBuiltins: true,
    domGlobals: false,
    extensions: [".ts"],
  },
  {
    id: "src/web/client",
    npm: new Set(["preact", "preact/hooks", "preact/jsx-runtime", "@preact/signals", "marked", "dompurify", "sigma", "graphology"]),
    // Unchanged by the §2.1 narrowing, and that is the point: the client
    // reaches the view-models through `src/web/shared/view.ts`, never
    // directly. One door, one guard on it.
    imports: ["src/web/client", "src/web/shared"],
    typeOnly: [],
    moduleExceptions: NO_EXCEPTIONS,
    nodeBuiltins: false,
    domGlobals: true,
    extensions: [".ts", ".tsx"],
  },
  {
    id: "src/pi",
    // The adapter is where harness packages are allowed to exist at all.
    npm: null,
    imports: [...ALL_TIERS],
    typeOnly: [],
    moduleExceptions: NO_EXCEPTIONS,
    nodeBuiltins: true,
    domGlobals: true,
    extensions: [".ts", ".tsx"],
  },
];

// --- source scanning ----------------------------------------------------------

interface Module {
  /** Absolute path. */
  readonly abs: string;
  /** Path relative to the repository root, for failure messages. */
  readonly rel: string;
  readonly text: string;
}

async function modulesOf(tier: Tier): Promise<Module[]> {
  const files = await walk(join(ROOT, tier.id), tier.extensions);
  return Promise.all(files.map(async (abs) => ({ abs, rel: rel(abs), text: await fs.readFile(abs, "utf8") })));
}

/**
 * Resolve a relative specifier to the repo-relative module file it names, so
 * it can be matched against {@link Tier.moduleExceptions}.
 *
 * Deliberately synchronous and extension-only: the exception list names
 * concrete `.ts` files, and a specifier that resolves to a directory barrel is
 * *not* one of them — `import … from "../../core/view"` must stay a violation
 * even though every file in that directory is individually permitted, because
 * the barrel also re-exports `health.ts` and `cluster.ts`.
 */
function exceptionPathFor(from: string, spec: string): string {
  return `${rel(resolveSpec(from, spec))}.ts`;
}

// --- the checks ---------------------------------------------------------------

describe("tier import rules (weave-workspace §2)", () => {
  it("every source file belongs to a declared tier", async () => {
    // The guard against a new tier appearing with no rules attached to it.
    const all = await walk(SRC, [".ts", ".tsx"]);
    expect(all.length).toBeGreaterThan(0);
    const orphans = all.filter((abs) => tierOf(abs) === null).map((abs) => rel(abs));
    expect(orphans).toEqual([]);
  });

  it("finds source in every tier that exists on disk", async () => {
    // Not an existence requirement — a tier directory is legitimately allowed
    // to be absent, so its checks pass vacuously and start biting the day the
    // directory appears. What this *does* catch is a path typo in
    // {@link TIERS}: a tier whose directory exists but whose walk returns
    // nothing is a rule silently switched off, which is worse than no rule.
    const empty: string[] = [];
    for (const tier of TIERS) {
      const exists = await fs.stat(join(ROOT, tier.id)).then(
        () => true,
        () => false,
      );
      if (exists && (await modulesOf(tier)).length === 0) empty.push(tier.id);
    }
    expect(empty).toEqual([]);
    // And the table is not vacuous overall.
    const scanned = (await Promise.all(TIERS.map(async (t) => (await modulesOf(t)).length))).reduce((a, b) => a + b, 0);
    expect(scanned).toBe((await walk(SRC, [".ts", ".tsx"])).length);
  });

  for (const tier of TIERS) {
    describe(tier.id, () => {
      it("imports only from permitted tiers", async () => {
        const permitted = new Set([...tier.imports, ...tier.typeOnly]);
        const offenders: string[] = [];
        for (const mod of await modulesOf(tier)) {
          for (const spec of specifiers(mod.text)) {
            if (!spec.startsWith(".")) continue;
            const target = tierOf(resolveSpec(mod.abs, spec));
            if (target === null) offenders.push(`${mod.rel} → ${spec} (outside every tier)`);
            else if (permitted.has(target)) continue;
            else if (tier.moduleExceptions.has(exceptionPathFor(mod.abs, spec))) continue;
            else offenders.push(`${mod.rel} → ${spec} (${target})`);
          }
        }
        expect(offenders).toEqual([]);
      });

      it("uses every module exception it declares", async () => {
        // A stale exception is a rule granting access nobody audits any more.
        // The permitted set is small and hand-maintained precisely so that
        // removing the last import of a module removes it from the list in the
        // same commit; without this check it would linger, and the next module
        // to want that path would find the door already open.
        if (tier.moduleExceptions.size === 0) return;
        const used = new Set<string>();
        for (const mod of await modulesOf(tier)) {
          for (const spec of specifiers(mod.text)) {
            if (!spec.startsWith(".")) continue;
            const path = exceptionPathFor(mod.abs, spec);
            if (tier.moduleExceptions.has(path)) used.add(path);
          }
        }
        // Only *directly* imported modules appear here; the rest of the
        // allowlist is reached transitively and is checked for exactly that in
        // `view.purity.test.ts`. So this asserts the list is not wholly
        // fictional, and the purity suite asserts it is not loose.
        expect(used.size).toBeGreaterThan(0);
        for (const path of used) expect(tier.moduleExceptions.has(path)).toBe(true);
      });

      it("declares only allowlisted npm dependencies", async () => {
        if (tier.npm === null) return;
        const allowed = tier.npm;
        const offenders: string[] = [];
        for (const mod of await modulesOf(tier)) {
          for (const spec of specifiers(mod.text)) {
            if (spec.startsWith(".") || spec.startsWith("node:") || allowed.has(spec)) continue;
            offenders.push(`${mod.rel} → ${spec}`);
          }
        }
        expect(offenders).toEqual([]);
      });

      it(tier.nodeBuiltins ? "may use node builtins" : "imports no node builtins", async () => {
        const offenders: string[] = [];
        for (const mod of await modulesOf(tier)) {
          for (const spec of specifiers(mod.text)) {
            if (spec.startsWith("node:") && !tier.nodeBuiltins) offenders.push(`${mod.rel} → ${spec}`);
          }
        }
        expect(offenders).toEqual([]);
      });

      it(tier.nodeBuiltins ? "may use node globals" : "touches no node globals", async () => {
        if (tier.nodeBuiltins) return;
        const offenders: string[] = [];
        for (const mod of await modulesOf(tier)) {
          for (const g of NODE_GLOBALS) {
            if (new RegExp(`\\b${g}\\b`).test(code(mod.text))) offenders.push(`${mod.rel} → ${g}`);
          }
        }
        expect(offenders).toEqual([]);
      });

      it(tier.domGlobals ? "may touch DOM globals" : "touches no DOM globals", async () => {
        if (tier.domGlobals) return;
        const offenders: string[] = [];
        for (const mod of await modulesOf(tier)) {
          for (const g of DOM_GLOBALS) {
            if (new RegExp(`\\b${g}\\b`).test(code(mod.text))) offenders.push(`${mod.rel} → ${g}`);
          }
        }
        expect(offenders).toEqual([]);
      });

      it("reaches type-only tiers with `import type` only", async () => {
        if (tier.typeOnly.length === 0) return;
        const typeOnly = new Set(tier.typeOnly);
        const offenders: string[] = [];
        for (const mod of await modulesOf(tier)) {
          for (const { clause, spec } of statements(mod.text)) {
            if (!spec.startsWith(".")) continue;
            const target = tierOf(resolveSpec(mod.abs, spec));
            if (target === null || !typeOnly.has(target)) continue;
            if (!/^type\b/.test(clause)) offenders.push(`${mod.rel} → ${spec} (${clause})`);
          }
        }
        expect(offenders).toEqual([]);
      });
    });
  }
});

describe("the client bundle is transitively free of node (weave-workspace §2)", () => {
  /**
   * Why this exists as a separate, transitive check.
   *
   * The per-tier rules above are all **direct**: for each file, classify the
   * specifiers it writes down. Every one of them passed while the client was
   * importing core, because the violation was a *composition* of two legal
   * edges — `client → shared` is permitted, `shared → core` was permitted as
   * "types only", and nothing anywhere composed them. The build failed with
   * 24 `Cannot find module 'node:fs'` errors; the guard that was supposed to
   * prevent exactly this was green.
   *
   * A tier table is a statement about reachability, not about single hops. So
   * this walks the closure.
   */
  async function clientEntries(): Promise<string[]> {
    const files = await walk(join(SRC, "web", "client"), [".ts", ".tsx"]);
    expect(files.length).toBeGreaterThan(0);
    return files;
  }

  it("reaches only the node-free core modules, however indirectly", async () => {
    // Formerly "reaches no src/core module". The §2.1 narrowing means the
    // client legitimately reaches the §3 view-models through
    // `src/web/shared/view.ts` — but only those, and only through that door.
    // A chain ending at `core/vault.ts` is still the original violation and
    // still fails here.
    const reachable = await reachableFrom(await clientEntries());
    const offenders: string[] = [];
    for (const [abs, chain] of reachable) {
      if (tierOf(abs) !== "src/core") continue;
      if (NODE_FREE_CORE_MODULES.has(rel(abs))) continue;
      // The chain's first hop names the client file that started it.
      const entry = chain[0]?.from ?? rel(abs);
      offenders.push(renderChain(entry, chain));
    }
    expect(offenders).toEqual([]);
  });

  it("reaches core only through src/web/shared/view.ts", async () => {
    // The permission is attached to a *door*, not to the core modules
    // themselves. Without this, a second `src/web/shared/…` file could import
    // `core/view/tree.ts` directly and pass every other check — and then there
    // are two doors, only one of which anybody remembers to look at.
    const door = join(SRC, "web", "shared", "view.ts");
    const reachable = await reachableFrom(await clientEntries());
    const offenders: string[] = [];
    for (const [abs, chain] of reachable) {
      if (tierOf(abs) !== "src/core") continue;
      if (chain.some((hop) => hop.from === rel(door))) continue;
      offenders.push(renderChain(chain[0]?.from ?? rel(abs), chain));
    }
    expect(offenders).toEqual([]);
    // …and the door is real, not a path that silently matches nothing.
    expect(await fs.stat(door).then((s) => s.isFile())).toBe(true);
  });

  it("reaches no src/pi module, however indirectly", async () => {
    const reachable = await reachableFrom(await clientEntries());
    const offenders: string[] = [];
    for (const [abs, chain] of reachable) {
      if (tierOf(abs) !== "src/pi") continue;
      offenders.push(renderChain(chain[0]?.from ?? rel(abs), chain));
    }
    expect(offenders).toEqual([]);
  });

  it("no module in the client's reachable set imports node:*", async () => {
    // The failure mode the typecheck reports, stated directly: it is not
    // "core is forbidden" that matters to the browser, it is that something
    // reachable pulls in a Node builtin. Checking this independently of the
    // core rule means a future `src/web/shared/fs-ish.ts` is caught even
    // though it lives in a tier the client is allowed to import — and, since
    // §2.1's narrowing, it is also the check that catches a `node:fs` added to
    // `src/core/view/tree.ts`.
    const reachable = await reachableFrom(await clientEntries());
    const offenders: string[] = [];
    for (const [abs, chain] of reachable) {
      const text = await fs.readFile(abs, "utf8");
      for (const spec of specifiers(text)) {
        if (!spec.startsWith("node:")) continue;
        offenders.push(`${renderChain(chain[0]?.from ?? rel(abs), chain)} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches only tiers the client may import", async () => {
    // The positive form: whatever the closure contains must be client, shared,
    // or one of the explicitly allowlisted core modules. Catches a tier that
    // gets added later without anyone revisiting the negative checks above.
    const permitted = new Set(["src/web/client", "src/web/shared"]);
    const reachable = await reachableFrom(await clientEntries());
    const offenders: string[] = [];
    for (const [abs, chain] of reachable) {
      const tier = tierOf(abs);
      if (tier !== null && permitted.has(tier)) continue;
      if (NODE_FREE_CORE_MODULES.has(rel(abs))) continue;
      offenders.push(`${renderChain(chain[0]?.from ?? rel(abs), chain)} (${tier ?? "outside every tier"})`);
    }
    expect(offenders).toEqual([]);
  });

  it("actually traverses more than the entry files", async () => {
    // A traversal that silently resolved nothing would pass every check above
    // while proving nothing at all. `api.ts` imports `../shared/wire`, so the
    // closure must be strictly larger than the client tier itself.
    const entries = await clientEntries();
    const reachable = await reachableFrom(entries);
    expect(reachable.size).toBeGreaterThan(entries.length);
    const shared = [...reachable.keys()].filter((abs) => tierOf(abs) === "src/web/shared");
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("src/core/view stays renderer-agnostic (weave-workspace §3)", () => {
  it("carries no terminal or harness concepts", async () => {
    // Narrower than the tier rule above: the promoted view-models are shared
    // by the TUI and the browser workspace, so they must not acquire theme
    // glue or column widths even from inside core.
    const files = await walk(join(SRC, "core", "view"), [".ts"]);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const abs of files) {
      const text = await fs.readFile(abs, "utf8");
      for (const spec of specifiers(text)) {
        if (spec.includes("/pi/") || /(^|\/)theme$/.test(spec)) offenders.push(`${rel(abs)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
