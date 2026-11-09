import { promises as fs } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthStore, deviceLabel, normalizeRecoveryCode, recoveryCode, SESSION_TTL_MS } from "../../src/capture/server/auth";
import { resolveConfig } from "../../src/capture/server/config";
import { audioExtension, defaultTitle, isRecordingId, Recordings, type Transcribe } from "../../src/capture/server/recordings";
import { parseWhisperJson, runProgram, whisperTranscriber } from "../../src/capture/server/whisper";
import { simpleWebAuthn } from "../../src/capture/server/webauthn";
import { listTranscripts, saveTranscript } from "../../src/core/capture";
import { makeTempDir } from "../helpers";

let dir: string;
let vault: string;
beforeEach(async () => {
  dir = await makeTempDir();
  vault = await makeTempDir();
});

describe("config", () => {
  it("reads flags, then environment, then defaults", () => {
    const defaults = resolveConfig([], { PI_WEAVE_VAULT: "/v" });
    expect(defaults).toMatchObject({ origin: "https://weave.manta.run", rpId: "weave.manta.run", port: 3310, host: "127.0.0.1", vaultRoot: "/v", whisper: "whisper-cli", language: "auto", ffmpeg: "ffmpeg" });
    expect(defaults.model).toMatch(/\.okf-capture\/models\/ggml-large-v3-turbo\.bin$/);
    const set = resolveConfig(["--origin=https://x.example/path", "--port", "4000", "stray", "--dir", "/d", "--model"], { PI_WEAVE_WHISPER_LANG: "he" });
    expect(set).toMatchObject({ origin: "https://x.example", rpId: "x.example", port: 4000, dir: "/d", language: "he", model: "/d/models/ggml-large-v3-turbo.bin" });
    expect(() => resolveConfig(["--port", "70000"], {})).toThrow("invalid port");
  });
});

describe("auth helpers", () => {
  it("makes readable recovery codes and normalizes typed ones", () => {
    expect(recoveryCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeRecoveryCode("k7pq m2xd 9rta")).toBe("K7PQ-M2XD-9RTA");
    expect(normalizeRecoveryCode("short")).toBe("SHORT");
  });

  it("names devices", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)")).toBe("iPhone");
    expect(deviceLabel("(iPad; CPU OS 18_0)")).toBe("iPad");
    expect(deviceLabel("Linux; Android 15")).toBe("Android");
    expect(deviceLabel("Macintosh; Intel Mac OS X 10_15")).toBe("Mac");
    expect(deviceLabel("Windows NT 10.0")).toBe("Windows");
    expect(deviceLabel("X11; Linux x86_64")).toBe("Linux");
    expect(deviceLabel(undefined)).toBe("Passkey");
  });

  it("persists to a private file and expires sessions", async () => {
    let now = 1_000;
    const store = new AuthStore(dir, () => now);
    const passkey = { id: "k", publicKey: "p", counter: 0, transports: [], name: "iPhone", created: "c", lastUsed: null };
    await store.completeSetup("Eran", passkey);
    await store.addPasskey({ ...passkey, name: "Renamed" });
    const token = await store.createSession();
    const mode = (await fs.stat(join(dir, "auth.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    const reopened = new AuthStore(dir, () => now);
    expect(await reopened.session(token)).toEqual({ recovery: false });
    expect((await reopened.passkeys()).map((p) => p.name)).toEqual(["Renamed"]);
    expect(await reopened.findPasskey("missing")).toBeNull();
    await reopened.markPasskeyUsed("missing", 3);
    expect(await reopened.session(undefined)).toBeNull();
    await reopened.endSession(undefined);
    now += SESSION_TTL_MS + 1;
    expect(await reopened.session(token)).toBeNull();
    await reopened.newRecoveryCodes();
    expect(await reopened.recoveryCodesLeft()).toBe(10);
  });

  it("surfaces an unreadable auth file instead of starting over", async () => {
    await fs.mkdir(join(dir, "auth.json"));
    await expect(new AuthStore(dir).isSetUp()).rejects.toThrow();
  });
});

describe("passkey ceremonies", () => {
  const rp = { origin: "https://weave.example", rpId: "weave.example" };

  it("asks for a discoverable, verified passkey on this device", async () => {
    const options = await simpleWebAuthn.registrationOptions(rp, { id: "user", name: "Eran" }, [
      { id: "AAAA", publicKey: "", counter: 0, transports: ["internal"], name: "", created: "", lastUsed: null },
    ]);
    expect(options.rp).toEqual({ name: "Weave Capture", id: "weave.example" });
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(options.excludeCredentials).toEqual([{ id: "AAAA", type: "public-key", transports: ["internal"] }]);
    const login = await simpleWebAuthn.authenticationOptions(rp);
    expect(login.userVerification).toBe("required");
    expect(login.allowCredentials ?? []).toEqual([]);
  });

  it("rejects responses that do not verify", async () => {
    expect(await simpleWebAuthn.verifyRegistration(rp, { id: "x" } as never, "c")).toBeNull();
    const passkey = { id: "x", publicKey: "AAAA", counter: 0, transports: [], name: "", created: "", lastUsed: null };
    expect(await simpleWebAuthn.verifyAuthentication(rp, { id: "x" } as never, "c", passkey)).toBeNull();
  });
});

describe("recordings", () => {
  const segments: Transcribe = async () => [{ start: 0, text: "hi" }];

  it("validates ids, extensions and titles", () => {
    expect(isRecordingId("abcdefgh")).toBe(true);
    expect(isRecordingId("../etc")).toBe(false);
    expect(audioExtension("audio/mp4;codecs=mp4a")).toBe("m4a");
    expect(audioExtension("audio/ogg")).toBe("ogg");
    expect(audioExtension("audio/wav")).toBe("wav");
    expect(audioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(defaultTitle(new Date(2026, 10, 9, 9, 5))).toBe("Meeting 2026-11-09 09:05");
  });

  it("names a recording from the clock when the phone sends no time", async () => {
    const recordings = new Recordings(dir, vault, segments, 7, () => new Date(2026, 10, 9, 9, 5));
    const meta = await recordings.create({ recorded: "not a date" });
    expect(meta.title).toBe("Meeting 2026-11-09 09:05");
    expect(meta.mime).toBe("audio/webm");
    expect(await recordings.get("../x")).toBeNull();
    expect(await recordings.rename(meta.id, "")).toBe(false);
  });

  it("keeps a failure, retries it, and never writes a transcript twice", async () => {
    let fail = true;
    const lines: string[] = [];
    const recordings = new Recordings(dir, vault, async () => {
      if (fail) throw new Error("whisper-cli failed");
      return [{ start: 2, text: "second try" }];
    }, 7, undefined, (line) => lines.push(line));
    const meta = await recordings.create({ title: "Retro" });
    await recordings.putPiece(meta.id, 0, Buffer.from("a"));
    await recordings.finish(meta.id, { pieces: 1, duration: 30 });
    await recordings.idle();
    expect(await recordings.get(meta.id)).toMatchObject({ status: "failed", error: "whisper-cli failed" });
    expect(await recordings.rename(meta.id, "Retro 2")).toBe(true);
    fail = false;
    expect(await recordings.retry(meta.id)).toBe(true);
    await recordings.idle();
    const done = await recordings.get(meta.id);
    expect(done).toMatchObject({ status: "done", slug: "meetings/retro-2" });
    expect(await recordings.discard(meta.id)).toBe(false);
    expect(await recordings.rename(meta.id, "x")).toBe(false);
    expect((await recordings.finish(meta.id, { pieces: 1, duration: 1 })).ok).toBe(true);
    expect(lines.join("\n")).toContain("transcription failed");
    // A restart that finds the note already written just marks it done.
    await fs.writeFile(join(dir, "recordings", meta.id, "meta.json"), JSON.stringify({ ...done, status: "queued" }));
    await recordings.resume();
    await recordings.idle();
    expect((await listTranscripts(vault)).length).toBe(1);
    expect(await recordings.retry("missing-recording")).toBe(false);
  });

  it("picks up interrupted work and prunes old audio", async () => {
    let now = new Date("2026-11-09T07:00:00Z");
    const recordings = new Recordings(dir, vault, segments, 7, () => now);
    const a = await recordings.create({ title: "A", recorded: "2026-11-09T06:00:00Z" });
    await recordings.putPiece(a.id, 0, Buffer.from("a"));
    await fs.writeFile(join(dir, "recordings", a.id, "meta.json"), JSON.stringify({ ...a, status: "transcribing", pieces: 1 }));
    await recordings.resume();
    await recordings.idle();
    expect((await recordings.get(a.id))?.status).toBe("done");
    expect(await recordings.prune()).toBe(0);
    now = new Date("2026-11-20T07:00:00Z");
    expect(await recordings.prune()).toBe(1);
    expect(await recordings.all()).toEqual([]);
    await fs.mkdir(join(dir, "recordings", "not-a-recording"), { recursive: true });
    expect(await recordings.all()).toEqual([]);
  });

  it("lists failed recordings with their error beside transcripts", async () => {
    await saveTranscript(vault, { title: "Old", recorded: new Date("2026-11-01T07:00:00Z"), duration: 5, segments: [], capture: "x" });
    const recordings = new Recordings(dir, vault, async () => {
      throw "boom";
    });
    const meta = await recordings.create({ title: "Broken", recorded: "2026-11-09T07:00:00Z" });
    await recordings.putPiece(meta.id, 0, Buffer.from("a"));
    await recordings.finish(meta.id, { pieces: 1, duration: Number.NaN });
    await recordings.idle();
    const meetings = await recordings.meetings();
    expect(meetings[0]).toMatchObject({ title: "Broken", status: "failed", error: "boom", duration: 0 });
    expect(meetings[1]).toMatchObject({ title: "Old", kind: "transcript" });
  });
});

describe("whisper", () => {
  it("parses whisper-cli JSON", () => {
    expect(parseWhisperJson('{"transcription":[{"offsets":{"from":1500},"text":" Hi"},{"text":null}]}')).toEqual([
      { start: 1.5, text: " Hi" },
      { start: 0, text: "" },
    ]);
    expect(() => parseWhisperJson("{}")).toThrow("no transcription");
  });

  it("converts with ffmpeg, transcribes, and removes the WAV", async () => {
    const calls: string[][] = [];
    const transcribe = whisperTranscriber({ ffmpeg: "ff", whisper: "wh", model: "/m.bin", language: "auto" }, async (program, args) => {
      calls.push([program, ...args]);
      if (program === "ff") await fs.writeFile(join(dir, "audio.wav"), "wav");
      if (program === "wh") await fs.writeFile(join(dir, "transcript.json"), '{"transcription":[{"offsets":{"from":0},"text":"ok"}]}');
    });
    expect(await transcribe(join(dir, "audio.m4a"), dir)).toEqual([{ start: 0, text: "ok" }]);
    expect(calls.map((c) => c[0])).toEqual(["ff", "wh"]);
    expect(calls[1]).toContain("-oj");
    await expect(fs.access(join(dir, "audio.wav"))).rejects.toThrow();
  });

  it("runs programs and reports their stderr", async () => {
    await runProgram(process.execPath, ["-e", "0"]);
    await expect(runProgram(process.execPath, ["-e", "console.error('bad input'); process.exit(3)"])).rejects.toThrow("bad input");
    await expect(runProgram(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow(/failed \(/);
  });
});
