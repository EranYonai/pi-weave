# Frontend plan — making the workspace great again

*Branch `fix/weave-view-graph-consistency`, 2026-08-29.*

Four reviews fanned out over the workspace client (design, accessibility, UX, and
performance/motion — the last with measurements run against `repoLikeGraph()`
fixtures and the real d3-force pipeline). This document is the synthesis: what is
already fixed on this branch, what to fix next and in which order, and — equally
important — a register of things that are correct *on purpose* and must not be
"fixed". Everything below honours §10 (all decisions in pure `.model.ts` files,
`.tsx` files are props-in/JSX-out) and the 150 KiB gzip bundle budget.

---

## 0. Already done on this branch

- **Palettes from the brief.** Light "linen and plum" (`#F8EDE3 #DFD3C3 #D0B8A8
  #85586F`) and dark "indigo dusk" (`#2A2F4F #917FB3 #E5BEEC #FDE2F3`), derived
  into full token sets with documented contrast ratios; the graph's WebGL
  `GRAPH_PALETTE` mirrors them under a test gate.
- **The theme switch.** Tri-state `system / light / dark` in the pure
  `shell/theme.model.ts`; a `◐/○/●` header button plus the bare `t` key cycle
  it; the choice reaches the sheet as a `data-weave-theme` attribute on `<html>`
  (CSP-legal, `system` clears the attribute so the media query keeps answering
  live OS flips), is persisted to `localStorage` pre-paint in `main.tsx`, and is
  resolved for the graph column in `Shell.tsx` → `Columns.tsx` → `Graph.tsx`
  (a change remounts the renderer — the honest response, since a WebGL palette
  is fixed at construction).
- **Review touch-ups already applied.** Themed light-tinted scrim,
  `::selection` from the palette, thin themed scrollbars,
  `.weave-ctx-heading` unified with `.weave-col-title`, and the once-undefined
  `--weave-raise` token now defined in both schemes.
- `npm run check` green: 2553 tests across 71 files; bundle 107.2 KiB gzip of a
  150 KiB budget.

---

## 1. Tier 0 — real bugs first

**Status: done** (2026-08-29), on top of the theme-switch work. Per-item notes
where reality corrected the review:

- T0.1 ✅ palette selection now routes through `editor.send({type:"navigate"})`
  like every other column, behind the dirty-draft guard.
- T0.2 ✅ the note `<article>` is keyed on the note slug — the article *is* the
  scroll container, so a fresh note starts a fresh container at the top.
- T0.3 ✅ `toggleColumn`/`isVisible`/the `revealed` state deleted; the reader
  now ignores the stored `revealed` key the toggle era left behind. (§1.2's
  viewport collapse itself is untouched — that was never the bug.)
- T0.4 ✅ `forceCollide(...).iterations(3→1)` in `shared/layout.ts` (reviewer-
  measured ~45 % faster cold layout); the stale "tens of milliseconds" claim in
  `column.model.ts` replaced with the measured numbers. §8's non-degeneracy
  gate passes unchanged. `LAYOUT_TICKS` left at 300.
- T0.5 ✅ dark `--weave-bad` → `#eb93a1`. **Correction to the review:** the old
  `#e37e8d` measured 4.72:1 (AA-passing, contrary to the review's 3.6:1
  claim); the new value is 5.70:1, kept for margin, with ratios documented in
  `theme.ts`.
- T0.6 ✅ help rows derive a "(when on screen)" caveat for the tree/graph
  columns from `columnsAt`, not a hand-typed string.

## 2. Tier 1 — cheap, high-leverage performance

**Status: done** (2026-08-29).

| # | Finding | Where | Fix |
|---|---------|-------|-----|
| T0.1 | **⌘K search bypasses the dirty-draft guard.** Opening the palette from the header or the keyboard selects a note directly, while every other navigation path routes through `editor.send({type:"navigate"})` and parks behind the UNSAVED prompt. One door, three that forgot. | `Shell.tsx` (`onSelect` handoff) | Route the palette's selection through the same `navigate` event. |
| T0.2 | **Opening a new note keeps the previous note's scroll position.** `.weave-note` is the scroll container and the body is swapped in place, so note 2 starts scrolled. This is a *usability* bug, not an animation. | `Note.tsx`, `theme.ts` | Key the scroll region by note slug (`key={note.slug}`) so a fresh container resets to the top. No scroll-API effect needed. |
| T0.3 | **The documented breakpoint column-toggle doesn't exist.** UX review: `toggleColumn`/`revealed` model code sits dead in `layout.model.ts` while the help/docs imply the affordance works. Ship the wiring or delete the dead model code — a documented-but-absent feature is the worst of both. | `layout.model.ts`, docs | Delete the dead code (preferred — honest) until a column toggle is actually wanted. |
| T0.4 | **First paint of a big, never-laid-out graph blocks the tab ~0.4–0.8 s.** Measured: `computeLayout` at `LAYOUT_TICKS=300, pinWarm:true` = 767 ms at 244 nodes/251 edges; `column.model.ts:84` claims "tens of milliseconds" — stale by an order of magnitude. | `positions.ts:77`, `layout.ts:557-573`, `column.model.ts:84` | One-line change first: `forceCollide(...).iterations(3)` → `1` (measured ~45 % faster, deterministic-jiggle gate unaffected). Then correct the stale budget claim. Only if the §8 non-degeneracy gate shows a gap, consider dropping `LAYOUT_TICKS`. |
| T0.5 | **`dark --weave-bad` fails contrast.** The a11y review's C1 candidate set: dark `#e37e8d` → `#eb93a1`. | `theme.ts`, `graph.model.ts` | Swap the token; re-verify the `GRAPH_PALETTE` mirror gate and the documented ratios. |
| T0.6 | **`⌘2`/`⌘3` column focus silently no-ops below the 1100 px breakpoint.** Documented for focusability, absent from the help sheet's caveat. | `keys.model.ts` help row | Either make the help honest ("when visible") or focus the next existing column. Minimal: annotate the combo. |

## 2. Tier 1 — cheap, high-leverage performance

All measured; none of these change behaviour, they remove waste.

- **T1.1 — Memoize `graphColumnModel`** in `Graph.tsx` (`useMemo` over
  `[graph, selectedId, view, storage, scheme]`). Today it re-runs per keystroke
  (Shell re-renders on every editor keystroke and `Graph` is un-memoized below
  it), re-doing `localStorage.getItem` + `JSON.parse` of the whole position map
  + the full reduce. This also makes `model.highlight` / `model.key`
  referentially stable, which **T1.2** then fixes for free.
- **T1.2 — The highlight effect repaints the whole graph per render.**
  `[model.highlight]` never compares equal because the effect receives a fresh
  `Set` each time; `setHighlight` → `applyReducers` → `setSetting` schedules a
  full sigma re-draw. Result: *typing in the note textarea repaints the WebGL
  graph*. Fix falls out of T1.1 — do **not** add set-content comparison; the
  memo gets identity for free.
- **T1.3 — Note view rebuilds markdown + sanitise + wiki index per render.**
  One `useMemo(() => renderNote(...), [note.body, note.slug])` (index memoized
  on `[graph, note.slug]`). Modest (~1–2 ms per render) but nearly free. Keep
  the `markdownRenderer(index)`-per-render closure *design* — it is deliberate;
  memoize the result, don't hoist the instance.

## 3. Tier 2 — motion: from snapping to calm

The stylesheet ships exactly one `transition` (the reduced-motion kill switch),
so every hover and overlay currently pops. Motion should land as CSS only —
no animation library, nothing outside the declared keyframes (which is what
keeps `prefers-reduced-motion` sufficient by construction):

- **T2.1 — One grouped transition rule** for the interactive set
  (`.weave-row`, `.weave-ctx-link`, `.weave-chip`, `.weave-search`,
  `.weave-refresh`, `.weave-divider`, `.weave-hit`, note toolbar buttons):
  `background-color/border-color/color 120ms ease`. Compositor-safe properties
  only — never `padding`/`height`. The existing kill-switch rule neutralises
  the whole group automatically because it lives in one declaration.
- **T2.2 — Entrance-only overlay animation.** `.weave-scrim` fade 140 ms;
  `.weave-palette`/`.weave-help` 160 ms fade + 4 px rise. Deliberately *no
  exit* animation: overlays unmount synchronously and delay-unmount plumbing
  is far past "polish".
- **T2.3 — Give the editor prompt the `weave-row-new` vocabulary** (an
  `opacity`/`translateY(-2px)` entrance reusing the existing
  class+keyframe pattern, killed by reduced-motion). It is a `role="alert"`
  that appears exactly once per conflict — no strobing risk. Do **not** apply
  the same flash to context-rail rows (they rest wholesale on every selection);
  the selected row's existing `.weave-row-on` state is enough.
- **T2.4 — `weave-row-new`'s `font-weight` interpolation reflows text every
  frame.** If the flash reads as shimmering, keyframe the weight as a discrete
  40 % snap and interpolate only the background colour.

## 4. Tier 3 — accessibility follow-through

The a11y review found real strengths to preserve — the tree's flat-tree ARIA,
the keymap's refusal philosophy, provenance glyphs — and these to fix:

- **T3.1 — C1 faint contrast.** With T0.5's `bad` swap, also consider dark
  `--weave-faint` → `#9d92c2` / light `#7f6455` (both pass AA at their roles)
  and remapping `.weave-row-on` children off `faint` so the *selected* row
  never contradicts itself.
- **T3.2 — FocusTrap single-focusable fix** in the overlays, plus
  `tabindex="-1"` targets for the `⌘2`/`⌘3` column-focus commands (today the
  command reports success but the browser's focus target is the section, no
  focusable content inside).
- **T3.3 — Tree filter typing guard**: filter state is claimed while the user
  types in the note editor in some edge paths; add the `typing` guard case the
  other bare keys already have.
- **T3.4 — Dimmed legend entry never renders** (`LEGEND.dimmed` unused — same
  family as T4.2 below).

## 5. Tier 4 — design-language next pass

The design review's "fix now" items already partly landed (selection accent
bar on `.weave-row-on`, mono numeric voice for `.weave-meta`/`.weave-note-time`,
fixed-width `.weave-kind`/`.weave-prov`, note-body `h1` demotion, the duplicate
`◧` glyph in `Tree.tsx` — track whatever remains):

1. **A named type ramp** — 9.5/10/11/12/13/14 px roles as tokens or a
   documented scale, so size unification like the `.weave-ctx-heading`/`.weave-col-title`
   fix becomes a lookup, not a guess.
2. **A radius scale** — two values (sharp for rails/rows, one soft corner for
   overlays/chips), documented in the sheet's header where the palette ratios
   are.
3. **18 px reading gutter** for the note body's measure.
4. **A dot-grid canvas signature** for the graph stage — the one aesthetic
   risk the design review recommends spending; quiet everywhere else.
5. **Status-bar grammar** — one separator vocabulary across
   `weave-status-cwd/sel/stamp`.
6. **Wikilink vs external link distinction** — same underline discipline,
   different affordance cue before opening.

## 6. Tier 5 — UX polish backlog (P1/P2 from the UX review)

Ordered, smallest first:

1. **Boot-failure state** — graph fetch failure should render a sentence, not
   an empty column.
2. **Missing Discard affordance** on the UNSAVED-changes prompt (conflict/collision/external have one; plain navigation prompt doesn't).
3. **Refresh must always say what happened** — invisible outcomes on stale-note-while-fetching and no-op 304s.
4. **Deep-linking via `location.hash`** (`#note:slug`) — read-only at first.
5. **Stage-click clears selection** — either make the empty stage clickable-with-intent (Escape exists) or stop clearing; today it's an accident.
6. Unused view-model affordances (`nodeTooltip`, `clusterBadge`, `LEGEND.dimmed`) are built and tested but rendered nowhere — render them or delete them.
7. **Relative times never tick** — the shell passes `now={Date.now()}` per render; either add a 60 s re-render tick or stamp absolute times.

## 7. The do-not-touch register

From the perf/motion review — each of these is correct *by construction* and
documented as such. The next reader should meet this list instead of re-litigating:

- **Write frequency is already right**: layout on divider release/nudge only,
  positions written once per new shape, selection on change. Don't add caching.
- **The RAF clock genuinely idles** (`dynamics.awake()` alpha floor; ~3.8 s
  decay after drag release is d3's own recipe). Don't add a timer.
- **`setPositions` uses `sigma.refresh()`; only `setGraph` touches
  `setCustomBBox`** — per-frame settles never rebuild WebGL buffers or reset
  the camera. Don't unify them.
- **Frozen `setCustomBBox`** over sigma's `autoRescale` is the documented
  drag-rescale fix.
- **SSE 304 leaves signals untouched** — an idle workspace performs zero
  renders while the watcher twitches.
- **Graph click on a collapsed cluster selects AND expands** — deliberate, and
  it's why the rail and note stay in sync on one gesture.
- **New motion must be a declared `animation`/`transition` in `THEME_CSS`** —
  not `element.animate`, which the reduced-motion kill switch cannot reach.

Also recorded, deliberately *not* done: lazy-loading `marked` + `dompurify`
(~20 KiB gzip) would need ESM splitting → two output files → an artifact-contract
change across `build-web.mjs`/`page.ts`. The budget holds at 71 % spent; revisit
only if a real editor forces a new dependency in.

---

## Sequencing

1. **One sitting:** T0.1–T0.6 (all small; T0.4's first fix is one line), T1.1–T1.3.
2. **One sitting:** T2.1–T2.3 + T3.1–T3.4 — they touch the same sheet section.
3. **Then** T4/T5 as appetite allows, starting with the type ramp since every
   later touch-up depends on it.

Each tier ends with `npm run check` green and the palette-mirror, class-coverage
and reachability gates still passing — they are the safety net that makes all of
the above cheap.