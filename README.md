# pi-weave

**An agent-native knowledge workspace for your life and your code.**

pi-weave is a [pi](https://github.com/earendil-works/pi-coding-agent)
extension with two faces that are secretly one:

1. **A smart notepad with AI skills.** A persistent vault of knowledge —
   decisions, ideas, people, meetings — stored as plain Markdown notes with
   front matter under `~/.okf/notes/`. Your agent reads and writes it *with*
   you; everything is editable by hand in any editor.

2. **A repository exploration engine.** A derived, git-aware knowledge index
   of the repo you're in, living at `<repo>/.okf/` — structure, languages,
   packages, modules, entry points, and staleness state. Rebuildable,
   disposable, never the source of truth.

And one rule across both: **everything is equally usable by humans and
agents.** No opaque databases. No lock-in formats.

```
🧵 vault:12 · my-project:ok      ← pi's status line when weave is active
```

## Install

```bash
pi install /path/to/pi-weave            # local path
pi install git:github.com/EranYonai/pi-weave   # from git (once published)
```

Or for development: `pi -e ./src/pi/index.ts`.

## What you get

| Surface | Name | Purpose |
|---|---|---|
| Tool | `weave_note` | list / get / add / append / search vault notes |
| Tool | `weave_repo` | status / scan / overview of the `.okf` repo index |
| Command | `/weave` | workspace dashboard (vault + repository) |
| Command | `/weave-scan` | build/refresh the repository index |
| Command | `/weave-view` | open the local graph viewer in your browser |
| Skill | `weave-notepad` | how the agent should take good notes |
| Skill | `weave-explore` | how the agent should explore repositories |

**`/weave-view`** starts a loopback-only server (`127.0.0.1`, random port)
and opens an interactive graph of your knowledge space: vault notes with
trust provenance (solid = human, dashed = agent, dimmed = generated),
wiki-link edges between notes, and the repository's structure anchored to
git state. It reads disk live on every refresh — never a stale cache.
Zoom/scroll, drag to pan, click nodes to expand; notes open in a rendered
markdown side panel.

On session start, pi-weave detects the repository you're in, checks whether
`.okf` exists and is fresh, and says so in the status line.

## The formats (why everything is portable)

Vault note (`~/.okf/notes/auth-boundary.md`):

```markdown
---
title: Auth boundary decision
created: 2026-08-22T09:00:00.000Z
updated: 2026-08-22T09:30:00.000Z
tags: [auth, security]
source: human
---

JWT validation happens at the gateway because…
```

Repository index (`<repo>/.okf/`):

```text
.okf/
├── okf.json            # format version + generator + source: generated
└── repository/
    ├── identity.json   # name, remotes, default branch
    ├── git.json        # HEAD sha + branch + changed-file content hashes (staleness anchor)
    └── structure.json  # languages, packages, modules, entry points
```

The `.okf` index is **derived**: delete it, rescan, lose nothing. By default
it's excluded from git locally (`.git/info/exclude`); committing it for team
sharing is a deliberate opt-in.

## For other agent harnesses

The on-disk artifacts and `src/core` are harness-agnostic by design — Claude
Code and opencode adapters are on the roadmap (docs/design.md §21), and the
skills follow the [Agent Skills standard](https://agentskills.io/specification).

## Development

```bash
npm install
npm run check     # typecheck + tests with coverage gate (≥95%)
```

See [AGENTS.md](AGENTS.md) for contributor/agent rules and
[docs/design.md](docs/design.md) for the full design.
