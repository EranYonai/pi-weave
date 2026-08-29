/**
 * Deep links: the selection, addressable (weave-workspace UX backlog T5.4).
 *
 * `#note/<slug>` in the location bar is the current selection, both ways:
 * a `location.hash` naming a real node at boot takes priority over the saved
 * *last note* (the link is an explicit instruction, storage is a habit), and
 * every selection change is written back with `history.replaceState` — a
 * shared URL must mean the note on screen, but reading three notes must not
 * put three entries in the back button's history.
 *
 * Two facts decide the shape. First, only *note* nodes deep-link: a
 * repository or file node has no URL-worthy permanence (its id is derived
 * from paths that move), and the note fetch behind a selection 404s for
 * anything else. Second, a hash naming a node that is *not in the graph*
 * must refuse rather than select: a stale link pointing at a deleted note
 * would otherwise land the reader on "Nothing open" with the saved note
 * passed over — parsing without validation would make every dead link hide
 * the workspace's own continuity.

 * Everything here is a pure function over strings and payloads (§10); the
 * `history.replaceState` call itself is the shell's, because it is an effect.
 */

import type { GraphPayload } from "../../shared/wire";

/**
 * The note node a hash names, or `null`.
 *
 * Accepts the two spellings a user might paste — `#note/<slug>` and the
 * node id it encodes (`#note:<slug>` is what the tree's own rows use) — and
 * rejects everything else, including the bare `#` a reader gets from
 * clearing the hash by hand. An empty slug would produce a request for
 * `/api/note/`, which means nothing to anyone.
 */
export function hashSelection(hash: string): string | null {
  if (hash === "" || hash === "#") return null;
  const body = hash.slice(1);
  const match = /^note[/:](.+)$/.exec(body);
  return match === null ? null : `note:${match[1]}`;
}

/**
 * The boot selection: a hash that names a node the payload actually holds,
 * or `null`. Validation is *the* point — see the module header.
 */
export function deeplinkSelection(hash: string, payload: GraphPayload | null): string | null {
  const wanted = hashSelection(hash);
  if (wanted === null || payload === null) return null;
  return payload.model.nodes.some((node) => node.id === wanted) ? wanted : null;
}

/**
 * The URL fragment for a selection: `#note/<slug>`, or `""` for a cleared
 * selection (an empty string hands `replaceState` the bare URL, clearing the
 * hash). A non-note id formats to `""` too — the address bar describes the
 * *note* being read, nothing else.
 */
export function formatHash(selectedId: string | null): string {
  const slug = selectedId === null ? null : selectedId.startsWith("note:") ? selectedId.slice("note:".length) : null;
  return slug === null || slug === "" ? "" : `#note/${slug}`;
}