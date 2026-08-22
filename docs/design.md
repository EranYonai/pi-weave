# pi-weave — Design

## The identity: one workspace, two faces

pi-weave is **two products that are secretly one**:

1. **A smart notepad with AI skills.** A persistent, local-first vault of human
   knowledge — decisions, ideas, people, meetings — that the agent can read,
   write, search, and maintain *for* you, and that you can read and edit
   yourself, because it is plain Markdown on disk.

2. **A repository exploration engine.** A derived, machine-generated knowledge
   index of the codebase you are standing in (`./.okf/`), built up
   progressively, git-aware, rebuildable, disposable.

And one rule that holds across both:

> **Everything pi-weave produces must be equally usable by humans and by agents.**

Humans and agents read the same files, write the same formats, and traverse the
same graph. The agent is a first-class author (with provenance marking), and
the human is a first-class reader (plain text, no opaque database). Neither is
a second-class consumer of the other's output.

This duality is the product. A notepad alone is Obsidian. A repo index alone
is a code-search tool. **A notepad and a repo index that humans and agents
share — that is pi-weave.**

Yes. This makes the architecture substantially more interesting. The **repository itself becomes a first-class knowledge source**, and `.okf` becomes the local, derived knowledge index for that repository.

I would change the model from "personal OKF vault" to a **knowledge workspace with multiple scopes**.

# Revised Architecture: Vault + Repository Knowledge

The key distinction is:

> **The vault is the user's persistent knowledge. `.okf` is the machine-generated knowledge of a repository.**

They can interact, but they should not be conflated.

```text
                         PI
                          │
                 ┌────────▼────────┐
                 │  Knowledge      │
                 │  Workspace      │
                 └────────┬────────┘
                          │
             ┌────────────┼─────────────┐
             │            │             │
             ▼            ▼             ▼
          VAULT        REPOSITORY     SESSION
             │            │             │
             │          .okf            │
             │            │             │
             └────────────┼─────────────┘
                          │
                          ▼
                    Graph / Context
                          │
                          ▼
                    Human Viewer
```

## 1. Two fundamentally different kinds of knowledge

### Vault knowledge

Human/agent-maintained persistent knowledge:

```text
~/.okf/
```

or whatever location the user chooses.

Contains things like:

```text
projects
decisions
people
ideas
concepts
meetings
personal knowledge
```

This is **semantic knowledge about the world**.

---

### Repository knowledge

Automatically generated knowledge about a codebase:

```text
my-project/
├── .okf/
│   ├── ...
│   └── ...
├── src/
├── tests/
├── docs/
└── ...
```

This is **structural knowledge about software**.

It can contain:

```text
repositories
modules
packages
classes
functions
interfaces
APIs
dependencies
tests
configuration
CI pipelines
documentation
architectural boundaries
ownership
relationships
```

The crucial point:

> `.okf` should be treated as a **derived knowledge database**, not as a second human vault.

---

# 2. Automatic repository discovery

This should be completely frictionless.

User:

```text
$ cd ~/projects/my-agent
$ pi
```

The plugin detects:

```text
cwd
 ↓
Git repository?
 ↓
.okf exists?
```

If it doesn't exist:

```text
Repository knowledge not initialized.

[Explore repository]
```

Or Pi can simply understand:

> Explore this repository.

The plugin creates:

```text
./.okf/
```

and begins indexing.

No configuration should be necessary for the common case.

---

# 3. `.okf` should be Git-aware

This is important.

We don't want to blindly scan the repository every time.

The repository knowledge should have awareness of:

```text
HEAD
branch
commit
working tree
file hashes
```

Conceptually:

```text
Repository
    │
    ├── source files
    ├── Git history
    ├── configuration
    └── documentation
           │
           ▼
       OKF compiler
           │
           ▼
        .okf/
```

When the repository changes:

```text
git diff
   ↓
affected files
   ↓
affected knowledge
   ↓
incremental update
```

This is dramatically cheaper than re-indexing everything.

---

# 4. The `.okf` database is a compiled representation

I would think of it almost like a compiler artifact:

```text
Repository source
       │
       ▼
  Repository analyzer
       │
       ▼
  Repository knowledge
       │
       ▼
      .okf
```

This gives us a very useful mental model:

> **Source code is the source of truth. `.okf` is the compiled semantic index.**

If `.okf` is deleted:

```text
rm -rf .okf
```

nothing is lost.

It can be regenerated.

That's very different from the user's vault.

---

# 5. Vault vs repository knowledge

This distinction should be explicit in the UI.

For example:

```text
KNOWLEDGE

🌐 Vault
   Architecture decisions
   Project history
   People
   Meetings

📦 Repository
   my-project
      Modules
      APIs
      Tests
      Dependencies
      Architecture
```

And Pi can reason across both.

---

# 6. This creates a very powerful query

Suppose the user asks:

> Why is the authentication service structured this way?

Pi can combine:

```text
Vault
  ↓
Architecture decision
  ↓
Repository
  ↓
Authentication module
  ↓
Git history
  ↓
Commit
  ↓
Pull request
```

Now we have something much more interesting than either a code agent or an Obsidian vault.

We have:

# **semantic knowledge + actual implementation**

---

# 7. The graph becomes a bridge between code and knowledge

Imagine:

```text
                Authentication
                      │
          ┌───────────┼────────────┐
          │           │            │
          ▼           ▼            ▼
       Decision     Service       Incident
          │           │            │
          │           │            │
          │       src/auth/       Jira
          │           │
          │       AuthService
          │           │
          │       JWTHandler
          │
          └──── Git commit
```

The human can traverse:

**decision → implementation → commit → incident**

and Pi can reason over the same graph.

This is a major differentiator.

---

# 8. "Explore this repo" becomes a first-class Pi capability

User:

> Explore this repository.

Pi should not simply respond:

> "The repo contains 47 Python files..."

Instead it starts constructing a semantic model.

Potential stages:

```text
Repository discovery
        ↓
Language / framework detection
        ↓
Project structure
        ↓
Module relationships
        ↓
Public interfaces
        ↓
Tests
        ↓
Configuration
        ↓
CI/CD
        ↓
Git history
        ↓
Documentation
        ↓
Architecture inference
```

The result becomes `.okf`.

---

# 9. But we need levels of repository knowledge

Don't immediately analyze every function in a 500k-line repository.

Use progressive depth.

### Level 0 — Structure

```text
directories
files
languages
packages
```

### Level 1 — Architecture

```text
modules
dependencies
interfaces
entry points
```

### Level 2 — Semantics

```text
classes
functions
data flows
important symbols
tests
```

### Level 3 — History

```text
commits
authors
changes
architectural evolution
```

### Level 4 — AI interpretation

```text
architectural patterns
responsibilities
invariants
potential risks
```

This can make repository exploration dramatically cheaper.

---

# 10. The user should control expansion

This maps beautifully onto the visualization.

Start:

```text
Repository
 ├── src
 ├── tests
 ├── docs
 └── infrastructure
```

User asks:

> Show me the authentication architecture.

Graph expands:

```text
                Authentication
                 /     |      \
                /      |       \
          API Gateway  Auth    JWT
                       Service
                         |
                      Database
```

Then:

> Show implementation.

The graph expands into actual repository symbols.

```text
Auth Service
    │
    ├── AuthController
    ├── AuthService
    ├── TokenValidator
    └── SessionStore
```

---

# 11. This makes the visualization much more useful

The human layer can have distinct node categories:

```text
🟣 Vault knowledge
🔵 Repository
🟢 Code symbol
🟡 Git history
🟠 External source
```

Then connections show where knowledge comes from.

For example:

```text
             Architecture Decision
                    🟣
                     │
                  implements
                     │
                     ▼
                AuthService
                    🟢
                     │
                 introduced by
                     │
                     ▼
                Git Commit
                    🟡
```

Now the graph is literally connecting **human knowledge with software reality**.

---

# 12. Repository `.okf` should be scoped

I'd make repository knowledge explicitly identify its repository.

Something conceptually like:

```text
.okf/
    repository/
       identity
       structure
       symbols
       dependencies
       history
       architecture
```

The exact format can follow OKF rather than inventing another database schema.

But the conceptual namespace matters.

We should always know:

> Is this knowledge about the repository, or about the user's broader world?

---

# 13. Don't mix generated and human-authored knowledge

This is critical.

Suppose the agent analyzes:

> `AuthService` is responsible for token validation.

That should be marked as:

```text
generated
source: repository
```

If the user says:

> AuthService is intentionally responsible for token validation because of security boundary X.

That becomes:

```text
human-confirmed
source: user
```

Then the graph can show the distinction.

This prevents the `.okf` repository index from becoming an untrusted pile of AI assertions.

---

# 14. Repository knowledge should update automatically

Potential triggers:

### Pi startup

Check whether repository changed.

### File watcher

For active development.

### Git operation

After checkout/pull/merge.

### Explicit command

```text
> refresh repository knowledge
```

### Pi detects a relevant change

For example:

> You modified the authentication subsystem. The repository knowledge index is stale.

Then:

```text
[Update]
[Ignore]
```

---

# 15. The `.okf` directory should probably be ignored by Git initially

This deserves thought.

There are two possible models.

### Model A — Local derived cache

```text
.okf/
→ .gitignore
```

Advantages:

* cheap
* machine-specific
* always rebuildable

### Model B — Versioned semantic repository knowledge

```text
.okf/
→ committed
```

Advantages:

* team shares architectural knowledge
* knowledge diff works
* CI can consume it
* agents share the same repository model

I think the architecture should support both.

But **default to local generated cache initially**.

Later, users can opt into committing it.

---

# 16. This creates an extremely interesting team workflow

Imagine a repository where `.okf` is committed.

Developer A updates architecture.

Developer B pulls.

Now their agents automatically understand the same semantic repository model.

```text
Git
 │
 ▼
.okf
 │
 ├── Pi
 ├── Claude
 ├── Codex
 └── Human viewer
```

That could become a powerful open-source convention.

---

# 17. The vault becomes a union of knowledge scopes

The conceptual model could be:

```text
                    KNOWLEDGE SPACE
                          │
          ┌───────────────┼───────────────┐
          │               │               │
        Vault          Repository       External
          │               │               │
       personal        source code     integrations
       decisions       architecture
       concepts        history
       projects        dependencies
```

Pi can traverse across them.

The viewer can visually distinguish them.

---

# 18. The killer query now becomes much more powerful

Instead of:

> "What do we know about authentication?"

You can ask:

> **"Why is authentication implemented this way?"**

Pi can answer using:

```text
Vault:
  architectural decision

Repository:
  implementation

Git:
  historical change

Knowledge:
  security incident
```

And the graph lights up all four.

That is something neither a traditional code agent nor Obsidian gives you naturally.

---

# 19. Updated product architecture

I would now define **four layers**:

```text
                         PI
                          │
                   Agent Interface
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
       Vault          Repository       External
      Knowledge       Knowledge        Knowledge
          │               │                │
          └───────────────┼────────────────┘
                          ▼
                  Knowledge / Context
                       Engine
                          │
                          ▼
                    Unified Graph
                          │
                          ▼
                  Local Web Viewer
```

And the repository itself has:

```text
Repository
     │
     ▼
Analyzer
     │
     ▼
.okf
     │
     ▼
Graph
```

---

# 20. This changes the project positioning

I would now stop describing the project as:

> **Pi + OKF + visualization**

and describe it as:

# **An agent-native knowledge workspace for your life and your code.**

Or more technically:

> **A local-first knowledge graph for Pi that unifies human knowledge, repository knowledge, and agent context — with a live visual interface.**

The key UX:

> **Ask Pi anything. See the knowledge it found light up. Expand into the repository when you need to understand the implementation.**

That is a substantially stronger product.

And `.okf` being automatically discovered in `cwd` is exactly the right convention: **when you're inside a repository, Pi should automatically know that there is a local semantic model of the codebase available.**

---

# 21. Multi-agent portability: pi first, then Claude Code and opencode

pi-weave is built for pi. But the duality makes one thing obvious: **the
artifacts must not be pi-specific.** A vault your next agent harness cannot
read is a lock-in trap, and a `.okf` index that only pi understands defeats
the team-sharing story from §16.

So the architecture is split into **portable core** and **thin adapters**:

```text
            ┌──────────── portable artifacts ─────────────┐
            │   ~/.okf/ vault (Markdown + frontmatter)    │
            │   <repo>/.okf/ index (JSON documents)       │
            │   skills/ (Agent Skills standard)           │
            └─────────────────────┬───────────────────────┘
                                  │
                       pi-weave core (pure TS,
                       zero harness imports)
                                  │
        ┌────────────────┬────────┴─────────┬──────────────┐
        ▼                ▼                  ▼              ▼
   pi adapter      Claude Code        opencode adapter   MCP server
   (extension)     adapter (plugin/   (plugin)           (stdout/JSON,
                   skills + hooks)                        optional)
```

### What is portable, concretely

1. **The vault.** Plain Markdown files with YAML front matter. Any agent,
   any editor, Obsidian included. An agent that can read files can use the
   vault; no API, no database, no lock.

2. **The `.okf` repository index.** JSON documents in a documented layout
   (see Appendix A). Any harness — pi, Claude Code, opencode, CI — can read
   it, regenerate it, or check its staleness with plain `git` commands.

3. **The skills.** pi-weave's workflows ("how to take a good note", "how to
   explore a repo with weave") are authored to the [Agent Skills
   standard](https://agentskills.io/specification) (`SKILL.md` + frontmatter).
   pi loads them natively; Claude Code loads the same directories from its
   skills paths; opencode supports the same convention. One skill, three
   harnesses.

4. **The core library.** `src/core` contains every interesting behavior —
   vault store, repo scanner, staleness logic, search — and imports **nothing**
   from `@earendil-works/*`. Adapters (`src/pi`, future `src/claude-code`,
   `src/opencode`) only translate harness events/tool-calls into core calls.

### Adapter roadmap

| Harness     | Mechanism                                        | Status  |
|-------------|--------------------------------------------------|---------|
| pi          | Extension (tools, commands, events, skills)      | **MVP** |
| Claude Code | Plugin: skills + slash commands + hooks          | Planned |
| opencode    | Plugin (tool registrations)                      | Planned |
| Any         | MCP server wrapping the core                     | Future  |

The rule for all adapters: **no logic in adapters**. Adapters wire events to
the core; the core owns behavior; the artifacts stay readable everywhere.

That is what keeps the §16 team workflow honest: developer A may use pi,
developer B Claude Code, CI a plain script — all three consume and produce
the same `.okf`.

---

# 22. Implementation phases

### Phase 1 — Walking skeleton (this repository, today)

- Core: vault store (Markdown + frontmatter), repo scanner (Level 0 +
  light Level 1), git-aware staleness, workspace status across scopes
- pi adapter: `weave_note` tool (the notepad), `weave_repo` tool
  (explore/status), `/weave` command, `session_start` auto-discovery
- Skills: `weave-notepad`, `weave-explore`
- ≥95% test coverage on all shipped code

### Phase 2 — Trustworthy repository knowledge

- Incremental refresh driven by `git diff` (§3)
- Level 2 semantics (symbols, interfaces) for TS/JS/Python/Go/Rust
- Provenance marking end-to-end (§13): `generated` vs `human-confirmed`

### Phase 3 — The graph and the viewer

- Unified graph over vault + repository + history (§7, §11)
- Local web viewer; query lights up nodes (§18)

### Phase 4 — Everywhere

- Claude Code + opencode adapters (§21)
- Committed `.okf` team workflows (§15 Model B, §16)
- External knowledge sources (§17)

---

# Appendix A — OKF v1 (minimal on-disk format)

"OKF" is intentionally boring. Boring is portable.

### Vault: `~/.okf/`

```text
~/.okf/
├── okf.json            # { "okfVersion": 1, "scope": "vault" }
└── notes/
    └── <slug>.md       # one file per note
```

A note:

```markdown
---
title: Auth boundary decision
created: 2026-08-22T09:00:00.000Z
updated: 2026-08-22T09:30:00.000Z
tags: [auth, security]
source: human           # human | agent | generated
---

Markdown body, free-form. Wiki-links later, plain text today.
```

### Repository index: `<repo>/.okf/`

```text
.okf/
├── okf.json                 # { "okfVersion": 1, "scope": "repository",
                             #   "generator": "pi-weave@x.y.z",
                             #   "source": "generated" }
└── repository/
    ├── identity.json        # name, root, remotes, default branch
    ├── git.json             # headSha, branch, changed files + worktree
                             #   content hashes — staleness anchor
    └── structure.json       # Level 0/1: files, languages, packages, modules
```

Rules:

- `.okf` is **derived**. `rm -rf .okf` loses nothing (§4). Default:
  gitignored (§15 Model A); committing is an explicit opt-in (Model B).
- Everything machine-written carries provenance. The vault notes
  written by agents say `source: agent`; analysis says `source: generated`.
- Unknown fields are ignored, so older agents can read newer indexes.
