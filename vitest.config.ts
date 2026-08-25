import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Type-only modules. `src/core/view/types.ts` declares interfaces and
      // type aliases and nothing else, so it erases to an empty module: v8
      // reports 0/0/0/0 — zero covered of zero coverable — and the reporter
      // averages that in as a literal 0%, dragging the global figure down for
      // a file that has no runtime behaviour to test.
      //
      // Excluded rather than "fixed" with a test that imports it for the side
      // effect of touching it. Such a test asserts nothing, and a green tick
      // next to a file with no executable code is worth less than an honest
      // absence.
      //
      // Listed by exact path, never as a glob such as `**/types.ts`: a
      // pattern would silently swallow the next `types.ts` that *does* carry
      // a guard or a constant. Adding an entry here means proving the module
      // is type-only, and `docs/testing.md` §L5.2 states the policy.
      exclude: ["src/core/view/types.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
