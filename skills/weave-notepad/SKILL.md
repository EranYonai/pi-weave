---
name: weave-notepad
description: "Create, update, and retrieve durable notes and past decisions. Use for remember/note requests (notes, ai note, note-taking, note-taker), live dictation, interviews, and repairing or suggesting [[wiki-links]]."
---

# Weave Notepad

The pi-weave vault is the user's long-term memory: plain Markdown notes with front matter under `~/.okf/notes/`. It is shared with the human
— anything you write here, they can read and edit, and vice versa.

Use `weave_note`. Without the tool, edit the files directly (`PI_WEAVE_VAULT` overrides the vault root). Front matter:
`title`, `created`, `updated` (ISO-8601), `tags`, and `source: human | agent | generated`.

## Capture

- Create notes only on explicit requests: “remember this”, “start a note”, “add to this note”. Do not capture conversation unprompted.
- Given new content, call `add` directly and report the slug. Do not list the vault, inspect the repository, or run git first.
- When extending existing knowledge, make one targeted `search`, then `append` to the matching note instead of duplicating it.
- Ask one short question if content is missing; exploration cannot reveal what the user meant.
- Use a specific title and 1–4 lowercase tags; reuse existing tags when known.
- User-supplied words are `source: human`; pass that explicitly to `add`. Agent-drafted notes are `source: agent` (the default).
  Finalization changes presentation, not authorship. Preserve human meaning; put agent additions in a dated “Agent addendum”.
- Do not store repository-derived facts, temporary task state, or secrets the user has not confirmed are safe to persist.

## Dictation mode (continuous compile)

During live dictation or interviews, keep the organized note current after every append; do not wait until the session ends:

1. `append` with `raw: true` preserves the user's words verbatim under `## Raw`. Never silently reword dictation.
2. Immediately `finalize` the body above the tail: TLDR, sections, decisions, questions, tasks, entities, and links reflecting
   everything said so far.

Outside dictation, finalize only on request.

### How to capture and append raw input

- Keep an append-only raw section at the bottom: `---`, then `## Raw`, then the notice shown below.
- Fence verbatim input in code blocks. Prepend each subsequent block with `<!-- appended YYYY-MM-DD HH:MM -->`.
- Use `append` with `raw: true` when available; it maintains this format and creates the tail if missing. Do not hand-format it.
- `finalize` changes only the body above the tail. Never rewrite, remove, or move words out of the raw tail. If no tail exists, preserve the
  entire previous body as a new raw tail before restructuring; the tool does this automatically.

When editing files directly, preserve the same format:

````markdown
---

## Raw
<!-- NEVER edit below this line. Verbatim user input preserved here. -->

```
<Initial verbatim input>
```

<!-- appended YYYY-MM-DD HH:MM -->
```
<Follow-up verbatim input>
```
````

## TLDR on finalize

Every finalized note opens with a TLDR: a `**TLDR:**` line directly under the title, one to three sentences on what the note says and
what matters most. Rewrite it on each `finalize` so it reflects the whole note; never stack a second one.

## Retrieve

- Known slug: `get`. Otherwise, one targeted `search` with the user's terms; never list the vault to find a note.
- One result or a unique exact-title match returns the full note. Use it; do not fetch it again. A body marked `complete` needs no `get`.
- For multiple plausible matches, fetch at most the three strongest slugs together. If still ambiguous, ask for another identifier instead
  of repeating searches. Fetch additional content only when marked as an excerpt.
- Search accepts ordinary multi-term queries, with exact-phrase matching followed by ranked lexical fallback. Read the match evidence and
  bounded content before another call.
- Connected notes are discovery context, not query matches. Use them only when their stated relationship matters; connections are lexical or
  explicit, not semantic.
- Trust repository code over conflicting notes about implementation; flag potentially stale intent.

## Session memory

`/weave-scan sessions [path]` creates searchable notes under `notes/sessions/` from available session transcripts.

- These are `source: generated` recollections; a contradicting human decision record wins.
- Search their `## Takeaways` for reusable lessons before re-deriving a familiar solution.
- Rescans update changed transcripts while preserving human edits above the raw tail. Session notes remain re-derivable.

Scans spend model tokens. Never run them unprompted; suggest one when asked to recover history or improve memory across sessions. An
explicit path accepts a history file or directory.

## Links

Use `links` to report stale targets, then `links` with `fix: true` after the user reviews the report. Resolution requires exactly one
candidate: exact slug, then basename, then slugified title. Never guess ambiguous targets or invent content for missing notes. Repairs
preserve aliases, raw tails, code fences, and `updated`; do not reconstruct links by reading the entire vault and guessing.

Use `suggest` (optionally with `slug` or `limit`) for unwritten connections. It reports unlinked pairs with shared-term evidence and never
writes. Propose relevant pairs and add links only after user confirmation; similarity is not an established relationship.

See [references/link-repair.md](references/link-repair.md) for examples and repair guarantees.
