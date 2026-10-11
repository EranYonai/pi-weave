# Second thoughts

Catch a decision that contradicts an earlier human decision while the user is there to answer in one word. Silence is the default; a
false alarm costs more than a missed one.

## Conflict: ask once, after saving

```text
User:  Add to the auth note that we're going with SAML.

Agent: (search "auth" → auth-migration; Decisions has "2026-09-03: OIDC next quarter, JWT compatibility window", source: human)
       (append to auth-migration)

Agent: Added. One thing: on Sep 3 you decided "OIDC next quarter, JWT compatibility window" (auth-migration, Decisions).
       Should SAML replace that decision, or are both true?

User:  Replace it.

Agent: (edit the body above the raw tail)
       Updated. The Sep 3 decision is now marked superseded.
```

The Decisions section afterwards:

```markdown
## Decisions

- ~~2026-09-03: OIDC next quarter, JWT compatibility window~~ (superseded 2026-10-11 → [[auth-migration]])
- 2026-10-11: Go with SAML.
```

If the user answers "both are true", leave both lines as they are and say so.

## No question

| New statement | Earlier note | Why silent |
|---|---|---|
| "Use SAML for the admin portal" | human: "OIDC for the customer app" | Different subjects |
| "Use Okta as the OIDC provider" | human: "OIDC next quarter" | Compatible; it builds on the decision |
| "We're going with SAML" | generated session note: "team leaning OIDC" | Not a human decision; mention it in one line |
| "SAML might be simpler" | human: "OIDC next quarter" | Not a decision |

## Rules of thumb

- Use the hits from the one `search` the capture already made; no extra calls to look for conflicts.
- At most one question per turn, even if several decisions conflict. Name the strongest; mention others in the same question.
- Never delete the old decision and never touch the raw tail. Superseded lines survive `finalize`, struck through.
