/**
 * BodyStore — shared note/.okf body cache (weave-view-tui-v2 §6, §9.1).
 *
 * The v1 WeaveExplorer cached bodies in private maps. v2 lifts that cache into
 * a per-session store so every pane (e.g. two Detail panes reading the same
 * note) shares one fetch per node id. Behavior is identical to v1's
 * per-explorer cache: a body load is kicked off once per id, in-flight loads
 * are deduped, and a refresh busts the cache so the next read re-fetches.
 *
 * The store is harness-free (takes injected loaders + an optional
 * onChange callback), so it is unit-tested with fake loaders exactly like
 * v1's body tests.
 */

import type { ViewNote } from "../../../core/graph/current";

/** The body loaders a BodyStore is bound to (bound to vault/cwd by run.ts). */
export interface BodyLoaders {
  loadNote: (slug: string) => Promise<ViewNote | null>;
  loadOkf: (rel: string) => Promise<{ path: string; body: string } | null>;
}

export interface BodyStoreOptions {
  loaders: BodyLoaders;
  /** Invoked (no args) when an async load resolves so the owner can re-render. */
  onChange?: () => void;
}

/**
 * A cache+dedup keyed by node id. `get` never throws and never double-loads.
 *
 * - `null` body = the node exists but has no loadable body (or it loaded to
 *   null); the pane renders nothing for it.
 * - `undefined` = not yet requested (the pane shows a placeholder and asks the
 *   store to load, mirroring v1's `bodyLinesFor`).
 * - `isLoading(id)` = an in-flight request is outstanding (pane shows "loading").
 */
export class BodyStore {
  private readonly loaders: BodyLoaders;
  private readonly onChange: (() => void) | undefined;
  private cache = new Map<string, string | null>();
  private loading = new Set<string>();

  constructor(opts: BodyStoreOptions) {
    this.loaders = opts.loaders;
    this.onChange = opts.onChange;
  }

  /** True when the id is mid-load. */
  isLoading(id: string): boolean {
    return this.loading.has(id);
  }

  /** Cached body for the id, or undefined when not yet requested. */
  get(id: string): string | null | undefined {
    return this.cache.get(id);
  }

  /** True once a body has been requested for the id (cached or failed). */
  has(id: string): boolean {
    return this.cache.has(id);
  }

  /**
   * Kick off a load for `id` if not already requested/in-flight. Returns true
   * when a load was started (so the caller can show a placeholder). The load
   * uses `kind` (note/file) to pick the loader and `ref` (slug/rel path).
   */
  load(id: string, kind: "note" | "file", ref: string | undefined): boolean {
    if (ref === undefined) return false;
    if (this.cache.has(id) || this.loading.has(id)) return false;
    this.loading.add(id);
    if (kind === "note") {
      void this.loaders
        .loadNote(ref)
        .then((note) => this.finish(id, note?.body ?? null))
        .catch(() => this.finish(id, null));
    } else {
      void this.loaders
        .loadOkf(ref)
        .then((file) => this.finish(id, file?.body ?? null))
        .catch(() => this.finish(id, null));
    }
    return true;
  }

  /** Drop all cached bodies and in-flight markers (the `r` refresh). */
  clear(): void {
    this.cache.clear();
    this.loading.clear();
  }

  private finish(id: string, body: string | null): void {
    this.cache.set(id, body);
    this.loading.delete(id);
    this.onChange?.();
  }
}
