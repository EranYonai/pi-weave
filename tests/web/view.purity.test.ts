/**
 * The purity guard behind the `src/web/shared/view.ts` door
 * (weave-workspace §2.1, §3).
 *
 * ## What this defends, and why it is load-bearing
 *
 * §2.1 records a rule paid for with a broken build: *nothing under
 * `src/web/shared/` imports `src/core`, not even as a type*. One
 * `import type { GraphModel }` produced 24 `Cannot find module 'node:fs'`
 * errors under `tsconfig.web.json`, because type erasure is a **bundler**
 * distinction and not a **compiler** one — the compiler resolves the target
 * module and walks its whole transitive closure regardless of the keyword.
 *
 * `src/web/shared/view.ts` is a deliberate, documented exception to that rule.
 * The reasoning that justifies it is a *property of a specific closure*, not a
 * change of mind about core: the eleven modules reachable from
 * `src/core/view/` are pure functions over plain data with no `node:*` import,
 * no Node global and no npm dependency anywhere in them. §3's whole purpose is
 * that the TUI and the browser share one implementation of the tree and detail
 * projections, and a blanket ban forced either a second implementation or
 * server-side pre-rendering — both of which are the drift §3 exists to
 * prevent.
 *
 * A property nobody checks is an assumption. **This file is the check.** If a
 * future change adds `import { readFileSync } from "node:fs"` to
 * `src/core/view/tree.ts`, that is a perfectly reasonable thing to do to a
 * core module and a catastrophic thing to do to one the browser bundles — and
 * without this suite it would surface as a runtime explosion in a user's
 * browser, in whichever column happened to touch the tree first. Here it is a
 * red test, on the commit that introduces it, naming the exact chain.
 *
 * ## The two halves
 *
 * 1. **Runtime**: walk the transitive closure from the door and assert
 *    node-freedom over the source text — imports, globals, npm specifiers.
 *    Modelled on the closure walk in `./tiers.test.ts`, whose machinery it
 *    literally shares (`./importGraph`) rather than reimplementing.
 * 2. **Type-level**: assert that `tsconfig.web.json` — `"types": []`, a `lib`
 *    with no Node types — actually *includes* this path, so `npm run
 *    typecheck` compiles the closure under browser settings. That is the check
 *    that produced the original 24 errors; pointing it at the door is what
 *    turns "we believe this compiles for a browser" into "CI proves it".
 *
 * Neither half alone is sufficient. The text scan cannot see a type-level
 * dependency on `@types/node` (a bare `NodeJS.Timeout` annotation imports
 * nothing); the typecheck cannot see a global read that happens to be legal in
 * the DOM lib. Together they cover the failure §2.1 describes.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  NODE_FREE_CORE_MODULES,
  NODE_GLOBALS,
  reachableFrom,
  rel,
  renderChain,
  ROOT,
  SRC,
  code,
  specifiers,
  tierOf,
} from "./importGraph";

// The door, and the core modules it claims to be a pass-through for. Importing
// both is legal here for the same reason `wire.contract.test.ts` may import
// core: this is a Node-side test, not client-reachable code.
import * as door from "../../src/web/shared/view";
import * as coreCluster from "../../src/core/view/cluster";
import * as coreDetail from "../../src/core/view/detail";
import * as coreFocus from "../../src/core/view/focus";
import * as coreLinks from "../../src/core/view/links";
import * as coreTime from "../../src/core/view/time";
import * as coreTree from "../../src/core/view/tree";

/** The one legal door from the browser tier onto the core view-models. */
const DOOR = join(SRC, "web", "shared", "view.ts");

/**
 * npm specifiers anything behind the door may import.
 *
 * Empty, and the emptiness is the point: `src/core/view/` is pure computation
 * over plain data. A dependency appearing there is a design decision with a
 * bundle-size consequence for the browser (§14's budget) and belongs in a PR
 * that says so, not in a transitive import nobody notices.
 */
const PERMITTED_NPM: ReadonlySet<string> = new Set();

async function closure(): Promise<Map<string, readonly { from: string; spec: string }[]>> {
  return reachableFrom([DOOR]);
}

describe("src/web/shared/view.ts opens a node-free closure (weave-workspace §2.1)", () => {
  it("the door exists and re-exports rather than reimplements", async () => {
    // The exception is only defensible because there is one implementation.
    // A wrapper — `export function treeRows(…) { return coreTreeRows(…); }` —
    // would be a second implementation with its own edge cases, which is
    // exactly the TUI/web drift §3 was promoted to prevent. So the door is
    // required to be *nothing but* re-exports: no function bodies, no
    // constants, no logic to get subtly different from core's.
    const text = code(await fs.readFile(DOOR, "utf8"));
    const statements = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    const nonReexport = statements.filter((l) => !/^export (type )?\{[^}]*\} from "[^"]+";$/.test(l));
    expect(nonReexport).toEqual([]);
  });

  it("every runtime export is the identical binding from core", () => {
    // The strongest available statement of "one implementation" (§3), and the
    // runtime complement to the source-text check above.
    //
    // The text check proves the *file* contains only re-export syntax. This
    // proves the *bindings* are core's own function objects — `===`, not
    // "behaves the same". A wrapper, a `.bind`, a defensive copy or a
    // re-declaration would all pass a behavioural test on the day it was
    // written and then drift; none of them can pass reference equality. It is
    // also what makes the door free: there is no second code path to test,
    // because there is no second code path.
    const bindings: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["treeRows", door.treeRows, coreTree.treeRows],
      ["listLabel", door.listLabel, coreTree.listLabel],
      ["treeEmptyHint", door.treeEmptyHint, coreTree.treeEmptyHint],
      ["relTime", door.relTime, coreTime.relTime],
      ["formatTreeMeta", door.formatTreeMeta, coreTime.formatTreeMeta],
      ["detailModel", door.detailModel, coreDetail.detailModel],
      ["focusModel", door.focusModel, coreFocus.focusModel],
      ["deriveBacklinks", door.deriveBacklinks, coreLinks.deriveBacklinks],
      // P3's three additions (§2.1.1 predicted exactly these). The graph's
      // neighbourhood highlight and the context rail's "Related" must be the
      // same set, and the graph's cluster collapse and the TUI tree must agree
      // about what "collapsed" means — which holds because both call one
      // function object, not two that behave alike today.
      ["focusNeighborhood", door.focusNeighborhood, coreFocus.focusNeighborhood],
      ["degreeOf", door.degreeOf, coreFocus.degreeOf],
      ["clusterAggregate", door.clusterAggregate, coreCluster.clusterAggregate],
    ];
    for (const [name, viaDoor, viaCore] of bindings) {
      expect(typeof viaDoor, name).toBe("function");
      expect(viaDoor, name).toBe(viaCore);
    }
    // And the door exports nothing at runtime beyond those — a value arriving
    // here that is not core's is exactly the wrapper this forbids. (Types
    // erase, so they are invisible to `Object.keys` and are covered by the
    // source-text check instead.)
    expect(Object.keys(door).sort()).toEqual(bindings.map(([name]) => name).sort());
  });

  it("reaches something — the walk is not vacuous", async () => {
    // Every assertion below is of the form "nothing in the closure does X",
    // which a closure of size 1 satisfies trivially. Pin the shape first.
    const reachable = await closure();
    expect(reachable.size).toBeGreaterThan(1);
    const core = [...reachable.keys()].filter((abs) => tierOf(abs) === "src/core");
    expect(core.length).toBeGreaterThan(0);
  });

  it("its core closure is exactly NODE_FREE_CORE_MODULES", async () => {
    // Both directions, deliberately.
    //
    // *Subset* is the safety property: the tier guard grants `src/web/shared`
    // access to precisely this list, so a module reachable from the door but
    // absent from it would be access granted by accident.
    //
    // *Superset* is the hygiene property: an entry no longer reachable is a
    // permission nobody is auditing, still standing open for the next module
    // that wants it. Equality means the list can only change when someone
    // edits it on purpose.
    const reachable = await closure();
    const core = [...reachable.keys()]
      .filter((abs) => tierOf(abs) === "src/core")
      .map((abs) => rel(abs))
      .sort();
    expect(core).toEqual([...NODE_FREE_CORE_MODULES].sort());
  });

  it("no module in the closure imports node:*", async () => {
    // The headline assertion. `node:fs` in `src/core/view/tree.ts` fails here,
    // by name, with the chain that reached it.
    const reachable = await closure();
    const offenders: string[] = [];
    for (const [abs, chain] of reachable) {
      const text = await fs.readFile(abs, "utf8");
      for (const spec of specifiers(text)) {
        if (!spec.startsWith("node:")) continue;
        offenders.push(`${renderChain(rel(DOOR), chain)} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no module in the closure touches a node global", async () => {
    // `node:*` is not the only way in. `process.env.HOME` needs no import and
    // is `undefined is not an object` in a browser; `Buffer.from` is a
    // `ReferenceError`. Comment-stripped, so a module header may discuss them.
    const reachable = await closure();
    const offenders: string[] = [];
    for (const abs of reachable.keys()) {
      const text = code(await fs.readFile(abs, "utf8"));
      for (const g of NODE_GLOBALS) {
        if (new RegExp(`\\b${g}\\b`).test(text)) offenders.push(`${rel(abs)} → ${g}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no module in the closure imports an npm package", async () => {
    // A bare specifier is not followed by the walk (that is `node_modules`'
    // job, not a guard's), so it has to be checked where it is written.
    // Anything landing here is a byte cost the browser pays for a core
    // refactor, which §14's budget says must be a deliberate edit.
    const reachable = await closure();
    const offenders: string[] = [];
    for (const abs of reachable.keys()) {
      const text = await fs.readFile(abs, "utf8");
      for (const spec of specifiers(text)) {
        if (spec.startsWith(".") || spec.startsWith("node:") || PERMITTED_NPM.has(spec)) continue;
        offenders.push(`${rel(abs)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the closure contains no tier the browser may not bundle", async () => {
    // Belt and braces against the door being widened sideways rather than
    // downwards: a `src/pi` or `src/web/server` module appearing behind it is
    // as fatal as a `node:fs`, and would otherwise only be caught once the
    // client imported the door (which is `tiers.test.ts`' check, one layer
    // later and with a worse error message).
    const permitted = new Set(["src/web/shared", "src/core"]);
    const reachable = await closure();
    const offenders: string[] = [];
    for (const [abs, chain] of reachable) {
      const tier = tierOf(abs);
      if (tier !== null && permitted.has(tier)) continue;
      offenders.push(`${renderChain(rel(DOOR), chain)} (${tier ?? "outside every tier"})`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the closure is typechecked under browser settings (weave-workspace §2.1)", () => {
  /**
   * The type-level half.
   *
   * `tsc -p tsconfig.web.json` is where the original 24 errors came from, and
   * it only says anything about a file it is asked to compile. A door that
   * `include` did not reach would be checked exclusively by the root project —
   * which has `"types": ["node"]` and would therefore accept a `node:fs` in
   * the closure without a murmur, leaving the runtime scan above as the only
   * guard and the type-level failure mode entirely unwatched.
   *
   * So the configuration itself is asserted. This is a cheap check for a
   * silent, total loss of coverage.
   */
  async function webConfig(): Promise<{ include: string[]; types: string[]; lib: string[] }> {
    const text = await fs.readFile(join(ROOT, "tsconfig.web.json"), "utf8");
    // tsconfig is JSONC and the file is comment-heavy on purpose, so the
    // comments have to go before `JSON.parse`. Whole-line `//` only —
    // deliberately *not* `code()` from `./importGraph`, whose block-comment
    // rule sees the `/**/` inside `"src/web/client/**/*.ts"` as a comment and
    // silently eats half the glob. Every comment in this file is a full-line
    // one, and the assertions below fail loudly if that ever stops being true.
    const stripped = text.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(stripped) as {
      include?: string[];
      compilerOptions?: { types?: string[]; lib?: string[] };
    };
    return {
      include: parsed.include ?? [],
      types: parsed.compilerOptions?.types ?? [],
      lib: parsed.compilerOptions?.lib ?? [],
    };
  }

  it("tsconfig.web.json includes src/web/shared", async () => {
    const { include } = await webConfig();
    expect(include).toContain("src/web/shared/**/*.ts");
  });

  it("tsconfig.web.json still has no node types", async () => {
    // The settings that give the inclusion its teeth. `"types": []` keeps
    // `@types/node` out of the global scope and the `lib` list carries no Node
    // typings, so `node:fs` in the closure is `Cannot find module` rather than
    // a clean compile. Loosening either one would leave `include` pointing at
    // the door while checking nothing that matters.
    const { types, lib } = await webConfig();
    expect(types).toEqual([]);
    expect(lib).not.toContain("node");
  });

  it("the door is under a path tsconfig.web.json includes", async () => {
    // Stated against the file rather than the glob, so moving `view.ts` — or
    // renaming the directory, or tightening the pattern to
    // `src/web/shared/wire.ts` — cannot leave an `include` entry that still
    // reads plausibly while matching nothing.
    const { include } = await webConfig();
    expect(include.some((pattern) => matchesGlob(pattern, rel(DOOR)))).toBe(true);
    expect(await fs.stat(DOOR).then((s) => s.isFile())).toBe(true);
  });

  /**
   * tsconfig's `include` glob subset, as a regex: `**` spans directories
   * (including none), `*` stops at a separator, everything else is literal.
   *
   * Hand-rolled rather than pulled from a package because the alternative is
   * an npm dependency (AGENTS.md: near-zero) for four lines, and because the
   * two patterns this repository actually uses are the two spellings below.
   */
  function matchesGlob(pattern: string, path: string): boolean {
    const source = pattern
      .split("/")
      .map((segment) =>
        segment === "**" ? "(?:[^/]+/)*[^/]*" : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
      )
      .join("/")
      // `a/**/b` must also match `a/b`: the `**` segment already absorbs its
      // own trailing separator, so collapse the one the join added.
      .replace(/\(\?:\[\^\/\]\+\/\)\*\[\^\/\]\*\//g, "(?:[^/]+/)*");
    return new RegExp(`^${source}$`).test(path);
  }
});
