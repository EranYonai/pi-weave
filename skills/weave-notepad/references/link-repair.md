# Link repair

Use deterministic repair for stale `[[wiki-links]]`; do not read every note and guess connections.

```jsonc
weave_note { "action": "links" }              // report
weave_note { "action": "links", "fix": true } // apply unambiguous repairs
```

Without the tool, call `repairVaultLinks(vaultRoot, { apply })` from `pi-weave/core`. Report first, then apply after user review; never run
`fix: true` unprompted on a vault you did not just change.

## Resolution

Try these in order; each requires exactly one candidate:

| Rule | Example |
|------|---------|
| Exact slug | `[[planning/roadmap-2026]]` — unchanged |
| Unique basename | `[[roadmap-2026]]` → `planning/roadmap-2026` |
| Unique slugified title | `[[Quarterly Roadmap]]` → `planning/roadmap-2026` |

- **Ambiguous:** report candidates and ask; never choose for the user.
- **Unresolvable:** offer to create the missing note or remove the link; never invent content to satisfy it.

Repairs preserve visible text through aliases: `[[Quarterly Roadmap]]` becomes `[[planning/roadmap-2026|Quarterly Roadmap]]`. They leave raw
tails, fenced code, and `updated` untouched. A second run makes no changes. `renameNote`, `moveNote`, and `renameFolder` already repair
inbound links automatically.

## Unwritten connections

```jsonc
weave_note { "action": "suggest" }                      // strongest unlinked pairs
weave_note { "action": "suggest", "slug": "some/note" } // one note's candidates
weave_note { "action": "suggest", "limit": 40 }
```

Suggestions rank unlinked pairs by IDF-weighted cosine over title, tags, and body. Rare shared vocabulary matters more than common terms.
Read the cited terms, not just the score. `suggest` never writes and has no `fix`: propose useful pairs and add links only after
confirmation. Never bulk-apply suggestions or present them as established connections.

Use `links` for dangling links or after external bulk imports; use `suggest` when asked to discover relationships or connect notes.
