# weave-view (browser) — superseded

> **This doc has been replaced by [`docs/weave-workspace.md`](./weave-workspace.md).**

The browser viewer was retired from the tree (commit `d6bceae`) and is being rebuilt — not as a graph viewer, but as a **knowledge
workspace** in which the graph is one column alongside notes and context.

What used to live here is preserved where it is still useful:

| Old content | Now in |
| --- | --- |
| Post-mortem of the retired SVG viewer (the vertical-line collapse and its four mechanisms) | `weave-workspace.md` §7.2 |
| "Use pixi.js" recommendation | Reversed with measurements in `weave-workspace.md` §0.1 / §0.2 — **sigma.js v3 + d3-force**, because pixi is a renderer, not a graph library, and would leave every part that actually broke in our hands |
| Dynamics smoke test requirement | `weave-workspace.md` §8 — written before any UI, with adversarial graph fixtures |
| Notes-first workspace direction (the appended GPT input) | `weave-workspace.md` §1 — adopted, but with **one fixed layout** instead of a dockable panel engine |
| Hard constraints (no screenshots, tight CSP, zero runtime deps) | `weave-workspace.md` §5.2, §9, §10 |

Retired code, for reference only — do not restore: `git show cef1177 -- src/pi/viewer/page.ts src/pi/viewer/server.ts`.

The TUI (`src/pi/viewer/tui/`) is alive and unaffected; it becomes `/weave-view tui`.
