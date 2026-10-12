import { describe, expect, it, vi } from "vitest";
import { createDraftStore, mayMutateDrafts, mayRemoveDrafts } from "../../src/web/client/note/drafts";
import { toggleTaskCheckbox } from "../../src/web/client/note/note.model";

import { initialLayout, openDocument, closeTab, splitPane, closePane } from "../../src/web/shared/workspace";

describe("shared note drafts", () => {
  it("keeps the Raw tail out of the editor and joins it back on save", async () => {
    const drafts = createDraftStore();
    const tail = "---\n\n## Raw\n<!-- NEVER edit below this line. Verbatim user input preserved here. -->\n\n```\nhi\n```";
    drafts.open("one", `Body text.\n\n${tail}\n`);
    expect(drafts.get("one")).toEqual({
      body: "Body text.", baseline: "Body text.", tail, raw: "```\nhi\n```", rawBaseline: "```\nhi\n```", saving: false,
      original: "Body text.", originalRaw: "```\nhi\n```", savedAt: null, failed: false,
    });
    drafts.taskBody("one", `Body text.\n\n${tail}`, drafts.nextLoadVersion());
    drafts.edit("one", "Body text, edited.");
    const onSave = vi.fn(async () => true);
    await drafts.save("one", onSave);
    expect(onSave).toHaveBeenCalledWith("one", `Body text, edited.\n\n${tail}`, undefined);
    // The optimistic body under the read view keeps its tail too.
    expect(drafts.getTaskBody("one", "")).toBe(`Body text, edited.\n\n${tail}`);
    expect(drafts.get("one")).toBeNull();
  });

  it("saves an edited Raw under its heading and marks the save as a Raw edit", async () => {
    const drafts = createDraftStore();
    const opening = "---\n\n## Raw\n<!-- NEVER edit below this line. Verbatim user input preserved here. -->";
    drafts.open("one", `Body.\n\n${opening}\n\nteh words`);
    drafts.editRaw("one", "teh words");
    expect(drafts.isDirty("one")).toBe(false);
    drafts.editRaw("missing", "x");
    drafts.editRaw("one", "the words");
    expect(drafts.isDirty("one")).toBe(true);
    expect(drafts.dirtySlugs()).toEqual(["one"]);
    let release: (ok: boolean) => void = () => {};
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const saving = drafts.save("one", onSave);
    // Typed while the save is in flight: the draft stays, with the sent Raw as its baseline.
    drafts.editRaw("one", "the words, and more");
    release(true);
    await saving;
    expect(onSave).toHaveBeenCalledWith("one", `Body.\n\n${opening}\n\nthe words`, { raw: true });
    expect(drafts.get("one")).toMatchObject({ raw: "the words, and more", rawBaseline: "the words", tail: `${opening}\n\nthe words` });
    // Clearing every entry drops the tail.
    drafts.editRaw("one", "");
    const clear = vi.fn(async () => true);
    await drafts.save("one", clear);
    expect(clear).toHaveBeenCalledWith("one", "Body.", { raw: true });
    expect(drafts.get("one")).toBeNull();
  });

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
    expect(drafts.get("one")).toEqual({ body: "original", baseline: "original", tail: "", raw: "", rawBaseline: "", saving: false, original: "original", originalRaw: "", savedAt: null, failed: false });
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

    expect(drafts.get("one")).toMatchObject({ body: "typed while saving", baseline: "sent", tail: "", raw: "", rawBaseline: "", saving: false, failed: false });
    expect(drafts.isDirty("one")).toBe(true);

    let resolveSecond!: (ok: boolean) => void;
    drafts.open("two", "original");
    drafts.edit("two", "sent");
    const secondSave = drafts.save("two", () => new Promise<boolean>((resolve) => { resolveSecond = resolve; }));
    drafts.edit("two", "original");
    resolveSecond(true);
    await secondSave;
    expect(drafts.get("two")).toMatchObject({ body: "original", baseline: "sent", tail: "", raw: "", rawBaseline: "", saving: false });
    expect(drafts.isDirty("two")).toBe(true);
  });

  it("keeps failed saves and rejects stale completions after discard and reopen", async () => {
    const drafts = createDraftStore();
    drafts.open("one", "original");
    drafts.edit("one", "failed save");
    await drafts.save("one", async () => false);
    expect(drafts.get("one")?.body).toBe("failed save");
    expect(drafts.get("one")?.saving).toBe(false);
    expect(drafts.get("one")?.failed).toBe(true);

    let resolveSave!: (ok: boolean) => void;
    const saving = drafts.save("one", () => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    drafts.discard("one");
    drafts.open("one", "replacement");
    resolveSave(true);
    await saving;
    expect(drafts.get("one")).toEqual({ body: "replacement", baseline: "replacement", tail: "", raw: "", rawBaseline: "", saving: false, original: "replacement", originalRaw: "", savedAt: null, failed: false });
  });
});

describe("dirty view removal", () => {
  it("keeps the dirty draft when splitting moves its only view", () => {
    const drafts = createDraftStore();
    drafts.open("one", "original"); drafts.edit("one", "edited");
    const one = openDocument(initialLayout(), "note:one");
    const confirm = vi.fn(() => false);
    expect(mayRemoveDrafts(drafts, one, splitPane(one, "down"), confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(drafts.get("one")?.body).toBe("edited");
  });
  it("keeps one shared draft while another tab/pane still selects the note", () => {
    const drafts = createDraftStore();
    drafts.open("one", "original"); drafts.edit("one", "edited");
    const one = openDocument(initialLayout(), "note:one");
    const two = { ...openDocument(splitPane(one, "right"), "note:one", { paneId: "pane-1" }), activePane: "pane-2" };
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
    const two = { ...openDocument(splitPane(one, "right"), "note:one", { paneId: "pane-1" }), activePane: "pane-2" };
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

  it("autosaves without closing the editor, and passes quiet so the shell does not alert", async () => {
    const drafts = createDraftStore(() => 1_760_000_000_000);
    drafts.open("one", "original");
    drafts.edit("one", "typed");
    const onSave = vi.fn(async () => true);
    await drafts.save("one", onSave, { keepOpen: true });
    expect(onSave).toHaveBeenCalledWith("one", "typed", { quiet: true });
    expect(drafts.get("one")).toMatchObject({ body: "typed", baseline: "typed", original: "original", failed: false, savedAt: 1_760_000_000_000 });
    expect(drafts.isDirty("one")).toBe(false);

    await drafts.save("one", async () => false, { keepOpen: true });
    expect(drafts.get("one")?.failed).toBe(true);
  });

  it("reverts to the opening body, and says whether disk now differs", async () => {
    const drafts = createDraftStore();
    expect(drafts.revert("missing")).toBe(false);
    drafts.open("one", "original");
    drafts.edit("one", "typed");
    // Nothing written yet: going back is just closing.
    expect(drafts.revert("one")).toBe(false);
    drafts.edit("one", "typed");
    await drafts.save("one", async () => true, { keepOpen: true });
    // The edits are on disk, so the original has to be written back.
    expect(drafts.revert("one")).toBe(true);
    expect(drafts.get("one")?.body).toBe("original");
  });

  describe("following the Raw tail on disk", () => {
    const opening = "---\n\n## Raw\n<!-- NEVER edit below this line. Verbatim user input preserved here. -->";
    const note = (body: string, entries: string): string => `${body}\n\n${opening}\n\n${entries}`;

    it("keeps an entry an agent appended during an autosave when Raw is edited next", async () => {
      const drafts = createDraftStore();
      drafts.open("one", note("Body.", "first"));
      drafts.edit("one", "Body, edited.");
      // The server keeps its own tail for an untouched Raw, agent entry included.
      await drafts.save("one", async () => true, { keepOpen: true });
      const changed = vi.fn();
      drafts.subscribe(changed);
      drafts.syncTail("one", note("Body, edited.", "first\n\nsecond"));
      expect(changed).toHaveBeenCalledTimes(1);
      expect(drafts.get("one")).toMatchObject({ raw: "first\n\nsecond", rawBaseline: "first\n\nsecond", originalRaw: "first\n\nsecond", tail: `${opening}\n\nfirst\n\nsecond` });
      expect(drafts.isDirty("one")).toBe(false);

      drafts.editRaw("one", "First\n\nsecond");
      const onSave = vi.fn(async () => true);
      await drafts.save("one", onSave, { keepOpen: true });
      expect(onSave).toHaveBeenCalledWith("one", note("Body, edited.", "First\n\nsecond"), { raw: true, quiet: true });
    });

    it("leaves unsaved Raw edits, writes in flight and an unchanged tail alone", async () => {
      const drafts = createDraftStore();
      drafts.syncTail("missing", note("Body.", "x"));
      drafts.open("one", note("Body.", "first"));
      const changed = vi.fn();
      drafts.subscribe(changed);
      drafts.syncTail("one", note("Another body.", "first"));
      expect(changed).not.toHaveBeenCalled();

      drafts.editRaw("one", "mine");
      changed.mockClear();
      drafts.syncTail("one", note("Body.", "first\n\nsecond"));
      expect(changed).not.toHaveBeenCalled();
      expect(drafts.get("one")?.raw).toBe("mine");

      drafts.editRaw("one", "first");
      let release: (ok: boolean) => void = () => {};
      drafts.edit("one", "Body, edited.");
      const saving = drafts.save("one", () => new Promise<boolean>((resolve) => { release = resolve; }), { keepOpen: true });
      drafts.syncTail("one", note("Body.", "first\n\nsecond"));
      expect(drafts.get("one")?.rawBaseline).toBe("first");
      release(true);
      await saving;
    });

    it("lets Discard keep what was appended after the person's own autosaved Raw edit", async () => {
      const drafts = createDraftStore();
      drafts.open("one", note("Body.", "first"));
      drafts.editRaw("one", "First");
      await drafts.save("one", async () => true, { keepOpen: true });
      drafts.syncTail("one", note("Body.", "First\n\nsecond"));
      expect(drafts.get("one")?.originalRaw).toBe("first\n\nsecond");
      expect(drafts.revert("one")).toBe(true);
      expect(drafts.get("one")?.raw).toBe("first\n\nsecond");

      // A tail rewritten rather than appended to leaves the opening Raw as it was.
      const other = createDraftStore();
      other.open("two", note("Body.", "first"));
      other.editRaw("two", "First");
      await other.save("two", async () => true, { keepOpen: true });
      other.syncTail("two", note("Body.", "rewritten"));
      expect(other.get("two")).toMatchObject({ raw: "rewritten", originalRaw: "first" });
    });
  });
});
