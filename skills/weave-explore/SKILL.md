---
name: weave-explore
description: Explore a git repository through its pi-weave knowledge index (.okf). Use when starting work in an unfamiliar repo, when asked to "explore this repository", or before broad structural questions about modules, packages, or architecture.
---

# Weave Explore

pi-weave keeps a **derived** knowledge index of the repository at
`<repo>/.okf/`. Source code is the truth; the index is a rebuildable cache.
Deleting `.okf` loses nothing — rescan to regenerate it.

## Tools

In pi, use the `weave_repo` tool (or the `/weave-scan` command). In other
harnesses, read the JSON documents under `.okf/` directly.

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
4. **Answer with structure**: name modules and packages by their indexed
   paths so the user can jump straight to them.

## On-disk layout

```text
.okf/
├── okf.json               # format version + generator
└── repository/
    ├── identity.json      # name, remotes, default branch
    ├── git.json           # HEAD sha + branch + changed files (staleness anchor)
    └── structure.json     # languages, packages, modules, entry points
```

## Trust model

Everything in `.okf` is machine-generated (`source: generated`). If the user
corrects an interpretation, that correction belongs in the vault (see the
`weave-notepad` skill) as human knowledge, not in the derived index.
