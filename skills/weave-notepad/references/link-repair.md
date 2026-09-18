# Link repair — keeping the vault connected

Wiki-links go stale. A note gets renamed or moved, or someone writes `[[John Doe]]` by hand while the note actually lives at
`1-1s/john-doe`. The graph then shows an isolated note that is in fact well connected.

**Never reconnect a vault by reading it.** Do not search the vault note by note, infer which notes "feel related", and hand-write links.
That is slow, costs tokens, and is not reproducible — two runs give two different answers. There is a deterministic pass that does it in
one shot.

## The tool

```jsonc
weave_note { "action": "links" }              // read-only report
weave_note { "action": "links", "fix": true } // apply the unambiguous repairs
```

In other harnesses, call `repairVaultLinks(vaultRoot, { apply })` from `pi-weave/core`.

Always run the report first, read it, then apply. The report is cheap (one pass over the vault, no model calls).

## How targets resolve

Three rules, tried in order. A rule fires only when it yields **exactly one** candidate:

| # | Rule | Example |
|---|------|---------|
| 1 | exact slug | `[[1-1s/john-doe]]` — already correct, left alone |
| 2 | unique basename | `[[john-doe]]` → `1-1s/john-doe` |
| 3 | unique slugified title | `[[Infra Roadmap]]` → `infra/roadmap-fy27` |

Anything else is reported, never guessed:

- **ambiguous** — several notes match (two `plan.md` in different folders). The report lists the candidates; a human picks one, or you
  ask. Do not choose on their behalf.
- **unresolvable** — no note matches. The link points at something never written. Offer to create the note or drop the link; **never
  invent content to satisfy a link.**

## What a repair does and does not do

- Rewrites `[[John Doe]]` → `[[1-1s/john-doe|John Doe]]`. The **alias preserves the visible text**, so the rendered prose is unchanged —
  only the target moves.
- **Does not touch the `## Raw` tail.** A link inside dictation is the user's words, quoted. Off limits, always.
- **Does not touch fenced code blocks.** `[[…]]` in a code sample is a string literal.
- **Does not bump `updated`.** A repair is bookkeeping, not an edit; bumping it would reorder the whole vault by recency.
- **Is idempotent.** A second run finds nothing.

## Renames repair themselves

`renameNote`, `moveNote` and `renameFolder` rewrite inbound links automatically. Moving a note no longer breaks its backlinks, so the
repair pass exists for links that were *written* stale, not for links the vault broke itself.

## Finding connections that were never made

Repair fixes links that point wrong. It cannot find links that were **never written** — two notes that belong together but have never referenced each
other. That is `suggest`:

```jsonc
weave_note { "action": "suggest" }                              // strongest pairs vault-wide
weave_note { "action": "suggest", "slug": "some/note" }         // what relates to this note
weave_note { "action": "suggest", "limit": 40 }
```

It ranks unlinked pairs by IDF-weighted cosine over every term a note carries — title, tags and body in one bag — weighting each term by how rare
it is *in this vault*. Vocabulary shared by most notes (`sprint`, `meeting`, a tag on half the vault) scores near zero and connects nothing;
a ticket id or an unusual name on a handful of notes scores high. Nothing is domain-specific: the vault's own frequencies decide.

Every suggestion cites the shared terms that earned it. **Read the evidence, not the score** — `shared: cort-2091, traps-pipelines` is checkable,
`0.16` is not.

### suggest never writes

This is the rule that matters. `suggest` only reports; there is no `fix`. A similarity score is a soft signal and a `[[link]]` is a hard claim —
once written into a body it is indistinguishable from one the user wrote deliberately. Good scores here are around 0.1–0.3, not 0.9, so treat the
output as a shortlist for a human:

1. Run `suggest`, read the shared terms.
2. Propose the worthwhile pairs **to the user**.
3. Add `[[wikilinks]]` only to those they confirm.

Never bulk-apply suggestions, and never present one as an established connection.

## When to run it

- The user asks to "fix the links in" their notes — `links`.
- The health panel or `/weave` reports dangling links — `links`.
- After bulk-importing or reorganising notes outside the tool — `links`.
- The user asks what a note "relates to", or to "connect" / "link up" the vault — `suggest`, then confirm before writing.

Do not run `fix: true` unprompted on a vault you did not just change — show the report and let the user approve. Reporting is always safe.
