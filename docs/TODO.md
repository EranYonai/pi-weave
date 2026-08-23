# TODO

Work items that are not yet part of the design or implementation. Each item should eventually be folded into `docs/design.md` or a dedicated
doc before it is considered done.

## Todo 2 — Implement the redesigned notepad workflow in `docs/notepad.md`

The notepad skill (the smart-notepad face of pi-weave) is written up as `docs/notepad.md`. The doc exists; the remaining work is
implementing the redesigned workflow — explicit capture, AI finalization, raw notes preserved (see `docs/HANDOFF.md` §6).

## Todo 3 — Borrow ideas from codebase-memory-mcp

Reference: https://github.com/DeusData/codebase-memory-mcp

Do **not** integrate with it — instead, study the ideas and see which ones could make our automatic `/weave-scan` better.

Research brief: `docs/research-codebase-memory.md` (answers the open questions below). The transferable, dependency-free ideas are a
diff-impact view, honest index-coverage reporting, a `.okfignore` layer, and incremental light-scan re-derivation.
Tree-sitter/semantic/SQLite ideas stay in the Phase 2 Level 2 design space.

Open questions:

- Which ideas transfer cleanly to a git-aware, derived `.okf` index?
- Does any of it require dependencies we don't want (see the near-zero deps rule in `AGENTS.md`)?
- What would actually move the needle on navigation/readability vs. today?
