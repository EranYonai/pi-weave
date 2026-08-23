# scan-modes.md — light and deep repository scanning

> Status: **implemented** (folds `docs/TODO.md` items **Todo 1** and **Todo 3** — the codebase-memory-mcp study — into one design).

## As-built deltas

Two details differ from the spec below; the rest matches.

- **Result shape** is `{ considered, written, skippedFresh, skippedTooBig, failed[], pruned }` — the field counting candidates is
  `considered`, not `total`.
- **The adapter resolves auth internally.** It calls `ctx.modelRegistry.complete(model, context, { maxTokens, signal })` — auth is owned by
  `modelRegistry`, not the spec's `getProviderAuth` + `completeSimple` dance.

## What we have today

`/weave-scan` builds the light index: languages, packages, modules (directory-level groupings), entry points, git anchor. Fast, structural,
no LLM. It tells you *where things are*, not *what they do*.

## The goal: two modes

| Mode | Trigger | Cost | Output |
|------|---------|------|--------|
| **Light** (default) | `/weave-scan` | milliseconds | Level 0+1 structure (today's index) |
| **Deep** | `/weave-scan deep` | LLM tokens × files | `.okf/repository/summaries/<file>.md` sidecars |

Deep mode is **opt-in and incremental**: summarizing costs tokens, so it never happens implicitly, and re-running it only re-summarizes
files whose content hash changed since their summary was written.

## Borrowed from codebase-memory-mcp (Todo 3 — studied, not integrated)

| Their idea | Transfers? | How |
|---|---|---|
| Layered ignoring (hardcoded + gitignore + `.cbmignore`) | **Yes, free** | we enumerate via `git ls-files`, so ignored/untracked files are already excluded; skip-lists for lockfiles/minified/generated files added on top |
| Incremental indexing keyed on content | **Yes** | summaries store the file's sha1; unchanged files are skipped |
| "No built-in LLM — the agent client is the intelligence" | **Yes** | deep scan uses the session's *already-configured* model (`ctx.model` + `ctx.modelRegistry` auth). No new keys, providers, or config — the pi-weave stance exactly |
| Daemon/watcher auto-sync | No — later | session-start staleness nudge + explicit rescan is our (deliberate) level |
| Tree-sitter symbol graphs / Hybrid LSP | No | violates the near-zero-deps rule; that's **Phase 2 Level 2** design space |
| Graph UI | Already shipped | weave-view |
| Committed shared artifact | Later | Phase 4 (`.gitignore`-initial policy stays) |

## Design

### Storage: sidecar files, not index bloat

Each summarized file gets a human-readable sidecar — `.okf` artefacts stay plain files (design principle):

```text
<repo>/.okf/repository/summaries/src--core--vault.ts.summary.md
```

```markdown
---
target: src/core/vault.ts
source: generated        # rule 4: never masquerades as human
content_hash: 4b825…     # sha1 of file content at summarize time
model: ollama/kimi-k3:cloud
at: 2026-08-23T09:00:00.000Z
---

Vault CRUD over ~/.okf/notes: frontmatter parse/serialize, slug-confined
paths, append with updated-timestamp refresh, mutation-queue-friendly.
```

The path name is derived by replacing `/` with `--` and appending `.summary.md` (deterministic, reversible, no subdirectories to manage).

### Deep scan pipeline (core: `src/core/summaries.ts`)

1. Enumerate files with the same `git ls-files` list the light scan used.
2. Filter: skip lockfiles, minified/`.map`/`.snap`, media and binary-ish extensions, then cap at `maxFiles` (default 300) and `maxFileBytes`
   (default 32 KB) per file.
3. For each candidate: sha1 worktree content; if the sidecar's `content_hash` matches, skip (incremental).
4. Else call the **injected** `summarize(path, content)` function with concurrency 4 (the adapter wires the session LLM; tests inject a fake
   — core never imports pi packages).
5. Write/refresh sidecars; prune sidecars whose `target` is no longer tracked. Collect per-file failures without aborting the run.

Result shape: `{ considered, written, skippedFresh, skippedTooBig, failed, pruned }`.

### The summarizer (adapter: `src/pi/summarize.ts`)

- Resolve the session model via `ctx.model`; auth is owned by `ctx.modelRegistry` — the adapter calls `ctx.modelRegistry.complete(model,
  context, { maxTokens, signal })` (pi-ai `completeSimple` is not used directly).
- Prompt asks for 1–3 sentences: what the file does, its outward surface, anything surprising — terse, navigation-oriented.
- No model available (headless rpc without provider, etc.) → friendly notice, scan falls back to light-only. Extension code has this as an
  explicit injection seam (`deps.complete`) so tests never hit a network.

### Surfaces

- `/weave-scan deep` — light index refresh, then deep pass with a progress status (`deep: 41/123 files`), finishing with the result summary.
- `/weave` dashboard — `summaries: N files (M stale)` line when present.
- **weave-view** — entry-point and module nodes show summaries in the side panel (module: first few + count); summary presence is data, so
  the viewer's poll-refresh picks up deep scans automatically.
- `weave-explore` skill — teaches the agent to read summaries first.

### Why not…

- …summaries inside `index.json`? Two copies of the truth; sidecars are git-diffable, human-browsable, and independently prunable.
- …a separate `/weave-deep` command? The TODO's own answer: one concept (scan) with two depths; a flag scales better as modes grow (`deep`
  future siblings: `--files`, `--modules`).
- …auto-deep on session start? Cost must be opt-in (TODO rationale).

## Non-goals

- Symbol/call graphs (Phase 2).
- Embedding search / vector retrieval.
- Background watcher (needs a daemon story; deliberate omission today).
