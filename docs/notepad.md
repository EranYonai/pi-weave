# Notepad Skill — Product & Design Specification

> Status: **product & design spec**. The skill skeleton exists at [`skills/weave-notepad/SKILL.md`](../skills/weave-notepad/SKILL.md); the
> experience described here is largely roadmap. **Implemented so far:** explicit capture, verbatim scribbles under a `## Raw notes` tail,
> and finalization that restructures the body above the tail while preserving it verbatim (`weave_note` action=finalize, `finalizeNote` in
> `src/core/vault.ts`). During **dictation mode** (live interview note-taking), finalization is continuous: the body is recompiled after
> every interactive append so the note reads as a living document, not just an accumulating raw tail. The graph/visualization layers remain
> roadmap.
>
> Related: [design.md](design.md) (overall architecture, provenance §13, scopes §17), [weave-view.md](weave-view.md) (the viewer this spec
> drives), [testing.md](testing.md). Appendix A maps each concept to the current codebase and lists the deltas this spec implies.

*****
> Eran's directive (2026-08) is incorporated: capture is **explicit** (the user asks for a note to exist), Pi **finalizes** scribbles on
> request, and the raw notes are preserved at the end of the document. See §3 and Appendix A.
*****

The Notepad Skill is the primary human-facing interaction model: it gives Pi the ability to behave like an intelligent meeting/notetaking
assistant while continuously connecting notes to the user's existing knowledge, repositories, and OKF data.

The experience should feel closer to **Granola** than to a traditional markdown editor:

> **The user talks/thinks naturally. Pi captures, structures, connects, and remembers.**

But unlike a traditional AI notetaking application, Pi-Weave maintains a persistent, explorable knowledge graph and connects notes directly
to code and repositories.

---

# 1. Overview

**Pi-Weave** is a visual, local-first knowledge workspace for Pi.

The **Notepad Skill** is the primary human-facing interaction model: it gives Pi the ability to behave like an intelligent
meeting/notetaking assistant while continuously connecting notes to the user's existing knowledge, repositories, and OKF data.

---

# 2. Core Concept

The Notepad Skill sits between:

* the **current Pi session**
* the **user's notes**
* the **OKF knowledge vault**
* the **current repository**
* the **repository `.okf` knowledge database**
* the **visualization layer**

```text
                         PI
                          │
                    Notepad Skill
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
       Session          Vault          Repository
        Notes            OKF              .okf
          │               │                │
          └───────────────┼────────────────┘
                          ▼
                    Pi-Weave Graph
                          │
                          ▼
                  Local Web Viewer
```

The skill should make all of these feel like **one workspace**.

---

# 3. The Granola-inspired experience

Capture is **explicit**. Pi never promotes conversation into notes on its own initiative. A note exists only because the user asked for it
to exist:

> "Start a note on the authentication migration." "Add this to the OIDC note." "Jot that down."

The user drives *what* becomes a note and *when*. Pi's job is to make capture effortless and the result useful — not to decide on the user's
behalf.

For example:

```text
User:
Start a note on the authentication migration.

User:
We're probably going to migrate the authentication
service to OIDC next quarter.
```

Pi appends the user's words as a rough, verbatim scribble to the note. It may internally recognize the shape of the knowledge:

```text
Topic:
Authentication migration

Potential decision:
Move authentication toward OIDC

Status:
Proposal

Time:
Next quarter

Related:
Authentication service
JWT
OAuth
Security architecture
```

But it should **not automatically promote every statement into authoritative knowledge**, and it should **not** create notes the user didn't
ask for.

This distinction is critical.

---

# 4. Capture vs. Knowledge

The Notepad Skill has two layers.

## Raw notes

What was actually said, kept verbatim. Scribbles are appended to a `## Raw notes` tail at the end of the note. This section is **append-only
and never rewritten** — it is the literal record of the user's words.

```text
## Raw notes

"We're probably going to migrate the authentication
service to OIDC next quarter."
```

## Structured knowledge

What Pi believes the statement represents:

```text
Proposal:
Authentication service → OIDC
```

The structured knowledge retains provenance:

```text
Source:
Pi session / Notepad

Status:
Unconfirmed

Confidence:
Inferred

Created:
2026-08-22
```

This prevents the AI from silently turning conversations into facts.

---

# 5. The Notepad is a workspace, not merely a document

A note should be able to contain:

* text
* structured facts
* questions
* decisions
* tasks
* references
* repository entities
* people
* concepts
* links to other notes
* links to code
* links to Git commits
* links to OKF entities

Example:

```text
Authentication Migration
────────────────────────────────

We should probably move to OIDC next quarter.

DECISION
Move authentication toward OIDC
Status: Proposal

QUESTIONS
□ Which services currently depend on JWT claims?
□ What is the migration strategy?

RELATED
→ AuthService
→ Security Architecture
→ Incident #312
→ Decision #42

REPOSITORY
→ src/auth/
→ AuthService
→ TokenValidator
```

The user sees a simple note.

The underlying system sees a graph.

---

# 6. Natural-language commands

The skill should support natural language rather than requiring rigid commands.

Examples:

> Remember that we decided to use OIDC.

> Add this to the authentication project.

> What did we say about this last time?

> Connect this to the authentication architecture.

> Turn that into a task.

> What questions are still unresolved?

> Show me everything related to this discussion.

> Open the relevant part of the repository.

> What changed since our previous discussion?

Pi translates these into deterministic knowledge operations.

---

# 7. The "capture now, organize later" principle

The user should never be forced to organize information while thinking.

During a session:

```text
User talks
   ↓
Pi appends scribbles (on request)
   ↓
Raw notes accumulate
   ↓
Pi identifies structure
   ↓
Knowledge relationships emerge
```

Later:

> Clean this note up.

Pi restructures the top of the note — front-loaded summary, sections, entities, links — while leaving the `## Raw notes` tail untouched. The
principle is scoped **within a note**: capture is explicit (the user asked for the note to exist), but *organization* is deferred until the
user asks to finalize — **except in dictation mode** (see below), where organization runs continuously alongside capture so the compiled
body never lags behind the raw tail.

---

# 8. Session lifecycle

Each Pi session can have an associated Notepad.

```text
Session
 │
 ├── conversation
 ├── observations
 ├── decisions
 ├── questions
 ├── tasks
 └── knowledge changes
```

At any point:

> Show my notes.

The local viewer opens the current Notepad.

---

# 9. Live visualization

This is where Pi-Weave differs substantially from Granola.

While the conversation is happening, the graph can react.

User:

> We're investigating why authentication is slow.

Pi identifies:

```text
Authentication
Performance
Gateway
JWT
Database
Incident #421
```

The browser highlights the relevant nodes.

```text
                Project
                   │
             🔵 Authentication
              /        \
           🔵 JWT    🔵 Gateway
                       │
                    🔵 Database
                       │
                  🔵 Incident
```

The Notepad and graph are two views of the same session.

---

# 10. "Ask → Light Up"

This should become one of Pi-Weave's signature interactions.

User:

> What do we know about the authentication migration?

Pi searches the knowledge space.

The visualization:

1. focuses the relevant region
2. highlights relevant nodes
3. emphasizes relevant edges
4. shows provenance
5. optionally displays the retrieval path

The user can immediately understand **what Pi found**.

---

# 11. Repository-aware notes

When Pi is running inside a repository, the Notepad Skill automatically recognizes the repository.

Example:

```text
~/projects/ipapyaa
```

Pi discovers:

```text
.ipapyaa/.okf
```

or:

```text
./.okf
```

The repository becomes an available knowledge scope.

The user can say:

> Let's investigate why test collection is slow.

Pi can combine:

```text
Current conversation
        +
Repository knowledge
        +
Git history
        +
Vault knowledge
```

---

# 12. Repository exploration from the Notepad

A note can contain repository references.

Example:

```text
Performance Investigation

Hypothesis:
pytest collection is slow because of import-heavy modules.

Repository:
→ pytest runner
→ conftest.py
→ plugin initialization
→ test discovery

Relevant code:
→ src/runner.py
→ tests/conftest.py
```

The user can click a repository entity in the visual UI.

The graph transitions from:

```text
Conceptual knowledge
```

into:

```text
Repository knowledge
```

without leaving the workspace.

---

# 13. Meeting / conversation mode

The Notepad Skill should work particularly well during long conversations.

Pi maintains:

### Topics

```text
Authentication
Testing infrastructure
Deployment
```

### Decisions

```text
Use OIDC
Keep existing JWT compatibility
```

### Questions

```text
How do we migrate existing tokens?
```

### Action items

```text
Investigate gateway changes
```

### References

```text
AuthService
Security Review
Incident #421
```

This creates a structured session summary — but only for notes the user asked to exist, and only when the user asks to finalize them (or, in
dictation mode, after every interactive append — see §7).

---

# 14. End-of-session behavior

At the end of a session:

> Summarize this.

Pi produces:

```text
AUTHENTICATION MIGRATION

Summary
We discussed migrating the authentication service to OIDC.

Decisions
• OIDC is the preferred direction.
• Existing JWT compatibility must remain during migration.

Open questions
• Token migration strategy
• Gateway compatibility

Tasks
□ Investigate gateway changes
□ Review token migration

Related knowledge
• Authentication Architecture
• Security Review
• AuthService
```

But the important part is that these aren't merely generated Markdown.

They are backed by structured knowledge and provenance.

Finalization is **editorial, not generative**: the summary is built from the user's own words, and the `## Raw notes` tail is preserved
verbatim beneath it. Pi only summarizes notes the user asked to exist. In dictation mode this editorial compile runs after every append, so
the summary above the tail stays current throughout the session rather than only at the end.

---

# 15. Knowledge promotion

Not every note should become permanent knowledge.

Use an explicit promotion lifecycle:

```text
Raw Note
   ↓
Candidate Knowledge
   ↓
Confirmed
   ↓
Persistent Knowledge
```

For example:

```text
"Maybe we should migrate to OIDC."
```

becomes:

```text
Proposal
```

not:

```text
Decision
```

Only when the user says:

> We decided to migrate to OIDC.

does it become:

```text
Decision
Status: confirmed
```

---

# 16. The visual UI should show epistemic state

A human should be able to distinguish:

* observed
* proposed
* inferred
* confirmed
* deprecated
* contradicted
* stale

This can be reflected visually.

For example:

```text
Observation ──→ Proposal ──→ Decision
                         \
                          → Rejected
```

The exact visual language can evolve, but the semantic distinction must remain.

---

# 17. Search

The Notepad Skill should provide several types of retrieval.

### Exact

> Find the note mentioning OIDC.

### Semantic

> What did we discuss about authentication migration?

### Graph

> What decisions are related to authentication?

### Temporal

> What changed since last month?

### Repository

> What code implements this decision?

### Provenance

> Where did we get this information?

---

# 18. Context-efficient retrieval

The skill should **not dump entire notes or repositories into Pi**.

Instead:

```text
User query
    ↓
Relevant entities
    ↓
Relevant relationships
    ↓
Relevant source fragments
    ↓
Minimal context
    ↓
Pi
```

This directly addresses the original motivation for building this project:

> **The agent should have access to a large knowledge space without paying the token cost of loading the entire knowledge space.**

---

# 19. Visual context debugger

The human visualization should be able to show:

```text
CURRENT PI CONTEXT

Primary:
  Authentication
  OIDC
  AuthService

Supporting:
  JWT
  Gateway
  Security Review

Sources:
  4 notes
  3 repository files
  2 decisions

Estimated context:
  ~2,400 tokens
```

The user can visually inspect why these nodes were selected.

---

# 20. Notes as graph entry points

Every note should become a navigable region of the graph.

For example:

```text
Note
 │
 ├── Authentication
 │      ├── AuthService
 │      ├── OIDC
 │      └── Security Review
 │
 ├── Decision #42
 │
 └── Incident #312
```

Opening a note can therefore open a **graph neighborhood**, rather than just a text file.

---

# 21. Multiple notes, one knowledge space

Do not create isolated note silos.

Instead:

```text
Note A ─────┐
            │
Note B ─────┼──→ Knowledge Graph
            │
Note C ─────┘
```

This enables:

> What did we discuss about this across all previous sessions?

without manually organizing notes.

---

# 22. Human-first interface

The viewer should feel calm and lightweight.

The user should be able to see:

```text
┌─────────────────────────────────────────┐
│ Authentication Migration                │
│                                         │
│ We discussed migrating to OIDC...       │
│                                         │
│ Decisions                               │
│   • OIDC is preferred                   │
│                                         │
│ Questions                               │
│   • Token migration                     │
│                                         │
│ Related                                 │
│   AuthService   Security   Gateway      │
└─────────────────────────────────────────┘
```

and optionally switch to:

```text
GRAPH
```

or:

```text
TIMELINE
```

or:

```text
CONTEXT
```

The user should never feel like they are operating a database.

---

# 23. Pi remains the primary driver

The browser is not another AI agent.

It doesn't independently decide what the user should know.

Its role is:

```text
Pi
 ↓
semantic instruction
 ↓
Viewer
```

Examples:

> Focus authentication.

> Highlight the migration decisions.

> Show the provenance.

> Compare these two decisions.

> Show the repository implementation.

The browser renders these intents.

---

# 24. Skill responsibilities

The **Notepad Skill** should primarily teach Pi how to:

1. recognize useful information
2. capture it without over-structuring
3. preserve provenance
4. distinguish fact from inference
5. connect notes to existing knowledge
6. search historical notes
7. interact with repository knowledge
8. update the visualization
9. summarize sessions
10. promote confirmed knowledge

The skill should **not** implement the graph or visualization itself.

Those belong to Pi-Weave's underlying tools.

---

# 25. Proposed skill commands

Natural language should be primary, but power users can have explicit commands.

Potential commands:

```text
/notepad
/notepad show
/notepad summarize
/notepad clean
/notepad remember
/notepad search
/notepad graph
/notepad promote
```

These are optional convenience commands, not the fundamental interaction model.

---

# 26. Example end-to-end session

```text
User:
I'm investigating why authentication has become difficult
to maintain.

Pi:
I'll look at our existing knowledge and the current repository.

[Viewer opens]

                    Authentication
                       🔵
                     /     \
                 Gateway    JWT
                   🔵        🔵
                    \        /
                    AuthService
                       🔵
                        |
                    Incident #421
                       🔵
```

User:

> What decisions led us here?

Pi highlights:

```text
Decision #12
Decision #31
Decision #42
```

User:

> Which one is still valid?

Pi follows provenance and dates.

User:

> Show me the implementation.

The graph expands:

```text
Decision #42
      │
   implements
      ↓
AuthService
      │
      ├── TokenValidator
      ├── SessionStore
      └── GatewayAdapter
```

User:

> Add a note that we should investigate replacing the GatewayAdapter.

Pi creates the note (explicit request) and appends the user's words as a verbatim scribble.

Later:

> Summarize this investigation.

Pi finalizes the note: restructures the body above, preserves the raw scribbles under a `## Raw notes` tail.

The knowledge graph remains updated.

---

# 27. MVP for the Notepad Skill

The first version should **not** attempt to reproduce all of Granola.

### MVP

**Capture** (explicit only)

* notes created on request
* verbatim scribbles appended to `## Raw notes`
* finalization on request (restructure body, preserve raw tail)

**Knowledge**

* entities
* relationships
* decisions
* questions
* tasks

**Retrieval**

* search previous notes
* connect to OKF
* connect to `.okf` repository

**Visualization**

* open current note
* highlight related entities
* focus graph on query results

**Repository**

* automatically detect `.okf`
* expose repository entities in notes

---

# 28. Later versions

### V2

* automatic topic extraction
* knowledge promotion
* knowledge diff
* timeline
* contradiction detection
* stale knowledge detection

### V3

* 3D graph
* sophisticated repository architecture visualization
* Git history exploration
* multi-repository knowledge
* external integrations

### V4

* multi-agent knowledge
* shared team vaults
* other agent harnesses
* collaborative knowledge

---

# 29. The key design principle

The Notepad Skill should not create:

> **AI-generated notes.**

It should create:

> **A living knowledge layer from conversations.**

The difference is fundamental.

A traditional AI notetaker gives you:

```text
Meeting
 ↓
Summary
```

Pi-Weave gives you:

```text
Conversation
     │
     ├── Note
     ├── Decision
     ├── Question
     ├── Task
     ├── Repository entity
     ├── Existing knowledge
     └── New relationships
             │
             ▼
       Knowledge Graph
             │
       ┌─────┴──────┐
       ▼            ▼
      Pi          Human
   reasoning    exploration
```

## The product promise

> **Pi remembers the conversation. Pi-Weave shows you how it connects to everything else.**

And the most important interaction remains:

> **Ask Pi → find knowledge → watch the relevant part of your world light up.**

---

# Appendix A — Mapping to the current codebase

Grounding the spec in what exists today:

| Spec concept | Current primitive | Gap |
| --- | --- | --- |
| Capture (§4, §7) | `weave_note` add/append via the skill | Explicit by design (redesign 2026-08): capture only on request; finalization is editorial, raw tail preserved. **Implemented:** `finalizeNote` in `src/core/vault.ts` + `weave_note` action=finalize restructure the body above the `## Raw notes` tail and preserve it verbatim. **Dictation mode:** finalize is called after every interactive append so the body stays continuously compiled (see §7). **Implemented (2026-08):** `append` with `raw: true` appends verbatim dictation into the `## Raw` tail (dated fenced block, tail auto-created); a body with no tail yet is preserved in full as a new tail on finalize; plain appends stay above an existing tail. |
| Retrieval (§17, §18) | `weave_note` search/get with snippets; exact + body search | Semantic/graph/temporal/provenance retrieval variants are future work |
| Repository scope (§11, §12) | `weave_repo` status/scan/overview; auto-detect on session start | Repo *entity* references inside notes (clickable) need the viewer + richer index levels (design §9) |
| Visualization (§9, §10, §20) | none | [weave-view.md](weave-view.md) is the planned layer |
| Epistemic state (§15, §16) | `NoteMeta.source`: `human \| agent \| generated` (design §13) | Spec needs a superset: `observed/proposed/inferred/confirmed/deprecated/contradicted/stale` |
| Session notepad (§8) | none | Can be a vault note per session (`session-<date>-<slug>`) — no new storage primitive required |

## Deltas this spec implies (for the next core iteration)

1. **Richer note status.** The promotion lifecycle and epistemic states (§15–16) don't fit in today's three-value `NoteSource`. Proposal:
   keep `source` for *who wrote it* and add an optional front-matter `status:` (default undefined) for the *epistemic* axis, so
   `human/proposed` and `agent/confirmed` are both representable.
2. **A viewer focus channel.** "Ask → light up" (§10) and §23's semantic instructions need the agent to influence the *already-open* viewer.
   To stay inside the file-based, pull-only viewer model: pi writes `<workspace>/.okf/focus.json` (node ids + intent), the viewer merges it
   into `/graph.json` responses, and the page highlights on change. No websockets, no second writer — the viewer still only reads disk.
3. **Structured entities as note sections.** Decisions/questions/tasks (§13) are MVP-feasible as conventional Markdown headers with
   checklist syntax — no schema migration needed; extraction/promotion becomes a V2 parser over existing notes.
4. **Command naming.** Spec proposes `/notepad*`; current surface uses the `weave-` prefix (`/weave`, `/weave-scan`, planned `/weave-view`).
   Decision pending; one namespace, consistently applied. A future `finalize` convenience command stays under the `weave-` namespace (e.g.
   `/weave-note finalize`) — **not implemented in this sprint**.
5. **Continuous dictation compile.** The skill now teaches Pi to finalize
after every interactive append while live-dictating (§7, §13, §14), so the compiled body above the `## Raw notes` tail stays current instead
of waiting for an end-of-session "finalize". This is behavior in the skill/instructions only — `finalizeNote` already supports it and is
used as-is; no core change required.
