# weave-view TUI v2 — A Controllable Workspace

> **Status: design draft for implementation.** This supersedes the *layout*
> aspects of `docs/weave-view-tui-design.md` (v1). v1's data model, provenance
> theming, security, and testing posture are *kept*; this document changes
> *how the surfaces are arranged, focused, and reshaped*, and *how the product
> is branded*. v1 is already shipped (`src/pi/viewer/tui/`); v2 is an evolution,
> not a rewrite.

---

## 0. The problem, in one sentence

v1 is **a single monolithic pane that swaps surfaces by key** (`1` tree, `2`
health, detail, focus). It is legible and complete, but it feels *clunky and
immoveable*: you can never see your tree *and* the note you're reading *and*
the graph neighborhood you're walking at the same time. The layout is fixed
and the user has no agency over it.

v2 makes the layout **first-class and user-controllable**, in the spirit of
Obsidian's workspace: independent panes you can split, resize, focus, move,
close, and save as a named workspace — while staying inside pi-tui's existing
component model (no new dependencies).

---

## 1. Vision & principles

**Vision:** *pi-weave's knowledge space, arranged the way you think — and
branded as pi-weave, not as a generic dev tool.*

Principles (additions to v1's, not replacements):

1. **P1 — Layout is the user's, not ours.** The default workspace is a
   sensible opinion; everything about it is reshaped by the user without
   leaving the keyboard. Defaults should be *good*, never *locked*.
2. **P2 — Panes, not surfaces.** A "surface" (tree / detail / focus / health)
   becomes a **pane** that can live anywhere, alongside others. The same
   surface can even appear twice (e.g. two Detail panes for two notes).
3. **P3 — One focused pane owns input; the others stay legible.** Exactly
   Obsidian's model: a single active leaf receives keys; the rest render in
   full (dimmed borders) so context is never lost.
4. **P4 — Branded and refined.** The logo is present (where the terminal
   supports it), the chrome is restrained, motion is choreographed, and the
   type/rule density reads as a polished product, not a debug view.
5. **P5 — Keep the hard constraints.** Read-only, derived, zero new runtime
   deps, single-owner input, 95% coverage gate, core stays harness-free.

---

## 2. What we keep from v1 (do not redo)

- The **`GraphModel`** and all readers (`buildCurrentGraph`,
  `readNoteForView`, `readOkfFileForView`) — unchanged.
- The **pure view-model** in `src/pi/viewer/tui/model.ts` (`treeRows`,
  `focusModel`, `detailModel`, `healthModel`, `reduce`,
  `sanitizeTerminalText`) — unchanged in *behavior*; only its *consumption*
  changes (each pane subscribes to a slice).
- **Provenance/kind theming** (`theme.ts`) — unchanged; panes reuse the same
  glyph/slot maps.
- **Security posture** (read-only, traversal-safe readers, terminal-escape
  sanitization, `$EDITOR` shell-out policy) — unchanged.
- **Command shape** `/weave-view tui` and the guards in `run.ts` — unchanged.

What v2 *adds* is a **workspace/pane manager** that sits above the existing
view-model, composes panes from it, and routes input by focus.

---

## 3. The key discovery: pi-tui already has the primitives

This design is feasible *today* with the existing peer dependency.
`@earendil-works/pi-tui` ships:

| Primitive | Used for |
| --- | --- |
| `VStack` / `HStack` (`Stack` base) with flex `basis`/`grow`/`shrink`/`minSize`/`maxSize` | the split tree; **resize = editing these numbers**, no custom layout engine |
| `Container` / `Box` (padding + bg) | pane chrome (border + title + padding) |
| `ScrollView` (vertical, `follow`, `scrollbarStyle`) | per-pane scrolling, replacing v1's manual windowing |
| `Spacer` | empty regions / gutters |
| `Image` (Kitty graphics protocol, base64, `fallbackColor`) | the logo, rendered natively where supported |
| `Markdown` (`MarkdownTheme`) | note bodies (v1 deferred this; v1 wraps plain text — v2 upgrades it) |
| `tui.setFocus(component)` / `addInputListener` / `Focusable` | focus routing between panes |
| `OverlayHandle` (show/hide/focus/unfocus, anchor) | command palette, workspace switcher, help — overlays, not panes |

**Implication:** "split / resize / move / close" is mostly *editing a tree of
Stack entries*, not writing a layout engine. This is what makes v2 small.

---

## 4. Workspace model — the heart of v2

### 4.1 Split tree

A workspace is a recursive tree of **splits** and **panes**:

```text
Workspace
 └─ SplitNode (direction: row | column, sizes: number[])    ← VStack/HStack
     ├─ Pane (leaf: surface instance)                         ← a Surface component
     ├─ SplitNode (direction: column, …)
     │   ├─ Pane
     │   └─ Pane
     └─ Pane
```

- A **SplitNode** maps 1:1 to a pi-tui `VStack` (column) or `HStack` (row).
  Its `sizes` array drives each child's `grow` weight; **resizing a pane =
  adjusting two adjacent weights** (or an absolute `basis`), then
  `invalidate()` + `requestRender()`.
- A **Pane** is a thin `Box`-wrapped component holding a **surface instance**
  (Explore / Detail / Focus / Health / Graph-via-focus).
- The whole workspace is rendered as one `render(width)` tree; pi-tui's
  layout node system (`[LAYOUT_NODE]`) handles intrinsic-size measurement and
  flex allocation. We do **not** reimplement windowing — `ScrollView` does it
  per pane.

### 4.2 Panes are independent surface instances

v1 had *one* tree, *one* detail, *one* focus. v2 lets each pane hold its own
state derived from the shared model:

- Each pane owns: `surface`, the node id it's bound to (for Detail/Focus),
  its own scroll position, its own filter/query snapshot (Explore panes can
  filter independently), its own expansion set.
- Panes **share** the `GraphModel`, the body cache, and the loaders (one
  fetch per node id, reused across panes). The body cache lifts out of
  `WeaveExplorer` into a shared `BodyStore` (§6).
- Selecting a node in one pane can **open it in another pane** rather than
  replacing the current one — this is the Obsidian "open in new tab / split"
  gesture, expressed as a command (§7).

### 4.3 Focus model (Obsidian's "active leaf")

- Exactly **one pane is active** at a time. It receives all input that isn't
  a workspace-level command. Active pane: highlighted border (`accent` slot),
  full-opacity body, owns scroll. Inactive panes: dim border (`line` slot),
  full body still rendered (no dimming of content — context must stay
  readable; only the chrome de-emphasizes).
- `Tab` / `Shift+Tab` cycles focus across panes in layout order; the active
  pane's title strip shows `◆` and the surface name. Focus changes are
  instant (no motion), only the border color transitions.

### 4.4 Default workspaces (ship 3)

| Name | Layout | Purpose |
| --- | --- | --- |
| **Explore** (default) | HStack: `[Explore 40% | Detail 60%]` | the v1 single-pane feel, but already split — the gentlest upgrade |
| **Triple** | HStack: `[Explore 30% | Detail 40% | Focus 30%]` | walk the graph while reading — the power layout |
| **Wide** | VStack: `[HStack(Explore 50% | Health 50%) | Detail (full width, 60%)]` | dashboard on top, reading below |

First open picks the default **Explore** workspace, sized to the terminal
(narrow terminals collapse splits below a threshold → single pane, §9.2).
The user switches via the workspace switcher overlay (`w`).

---

## 5. Logo & branding

### 5.1 The logo — a small, casual mark (per decision 1)

The logo asset is `docs/pi-weave-logo.jpg` (1024×1024). Decision: **don't try to
faithfully reproduce it as line art.** Instead ship a **small raster copy** —
a downscaled variant of the JPG (a handful of KB) bundled with the package —
and embed it as a **small ~2×2-cell favicon-like mark in the header strip**,
casually present. The browser viewer already uses the JPG as its `favicon` and
OG image; the TUI mirrors that gesture with an in-bar mark, not a hero splash.

Render tiers, auto-selected once per session from terminal capability:

1. **Kitty graphics protocol** (preferred) — pi-tui's `Image` component takes
   base64 + mime and emits the Kitty sequence. Renders the real (small) logo in
   the header bar. Probed at startup; cached for the session.
2. **Unicode glyph mark** (fallback) — a tiny curated constant (a single
   box-drawing/Unicode glyph derived from the logo silhouette) stored in
   `branding.ts`. This is the *representation* fallback, never generated from
   the JPG at runtime.
3. **`🧵` + wordmark** (last resort) — as today; forced by `PI_WEAVE_TUI_PLAIN`.

No full-screen splash of the logo (§5.4 empty state uses the small mark, not
the hero, per the "casual" decision).

### 5.2 The header strip (refined chrome)

Replaces v1's two/three plain header lines with a compact branded bar:

```text
┌ 🧵(logo) weave view ───────────── Explore ─ ◆ 2/3 panes ─ ⎇ repo:ok ┐
│ notes 128 (● 40 / ◐ 62 / ○ 26)   data as of 3m ago   r↻ refresh        │
```

- One line by default; expands to two only when an active filter/focus banner
  is present. This recovers vertical space for panes (v1 burned 2–3 lines).
- The logo mark leads, then the wordmark `weave view` (bold), a thin rule
  (`─`) fills to the right, then surface/pane count, then repo state, then
  the refresh affordance.
- `tnum` figure settings on counts (already in v2 browser spec) so the bar
  doesn't jitter on refresh.
- The bar is **part of the workspace chrome**, not a pane — it always sits
  on top, full width.

### 5.3 Footer / command bar

One dim line of *contextual* hints that adapt to the active pane's surface
and the last command family. `?` expands to a full help **overlay** (not a
line). v1's help block ate body space; v2 lifts it into an overlay so help
never shrinks the workspace.

### 5.4 Empty state

When the vault is empty and the repo is unindexed, the workspace center
shows the **small logo mark** (per decision 1) above a single line:
`no notes yet — add one with the weave_note tool  ·  /weave-scan deep to index the repo`.
This makes the "nothing here" state feel intentional rather than broken —
without turning the brand into a hero splash.

---

## 6. Module layout (delta from v1)

```text
src/pi/viewer/tui/
  model.ts         KEPT — pure view-model (v1), lightly extended:
                     panes subscribe to slices; add pane-id-stable selectors.
  theme.ts         KEPT — glyph/slot maps; ADD border/chrome slots used by panes.
  branding.ts      NEW — logo render tiers, wordmark, line-art mark, probe.
  bodyStore.ts     NEW — shared note/.okf body cache + in-flight dedup,
                     lifted out of WeaveExplorer so all panes share one fetch.
  surface/
    base.ts        NEW — Pane<Surface> wrapper (Box + border + title + focus
                     ring), ScrollView host, the shared Surface interface.
    explore.ts     NEW — Explore surface as a Component (wraps treeRows + keys).
    detail.ts      NEW — Detail surface component (Markdown body, links).
    focus.ts       NEW — Focus surface component.
    health.ts      NEW — Health surface component.
  workspace.ts     NEW — the split tree, focus owner, resize/split/move/close
                     commands, default workspaces, save/load named workspaces.
  explorer.ts      CHANGED — now the Workspace root Component: builds the
                     Stack tree from workspace.ts, owns the single input
                     listener, routes keys to the active pane or to workspace
                     commands. The bulk of v1's input/render moves here.
  run.ts           KEPT — guards + buildCurrentGraph + ctx.ui.custom wiring.
                     Passes rows + terminal capability probe into the explorer.
```

**Core untouched.** All new files are adapter-side (`src/pi/`), import only
core types + pi-tui, and stay within the 95% gate via exported pure
functions/components (mirrors v1's testing strategy, §11).

---

## 7. Commands — the user controls the layout

Two input layers, resolved top-down:

1. **Workspace commands** (work in any pane, prefix-free): focus cycle,
   split, close, resize, move, workspace switch, refresh, help, quit.
2. **Pane commands** (only in the active pane): everything v1 had —
   navigation, expansion, filter, provenance cycle, focus-in/out, open-in-
   editor. Unchanged keys, unchanged behavior, just scoped to the active pane.

### 7.1 Workspace keymap (new)

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | cycle focus to next/previous pane |
| `\` | split active pane **vertically** (new pane below, same surface, empty selection) |
| `\|` (Shift-\) | split active pane **horizontally** (new pane to the right) |
| `Ctrl-h/j/k/l` | **resize**: shrink/grow the active pane in that direction (adjusts the relevant SplitNode weights) |
| `Ctrl-H/J/K/L` (or `Alt-`) | **move** the active pane's boundary-neighbor selection / swap panes within a split (see Q3) |
| `x` | close the active pane (if it's the last pane in the workspace, keep one empty pane, don't quit) |
| `e` / `d` / `f` / `h` | open a new **Explore / Detail / Focus / Health** pane in place of the active one (swap surface) |
| `E` / `D` / `F` / `H` (Shift) | open that surface in a **new split** to the right |
| `w` | open the **workspace switcher** overlay (named workspaces + save/new) |
| `r` | refresh (unchanged) — rebuild graph; all panes re-derive |
| `?` | help **overlay** |
| `q` | quit explorer |

> **Resize ergonomics (Q3 — needs your call):** `Ctrl-hjkl` for resize is the
> Obsidian/tmux instinct, but conflicts with nothing in the explorer. The
> alternative is a resize **mode** entered with `R` then `hjkl` (no Ctrl),
> exited with Esc — heavier but modifier-free on terminals where Ctrl is
> awkward. I lean `Ctrl-hjkl`; flagging because it's the one shortcut a user
> hits constantly.

### 7.2 Pane keymap (unchanged from v1, scoped)

All of v1's keys (`↑↓jk`, `←→hl`, `enter`, `/`, `p`, `i`, `f`, `g`, `1`, `2`,
`o`) apply **to the active pane only**. The only behavior change: when a pane
command would "open detail" (v1 replaced the whole view), v2 instead:
- if the active pane *is* a Detail/Focus pane → rebind it in place;
- else → open in the **nearest** Detail pane to the right of the active pane,
  splitting one if none exists (the Obsidian "open in main" instinct). This
  is the default; a pane-level command `o`-style (e.g. `O`) forces "open here".

### 7.3 The workspace switcher overlay (`w`)

A pi-tui **overlay** (not a pane): a compact list of named workspaces
(default ×3 + any saved), with actions: apply, save current as…, rename,
delete. Saving serializes the split tree (structure + per-pane surface &
bound node, **not** transient scroll) to a JSON file under the vault
(`~/.okf/workspaces/<name>.json`) so it survives sessions — a v1 gap (Q2:
persist per-project vs global? I propose per-project, keyed by cwd).

---

## 8. Motion & refinement

v1 has no motion. v2 adds **choreographed, reduced-motion-safe** transitions
that are cheap because they're per-line SGR, not re-layouts:

- **Focus change:** 120ms border-color crossfade on the old/new active pane
  (SGR only; layout is identical so no reflow). Reduced-motion → instant.
- **Split/close:** the new pane's lines fade in (150ms opacity ramp via a
  per-line dim→full sequence on the next two render frames). Reduced-motion
  → instant.
- **Selection:** v1's `›` gutter + selectedBg, kept; add a 1-frame accent
  "pop" on the selected row when focus changes (decorative, optional).
- **Refresh:** the header `r↻` glyph spins one notch per render frame until
  `refreshDone` (v1 already flips a banner; v2 makes it a glyph so it doesn't
  eat a line).

All motion is implemented as **interpolated render inputs** (the component
emits slightly different styled lines across a few `requestRender` ticks),
never as animated layout. `prefers-reduced-motion` is honored via the
terminal's capability query (Q4: confirm pi exposes a reduced-motion signal;
if not, gate on `PI_WEAVE_TUI_NO_MOTION=1`).

---

## 9. Performance & scope

### 9.1 Sharing work across panes

- **One `BodyStore`** per session: `loadNote(slug)` / `loadOkf(rel)` are
  deduped by id; every Detail pane reading the same note renders from the
  same fetched string. v1's per-explorer cache was fine for one pane; v2's
  multi-pane case demands the shared store.
- **Per-pane row models** are recomputed only when that pane's own state or
  the shared model changes; an unchanged pane's `render(width)` returns its
  cached lines (v1's render cache, lifted to the pane level).
- `ScrollView` owns scrolling per pane — we **remove** v1's hand-rolled
  windowing/offset logic from `explorer.ts`; that's a net code reduction.

### 9.2 Responsive collapse

Below thresholds, splits collapse to a single pane so the TUI never renders
an unusable sliver:

| Terminal width | Behavior |
| --- | --- |
| ≥ 110 cols | full split layouts as authored |
| 80–109 cols | max one vertical (column) split; 3-pane workspaces become 2+1 stacked |
| < 80 cols | single pane; all multi-pane workspaces collapse to the active pane; `Tab` still cycles but only one is visible at a time (others are "tabs" — Q5: do you want a tab bar in this narrow mode?) |

Height: < 18 rows → header collapses to one line, footer hides hints to `?`.

### 9.3 Caps

Inherited from v1: notes capped at `DEFAULT_MAX_NOTES = 500`; health lists cap
at 10 + overflow; filter input 200 chars. Multi-panes don't add data, only
views, so caps are unchanged.

---

## 10. Accessibility & contrast

- Provenance/kind never color-only (v1's glyph+style-first) — kept.
- **Active pane** is conveyed by border style (solid `accent` vs dim `line`)
  **and** a leading `◆` in the title, not color alone — meets the
  not-by-color rule for the new focus signal.
- Keyboard: every layout operation is a key; no mouse requirement (mice
  aren't in pi-tui's model anyway). All panes reachable by `Tab`.
- Reduced-motion honored (§8).
- Contrast: reuse v2 browser token pairs; pane borders use existing
  `line`/`accent` slots, already contrast-verified.

---

## 11. Testing strategy (extends v1, same posture)

Coverage gate is `vitest --coverage ≥ 95%` over `src/**/*.ts`. Every new
module is exported + unit-testable without a terminal.

- **`workspace.ts`** — pure functions over a `Workspace` value:
  `split(ws, id, dir)`, `close(ws, id)`, `resize(ws, id, dir, delta)`,
  `move(ws, id, dir)`, `focus(ws, dir)`, `applyLayout(ws, name)`,
  `serialize(ws)`/`deserialize(json)`, `collapseForWidth(ws, width)`.
  Assert the split tree shape, weight math, focus order, and the responsive
  collapse table in §9.2. No pi-tui import in this layer.
- **`bodyStore.ts`** — dedup + cache + bust-on-refresh, with fake loaders.
- **`surface/*.ts`** — each surface as a Component with injected theme/tui;
  feed real key byte-sequences (as v1's `decodeAction` tests do), assert
  `render(width)` lines ≤ width and that the right rows are selectable.
  Explore/Detail/Focus/Health reuse v1's `model.ts` tests verbatim (the
  view-model didn't change) — we *port* them, not rewrite them.
- **`explorer.ts`** (workspace root) — built with fake tui/theme/loaders +
  a fake terminal (`{rows, columns}`) and a `probeGraphics()` stub for the
  logo tier. Assert: focus routing (workspace key vs pane key precedence),
  resize changes the Stack weights and re-renders, `w` opens the overlay,
  `q` calls `done(null)` exactly once, responsive collapse at 79/80/109/110
  cols, cache stability across identical renders.
- **`branding.ts`** — `logoTierFor(capabilities)` selects Kitty/Unicode/glyph;
  `renderMark(tier, theme, width)` returns ≤ width lines; sanitize the
  Unicode mark (no stray ESC). The line-art constant is snapshotted.
- **`run.ts` / viewCommand** — extend the v1 mock: `ui.custom` factory is
  invoked, the workspace opens with the default layout for the cwd, guards
  unchanged. New: `PI_WEAVE_VAULT` workspaces dir is created lazily and is
  temp-dir isolated in tests (`withVaultEnv`).
- **Core:** untouched; existing `tests/core/**` stays green.

---

## 12. Security & limits (delta)

- No new shell-out paths; `o` reuses `openNoteInEditor` exactly as v1.
- **Kitty image data** is a fixed JPG bundled with the package (read at
  build/runtime from `docs/pi-weave-logo.jpg` via `import`? — no; read from
  disk relative to the extension, base64'd once, cached). It is *our* asset,
  not user content, so it bypasses the terminal-escape sanitization that
  guards note bodies. The line-art and glyph tiers contain no ESC by
  construction (constants).
- **Workspace JSON** (`~/.okf/workspaces/<name>.json`) is read with the same
  traversal-safe read we use for notes; malformed JSON degrades to the
  default workspace with a warning, never crashes. Saved workspaces store
  only structure + bound node ids (no code, no paths beyond node ids).
- No new env vars except the optional `PI_WEAVE_TUI_PLAIN` and
  `PI_WEAVE_TUI_NO_MOTION` opt-outs. No new dependencies.

---

## 13. Migration & rollout

v2 is **additive and backward-compatible** at the command level
(`/weave-view tui` unchanged). Internal migration:

1. **Extract `BodyStore`** from `WeaveExplorer` — first PR, no UX change, v1
   behavior preserved, tests stay green. (Pure refactor; safe to land.)
2. **Surfaces → Components** — lift each surface out of `explorer.ts` into
   `surface/*.ts`, still rendered as a single pane (no splits yet). Land
   behind the existing keymap; v1's users see no difference.
3. **Workspace + splits** — introduce the split tree and the default
   Explore (split) workspace. Workspace keymap (§7.1) goes live; pane keymap
   (§7.2) is unchanged. This is the user-visible v2.
4. **Branding** — logo tiers, refined header/footer, splash. Polish milestone.
5. **Workspaces persistence + switcher overlay** — save/load named layouts.
6. **Gate** — `npm run check` green; manual smoke in an indexed repo at
   80/110/140 cols; feature branch + PR per repo hard rules.

Each milestone is independently shippable and testable.

---

## 14. Non-goals (explicit)

- **Mouse / drag-to-resize.** pi-tui has no pointer model; resize is
  keyboard only. (If pi-tui grows pointer support later, the split tree is
  already the model a drag would edit.)
- **A spatial force-graph in the terminal.** Inherited from v1; Focus pane
  remains the graph-walking surface.
- **Editing from the TUI.** Read-only; `o` is the only shell-out, unchanged.
- **Per-pane theming.** One theme; panes differ by chrome state only.
- **Unlimited panes.** Soft cap (e.g. 8) with a friendly warning; the
  terminal is finite and the split tree degrades below ~2 rows/pane.
- **Syncing workspaces across machines.** They live in the local vault; a
  future git-sync of `~/.okf` would carry them for free.

---

## 16. Graph visualization — fixing jumpy & crowded (browser viewer)

> Scope note: the **spatial** graph lives in the **browser viewer**
> (`src/pi/viewer/page.ts`), not the TUI (the TUI's "graph" is the
> tree+focus panes). This section addresses the force-graph the user
> called "jumpy and crowded." It is a companion to the TUI v2 work, in
> the same persistent file because the same agent(s) will pick it up.
> It respects the browser viewer's hard constraints: **single
> self-contained HTML string, zero external resources, no new deps,
> hand-rolled sim, ~500-note cap** (AGENTS.md + weave-view-v2 §8).

### 16.1 What the user sees, and why

Today the sim (`page.ts:639` `tick()`): charge `380·alpha/d²`, a 22px-min
soft collision, center gravity `0.006·alpha`, link springs
`(dd−REST)·0.018·alpha`, `alpha *= 0.995` decay, warm-up before paint.
Two failure modes the user named:

- **Jumpy** — every rebuild re-seeds all node positions (`sim = {}`, fresh
  random coords), so a single new note or poll delta re-explodes the whole
  graph; plus uncontrolled oscillation on high-degree hubs.
- **Crowded** — no real collision (22px is a floor, not separation) and the
  vault is **scale-free**: a few hub notes + a forest of leaf notes,
  producing the classic hairball around hubs.

### 16.2 How the big guys do it (researched, grounded)

Sources: Obsidian graph docs + Persistent Graph plugin (the single most
requested community plugin — "graph lovers, rejoice… every time you
restart all nodes lose their place"); d3-force reference (Obsidian's
original engine, and the model `page.ts` hand-rolls); ForceAtlas2 / Gephi
paper (PLOS ONE, Jacomy et al.); Cytoscape.js "Using layouts" tutorial.

The converging lessons, ranked by leverage for pi-weave:

1. **Position persistence** (Obsidian Persistent Graph; d3-force `fx/fy`).
   Existing nodes keep their coordinates across rebuilds; only new nodes
   get seeded positions; removed nodes vanish. This is the *single biggest*
   fix for "jumpy." Node ids are stable slugs/paths (build.ts invariant), so
   persistence is safe.
2. **Subgraph-by-default, not whole-graph** (Cytoscape "the hairball
   problem"). Large graphs are visual noise; the answer is to show a
   *relevant subgraph* — N hops around a locus — and let the user expand.
   pi-weave already has Focus mode; the lesson is to make the **focused
   neighborhood the default first paint**, with "show all" as an explicit
   `g`. Don't open on a 500-node blob.
3. **Repulsion by degree** (ForceAtlas2, the clutter-killer for scale-free
   graphs). `F_r ∝ (deg₁+1)(deg₂+1)/d` brings leaves close to hubs instead of
   scattering them around the periphery — directly targets the vault's
   hub-with-leaves clutter. Cheap to drop into the hand-rolled charge term.
4. **Real collision force** (d3-force `forceCollide`; ForceAtlas2 "Prevent
   Overlapping"). Radius ∝ node size (degree), border-to-border distance,
   disable attraction when overlapping, stronger repulsion when
   overlapping, **iterative relaxation** (a few sub-iterations/tick to kill
   partial overlaps without jitter).
5. **Adaptive damping / anti-oscillation** (ForceAtlas2 swinging+traction).
   Track each node's force divergence between ticks; slow swingers down.
   This is the cure for the perpetual low-grade jiggle that reads as
   "jumpy." Local speed, capped by a global tolerance.
6. **Controlled reheat, not full reset** (d3-force alpha/alphaDecay/alphaMin).
   On a small data delta, nudge alpha up just enough (e.g. 0.05) to settle,
   never back to 1.0. Full reheat only on user action ("re-simulate").
7. **Deterministic initial positions** (d3-force phyllotaxis). Seed new
   nodes on a phyllotaxis spiral, not `Math.random()` — same graph always
   starts the same shape, so even a cold start isn't jumpy.
8. **User pinning** (d3-force `fx/fy`; Obsidian drag-to-pin). A dragged node
   stays fixed across ticks *and rebuilds* — the frame-of-reference
   stability the Cytoscape Wine&Cheese example is built on.
9. **Degree-weighted gravity** (ForceAtlas2) so disconnected components
   (islands) cluster without collapsing into the center.
10. **Component packing** (ELK `disco`; Cytoscape) so disconnected islands
    don't overlap each other.
11. **Label discipline** (Obsidian text-fade threshold). Show labels only
    above a zoom level or for high-degree / hovered / selected nodes — the
    biggest *perceived* clutter reduction, at zero layout cost.
12. **A deterministic layout alternative** (Cytoscape `concentric` by degree;
    d3-hierarchy tidy tree for the containment DAG). Offer "radial by
    degree" or "tree" as a toggle for users who want a *stable* map, not a
    simmering physics soup. The containment hierarchy
    (vault→note, repo→module→file) is genuinely tree-shaped and reads far
    better as a tree/hierarchy than as a force blob.

### 16.3 What to do in pi-weave (concrete, zero-dep, in `page.ts`)

Tier the work by leverage; each tier is independently shippable.

**Tier A — stop the jump (positions & reheat):**
- Persist `sim[id]` positions in a `Map` keyed by node id that **survives**
  `buildModel` / poll rebuilds. On rebuild: reuse coords for surviving ids,
  seed only **new** ids (phyllotaxis spiral, not random), drop removed ids.
- Replace the all-or-nothing alpha reset with a **delta-aware reheat**:
  no-op JSON → no reheat (already true); small delta → alpha = max(alpha,
  0.05); explicit user "re-simulate" → alpha = 0.5 (not 1.0).
- Persist user-pinned nodes (`fixed` flag in the sim entry) across rebuilds.

**Tier B — kill the crowding (forces):**
- Replace the soft 22px collision with a real **collision force**: radius
  `r = 7 + min(6, √degree·1.2)` (the v2 spec's degree sizing), border-to-
  border, `iterations = 2` per tick, anticipated positions to reduce jitter.
- Add **repulsion-by-degree** to the charge term: multiply by
  `(degᵢ+1)(degⱼ+1)` (normalized so total energy stays comparable).
- Add **degree-weighted gravity** so islands pack without imploding.

**Tier C — kill the jiggle (damping) + labels:**
- Port ForceAtlas2's **swinging/traction local speed**: track each node's
  force divergence vs the previous tick; scale its displacement by
  `1/(1+k·√swing)` so oscillators slow down. Global tolerance constant.
- **Label fade threshold**: hide labels below a camera scale or for
  low-degree nodes; reveal on hover/selection/zoom-in.

**Tier D — the structural alternative:**
- Add a **layout toggle** (header control): `force` (default, the above) /
  `radial` (concentric by degree — hubs center, deterministic) / `tree`
  (d3-hierarchy-style tidy tree over the containment edges; cross-links
  drawn as curved chords). These are *deterministic* and never jumpy —
  the user gets a stable map when they want one.
- Make **focused-neighborhood the default first paint** (Tier D overlaps
  Tier A's subgraph-by-default from Cytoscape): open on the selected
  note's 1-hop, "show all" on `g`.

### 16.4 What we explicitly do NOT do

- **Barnes–Hut** at ≤500 nodes is premature; the O(n²) charge is fine.
  (Add it only if a real profile shows pain, and only behind the existing
  quadtree-free loop being replaced.)
- **Louvain community detection / auto-clustering** — tempting, but a new
  algorithm in a no-dep single file is a testing liability; the degree-
  weighted forces already make communities *visible* without computing
  them.
- **Edge bundling** — adds rendering complexity for modest gain at this
  scale; deferred.
- **A new dependency** (d3-force, graphology, ForceAtlas2) — rejected by
  the viewer's hard constraints. We port the *formulas* into the existing
  hand-rolled `tick()`, exactly as v2 ports `listTree` semantics into TS.

### 16.5 Testing

The page's inline JS is **outside** the 95% gate (vitest covers
`src/**/*.ts`; the script is a string), per weave-view-v2 §13. Mitigation,
same pattern: extract-and-run the new **pure** helpers from the script:
- `seedPositions(existing, ids)` → phyllotaxis for new ids, reuse for
  survivors (assert determinism: same input → same coords).
- `collideRadius(degree)` / `degreeRepulsion(deg1, deg2)` → formula unit
  tests.
- `localSpeed(prevForce, force)` → swinger damping (assert oscillators
  get smaller steps than steady movers).
- `radialLayout(nodes)` / `treeLayout(nodes, edges)` → deterministic
  position assertions.
- `deltaAlpha(prev, next)` → reheat policy (no-op → 0; small → ≤0.05).
Behaviors, not string markers, mirroring v2 §13.

---

## 15. Decisions (resolved with the user)

1. **Logo handling — small copy, casual.** Don't try to faithfully
   reproduce the full JPG as line art. Instead: ship a **small raster
   copy** of `docs/pi-weave-logo.jpg` (a downscaled variant, a few KB) and
   embed it via the **`Image` component** (Kitty graphics protocol) as a
   **small ~2×2-cell favicon in the header strip** — casually present, not a
   splash centerpiece. The browser viewer already uses the JPG as its
   `favicon`/OG image (`page.ts` / `package.json`); the TUI mirrors that with
   the in-bar mark. Fallbacks (no Kitty support): a tiny **Unicode glyph**
   mark derived from the logo silhouette (a single curated constant, not
   OCR'd at runtime), then `🧵`. No full-screen splash of the logo — it's a
   small, incidental brand touch, not a hero.
2. **Workspace persistence — per-project, keyed by cwd.** Saved under
   `~/.okf/workspaces/<cwd-hash>/<name>.json`. Confirmed.
3. **Resize ergonomics — `Ctrl-hjkl`.** Modifier, instinctive, always-on;
   easy UX. Confirmed.
4. **Reduced-motion signal — verify during impl.** Unknown whether pi
   exposes a reduced-motion preference; the implementing agent checks
   `docs/tui.md` and the terminal capability surface. Fallback gate:
   `PI_WEAVE_TUI_NO_MOTION=1`. No answer needed now.
5. **Narrow-mode tab bar — include it.** A one-line tab strip under ~80 cols
   showing the other panes (tmux-style), since multi-pane layouts collapse to
   one visible pane there. Confirmed.
6. **First-run default workspace — Explore (split).** Gentle, least
   surprising; the show-off **Triple** is one `w`-away. Confirmed.
7. **`Markdown` for bodies — yes.** Detail panes render note bodies through
   the real `Markdown` component (already a peer dep, no new dependency).
   Confirmed.