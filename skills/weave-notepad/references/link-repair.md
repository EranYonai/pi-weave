# Link repair — keeping the vault connected

Wiki-links go stale. A note gets renamed or moved, or someone writes `[[Mathieu]]` by hand while the note actually lives at
`1-1s/mathieu`. The graph then shows an isolated note that is in fact well connected.

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
| 1 | exact slug | `[[1-1s/mathieu]]` — already correct, left alone |
| 2 | unique basename | `[[mathieu]]` → `1-1s/mathieu` |
| 3 | unique slugified title | `[[Infra Roadmap]]` → `infra/roadmap-fy27` |

Anything else is reported, never guessed:

- **ambiguous** — several notes match (two `plan.md` in different folders). The report lists the candidates; a human picks one, or you
  ask. Do not choose on their behalf.
- **unresolvable** — no note matches. The link points at something never written. Offer to create the note or drop the link; **never
  invent content to satisfy a link.**

## What a repair does and does not do

- Rewrites `[[Mathieu]]` → `[[1-1s/mathieu|Mathieu]]`. The **alias preserves the visible text**, so the rendered prose is unchanged —
  only the target moves.
- **Does not touch the `## Raw` tail.** A link inside dictation is the user's words, quoted. Off limits, always.
- **Does not touch fenced code blocks.** `[[…]]` in a code sample is a string literal.
- **Does not bump `updated`.** A repair is bookkeeping, not an edit; bumping it would reorder the whole vault by recency.
- **Is idempotent.** A second run finds nothing.

## Renames repair themselves

`renameNote`, `moveNote` and `renameFolder` rewrite inbound links automatically. Moving a note no longer breaks its backlinks, so the
repair pass exists for links that were *written* stale, not for links the vault broke itself.

## When to run it

- The user asks to "connect", "link up", or "fix the links in" their notes.
- The health panel or `/weave` reports dangling links.
- After bulk-importing or reorganising notes outside the tool.

Do not run `fix: true` unprompted on a vault you did not just change — show the report and let the user approve. Reporting is always safe.
