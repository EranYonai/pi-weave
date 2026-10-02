import { describe, expect, it, vi } from "vitest";
import { createDraftStore, mayRemoveDrafts } from "../../src/web/client/note/drafts";

import { initialLayout, openDocument, closeTab, splitPane, closePane } from "../../src/web/shared/workspace";

describe("shared note drafts", () => {
  it("ignores no-op edits and exposes only dirty note identities", async () => {
    const drafts = createDraftStore();
    const changed = vi.fn();
    const unsubscribe = drafts.subscribe(changed);
    expect(drafts.get("missing")).toBeNull();
    expect(drafts.isDirty("missing")).toBe(false);
    expect(drafts.dirtySlugs()).toEqual([]);
    await drafts.save("missing", vi.fn(async () => true));

    drafts.open("one", "same");
    drafts.edit("one", "same");
    expect(drafts.isDirty("one")).toBe(false);
    expect(drafts.dirtySlugs()).toEqual([]);
    drafts.discard("missing");
    unsubscribe();
    drafts.discard("one");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shares a draft by slug and reports changes from its opening baseline", () => {
    const drafts = createDraftStore();
    const changed = vi.fn();
    drafts.subscribe(changed);

    drafts.open("one", "original");
    drafts.open("one", "new server body");
    const firstView = drafts.get("one");
    const secondView = drafts.get("one");
    expect(firstView).toBe(secondView);
    expect(drafts.get("one")).toEqual({ body: "original", baseline: "original", saving: false });
    drafts.edit("one", "edited");
    expect(secondView?.body).toBe("edited");
    expect(drafts.isDirty("one")).toBe(true);
    expect(drafts.dirtySlugs()).toEqual(["one"]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("discards after an unchanged successful save, but retains edits typed during it", async () => {
    const drafts = createDraftStore();
    drafts.open("saved", "original");
    drafts.edit("saved", "sent");
    await drafts.save("saved", async (_slug, body) => body === "sent");
    expect(drafts.get("saved")).toBeNull();

    let resolveSave!: (ok: boolean) => void;
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    drafts.open("one", "original");
    drafts.edit("one", "sent");

    const saving = drafts.save("one", onSave);
    expect(drafts.get("one")?.saving).toBe(true);
    await drafts.save("one", onSave);
    expect(onSave).toHaveBeenCalledTimes(1);
    drafts.edit("one", "typed while saving");
    resolveSave(true);
    await saving;

    expect(drafts.get("one")).toEqual({ body: "typed while saving", baseline: "sent", saving: false });
    expect(drafts.isDirty("one")).toBe(true);

    let resolveSecond!: (ok: boolean) => void;
    drafts.open("two", "original");
    drafts.edit("two", "sent");
    const secondSave = drafts.save("two", () => new Promise<boolean>((resolve) => { resolveSecond = resolve; }));
    drafts.edit("two", "original");
    resolveSecond(true);
    await secondSave;
    expect(drafts.get("two")).toEqual({ body: "original", baseline: "sent", saving: false });
    expect(drafts.isDirty("two")).toBe(true);
  });

  it("keeps failed saves and rejects stale completions after discard and reopen", async () => {
    const drafts = createDraftStore();
    drafts.open("one", "original");
    drafts.edit("one", "failed save");
    await drafts.save("one", async () => false);
    expect(drafts.get("one")?.body).toBe("failed save");
    expect(drafts.get("one")?.saving).toBe(false);

    let resolveSave!: (ok: boolean) => void;
    const saving = drafts.save("one", () => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    drafts.discard("one");
    drafts.open("one", "replacement");
    resolveSave(true);
    await saving;
    expect(drafts.get("one")).toEqual({ body: "replacement", baseline: "replacement", saving: false });
  });
});

describe("dirty view removal", () => {
  it("keeps one shared draft while another tab/pane still selects the note", () => {
    const drafts = createDraftStore();
    drafts.open("one", "original"); drafts.edit("one", "edited");
    const one = openDocument(initialLayout(), "note:one");
    const two = splitPane(one, "right");
    const confirm = vi.fn(() => false);
    const merged = closePane(two, two.activePane);
    expect(mayRemoveDrafts(drafts, two, merged, confirm)).toBe(true);
    expect(mayRemoveDrafts(drafts, merged, closeTab(merged, merged.activePane, "tab-1"), confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(drafts.get("one")?.body).toBe("edited");
  });

  it("cancels final-view close/replacement without discarding, and only clears an accepted removal", () => {
    const drafts = createDraftStore();
    drafts.open("one", "original"); drafts.edit("one", "edited");
    drafts.open("other", "baseline"); drafts.edit("other", "still open");
    const current = openDocument(openDocument(initialLayout(), "note:one"), "note:other", { newTab: true });
    const next = closeTab(current, current.activePane, "tab-1");
    const no = vi.fn(() => false);
    expect(mayRemoveDrafts(drafts, current, next, no)).toBe(false);
    expect(no).toHaveBeenCalledTimes(1);
    expect(drafts.get("one")?.body).toBe("edited");
    const replace = openDocument({ ...current, panes: current.panes.map(pane => ({ ...pane, activeTab: "tab-1" })) }, "note:replacement");
    expect(mayRemoveDrafts(drafts, current, replace, no)).toBe(false);
    expect(mayRemoveDrafts(drafts, current, next, () => true)).toBe(true);
    expect(drafts.get("one")).toBeNull();
    expect(drafts.get("other")?.body).toBe("still open");
  });
});
