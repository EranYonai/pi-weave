# HANDOFF — feat/scan-modes sprint (for the orchestrator + parallel subagents)

> **Audience:** one orchestrator pi agent dispatching work to parallel
> deepseek-flash subagents. Written 2026-08-23 by the previous agent whose
> context was compacted. This file is the single source of truth for "where
> we are" and "what's left". Delete or archive it when the sprint closes.

---

## 0. Mission

Finish the **two scan modes** feature (light + deep) and the **notepad small
redesign**, on branch **`feat/scan-modes`**, with all quality gates green.
Multiple agents work **in parallel** — the file-ownership map in §3 keeps you
out of each other's way.

## 1. Repo state right now (verified)

- Branch: `feat/scan-modes` (local-only so far; remote = origin/github EranYonai/pi-weave).
- **`git status` is dirty**: the whole scan-modes implementation is sitting
  uncommitted in the working tree (see §4). First action of the sprint:
  **commit it as a WIP baseline** (§5 step 0).
- `npm run typecheck` → **clean**.
- `npm test` → **210 pass, 0 fail**.
- `npm run coverage` → **FAILING the gate: branches 93.2% < 95%**
  (lines 97.91 ok). Exact offenders listed in §5 Workstream A.

## 2. What was done before the context reset

Feature **scan-modes** (spec: `docs/scan-modes.md`) — mostly implemented:

| Piece | File | State |
|---|---|---|
| Spec doc | `docs/scan-modes.md` | written |
| Core: sidecar summaries + deep-scan pipeline | `src/core/summaries.ts` (new) | done, 17 L1 tests in `tests/core/summaries.test.ts` |
| Core: generic `parseFrontMatter` extracted | `src/core/frontmatter.ts` | done |
| Core barrel export | `src/core/index.ts` (`export * from "./summaries"`) | done |
| Graph: `summaries` input → module/entryPoint detail + timestamp | `src/core/graph/build.ts` | done, **branches undertested** |
| Adapter: session-LLM summarizer + deep runner | `src/pi/summarize.ts` (new) | done, 10 L2 tests in `tests/pi/summarize.test.ts` |
| Command: `/weave-scan deep` arg handling | `src/pi/index.ts` | wired, **no command-path tests yet** |
| Viewer: summary flow server→graph | `src/pi/viewer/server.ts` | done, untested |
| Viewer: summary in side panel (rendered like preview) | `src/pi/viewer/page.ts` | done |
| Dashboard: `summaries: N file(s)` line + `summaryCount` field | `src/core/workspace.ts`, `src/core/types.ts`, `tests/core/workspace.test.ts` | done |
| Test harness: model/complete options on `createMockCtx` | `tests/helpers.ts` | done |

Not done: docs folding (README/TODO/skills), the failing coverage gate,
`docs/notepad.md` redesign per Eran's note (§6).

## 3. Parallel-work protocol (read first, all agents)

### File ownership — no two agents edit the same file

| Workstream | Owns (exclusive) |
|---|---|
| **A — code+tests, coverage gate** | `src/**`, `tests/**`, `package.json`, `vitest.config.ts` |
| **B — scan-modes docs & skills** | `README.md`, `docs/TODO.md`, `docs/scan-modes.md`, `skills/weave-explore/**` |
| **C — notepad redesign (docs only)** | `docs/notepad.md`, `skills/weave-notepad/**` |

`docs/HANDOFF.md` is append-only, orchestrator-owned (§9 log).

### Rules of engagement

1. **Test your own code.** Never hand off untested changes.
2. Before finishing your stream: `npm run typecheck` then `npm test` on
   your touched suites first (`npx vitest run tests/core/summaries.test.ts`),
   then the full `npm test`. Stream A additionally ends with
   `npm run coverage` green (the 95% gate).
3. **Commit small and often** on `feat/scan-modes`. Message prefixes:
   A: `feat(scan-modes): …` / `test(scan-modes): …`, B: `docs(scan-modes): …`,
   C: `docs(notepad): …`. One stream = one or more commits; no giant
   polished commit needed (owner's call).
4. Do **not** rebase, force-push, or touch other streams' files. Do **not**
   open a PR — the human decides when.
5. If a gate breaks that you didn't cause, stop and report to the
   orchestrator; don't fix other streams' code.
6. Read `AGENTS.md` before anything else. Its hard rules apply to you:
   - **`src/core/` never imports `@earendil-works/*` or `typebox`** — and
     the adapter (`src/pi/`) imports pi packages as `import type` only,
     **except `@earendil-works/pi-ai` value imports** (`StringEnum`,
     `fauxAssistantMessage`) which are CI-proven safe. A runtime
     `pi-coding-agent` value import crashes Node 20 CI (bundled undici).
   - Generated content carries provenance (`source: human|agent|generated`).
   - `.okf` indexes are derived/rebuildable — never the only copy.
7. Strict TS: `exactOptionalPropertyTypes` means **never pass
   `{ key: undefined }`** — omit the key or spread conditionally
   (`...(x !== undefined ? { x } : {})`).

### Test-harness cheatsheet (`tests/helpers.ts`)

```ts
const dir = await makeTempDir();        // async, returns path string
gitInit(dir);                           // SYNC, void — do not await
await writeFixture(dir, "a.ts", "…");   // async
commitAll(dir, "msg");                  // sync
await fs.rm(dir, { recursive: true, force: true }); // cleanup yourself

const ctx = createMockCtx(dir);                                   // no model
const ctx = createMockCtx(dir, true, { model: { provider: "p", id: "m" },
  complete: async (_model, context, _opts) => fauxAssistantMessage("…") });
// deep scans need the model form; cast when calling adapter fns directly:
//   asExtensionCtx  (see tests/pi/summarize.test.ts for the pattern)

const mock = createMockPi(); piWeave(mock.api as any);
await mock.commands.get("weave-scan")!.handler("deep", ctx);
ctx.ui.notifications / ctx.ui.statuses   // recorded assertions
await withVaultEnv(await makeTempDir(), async () => { … });  // PI_WEAVE_VAULT
```

## 4. Workstream A — finish scan-modes code & restore the coverage gate

**Owner files:** everything under `src/` and `tests/`.

### A0 (orchestrator, before dispatching)

Commit the existing WIP baseline so agents start clean:

```bash
git add -A && git commit -m "wip(scan-modes): summaries core+adapter+surfaces (coverage gate pending)"
```

### A1. Close the branch-coverage gap (global ≥95%; currently 93.2%)

Uncovered branches, with the suggested test (add to the matching suite):

- `src/core/graph/build.ts` **40–44** (`moduleDetail` count>0): buildGraph
  test with a `summaries` map whose targets fall inside a module → detail
  `"summarized files": "1"`; also the absent case.
- `src/core/graph/build.ts` **62–65** (`dataTimestamp` summary loop):
  summaries map with a newer `at` wins; without summaries behaves as before.
- `src/core/graph/build.ts` **194–199** (entryPoint summary detail):
  summary with `model` set (→ `"summarized by"`) **and** `model: null`.
- `src/core/summaries.ts` **134–138** (unreadable sidecar skipped): write a
  malformed `*.summary.md` by hand, then `readSummaries` → skipped.
- `src/core/summaries.ts` **222–228** (file read fails mid-run): `chmod
  0o000` a tracked file before `runDeepScan`, expect it in `failed` with
  `"unreadable"` (restore perms in `finally`).
- `src/core/summaries.ts` **281–285** (prune "already gone"): `vi.spyOn` on
  `node:fs/promises` `rm` to throw once, assert prune still resolves.
- `src/pi/summarize.ts` **104–108** (deps spreads): call
  `deepScanRepository` with **all four** tuning deps (`at`, `maxFiles`,
  `maxFileBytes`, `concurrency`) set once, and once with none.
- `src/pi/summarize.ts` **123–127** (`first?.path ?? "?"`): the nullish arms
  are practically unreachable — **refactor instead of contorting tests**:
  `const [failed0] = result.failed; if (failed0) { text += …${failed0.path}… }`
  then cover both branches (with/without failures) — the existing three
  format tests already hit the `with` arm after the refactor.

### A2. Command-path tests for `/weave-scan deep` (`tests/pi/index.test.ts`)

Through `createMockPi` + real git fixtures:

1. `handler("deep", ctx)` with **no model** → warning notification
   "deep scan needs an active session model…", light index still written,
   status ends `:ok`.
2. With model + stub `complete` → info "deep scan complete",
   `.okf/repository/summaries/*.summary.md` exists, dashboard/status updated.
3. `handler("nonsense", ctx)` → light-only, no deep notice (documents the
   exact-match contract).
4. Case: `"DEEP"` also triggers (impl lowercases).

### A3. Viewer test (`tests/pi/viewer.test.ts`)

`buildCurrentGraph` on a repo fixture with a handwritten sidecar for an
entry-point file → the `entryPoint:` node's `detail.summary` is present in
`/graph.json` output. (Page-side rendering is exercised indirectly; the
page already prefers `summary` over `preview` — no new page test needed,
but if you touch `page.ts` remember: **it is a TS template literal — no raw
backticks or `${` inside the page script**; escape as `` \` `` and `\${`.)

### A4. Final gate for stream A

```bash
npm run check    # typecheck + coverage — must be fully green
```

## 5. Workstream B — docs & skills folding (scan-modes)

**Owner files:** `README.md`, `docs/TODO.md`, `docs/scan-modes.md`,
`skills/weave-explore/**`.

1. **README.md** — the commands table (~line 41): update the `/weave-scan`
   row and add `/weave-scan deep` (model-summarized sidecars, opt-in,
   incremental). One sentence in prose near it is enough.
2. **docs/TODO.md** — remove Todo 1 and Todo 3 (both folded into
   scan-modes.md, now implemented). Keep Todo 2 but reword: the doc exists;
   the remaining work is implementing the redesigned workflow (see §6).
3. **docs/scan-modes.md** — flip status from "spec for the next iteration"
   to **implemented**; add a short "as-built deltas" note if reality differs
   from spec (check: result shape is
   `{considered, written, skippedFresh, skippedTooBig, failed[], pruned}`;
   adapter calls `ctx.modelRegistry.complete(model, context,
   {maxTokens, signal})`, auth handled internally — **not** the spec's
   `getProviderAuth` + `completeSimple` dance).
4. **skills/weave-explore/SKILL.md** — teach: after a repo has summaries
   (`.okf/repository/summaries/`), read relevant summaries **before** opening
   full files; mention `/weave-scan deep` as the way to create/refresh them.
   Keep the skill harness-agnostic (files-first language like the notepad
   skill).

## 6. Workstream C — notepad small redesign (docs only)

**Owner files:** `docs/notepad.md`, `skills/weave-notepad/SKILL.md`.

**Eran's directive (verbatim, at the top of `docs/notepad.md`):**

> ERAN INPUT HERE - no, user should explictly request ot create a note. the
> granola experience is writing scribble notes, and having AI to finalize
> them. while keeping the raw notes at the end of the document.

Reconciled model — **explicit capture, AI finalization, raw preserved**:

1. **No ambient auto-capture.** Rewrite §3: the user explicitly asks for a
   note to exist ("start a note on X", "add to the X note"). Pi never
   promotes conversation into notes on its own initiative.
2. **Scribble in → finalize out.** The Granola experience is: the user
   (or Pi, at the user's say-so) appends rough, verbatim scribbles
   (`weave_note` append); on "finalize this" / "clean this up", Pi
   restructures the top of the note (front-loaded summary, sections,
   entities, links) — and **appends the raw scribbles, unchanged, under a
   `## Raw notes` tail that is append-only and never rewritten**.
3. Touch-ups rippling from that: §4 (the raw layer is now literal — the
   `## Raw notes` section), §7 (principle survives, scoped to within-note),
   §13–14 (meeting mode + end-of-session summaries drop auto-capture
   language), §26 example, §27 MVP bullets.
4. **Provenance decision (make it, document it):** content originates from
   the user's words; finalization is editorial. Keep `source: human` for
   user-scribbled notes and state this rule in both the doc and the skill;
   notes Pi drafts from scratch stay `source: agent`.
5. **skills/weave-notepad/SKILL.md** — update the workflow: create only on
   explicit request; append scribbles verbatim (no silent rewording);
   on finalize: restructure the body above, move nothing from `## Raw
   notes`; keep the existing "search first / append rather than duplicate"
   guidance.
6. Remove or resolve the `ERAN INPUT HERE` banner once incorporated; note
   the resolution in Appendix A. Appendix A row "Capture (§4, §7)" changes
   to "explicit by design (redesign 2026-08)". Delta #4 (command naming)
   gains one line: a future `finalize` convenience command stays under the
   `weave-` namespace; do **not** implement commands in this sprint.
7. **No code changes in this stream.** If you find a code implication you
   can't avoid, write it as a bullet in §6 "open questions" of notepad.md
   and report to the orchestrator.

## 7. Suggested orchestration

```text
orchestrator
 ├─ step 0: WIP-baseline commit (A0), then dispatch in parallel:
 │     ├─ Agent-A: Workstream A (code + tests)   ── gates: npm run check
 │     ├─ Agent-B: Workstream B (docs/skills)    ── gates: docs review only
 │     └─ Agent-C: Workstream C (notepad docs)   ── gates: docs review only
 ├─ on each agent finishing: verify its commits land on feat/scan-modes,
 │   run `npm test` to confirm nothing regressed globally
 └─ close-out (§8), then report to the human — PR opened only if asked
```

B and C share `skills/` but **different subdirectories** — safe. B and C
both edit `docs/` but **different files** — safe. A touches no docs.

## 8. Definition of done (sprint)

- [x] All streams committed; `git status` clean (`.pi/` ignored is expected).
- [x] `npm run check` fully green (typecheck + coverage ≥95 everywhere).
- [x] Todo 1 removed from TODO.md; Todo 2 reworded. **Todo 3 kept** (per Eran's
      direction — it is a forward-looking research item, not folded into the
      implemented feature).
- [x] notepad.md matches Eran's directive; banner folded.
- [x] README shows `/weave-scan deep`.
- [x] This handoff updated with a closing note per stream (§9).

## 9. Agent log (append-only; orchestrator writes)

```text
2026-08-23  handoff authored by previous (kimi) agent; state verified:
            tsc clean, 210 tests pass, coverage gate red at 93.2% branches.
2026-08-23  orchestrator  step 0  done: 7ef200a wip(scan-modes) baseline commit.
2026-08-23  Agent-A  A  done: c3a5267, f8c4f48, 87a873b — closed branch coverage
            93.2%→95.43% (12 new tests across graph/summaries/summarize/index/
            viewer), refactored formatDeepScanResult per §4 A1, /weave-scan deep
            command-path + viewer tests. npm run check green (222 tests).
            Note: HANDOFF's vi.spyOn on node:fs/promises unlink is impossible in
            this ESM vitest setup; substituted chmod-based tests (skip as root).
2026-08-23  Agent-B  B  done: e825010 — README /weave-scan deep row, TODO.md
            (removed Todo 1, reworded Todo 2), scan-modes.md flipped to
            implemented + as-built deltas, weave-explore skill teaches
            summaries-first reading.
2026-08-23  Agent-C  C  done: 5fb3053 — notepad.md redesign (explicit capture,
            AI finalization, ## Raw notes tail, provenance rule), banner folded
            into Appendix A, weave-notepad skill updated. No code changes.
2026-08-23  orchestrator  close-out  done: e271856 restored Todo 3 in TODO.md
            (Eran wants the codebase-memory-mcp research thought kept).
            Verified: git status clean, npm run check green (222 tests,
            branches 95.43%). No PR opened — human decides.
```

## 10. Hard-won gotchas (keep the flash agents out of known traps)

1. Runtime value import from `@earendil-works/pi-coding-agent` = Node 20 CI
   crash. Type imports only. pi-ai value imports are fine.
2. `exactOptionalPropertyTypes`: conditional-spread optional deps,
   never `key: undefined`.
3. Mock ctx needs the `{ model, complete }` form for any deep-scan path;
   `gitInit`/`commitAll` are **sync**; `makeTempDir` is **async**.
4. `page.ts` is a template literal — no raw backticks/`${` inside the page
   JS; execute-safety is tested by extracting script bodies with regexes.
5. Coverage on type-only modules shows 0% — every new module needs runtime
   exports exercised by tests.
6. PR bodies: write to a file and `gh pr create --body-file` — heredocs in
   this repo's prose break on backticks/apostrophes.
