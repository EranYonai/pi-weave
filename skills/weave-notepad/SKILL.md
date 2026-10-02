---
name: weave-notepad
description: "Create, update, and retrieve durable notes and past decisions. Use for remember/note requests (notes, ai note, note-taking, note-taker), live dictation, interviews, and repairing or suggesting [[wiki-links]]."
---

# Weave Notepad

Use `weave_note`. Without the tool, edit Markdown files under `~/.okf/notes/` (`PI_WEAVE_VAULT` overrides the vault root). Front matter:
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

## Dictation and finalization

For every live dictation/interview append:

1. `append` with `raw: true` preserves the user's words verbatim in a dated fenced block under `## Raw`, creating the tail if needed.
2. Immediately `finalize` the body above the tail: summary, sections, decisions, questions, tasks, entities, and links reflecting everything
   said.

Never rewrite or delete the raw tail. Use the tool to format it when available. Outside dictation, finalize only on request. `finalize`
preserves an existing tail verbatim; if absent, it saves the entire previous body as a new tail before restructuring.

For direct file edits, preserve this append-only format and add a timestamp before each subsequent block:

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
