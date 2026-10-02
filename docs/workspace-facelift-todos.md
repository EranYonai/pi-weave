# Browser workspace facelift — implementation

Branch: `codex/weave-workspace-facelift`. Browser first; dedicated macOS hosting follows a user browser pass.

## Design contract

- Note-first workspace: quiet header, persistent notes sidebar, document tab strip, optional context sidebar.
- One or two pane groups, split right/down with an adjustable divider; closing a pane moves tabs to the remaining pane.
- Each document tab owns navigation history and reading position; one shared draft per note identity.
- One Graph tab and renderer per workspace. Change its hosting and selection routing only; preserve physics and drawing.
- Shared web UI in browser and eventual desktop. Keep unified search, explicit Edit/Save, provenance, and existing file APIs.
- Restore bounded presentation snapshots by vault/repository, independent of the random server port.
- Native hosting is Stage B, after the browser experience is validated; no native dependencies now.

## Todos and owners

- [x] Inspect current main and isolate an implementation worktree.
- [x] Define the layout and bounded pane model.
- [x] Luna / tabs: pure tab/pane/history/snapshot model and regression tests.
- [x] Luna / drafts: shared draft state, Note integration, safe save races, regression tests.
- [x] Luna / persistence: authenticated bounded workspace snapshot endpoint and filesystem storage, regression tests.
- [x] Main: integrate shell, pane document loading, graph hosting, search routing, keyboard/accessibility, visual styling.
- [x] Main: validate restored state, scroll continuity, splits, shared drafts, and navigation in the browser.
- [ ] User pass: cancel/accept native discard/reload dialogs, missing-note recovery, and external-edit workflows.
- [x] Main: rebuild browser bundle and pass `npm run check` without reducing coverage.
- [x] Main: browser smoke against a disposable vault, screenshots, user handoff.
- [x] Main: review diff, update docs, commit/push branch and open draft PR.
- [x] Luna / tabs: independent self-review; fix and regression-test the confirmed stale clean-draft finding.
- [x] Sol 6.1: independent self-review and re-review; correct data-safety and navigation findings.
- [x] Main: second reference-app pass and control-by-control user-flow review in `workspace-usability-review.md`.

## Verification

Unit checks cover history, tab/pane moves, draft/save races, persisted input validation, and isolation. Browser checks cover note-to-note and note-to-graph reading workflows, draft retention, narrow screens, sidebar controls, and refresh. No testing uses the real vault.

## Results

- `npm run check`: typechecks, committed bundle check, and 2,138 tests pass (76 files).
- Coverage: 98.90% statements/lines, 95.35% branches, 98.83% functions; thresholds unchanged.
- Bundle: 404.7 KiB raw, 122.5 KiB gzip (150 KiB gzip budget); no dependency changes.
- Disposable-vault browser checks at 1280×800 and 700×720: tab/new-tab search, wiki-link history,
  shared drafts across two views, save refresh, graph/note split, pane merge, sidebars, keyboard
  focus, narrow-pane switching, and scroll restoration. A 1440-pixel reading position survived tab
  switching, pane switching, and reload. No browser console errors were recorded.
- Server integration test restarts on a fresh port and restores the same workspace; simultaneous
  views keep separate snapshot files. Input bounds, malformed snapshots, and write failures are tested.
- Failed document requests retry independently of graph cache hits; stale completions and cancelled retry timers are regression-tested.
- Draft cancellation/accepted discard are regression-tested through the same guard the shell calls.
  The in-app browser stalled on its native confirmation during the live final-tab-close check;
  cancellation and reload prompts remain a manual user check.
- Independent Luna review found stale clean edit-mode drafts surviving final-view removal. The
  shared guard now clears those drafts without prompting, while preserving drafts in another view;
  two regression tests failed before the fix and pass afterward.
- Sol 6.1 review corrected background/affected draft guards, duplicate-view checkbox writes,
  last-active document routing, keyboard focus, narrow tree browsing, context-link modifiers,
  and recent visits. Live checks additionally covered menu Escape/outside-click dismissal,
  active-tab visibility, synchronized task/editor bodies, external restores, and a fresh-port
  layout reload. File actions now have a visible trigger and their own menu keyboard handling;
  live checks verified focus, arrow navigation, Escape, new-folder cancellation, and Rename
  of filtered-out and collapsed-folder notes.
  Sol re-reviewed the fixes with no remaining confirmed blockers.
- Recent stays stable while browsing and refreshes on reentry. Live checks verified note,
  folder, and HTML-file icons, selection, tooltips, sidebar reopening, and narrow widths.
- Graph drawing, layout physics, position caching, core knowledge code, and package dependencies
  are unchanged; node-click routing now separates preview from opening. Dedicated macOS hosting remains Stage B after browser review.

- Graph preview checks: first-click title/type, second-click and fast double-click, explicit Open,
  split/single-pane destinations, Escape/Clear, return-to-Graph reset, and drag without opening.
  Preview controls remain visible at 700×720 with the notes sidebar open. Sol 6.1 reviewed
  and re-reviewed the drag safeguard with no further actionable findings.
