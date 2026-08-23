# Research: what to borrow from codebase-memory-mcp

> Status: **research brief** — input for a future `/weave-scan` improvement milestone. Nothing here is integrated yet. See `docs/TODO.md`
> Todo 3.

## Summary

codebase-memory-mcp is a single static C binary that builds a persistent tree-sitter knowledge graph (functions, classes, call chains,
routes) in SQLite and exposes ~15 MCP tools, deliberately shipping **no LLM** — the agent client is the intelligence layer. For pi-weave's
git-aware, derived `.okf` index, the transferable ideas are the dependency-free ones (layered ignoring, content-hash incremental indexing,
git-diff impact mapping, honest index-coverage reporting); everything needing a syntax/type model (tree-sitter symbol/call graphs,
communities, dead-code, semantic search, SQLite+Cypher) violates the near-zero-deps and plain-files rules and belongs in the
already-reserved Phase 2 Level 2 design space.

## Findings

1. **Diff-impact view transfers cleanly and is the top navigation win** — our staleness report already knows the changed-file set; mapping
   it onto existing `structure.json` module/package membership turns "index is stale" into "these modules are affected by your uncommitted
   work," using plain `git diff` + data we already have. [Source](https://github.com/DeusData/codebase-memory-mcp)

2. **Honest coverage reporting transfers cheaply** — deep scan already counts `skippedTooBig`/`skippedFresh`/`failed`; surfacing a coverage
   summary (skipped-by-design vs. too-big vs. binary vs. ignored) makes the index's blind spots visible and builds trust.
   [Source](https://github.com/DeusData/codebase-memory-mcp)

3. **A project-level ignore file (`.okfignore`, gitignore syntax) is the missing ignoring layer** — we already exclude via `git ls-files`,
   but a user-facing ignore file lets users carve out tracked-but-noisy dirs from both light and deep scans.
   [Source](https://github.com/DeusData/codebase-memory-mcp)

4. **Incremental light scan is a natural extension** — deep scan already stores per-file sha1 and skips unchanged files; the light
   `structure.json` is still rebuilt wholesale, so reusing the content-hash anchor to re-derive only changed files is a free win.
   [Source](https://arxiv.org/abs/2603.27277)

5. **The deps line is clean** — tree-sitter symbol/call graphs, Hybrid LSP, Louvain communities, dead-code, semantic/embedding search, and
   the SQLite+Cypher store all need deps we deliberately don't take (native parsers, embedding models, an opaque DB), so they stay in the
   Phase 2 Level 2 design space. [Source](https://github.com/DeusData/codebase-memory-mcp)

## Sources

- Kept: [codebase-memory-mcp README](https://github.com/DeusData/codebase-memory-mcp) — primary source for features, tools, ignoring model,
  and the "no built-in LLM" stance.
- Kept: [arXiv preprint 2603.27277](https://arxiv.org/abs/2603.27277) — design/benchmark paper (multi-pass pipeline, content-hash
  incremental sync, call resolution, community detection).
- Kept: [project homepage](https://deusdata.github.io/codebase-memory-mcp/) — corroborates token-efficiency and feature claims.
- Dropped: DEV.to explainer — secondary commentary; adds nothing beyond the README/paper.

## Gaps

- Did not run codebase-memory-mcp locally; its latency/quality numbers are the project's own benchmarks.
- Diff-impact and coverage ideas are assessed from README tool descriptions, not source; output shapes would be designed fresh for `.okf`.
- Next step: prototype the diff-impact view and coverage summary in `src/core` (no deps) and validate against a real repo before folding
  into `docs/scan-modes.md`.
