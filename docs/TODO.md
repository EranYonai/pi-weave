# TODO

Work items that are not yet part of the design or implementation. Each item
should eventually be folded into `docs/design.md` or a dedicated doc before it
is considered done.

## Todo 1 — Two scan modes: light and "expensive"

`/weave-scan` should support two options:

- **Light scan** — what we do today (fast, structural).
- **Expensive scan** — take the files and summarize each one briefly, for
  better navigation and readability.

Rationale: the current scan gives structure but not content; a short summary
per file would make the derived index much more navigable and readable for
both humans and agents.

Open questions:
- Does this fit as a flag on the existing scan, or a separate command?
- Cost/latency tradeoffs — should the expensive mode be opt-in?
- Where do summaries live in the `.okf` derived index?

## Todo 2 — Implement the notepad skill as `docs/notepad.md`

The notepad skill (the smart-notepad face of pi-weave) should be written up as
`docs/notepad.md`. A doc already exists at `docs/notepad.md` — fold this TODO
into the actual implementation/documentation there.

## Todo 3 — Borrow ideas from codebase-memory-mcp

Reference: https://github.com/DeusData/codebase-memory-mcp

Do **not** integrate with it — instead, study the ideas and see which ones
could make our automatic `/weave-scan` better.

Open questions:

- Which ideas transfer cleanly to a git-aware, derived `.okf` index?
- Does any of it require dependencies we don't want (see the near-zero deps
  rule in `AGENTS.md`)?
- What would actually move the needle on navigation/readability vs. today?
