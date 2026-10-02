# Workspace usability review

Date: 2026-10-02–03. Reference: Obsidian 1.13.7, its small `test` / `Welcome` vault.
Implementation: PR #62, browser workspace first; dedicated macOS window follows.

The review asks whether someone can read, compare, edit, and return to their work without
understanding the pane model. It combines a Sol 6.1 source review with a second live pass
through Obsidian and Weave. Weave testing uses a disposable vault, never the real vault.

## What the second Obsidian pass established

- A file click replaces the active pane's document, leaving the other pane alone. The
  tab strip and file list provide stable reference points.
- Split right duplicates the current document into an independent tab group. Clicking
  another file then changes that new group. This makes comparison a two-action flow.
- Quick switching exposes its choices: Enter opens, Cmd+Enter opens a new tab, and
  Cmd+Alt+Enter opens to the right. These hints explain the destination before acting.
- Document options and tab context menus keep infrequent actions out of the reader.
  Splitting, finding text, revealing the file, and opening linked views have distinct uses.
- Open in new window creates a quiet document window with its own tabs and navigation.
  It is useful for a second monitor or a persistent reference, beyond the two-pane flow.
- Outline is a linked view with filtering and section-following controls. The reference
  Welcome document has no Markdown headings, so its empty state correctly says so.
- Graph is a peer reading surface. Back returned from it to the previous document.

The temporary split, outline, and pop-out were closed afterward. No Obsidian note bodies
were edited. This is a small-vault interaction review, not a large-vault performance claim.

## Controls and the user flows they serve

| Surface / control | User's purpose | Assessment and resulting behavior |
| --- | --- | --- |
| Header Search / Cmd+K | Find a remembered idea without knowing its folder | One palette for notes and repository knowledge; remove the redundant search ribbon icon |
| New tab / empty-tab Search | Keep the current document while looking for another | Explicit new context; welcome view gives a useful action instead of a blank surface |
| Files | Browse familiar folders and notes | Keep the list stable; file clicks follow the active pane |
| Tree filter | Narrow the visible file list | A local list filter; it does not introduce another retrieval mode |
| Provenance / knowledge filters | Inspect authorship or reveal repository internals | Secondary controls retain their explanatory tooltips |
| Recent | Return to a document after leaving or closing its tab | Track actual visits in this window, latest first; tab closure no longer erases the list |
| Notes ribbon / sidebar hide | Recover reading space, then restore navigation | Both directions remain explicit; narrow keyboard browsing keeps the sidebar open |
| Document tab | Return to a working context | Preserve its history, scroll, and shared draft; arrow keys navigate the strip |
| Tab close | Finish with one context | Clear clean edit sessions; ask before discarding the final view of a dirty draft |
| Back / forward | Follow a link and return | History belongs to that tab; disabled controls indicate the end of its history |
| Pane options | Compare documents or reorganize the comparison | Split right/down when there is one group; label existing-group arrangement as side by side or stacked |
| Move tab to other pane | Put a reference next to the current work | Move the existing context and draft; do not clone independent editor state |
| Close pane | Return to one reading area | Move its tabs into the remaining pane; tooltip explains that work is retained |
| Divider | Give the more important document more space | Pointer drag and arrow-key resizing; no hidden gesture required |
| Switch pane on narrow windows | Reach the other group when two cannot fit | A visible switch; neither group's tabs are destroyed |
| Graph ribbon / Graph tab | Discover a connection, then inspect its content | One graph renderer; nodes route to the other pane, or the last active document in the same group |
| Context ribbon / links | Find related notes without losing the current one | Normal click navigates; Cmd/Ctrl-click opens a new tab consistently with file and wiki links |
| Edit / Save / Done | Deliberately change a note | Explicit editing, one draft per note, visible save state, and discard protection |
| Task checkbox | Record a small change without opening the editor | Shared body and write protection across duplicate views; visible checkboxes must match that body |
| Open in external editor | Use a familiar editing tool | Retain the existing action and reload behavior; external changes do not silently replace a draft |
| File rename / move / delete | Organize notes | Guard every affected draft, including background tabs and folder descendants; preserve unrelated drafts |
| Theme | Adapt the reading surface | Existing system/light/dark cycle and next-action tooltip |
| Refresh workspace | Retry or fetch external changes immediately | Keep the recovery action; replace implementation-oriented “Refetch everything” wording |
| Help | Discover shortcuts and pane actions | Accessible button; shortcuts describe the actual workspace flows |
| Footer | Identify the workspace and pending work | Keep workspace/draft/restoration status; remove the internal context-bus tooltip |

## Findings fixed in the review

Sol 6.1 found two data-safety issues: file operations protected only the active note and
could discard unrelated drafts; duplicate note views could issue checkbox writes from
different stale bodies. The fixes use affected note identities and shared per-note state.
Note-load generations distinguish old requests from fresh external edits, including a
legitimate external restore to an earlier body. Content equality alone cannot do that.

It also found navigation inconsistencies: focus-note changed tabs, Graph returned to the
last-created rather than last-active document, narrow tree navigation hid its own sidebar,
and context links ignored new-tab modifiers. Recent ordering and retention were corrected.
Active tabs now scroll into view when selection, labels, or pane dimensions change, so a
restored or newly selected document does not leave its tab hidden beyond the strip.

The live pass found another menu bug: Escape in pane options cleared the document to an
empty tab while leaving the menu open. Escape now closes that menu and returns focus to
its trigger. Outside clicks dismiss menus. Focusing a document that is still loading falls
back to its visible panel instead of leaving focus on a hidden Graph surface.

## Important follow-ups

1. **Outline / find within a long document.** The long Research fixture makes repeated
   scrolling costly. An outline in Context would provide direct section navigation.
   This deserves a small, separately designed addition; it does not require graph changes.
2. **Reveal the active file.** A note opened from search or a link can be inside a collapsed
   folder. A visible reveal action is more predictable than forcing folders to expand on
   every navigation. Obsidian offers both reveal and optional automatic reveal.
3. **Capture a new note in the viewer.** Today the agent is the capture entry point and
   browser Edit changes existing notes. Obsidian's New note action makes a different
   promise. Decide that workflow explicitly before adding a button: naming, location,
   human provenance, and empty-note handling all need a coherent path.
4. **Dedicated window.** Native title bar, app switching, menus, focus/reopen behavior,
   and session-ended draft recovery remain the next delivery. Per-note pop-out windows
   would be a further capability; they are not required for the agreed one-window session
   contract. Browser shortcut conflicts should be addressed in the native host.

Pinning, arbitrary pane trees, canvases, bookmarks, plugin settings, and editor-engine
replacement do not solve an observed blocker in these flows. The two-group limit still
covers note comparison and graph-to-note exploration without another workspace system.

## Verification boundaries

Regression tests cover the shared model, affected-draft guard, checkbox writes and load
ordering, remembered document targets, bounded parsing, and recent visit ordering.
Live browser checks cover the revised pane, focus, modifier, menu, and narrow-window flows.
Two live reading panes reflected consecutive task changes and the same Edit baseline; an
external restore to the earlier unchecked text reached both views. Reload on a fresh server
port restored the comparison layout with both active tabs visible and no restoration error.
Native discard/reload confirmation handling remains a manual check where the in-app
browser cannot expose its dialog. Dedicated-window lifecycle is not implemented here.

Sol 6.1 re-reviewed the corrections and found no remaining confirmed blockers. The full
gate passes 2,129 tests in 76 files, with 98.90% statements/lines, 95.32% branches, and
98.82% functions. The browser bundle is 121.3 KiB gzip, below its 150 KiB budget.
