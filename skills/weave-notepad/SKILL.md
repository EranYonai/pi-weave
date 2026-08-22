---
name: weave-notepad
description: Take and retrieve durable notes in the pi-weave vault. Use when the user asks to remember something, when a decision or preference worth keeping surfaces, or when answering questions about past decisions, people, or projects.
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

## When to take a note

- The user says "remember this", "note that", "jot this down".
- A durable fact surfaces: an architecture decision, a person's role, a
  project constraint, a stated preference.
- You discover something non-obvious that took real effort to learn.

## When NOT to take a note

- Anything derivable from the repository itself (that knowledge belongs to
  the `.okf` index, not the vault).
- Session-scratch information (in-progress task state).
- Secrets, credentials, or anything the user hasn't confirmed is safe to persist.

## How to write a good note

1. **Search first** (`weave_note` action=search): if a note exists, `append`
   to it rather than creating a duplicate.
2. Title: short noun phrase ("Auth boundary decision", not "Notes").
3. Body: Markdown, front-loaded — the first line should answer "what is this".
4. Tags: 1–4 lowercase tags; reuse existing tags when possible.
5. Provenance: notes you write are `source: agent`. Never overwrite a
   `source: human` note's meaning; append with a dated "Agent addendum"
   section instead.

## Retrieving knowledge

Use `weave_note` action=search with the user's key terms, then `get` the best
hits. When a note and the repository index disagree, trust the repository for
facts about code and flag the discrepancy — the note may be stale intent.
