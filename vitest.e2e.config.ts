import { defineConfig } from "vitest/config";

// End-to-end runs: real pi in tmux + the browser workspace in Chromium.
// Kept out of `npm test` / the coverage gate (see docs/e2e.md); run with
// `npm run e2e`.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // One pi at a time: scenarios are slow-ish and share nothing, but
    // parallel TUIs make failures much harder to read.
    fileParallelism: false,
  },
});
