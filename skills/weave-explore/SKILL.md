---
name: weave-explore
description: Explore a git repository through its pi-weave knowledge index (.okf). Use when starting work in an unfamiliar repo, when asked to "explore this repository", or before broad structural questions about modules, packages, or architecture.
---

# Weave Explore

pi-weave keeps a **derived** knowledge index of the repository at
`<repo>/.okf/`. Source code is the truth; the index is a rebuildable cache.
Deleting `.okf` loses nothing — rescan to regenerate it.

## Tools

In pi, use the `weave_repo` tool (or the `/weave-scan` command). To see
the assembled graph in the terminal, run `/weave-view tui` (Explore tree,
Focus neighborhood, Health surface); `/weave-view` opens the browser viewer.
In other harnesses, read the JSON documents under `.okf/` directly.

## Workflow

1. **Check for an index**: `weave_repo` action=status.
   - `missing` → offer to scan (`weave_repo` action=scan), or scan directly
     when the user asked to explore.
   - `stale` → scan again; the repository moved on.
   - `fresh` → read it: action=overview.
2. **Start from the overview**: file counts, languages, packages, module
   groupings, and likely entry points. This replaces dozens of `ls`/`find`
   calls.
3. **Descend progressively** (design §9): only open files in modules relevant
   to the user's question. The index gives you the map; the code gives you
   the terrain.
4. **Read summaries before full files**: if the repo has been deep-scanned
   (`.okf/repository/summaries/` exists), read the relevant sidecars first —
   they tell you what a file does and its outward surface in 1–3 sentences,
   so you can decide whether to open the full file at all.
5. **Answer with structure**: name modules and packages by their indexed
   paths so the user can jump straight to them.

## Deep summaries

`/weave-scan deep` creates or refreshes `.okf/repository/summaries/` — one
sidecar per file, written by the session model. It is **opt-in and
incremental**: it never runs implicitly, and it only re-summarizes files
whose content hash changed since their last summary. If summaries are
missing or stale, offer `/weave-scan deep` to create or refresh them before
diving into full files.

## On-disk layout

```text
.okf/
├── okf.json               # format version + generator
└── repository/
    ├── identity.json      # name, remotes, default branch
    ├── git.json           # HEAD sha + branch + changed files (staleness anchor)
    ├── structure.json     # languages, packages, modules, entry points
    └── summaries/         # deep-scan sidecars (one per file, when present)
```

## Trust model

Everything in `.okf` is machine-generated (`source: generated`). If the user
corrects an interpretation, that correction belongs in the vault (see the
`weave-notepad` skill) as human knowledge, not in the derived index.
