# pi-weave

<p align="center">
  <img src="https://raw.githubusercontent.com/EranYonai/pi-weave/main/docs/pi-weave-logo.jpg" alt="pi-weave — an agent-native knowledge workspace" width="220"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-weave"><img alt="npm version" src="https://img.shields.io/npm/v/pi-weave?color=blue&logo=npm"></a>
  <a href="https://github.com/EranYonai/pi-weave/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/EranYonai/pi-weave/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/EranYonai/pi-weave/releases"><img alt="release" src="https://img.shields.io/github/v/release/EranYonai/pi-weave?color=blue&logo=github"></a>
  <a href="./LICENSE"><img alt="license: MIT" src="https://img.shields.io/npm/l/pi-weave?color=green"></a>
</p>

**An agent-native knowledge workspace for your life and your code.**

pi-weave is a [pi](https://github.com/earendil-works/pi) extension with two faces that are secretly one:

1. **A smart notepad.** A persistent vault of knowledge — decisions, ideas, people, meetings — stored as plain Markdown notes with YAML
   front matter under `~/.okf/notes/`. Your agent reads and writes it *with* you through the `weave_note` tool; everything stays editable by
   hand in any editor.

2. **A repository exploration engine.** A derived, git-aware knowledge index of the repo you are standing in, living at `<repo>/.okf/` —
   structure, languages, packages, modules, entry points, and staleness state. Built and read through the `weave_repo` tool. Rebuildable,
   disposable, never the source of truth.

One rule spans both: **everything is equally readable by humans and agents.** Markdown and JSON on disk, no opaque database, no lock-in
format. Every generated artefact carries provenance (`human`, `agent` or `generated`), so agent-written content never masquerades as
something you wrote.

```
🧵 vault:12 · my-project:ok      ← pi's status line when weave is active
```

See [docs/design.md](docs/design.md) for the reasoning behind all of it.

## Install

```bash
pi install npm:pi-weave                        # from npm (recommended)
pi install git:github.com/EranYonai/pi-weave   # from git
pi install /path/to/pi-weave                   # local path
```

Requires Node **>= 20.13.0**. For development against a checkout: `pi -e ./src/pi/index.ts`.

On session start pi-weave detects the repository you are in, checks whether `.okf` exists and is fresh, and reports it in the status footer
— a filled `●` marks weave as active. An unindexed repository gets a one-line nudge; a stale one gets a warning.

## Tools and commands

| Surface | Name | Purpose |
|---|---|---|
| Tool | `weave_note` | `list` / `get` / `add` / `append` / `finalize` / `search` over vault notes |
| Tool | `weave_repo` | `status` / `scan` / `overview` of the `.okf` repository index |
| Command | `/weave` | workspace dashboard (vault + repository) |
| Command | `/weave-view` | open the knowledge workspace in your browser |
| Command | `/weave-scan` | build or refresh the repository index (light) |
| Command | `/weave-scan deep` | light index plus model-written per-file summaries (opt-in, incremental, background) |
| Command | `/weave-scan-cancel` | stop an in-flight `/weave-scan deep` run |
| Skill | `weave-notepad` | how the agent should take good notes |
| Skill | `weave-explore` | how the agent should explore repositories |

`/weave-scan deep` refreshes the light index and then writes a short model summary per file to `.okf/repository/summaries/`, skipping files
whose content hash has not changed since their last summary. It costs tokens, so it never runs implicitly — and it runs in the background,
so `/weave-scan-cancel` can stop it mid-flight.

## The workspace

`/weave-view` opens a browser knowledge workspace over the same graph the tools see — the vault and the repository index as one model.

```bash
/weave-view              # browser workspace (default), opens a tab
/weave-view --no-open    # same server, just prints the URL
/weave-view tui          # the in-terminal explorer instead
```

Three resizable columns and a context rail:

- **Tree** — an expandable containment tree over notes and repository structure, with a filter box and provenance cycling.
- **Note** — the selected note rendered with [marked](https://marked.js.org) and sanitised with DOMPurify. `[[wikilinks]]` navigate inside
  the workspace; links with no target render as ghosts rather than dead text.
- **Graph** — [sigma.js](https://www.sigmajs.org) v3 on WebGL with a [d3-force](https://d3js.org/d3-force) layout: neighbourhood highlight
  on selection, semantic zoom that reveals labels as you go in, and cluster collapse as real graph reduction rather than hiding.
- **Context rail** — links, backlinks, tags and mentions for whatever is selected, every entry clickable.

Selecting anywhere highlights everywhere: the tree, the note body, the graph and the rail are lenses onto one selection. Updates arrive live
over SSE as files change on disk, so an agent writing a note shows up without a refresh.

`⌘K` opens a search palette spanning both faces (notes ranked with snippets, repository nodes by label). The whole workspace is keyboard
drivable — `⌘1/2/3` focus a column, `/` filters the tree, `g` fits the graph, `Esc` clears, and `?` lists the rest. Column widths persist.

The workspace is **read-first**, but no longer read-only. `⌘E` toggles the note column between read and edit, `⌘S` saves, and every save
carries the revision read at load — a stale one gets a `409` and a choice of reload, overwrite or keep editing. The draft is never silently
discarded or clobbered: a remote change arriving over SSE for the note you are editing is recorded rather than applied, and comes back as
that same `409` when you save.

Front matter the engine does not own survives a browser save **byte-identically** — `aliases`, `cssclass` and a `tags:` block list all come
back unchanged and in place, with `updated:` the only line a save moves. That is the P5 exit criterion, and
`tests/web/editor.roundtrip.test.ts` drives it through the real client, over a real socket, into a real vault — it is what makes editing
here safe alongside Obsidian.

Rename and delete have routes, client functions and tests but **no UI**, deliberately: the vault has no trash, so the confirmation flow
around a destructive button is a design decision rather than a wiring task. Notes are still authorable through the `weave_note` tool or by
hand, and the note toolbar's "Open in $EDITOR" hands the file to yours. `/weave-view tui` is the read-only in-terminal explorer — the same
model, a containment tree, a 1-hop focus view, node detail and a link-health surface, for when you are on the far end of an SSH session.

### The local server

The workspace server is deliberately small and deliberately paranoid, because loopback is not an authorisation boundary — any local process
can reach the port, and any website you visit can try to via DNS rebinding. Four layers:

1. Binds `127.0.0.1` on an ephemeral port. Never `0.0.0.0`.
2. A `Host` header allowlist (`127.0.0.1:PORT`, `localhost:PORT`, `[::1]:PORT`), which is what actually stops rebinding.
3. A 256-bit per-session token, handed off once in the URL and exchanged for an `HttpOnly; SameSite=Strict` cookie via a redirect that drops
   it from the address bar. Compared in constant time.
4. `Origin` validated when present, and required on anything that is not a `GET` or `HEAD`.

The page is served under a nonce-only CSP — `default-src 'none'`, no `unsafe-inline`, no `unsafe-eval`, no CORS headers at all. The server
shuts itself down after 30 minutes with no client attached, and always at the end of the pi session.

## The formats

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

The `.okf` index is **derived**: delete it, rescan, lose nothing. By default it is excluded from git locally (`.git/info/exclude`);
committing it to share with a team is a deliberate opt-in. The vault location can be overridden with `PI_WEAVE_VAULT`.

## Zero runtime dependencies

`package.json` declares no `dependencies`. The four peers (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, `typebox`) are supplied by the pi harness, which loads `src/pi/index.ts` as TypeScript directly — installing
pi-weave runs no build step.

The browser client cannot work that way, so preact, sigma, graphology, d3-force, marked and DOMPurify are **devDependencies** bundled into a
committed artifact at `src/web/client/dist/app.js`. They are inputs to a build, not runtime requirements of the package.

## For other agent harnesses

The skills follow the [Agent Skills standard](https://agentskills.io/specification), and the on-disk artefacts and `src/core` are
harness-agnostic by design: `src/core` may not import anything pi-specific. Claude Code and opencode adapters are on the roadmap
([docs/design.md](docs/design.md) §21).

## Documentation

| Where | What |
|---|---|
| [docs/design.md](docs/design.md) | the design document — *why* pi-weave is shaped this way |
| [docs/weave-workspace.md](docs/weave-workspace.md) | the browser workspace: library choices with measurements, security model, phases |
| [docs/weave-view-tui-design.md](docs/weave-view-tui-design.md) | the in-terminal explorer |
| [AGENTS.md](AGENTS.md) | contributor and agent rules — read before changing anything |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit, strict, both projects
npm test            # vitest run
npm run coverage    # the 95% gate (lines, branches, functions, statements)
npm run build:web   # rebuild the committed browser bundle
npm run check       # typecheck + bundle drift check + coverage — run this before committing
```

Two rules worth knowing before you send a patch. Coverage must stay at or above **95%** on every metric; the gate is enforced by vitest
thresholds and `npm run check` fails below it. And the committed web bundle must match its source — `npm run check` rebuilds it in memory
and byte-compares, so run `npm run build:web` and commit the result whenever you touch `src/web/`.

Never commit to `main`; branch, then open a PR. See [AGENTS.md](AGENTS.md) for the rest.

## Licence

[MIT](LICENSE).
