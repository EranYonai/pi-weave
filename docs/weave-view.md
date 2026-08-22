# weave-view — Local Web Viewer Spec

The human surface of pi-weave: a zero-dependency local web page that renders
the knowledge space — vault + repository — as an interactive graph (design
§11, §19). Reads `.okf` and the vault live from disk on every request; the
viewer stores nothing itself.

> Status: **M1–M3 implemented** (skeleton, wiki-links, staleness badge,
> calm pre-simulated layout, zoom/pan, markdown side panel, refresh +
> identical-JSON polling). M4 (`mentions` edges, symbols, session scope)
> remains future work. The page script and physics live behind the
> `src/pi/viewer/page.ts` seam.

## 1. Product shape

- **`/weave-view` command** in pi starts (or reuses) a loopback HTTP server
  and opens the page in the user's browser.
- **First paint** shows exactly two root nodes — 🟣 *Vault* and 🔵
  *Repository* — plus a 🟡 git anchor when the cwd repo is indexed.
  Progressive disclosure (design §9): nothing expands until clicked.
- **Every node carries provenance styling** (design §13): human-authored =
  solid, agent-authored = dashed border, generated = dimmed. Trust is visible
  at a glance, not buried in metadata.

The viewer is *read-only* in v1. Editing knowledge happens through pi or by
opening the Markdown/JSON files directly (humans-and-agents-alike on disk).

## 2. Architecture

```
src/core/graph/        ← portable, NO harness imports (design §21)
  model.ts             node/edge types + kinds + provenance
  build.ts             pure: (RepoIndex|null, StalenessReport, Note[]) → GraphModel
  wikilinks.ts         [[slug]] extraction from note bodies

src/pi/viewer/
  server.ts            node:http lifecycle (lazy start, idempotent stop)
  page.ts              the HTML/CSS/JS page as an exported template string
                       (no build step, no CDN, no assets dir)

src/pi/index.ts        + registerCommand("weave-view", ...)
```

Request flow:

```
browser ──GET /─────────────► server.ts ──► page.ts (static HTML)
browser ──GET /graph.json───► server.ts ──► core/graph/build.ts
                                              │  reads disk NOW:
                                              │  readRepoIndex + assessStaleness
                                              │  + listNotes/getNote
                                              ▼
                                           GraphModel JSON
```

No caching layer, no watch mode, no build artifacts: `/graph.json` is
rebuilt from disk per request, so the page is trivially fresh and the whole
viewer obeys the "derived, disposable" philosophy (design §4).

## 3. Graph model

Nodes (kinds map to design §11's legend):

| Kind   | Source data | Notes |
| ------ | ----------- | ----- |
| 🟣 `vault` root | `getWorkspaceStatus().vault` | always present |
| 🟣 `note` | `listNotes` + `getNote` (body for links) | `title`, `tags`, `source`, `updated` in detail panel; **provenance from `NoteMeta.source`** |
| 🔵 `repository` | `readRepoIndex` | absent when cwd isn't a git repo (viewer still shows vault) |
| 🟢 `module` / `package` / `entryPoint` | `structure.json` | containment tree, depth ≤ 2 by default |
| 🟡 `gitState` | `index.git` | label `branch @ shortSha` |
| 🟠 `external` | `identity.remotes` | one node per git remote |

Edges:

| Kind | Meaning |
| --- | --- |
| `contains` | vault→note, repository→module/package/entryPoint |
| `anchored-at` | repository→gitState |
| `links-to` | note→note, from `[[wiki-links]]` in bodies (v1) |
| `mentions` | note→module path mention heuristic — **v1.1, opt-in**, styled `generated` because it's inferred |

`[[slug]]` wiki-links are the v1 cross-scope mechanism: Obsidian-compatible,
so the same vault renders meaningfully in both tools. Tag-overlap edges are
explicitly *not* inferred in v1 — they produce hairballs.

```ts
interface GraphNode {
  id: string;                 // stable: "note:<slug>", "module:<path>", ...
  kind: "vault" | "note" | "repository" | "module" | "package"
      | "entryPoint" | "gitState" | "external";
  label: string;
  provenance: NoteSource | null;  // null for structural nodes
  detail: Record<string, string>; // side-panel payload (pre-formatted)
}

interface GraphEdge { source: string; target: string; kind: EdgeKind }

interface GraphModel {
  generatedAt: string;          // ISO; page uses it for staleness polling
  staleness: StalenessReport | null;  // repo freshness banner input
  nodes: GraphNode[];
  edges: GraphEdge[];
}
```

Stability requirement: ids derive only from file paths/slugs, never from
timestamps — two consecutive builds of unchanged inputs must produce
identical JSON (makes refresh-polling cheap and L1 tests snapshot-able).

## 4. Server

- `node:http`, **bind `127.0.0.1` only**, port `0` (OS-assigned) unless
  `PI_WEAVE_VIEW_PORT` is set. Report the resolved URL via `ctx.ui.notify`.
- Routes: `GET /` → HTML page; `GET /graph.json` → fresh `GraphModel`;
  `GET /note/<slug>` → one note's body live from disk (side-panel render;
  traversal-proof via `resolveNotePath`); everything else → 404.
  **No POST/PUT in v1.**

  > Amendment: the spec's CSP blocked inline script and would brick the page.
  > Shipped CSP is `default-src 'self'; style-src 'unsafe-inline';
  > script-src 'unsafe-inline'` — same audit surface (zero external
  > resources), inline JS allowed.
- Response headers: `Content-Security-Policy: default-src 'self'; style-src
  'unsafe-inline'` (page JS is inline by design — nothing external to allow).
- Lifecycle obeys the extension rules:
  - **never** start from the extension factory — lazy start on the first
    `/weave-view` invocation (session-scoped);
  - one server per session; repeat `/weave-view` reopens the browser tab
    against the same URL;
  - `session_shutdown` closes it; the close handler must be idempotent
    (fires on `/reload`, `/new`, quit).
- Browser open via `pi.exec`: `open` (macOS) / `xdg-open` (Linux) / `start`
  (Windows). **Guarded by `ctx.hasUI` and `ctx.mode === "tui"`**; in rpc /
  print / json modes the command just returns the URL in its output.
  `PI_WEAVE_VIEW_NO_OPEN=1` suppresses opening (CI, headless, eval harness).

## 5. The page

Single HTML string, inline CSS+JS, **no external resources** — works offline,
nothing to audit.

- Hand-rolled force layout on SVG — **pre-simulated 140 ticks before the
  first paint** (calm first view), capped velocities, per-edge-kind rest
  lengths, gentle reheats on expand. Nodes ≤ ~2k by construction
  (containment capped): no hairball, no vendored lib needed yet; one goes
  behind the `page.ts` seam if ever required.
- Obsidian-style navigation: **scroll = zoom to cursor, drag background =
  pan, drag node = reposition**, `+`/`−`/`⌂` buttons, click container node →
  expand/collapse (`▾`/`▸`), click background or `Esc` → dismiss panel.
- Side panel renders knowledge, not metadata dumps: notes fetch their full
  body live (`/note/<slug>`) and render through the page's inline mini
  markdown renderer (headings, lists, quotes, code fences, `[[wiki-links]]`,
  https links; HTML-escaped first, `javascript:` URLs refused); tags as
  chips, provenance badge.
- **search box** → substring filter dims non-matching nodes;
  legend mapping colors/shapes to kinds + provenance styling.
- Staleness UX: when `staleness.state === "stale"`, the 🔵 repository node
  gets a badge and the page header shows the first reason with a hint to run
  `/weave-scan` (viewer never mutates; it *points back to pi*).
- Freshness: a Refresh button; optional 5s polling that re-fetches
  `/graph.json` and no-ops on identical JSON. No websockets.

## 6. Config surface (keep tiny)

| Env var | Default | Effect |
| --- | --- | --- |
| `PI_WEAVE_VIEW_PORT` | `0` (auto) | pin a port |
| `PI_WEAVE_VIEW_NO_OPEN` | unset | don't auto-open browser |
| `PI_WEAVE_VIEW_MENTIONS` | unset/off | enable v1.1 `mentions` edges |

## 7. Testing (per docs/testing.md)

- **L1** — `buildGraph` over hand-written `RepoIndex`/`Note[]` fixtures:
  node/edge shapes, id stability ("same inputs ⇒ identical JSON"),
  provenance mapping, wiki-link parsing (duplicates, dangling links,
  `[[slug]]` vs `[[slug|alias]]`), containment depth cap, empty-vault and
  no-repo models.
- **L2** — server against temp vault + fixture repo: `/` returns 200 HTML
  with CSP header; `/graph.json` matches `buildGraph` output; double-`stop()`
  doesn't throw; two servers get distinct ports; 404 for unknown routes.
- **L3** — via the mocked `ExtensionAPI` (`tests/pi`): command name
  `weave-view` registered; no browser `exec` when `ctx.hasUI === false`;
  `session_shutdown` closes the port (connect → ECONNREFUSED); repeat
  invocation reuses the same port.
- **L4 manual checklist** — colors/legend correct; expand/collapse smooth;
  stale badge appears after `touch`ing a tracked file; the same vault opened
  in Obsidian shows the same wiki-links; print mode prints a URL and exits.

## 8. Non-goals (v1)

- Editing or deleting knowledge from the browser.
- Level-2 semantic nodes (classes/functions) — needs the repository analyzer
  (design §9 L2); the model has room (`kind: "symbol"`) reserved.
- Server push (websockets/SSE), auth, multi-user, remote access.
- Session-knowledge scope (design §17's third pillar) — the model leaves
  room; nothing in v1 reads session state.
- Mobile layout, theming beyond the fixed palette.

## 9. Milestones

| Milestone | Contents | Exit check |
| --- | --- | --- |
| **M1 — skeleton** | model + build.ts, server, static page, `/weave-view`, expand/collapse, L1–L3 tests | UC-style: `/weave-view` opens browser, two roots expand |
| **M2 — links** | wiki-link edges + parsing, search filter, staleness badge, side panel | note→note edges visible; stale badge demo |
| **M3 — liveness** | hash-no-op polling, note count > 500 guard + warning | edit a vault file → page reflects it ≤ 5s |
| **M4 — deeper scopes** | `mentions` edges (opt-in), symbols when the analyzer lands, session scope | gated behind analyzer milestone |

Size estimate: ~300 LOC core graph, ~400 LOC viewer (mostly the page),
~500 LOC tests. **No new `dependencies`.** The `files` whitelist in
`package.json` already covers `src/`.

## 10. Open questions

1. Opening `~/.okf` vault notes from the viewer for editing — link to
   `obsidian://open?vault=...` when Obsidian is installed, or stay out of it?
2. Should `weave_view` also exist as an LLM-callable tool ("show me the
   graph" → pi opens it)? Cheap to add post-M1; needs a mode-aware
   `terminate: true` result.
3. Embedding a read-only graph *snapshot* export (single self-contained HTML
   file for sharing) — trivial once M1 exists; in or out for v1?
