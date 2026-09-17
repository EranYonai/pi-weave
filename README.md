# pi-weave

<p align="center">
  <img src="https://raw.githubusercontent.com/EranYonai/pi-weave/main/docs/pi-weave-logo.png" alt="pi-weave" width="220"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-weave"><img alt="npm version" src="https://img.shields.io/npm/v/pi-weave?color=blue&logo=npm"></a>
  <a href="https://github.com/EranYonai/pi-weave/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/EranYonai/pi-weave/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/EranYonai/pi-weave/releases"><img alt="release" src="https://img.shields.io/github/v/release/EranYonai/pi-weave?color=blue&logo=github"></a>
  <a href="./LICENSE"><img alt="license: MIT" src="https://img.shields.io/npm/l/pi-weave?color=green"></a>
</p>

**A local knowledge workspace you can talk to.**

pi-weave is an extension for [pi](https://github.com/earendil-works/pi). Ask Pi to take notes while you think out loud, keep your exact words alongside a useful summary, and explore everything in `/weave-view`.

It also understands the repository you are working in. Personal notes live in a Markdown vault; repository knowledge lives in a disposable `.okf` index. Both are plain files that humans and agents can read.

## Core capabilities

- **Conversational note-taking.** Create and update notes through natural-language requests such as “start a note”, “add this”, or “remember that”.
- **Verbatim narration with structured summaries.** During dictation, Pi preserves each spoken passage in an append-only `## Raw` section while maintaining an organized summary above it.
- **Knowledge retrieval.** Pi searches existing notes when answering questions about previous decisions, people, projects, or meetings.
- **Unified visual workspace.** `/weave-view` presents notes, links, repository structure, and provenance in a live browser interface.
- **Optional session memory.** `/weave-scan sessions` turns changed pi transcripts into searchable notes with reusable technical takeaways.
- **Repository exploration.** A lightweight, git-aware index gives Pi a structural overview of the current codebase before it reads files.

Nothing is captured silently. pi-weave creates or extends a personal note only when you ask it to.

## Install

```bash
pi install npm:pi-weave
```

Other install sources:

```bash
pi install git:github.com/EranYonai/pi-weave
pi install /path/to/pi-weave
```

Requires Node **20.13 or newer**.

## Start taking notes

Talk to Pi normally:

```text
You: Start a note called Authentication migration.

You: We probably want OIDC next quarter, but existing JWT clients need
     a compatibility window.

You: Add that the gateway team owns the migration plan.

You: What open questions are in this note?
```

For live narration or interview notes, tell Pi that you are dictating:

```text
You: Start a note for this interview. I’m going to narrate; keep my words
     verbatim and organize the note as we go.
```

For each chunk, Pi:

1. appends your words unchanged to the note’s `## Raw` tail;
2. refreshes the structured summary above it;
3. leaves the raw record untouched.

This makes the note readable during the conversation without replacing your words with an AI reconstruction. Notes based on your dictation remain marked `source: human`; notes drafted by Pi are marked `source: agent`.

Useful requests include:

| Say this | What happens |
|---|---|
| “Start a note about…” | Creates a Markdown note in the vault |
| “Add this to the … note” | Finds the existing note and appends to it |
| “Clean up” or “finalize this note” | Reorganizes the readable body and preserves the raw tail |
| “What did we decide about…?” | Searches the vault, then reads the relevant notes |
| “Remember that…” | Stores durable knowledge for a future session |

## `/weave-view`

```bash
/weave-view              # open the browser workspace
/weave-view --no-open    # start it and print the URL
/weave-view tui          # terminal UI for SSH or browser-free use
```

The browser workspace has four connected views:

- **Tree** — notes, folders, and repository structure, with text and provenance filters.
- **Note** — rendered Markdown with clickable `[[wikilinks]]`, link previews, tags, authorship, and an action to open the source in `$EDITOR`.
- **Graph** — a navigable map of notes, links, mentions, modules, and repository relationships. Selecting something updates every view.
- **Context** — links, backlinks, tags, and code mentions for the current selection.

Search with `⌘K` / `Ctrl K`. Press `?` for all shortcuts. The workspace updates as notes change on disk, so a note written by Pi appears without a reload. It follows the system theme by default and can be switched between light and dark.

The browser is read-only. Edit with `$EDITOR`, Obsidian, or the `weave_note` tool; unknown front-matter fields remain preserved.

`/weave-view tui` is the smaller, read-only terminal explorer: tree, focused neighborhood, details, and link health over the same graph.

## Remember past pi sessions

```bash
/weave-scan sessions                    # pi history (default)
/weave-scan sessions /path/to/history   # explicit history root
```

This opt-in scan treats a supplied file—or every bounded text file under a supplied directory—as opaque session material for the active model to interpret, then writes generated notes under `~/.okf/notes/sessions/`. That makes it usable with Claude Code, opencode, Codex, or exported history trees without requiring their schema or file extension. It skips unchanged files, captures outcomes plus reusable technical takeaways, works outside Git repositories, and can be stopped with `/weave-scan-cancel`.

## Repository knowledge

Inside a Git repository, pi-weave detects whether `<repo>/.okf/` is missing, fresh, or stale.

```bash
/weave-scan         # fast structural index
/weave-scan deep    # also summarize changed files with the active model
```

The light index covers languages, packages, modules, entry points, and Git state. A deep scan adds short per-file summaries and only revisits files whose content changed.

The repository index is a cache, not a source of truth. Delete `.okf`, scan again, and nothing important is lost. pi-weave excludes it locally from Git by default.

## Commands and tools

Most people only need natural language and `/weave-view`.

| Surface | Name | Purpose |
|---|---|---|
| Command | `/weave-view` | Open the browser or terminal workspace |
| Command | `/weave` | Show vault and repository status |
| Command | `/weave-scan` | Build or refresh the repository index |
| Command | `/weave-scan deep` | Add incremental model-written file summaries |
| Command | `/weave-scan sessions [path]` | Turn changed session-history files into durable memory notes |
| Command | `/weave-scan-cancel` | Stop a deep or session scan |
| Tool | `weave_note` | List, read, add, append, finalize, and search notes |
| Tool | `weave_repo` | Check, scan, and summarize the repository index |

The included `weave-notepad` and `weave-explore` skills teach Pi when and how to use these tools.

## Files, privacy, and portability

Personal notes are ordinary Markdown files:

```text
~/.okf/
└── notes/
    ├── authentication-migration.md
    └── release-plan.md
```

A note has small YAML front matter followed by Markdown:

````markdown
---
title: Authentication migration
created: 2026-08-22T09:00:00.000Z
updated: 2026-08-22T09:30:00.000Z
tags: [auth, security]
source: human
---

## Summary

Move toward OIDC while keeping a JWT compatibility window.

---

## Raw
<!-- NEVER edit below this line. Verbatim user input preserved here. -->

```
We probably want OIDC next quarter…
```
````

Set `PI_WEAVE_VAULT` to use a different vault location.

Reading, writing, searching, and viewing notes are local operations. Deep repository scans and session summaries send bounded input to whichever model you configured in pi. The browser workspace binds only to loopback, uses a per-session token, and shuts down with the pi session.

The vault format, repository index, and skills are intentionally harness-agnostic. `src/core` contains no pi-specific imports.

## Development

```bash
npm install
npm run check
```

Useful individual commands:

```bash
npm run typecheck
npm test
npm run coverage
npm run build:web
```

Coverage must remain at or above **95%** for lines, branches, functions, and statements. If browser source changes, rebuild and commit `src/web/client/dist/app.js`.

Read [AGENTS.md](AGENTS.md) before contributing. Work on a feature branch; do not commit directly to `main`.

## More detail

- [Design](docs/design.md) — product and architecture
- [Notepad skill](skills/weave-notepad/SKILL.md) — capture, narration, and provenance behavior
- [Historical browser workspace notes](docs/weave-workspace.md) — superseded implementation record
- [Session scanning](docs/session-scan.md) — incremental session memory
- [Repository exploration skill](skills/weave-explore/SKILL.md) — how Pi uses the index

## License

[MIT](LICENSE)
