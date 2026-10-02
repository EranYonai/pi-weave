import { tabSelection, type WorkspaceLayout } from "../../shared/workspace";

export interface NoteDraft {
  body: string;
  baseline: string;
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
}

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, NoteDraft>();
  const listeners = new Set<() => void>();
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
      if (draft === undefined || draft.saving) return;
      const sent = draft.body;
      draft.saving = true;
      notify();
      let ok = false;
      try {
        ok = await onSave(slug, sent);
      } finally {
        // Discard/reopen during an in-flight request gives the new draft a new identity.
        if (drafts.get(slug) === draft) {
          if (ok && draft.body === sent) drafts.delete(slug);
          else {
            if (ok) draft.baseline = sent;
            draft.saving = false;
          }
          notify();
        }
      }
    },
  };
}

/** Removing the last selected view of a dirty note requires deliberate discard. */
export function mayRemoveDrafts(drafts: DraftStore, current: WorkspaceLayout, next: WorkspaceLayout, confirm: () => boolean): boolean {
  const before = new Set(current.panes.flatMap((pane) => pane.tabs.map(tabSelection)));
  const after = new Set(next.panes.flatMap((pane) => pane.tabs.map(tabSelection)));
  const removed = drafts.dirtySlugs().filter((slug) => before.has(`note:${slug}`) && !after.has(`note:${slug}`));
  if (removed.length && !confirm()) return false;
  removed.forEach((slug) => drafts.discard(slug));
  return true;
}
