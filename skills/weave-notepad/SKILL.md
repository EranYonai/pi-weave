---
name: weave-notepad
description: "Take and retrieve durable notes in the pi-weave vault. Use when the user asks to remember something or to start/add to a note (aliases: notes, ai note, note-taking, note-taker), or when answering questions about past decisions, people, or projects. Also handles interview note-taking where raw dictations are appended AND expanded, and deterministic repair of stale [[wiki-links]] between notes."
---

# Weave Notepad

The pi-weave vault is the user's long-term memory: plain Markdown notes with front matter under `~/.okf/notes/`. It is shared with the human
— anything you write here, they can read and edit, and vice versa.

## Tools

In pi, use the `weave_note` tool. In other harnesses (or when the tool is not available), operate on the files directly:

- **Notes** live at `~/.okf/notes/<slug>.md` (vault root overridable via `PI_WEAVE_VAULT`).
- Each note has YAML front matter: `title`, `created`, `updated` (ISO-8601), `tags: [..]`, and `source: human | agent | generated`.
- `weave_note` actions: `list`, `get`, `add`, `append`, `finalize`, `search`, `links`, `suggest`. `finalize` restructures the body *above* the `## Raw` tail and
  preserves the tail verbatim — a body with no tail yet is preserved **in full** as a newly created tail, so finalization never destroys
  dictation.
- **Dictation appends**: use `append` with `raw: true` — the tool appends the text verbatim into the `## Raw` tail as a dated fenced block,
  creating the tail if the note has none. In pi, never hand-format the raw tail; the tool maintains it.

## Raw Tail Format

In pi you rarely format this by hand: `weave_note` append with `raw: true` appends a dated fenced block into the tail (and creates the whole
tail — separator, heading, notice — when the note has none). The format below is what that produces, and what to write when editing files
directly or working in other harnesses.

Every note maintains a verbatim, append-only raw section at the bottom separated by a horizontal rule (`---`):

---

## Raw
<!-- NEVER edit below this line. Verbatim user input preserved here. -->

```
<Initial verbatim input>
```

<!-- appended 2026-08-23 08:45 -->
```
<Follow-up verbatim user input>
```

### How to capture and append raw input

1. **Divider and Heading**: The raw section starts with `---` followed by `## Raw` and the notice comment: `<!-- NEVER edit below this line.
   Verbatim user input preserved here. -->`.
2. **Code Blocks for Verbatim Input**: Always wrap verbatim user lines inside code blocks (triple backticks).
3. **Date and Time on Appends**: When appending subsequent snippets, prepend each snippet with: `<!-- appended YYYY-MM-DD HH:MM -->`.
4. **Finalization (`finalize`)**:
   - `finalize` replaces or structures content only above the `---` and `## Raw` section.
   - The `## Raw` block and all verbatim code blocks are never modified or removed.

## Dictation mode (continuous compile)

During live dictation / interview note-taking (see the skill description), Pi does **not** wait until the end to organize the note. Every
interactive append is immediately compiled into the body:

1. **Append the raw words verbatim** into the `## Raw` tail (`weave_note` action=append with `raw: true` — the tool adds the dated code block
   and creates the tail if missing).
2. **Then immediately finalize** (`weave_note` action=finalize): rewrite the body *above* the `## Raw` tail — front-loaded summary,
   sections, decisions, questions, tasks, entities, links — so the compiled document reflects everything said so far.
3. **Never rewrite or remove the `## Raw` tail.** It stays append-only and verbatim; only the body above it changes.

The result is a continuously-updated compiled document that stays current throughout the session — not just a raw tail that gets organized
once at the end.

## When to take a note

Create a note **only when the user explicitly asks** for one to exist: "start a note on X", "add to the X note", "remember this", "jot that
down". Never promote conversation into a note on your own initiative — capture is explicit by design.

## When NOT to take a note

- Anything derivable from the repository itself (that knowledge belongs to the `.okf` index, not the vault).
- Session-scratch information (in-progress task state).
- Secrets, credentials, or anything the user hasn't confirmed is safe to persist.

## How to write a good note

0. **Go straight to the tool.** A note is one `weave_note` call. Do not `list` the vault, inspect the repository, or run `git` — none of that
   informs what to write, and on a large vault `list` alone floods the context. When the user gives you the content ("note that says X"),
   `add` it and report the slug.
1. **Search first when adding to existing knowledge** (`weave_note` action=search, with the note's key terms): if a note on the subject
   exists, `append` to it rather than creating a duplicate. Skip this when the user is clearly starting something new — one targeted search,
   never a vault listing.
2. Title: short noun phrase ("Auth boundary decision", not "Notes").
3. **Ask only when the content is genuinely missing.** A vague request ("write a note weave") needs one short question, not exploration —
   searching the vault or the repo will not reveal what the user meant.
4. **Scribble in, verbatim.** When the user is dictating, append their words to the note as rough, verbatim scribbles — no silent rewording.
   Append with `raw: true` so they land under the `## Raw` tail at the end of the note (the tail is created automatically if missing).
5. **Compile continuously during dictation.** After *every* interactive append in dictation mode, immediately finalize the body *above* the
   raw tail so the compiled doc stays current (see [Dictation mode](#dictation-mode-continuous-compile)). Outside dictation mode,
   compilation stays on request.
6. **Finalize on request.** When the user says "finalize this" / "clean this up", restructure the body *above* the raw tail: front-loaded
   summary, sections, entities, links. Use `weave_note` action=finalize (or edit the file directly in other harnesses). Move nothing out of
   `## Raw` — it is append-only and never rewritten. A note with no `## Raw` tail yet gets its entire pre-finalize body preserved as a new
   raw tail: finalization is editorial, never destructive.
7. Tags: 1–4 lowercase tags; reuse existing tags when possible.
8. Provenance: notes the user scribbled stay `source: human` (finalization is editorial, not authorship) — pass `source: "human"` to `add`
   for user-scribbled notes. Notes you draft from scratch are `source: agent` (the default). Never overwrite a `source: human` note's
   meaning; append with a dated "Agent addendum" section instead.

## Session memory (`notes/sessions/`)

`/weave-scan sessions` summarizes past agent session transcripts into generated notes under `notes/sessions/`. These are ordinary vault notes — `search` and `get` reach them like any other — with three differences worth knowing:

- They are `source: generated`, not human knowledge. Treat one as a recollection of what a past session did, not as a decision record; a human note that contradicts it wins.
- Each carries a `## Takeaways` section: reusable technical lessons (gotchas, root causes, non-obvious rules) from that session. When the user hits a problem that smells familiar, search the vault before re-deriving the answer — a previous session may already have paid for it.
- They are re-derivable. The scan rewrites a note in place when its transcript changes, preserving human edits above the raw tail, so no session note is the only copy of anything.

The scan is opt-in and never runs on its own. Suggest it when the user asks why the agent keeps forgetting across sessions, or wants history from another tool (`/weave-scan sessions <path>` accepts any history file or directory). Never run it unprompted: it spends model tokens per changed session.

## Retrieving knowledge

When the slug is known, use `weave_note` action=get directly. Otherwise use one targeted `search` with the user's key terms. A search with
one result or one unique exact-title match returns the full note; that result is sufficient, so do not call `get` again. If several
plausible candidates remain, fetch at most the three strongest slugs together in the next tool round. If the answer is still ambiguous,
ask the user for another identifier instead of reformulating and repeating the search. Never list the vault to find a note.

Search results are strongest-first and include match evidence, metadata, excerpts, and a bounded set of connected notes found through
links, backlinks, shared tags, and shared distinctive terms. Use that context before making another tool call. Connections are lexical and
explicit, not semantic.

When a note and the repository index disagree, trust the repository for facts about code and flag the discrepancy — the note may be stale
intent.

## Repairing stale links

A link written as a bare title or basename — `[[Quarterly Roadmap]]` when the note is `planning/roadmap-2026` — resolves to nothing.
**Never reconnect a vault by reading every note and guessing which ones relate.** Run the deterministic pass instead:

```jsonc
weave_note { "action": "links" }              // report: fixable / ambiguous / unresolvable
weave_note { "action": "links", "fix": true } // apply only the unambiguous repairs
```

It resolves by exact slug, then unique basename, then unique title — each requiring exactly one candidate. Ambiguous links are reported
with their candidates and never guessed; unresolvable ones point at notes that were never written. Aliases are preserved, the `## Raw`
tail and code fences are never touched, and `updated` is not bumped. Report first, apply after the user sees it.

To find connections that were **never written** — two notes that belong together but have never referenced each other — use `suggest`:

```jsonc
weave_note { "action": "suggest" }                      // strongest unlinked pairs
weave_note { "action": "suggest", "slug": "some/note" } // what relates to one note
```

It ranks pairs by how much *rare* vocabulary they share, and cites the shared terms as evidence. **`suggest` never writes** — there is no `fix`.
A similarity score is a soft signal and a `[[link]]` is a hard claim, so propose the worthwhile pairs to the user and add links only to those they
confirm.

See [references/link-repair.md](references/link-repair.md) for the full rules, guarantees, and when to run each.
