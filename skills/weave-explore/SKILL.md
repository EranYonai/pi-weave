---
name: weave-explore
description: Explore unfamiliar git repositories and answer structural questions about modules, packages, or architecture using the pi-weave index (.okf).
---

# Weave Explore

Use `weave_repo`. Without the tool, read `<repo>/.okf/` directly. The index is a generated, rebuildable cache; source code is authoritative.

## Workflow

1. Read `action=overview`. It builds or refreshes the structure index itself, so there is nothing to scan first.
2. Use the overview's languages, packages, modules, and entry points to select relevant paths instead of listing the whole repository.
3. Read available `.okf/repository/summaries/` sidecars before opening full files.
4. Inspect the relevant code and cite indexed paths in your answer.

## Commands

- `/weave-scan` generates file summaries using the session model. Offer it when summaries would help and the overview shows none;
  never run it implicitly. Only changed content is summarized again.
- `/weave-view` opens the browser workspace.
- `/weave-scan sessions [path]` writes session memories to the vault, not the repository index; see `weave-notepad`.

## Files and trust

```text
.okf/
├── okf.json               # format version + generator
└── repository/
    ├── identity.json      # name, remotes, default branch
    ├── git.json           # HEAD, branch, changed files
    ├── structure.json     # languages, packages, modules, entry points
    └── summaries/         # generated file summaries, when present
```

Index content is `source: generated`. Store user corrections as human knowledge in the vault, never only in the derived index.
