import { describe, expect, it } from "vitest";
import { CaptureApi, type FetchLike } from "../../src/capture/client/api";
import { clock, meetingLine, minutes, pickMime, statusLabel, transcriptMarkdown, when } from "../../src/capture/client/format";
import { backoff, MemoryPieceStore, Uploader } from "../../src/capture/client/uploader";

function fakeFetch(routes: Record<string, (body: unknown) => { status: number; json?: unknown } | "throw" | "badjson">) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> | undefined }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const route = routes[`${init.method} ${url}`] ?? routes[`${init.method} *`];
    const answer = route ? route(init.body) : { status: 404, json: { error: "Not found." } };
    if (answer === "throw") throw new TypeError("offline");
    if (answer === "badjson") return { ok: false, status: 502, json: async () => { throw new SyntaxError("x"); } };
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.json ?? null };
  };
  return { fetcher, calls };
}

describe("capture api", () => {
  it("sends JSON and raw bodies with same-origin credentials", async () => {
    const { fetcher, calls } = fakeFetch({ "POST *": () => ({ status: 200, json: { ok: true } }), "PUT *": () => ({ status: 200, json: { ok: true } }) });
    const api = new CaptureApi(fetcher);
    expect(await api.setupOptions("Eran")).toEqual({ ok: true, data: { ok: true } });
    expect(calls[0]).toMatchObject({ url: "/api/auth/setup/options", body: '{"name":"Eran"}', headers: { "content-type": "application/json" } });
    await api.putPiece("rec", 3, "BLOB");
    expect(calls[1]).toMatchObject({ url: "/api/recordings/rec/pieces/3", method: "PUT", body: "BLOB", headers: { "content-type": "application/octet-stream" } });
  });

  it("turns failures into results", async () => {
    const { fetcher } = fakeFetch({
      "GET /api/session": () => "throw",
      "GET /api/meetings": () => "badjson",
      "POST /api/auth/recover": () => ({ status: 401, json: { error: "That code didn’t work." } }),
      "GET /api/passkeys": () => ({ status: 403, json: "nope" }),
    });
    const api = new CaptureApi(fetcher);
    expect(await api.session()).toEqual({ ok: false, status: 0, error: "Can’t reach your Mac right now." });
    expect(await api.meetings()).toMatchObject({ ok: false, status: 502, error: "Can’t reach your Mac right now." });
    expect(await api.recover("x")).toMatchObject({ ok: false, status: 401, error: "That code didn’t work." });
    expect(await api.passkeys()).toMatchObject({ ok: false, error: "Request failed (403)." });
  });

  it("names every route", async () => {
    const { fetcher, calls } = fakeFetch({ "GET *": () => ({ status: 200 }), "POST *": () => ({ status: 200 }), "DELETE *": () => ({ status: 200 }) });
    const api = new CaptureApi(fetcher);
    await api.setupVerify({});
    await api.loginOptions();
    await api.loginVerify({});
    await api.logout();
    await api.passkeyOptions();
    await api.passkeyVerify({});
    await api.removePasskey("a/b");
    await api.newRecoveryCodes();
    await api.transcript("meetings/x y");
    await api.setTranscriptStatus("s", "read");
    await api.renameTranscript("s", "t");
    await api.createRecording({ recorded: "r", mime: "m" });
    await api.finish("id", 2, 3);
    await api.retry("id");
    await api.renameRecording("id", "t");
    await api.discard("id");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/auth/setup/verify",
      "POST /api/auth/login/options",
      "POST /api/auth/login/verify",
      "POST /api/auth/logout",
      "POST /api/passkeys/options",
      "POST /api/passkeys/verify",
      "DELETE /api/passkeys/a%2Fb",
      "POST /api/recovery-codes",
      "GET /api/transcript?slug=meetings%2Fx%20y",
      "POST /api/transcript/status",
      "POST /api/transcript/title",
      "POST /api/recordings",
      "POST /api/recordings/id/finish",
      "POST /api/recordings/id/retry",
      "POST /api/recordings/id/title",
      "DELETE /api/recordings/id",
    ]);
  });
});

describe("uploader", () => {
  function setup(answers: { put?: (index: number) => { ok: boolean; status: number }; finish?: () => { ok: boolean; status: number; error?: string } } = {}) {
    const store = new MemoryPieceStore();
    const sent: string[] = [];
    const api = {
      putPiece: async (id: string, index: number) => {
        sent.push(`${id}/${index}`);
        const a = answers.put?.(index) ?? { ok: true, status: 200 };
        return a.ok ? { ok: true as const, data: { ok: true as const } } : { ok: false as const, status: a.status, error: "Can’t reach your Mac right now." };
      },
      finish: async () => {
        const a = answers.finish?.() ?? { ok: true, status: 200 };
        return a.ok ? { ok: true as const, data: { ok: true as const, status: "queued" } } : { ok: false as const, status: a.status, error: a.error ?? "x" };
      },
    };
    return { store, sent, uploader: new Uploader(store, api) };
  }

  it("uploads in order, finishes stopped recordings and empties the store", async () => {
    const { store, sent, uploader } = setup();
    await store.putRecording({ id: "r", title: "t", pieces: 2, duration: 20, stopped: true });
    await store.putPiece({ recording: "r", index: 1, bytes: "b" });
    await store.putPiece({ recording: "r", index: 0, bytes: "a" });
    await store.putRecording({ id: "live", title: "t", pieces: 1, duration: 5, stopped: false });
    await store.putPiece({ recording: "live", index: 0, bytes: "c" });
    const [one, two] = await Promise.all([uploader.sync(), uploader.sync()]);
    expect(one).toBe(two);
    expect(one).toEqual({ waiting: 0, finished: ["r"], error: null });
    expect(sent).toEqual(["r/0", "r/1", "live/0"]);
    expect((await store.recordings()).map((r) => r.id)).toEqual(["live"]);
  });

  it("stops at a network failure and keeps the audio", async () => {
    const { store, uploader } = setup({ put: (i) => (i === 1 ? { ok: false, status: 0 } : { ok: true, status: 200 }) });
    await store.putRecording({ id: "r", title: "t", pieces: 2, duration: 20, stopped: true });
    await store.putPiece({ recording: "r", index: 0, bytes: "a" });
    await store.putPiece({ recording: "r", index: 1, bytes: "b" });
    expect(await uploader.sync()).toEqual({ waiting: 1, finished: [], error: "Can’t reach your Mac right now." });
  });

  it("drops pieces the Mac will never take, and empty or refused recordings", async () => {
    const { store, uploader } = setup({ put: () => ({ ok: false, status: 409 }), finish: () => ({ ok: false, status: 409, error: "Some audio has not arrived yet." }) });
    await store.putRecording({ id: "empty", title: "t", pieces: 0, duration: 0, stopped: true });
    await store.putRecording({ id: "r", title: "t", pieces: 1, duration: 1, stopped: true });
    await store.putPiece({ recording: "r", index: 0, bytes: "a" });
    expect(await uploader.sync()).toEqual({ waiting: 0, finished: [], error: "Some audio has not arrived yet." });
    expect(await store.recordings()).toEqual([]);
  });

  it("keeps a recording whose finish could not reach the Mac", async () => {
    const { store, uploader } = setup({ finish: () => ({ ok: false, status: 0, error: "offline" }) });
    await store.putRecording({ id: "r", title: "t", pieces: 1, duration: 1, stopped: true });
    expect((await uploader.sync()).error).toBe("offline");
    expect((await store.recordings()).length).toBe(1);
    await store.removePiece("r", 0);
  });

  it("backs off up to a minute", () => {
    expect([0, 1, 2, 3, 9].map(backoff)).toEqual([2, 2, 4, 8, 60]);
  });
});

describe("format", () => {
  it("formats clocks and lengths", () => {
    expect(clock(0)).toBe("00:00:00");
    expect(clock(1_421_000)).toBe("00:23:41");
    expect(clock(-5)).toBe("00:00:00");
    expect(minutes(40)).toBe("40 s");
    expect(minutes(2520)).toBe("42 min");
    expect(minutes(3900)).toBe("1 h 05 min");
  });

  it("says when, relative to today", () => {
    const now = new Date(2026, 10, 9, 12, 0);
    expect(when(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toBe("Today 09:00");
    expect(when(new Date(2026, 10, 8, 16, 30).toISOString(), now)).toBe("Yesterday 16:30");
    expect(when(new Date(2026, 10, 6, 11, 0).toISOString(), now)).toBe("Fri 11:00");
    expect(when(new Date(2026, 9, 3, 11, 0).toISOString(), now)).toBe("3 Oct 11:00");
    expect(when("nope", now)).toBe("");
    expect(when(new Date().toISOString())).toMatch(/^Today/);
  });

  it("labels statuses and meetings", () => {
    expect((["recording", "queued", "transcribing", "failed", "new", "read"] as const).map(statusLabel)).toEqual(["uploading", "waiting", "transcribing", "failed", "new", "read"]);
    const now = new Date(2026, 10, 9, 12, 0);
    const meeting = { id: "m", kind: "transcript" as const, title: "T", recorded: new Date(2026, 10, 9, 9, 0).toISOString(), duration: 2520, status: "new" as const };
    expect(meetingLine(meeting, now)).toBe("Today 09:00 · 42 min");
    expect(meetingLine({ ...meeting, duration: 0 }, now)).toBe("Today 09:00");
  });

  it("copies a transcript as Markdown", () => {
    expect(transcriptMarkdown({ id: "m", kind: "transcript", title: "Sync", recorded: "2026-11-09T07:00:00.000Z", duration: 60, status: "new", body: "[00:00:01] hi\n" })).toBe(
      "# Sync\n\nRecorded 2026-11-09 07:00 UTC, 1 min.\n\n[00:00:01] hi\n",
    );
  });

  it("picks the best recording format the browser has", () => {
    expect(pickMime((m) => m === "audio/mp4")).toBe("audio/mp4");
    expect(pickMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickMime(() => false)).toBe("");
  });
});
