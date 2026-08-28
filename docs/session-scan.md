# session-scan.md — `/weave-scan sessions`: pi's memory in the vault

> Status: **design → implementation** (this document describes the shipped behavior).
> Sibling of `docs/scan-modes.md` (light + deep repository scanning); reads it for the
> incremental-hash pattern this feature reuses.

## Motivation

pi has no memory. Every session starts from zero: the agent re-reads the repo, re-derives
decisions, and re-asks the user things it was told last Tuesday. Meanwhile a complete record
of everything pi has ever done sits on disk as opaque JSONL — readable, but only by
machines willing to parse a message tree.

The vault (`~/.okf/`) is pi-weave's persistent, repo-agnostic knowledge store, equally
readable by humans and agents. Session summaries belong there: **one note per pi session,
written by the model, incrementally maintained**. That turns the session history into
searchable, linkable, graph-visible memory — the "smart notepad" face absorbing the
"session" scope from design.md §17.

## The command

| Trigger | Cost | Output |
|---------|------|--------|
| `/weave-scan sessions` | LLM tokens × new/changed sessions | one vault note per session |

Like `deep`, it runs in the **background** (progress on the status line, cancellable via
`/weave-scan-cancel`), because a blocking command cannot be interrupted in the TUI. Unlike
`deep`, it needs **no git repository** — it is repo-agnostic by definition and works from
any directory. It does require an active session model (same stance as deep scans: the
session's already-configured model, no new keys or providers).

## Storage: an inner folder of the vault graph

Each summarized session becomes a real, nested vault note — searchable by `weave_note`,
visible in weave-view's graph, editable by humans, but organized in its own folder so it
never mixes with the flat listing a human curates:

```text
~/.okf/notes/sessions/what-is-weave-scan-sessions.md
```

```markdown
---
title: What is weave-scan sessions?
created: 2026-08-23T09:00:00.000Z     # note creation, not session start
updated: 2026-08-23T09:30:00.000Z
tags: [pi-session, pi-weave]
source: generated                     # rule 4: agent-written content never masquerades as human
session_id: 01a0282c-6048-7f9d-b697-6fac81b9d18a
session_hash: 4b825dc642cb6eb9a060e54bf8d69288fbee4904
session_cwd: /Users/eranyonai/Documents/pi-weave
session_start: 2026-08-22T06:33:12.008Z
session_file: /Users/eranyonai/.pi/agent/sessions/--Users-…--/2026-08-22T06-33-12-008Z_01a0282c….jsonl
---

The user wanted pi to remember its sessions; the scan hashed each transcript while reading
it, summarized the changed ones, and left the vault clean.

## Details

- Session: `01a0282c-…`
- Started: 2026-08-22T06:33:12.008Z · ended: 2026-08-22T08:01:00.000Z
- Project: `/Users/eranyonai/Documents/pi-weave`
- Messages: 214 user · 331 assistant · 402 tool results (2 errors)
- Tools: bash ×40, edit ×12, read ×41
- Models: ollama/kimi-k3:cloud
- Previous session: [[sessions/can-we-change-the-emoji…]]
- Next session: [[sessions/clear]]
- Transcript: `/Users/…/2026-08-22T06-33-12-008Z_….jsonl`
- Summarized: 2026-08-23T09:00:00.000Z by ollama/kimi-k3:cloud
```

The slug is the note's **path relative to `notes/`** — `sessions/<name>` — which is what
makes this an inner folder of the vault rather than a hidden sidecar corner:

- `weave_note list` / `search` / the graph see session notes as the first-class notes they
  are (the vault listing is recursive; the slug is the relative path),
- the graph groups them under a synthesized **folder node** (`vfolder:sessions`, kind
  `module`) so the viewer's tree nests `sessions/` like the repository tree nests
  directories — no client change needed; the tree renders any `contains` chain,
- `[[sessions/…]]` wiki-links between them **resolve in the graph** — each note's Details
  block links its chronological neighbours within the same project, forming a walkable
  chain (backward links are always complete; forward links reflect what the writing scan
  knew, and refresh when a session is re-summarized),
- the five managed keys are the note engine's; the `session_*` keys are **owned by this
  feature** — written at creation, upserted on re-summarize, carried verbatim through any
  human edit,
- the title carries no `Pi session:` prefix — the folder is that context. Titles are set at
  creation (the human may have retitled the note; a re-scan must not clobber that).

A nested slug needs the whole stack to agree: `resolveNotePath` accepts subpaths inside
`notes/` (traversal is still rejected at that one door), `listNoteFiles` walks recursively
(slug = relative path), and the web server's `/api/note/` family treats `sessions/foo` as a
slug — its only sub-resource, `/rename`, is matched at the end.

### Migration

Earlier layouts are migrated at the start of every scan, best-effort and idempotent: flat
`notes/*.md` with a `session_id` marker (the first release), and a vault-level `sessions/`
folder (the interim one). Each note moves to `notes/sessions/<name>.md`, dropping the
`pi-session-` slug prefix and the `Pi session: ` title prefix, backfilling
`session_start`, and qualifying its chain links. A target-name collision with a *different*
session id leaves the legacy file in place; a same-id collision means the target is the
authoritative rescanned copy and the stale legacy duplicate goes. Non-session notes are
never touched.

### Why a folder of real notes, not a sidecar corner

An earlier draft stored session notes outside `notes/` entirely — which made them invisible
to the graph, to `weave_note search`, and to the vault status line: memory no one can find.
Inside `notes/sessions/` they are ordinary notes (human-editable, graph-visible,
searchable) that happen to live in their own folder — the directory provides the context
the old title prefix carried, and generated memory stays visually distinct from
hand-curated knowledge in the vault's `sessions/` subfolder.

## Incrementality: hash while reading

The deep scan's incremental trick, applied to sessions:

1. Discover `~/.pi/agent/sessions/*/*.jsonl` (stat each: size, mtime), newest first.
2. Build a note index in one pass over the vault: `session_id → { slug, session_hash }`
   from note front matter. Marker-based, so renamed notes still resolve.
3. For each candidate file (newest first, capped): **read it once, hash the bytes**
   (sha1, `hashContent`), and peek at the header line for the session id.
4. If the note's `session_hash` matches — skip. No parse, no LLM call.
5. Otherwise parse the full JSONL into a digest, summarize, and upsert the note
   (create or update in place, keyed by `session_id`).

The hash is computed from the same single read that feeds the parse — the file is never
read twice. A session that keeps growing (the live one, or a resumed one) simply changes
hash and is re-summarized next scan; its note is updated **in place**, keeping its slug,
title, `created`, and any human edits (unknown front-matter keys and the append-only
`## Raw` tail are preserved, per the vault's round-trip guarantees).

### Identity and lookup

- **Identity**: the session uuid from the JSONL header (`type: "session"`), stable across
  file moves and re-scans; the storage path is recorded for provenance but is not the key.
- **Lookup**: `readSessionNoteIndex(vaultRoot)` maps `session_id → note slug + hash`.
- **Slug**: `slugify(title)` at creation (uniquified `-2`, `-3`… on collision); the marker
  index, not the slug, is what makes re-scans find the note even after a rename.

## The digest

Session files can be megabytes; the summarizer must not see all of it. `parseSessionDigest`
walks the JSONL once and keeps:

| Signal | Why |
|--------|-----|
| header (`id`, `cwd`, start time, `parentSession`) | identity + project |
| `session_info` name | the user's own label, when set |
| user messages (each clipped to 400 chars, first 60) | what was asked |
| first user message | note title seed |
| `compaction` / `branch_summary` summaries (last 3 / 2, clipped) | pre-written session summaries — the highest-value signal in long sessions |
| last non-empty assistant text (clipped 800) | how things ended |
| counts (user/assistant/toolResult, errors) | shape of the work |
| tool-name histogram + direct `bashExecution` count | what was actually done |
| models used (`model_change` + assistant messages) | provenance |

`renderSessionDigest` flattens this to a compact transcript (`Session <id> (t₀ → t₁)`,
`Project:`, `Messages:`, `## User messages`, `## Compaction summaries`, `## Last assistant
message`) capped at 12 000 chars. `## User messages` absent ⇒ nothing to remember: sessions
with no user messages, no compactions, no branch summaries and no shell activity are
counted as `skippedEmpty` and never spend a token.

## Caps and defaults

| Cap | Default | Rationale |
|-----|---------|-----------|
| `maxSessions` | 100 (newest first) | first run over years of history must terminate; re-scans are near-free so the tail catches up |
| `maxFileBytes` | 16 MiB (stat-based, before read) | pathologically large files are mostly base64 image blocks |
| digest cap | 12 000 chars | one summarization call per session, bounded |
| user messages kept | 60 × 400 chars | intent lives in the asks, not in every follow-up |
| compactions / branch summaries | 3 × 1200 / 2 × 800 chars | newest state matters most |
| concurrency | 2 | sessions are big; gentler than the file scan's 4 |

## Title, tags, slug

- **Title**: `session_info` name, else first user message, else `session <id8>` — flattened,
  clipped to 80 chars, always prefixed `Pi session: `. Set **at creation only**: on
  re-summarization the title, slug and `created` are preserved (a human may have retitled
  the note; the refreshed body carries the news).
- **Tags**: `["pi-session", <slugified project dir name>]` — graph-clusterable.
- **Body**: the model's summary, then a `## Details` block with the session id, span,
  project, message counts, tools, models, transcript path, and summarizer provenance.

## Result shape

```ts
{
  discovered,        // *.jsonl files found under the sessions root
  considered,        // after the size filter and maxSessions cap
  written,           // created + updated
  created, updated,  // new notes vs re-summarized notes
  skippedFresh,      // hash unchanged — the incremental payoff
  skippedEmpty,      // sessions with nothing to remember
  skippedTooBig, skippedUnreadable,
  failed: [{ path, error }]
}
```

## Split (AGENTS.md rule 3)

- **`src/core/sessions.ts`** — discovery, hashing, parsing, digest, title/tags/body
  derivation, the scan loop, and `readSessionNoteIndex`. Injected: `summarize`, both roots,
  clock, signal, caps. No harness imports.
- **`src/core/frontmatter.ts`** — `upsertFrontMatterFields`: upsert owned scalar keys into
  a note's front-matter lines (first occurrence replaced, duplicates collapsed, missing
  appended), reusing the one line-classification rule.
- **`src/core/vault.ts`** — `upsertNote`: idempotent create-or-update for *generated* notes
  (marker-free callers pass a slug; creation uniquifies; update preserves title, `created`,
  unknown front matter and the raw tail, bumps `updated`). Source defaults to
  `"generated"` — the safe direction for rule 4.
- **`src/pi/summarize.ts`** — `createModelSummarizer`: the shared session-model wiring
  (resolve `ctx.model`, auth via `modelRegistry.complete`, capped output, empty-summary
  rejection); `createLlmSummarizer` and the new session summarizer are both thin wrappers
  over it.
- **`src/pi/sessionScan.ts`** — the session prompt (3–6 sentences: what was asked, what was
  done, outcomes, open threads), `scanPiSessions` (roots + tunables → `runSessionScan`),
  and the result formatter.
- **`src/pi/index.ts`** — `/weave-scan sessions` starts a background scan (shared lifecycle
  helper with deep scans); `/weave-scan-cancel` aborts whichever scans are in flight.

The sessions root resolves from `PI_WEAVE_SESSIONS` (tests, unusual setups) and defaults to
`~/.pi/agent/sessions` — the documented pi location.

## Why not…

- …parse sessions with pi's own `SessionManager`? It lives in the coding-agent package; the
  core must stay harness-free (rule 3), and the digest needs a tenth of the format. The
  JSONL format is documented and versioned; the parser is tolerant (unknown types skipped,
  malformed lines ignored, v1/v3 headers both fine).
- …one note per *project*? Per-session notes are the atomic unit of memory — linkable,
  prunable by the human, each with its own hash. A project rollup can be a later note that
  links to them.
- …delete notes when their transcript vanishes? Vault notes are user knowledge, not derived
  cache (rule 5 cuts the other way here). Stale notes stay.
- …auto-scan on session start? Cost must be opt-in, exactly like deep scans.

## Non-goals

- Embedding / semantic retrieval over session notes (vault search is substring-based today).
- Cross-session project rollups.
- Scanning other harnesses' transcripts (Claude Code, opencode) — the core's injected roots
  make that an adapter concern later.