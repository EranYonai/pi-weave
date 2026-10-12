import { joinRawOpening, joinRawTail, splitRawOpening, splitRawTail } from "../../shared/view";
import { tabSelection, type WorkspaceLayout } from "../../shared/workspace";

/**
 * An open editor. `body` is only the part above the `## Raw` tail, and the
 * tail's entries get their own box (`raw`): one textarea holding both used
 * to drop anything typed below the heading on save, without a word.
 */
export interface NoteDraft {
  body: string;
  baseline: string;
  /** The verbatim `## Raw` tail as it was when the editor opened; "" when none. */
  tail: string;
  /** The tail's entries, below its heading and notice, as edited. */
  raw: string;
  rawBaseline: string;
  saving: boolean;
  /** The body and Raw entries as they were when the editor opened: what Discard returns to. */
  original: string;
  originalRaw: string;
  /** When an autosave last landed (epoch ms); null until one has. */
  savedAt: number | null;
  /** The last save attempt failed; cleared by the next one that lands. */
  failed: boolean;
}

/** How a save should treat the `## Raw` tail; `raw` means the person edited it. */
export interface SaveOptions {
  raw?: boolean;
  /** An autosave: the shell reports a failure in the edit bar, not with an alert. */
  quiet?: boolean;
}

/** How a draft save behaves. */
export interface DraftSaveOptions {
  /**
   * Keep the editor open after the write lands (autosave). Without it a save
   * that catches up with the editor closes it, which is what Done does.
   */
  keepOpen?: boolean;
}

export type SaveNote = (slug: string, body: string, options?: SaveOptions) => Promise<boolean>;

interface TaskSource {
  body: string;
  version: number;
  pending?: { body: string; version: number };
  saving: boolean;
}

export interface DraftStore {
  get(slug: string): Readonly<NoteDraft> | null;
  subscribe(listener: () => void): () => void;
  /** Open an editor on a full note body; the `## Raw` tail is split off. */
  open(slug: string, body: string): void;
  edit(slug: string, body: string): void;
  /** Edit the `## Raw` entries. */
  editRaw(slug: string, raw: string): void;
  discard(slug: string): void;
  isDirty(slug: string): boolean;
  dirtySlugs(): string[];
  save(slug: string, onSave: SaveNote, options?: DraftSaveOptions): Promise<void>;
  /**
   * Put the body and Raw entries back to how they were when the editor
   * opened. Returns whether that differs from what is on disk now (an
   * autosave already wrote the edits), in which case the caller saves.
   */
  revert(slug: string): boolean;
  nextLoadVersion(): number;
  getTaskBody(slug: string, fallback: string): string;
  taskBody(slug: string, serverBody: string, loadVersion: number): string;
  isTaskSaving(slug: string): boolean;
  saveTask(slug: string, body: string, onSave: SaveNote): Promise<boolean>;
  clearTaskSources(slugs: readonly string[]): void;
}

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, NoteDraft>();
  const taskSources = new Map<string, TaskSource>();
  const listeners = new Set<() => void>();
  let loadVersion = 0;
  const notify = (): void => listeners.forEach((listener) => listener());
  const dirty = (draft: NoteDraft): boolean => draft.body !== draft.baseline || draft.raw !== draft.rawBaseline;

  return {
    get: (slug) => drafts.get(slug) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(slug, body) {
      if (drafts.has(slug)) return;
      const { head, tail } = splitRawTail(body);
      const { entries } = splitRawOpening(tail);
      drafts.set(slug, { body: head, baseline: head, tail, raw: entries, rawBaseline: entries, saving: false, original: head, originalRaw: entries, savedAt: null, failed: false });
      notify();
    },
    edit(slug, body) {
      const draft = drafts.get(slug);
      if (draft === undefined || draft.body === body) return;
      draft.body = body;
      // New words get a fresh autosave attempt; a failure says so until then.
      draft.failed = false;
      notify();
    },
    editRaw(slug, raw) {
      const draft = drafts.get(slug);
      if (draft === undefined || draft.raw === raw) return;
      draft.raw = raw;
      draft.failed = false;
      notify();
    },
    discard(slug) {
      if (drafts.delete(slug)) notify();
    },
    isDirty(slug) {
      const draft = drafts.get(slug);
      return draft !== undefined && dirty(draft);
    },
    dirtySlugs() {
      return [...drafts].filter(([, draft]) => dirty(draft)).map(([slug]) => slug);
    },
    revert(slug) {
      const draft = drafts.get(slug);
      if (draft === undefined) return false;
      draft.body = draft.original;
      draft.raw = draft.originalRaw;
      notify();
      return dirty(draft);
    },
    async save(slug, onSave, options) {
      const draft = drafts.get(slug);
      if (draft === undefined || draft.saving || taskSources.get(slug)?.saving) return;
      const sent = draft.body;
      const sentRaw = draft.raw;
      // An untouched Raw is sent as it was and kept by the server, so an
      // entry dictated while this editor was open survives the save. An
      // edited one is sent as the person left it, and replaces the tail.
      const rawEdited = sentRaw !== draft.rawBaseline;
      const tail = rawEdited ? joinRawOpening(splitRawOpening(draft.tail).opening, sentRaw) : draft.tail;
      const full = joinRawTail(sent, tail);
      draft.saving = true;
      notify();
      let ok = false;
      try {
        const saveOptions: SaveOptions = { ...(rawEdited ? { raw: true } : {}), ...(options?.keepOpen ? { quiet: true } : {}) };
        ok = await onSave(slug, full, Object.keys(saveOptions).length === 0 ? undefined : saveOptions);
      } finally {
        // Discard/reopen during an in-flight request gives the new draft a new identity.
        if (drafts.get(slug) === draft) {
          const source = taskSources.get(slug);
          if (ok && source !== undefined) {
            source.body = full;
            source.version = ++loadVersion;
            delete source.pending;
          }
          if (ok && !options?.keepOpen && draft.body === sent && draft.raw === sentRaw) drafts.delete(slug);
          else {
            if (ok) {
              draft.baseline = sent;
              draft.rawBaseline = sentRaw;
              draft.tail = tail;
              draft.savedAt = Date.now();
            }
            draft.failed = !ok;
            draft.saving = false;
          }
          notify();
        }
      }
    },
    nextLoadVersion() {
      return ++loadVersion;
    },
    getTaskBody(slug, fallback) {
      return taskSources.get(slug)?.body ?? fallback;
    },
    taskBody(slug, serverBody, version) {
      let source = taskSources.get(slug);
      let changed = false;
      if (source === undefined) {
        source = { body: serverBody, version, saving: false };
        taskSources.set(slug, source);
      } else if (version > source.version) {
        if (source.saving) {
          if (source.pending === undefined || version > source.pending.version) source.pending = { body: serverBody, version };
        } else {
          changed = source.body !== serverBody;
          source.body = serverBody;
          source.version = version;
        }
      }
      if (changed) notify();
      return source.body;
    },
    isTaskSaving: (slug) => taskSources.get(slug)?.saving ?? false,
    async saveTask(slug, body, onSave) {
      const source = taskSources.get(slug);
      if (source === undefined || source.saving || drafts.get(slug)?.saving) return false;
      source.saving = true;
      notify();
      let ok = false;
      try {
        ok = await onSave(slug, body);
        return ok;
      } finally {
        if (taskSources.get(slug) === source) {
          if (ok) {
            source.body = body;
            // Invalidate note loads that began before this save completed.
            source.version = ++loadVersion;
          } else if (source.pending !== undefined && source.pending.version > source.version) {
            source.body = source.pending.body;
            source.version = source.pending.version;
          }
          delete source.pending;
          source.saving = false;
          notify();
        }
      }
    },
    clearTaskSources(slugs) {
      let changed = false;
      for (const slug of slugs) changed = taskSources.delete(slug) || changed;
      if (changed) notify();
    },
  };
}

/** Removing the last selected view of a dirty note requires deliberate discard. */
export function mayRemoveDrafts(drafts: DraftStore, current: WorkspaceLayout, next: WorkspaceLayout, confirm: () => boolean): boolean {
  const before = new Set(current.panes.flatMap((pane) => pane.tabs.map(tabSelection)));
  const after = new Set(next.panes.flatMap((pane) => pane.tabs.map(tabSelection)));
  const removed = [...before].filter((id): id is string => id !== null && id.startsWith("note:") && !after.has(id))
    .map((id) => id.slice(5));
  if (removed.some((slug) => drafts.isDirty(slug)) && !confirm()) return false;
  removed.forEach((slug) => drafts.discard(slug));
  drafts.clearTaskSources(removed);
  return true;
}

/** Confirm only dirty drafts affected by a tree mutation, then clear affected state. */
export function mayMutateDrafts(drafts: DraftStore, affectedSlugs: readonly string[], confirm: () => boolean): boolean {
  const affected = new Set(affectedSlugs);
  const dirty = drafts.dirtySlugs().filter((slug) => affected.has(slug));
  if (dirty.length > 0 && !confirm()) return false;
  affected.forEach((slug) => drafts.discard(slug));
  drafts.clearTaskSources([...affected]);
  return true;
}
