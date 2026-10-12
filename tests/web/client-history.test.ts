import { describe, expect, it } from "vitest";
import { fetchHistory, historySettings, isHistoryPayload, isHistorySettings } from "../../src/web/client/api";
import type { FetchLike, HttpRequest, HttpResponse } from "../../src/web/client/api";
import {
  HISTORY_CLOSE_LABEL,
  HISTORY_LABEL,
  MARK_CLOSE as C,
  MARK_OPEN as O,
  changedRange,
  markChange,
  nextStep,
  replayStep,
} from "../../src/web/client/note/replay.model";
import { splitMarked } from "../../src/web/client/note/replay.model";
import type { HistoryRevision } from "../../src/web/shared/wire";

function respondsWith(body: unknown): FetchLike & { calls: Array<{ url: string; init: HttpRequest | undefined }> } {
  const calls: Array<{ url: string; init: HttpRequest | undefined }> = [];
  const impl = (url: string, init?: HttpRequest): Promise<HttpResponse> => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return Object.assign(impl, { calls });
}

const rev = (body: string, by: HistoryRevision["by"] = "agent", op = "append", at = "2026-10-11T09:00:00.000Z"): HistoryRevision => ({ at, by, op, body });

describe("history API", () => {
  it("fetches a note's revisions with the slug encoded, and checks every revision", async () => {
    const wire = (body: string) => ({ at: "2026-10-11T09:00:00.000Z", by: "agent", op: "append", full: body });
    const payload = { slug: "a/b", enabled: true, trimmed: false, revisions: [wire("x")] };
    const fetch = respondsWith(payload);
    expect(await fetchHistory(fetch, "a/b")).toMatchObject({ ok: true, data: { slug: "a/b", enabled: true, trimmed: false, revisions: [rev("x")] } });
    expect(fetch.calls[0]?.url).toBe("/api/history/a%2Fb");
    expect(isHistoryPayload({ ...payload, revisions: [{ ...wire("x"), by: "someone" }] })).toBe(false);
    expect(isHistoryPayload({ ...payload, revisions: [{ ...wire("x"), full: 1 }] })).toBe(false);
    expect(isHistoryPayload({ ...payload, revisions: [{ ...wire("x"), at: 1 }] })).toBe(false);
    expect(isHistoryPayload({ ...payload, revisions: [{ ...wire("x"), op: 1 }] })).toBe(false);
    expect(isHistoryPayload({ ...payload, revisions: [{ at: "t", by: "agent", op: "edit", keep: [0, -1], text: "" }] })).toBe(false);
    expect(isHistoryPayload({ ...payload, revisions: [{ at: "t", by: "agent", op: "edit", keep: [0], text: "" }] })).toBe(false);
    expect(isHistoryPayload({ ...payload, revisions: [{ at: "t", by: "agent", op: "edit", keep: [0, 0] }] })).toBe(false);
    expect(isHistoryPayload({ ...payload, revisions: [null] })).toBe(false);
    expect(isHistoryPayload({ ...payload, revisions: null })).toBe(false);
    expect(isHistoryPayload({ ...payload, enabled: "yes" })).toBe(false);
    expect(isHistoryPayload({ ...payload, trimmed: "no" })).toBe(false);
    expect(isHistoryPayload({ ...payload, slug: 1 })).toBe(false);
    expect(isHistoryPayload(null)).toBe(false);
  });

  it("rebuilds bodies from deltas, and refuses a delta that does not fit", async () => {
    const base = { at: "2026-10-11T09:00:00.000Z", by: "agent", op: "append" };
    const payload = {
      slug: "n",
      enabled: true,
      trimmed: true,
      revisions: [{ ...base, full: "one" }, { ...base, keep: [3, 0], text: " two" }, { ...base, keep: [0, 3], text: "zero, " }],
    };
    const result = await fetchHistory(respondsWith(payload), "n");
    expect(result.ok && result.data.revisions.map((r) => r.body)).toEqual(["one", "one two", "zero, two"]);
    expect(result.ok && result.data.trimmed).toBe(true);
    const broken = { ...payload, revisions: [{ ...base, keep: [0, 0], text: "orphan" }] };
    expect(await fetchHistory(respondsWith(broken), "n")).toMatchObject({ ok: false, kind: "malformed" });
    const overrun = { ...payload, revisions: [{ ...base, full: "ab" }, { ...base, keep: [2, 1], text: "" }] };
    expect(await fetchHistory(respondsWith(overrun), "n")).toMatchObject({ ok: false });
    expect(await fetchHistory(() => Promise.reject(new Error("down")), "n")).toMatchObject({ ok: false, kind: "network" });
  });

  it("reads and sets the history switch", async () => {
    const fetch = respondsWith({ enabled: false });
    expect(await historySettings(fetch)).toMatchObject({ ok: true, data: { enabled: false } });
    expect(fetch.calls[0]).toEqual({ url: "/api/history-settings", init: undefined });
    await historySettings(fetch, false);
    expect(fetch.calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(fetch.calls[1]?.init?.body ?? "")).toEqual({ enabled: false });
    expect(isHistorySettings({ enabled: 1 })).toBe(false);
  });
});

describe("replay model", () => {
  it("finds the changed range", () => {
    expect(changedRange("abc", "abXc")).toEqual({ start: 2, end: 3, removed: 0 });
    expect(changedRange("abc", "ac")).toEqual({ start: 1, end: 1, removed: 1 });
  });

  it("marks added text after block syntax, line by line", () => {
    expect(markChange("# Title\n", "# Title\n\n## Decisions\n- ship Friday\n")).toBe(
      `# Title\n\n## ${O}Decisions${C}\n- ${O}ship Friday${C}\n`,
    );
    expect(markChange(null, "hello")).toBe(`${O}hello${C}`);
    expect(markChange("same", "same")).toBe("same");
    expect(markChange("abc", "ac")).toBe("ac");
    expect(markChange("a", "a\n\n   \n")).toBe("a\n\n   \n");
  });

  it("never splits links, fences, rules or comments", () => {
    expect(markChange("see [[alpha]] now", "see [[alpha-beta]] now")).toBe(`see ${O}[[alpha-beta]]${C} now`);
    expect(markChange("go [x](http://a.b/c) ok", "go [x](http://a.b/cd) ok")).toBe(`go ${O}[x](http://a.b/cd)${C} ok`);
    const raw = "body\n\n---\n\n## Raw\n<!-- appended 2026-10-11 09:00 -->\n```\nmy words\n```\n";
    expect(markChange("body", raw)).toBe(
      `body\n\n---\n\n## ${O}Raw${C}\n<!-- appended 2026-10-11 09:00 -->\n\`\`\`\n${O}my words${C}\n\`\`\`\n`,
    );
  });

  it("splits text nodes at the markers, carrying state across nodes", () => {
    expect(splitMarked(`a${O}b`, false)).toEqual({ parts: [{ text: "a", marked: false }, { text: "b", marked: true }], inside: true });
    expect(splitMarked(`c${C}d`, true)).toEqual({ parts: [{ text: "c", marked: true }, { text: "d", marked: false }], inside: false });
    expect(splitMarked(`${O}${C}`, false)).toEqual({ parts: [], inside: false });
  });

  it("describes each step of the slider", () => {
    const revisions = [
      rev("one", "outside", "baseline", "2026-10-10T09:00:00.000Z"),
      rev("one two", "human", "edit", "2026-10-11T09:00:00.000Z"),
      rev("two", "agent", "finalize", "2026-10-11T09:05:00.000Z"),
      rev("two", "system", "mystery", "not a date"),
    ];
    expect(replayStep([], 0)).toBeNull();
    expect(replayStep(revisions, 0)).toMatchObject({ position: "1 of 4", action: "Earliest saved version", change: "+3", by: "outside" });
    const edit = replayStep(revisions, 1)!;
    expect(edit).toMatchObject({ position: "2 of 4", action: "You edited", change: "+4", atIso: "2026-10-11T09:00:00.000Z" });
    expect(edit.at).toMatch(/,/);
    const finalize = replayStep(revisions, 2)!;
    expect(finalize).toMatchObject({ action: "Agent rewrote the summary", change: "−4" });
    expect(finalize.at).not.toMatch(/,/);
    expect(replayStep(revisions, 99)).toMatchObject({ position: "4 of 4", action: "pi-weave mystery", change: "", at: "not a date" });
    expect(replayStep(revisions, -5)?.position).toBe("1 of 4");
  });

  it("steps forward until the end", () => {
    expect(nextStep(0, 2)).toBe(1);
    expect(nextStep(1, 2)).toBeNull();
    expect([HISTORY_LABEL, HISTORY_CLOSE_LABEL]).toEqual(["History", "Close history"]);
  });
});
