# weave-view TUI — In-Terminal Knowledge Explorer

Design for `/weave-view tui`: a terminal-native counterpart to the browser
`/weave-view`. Same data (the `GraphModel` assembled from vault + repo index),
same principles (provenance-first, three surfaces, read-only, derived), a
different interaction model (keyboard-driven tree + neighbors instead of a
force graph).

> Status: **design for implementation** — concrete decisions, no code yet.
> Amends the AGENTS.md / design §22 note "No custom TUI renderers yet — a
> deliberate MVP choice": this is the first custom TUI surface.

---

## 1. Goals & non-goals

### Goals

1. **Feature parity of *navigation***, not pixels. Everything the HTML viewer
   lets you *reach* — notes, modules, entry points, `.okf` files, links,
   backlinks, staleness/health — must be reachable by keyboard in the TUI.
2. **One model, both viewers.** Reuse `buildCurrentGraph` +
   `readNoteForView` + `readOkfFileForView` verbatim. Zero new data paths;
   zero core model changes.
3. **Provenance is the hero, terminal-style.** human/agent/encoded
   (`●`/`◐`/`○` + dim style), never color alone (mirrors v2 P1).
4. **Respect the layering rule (AGENTS.md / design §21).** All logic in core
   or in pure, harness-free view-model modules; the pi-tui component is a
   thin input/render shell. Nothing in `src/core/` imports pi packages.
5. **Testable without a terminal.** The 95% coverage gate applies to all new
   code (`vitest --coverage` covers `src/**/*.ts`). Every interesting
   behavior is a pure exported function or a class drivable with fake
   `tui`/`theme` objects.

### Non-goals (explicit)

- **A force-graph / 2-D spatial layout in the terminal.** Braille/ASCII
  scatter plots are out; the tree + neighborhood views carry the "graph".
- **Editing from the TUI.** Read-only, same as the HTML viewer; the only
  write-ish action is `o` (open note in `$EDITOR`), reusing the existing
  traversal-safe helper.
- **Live polling / watch mode.** Build once on open; explicit `r` to refresh.
  No timers (keeps tests deterministic).
- **Session-scope knowledge, mentions edges, symbol nodes** — unchanged from
  the HTML viewer's roadmap; the TUI inherits whatever the model grows.
- **Non-pi harnesses.** The TUI is pi-adapter code by definition; only its
  view-model modules are kept harness-free so a future adapter could re-skin.
- **Overlay/persistent widget forms** for v1 (see §3).

---

## 2. Command shape — decision

**`/weave-view tui` — an argument to the existing `weave-view` registration,
not a new command.**

Rationale:

- The codebase already has the subcommand-via-args precedent:
  `/weave-scan deep` parses `args.trim().toLowerCase() === "deep"`.
  `/weave-view tui` is the same shape; a separate `/weave-tui` command would
  split one product surface ("see the knowledge space") across two names.
- The handler currently ignores `args` (`handler: async (_args, ctx)`), so
  parsing is additive and cannot break existing behavior.
- Discoverability: one command, one description
  ("`/weave-view` opens the browser graph; `/weave-view tui` explores
  in-terminal"). Slash-command autocomplete stays small.

Parsing semantics (exact):

| `args.trim().toLowerCase()` | Behavior |
| --- | --- |
| `""` | Current behavior, unchanged: lazy-start/reuse server, notify URL, open browser. |
| `"tui"` | Open the TUI explorer (this design). |
| anything else | `ctx.ui.notify("usage: /weave-view [tui]", "warning")`, no action. |

Guards for the `tui` path (mirroring `openInBrowser`'s guard):

- Requires `ctx.hasUI && ctx.mode === "tui"`. In `print`/`json`/`rpc` modes
  or headless contexts, notify
  `"pi-weave: '/weave-view tui' needs an interactive terminal — run /weave-view for the browser viewer."`
  at `warning` level and return. (The browser path already reports the URL in
  those modes; the TUI has no such fallback, so it fails loud and cheap.)
- Both viewer flavors may coexist: the HTTP server lifecycle is untouched;
  the TUI reads from disk independently.

---

## 3. Module layout & the shared-current-module refactor

### 3.1 Decision: move the "assemble from disk" readers into core

Create **`src/core/graph/current.ts`** and move, verbatim in behavior:

- `buildCurrentGraph(cwd, vaultRoot?)` — from `src/pi/viewer/server.ts`.
- `readNoteForView(vaultRoot, slug)` — thin traversal-safe (`resolveNotePath`)
  wrapper over `getNote` returning `{ slug, title, body, created, updated, tags, source }`.
- `readOkfFileForView(cwd, rel)` — reads a file body anchored under
  `<cwd>/.okf` with the same traversal guard (`resolve` + prefix check).

Export them from `src/core/index.ts` (alongside `buildGraph`).

Why core: these functions are **workspace assembly**, symmetric to
`getWorkspaceStatus` (already in core): pure fan-out over `core/vault`,
`core/repoIndex`, `core/summaries`, `core/git`, then the pure `buildGraph`.
They import only core + node builtins; `resolveVaultRoot()` reading
`PI_WEAVE_VAULT` is established core behavior (`core/paths.ts`). Design §21's
"no logic in adapters; the core owns behavior" points here directly. A future
Claude Code/opencode adapter then assembles the same graph without importing
pi's viewer directory.

What **stays** in the adapter (`src/pi/viewer/server.ts`): everything HTTP
(`startViewer`, `route`, CSP), plus the exec/policy helpers
`openNoteCommand`, `openNoteInEditor`, and `browser.ts` — those encode
per-platform shell-out policy, which is adapter business, not engine
behavior. `server.ts` re-exports the moved functions
(`export { buildCurrentGraph, readNoteForView, readOkfFileForView } from "../../core/graph/current"`)
so the existing import sites in `tests/pi/viewer.test.ts` /
`tests/pi/viewCommand.test.ts` keep passing unchanged.

Fallback (if reviewers object to touching core): a harness-free
`src/pi/viewer/current.ts`, mirroring `server.ts`'s own header
("harness-agnostic on purpose"). Acceptable, but the core move is preferred.

### 3.2 New adapter modules (the TUI itself)

```text
src/pi/viewer/tui/
  model.ts      PURE view-model: treeRows(), detailModel(), focusModel(),
                healthModel(), neighbor grouping, filters. Imports ONLY core
                types. No pi-tui imports — the bulk of the logic, unit-tested
                like the page's listTree tests.
  theme.ts      provenance/kind → glyph + theme color-slot maps (§7).
                Imports only core types. Pure.
  explorer.ts   WeaveExplorer component (imports @earendil-works/pi-tui).
                Thin: key routing, render cache, body fetching via injected
                loaders, windowing. All branching logic lives in model.ts.
  run.ts        runWeaveViewTui(ctx): guards, buildCurrentGraph, ctx.ui.custom
                wiring, post-close status-line refresh. Deps injected so tests
                never touch a real terminal.
```

`src/pi/index.ts` gets a small edit: the `weave-view` handler parses the arg
and calls `runWeaveViewTui(ctx)`; description updated.

---

## 4. Component architecture

### 4.1 Full-screen custom UI, not an overlay

**Decision: run through `ctx.ui.custom(factory)` with no `overlay` option** —
the explorer takes over the main content area with keyboard focus until
`done(null)` resolves the command.

- It is a *primary reading surface*, not a transient dialog: it wants full
  width and height-based windowing, and it owns input for its whole lifetime.
- Overlay semantics (disposed on close; re-open = new instance; focus hand-off
  subtleties) buy nothing here and complicate the refresh flow.
- Modal blocking is honest: while the explorer is open the agent loop waits,
  exactly like pi's built-in selectors. The browser viewer remains the
  non-blocking option. (Recorded as an open question in §12.)

The factory can itself be async
(`custom<T>(factory: (...) => Component | Promise<Component>)`), but we build
the graph in the *handler* before calling `custom()` (simpler failure path;
`runWeaveViewTui` awaits `buildCurrentGraph` and passes the model in).
`buildCurrentGraph` is local disk I/O — hundreds of ms worst case at 500
notes. If profiling later shows pain, wrap the build in a `BorderedLoader`
phase (Pattern 2 in pi docs) and pass the result into a second `custom()` —
noted, not v1.

### 4.2 Component tree

```text
WeaveExplorer (root; implements Component — render/handleInput/invalidate)
│  holds: GraphModel · ExplorerState (surface, selection, expansion, filter,
│  focus, scroll) · body cache · render cache
│
├─ Header strip   (2–3 lines, always rendered)
│    line 1: "🧵 weave view — data as of <generatedAt>" + surface name
│    line 2: notes N (● h / ◐ a / ○ g) · repo <name>:fresh|stale|missing
│             (+ first staleness reason when stale)
│    line 3 (conditional): active filter/provenance/focus banner
│
├─ Body — exactly one surface, all rendered FROM model.ts row models:
│    ├─ TreeSurface (Explore) — expandable containment tree (§5.1)
│    ├─ DetailSurface          — selected node: meta, body, links (§5.2)
│    ├─ FocusSurface           — 1-hop neighborhood of the pinned node (§5.3)
│    └─ HealthSurface          — staleness + link health report (§5.4)
│
├─ SearchInput line (visible only in search mode; inline filter string)
└─ Footer         (1 dim line of key hints; `?` expands to a help block)
```

Responsibilities:

- **`model.ts`** owns *what rows exist* in every surface: expansion/filter
  application, focus groups, detail sections, health lists. Returns plain
  row structs (`{ id, depth, label, kind, provenance, marker, meta, ... }`).
- **`WeaveExplorer`** owns *interaction state* (selected index, scroll offset,
  mode), maps keys → state transitions (each transition delegated to a small
  exported `reduce(state, action)` in model.ts so transitions are testable
  without the component), renders rows + header/footer via `theme.fg`,
  caches rendered lines keyed by `(width, stateVersion)`.
- **Bodies** (note markdown, `.okf` file text) load lazily the first time a
  node opens in Detail, through injected async loaders
  (`readNoteForView`/`readOkfFileForView` bound to vaultRoot/cwd), cached in a
  `Map<nodeId, string | null>`, busted on `r` refresh.
- **Height**: `render(width)` receives no height — read
  `tui.terminal.rows` in the factory and hand it to the component (fallback
  24 when unavailable, e.g. in tests); the body surfaces window their rows to
  `rows - (header + footer)` with a scroll offset that always keeps the
  selection visible.

### 4.3 Input routing & paging

One root component holds focus for the explorer's lifetime; a `mode` field in
state routes keys:

```text
mode: "tree" | "detail" | "focus" | "health" | "search"
```

`search` is a sub-mode of `tree` (printable characters edit the filter
string; see §6). We deliberately do **not** embed pi-tui's `Input` component:
an inline captured-string filter keeps the component single-focus and fully
testable; IME support for the filter is the accepted v1 tradeoff.
`wantsKeyRelease` stays default (`false`).

Paging: `pgup`/`pgdown` move the selection by one window; `home`/`end` jump
to first/last row; the scroll offset follows the selection
(offset ≤ selected < offset + window). Wide content is truncated
(`truncateToWidth`), never wrapped, in tree/focus/health rows; Detail bodies
wrap through the `Markdown` component.

---

## 5. Surfaces (the interaction model that replaces the force graph)

### 5.1 Explore = expandable tree (the terminal List surface)

Port the page's `listTree` semantics 1:1 into `model.ts` as
`treeRows(model, state)`:

- **Rows** are built from `contains` + `anchored-at` edges. Roots: `vault`,
  `repository` (nodes with no incoming containment edge).
- Entry points nest under the module whose path prefixes theirs
  (`module:src` → `entryPoint:src/index.ts`), using `detail.path`.
- The `.okf` subtree (already path-nested by `build.ts`: `okf:*` file nodes
  under `module:.okf…`) renders as-is.
- **Internals hidden by default** (`gitState`, `external`, `package`,
  `entryPoint`) — matches the page's `showInternals` behavior; `i` toggles.
- Filter active (query and/or provenance): prune to matching nodes **plus
  their ancestors**, auto-expanding ancestors so matches stay reachable
  (mirrors the page).
- Each row: `depth`, chevron (`▾`/`▸`) when `hasKids`, provenance/kind
  marker (§7), label, and a dim `meta` tail (note: relative `updated`;
  module: `files=N`; gitState: short sha) truncated to width.
- Empty states render as hint rows: vault-only →
  `"no notes yet — add one with the weave_note tool"`; no repo →
  repository root absent (graph is vault-only, same as browser).

Default expansion on open: `vault` and `repository` expanded; everything
deeper collapsed (progressive disclosure, design §9).

### 5.2 Detail surface

`detailModel(model, id, bodyCache)` → sections:

1. **Title line**: marker + label + kind + provenance badge.
2. **Meta rows** from `node.detail`, verbatim but ordered (path/slug, source,
   updated, tags, files, languages, commit, captured, summary…), values
   truncated to width.
3. **Body**: for `note:*` ids, the full note body via `readNoteForView`,
   rendered with the pi-tui **`Markdown`** component
   (`getMarkdownTheme()`), composed as a child sub-range of lines; for
   `okf:*` ids, the raw file body via `readOkfFileForView` (Markdown render
   for `.md`, plain wrapped text for `.json`); for `entryPoint:*`, the
   `detail.summary` when present. `(loading…)` placeholder while the
   injected loader promise is in flight.
4. **Links** (outgoing edges, grouped by kind: `contains`, `links-to`,
   `anchored-at`) and **Backlinks** (incoming edges — computed from
   `model.edges`, exactly like the page's `deriveBacklinks`). Each is a
   selectable row; `enter` jumps to that node (selects it in the tree and
   opens its detail).

`↑/↓` move selection across meta + link rows; `enter` on a link jumps; `esc`
returns to the tree with the same node still selected. Wiki-links inside
note *bodies* are not individually key-addressable in v1 (they are reachable
through the Links section).

### 5.3 Focus mode — the 1-hop neighborhood

`f` pins the selected node and switches the body to `focusModel(model, id)`:

```text
◆ note:auth-boundary  (focus — g to exit)
  links to →        note:token-storage ● agent
  ← linked from     note:login-flow ● human · note:threat-model ◐ agent
  contains          (2 rows, when applicable)
  contained by      vault
```

- Groups = outgoing edges by kind (`links-to →`, `contains`, `anchored-at`)
  then incoming (`← backlinks`, `contained by`). 1-hop only (2-hop is a
  documented non-goal, same as v2).
- `↑/↓` select within groups; `enter` re-centers focus on the new node
  (this is the terminal's "click a node to walk the graph"); `g`/`esc`
  exits back to the tree. Selection/expansion state of the tree is
  preserved across focus enter/exit.

### 5.4 Health surface

`healthModel(model)` — **derived exclusively from the `GraphModel`** (mirrors
v2 §7: zero new server/core fields). Not `formatDashboard` (that needs a
`WorkspaceStatus`; we already hold the fresher thing). Sections:

- **Repository**: `staleness.state` + all `staleness.reasons`; languages and
  file count (repository node detail); summarized-file count (sum of module
  `detail["summarized files"]`) with the hint `run /weave-scan deep`.
- **Vault**: true note count (`detail.notes` on the vault node — may exceed
  the 500-node cap, and when truncated the cap warning row, already phrased
  in `detail.warning`), provenance split computed from nodes
  (human/agent/generated).
- **Link health**: orphans (notes with no incoming `links-to`), dangling
  (notes whose `detail["dangling links"] > 0`, with counts), top-10 hubs by
  incident-edge degree. Lists cap at ~10 rows with `… and N more`.

---

## 6. Keybinding map (concrete)

| Key | Context | Action |
| --- | --- | --- |
| `↑` / `k`, `↓` / `j` | all surfaces | move selection |
| `→` / `l` | tree | expand node; if already expanded, move to first child |
| `←` / `h` | tree | collapse node; if already collapsed/leaf, jump to parent |
| `enter` | tree | open Detail for selection |
| `enter` | detail / focus | jump to the selected link/neighbor (detail: re-open; focus: re-center) |
| `pgup` / `pgdown` | all | page the window |
| `home` / `end` | all | first / last row |
| `/` | tree, focus, health | enter search mode (filter applies to tree rows) |
| *(printable chars)* | search | append to filter; live re-filter, ancestors auto-expand |
| `backspace` | search | delete char |
| `enter` | search | keep filter, exit to tree |
| `esc` | search | clear filter, exit to tree |
| `p` | any | cycle provenance filter: all → human → agent → generated → all |
| `i` | tree, focus | toggle internals (`gitState`/`external`/`package`/`entryPoint`) |
| `f` | tree, detail | enter focus on selected/current node |
| `g` | focus | exit focus to tree |
| `1` | any except search | Explore (tree) surface |
| `2` | any except search | Health surface |
| `r` | any except search | refresh: rebuild graph from disk (async, old view stays up, banner flips to `refreshing…`) |
| `o` | any (note selected/open) | open the note in `$EDITOR` via `openNoteInEditor` |
| `?` | any except search | toggle expanded help block |
| `q` | any except search | quit explorer → `done(null)` |
| `esc` | detail → tree; focus → tree; tree → quit | precedence: search > surface-exit > quit |

Unmatched keys (including `ctrl+c`) are **not consumed**… with the
custom-component contract the component owns input while focused, so
documented behavior: we only act on the keys above and ignore the rest;
global pi keys (`ctrl+c` interrupt etc.) are the harness's — the explorer
must not implement process-level shortcuts. Vim-style `hjkl` duplicates are
deliberate for the drill-down flow.

Refresh state preservation: `r` rebuilds the model but keeps the expanded
set, filter, surface, and selected **node id** (ids are stable: slugs/paths
only — the build.ts invariants make this safe). A selected/expanded id that
no longer exists drops out; selection falls back to the first root.

---

## 7. Provenance & kind theming map

Theme slots only (`theme.fg(slot, …)`) — never hardcoded hex — so pi themes
restyle everything. Style-first per v2 P1: provenance is glyph + dimness,
color is the weak secondary channel.

### 7.1 Provenance (`NoteSource | null`)

| Provenance | Glyph (prefix) | Text style | Slot |
| --- | --- | --- | --- |
| `human` | `●` | normal | `success` |
| `agent` | `◐` | normal | `accent` |
| `generated` | `○` | **dim** whole row | `dim` |
| structural (`null`) | none (kind glyph leads) | `muted` label is fine | — |

Filters reuse the same words: the `p` cycle and the header banner print
`● human` / `◐ agent` / `○ generated`.

### 7.2 Kind markers

| Kind | Glyph | Slot | Notes |
| --- | --- | --- | --- |
| `vault` | `◆` | `accent` | |
| `note` | *(provenance glyph)* | provenance slot | trust-first |
| `repository` | `■` | `accent` | adds `warning` badge text when stale |
| `module` | `▪` | `success` | |
| `package` | `▲` | `success` | |
| `entryPoint` | `▹` | `warning` | distinct from chevrons `▸/▾` |
| `gitState` | `⎇` | `warning` | fallback `@` if glyphs render poorly |
| `external` | `↗` | `warning` | |
| `file` (`.okf`) | `·` | `dim` | |

Selection is a reverse/`selectedBg` row background + `›` left gutter;
staleness is a separate `warning`-colored `[stale]` tag — never folded into
the provenance glyph (v2 lesson).

---

## 8. Rendering notes

- **Line contract**: every emitted line passes through `truncateToWidth`
  (tree/health/focus) or a wrapping component (`Text`/`Markdown`) for
  bodies. Style must not bleed across lines — the TUI resets SGR per line;
  we apply `theme.fg` per complete line.
- **No pre-baked ANSI in state**: state holds plain strings; styled lines
  are produced inside `render()`. Cache `string[]` keyed by
  `(width, stateVersion)`; every handled key that mutates state bumps
  `stateVersion`, calls `invalidate()`, then `tui.requestRender()`.
  On theme change, pi calls `invalidate()` → cache clear suffices because
  nothing themed was stored (this sidesteps the "Rebuild on Invalidate"
  trap by construction).
- **Header/footer** are recomputed each state change (cheap string joins),
  cached with the body.
- **Detail body** uses a child `Markdown` component (`setText` on body load)
  whose own cache we rely on; the explorer splices its lines into the
  window slice. `invalidate()` calls child `invalidate()`.
- **Windowing**: body slice = `[scrollOffset, scrollOffset + window)`; window
  = `terminalRows - headerLines - footerLines` clamped ≥ 5. A right-edge
  `▲ more / ▼ more` indicator pair appears when content exceeds the window
  (SelectList-style scroll info, dim).
- **`generatedAt`** is shown as "data as of …" — honest about the build-once
  model, and `r` gives the user control. Refresh compares nothing; it simply
  rebuilds (byte-identical rebuilds are free no-ops downstream because row
  models are rebuildable from scratch).

---

## 9. Security & limits

1. **Read-only.** The explorer contains no mutation path. `o` is the only
   shell-out and reuses `openNoteInEditor`: traversal-safe slug check,
   existence check, then `$EDITOR`/`$VISUAL` (whitespace-split) with the
   platform opener fallback — the same guarantee set as the HTTP `/open`
   endpoint. Caveat documented: terminal-resident editors (vim) will fight
   the TUI's raw mode; GUI/editor-server `$EDITOR`s (`code --wait`, `open`)
   work cleanly. v1 accepts the caveat.
2. **Traversal**: note bodies load only via `resolveNotePath`-guarded
   readers; `.okf` bodies only via the anchored `resolve(<cwd>/.okf, rel)` +
   prefix check. Both move to core unchanged (`current.ts`).
3. **Terminal-escape sanitization** (the TUI-specific XSS analog): note
   titles, detail values, and file bodies are user/disk content that could
   carry ESC/OSC sequences. All graph-derived strings pass through
   `sanitizeTerminalText(s)` — strip `\x1b`, `\x9b`, `\x07`, C0 controls
   (except `\n` in bodies) — *before* styling or handing to `Markdown`.
   Exported from `model.ts`, unit-tested.
4. **Caps**: notes already cap at `DEFAULT_MAX_NOTES = 500` upstream; the
   vault `detail.warning` surfaces truncation. Search input capped at 200
   chars. Health lists cap at 10 + overflow line. Meta values truncated to
   width.
5. **No network, no new env vars, no new dependencies**
   (`@earendil-works/pi-tui` is already a peer/dev dep; nothing imported
   beyond it and node builtins).

---

## 10. Testing strategy

All under `tests/pi/` using existing fixtures (`tests/helpers.ts`:
`makeTempDir`, `writeFixture`, `gitInit`, `commitAll`, `withVaultEnv`).

### 10.1 `tests/pi/viewTuiModel.test.ts` — pure view-model (the `listTree` analog)

- `treeRows`: root set (`vault`, `repository`); expansion/collapse pruning;
  entry-point nesting under prefix modules (`depth` assertions like the page
  tests); `.okf` subtree nesting; internals hidden by default / shown with
  `showInternals`; query filter prunes to matches + ancestors (auto-expand);
  provenance filter; combined filter; empty vault; vault-only (no repo).
- `focusModel`: grouped 1-hop, both directions, kind grouping, 2-hop
  excluded; node with no edges (center only).
- `detailModel`: meta ordering; links/backlinks derivation (contains not
  counted as backlink); entry-point summary surface.
- `healthModel`: staleness passthrough; provenance counts incl. structural;
  orphans/dangling/hubs on hand-built models; truncation warning surfaced.
- `sanitizeTerminalText`: strips ANSI payloads from hostile labels.
- `reduce`: key→state transitions (expand, move, filter chars, mode
  switches, selection clamp after shrink, refresh-merge of expansion state).
- Fixture graphs are hand-built `GraphModel` literals (as the page tests do)
  **plus** one end-to-end model from `buildGraph` over a temp vault/repo to
  pin the integration of builders ⇄ view-model.

### 10.2 `tests/pi/viewTuiExplorer.test.ts` — the component, no terminal

Construct `WeaveExplorer` directly with:

- fake theme: identity `fg/bg/bold` (or tagged markers to assert slots);
- fake tui: `{ requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } }`;
- injected `loadNote`/`loadOkf` stubs (no disk) plus one suite binding the
  real `readNoteForView`/`readOkfFileForView` against temp fixtures;
- captured `done` callback.

Feed raw key **byte sequences** — what a terminal emits — so `matchesKey`
runs its real decode path: up `"\x1b[A"`, down `"\x1b[B"`,
left `"\x1b[D"`, right `"\x1b[C"`, enter `"\r"`, esc `"\x1b"`, and literal
strings for letters (`"f"`, `"/"`, `"p"`…). Assert on `render(80)` output:
- lines never exceed width (`visibleWidth(line) <= width`);
- labels/markers/banners appear; chevrons flip on expand;
- esc precedence order (search → surface → quit → `done(null)` exactly once);
- `r` triggers the injected rebuilder, shows `refreshing…`, merges state;
- async body load: placeholder → flushed promise → body lines;
- cache: two `render(80)` calls are referentially identical;
  `invalidate()` forces recompute;
- windowing: with `rows` small and many nodes, output length ≤ window.

### 10.3 `tests/pi/viewCommand.test.ts` (extend) — wiring

Extend `MockUi` in `tests/helpers.ts` with a `custom(factory, options)`
stub that records the call and (optionally) invokes the factory with the
fake tui/theme/`done`, returning a controllable promise. Then:

- `/weave-view` (no arg) unchanged: server starts, browser exec happens.
- `/weave-view tui`: `ui.custom` invoked once; `done(null)` completes the
  handler; status line refreshed after close.
- Guards: `hasUI=false` and `mode="rpc"` → warning notify, **no** `custom`
  call, no server start.
- Unknown arg → usage warning, nothing else.
- Session lifecycle unaffected: `session_shutdown` still closes the HTTP
  server; the TUI holds no session resources.

### 10.4 Core move

`buildCurrentGraph` / reader tests move with the functions to a new
`tests/core/graphCurrent.test.ts` (existing cases preserved: fresh-per-call
liveness, corrupt-index degradation, summary sidecar, traversal refusals);
`server.ts` re-export keeps the old import paths green during transition.

Coverage: all logic lives in exported functions/component methods — nothing
string-embedded like the page's inline JS — so the 95% gate applies
cleanly. `npm run check` must pass before the PR.

---

## 11. Implementation plan (ordered)

1. **Core extraction** — new `src/core/graph/current.ts` hosting
   `buildCurrentGraph`, `readNoteForView`, `readOkfFileForView` (verbatim
   behavior); export from `src/core/index.ts`; `server.ts` imports +
   re-exports; add `tests/core/graphCurrent.test.ts`; keep old tests green.
2. **View-model** — `src/pi/viewer/tui/model.ts` (`treeRows`, `focusModel`,
   `detailModel`, `healthModel`, `reduce`, `sanitizeTerminalText`, types)
   + `theme.ts` (glyph/slot maps). Full unit suite (§10.1). No pi-tui import.
3. **Component** — `src/pi/viewer/tui/explorer.ts` (`WeaveExplorer`) +
   component tests (§10.2).
4. **Wiring** — `src/pi/viewer/tui/run.ts` + `src/pi/index.ts` arg parsing,
   description update; extend `tests/helpers.ts` mock + viewCommand tests
   (§10.3).
5. **Docs** — update `docs/weave-view.md` (TUI section), the `/weave-view`
   rows in README, `skills/weave-explore` mention, and amend the AGENTS.md
   "no custom TUI renderers yet" line (points here).
6. **Gate** — `npm run typecheck`, `npm run coverage` (≥95% everywhere),
   manual smoke: `pi -e ./src/pi/index.ts` → `/weave-view tui` in an
   indexed repo; per repo hard rules: feature branch + PR, never main.

---

## 12. Open questions / risks

1. **Modal blocking.** The explorer owns the session while open. Accepted
   for v1 (it's a deliberate reading surface, and the browser viewer stays
   non-blocking) — but if usage shows people wanting it persistent, a
   follow-up could re-express the header strip as a `setWidget` glanceable
   line. Not v1.
2. **`o` + terminal editors.** Raw-mode conflict is inherent; we document
   the GUI `$EDITOR` recommendation rather than engineering suspend/resume.
3. **Logic duplication with the page.** `treeRows`/`focusModel`/`healthModel`
   port the page's inline-JS `listTree`/`focusNeighborhood` semantics into
   TS. Two implementations drift over time; mitigate by porting the page
   tests 1:1 now, and if a third consumer appears, promote the view-model to
   core (rule of three — deliberately *not* done preemptively since it's
   presentation policy, and AGENTS.md keeps UI out of core).
4. **Glyph rendering.** `◐`/`⎇` width/availability varies by terminal/font;
   all glyphs go through `truncateToWidth`/'`visibleWidth` (double-width
   safe) and have ASCII fallbacks in `theme.ts` if a config flag is later
   warranted.
5. **Async factory support matrix.** We build the graph in the handler and
   pass a ready component to `ctx.ui.custom`, avoiding reliance on the async
   factory path; `pi-coding-agent` is a `*` peer dep, so conservative API
   use (the documented three-method object + `requestRender`) is intended.
6. **Terminal height access** (`tui.terminal.rows`) is used only for
   windowing with a hard fallback; if a future pi changes the surface, the
   fallback keeps the component functional.
