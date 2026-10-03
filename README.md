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

**Your notes. Your agent's notes. One searchable knowledge workspace.**

I've been chasing the right note-taking workflow for years. Notion, OneNote, Obsidian, and plenty of others.

With pi-weave, I've made one that finally answers the way I want to work today — especially now that AI agents are part of that work.

The idea is simple:

**You and your agent should share the same knowledge.**

Talk naturally and let your thoughts become structured notes. Write notes yourself. Let your agent capture decisions, discoveries, and
useful context. Bring important knowledge forward from previous sessions.

Then find it again — by searching the workspace yourself, or simply asking your agent.

Everything is local. Everything is readable. Your notes are ordinary files, not knowledge trapped inside another chat.

## Think out loud

Dictation is one of my favorite ways to use AI.

Instead of stopping to organize every thought while I'm having it, I can just talk:

> Start a note about pi-weave positioning. I'm going to think out loud.

pi-weave keeps what I actually said while Pi continuously turns it into a useful, structured note.

The raw thought stays yours. The organization is handled for you.

And it doesn't end with human notes.

## Your knowledge + your agent's knowledge

pi-weave gives humans and agents one workspace.

A note you dictate, something you write manually, a useful discovery made by an agent, or knowledge recovered from an earlier session can
all live together.

pi-weave keeps track of where knowledge came from, while making the whole workspace searchable by both you and your agent.

**The conversation can end. The knowledge doesn't have to.**

## Install

pi-weave supports [Pi](https://github.com/earendil-works/pi) and OpenCode (V1 **1.18.29+** and V2) from the same package. The adapters share
the vault, repository index, browser workspace, tools, and skills.

OpenCode V2:

```bash
opencode plugin add pi-weave
```

OpenCode V1 1.18.29+: add the package to both `opencode.json` (server) and `tui.json` (browser opening):

```json
{ "plugin": ["pi-weave"] }
```

Pi:

```bash
pi install npm:pi-weave
```

Other install sources:

```bash
pi install git:github.com/EranYonai/pi-weave
pi install /path/to/pi-weave
```

Requires Node **20.13 or newer**.

Then just talk to your agent.

## Start taking notes

Talk to Pi normally:

```text
You: Start a note called Authentication migration.

You: We probably want OIDC next quarter, but existing JWT clients need
     a compatibility window.

You: Add that the gateway team owns the migration plan.

You: What open questions are in this note?
```

For live narration or interview notes, tell your agent that you are dictating:

```text
You: Start a note for this interview. I’m going to narrate; keep my words
     verbatim and organize the note as we go.
```

For each chunk, the agent:

1. appends your words unchanged to the note’s `## Raw` tail;
2. refreshes the structured summary above it;
3. leaves the raw record untouched.

This makes the note readable during the conversation without replacing your words with an AI reconstruction. Notes based on your dictation
remain marked `source: human`; notes drafted by the agent are marked `source: agent`.

Useful requests include:

| Say this | What happens |
|---|---|
| “Start a note about…” | Creates a Markdown note in the vault |
| “Add this to the … note” | Finds the existing note and appends to it |
| “Clean up” or “finalize this note” | Reorganizes the readable body and preserves the raw tail |
| “What did we decide about…?” | Searches the vault, then reads the relevant notes |
| “Remember that…” | Stores durable knowledge for a future session |
| “Fix the broken links” | Audits and repairs stale `[[wiki-links]]` deterministically |

## Keeping the vault connected

A wiki-link resolves to nothing when it is written as a bare title — `[[Quarterly Roadmap]]` when the note lives at `planning/roadmap-2026`
— or when it points at a note that was never written. Pi repairs those in one deterministic pass instead of rereading the vault and
guessing.

```text
You: Check the links in my notes.
You: Fix the ones you're sure about.
```

A target resolves by exact slug, then unique basename, then unique title — each rule requiring **exactly one** candidate. Ambiguous links
are reported with their candidates and never guessed; links to notes that were never written are listed, never invented. Repairs preserve
the alias, so the visible text does not change, and never touch the `## Raw` tail or code fences.

Renaming or moving a note rewrites its inbound links automatically, so its backlinks stay intact.

## `/weave-view`

```bash
/weave-view              # open the browser workspace
/weave-view --no-open    # start it and print the URL
/weave-view tui          # Pi only: terminal UI for SSH or browser-free use
```

The browser workspace puts notes at the center, with a collapsible notes sidebar, document tabs, and optional context for links,
backlinks, tags, and code mentions. Open a note to replace the current document; `⌘` / `Ctrl` click a note or wiki-link to open a new tab.
Each document tab has its own Back/Forward history and reading position. The tab strip sits at the top of the workspace.
Use the ribbon search button or `⌘K` / `Ctrl K`; `⌘` / `Ctrl Enter` opens a result
in a new tab. **Recent** keeps its order while you browse; returning to it refreshes the visit order. Its rows show the same item icons
as Files. Press `?` for shortcuts.

Open **Graph view** from the left ribbon. Click a node to preview its title and type while staying in Graph. Click the same node again
or choose **Open in new tab** to open its content; in a split layout, the new tab opens in the other pane. Dragging does not open content.
Use **Pane options (···)** to split right or down, move the current tab to the other pane, or close a pane while retaining its tabs.
In a split workspace, drag a tab title into the other pane to move it. History, reading position, and unsaved drafts stay with it. On small windows, **Switch pane** reaches the
other group. Drag a note from Files into either pane to open it in a new tab. Closing or moving the last tab out of a split removes that pane;
closing the final workspace tab leaves a New tab. `Option W` / `Alt W` closes the active Weave tab using the same unsaved-draft guard.
Some browser hosts also claim this shortcut: Codex’s in-app browser still closes its outer tab. Both sidebars can be shown or hidden from the ribbon.

Click **Edit** to change a note's Markdown; `⌘S` / `Ctrl S` saves, and **Done** closes the editor. Drafts survive tab and pane switching,
and duplicate views of a note share one draft. Closing or replacing the last view of an unsaved note asks before discarding it. A save
rewrites only the body: unknown front-matter fields, key order, and the append-only `## Raw` tail survive untouched. Outside edits appear
within a couple of seconds; the last writer wins.

Tabs, pane sizes, sidebars, theme, and reading positions restore for the same vault and repository, even when the local server port
changes. Presentation snapshots live under `$XDG_CONFIG_HOME/pi-weave/presentation` (or `~/.config/pi-weave/presentation`), separate from
the knowledge files. Unsaved text stays in memory and is guarded on reload/close; it is not restored after closing the browser. Missing
notes do not prevent the other tabs from restoring. The workspace follows the system theme unless you choose light or dark.

This browser facelift is the first stage toward a dedicated macOS window. `/weave-view` still launches the browser, and the agent owns
the local server's lifetime.

`/weave-view tui` is the smaller, read-only terminal explorer: tree, focused neighborhood, details, and link health over the same graph.

## Remember sessions

```bash
/weave-scan sessions                    # Pi history, or the current OpenCode session
/weave-scan sessions /path/to/history   # explicit history root
```

This opt-in scan treats a supplied file—or every bounded text file under a supplied directory—as opaque session material for the active
model to interpret, then writes generated notes under `~/.okf/notes/sessions/`. In OpenCode, the pathless form reads the current session
through the public plugin API; it never inspects OpenCode's internal database. That makes explicit paths usable with Claude Code, OpenCode,
Codex, or exported history trees without requiring their schema or file extension. It skips unchanged files, captures outcomes plus reusable
technical takeaways, works outside Git repositories, and can be stopped with `/weave-scan-cancel`.

## Repository knowledge

Inside a Git repository, pi-weave detects whether `<repo>/.okf/` is missing, fresh, or stale.

```bash
/weave-scan         # fast structural index
/weave-scan deep    # also summarize changed files with the active model
```

The light index covers languages, packages, modules, entry points, and Git state. A deep scan adds short per-file summaries and only
revisits files whose content changed.

The repository index is a cache, not a source of truth. Delete `.okf`, scan again, and nothing important is lost. pi-weave excludes it
locally from Git by default.

## Commands and tools

Most people only need natural language and `/weave-view`.

| Surface | Name | Purpose |
|---|---|---|
| Command | `/weave-view` | Open the browser workspace (`tui` is a Pi-only argument) |
| Command | `/weave` | Show vault and repository status |
| Command | `/weave-scan` | Build or refresh the repository index |
| Command | `/weave-scan deep` | Add incremental model-written file summaries |
| Command | `/weave-scan sessions [path]` | Turn changed session-history files into durable memory notes |
| Command | `/weave-scan-cancel` | Stop a deep or session scan |
| Tool | `weave_note` | List, read, add, append, finalize, and search notes |
| Tool | `weave_repo` | Check, scan, and summarize the repository index |

The included `weave-notepad` and `weave-explore` skills teach Pi and OpenCode when and how to use these tools. In OpenCode, `/weave` shows
vault/repository status and scan progress appears in toasts; Pi keeps its persistent status line. V1 slash commands use its standard prompt
pipeline, so the model reports command results in the conversation. `/weave` does not open a dialog. V1 scans use the model from your last
chat message: send a message after selecting a model, then scan. Generation runs in temporary child sessions with tools denied;
those sessions are removed on completion or cancellation. V2 uses its direct command and generation APIs.

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

Reading, writing, searching, and viewing notes are local operations. Deep repository scans and session summaries send bounded input to the
active Pi/V2 model or the last-used V1 chat model. The browser workspace binds only to loopback, uses a per-session token, and shuts down
with the plugin lifecycle. OpenCode opens it automatically when the terminal can reach the viewer's loopback URL. Otherwise, it shows the
exact URL for a browser or tunnel.

The vault format, repository index, and skills are intentionally harness-agnostic. `src/core` contains no Pi- or OpenCode-specific imports.

## Development

The OpenCode V1/V2 bindings share tool schemas, core actions, and one command/scan workflow. Zod is the only direct runtime dependency,
required by V1's tool-schema protocol; OpenCode SDKs are development-only.

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

Coverage must remain at or above **95%** for lines, branches, functions, and statements. If browser source changes, rebuild and commit
`src/web/client/dist/app.js`.

Read [AGENTS.md](AGENTS.md) before contributing. Work on a feature branch; do not commit directly to `main`.

## More detail

- [Design](docs/design.md) — product and architecture
- [Notepad skill](skills/weave-notepad/SKILL.md) — capture, narration, and provenance behavior
- [Link repair reference](skills/weave-notepad/references/link-repair.md) — how stale links resolve, and what repair will not do
- [Historical browser workspace notes](docs/weave-workspace.md) — superseded implementation record
- [Repository exploration skill](skills/weave-explore/SKILL.md) — how Pi uses the index

## License

[MIT](LICENSE)
