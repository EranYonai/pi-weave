import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../../src/capture/server/auth";
import { resolveConfig } from "../../src/capture/server/config";
import { Recordings } from "../../src/capture/server/recordings";
import { createCaptureHandler, defaultAppPath, startCaptureServer, type CaptureServer } from "../../src/capture/server/server";
import { saveTranscript } from "../../src/core/capture";
import { addNote } from "../../src/core/vault";
import { makeTempDir } from "../helpers";
import { Client, fakeWebAuthn, ORIGIN } from "./helpers";

let dir: string;
let vault: string;
let server: CaptureServer;
let client: Client;
let recordings: Recordings;
let clock = Date.parse("2026-11-09T07:00:00.000Z");

beforeEach(async () => {
  dir = await makeTempDir();
  vault = await makeTempDir();
  clock = Date.parse("2026-11-09T07:00:00.000Z");
  const config = { ...resolveConfig(["--origin", ORIGIN, "--dir", dir], { PI_WEAVE_VAULT: vault }) };
  recordings = new Recordings(dir, vault, async () => [{ start: 1, text: "hello there" }]);
  server = await startCaptureServer(
    { config, auth: new AuthStore(dir, () => clock), webauthn: fakeWebAuthn, recordings, appJs: async () => Buffer.from("console.log(1)"), now: () => clock },
    0,
  );
  client = new Client(server.url);
});

afterEach(async () => {
  await server.close();
});

async function setUp(c = client) {
  const options = await c.post("/api/auth/setup/options", { name: "Eran" });
  expect(options.status).toBe(200);
  const verified = await c.post("/api/auth/setup/verify", { response: { id: "key-1", ok: true } });
  expect(verified.status).toBe(200);
  return verified.body.codes as string[];
}

describe("the page and the gate", () => {
  it("serves the page, assets and health", async () => {
    expect((await client.get("/api/health")).body).toEqual({ ok: true });
    const page = await client.get("/");
    expect(page.text).toContain("<title>Weave Capture</title>");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect((await client.get("/settings")).text).toContain("app.js");
    expect((await client.get("/app.js")).text).toBe("console.log(1)");
    expect((await client.get("/app.css")).text).toContain("--accent");
    expect((await client.get("/manifest.webmanifest")).body.name).toBe("Weave Capture");
    expect((await client.get("/icon.svg")).text).toContain("<svg");
    expect(defaultAppPath()).toMatch(/src\/capture\/dist\/app\.js$/);
  });

  it("answers only at its own host and origin", async () => {
    client.host = "evil.test";
    expect((await client.get("/api/session")).status).toBe(421);
    client.host = "cap.test";
    client.origin = "http://evil.test";
    expect((await client.post("/api/auth/login/options")).status).toBe(403);
    client.origin = null;
    expect((await client.post("/api/auth/login/options")).status).toBe(403);
  });

  it("refuses bad bodies and unknown routes", async () => {
    expect((await client.send("POST", "/api/auth/setup/options", undefined, Buffer.from("{nope"))).status).toBe(400);
    expect((await client.send("POST", "/api/auth/setup/options", undefined, Buffer.from("[1]"))).status).toBe(400);
    expect((await client.send("POST", "/api/auth/setup/options", undefined, Buffer.alloc(70 * 1024, 32))).status).toBe(413);
    await setUp();
    expect((await client.get("/api/nothing")).status).toBe(404);
    expect((await client.send("PATCH", "/api/recordings/abcdefgh12345")).status).toBe(404);
  });

  it("turns an unexpected failure into a 500 with a plain message", async () => {
    const handler = createCaptureHandler({
      config: resolveConfig(["--origin", ORIGIN], {}),
      auth: { session: async () => { throw new Error("disk"); } } as unknown as AuthStore,
      webauthn: fakeWebAuthn,
      recordings,
      appJs: async () => Buffer.from(""),
    });
    let status = 0;
    let body = "";
    await handler(
      { method: "GET", url: "/api/session", headers: { host: "cap.test" } } as never,
      { writeHead: (s: number) => (status = s), end: (b: string) => (body = b) } as never,
    );
    expect(status).toBe(500);
    expect(body).toContain("Something went wrong");
  });
});

describe("passkey sign-in", () => {
  it("sets up once, then closes setup", async () => {
    expect((await client.get("/api/session")).body).toEqual({ setUp: false, signedIn: false, recovery: false, name: null });
    expect((await client.post("/api/auth/setup/options", { name: " " })).status).toBe(400);
    expect((await client.post("/api/auth/login/options")).status).toBe(409);
    const codes = await setUp();
    expect(codes).toHaveLength(10);
    expect((await client.get("/api/session")).body).toEqual({ setUp: true, signedIn: true, recovery: false, name: "Eran" });
    const stranger = new Client(server.url);
    expect((await stranger.post("/api/auth/setup/options", { name: "Mallory" })).status).toBe(409);
    expect((await stranger.get("/api/meetings")).status).toBe(401);
  });

  it("refuses a setup that loses the race or fails to verify", async () => {
    const a = new Client(server.url);
    const b = new Client(server.url);
    await a.post("/api/auth/setup/options", { name: "A" });
    await b.post("/api/auth/setup/options", { name: "B" });
    expect((await a.post("/api/auth/setup/verify", { response: { id: "x", ok: false } })).status).toBe(400);
    await a.post("/api/auth/setup/options", { name: "A" });
    expect((await a.post("/api/auth/setup/verify", { response: { id: "a", ok: true } })).status).toBe(200);
    expect((await b.post("/api/auth/setup/verify", { response: { id: "b", ok: true } })).status).toBe(409);
  });

  it("needs a fresh, matching challenge", async () => {
    expect((await client.post("/api/auth/setup/verify", { response: {} })).status).toBe(400);
    await client.post("/api/auth/setup/options", { name: "Eran" });
    clock += 6 * 60 * 1000;
    expect((await client.post("/api/auth/setup/verify", { response: { id: "k", ok: true } })).body.error).toContain("took too long");
    await setUp();
    await client.post("/api/auth/login/options");
    expect((await client.post("/api/auth/setup/verify", { response: { id: "k", ok: true } })).status).toBe(400);
  });

  it("caps open challenges", async () => {
    for (let i = 0; i < 100; i++) await new Client(server.url).post("/api/auth/setup/options", { name: "x" });
    expect((await client.post("/api/auth/setup/options", { name: "x" })).status).toBe(429);
    clock += 6 * 60 * 1000;
    expect((await client.post("/api/auth/setup/options", { name: "x" })).status).toBe(200);
  });

  it("signs in with a known passkey and signs out", async () => {
    await setUp(new Client(server.url));
    await client.post("/api/auth/login/options");
    expect((await client.post("/api/auth/login/verify", { response: { id: "nope", ok: true } })).body.unknownPasskey).toBe(true);
    await client.post("/api/auth/login/options");
    expect((await client.post("/api/auth/login/verify", { response: { ok: true } })).status).toBe(401);
    await client.post("/api/auth/login/options");
    expect((await client.post("/api/auth/login/verify", { response: { id: "key-1", ok: false } })).status).toBe(401);
    await client.post("/api/auth/login/options");
    expect((await client.post("/api/auth/login/verify", { response: { id: "key-1", ok: true } })).status).toBe(200);
    expect((await client.get("/api/meetings")).status).toBe(200);
    expect((await client.get("/api/passkeys")).body.passkeys[0].lastUsed).toBe("2026-11-09T07:00:00.000Z");
    await client.post("/api/auth/logout");
    expect((await client.get("/api/meetings")).status).toBe(401);
    expect((await new Client(server.url).post("/api/auth/logout")).status).toBe(200);
  });

  it("lets a recovery code in only to add a passkey", async () => {
    const codes = await setUp(new Client(server.url));
    expect((await client.post("/api/auth/recover", { code: "AAAA-BBBB-CCCC" })).status).toBe(401);
    expect((await client.post("/api/auth/recover", { code: codes[0]!.toLowerCase().replace(/-/g, " ") })).status).toBe(200);
    expect((await client.get("/api/session")).body.recovery).toBe(true);
    expect((await client.get("/api/meetings")).status).toBe(403);
    await client.post("/api/passkeys/options");
    expect((await client.post("/api/passkeys/verify", { response: { id: "k2", ok: false } })).status).toBe(400);
    await client.post("/api/passkeys/options");
    expect((await client.post("/api/passkeys/verify", { response: { id: "k2", ok: true }, name: "Mac" })).status).toBe(200);
    expect((await client.get("/api/session")).body.recovery).toBe(false);
    const keys = await client.get("/api/passkeys");
    expect(keys.body.passkeys.map((p: { name: string }) => p.name)).toEqual(["Passkey", "Mac"]);
    expect(keys.body.recoveryCodesLeft).toBe(9);
    // A used code does not work twice.
    expect((await new Client(server.url).post("/api/auth/recover", { code: codes[0] })).status).toBe(401);
  });

  it("rate-limits recovery codes", async () => {
    const codes = await setUp(new Client(server.url));
    for (let i = 0; i < 4; i++) expect((await client.post("/api/auth/recover", { code: "" })).status).toBe(401);
    expect((await client.post("/api/auth/recover", { code: "nope" })).status).toBe(401);
    expect((await client.post("/api/auth/recover", { code: codes[1] })).status).toBe(429);
    clock += 16 * 60 * 1000;
    expect((await client.post("/api/auth/recover", { code: codes[1] })).status).toBe(200);
  });

  it("manages passkeys and recovery codes from settings", async () => {
    await setUp();
    await client.post("/api/passkeys/options");
    await client.post("/api/passkeys/verify", { response: { id: "key-2", ok: true } });
    expect((await client.send("DELETE", "/api/passkeys/nope")).status).toBe(404);
    expect((await client.send("DELETE", "/api/passkeys/key-1")).status).toBe(200);
    expect((await client.send("DELETE", "/api/passkeys/key-2")).status).toBe(409);
    const fresh = await client.post("/api/recovery-codes");
    expect(fresh.body.codes).toHaveLength(10);
  });

  it("uses secure cookie names on https", async () => {
    const httpsServer = await startCaptureServer(
      {
        config: resolveConfig(["--origin", "https://weave.example", "--dir", dir], { PI_WEAVE_VAULT: vault }),
        auth: new AuthStore(await makeTempDir()),
        webauthn: fakeWebAuthn,
        recordings,
        appJs: async () => Buffer.from(""),
      },
      0,
    );
    try {
      const c = new Client(httpsServer.url, "weave.example", "https://weave.example");
      const reply = await c.post("/api/auth/setup/options", { name: "Eran" });
      expect(String(reply.headers["set-cookie"])).toContain("__Host-weave-challenge=");
      expect(String(reply.headers["set-cookie"])).toContain("Secure");
    } finally {
      await httpsServer.close();
    }
  });
});

describe("meetings", () => {
  beforeEach(async () => {
    await setUp();
  });

  it("records, uploads pieces, finishes and lands in the vault", async () => {
    const created = await client.post("/api/recordings", { title: "Standup", recorded: "2026-11-09T06:30:00.000Z", mime: "audio/mp4" });
    const id = created.body.id as string;
    expect(created.body.title).toBe("Standup");
    expect((await client.send("PUT", `/api/recordings/${id}/pieces/0`, undefined, Buffer.from("aa"))).status).toBe(200);
    const early = await client.post(`/api/recordings/${id}/finish`, { pieces: 2, duration: 61 });
    expect(early.status).toBe(409);
    expect(early.body.missing).toEqual([1]);
    expect((await client.send("PUT", `/api/recordings/${id}/pieces/1`, undefined, Buffer.from("bb"))).status).toBe(200);
    expect((await client.post(`/api/recordings/${id}/finish`, { pieces: 2, duration: 61 })).body.status).toBe("queued");
    expect((await client.send("PUT", `/api/recordings/${id}/pieces/2`, undefined, Buffer.from("cc"))).status).toBe(409);
    await recordings.idle();
    const list = await client.get("/api/meetings");
    expect(list.body.meetings).toEqual([{ id: "meetings/standup", kind: "transcript", title: "Standup", recorded: "2026-11-09T06:30:00.000Z", duration: 61, status: "new" }]);
    const transcript = await client.get("/api/transcript?slug=meetings/standup");
    expect(transcript.body.body).toBe("[00:00:01] hello there");
  });

  it("refuses bad pieces and unknown recordings", async () => {
    const id = (await client.post("/api/recordings", {})).body.id as string;
    expect((await client.send("PUT", `/api/recordings/${id}/pieces/100000`, undefined, Buffer.from("a"))).status).toBe(400);
    expect((await client.send("PUT", "/api/recordings/unknown-id-123/pieces/0", undefined, Buffer.from("a"))).status).toBe(404);
    expect((await client.post("/api/recordings/unknown-id-123/finish", { pieces: 1 })).status).toBe(404);
    expect((await client.post(`/api/recordings/${id}/finish`, { pieces: 0 })).status).toBe(409);
  });

  it("renames, retries and discards recordings", async () => {
    const id = (await client.post("/api/recordings", {})).body.id as string;
    expect((await client.post(`/api/recordings/${id}/title`, { title: "Roadmap" })).status).toBe(200);
    expect((await client.post(`/api/recordings/${id}/title`, { title: " " })).status).toBe(409);
    expect((await client.post(`/api/recordings/${id}/retry`)).status).toBe(409);
    const list = await client.get("/api/meetings");
    expect(list.body.meetings[0]).toMatchObject({ id, kind: "recording", title: "Roadmap", status: "recording" });
    expect((await client.send("DELETE", `/api/recordings/${id}`)).status).toBe(200);
    expect((await client.send("DELETE", `/api/recordings/${id}`)).status).toBe(409);
  });

  it("serves, renames and marks only meeting transcripts", async () => {
    await saveTranscript(vault, { title: "Sync", recorded: new Date("2026-11-09T07:00:00Z"), duration: 60, segments: [], capture: "c1" });
    await saveTranscript(vault, { title: "Other", recorded: new Date("2026-11-09T08:00:00Z"), duration: 60, segments: [], capture: "c2" });
    await addNote(vault, { title: "Secret", body: "private", folder: "meetings" });
    await addNote(vault, { title: "Diary", body: "private" });
    expect((await client.get("/api/transcript?slug=diary")).status).toBe(404);
    expect((await client.get("/api/transcript?slug=meetings/secret")).status).toBe(404);
    expect((await client.get("/api/transcript?slug=meetings/../diary")).status).toBe(404);
    expect((await client.get("/api/transcript")).status).toBe(404);
    expect((await client.post("/api/transcript/status", { slug: "meetings/sync", status: "read" })).status).toBe(200);
    expect((await client.get("/api/transcript?slug=meetings/sync")).body.status).toBe("read");
    expect((await client.post("/api/transcript/status", { slug: "meetings/sync", status: "new" })).status).toBe(200);
    expect((await client.post("/api/transcript/title", { slug: "meetings/sync", title: "" })).status).toBe(400);
    expect((await client.post("/api/transcript/title", { slug: "meetings/sync", title: "Other" })).status).toBe(409);
    const renamed = await client.post("/api/transcript/title", { slug: "meetings/sync", title: "Design sync" });
    expect(renamed.body.slug).toBe("meetings/design-sync");
    expect(await fs.readFile(join(vault, "notes", "meetings", "design-sync.md"), "utf8")).toContain("title: Design sync");
  });
});
