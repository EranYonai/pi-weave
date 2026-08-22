# Testing, Use Cases & Evaluation

Testing strategy for pi-weave: what we test, at which layer, with which
fixtures — plus the evaluation harness we use to A/B-compare prompt and
context variants once the tools are live.

> Status: planning doc. Implementation lands alongside `src/core` /
> `src/pi`. The vitest config (`tests/**/*.test.ts`, 95% coverage thresholds)
> is already in place; the first test commit makes `npm test` green.

## 1. Layers

```
L1 unit          pure functions, no fs / no git          tests/unit/
L2 integration   temp dirs + temp git repositories       tests/integration/
L3 adapter       src/pi with a mocked ExtensionAPI       tests/adapter/
L4 eval          scripted pi runs, variant comparison    tests/eval/
```

### L1 — Unit (fast, deterministic, the bulk of the suite)

Pure functions take data in, return data out. No filesystem, no git.
Target them first; they carry the coverage thresholds.

| Module | What to test |
| --- | --- |
| `slug.ts` | `slugify`: case folding, whitespace→dash, punctuation stripping, unicode/emoji input, empty/garbage titles (fallback), idempotence. `uniqueSlug`: `-2`, `-3` suffixes on collision, base-free-when-possible. |
| `frontmatter.ts` | `serializeNote` → `parseNoteFile` roundtrip (property: parse(serialize(x)) ≡ x). Malformed files: no front matter, unclosed fence, bad timestamp, unknown `source` value, tags missing. |
| `languages.ts` | Known extensions map, unknown → `undefined`, case handling, `.dockerfile`/extensionless special cases. |
| `repoIndex.ts` (pure halves) | `buildStructure` on synthetic file lists: language ordering (count desc, name asc tiebreak), manifest detection per kind, fallback package names, module grouping (`src/x`, `packages/x`, `(root)`), entry-point regexes per language. `summarizeIndex` output shape. |
| `workspace.ts` (pure halves) | `formatStatusLine` / `formatDashboard` for all `WorkspaceStatus` shapes (vault present/absent, repository `null`, staleness states). |
| `vault.ts` (pure halves) | `formatNote` rendering. |

### L2 — Integration (temp filesystem + temp git repos)

Everything under `src/core` that touches disk or shells out to git.

**Vault** (`tests/integration/vault.test.ts`) — temp root per test:
`ensureVault` creates layout; `addNote` writes `<slug>.md` with valid front
matter; slug collisions resolve via `uniqueSlug`; `getNote`/`appendToNote`
update `updated` and preserve `created`; `listNotes` chronological order;
`searchNotes` ranks title hits over body hits; missing vault →
`vaultExists`/`noteCount` degrade, no throw.

**Git wrappers** (`tests/integration/git.test.ts`) — fixture repos built by
a helper (§2): `findGitRoot` from a nested dir; `headSha`/`currentBranch`;
`changedFiles` reflects porcelain state (new file, modified, staged);
`listFiles` excludes `.git` & untracked-ignored; `remotes`; `defaultBranch`;
unborn HEAD → `null` (not throw); non-git dir → `null` (not throw);
`excludeOkfLocally` writes `.git/info/exclude` exactly once (repeat call is
idempotent).

**Repo index** (`tests/integration/repoIndex.test.ts`):
`buildRepoIndex` on a committed fixture → identity/git/structure all sane;
uncommitted file appears in `git.changedFiles`; `maxFiles` cap respected;
unborn HEAD → `null`. `writeRepoIndex` → `readRepoIndex` roundtrip preserves
identity/git/structure. Malformed/missing JSON on disk → `readRepoIndex`
returns `null`.

**Staleness matrix** (same file, looped table):

| Setup | Expected state |
| --- | --- |
| no `.okf` | `missing` |
| index written, nothing touched | `fresh` |
| new commit after capture | `stale` ("HEAD moved") |
| branch switch | `stale` ("branch changed") |
| dirty a tracked file | `stale` ("new uncommitted change") |
| resolve the dirty file, same HEAD | `stale` ("resolved") |

**Workspace** (`tests/integration/workspace.test.ts`): `getWorkspaceStatus`
in (a) git repo with index, (b) git repo without index, (c) non-git dir
(repository `null`), (d) each × vault present/absent via `PI_WEAVE_VAULT`
pointed at a temp dir.

### L3 — Adapter (`src/pi` with a mocked pi)

No real pi needed: build a `MockExtensionAPI` test double that records
`registerTool` / `registerCommand` / `on` calls, run the default export from
`src/pi/index.ts` against it, then invoke the captured handlers directly.

- Factory registers: the note tool, the repo tool, `/weave`, `/weave-scan`,
  one `session_start` handler. (Assert names — they're the LLM-facing
  contract.)
- Tool `execute()` with a mock `ctx` (`ctx.cwd` → fixture repo, `ctx.ui`
  stubbed) drives the real core against L2-style temp repos and asserts the
  returned `content`/`details` shapes.
- Command handlers: `/weave` status output on indexed vs unindexed repos;
  no-UI modes (`ctx.hasUI === false`) never call `ui.*` prompt methods.
- Error paths: tool execution in non-git dir reports cleanly (not throws).

Keep harness imports confined to `src/pi` — an L3 test importing
`@earendil-works/*` types into `src/core` test helpers is a red flag
(design §21).

### L4 — Eval / E2E smoke

See §4. Interactive TUI testing stays manual (checklist below); scripted
behavioral checks use print/json mode.

## 2. Test infrastructure

**Fixture helpers** (`tests/helpers/`):

- `makeTempDir()` — `fs.mkdtemp` under `os.tmpdir()`, auto-cleaned in
  `afterEach` (vitest `onTestFinished` or `afterEach`).
- `makeTempRepo({ files, commits? })` — temp dir → `git init` → write files →
  optional scripted commits/dirty states. All commits with fixed
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env and `-c init.defaultBranch=main` so
  hashes and branches are deterministic across machines.
- `withEnv({ PI_WEAVE_VAULT })` — scoped env override; vitest files run in
  parallel workers, so **no global env mutation and no shared temp dirs**.

**Determinism rules:**

- Always inject `now` where the API offers it (`ScanOptions.now`,
  and any vault/build helpers that accept timestamps). Assert timestamps by
  ISO shape, not exact values, when injection isn't available.
- **No snapshot tests over raw JSON** — outputs contain absolute paths and
  timestamps. Normalize first, or assert structurally.
- Never run git against the developer's real repo; every git call targets a
  temp fixture root.

**Optional, deferred:** property-based testing (`fast-check`) for the
frontmatter roundtrip and `slugify` idempotence. Worth it once formats
stabilize; not now.

## 3. Use cases (acceptance scenarios)

Each scenario maps to a layer; the list doubles as the pre-release manual
checklist (L4 column = human in the TUI).

| # | Scenario | Expected behavior | Layer |
| --- | --- | --- | --- |
| UC1 | `pi` in a git repo with no `.okf` | Repo tool/command offers/builds index; `.okf/` contains `okf.json` + `repository/{identity,git,structure}.json`; `.git/info/exclude` updated | L2, L3, L4 |
| UC2 | Session in a non-git directory | Repository scope reports "not a git repository", no crash; vault features unaffected | L2, L3 |
| UC3 | Nothing changed since scan | Staleness `fresh` | L2 |
| UC4 | New commit / branch switch / dirty file | Staleness `stale` with the right reason strings | L2 |
| UC5 | Vault note lifecycle | add → get → append → search finds it; two same-title notes get distinct slugs | L2, L3 |
| UC6 | Cross-scope reasoning | A note can reference repo structure the index knows about (manual: ask pi "what do we know about auth?") | L4 |
| UC7 | `rm -rf .okf` then rescan | Rebuilt index matches the previous one modulo timestamps (derived, disposable — design §4) | L2 |
| UC8 | Huge repo | Scan respects `maxFiles` cap; summary notes the cap | L2 |
| UC9 | `git init`, zero commits | `buildRepoIndex` → `null`; surfaces as "nothing to anchor to" | L2 |
| UC10 | `/weave` dashboard | Renders vault + repository status lines; stale index is visibly marked | L3, L4 |

## 4. Evaluation & A/B testing

Classic web A/B doesn't apply to an agent extension — there is no traffic to
split. What we can and should do is **controlled variant comparison over a
fixed harness**: same repo, same questions, same model; one variable
changed; metrics compared.

### 4.1 What varies (the "arms")

- **Context depth** — what the repo tool injects: (a) nothing
  (control), (b) `summarizeIndex` lines only, (c) full `structure.json`
  projection. This is the central tradeoff: knowledge vs. token cost.
- **Tool surface wording** — tool `description`/`promptGuidelines` variants;
  measures how wording changes tool-selection behavior.
- **Search scoring** — vault `searchNotes` ranking variants (title weight,
  snippet window).
- **Staleness posture** — auto-refresh vs. ask-first (manual only, UX study).

### 4.2 The harness

```
tests/eval/
├── repos/          # fixture repos, git-submodule'd or generated, PINNED to a commit
├── questions/      # repo-QA sets: ~30 questions with known answers per repo
├── runners/        # scripts driving pi in --mode json / -p
└── results/        # JSONL output per run — gitignored except aggregate reports
```

Protocol per run:

1. Pin: repo commit, model, thinking level, temperature (as far as the
   provider allows).
2. Enable exactly one variant (env var or extension flag — keep this surface
   tiny and explicit).
3. Ask each question non-interactively (`pi -p` / json mode), capture the
   full event stream as JSONL.
4. Repeat N ≥ 10 per arm — LLM output is stochastic; report mean and spread,
   never a single run.

### 4.3 Metrics

| Metric | How captured |
| --- | --- |
| Answer correctness | exact match where possible; otherwise rubric-graded LLM judge (pinned judge model, recorded prompt) |
| Token cost | input/output/cache tokens from `usage` in the event stream |
| Latency | wall time per question |
| Tool behavior | count + names of tool calls (did it call the repo tool? did it waste scans?) |
| Staleness hygiene | false "fresh" / false "stale" events |

**Primary decision metric: answer quality per input token.** A variant that
adds 2k tokens for +2% correctness loses; one that cuts tokens at equal
quality wins. Guardrails: latency and wasted tool calls.

### 4.4 Process

- A experiment config = one JSON file naming: arm definition, question set,
  repo pin, model pin, N. Reproducible by construction.
- Results committed only as aggregate reports (`results/*/REPORT.md`); raw
  JSONL stays local (gitignored).
- Variant merges require: quality-per-token not worse, guardrails not
  regressed, and the losing arm's config kept for the record.

Human-facing A/B (viewer UX, notification wording) comes later, once the
viewer exists — manual side-by-side sessions until we have real users.

## 5. CI (when the repo goes public)

GitHub Actions, one job: `npm ci && npm run check` on Node 20 and 22.
Eval harness stays out of CI gating (needs model keys; runs on demand via
`workflow_dispatch` with secrets). Add a weekly scheduled eval once the
question sets stabilize, so silent quality drift surfaces early.

## 6. Order of operations

1. L2 helpers (`makeTempDir`, `makeTempRepo`) — everything else imports them.
2. L1 suite for `slug`, `frontmatter`, `languages`, pure `repoIndex` halves.
3. L2 suites: git → vault → repoIndex/staleness → workspace.
4. L3 adapter double + tool/command assertions.
5. Flip CI on. Only then start eval arms — A/B against an untested core
   measures noise.
