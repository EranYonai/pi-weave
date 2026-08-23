---
name: weave-notepad
description: Take and retrieve durable notes in the pi-weave vault. Use when the user asks to remember something or to start/add to a note (aliases: notes, ai note, note-taking, note-taker), or when answering questions about past decisions, people, or projects. Also handles interview note-taking where raw dictations are appended AND expanded.
---

# Weave Notepad

The pi-weave vault is the user's long-term memory: plain Markdown notes with
front matter under `~/.okf/notes/`. It is shared with the human — anything
you write here, they can read and edit, and vice versa.

## Tools

In pi, use the `weave_note` tool. In other harnesses (or when the tool is not
available), operate on the files directly:

- **Notes** live at `~/.okf/notes/<slug>.md` (vault root overridable via `PI_WEAVE_VAULT`).
- Each note has YAML front matter: `title`, `created`, `updated` (ISO-8601),
  `tags: [..]`, and `source: human | agent | generated`.
- `weave_note` actions: `list`, `get`, `add`, `append`, `finalize`, `search`.
  `finalize` restructures the body *above* the `## Raw` tail and preserves
  the tail verbatim.

## Raw Tail Format

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

1. **Divider and Heading**: The raw section starts with `---` followed by `## Raw` and the notice comment: `<!-- NEVER edit below this line. Verbatim user input preserved here. -->`.
2. **Code Blocks for Verbatim Input**: Always wrap verbatim user lines inside code blocks (triple backticks).
3. **Date and Time on Appends**: When appending subsequent snippets, prepend each snippet with: `<!-- appended YYYY-MM-DD HH:MM -->`.
4. **Finalization (`finalize`)**:
   - `finalize` replaces or structures content only above the `---` and `## Raw` section.
   - The `## Raw` block and all verbatim code blocks are never modified or removed.

## When to take a note

Create a note **only when the user explicitly asks** for one to exist:
"start a note on X", "add to the X note", "remember this", "jot that down".
Never promote conversation into a note on your own initiative — capture is
explicit by design.

## When NOT to take a note

- Anything derivable from the repository itself (that knowledge belongs to
  the `.okf` index, not the vault).
- Session-scratch information (in-progress task state).
- Secrets, credentials, or anything the user hasn't confirmed is safe to persist.

## How to write a good note

1. **Search first** (`weave_note` action=search): if a note exists, `append`
   to it rather than creating a duplicate.
2. Title: short noun phrase ("Auth boundary decision", not "Notes").
3. **Scribble in, verbatim.** When the user is dictating, append their words
   to the note as rough, verbatim scribbles — no silent rewording. Keep them
   under the `## Raw` tail format at the end of the note.
4. **Finalize on request.** When the user says "finalize this" / "clean this
   up", restructure the body *above* the raw tail: front-loaded summary,
   sections, entities, links. Use `weave_note` action=finalize (or edit the
   file directly in other harnesses). Move nothing out of `## Raw` — it
   is append-only and never rewritten.
5. Tags: 1–4 lowercase tags; reuse existing tags when possible.
6. Provenance: notes the user scribbled stay `source: human` (finalization is
   editorial, not authorship) — pass `source: "human"` to `add` for
   user-scribbled notes. Notes you draft from scratch are `source: agent`
   (the default). Never overwrite a `source: human` note's meaning; append
   with a dated "Agent addendum" section instead.

## Retrieving knowledge

Use `weave_note` action=search with the user's key terms, then `get` the best
hits. When a note and the repository index disagree, trust the repository for
facts about code and flag the discrepancy — the note may be stale intent.
