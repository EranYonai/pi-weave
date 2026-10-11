# AGENTS.md — working on pi-weave

Guidance for any agent (or human) making changes in this repository. Read `docs/design.md` first; it is the source of truth for *why*. This
file is about *how we work here*.

## What this project is

pi-weave is an agent-native knowledge workspace with **two faces**:

1. **Smart notepad** — a persistent vault of human/agent knowledge (`~/.okf/`, Markdown + front matter), usable through the `weave_note`
   tool.
2. **Repository exploration** — a derived, git-aware knowledge index of the repo you're standing in (`<repo>/.okf/`), usable through the
   `weave_repo` tool.

Both faces obey one rule: **artefacts are equally readable by humans and agents** (plain files on disk, no opaque databases).

## Hard rules

1. **Never commit directly to `main`.** Every push to `main` runs `.github/workflows/publish.yml`, which bumps the patch version and
   publishes to npm (unless the commit message contains `[skip ci]`). Create a feature branch (`feat/…`, `fix/…`, `chore/…`), commit
   there, push, and open a PR.
2. **Test coverage must stay ≥ 95%** (lines, branches, functions, statements). The gate is enforced by `vitest --coverage` thresholds — `npm
   run coverage` fails below 95. Write tests *with* the feature, not after.
3. **`src/core/` must never import from `@earendil-works/*`, `@opencode*`, `typebox`, or any harness package.** The core is the portable
   engine; adapters (`src/pi/`, `src/opencode/`) are thin wires into harness APIs. All logic lives in core.
4. **Generated knowledge carries provenance** (`source: human | agent | generated`). Never let agent-written content masquerade as
   human-authored.
5. **`.okf` indexes are derived and rebuildable.** Nothing in them may be the only copy of anything.
6. **The web client bundle is committed.** After changing anything under `src/web/client/`, run `npm run build:web` and commit
   `src/web/client/dist/app.js`. `npm run check` fails if the bundle does not match its source.

## Repository layout

```text
src/core/        Portable knowledge engine (vault, git, repo index, graph, view-models, workspace)
src/pi/          pi adapter: extension factory, tools, commands, /weave-view controller
src/opencode/    OpenCode adapter: V2 plugin (index.ts), V1 server (v1.ts), terminal companion (tui.ts), commands
src/web/server/  Local HTTP server for the browser workspace (routes, security, page)
src/web/client/  Browser workspace (Preact + sigma); bundled to dist/app.js by scripts/build-web.mjs
src/web/shared/  Wire types and the pure helpers both server and client may use
skills/          Agent Skills (agentskills.io): weave-notepad, weave-explore
scripts/         build-web, rewrap-md, eval-notepad-search
tests/           vitest suites mirroring src/ (tests/core, tests/pi, tests/opencode, tests/web)
docs/            design.md (source of truth), scan-modes.md, upstream pi reference docs, archive/ for finished plans
```

## Commands

```bash
npm run typecheck   # tsc --noEmit for the node project and the web project (strict; must stay clean)
npm test            # vitest run (no coverage gate)
npm run coverage    # vitest run --coverage (the 95% gate)
npm run build:web   # rebuild src/web/client/dist/app.js after client changes
npm run check       # typecheck + bundle check + coverage — run before committing
```

## Testing conventions

- Unit tests live in `tests/core`, adapter tests in `tests/pi` and `tests/opencode`, browser workspace tests in `tests/web`.
- `tests/helpers.ts` provides temp dirs, real git-fixture builders (`gitInit`, `commitAll`, `writeFixture`), and a **mock pi harness**
  (`createMockPi`, `createMockCtx`) that records tool/command/event registrations. Test the adapter through that mock; test core through its
  plain async functions.
- Use real temporary git repositories for git behavior — don't mock git output; the fixtures are cheap and honest.
- Inject clocks (`now` parameters) instead of depending on wall time.
- The vault location is overridable via `PI_WEAVE_VAULT`; adapter tests use `withVaultEnv(...)` from helpers. Don't touch a developer's real
  `~/.okf` from a test.

## End-to-end tests

`npm run e2e` drives real pi (in tmux, with a stub model) and the `/weave-view` workspace (headless Chromium) through a baseline journey.
Run it on your branch for any change a person would see in pi or the workspace, add steps for your feature, and look at the screenshots
it leaves in `e2e/.artifacts/`. How-to: `docs/e2e.md`.

## Trying the extension in pi

```bash
# project-local, hot-reloadable
mkdir -p .pi && ln -sfn ../.. .pi/extensions 2>/dev/null  # or point settings at it
pi -e ./src/pi/index.ts                                   # quick manual test
pi --mode rpc -e ./src/pi/index.ts                        # machine-driven smoke test
```

Smoke expectation: on session start pi's status line shows `🕸️ vault:N · repo:unindexed|ok|stale` and, in an unindexed repo, an info
notification suggests exploring.

**Graph layout settings** live under **Settings → Interface**, alongside group colors. The seven constants in
`src/web/shared/layout.ts` apply live and persist with workspace preferences; Reset graph layout restores the shipped values.
`docs/weave-workspace.md` §15.7–§15.8 (historical) has the original tuning history.

## Style

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- ESM. Extensionless relative imports (jiti and vitest both resolve them).
- Dependencies: keep near-zero. Runtime deps today: `fflate` (vault ZIP backup) and `zod` (OpenCode V1 tool schemas). The pi packages and
  `typebox` are peer dependencies supplied by the host. Browser libraries (Preact, sigma, marked, DOMPurify) are dev dependencies because
  they are bundled into `dist/app.js`. Anything new needs a justification in the PR.
- OpenCode is supported on two plugin APIs at once: `@opencode-ai/plugin` (V1, pinned) and `@opencode/plugin` (V2). Keep both working.
- The viewer is the browser workspace (`/weave-view`). Tool output is plain text.
