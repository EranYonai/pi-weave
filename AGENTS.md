# AGENTS.md — working on pi-weave

Guidance for any agent (or human) making changes in this repository. Read
`docs/design.md` first; it is the source of truth for *why*. This file is
about *how we work here*.

## What this project is

pi-weave is an agent-native knowledge workspace with **two faces**:

1. **Smart notepad** — a persistent vault of human/agent knowledge
   (`~/.okf/`, Markdown + front matter), usable through the `weave_note` tool.
2. **Repository exploration** — a derived, git-aware knowledge index of the
   repo you're standing in (`<repo>/.okf/`), usable through the `weave_repo`
   tool.

Both faces obey one rule: **artefacts are equally readable by humans and
agents** (plain files on disk, no opaque databases).

## Hard rules

1. **Never commit directly to `main`.** Create a feature branch
   (`feat/…`, `fix/…`), commit there, push, and open a PR with `gh pr create`.
2. **Test coverage must stay ≥ 95%** (lines, branches, functions,
   statements). The gate is enforced by `vitest --coverage` thresholds —
   `npm run coverage` fails below 95. Write tests *with* the feature, not
   after.
3. **`src/core/` must never import from `@earendil-works/*`, `typebox`, or
   any pi-specific package.** The core is the portable engine; adapters
   (`src/pi/`, future `src/claude-code/`, `src/opencode/`) are thin wires into
   harness APIs. All logic lives in core.
4. **Generated knowledge carries provenance** (`source: human | agent |
   generated`). Never let agent-written content masquerade as human-authored.
5. **`.okf` indexes are derived and rebuildable.** Nothing in them may be the
   only copy of anything.

## Repository layout

```text
src/core/      Portable knowledge engine (vault, git, repo index, workspace)
src/pi/        pi adapter: extension factory, tools, commands
skills/        Agent Skills (agentskills.io): weave-notepad, weave-explore
tests/         vitest suites mirroring src/ (tests/core, tests/pi)
docs/          design.md — the design document
```

## Commands

```bash
npm run typecheck   # tsc --noEmit (strict; must stay clean)
npm test            # vitest run (no coverage gate)
npm run coverage    # vitest run --coverage (the 95% gate)
npm run check       # typecheck + coverage — run before committing
```

## Testing conventions

- Unit tests live in `tests/core`, adapter tests in `tests/pi`.
- `tests/helpers.ts` provides temp dirs, real git-fixture builders
  (`gitInit`, `commitAll`, `writeFixture`), and a **mock pi harness**
  (`createMockPi`, `createMockCtx`) that records tool/command/event
  registrations. Test the adapter through that mock; test core through its
  plain async functions.
- Use real temporary git repositories for git behavior — don't mock git
  output; the fixtures are cheap and honest.
- Inject clocks (`now` parameters) instead of depending on wall time.
- The vault location is overridable via `PI_WEAVE_VAULT`; adapter tests use
  `withVaultEnv(...)` from helpers. Don't touch a developer's real
  `~/.okf` from a test.

## Trying the extension in pi

```bash
# project-local, hot-reloadable
mkdir -p .pi && ln -sfn ../.. .pi/extensions 2>/dev/null  # or point settings at it
pi -e ./src/pi/index.ts                                   # quick manual test
pi --mode rpc -e ./src/pi/index.ts                        # machine-driven smoke test
```

Smoke expectation: on session start pi's status line shows
`🧵 vault:N · repo:unindexed|ok|stale` and, in an unindexed repo, an info
notification suggests exploring.

## Style

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- ESM. Extensionless relative imports (jiti and vitest both resolve them).
- Dependencies: keep near-zero. Runtime deps today: `typebox`,
  `@earendil-works/pi-ai`. Anything new needs a justification in the PR.
- The first custom TUI surface is `/weave-view tui` (docs/weave-view-tui-design.md):
  a keyboard-driven explorer over the same GraphModel the browser viewer uses.
  Its pure view-model lives in `src/pi/viewer/tui/model.ts` (harness-free);
  the `WeaveExplorer` component is a thin input/render shell. Tool output
  outside the explorer is still plain text.
