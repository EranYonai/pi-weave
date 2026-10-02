import { describe, expect, it, vi } from "vitest";
import { createDraftStore, mayMutateDrafts, mayRemoveDrafts } from "../../src/web/client/note/drafts";
import { toggleTaskCheckbox } from "../../src/web/client/note/note.model";

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

describe("clean edit-mode draft removal", () => {
  it("releases a clean draft on final-view close so reopening starts with the current body", () => {
    const drafts = createDraftStore();
    drafts.open("one", "original");
    const current = openDocument(initialLayout(), "note:one");
    const next = closeTab(current, current.activePane, "tab-1");
    const confirm = vi.fn(() => false);
    expect(mayRemoveDrafts(drafts, current, next, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(drafts.get("one")).toBeNull();
    drafts.open("one", "changed externally");
    expect(drafts.get("one")?.body).toBe("changed externally");
  });

  it("preserves clean edit mode in another view, but clears it when its final view is replaced", () => {
    const drafts = createDraftStore();
    drafts.open("one", "original");
    const one = openDocument(initialLayout(), "note:one");
    const two = splitPane(one, "right");
    const remaining = closeTab(two, two.activePane, two.panes[1]!.activeTab);
    const confirm = vi.fn(() => false);
    expect(mayRemoveDrafts(drafts, two, remaining, confirm)).toBe(true);
    expect(drafts.get("one")?.body).toBe("original");
    const replacement = openDocument(remaining, "note:replacement", { paneId: "pane-1" });
    expect(mayRemoveDrafts(drafts, remaining, replacement, confirm)).toBe(true);
    expect(drafts.get("one")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("shared task checkbox writes", () => {
  it("blocks competing pane writes and uses the successful body before refresh", async () => {
    const drafts = createDraftStore();
    const original = "- [ ] first\n- [ ] second\n";
    const view1 = drafts.nextLoadVersion();
    const view2 = drafts.nextLoadVersion();
    const firstBody = toggleTaskCheckbox(drafts.taskBody("one", original, view1), 0)!;
    expect(drafts.getTaskBody("one", "fallback")).toBe(original);
    let resolveFirst!: (ok: boolean) => void;
    const saveFirst = vi.fn(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }));
    const first = drafts.saveTask("one", firstBody, saveFirst);

    expect(drafts.isTaskSaving("one")).toBe(true);
    const secondFromOtherPane = toggleTaskCheckbox(drafts.taskBody("one", original, view2), 1)!;
    const saveSecond = vi.fn(async () => true);
    expect(await drafts.saveTask("one", secondFromOtherPane, saveSecond)).toBe(false);
    expect(saveFirst).toHaveBeenCalledTimes(1);
    expect(saveSecond).not.toHaveBeenCalled();

    resolveFirst(true);
    expect(await first).toBe(true);
    expect(drafts.isTaskSaving("one")).toBe(false);
    expect(drafts.taskBody("one", original, view2)).toBe(firstBody);
    expect(drafts.getTaskBody("one", original)).toBe(firstBody);

    const secondBody = toggleTaskCheckbox(drafts.taskBody("one", original, view2), 1)!;
    expect(await drafts.saveTask("one", secondBody, async () => true)).toBe(true);
    expect(drafts.taskBody("one", original, view2)).toBe(secondBody);
    expect(secondBody).toBe("- [x] first\n- [x] second\n");
    expect(drafts.taskBody("one", secondBody, view2)).toBe(secondBody);
    const external = "- [ ] first\n- [ ] second\n- [ ] external\n";
    expect(drafts.taskBody("one", external, drafts.nextLoadVersion())).toBe(external);
    expect(drafts.taskBody("one", original, view1)).toBe(external);
  });

  it("keeps failed writes unchanged and ignores completions after source cleanup", async () => {
    const drafts = createDraftStore();
    const original = "- [ ] first\n";
    const firstLoad = drafts.nextLoadVersion();
    const checked = toggleTaskCheckbox(drafts.taskBody("one", original, firstLoad), 0)!;
    expect(await drafts.saveTask("one", checked, async () => false)).toBe(false);
    expect(drafts.taskBody("one", original, firstLoad)).toBe(original);
    expect(await drafts.saveTask("missing", checked, async () => true)).toBe(false);

    let resolveSave!: (ok: boolean) => void;
    const saving = drafts.saveTask("one", checked, () => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    drafts.clearTaskSources(["one"]);
    expect(drafts.isTaskSaving("one")).toBe(false);
    const replacementLoad = drafts.nextLoadVersion();
    drafts.taskBody("one", "replacement", replacementLoad);
    resolveSave(true);
    expect(await saving).toBe(true);
    expect(drafts.taskBody("one", "replacement", replacementLoad)).toBe("replacement");
  });

  it("rejects delayed loads, but accepts a fresh external restore of an older body", async () => {
    const drafts = createDraftStore();
    const oldLoad = drafts.nextLoadVersion();
    const newLoad = drafts.nextLoadVersion();
    const original = "- [ ] task\n";
    const external = "- [x] task\n";
    expect(drafts.taskBody("one", external, newLoad)).toBe(external);
    expect(drafts.taskBody("one", original, oldLoad)).toBe(external);

    const changed = toggleTaskCheckbox(drafts.taskBody("one", external, newLoad), 0)!;
    expect(await drafts.saveTask("one", changed, async () => true)).toBe(true);
    // A payload from a load that began before the save cannot undo the task write.
    expect(drafts.taskBody("one", original, newLoad)).toBe(changed);
    // A later successful load may legitimately restore the earlier text.
    const restoreLoad = drafts.nextLoadVersion();
    expect(drafts.taskBody("one", original, restoreLoad)).toBe(original);
  });

  it("applies the newest load held during a failed save", async () => {
    const drafts = createDraftStore();
    const initialLoad = drafts.nextLoadVersion();
    const initial = "- [ ] task\n";
    drafts.taskBody("one", initial, initialLoad);
    const checked = toggleTaskCheckbox(initial, 0)!;
    const savingLoad = drafts.nextLoadVersion();
    let finish!: (ok: boolean) => void;
    const save = drafts.saveTask("one", checked, () => new Promise<boolean>((resolve) => { finish = resolve; }));
    const external = "- [x] task\n";
    const externalLoad = drafts.nextLoadVersion();
    expect(drafts.taskBody("one", external, externalLoad)).toBe(initial);
    finish(false);
    expect(await save).toBe(false);
    expect(drafts.taskBody("one", initial, savingLoad)).toBe(external);
  });

  it("serializes editor and task writes and keeps the editor save as shared task state", async () => {
    const drafts = createDraftStore();
    const load = drafts.nextLoadVersion();
    const original = "- [ ] task\n";
    drafts.taskBody("one", original, load);
    drafts.open("one", original);
    drafts.edit("one", "- [x] edited task\n");

    let finishTask!: (ok: boolean) => void;
    const taskSave = drafts.saveTask("one", "- [x] task\n", () => new Promise<boolean>((resolve) => { finishTask = resolve; }));
    const editorWrite = vi.fn(async () => true);
    await drafts.save("one", editorWrite);
    expect(editorWrite).not.toHaveBeenCalled();
    finishTask(true);
    await taskSave;

    let finishEditor!: (ok: boolean) => void;
    const editorSave = drafts.save("one", () => new Promise<boolean>((resolve) => { finishEditor = resolve; }));
    expect(await drafts.saveTask("one", original, vi.fn(async () => true))).toBe(false);
    finishEditor(true);
    await editorSave;
    expect(drafts.taskBody("one", original, load)).toBe("- [x] edited task\n");
  });
});

describe("tree mutation draft guard", () => {
  it("asks only about affected dirty drafts, then clears only affected state", () => {
    const drafts = createDraftStore();
    drafts.open("one", "a"); drafts.edit("one", "changed");
    drafts.open("clean", "same");
    drafts.open("other", "a"); drafts.edit("other", "untouched");
    drafts.taskBody("one", "task body", drafts.nextLoadVersion());
    drafts.taskBody("clean", "clean task body", drafts.nextLoadVersion());
    const cancel = vi.fn(() => false);
    expect(mayMutateDrafts(drafts, ["one", "clean"], cancel)).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(drafts.get("one")?.body).toBe("changed");
    expect(drafts.get("clean")?.body).toBe("same");

    expect(mayMutateDrafts(drafts, ["one", "clean"], () => true)).toBe(true);
    expect(drafts.get("one")).toBeNull();
    expect(drafts.get("clean")).toBeNull();
    expect(drafts.get("other")?.body).toBe("untouched");
    expect(drafts.taskBody("one", "new source", drafts.nextLoadVersion())).toBe("new source");
    expect(drafts.taskBody("clean", "new source", drafts.nextLoadVersion())).toBe("new source");
  });

  it("clears clean affected drafts without prompting", () => {
    const drafts = createDraftStore();
    drafts.open("clean", "same");
    const confirm = vi.fn(() => false);
    expect(mayMutateDrafts(drafts, ["clean", "absent"], confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(drafts.get("clean")).toBeNull();
  });
});
