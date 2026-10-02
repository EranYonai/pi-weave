import { tabSelection, type WorkspaceLayout } from "../../shared/workspace";

export interface NoteDraft {
  body: string;
  baseline: string;
  saving: boolean;
}

interface TaskSource {
  body: string;
  version: number;
  pending?: { body: string; version: number };
  saving: boolean;
}

export interface DraftStore {
  get(slug: string): Readonly<NoteDraft> | null;
  subscribe(listener: () => void): () => void;
  open(slug: string, body: string): void;
  edit(slug: string, body: string): void;
  discard(slug: string): void;
  isDirty(slug: string): boolean;
  dirtySlugs(): string[];
  save(slug: string, onSave: (slug: string, body: string) => Promise<boolean>): Promise<void>;
  nextLoadVersion(): number;
  getTaskBody(slug: string, fallback: string): string;
  taskBody(slug: string, serverBody: string, loadVersion: number): string;
  isTaskSaving(slug: string): boolean;
  saveTask(slug: string, body: string, onSave: (slug: string, body: string) => Promise<boolean>): Promise<boolean>;
  clearTaskSources(slugs: readonly string[]): void;
}

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, NoteDraft>();
  const taskSources = new Map<string, TaskSource>();
  const listeners = new Set<() => void>();
  let loadVersion = 0;
  const notify = (): void => listeners.forEach((listener) => listener());

  return {
    get: (slug) => drafts.get(slug) ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open(slug, body) {
      if (drafts.has(slug)) return;
      drafts.set(slug, { body, baseline: body, saving: false });
      notify();
    },
    edit(slug, body) {
      const draft = drafts.get(slug);
      if (draft === undefined || draft.body === body) return;
      draft.body = body;
      notify();
    },
    discard(slug) {
      if (drafts.delete(slug)) notify();
    },
    isDirty(slug) {
      const draft = drafts.get(slug);
      return draft !== undefined && draft.body !== draft.baseline;
    },
    dirtySlugs() {
      return [...drafts].filter(([, draft]) => draft.body !== draft.baseline).map(([slug]) => slug);
    },
    async save(slug, onSave) {
      const draft = drafts.get(slug);
      if (draft === undefined || draft.saving || taskSources.get(slug)?.saving) return;
      const sent = draft.body;
      draft.saving = true;
      notify();
      let ok = false;
      try {
        ok = await onSave(slug, sent);
      } finally {
        // Discard/reopen during an in-flight request gives the new draft a new identity.
        if (drafts.get(slug) === draft) {
          const source = taskSources.get(slug);
          if (ok && source !== undefined) {
            source.body = sent;
            source.version = ++loadVersion;
            delete source.pending;
          }
          if (ok && draft.body === sent) drafts.delete(slug);
          else {
            if (ok) draft.baseline = sent;
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
