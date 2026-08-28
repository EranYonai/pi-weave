/**
 * Routes, over a real socket (weave-workspace §5.3, §5.4, §10).
 *
 * A real `node:http` server on port 0 and real `fetch`, against a temp vault
 * and a temp git repo. Not a mocked `ServerResponse`: half of what this
 * suite is for lives *between* the handler and the socket — status codes,
 * header casing, the `304` with no body, the redirect the runtime performs
 * for us — and a mock would assert our own beliefs about `http` rather than
 * its behaviour.
 *
 * ## The cookie problem, and why every request here is explicit
 *
 * `fetch` in Node does not manage a cookie jar, which is a feature for this
 * suite: the token is sent explicitly on every request, so a test that
 * *should* be rejected cannot pass by accident on a cookie some earlier test
 * left behind. {@link get}/{@link post} attach it; {@link raw} does not, and
 * that distinction is the whole 403 table.
 *
 * ## No fixed ports
 *
 * Every server binds `listen(0)`. A fixed port is a flaky test on a busy
 * machine and a squattable port in production.
 */

import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceCache } from "../../src/core/cache/workspace";
import type { GraphModel as CoreGraphModel } from "../../src/core/graph/model";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import { addNote } from "../../src/core/vault";
import { DEFAULT_COOKIE_NAME } from "../../src/web/server/security";
import {
  MAX_BODY_BYTES,
  graphStamp,
  parseSaveRequest,
  parseTarget,
  stampPayload,
  toGraphPayload,
  type SseHub,
  type Watcher,
} from "../../src/web/server/routes";
import {
  DEFAULT_IDLE_MS,
  defaultBundlePath,
  startWorkspaceServer,
  type StartWorkspaceServerOptions,
  type TimerHandle,
  type WorkspaceServer,
} from "../../src/web/server/server";
import type { ConflictPayload, GraphPayload, NotePayload, OkfFilePayload, SearchPayload } from "../../src/web/shared/wire";
import { WIRE_MODEL_OMITTED_KEYS } from "../../src/web/shared/wire";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";

/** The exact §5.2 policy, with the nonce elided. Asserted byte-for-byte. */
const CSP_TEMPLATE =
  "default-src 'none'; script-src 'nonce-{N}'; style-src 'nonce-{N}'; " +
  "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TOKEN = "test-token-" + "x".repeat(32);

const running: WorkspaceServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

interface Fixture {
  server: WorkspaceServer;
  cwd: string;
  vaultRoot: string;
}

interface Workspace {
  cwd: string;
  vaultRoot: string;
}

/**
 * The temp vault + indexed git repo, built **once** for the whole file.
 *
 * A git init plus a commit plus a repo-index build is ~300 ms, and this
 * suite boots a server per test. Rebuilding the fixture each time made the
 * file take 23 seconds to assert things that are all read-only. Binding a
 * fresh server on port 0 over a shared workspace is a couple of
 * milliseconds and preserves the property that matters — every test gets
 * its own port, its own security policy, and its own cache.
 *
 * The two tests that *do* mutate the workspace (a new note; a new file next
 * to `.okf`) build their own via {@link freshWorkspace}, so nothing here is
 * order-dependent.
 */
let shared: Promise<Workspace> | null = null;

function sharedWorkspace(): Promise<Workspace> {
  shared ??= freshWorkspace();
  return shared;
}

async function freshWorkspace(): Promise<Workspace> {
  const cwd = await makeTempDir();
  const vaultRoot = await makeTempDir();

  gitInit(cwd);
  await writeFixture(cwd, "src/index.ts", "export const x = 1;\n");
  await writeFixture(cwd, "README.md", "# fixture\n");
  commitAll(cwd);
  const index = await buildRepoIndex(cwd);
  // `null` means no commits or an unlistable tree — the fixture just
  // committed, so this is a broken fixture rather than a case to handle.
  if (index === null) throw new Error("fixture: buildRepoIndex returned null");
  await writeRepoIndex(cwd, index);

  await addNote(vaultRoot, { title: "Alpha Note", body: "the body of alpha", tags: ["t1"], source: "human" });
  await addNote(vaultRoot, { title: "Beta Note", body: "beta content here", tags: [], source: "agent" });
  return { cwd, vaultRoot };
}

/** Bind a server on an ephemeral port over the shared workspace. */
async function boot(over: Partial<StartWorkspaceServerOptions> = {}): Promise<Fixture> {
  return bootOn(await sharedWorkspace(), over);
}

/** Bind a server over a workspace only this test will touch. */
async function bootFresh(over: Partial<StartWorkspaceServerOptions> = {}): Promise<Fixture> {
  return bootOn(await freshWorkspace(), over);
}

async function bootOn(ws: Workspace, over: Partial<StartWorkspaceServerOptions>): Promise<Fixture> {
  const server = await startWorkspaceServer({
    cwd: ws.cwd,
    vaultRoot: ws.vaultRoot,
    token: TOKEN,
    // Never shell out to a real editor from a test.
    openNote: async (slug) => slug === "alpha-note",
    ...over,
  });
  running.push(server);
  return { server, ...ws };
}

/** An authenticated GET: cookie attached, Origin omitted (a navigation). */
function get(server: WorkspaceServer, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(server.url + path, {
    ...init,
    headers: { cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`, ...(init.headers as Record<string, string> | undefined) },
  });
}

/** An authenticated POST: cookie and Origin both attached, as a browser sends. */
function post(server: WorkspaceServer, path: string, body: unknown): Promise<Response> {
  return fetch(server.url + path, {
    method: "POST",
    headers: {
      cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`,
      origin: server.url,
      "content-type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** No credentials at all — the shape a local prober or a rebound page sends. */
function raw(server: WorkspaceServer, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(server.url + path, init);
}

/** An authenticated write under an arbitrary method — `DELETE`, mostly. */
function send(server: WorkspaceServer, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(server.url + path, {
    method,
    headers: {
      cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`,
      origin: server.url,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

/**
 * Write a note file **byte-exactly**, bypassing `addNote`.
 *
 * The point of the P5 exit criterion is what an *external* editor writes, and
 * `addNote` can only produce the canonical five-key block. Anything with an
 * `aliases:`, a `cssclass:` or a `tags:` block list has to be written the way
 * Obsidian writes it, which is as bytes.
 */
async function writeNoteFile(vaultRoot: string, slug: string, frontMatter: string[], body: string): Promise<string> {
  const path = join(vaultRoot, "notes", `${slug}.md`);
  await fs.mkdir(join(vaultRoot, "notes"), { recursive: true });
  const text = ["---", ...frontMatter, "---", "", body, ""].join("\n");
  await fs.writeFile(path, text, "utf8");
  return text;
}

/** Read a note file back verbatim. */
function readNoteFile(vaultRoot: string, slug: string): Promise<string> {
  return fs.readFile(join(vaultRoot, "notes", `${slug}.md`), "utf8");
}

/**
 * Read a file synchronously, or `""`.
 *
 * Synchronous because it runs *inside* a `suppress` callback, which is how
 * the suppression-ordering test observes the file as it was at the moment
 * the window opened. An `await` there would let the write land first and the
 * assertion would pass whichever order the code actually used.
 */
function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// --- pure helpers --------------------------------------------------------------

describe("parseTarget", () => {
  const cases: Array<[url: string, path: string | null, q: string | null]> = [
    ["/", "/", null],
    ["/api/graph", "/api/graph", null],
    ["/api/search?q=hello", "/api/search", "hello"],
    ["/api/search?q=", "/api/search", ""],
    ["/api/search", "/api/search", null],
    ["/api/search?x=1&q=two", "/api/search", "two"],
    ["/api/note/a%20b", "/api/note/a b", null],
    // Decoding happens before matching, which is the correct order: matching
    // on the raw string and decoding afterwards is exactly how `%2e%2e%2f`
    // slips past a prefix check.
    ["/api/okf/%2e%2e%2fescape", "/api/okf/../escape", null],
    ["", "/", null],
    // Malformed percent-encoding must be a 404, not a 500.
    ["/%", null, null],
    ["/%zz", null, null],
    ["/api/note/%E0%A4%A", null, null],
  ];

  for (const [url, path, q] of cases) {
    it(`${JSON.stringify(url)} → path ${JSON.stringify(path)}`, () => {
      const target = parseTarget(url);
      expect(target.path).toBe(path);
      expect(target.query.get("q")).toBe(q);
    });
  }
});

describe("toGraphPayload", () => {
  const EMPTY: CoreGraphModel = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    staleness: null,
    nodes: [],
    edges: [],
    danglingLinks: {},
  };

  it("carries a content digest as the stamp and leaves positions to the client", () => {
    // §15.6: `stamp` is a digest of the payload, not `generatedAt`. It is
    // opaque, so this asserts its *shape* and its independence from the
    // timestamp rather than pinning a literal hash — a pinned hash would
    // turn every legitimate wire-shape change into a mystery failure here.
    const payload = toGraphPayload(EMPTY);
    expect(payload).toEqual({
      model: { generatedAt: "2026-01-01T00:00:00.000Z", staleness: null, nodes: [], edges: [] },
      tags: {},
      dangling: {},
      positions: null,
      stamp: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
    });
    expect(payload.stamp).not.toBe(payload.model.generatedAt);
  });

  it("changes the stamp when only `generatedAt` moves", () => {
    // The digest covers the whole payload, and `generatedAt` is part of the
    // model — so the case the old stamp got *right* must keep working.
    const later = toGraphPayload({ ...EMPTY, generatedAt: "2026-06-01T00:00:00.000Z" });
    expect(later.stamp).not.toBe(toGraphPayload(EMPTY).stamp);
  });

  it("changes the stamp when only `tags` moves (§4.3)", () => {
    // `tags` is a top-level payload field the old timestamp stamp could not
    // see at all: editing front matter does not have to move `updated`.
    const before = toGraphPayload(EMPTY, [{ slug: "a", tags: ["before"] }]);
    const after = toGraphPayload(EMPTY, [{ slug: "a", tags: ["afterwards"] }]);
    expect(before.tags).not.toEqual(after.tags);
    expect(before.stamp).not.toBe(after.stamp);
  });

  it("changes the stamp when only `dangling` moves (§4.2)", () => {
    const before = toGraphPayload({ ...EMPTY, danglingLinks: { a: ["ghost"] } });
    const after = toGraphPayload({ ...EMPTY, danglingLinks: { a: ["phantom"] } });
    expect(before.stamp).not.toBe(after.stamp);
  });

  it("changes the stamp when a node is added or removed", () => {
    const node = { id: "note:a", kind: "note", label: "A", provenance: null, detail: {} } as const;
    const withNode = toGraphPayload({ ...EMPTY, nodes: [{ ...node }] });
    expect(withNode.stamp).not.toBe(toGraphPayload(EMPTY).stamp);
  });

  it("graphStamp agrees with the stamp the route serves, and is memoized", () => {
    // The §6 consistency requirement at its source: the SSE bridge asks
    // `graphStamp` for the frame's dedupe key and the route puts its own
    // digest in the ETag. If those two ever disagreed, every frame would
    // trigger a refetch whose validator could never match — so they are one
    // function, and this pins that.
    const snapshot = {
      model: { ...EMPTY, danglingLinks: {} },
      notes: [{ slug: "a", tags: ["t"] }],
    } as unknown as Parameters<typeof graphStamp>[0];

    const stamp = graphStamp(snapshot);
    expect(stamp).toBe(toGraphPayload(snapshot.model, snapshot.notes).stamp);
    // Same object in, same answer out — and the second call is a memo hit.
    expect(graphStamp(snapshot)).toBe(stamp);
  });

  it("is deterministic across independent builds of identical input", () => {
    // The property the whole cache key rests on: no wall clock, no iteration
    // order that depends on how the object was assembled, no locale.
    expect(toGraphPayload(EMPTY, [{ slug: "a", tags: ["t"] }]).stamp).toBe(
      toGraphPayload(EMPTY, [{ slug: "a", tags: ["t"] }]).stamp,
    );
  });

  it("does not fold a previous stamp into the next one", () => {
    // Stamping is idempotent: re-stamping an already-stamped payload must
    // reproduce the same digest, or the value would depend on how many times
    // it had passed through.
    const once = toGraphPayload(EMPTY, [{ slug: "a", tags: ["t"] }]);
    expect(stampPayload(once).stamp).toBe(once.stamp);
  });

  it("hoists danglingLinks to `dangling` (§4.2)", () => {
    const payload = toGraphPayload({ ...EMPTY, danglingLinks: { alpha: ["ghost", "phantom"] } });
    expect(payload.dangling).toEqual({ alpha: ["ghost", "phantom"] });
  });

  it("strips the core-only keys from `model` rather than shipping them twice", () => {
    // The narrowing in `WireGraphModel` is a type-level claim; structural
    // typing would let the extra property ride into `JSON.stringify` unless
    // something deletes it. This is that something.
    const payload = toGraphPayload({ ...EMPTY, danglingLinks: { alpha: ["ghost"] } });
    for (const key of WIRE_MODEL_OMITTED_KEYS) {
      expect(key in payload.model).toBe(false);
    }
    // And the serialized form agrees — the property that actually matters.
    expect(JSON.parse(JSON.stringify(payload)).model).not.toHaveProperty("danglingLinks");
  });

  it("does not mutate the model it was handed", () => {
    // The cache hands out the *same* model object to every caller until
    // something invalidates it, so a payload builder that deleted keys in
    // place would corrupt the cache for the TUI and for the next request.
    const model: CoreGraphModel = { ...EMPTY, danglingLinks: { alpha: ["ghost"] } };
    toGraphPayload(model);
    expect(model.danglingLinks).toEqual({ alpha: ["ghost"] });
  });

  // --- §4.3: tags ----------------------------------------------------------

  it("builds `tags` from the notes, not from the graph's display string", () => {
    const payload = toGraphPayload(EMPTY, [
      { slug: "a", tags: ["arch", "viewer"] },
      { slug: "b", tags: ["arch"] },
    ]);
    expect(payload.tags).toEqual({ arch: ["a", "b"], viewer: ["a"] });
  });

  it("emits tag keys in count-desc, tag-asc order", () => {
    // `Object.fromEntries` preserves insertion order for string keys, so the
    // ranking `deriveTagIndex` computed survives onto the wire as key order.
    const payload = toGraphPayload(EMPTY, [
      { slug: "a", tags: ["zebra", "hot"] },
      { slug: "b", tags: ["hot"] },
      { slug: "c", tags: ["alpha", "hot"] },
    ]);
    expect(Object.keys(payload.tags)).toEqual(["hot", "alpha", "zebra"]);
  });

  it("ships `{}` when no notes are supplied", () => {
    // The documented default: a caller with no note list gets an empty index
    // rather than a wrong one.
    expect(toGraphPayload(EMPTY).tags).toEqual({});
    expect(toGraphPayload(EMPTY, []).tags).toEqual({});
  });

  it("omits notes that carry no tags", () => {
    expect(toGraphPayload(EMPTY, [{ slug: "bare", tags: [] }]).tags).toEqual({});
  });

  it("is byte-stable for the same tag memberships in a different note order", () => {
    // This rides an ETag, so the serialization must not depend on note order.
    const forward = toGraphPayload(EMPTY, [{ slug: "a", tags: ["t"] }, { slug: "b", tags: ["t"] }]);
    const reverse = toGraphPayload(EMPTY, [{ slug: "b", tags: ["t"] }, { slug: "a", tags: ["t"] }]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });
});

// --- the shell -----------------------------------------------------------------

describe("GET /", () => {
  it("serves the shell with the exact §5.2 CSP", async () => {
    const { server } = await boot();
    const res = await get(server, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    // Byte-for-byte, with only the nonce normalised away. A policy that
    // drifts silently has already stopped protecting anything.
    const nonce = /'nonce-([^']+)'/.exec(csp ?? "")?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toBe(CSP_TEMPLATE.replaceAll("{N}", nonce ?? ""));

    const html = await res.text();
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain('<div id="app"');
  });

  it("mints a different nonce for every response", async () => {
    const { server } = await boot();
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await get(server, "/");
      await res.text();
      nonces.add(/'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1] ?? "");
    }
    expect(nonces.size).toBe(5);
  });

  it("is never cached — a cached nonce would not match a fresh CSP header", async () => {
    const { server } = await boot();
    const res = await get(server, "/");
    await res.text();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("bootstraps the client with the cwd, the vault root and the session", async () => {
    const { server, cwd, vaultRoot } = await boot();
    const html = await (await get(server, "/")).text();
    const open = html.indexOf(">", html.indexOf('<script type="application/json"')) + 1;
    const boot0 = JSON.parse(html.slice(open, html.indexOf("</script>", open)));
    expect(boot0).toEqual({ cwd, vaultRoot, session: server.session });
  });
});

// --- the bundle -----------------------------------------------------------------

describe("GET /app.js", () => {
  it("serves the committed bundle with no-store", async () => {
    const { server } = await boot();
    const res = await get(server, "/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // §5.3: the artifact changes on rebuild and the server may outlive one.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(await fs.readFile(defaultBundlePath(), "utf8"));
  });

  it("404s with an actionable message when the bundle is missing", async () => {
    const { server } = await boot({ bundlePath: "/nonexistent/app.js" });
    const res = await get(server, "/app.js");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("npm run build:web");
  });
});

// --- the graph ------------------------------------------------------------------

describe("GET /api/graph", () => {
  it("returns a GraphPayload stamped with a content digest, ETag'd strongly", async () => {
    const { server } = await boot();
    const res = await get(server, "/api/graph");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as GraphPayload;
    // §15.6: a digest of the payload, *not* the data-as-of timestamp, which
    // remains available on the model for anything that wants to show a time.
    expect(payload.stamp).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.stamp).not.toBe(payload.model.generatedAt);
    expect(payload.model.generatedAt).not.toBe("");
    // Strong, with no `W/` prefix: the digest was taken over the exact bytes
    // sent, so it is a byte-equality claim and may honestly say so.
    expect(res.headers.get("etag")).toBe(`"${payload.stamp}"`);
    expect(res.headers.get("etag")?.startsWith("W/")).toBe(false);
    expect(payload.model.nodes.length).toBeGreaterThan(0);
    // §4.3, no longer `{}`: the fixture's "Alpha Note" carries `t1`, and the
    // slug — not the node id — is what the index reports.
    expect(payload.tags).toEqual({ t1: ["alpha-note"] });
    // §4.2. The fixture's notes have no wiki-links at all, so nothing
    // dangles; that is an empty map for the right reason, not a stub.
    expect(payload.dangling).toEqual({});
    // Still null by design (§7.3): the server tier cannot import d3-force.
    expect(payload.positions).toBeNull();
    expect(res.headers.get("etag")).toBe(`"${payload.stamp}"`);
    // `no-cache`, not `no-store`: the client should keep the body and
    // revalidate, which is the entire point of the ETag.
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves tags and dangling built from the live vault (§4.2, §4.3)", async () => {
    // End-to-end rather than through `toGraphPayload` directly: this is the
    // path that proves the route reaches the *notes*, not just the model.
    const ws = await freshWorkspace();
    await addNote(ws.vaultRoot, {
      title: "Ghosted",
      body: "points at [[nowhere]]",
      tags: ["shared", "solo"],
      source: "human",
    });
    await addNote(ws.vaultRoot, { title: "Plain", body: "no links", tags: ["shared"], source: "agent" });
    const { server } = await bootOn(ws, {});

    const payload = (await (await get(server, "/api/graph")).json()) as GraphPayload;
    // `shared` is on two notes and sorts before the single-note tags.
    expect(Object.keys(payload.tags)[0]).toBe("shared");
    expect(payload.tags.shared).toEqual(["ghosted", "plain"]);
    expect(payload.tags.solo).toEqual(["ghosted"]);
    // The ghost target survives to the client as a name, not a count.
    expect(payload.dangling.ghosted).toEqual(["nowhere"]);
    // Every tagged slug is a real note node — the guarantee `snapshot()` buys.
    const slugs = new Set(payload.model.nodes.filter((n) => n.kind === "note").map((n) => n.detail.slug));
    for (const list of Object.values(payload.tags)) {
      for (const slug of list) expect(slugs.has(slug)).toBe(true);
    }
  });

  // --- §15.6, resolved: the three cases a timestamp stamp could not see -----
  //
  // These were one test asserting the bug ("KNOWN LIMITATION: the stamp
  // misses an edit that does not move `updated`"). Each is now a positive
  // assertion of the fix. What makes all three reachable is that none of them
  // advances `max(updated)`: a hand-edit (or any writer that leaves the field
  // alone) changes the payload while the old stamp stood still, so the client
  // was told `304` and kept stale data.
  //
  // Every case asserts the same three things, because all three are the bug:
  // the payload really did change, the stamp moved with it, and the
  // conditional GET on the old validator now answers `200` rather than `304`.

  it("§15.6 case 1: a note body edit that does not move `updated` busts the cache", async () => {
    const ws = await freshWorkspace();
    await addNote(ws.vaultRoot, { title: "Edited", body: "original body", tags: [], source: "human" });
    const { server } = await bootOn(ws, {});

    const firstRes = await get(server, "/api/graph");
    const firstEtag = firstRes.headers.get("etag") ?? "";
    const first = (await firstRes.json()) as GraphPayload;

    // Rewrite the body in place, leaving the front matter — and therefore
    // `updated` — untouched. The replacement is a different length so the
    // cache's mtime+size check notices the file, isolating the behaviour
    // under test to the *stamp* rather than to note caching.
    const file = join(ws.vaultRoot, "notes", "edited.md");
    const original = await fs.readFile(file, "utf8");
    const edited = original.replace("original body", "COMPLETELY DIFFERENT TEXT");
    expect(edited).not.toBe(original); // guard: the fixture's format changed
    await fs.writeFile(file, edited, "utf8");

    const conditional = await get(server, "/api/graph", { headers: { "if-none-match": firstEtag } });
    expect(conditional.status).toBe(200);
    const second = (await conditional.json()) as GraphPayload;

    // `generatedAt` deliberately did *not* move — which is precisely why the
    // old stamp missed this — and the digest moved anyway.
    expect(second.model.generatedAt).toBe(first.model.generatedAt);
    expect(second.stamp).not.toBe(first.stamp);
    expect(conditional.headers.get("etag")).toBe(`"${second.stamp}"`);
    const preview = (p: GraphPayload): unknown =>
      p.model.nodes.find((n) => n.detail.slug === "edited")?.detail.preview;
    expect(preview(second)).not.toBe(preview(first));
  });

  it("§15.6 case 2: a front-matter tag edit that does not move `updated` busts the cache", async () => {
    const ws = await freshWorkspace();
    await addNote(ws.vaultRoot, { title: "Edited", body: "b", tags: ["before"], source: "human" });
    const { server } = await bootOn(ws, {});

    const firstRes = await get(server, "/api/graph");
    const firstEtag = firstRes.headers.get("etag") ?? "";
    const first = (await firstRes.json()) as GraphPayload;
    expect(first.tags).toHaveProperty("before");

    const file = join(ws.vaultRoot, "notes", "edited.md");
    const original = await fs.readFile(file, "utf8");
    const edited = original.replace("tags: [before]", "tags: [afterwards]");
    expect(edited).not.toBe(original); // guard: the fixture's format changed
    await fs.writeFile(file, edited, "utf8");

    const conditional = await get(server, "/api/graph", { headers: { "if-none-match": firstEtag } });
    expect(conditional.status).toBe(200);
    const second = (await conditional.json()) as GraphPayload;

    // The widened blast radius §15.6 warned about: a stale `tags` map is a
    // tag chip pointing at a note that no longer carries it.
    expect(second.tags).toHaveProperty("afterwards");
    expect(second.tags).not.toHaveProperty("before");
    expect(second.model.generatedAt).toBe(first.model.generatedAt);
    expect(second.stamp).not.toBe(first.stamp);
  });

  it("§15.6 case 3: deleting a non-newest note busts the cache", async () => {
    const ws = await freshWorkspace();
    await addNote(ws.vaultRoot, { title: "Older", body: "o", source: "human" });
    // Strictly newer, so deleting "Older" cannot move max(updated) — the
    // whole point of the case.
    await addNote(ws.vaultRoot, {
      title: "Newest",
      body: "n",
      source: "human",
      now: new Date(Date.now() + 60_000),
    });
    const { server } = await bootOn(ws, {});

    const firstRes = await get(server, "/api/graph");
    const firstEtag = firstRes.headers.get("etag") ?? "";
    const first = (await firstRes.json()) as GraphPayload;

    await fs.rm(join(ws.vaultRoot, "notes", "older.md"));

    const conditional = await get(server, "/api/graph", { headers: { "if-none-match": firstEtag } });
    expect(conditional.status).toBe(200);
    const second = (await conditional.json()) as GraphPayload;

    const noteCount = (p: GraphPayload): number => p.model.nodes.filter((n) => n.kind === "note").length;
    expect(noteCount(second)).toBe(noteCount(first) - 1);
    expect(second.model.generatedAt).toBe(first.model.generatedAt);
    expect(second.stamp).not.toBe(first.stamp);
  });

  it("still answers 304 when nothing changed at all", async () => {
    // The other half of the contract, and the reason a digest that always
    // changes would be just as wrong as one that never does: the fix must
    // not have quietly disabled caching. A rebuild is forced so this is a
    // genuine re-derivation of the digest, not a memo hit.
    const { server } = await bootFresh();
    const first = await get(server, "/api/graph");
    const etag = first.headers.get("etag") ?? "";
    await first.json();

    server.cache.invalidateAll();

    const second = await get(server, "/api/graph", { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("derives the same digest from two independent servers over identical input", async () => {
    // Determinism across processes, in the only form a test can observe it:
    // two caches and two servers, built independently over the same bytes.
    // If key ordering or any locale-sensitive sort leaked into the payload,
    // these would differ and every client's cache would miss forever.
    const ws = await freshWorkspace();
    await addNote(ws.vaultRoot, { title: "Determinism", body: "[[ghost]] [[other]]", tags: ["b", "a"], source: "human" });

    const one = await bootOn(ws, { cache: new WorkspaceCache({ cwd: ws.cwd, vaultRoot: ws.vaultRoot }) });
    const two = await bootOn(ws, { cache: new WorkspaceCache({ cwd: ws.cwd, vaultRoot: ws.vaultRoot }) });

    const a = (await (await get(one.server, "/api/graph")).json()) as GraphPayload;
    const b = (await (await get(two.server, "/api/graph")).json()) as GraphPayload;
    expect(a.stamp).toBe(b.stamp);
  });

  it("a warm request re-uses the memoized rendering: zero extra hashing (§4.1)", async () => {
    // §4.1's promise is that a no-change rebuild does zero note reads and
    // zero git spawns; §15.6 adds "and no re-hashing" to that list, since the
    // digest would otherwise be the one cost that scaled with request rate.
    //
    // Asserted through observable behaviour rather than a timer: the cache
    // hands back the *identical* snapshot object while nothing has moved, and
    // the route memoizes its serialization against that identity. Same
    // object ⇒ the `WeakMap` hit ⇒ no `JSON.stringify` and no `createHash`.
    // A timing assertion would be flaky on a loaded CI box and would prove
    // less.
    const ws = await freshWorkspace();
    const cache = new WorkspaceCache({ cwd: ws.cwd, vaultRoot: ws.vaultRoot });
    const { server } = await bootOn(ws, { cache });

    const first = await get(server, "/api/graph");
    const etag = first.headers.get("etag") ?? "";
    await first.json();
    const warmed = await cache.snapshot();

    const statsBefore = cache.stats();
    for (let i = 0; i < 3; i += 1) {
      const res = await get(server, "/api/graph", { headers: { "if-none-match": etag } });
      expect(res.status).toBe(304);
      await res.text();
    }
    const statsAfter = cache.stats();

    // The snapshot identity is stable, which is what the memo keys on.
    expect(await cache.snapshot()).toBe(warmed);
    // And §4.1's original guarantees still hold on that path.
    expect(statsAfter.notesRead).toBe(statsBefore.notesRead);
    expect(statsAfter.gitCalls).toBe(statsBefore.gitCalls);
  });

  it("answers 304 with an empty body when If-None-Match matches", async () => {
    const { server } = await boot();
    const first = await get(server, "/api/graph");
    const etag = first.headers.get("etag") ?? "";
    await first.json();

    const second = await get(server, "/api/graph", { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("accepts a weak validator and a list, and honours *", async () => {
    const { server } = await boot();
    const etag = (await get(server, "/api/graph")).headers.get("etag") ?? "";
    for (const header of [`W/${etag}`, `"other", ${etag}`, "*", `${etag} , "x"`]) {
      const res = await get(server, "/api/graph", { headers: { "if-none-match": header } });
      expect(res.status, header).toBe(304);
    }
  });

  it("returns 200 for a non-matching validator", async () => {
    const { server } = await boot();
    for (const header of ['"stale"', '"a", "b"', ""]) {
      const res = await get(server, "/api/graph", { headers: { "if-none-match": header } });
      expect(res.status, header).toBe(200);
      await res.json();
    }
  });

  it("moves the stamp when a note changes, so the 304 stops being served", async () => {
    // The property that makes conditional GET correct rather than merely
    // plausible: `generatedAt` is derived from input timestamps.
    const { server, vaultRoot } = await bootFresh();
    const before = (await get(server, "/api/graph")).headers.get("etag") ?? "";

    await addNote(vaultRoot, { title: "Gamma", body: "new", tags: [], source: "human", now: new Date(Date.now() + 60_000) });
    server.cache.invalidateAll();

    const res = await get(server, "/api/graph", { headers: { "if-none-match": before } });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(before);
    await res.json();
  });

  // `snapshot()`, not `graph()`: the route reads the graph *and* the notes it
  // was built from in one call (§4.3), so that is the method whose failure
  // has to reach the client as a 500.
  it("surfaces a cache failure as a 500, not a hung socket", async () => {
    const ws = await sharedWorkspace();
    const cache = new WorkspaceCache({ cwd: ws.cwd, vaultRoot: ws.vaultRoot });
    cache.snapshot = () => Promise.reject(new Error("disk on fire"));
    const { server } = await boot({ cache });

    const res = await get(server, "/api/graph");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("disk on fire");
  });

  it("surfaces a non-Error throw as a 500 too", async () => {
    const ws = await sharedWorkspace();
    const cache = new WorkspaceCache({ cwd: ws.cwd, vaultRoot: ws.vaultRoot });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    cache.snapshot = () => Promise.reject("a bare string");
    const { server } = await boot({ cache });
    const res = await get(server, "/api/graph");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("a bare string");
  });

  it("ends the socket rather than hanging when a handler throws after writing headers", async () => {
    // The un-rescuable case: headers are already on the wire, so there is no
    // status left to send. Leaving the socket open would hang the browser
    // tab on a response that is never coming.
    const ws = await sharedWorkspace();
    const cache = new WorkspaceCache({ cwd: ws.cwd, vaultRoot: ws.vaultRoot });
    const { server } = await boot({
      cache,
      sse: {
        attach: (_req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          throw new Error("boom after headers");
        },
        broadcast: () => {},
        clientCount: () => 0,
        close: () => {},
      },
      idleMs: 0,
    });
    const res = await get(server, "/events");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

// --- notes ------------------------------------------------------------------------

describe("GET /api/note/:slug", () => {
  it("returns the note and its revision", async () => {
    const { server } = await boot();
    const res = await get(server, "/api/note/alpha-note");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as NotePayload;
    expect(payload.note).toMatchObject({ slug: "alpha-note", title: "Alpha Note", source: "human" });
    // Opaque by contract, so this asserts only that it is a non-empty string
    // — pinning its shape here would re-create the coupling core's own doc
    // comment forbids.
    expect(typeof payload.revision).toBe("string");
    expect(payload.revision.length).toBeGreaterThan(0);
  });

  it("never puts the raw front-matter block on the wire", async () => {
    // `Note.frontMatter` carries a user's unknown keys verbatim (P5a). It
    // must not cross the boundary: a client that receives it is a client that
    // might send it back, and preservation would stop being a property core
    // enforces by re-reading the file and become one the browser is trusted
    // to have got right.
    const { server, vaultRoot } = await bootFresh();
    await writeNoteFile(vaultRoot, "fm", ["title: Fm", "aliases: [Other]", "source: human"], "b");

    const payload = (await (await get(server, "/api/note/fm")).json()) as NotePayload;
    expect(Object.keys(payload.note).sort()).toEqual(["body", "created", "slug", "source", "tags", "title", "updated"]);
    expect(JSON.stringify(payload)).not.toContain("aliases");
  });

  it("404s for a missing note", async () => {
    const { server } = await boot();
    const res = await get(server, "/api/note/no-such-note");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such note" });
  });

  describe("path traversal", () => {
    // Every one of these is a real attempt at reaching outside
    // `<vault>/notes/`. They must all 404 — and, more importantly, must all
    // be refused by `resolveNotePath` before anything touches the disk,
    // which is why the route does no path arithmetic of its own.
    const attempts = [
      "../escape",
      "../../etc/passwd",
      "%2e%2e%2fescape", // encoded, decoded before matching
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "..%2fescape",
      "%2E%2E%2Fescape", // uppercase hex
      "a/../../escape",
      "nested/note",
      "/etc/passwd",
      "....//escape",
      ".",
      "..",
      "",
      "%00",
    ];

    for (const attempt of attempts) {
      it(`refuses ${JSON.stringify(attempt)}`, async () => {
        const { server } = await boot();
        const res = await get(server, `/api/note/${attempt}`);
        expect([404]).toContain(res.status);
        const body = await res.text();
        // Never leak a filesystem path or a file's contents in the refusal.
        expect(body).not.toContain("root:");
        expect(body).not.toContain("/etc");
      });
    }

    it("cannot escape via an absolute-looking slug on any platform", async () => {
      const { server } = await boot();
      // A note actually exists next to the vault; reaching it would prove
      // the guard is prefix-matching rather than resolving.
      const res = await get(server, "/api/note/..%2f..%2fetc%2fhosts");
      expect(res.status).toBe(404);
    });
  });
});

// --- writes (P5) ---------------------------------------------------------------------

/** Boot over a private vault holding one note, and read its revision. */
async function bootWritable(over: Partial<StartWorkspaceServerOptions> = {}): Promise<Fixture & { revision: string }> {
  const fixture = await bootFresh(over);
  const payload = (await (await get(fixture.server, "/api/note/alpha-note")).json()) as NotePayload;
  return { ...fixture, revision: payload.revision };
}

describe("parseSaveRequest", () => {
  it("accepts the three shapes a save can take", () => {
    expect(parseSaveRequest({})).toEqual({});
    expect(parseSaveRequest({ body: "text" })).toEqual({ body: "text" });
    expect(parseSaveRequest({ meta: { title: "T", tags: ["a"], source: "agent" }, expectedRevision: "r" })).toEqual({
      meta: { title: "T", tags: ["a"], source: "agent" },
      expectedRevision: "r",
    });
  });

  it("drops nothing it accepts and accepts nothing it should not", () => {
    // The allowlist is the security control, not a formality: `updateNote`
    // spreads `meta` straight over the note's front matter, so any key that
    // survives here reaches the file. `created` and `updated` are the two
    // that matter — one is not the caller's to set, the other is the
    // server's — and both must be silently absent rather than an error,
    // because a future client sending an extra field should not 400.
    const parsed = parseSaveRequest({ meta: { title: "T", created: "1970-01-01", updated: "1970-01-01" } });
    expect(parsed).toEqual({ meta: { title: "T" } });
  });

  it("rejects a malformed body rather than coercing it", () => {
    for (const bad of [
      null,
      42,
      "str",
      [],
      { body: 1 },
      { body: null },
      { expectedRevision: 7 },
      { meta: null },
      { meta: [] },
      { meta: "x" },
      { meta: { title: 1 } },
      { meta: { tags: "a" } },
      { meta: { tags: ["a", 2] } },
      { meta: { source: "verified" } },
      { meta: { source: null } },
    ]) {
      expect(parseSaveRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("POST /api/note/:slug", () => {
  it("writes the body and returns the note with a fresh revision", async () => {
    const { server, vaultRoot, revision } = await bootWritable();
    const res = await post(server, "/api/note/alpha-note", { body: "rewritten", expectedRevision: revision });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as NotePayload;
    expect(payload.note.body).toBe("rewritten");
    // The revision must describe the bytes now on disk, not the ones the
    // request was written against — otherwise the very next save from the
    // same editor would 409 against its own write.
    expect(payload.revision).not.toBe(revision);
    expect(await readNoteFile(vaultRoot, "alpha-note")).toContain("rewritten");
  });

  it("accepts a metadata-only save and bumps `updated`", async () => {
    const { server, revision } = await bootWritable();
    const before = (await (await get(server, "/api/note/alpha-note")).json()) as NotePayload;
    const res = await post(server, "/api/note/alpha-note", {
      meta: { title: "Renamed In Place", tags: ["x", "y"] },
      expectedRevision: revision,
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as NotePayload;
    expect(payload.note.title).toBe("Renamed In Place");
    expect(payload.note.tags).toEqual(["x", "y"]);
    expect(payload.note.body).toBe(before.note.body);
    expect(payload.note.updated).not.toBe(before.note.updated);
  });

  it("saves without a revision (last-write-wins is opt-in, and is how overwrite works)", async () => {
    const { server } = await bootWritable();
    const res = await post(server, "/api/note/alpha-note", { body: "clobbered" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as NotePayload).note.body).toBe("clobbered");
  });

  it("409s with the current note when the revision is stale", async () => {
    const { server, revision } = await bootWritable();
    // Someone else writes. The browser's held revision is now historical.
    await post(server, "/api/note/alpha-note", { body: "from the other writer" });

    const res = await post(server, "/api/note/alpha-note", { body: "from the browser", expectedRevision: revision });
    expect(res.status).toBe(409);
    const payload = (await res.json()) as ConflictPayload;
    expect(payload.reason).toBe("conflict");
    if (payload.reason !== "conflict") throw new Error("expected a conflict payload");
    // The whole point: reload-or-overwrite is answerable from this body
    // alone, with no second round trip.
    expect(payload.current.note.body).toBe("from the other writer");
    expect(payload.current.revision).not.toBe(revision);
    // And re-sending with the revision the 409 handed back succeeds — that
    // is "overwrite", expressed honestly rather than by disabling the check.
    const retry = await post(server, "/api/note/alpha-note", {
      body: "from the browser",
      expectedRevision: payload.current.revision,
    });
    expect(retry.status).toBe(200);
  });

  it("404s for a missing note", async () => {
    const { server } = await bootWritable();
    const res = await post(server, "/api/note/no-such-note", { body: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such note" });
  });

  it("404s every traversal slug, and writes nothing", async () => {
    // Two guards in series, and they answer at different layers. A slug with
    // a `/` in it is not a note route at all — the family matches the segment
    // after `/api/note/` exactly — so it never reaches core; a `/`-free
    // traversal (`..`) does reach core and is refused by `resolveNotePath`.
    // Both are a `404`, which is the only thing a caller may rely on.
    const { server, vaultRoot } = await bootWritable();
    for (const slug of ["..", "../escape", "..%2f..%2fetc%2fpasswd", "%2e%2e%2fescape", "nested/note", ""]) {
      const res = await post(server, `/api/note/${slug}`, { body: "clobbered" });
      expect(res.status, slug).toBe(404);
      const text = await res.text();
      expect(text).not.toContain("root:");
      expect(text).not.toContain("/etc");
    }
    await expect(readNoteFile(vaultRoot, "alpha-note")).resolves.toContain("the body of alpha");
  });

  it("404s rather than 409s when the note vanished before the revision check", async () => {
    // `expectedRevision` on a note that is not there: core answers `missing`,
    // not `conflict`, because there is nothing to conflict with.
    const { server } = await bootWritable();
    const res = await post(server, "/api/note/gone", { body: "x", expectedRevision: "1:1" });
    expect(res.status).toBe(404);
  });

  it("400s a malformed body", async () => {
    const { server } = await bootWritable();
    for (const body of ["not json", "", "[]", '"str"', '{"body":1}', '{"meta":{"source":"nope"}}']) {
      const res = await post(server, "/api/note/alpha-note", body);
      expect(res.status, body).toBe(400);
    }
  });

  it("refuses an oversized body instead of buffering it", async () => {
    const { server } = await bootWritable();
    const res = await post(server, "/api/note/alpha-note", JSON.stringify({ body: "x".repeat(MAX_BODY_BYTES + 1024) }));
    expect(res.status).toBe(400);
  });

  it("404s when the note is deleted between the write and the re-read", async () => {
    // A real race, not a defensive branch: the write succeeds, and a
    // `weave_note` delete (or an `rm` in another terminal) lands before the
    // re-read that supplies the new revision. The write did happen; the note
    // is gone anyway; `404` is the honest answer and a `500` would not be.
    //
    // Driven through the `readNote` seam because the window is microseconds
    // wide and a test that tried to hit it by timing would be the flakiest
    // thing in the suite.
    const { server } = await bootFresh({ readNote: async () => null });
    const res = await post(server, "/api/note/alpha-note", { body: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such note" });
  });
});

describe("POST /api/note/:slug/rename", () => {
  it("moves the file and returns the note at its new slug", async () => {
    const { server, vaultRoot } = await bootWritable();
    const res = await post(server, "/api/note/alpha-note/rename", { slug: "Alpha Renamed" });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as NotePayload;
    // `slugify` applies, so a human title is as acceptable as a slug.
    expect(payload.note.slug).toBe("alpha-renamed");
    await expect(readNoteFile(vaultRoot, "alpha-renamed")).resolves.toContain("Alpha Note");
    await expect(readNoteFile(vaultRoot, "alpha-note")).rejects.toThrow();
  });

  it("409s with the taken slug rather than overwriting", async () => {
    const { server } = await bootWritable();
    const res = await post(server, "/api/note/alpha-note/rename", { slug: "beta-note" });
    expect(res.status).toBe(409);
    const payload = (await res.json()) as ConflictPayload;
    expect(payload).toMatchObject({ reason: "collision", slug: "beta-note" });
  });

  it("404s for a missing source note", async () => {
    const { server } = await bootWritable();
    const res = await post(server, "/api/note/no-such-note/rename", { slug: "whatever" });
    expect(res.status).toBe(404);
  });

  it("slugifies a punctuation-only destination rather than refusing it", async () => {
    // `slugify` never returns the empty string — it falls back to `"note"`.
    // Asserted here because the route's suppression calls `slugify` itself,
    // and a change to that fallback would silently move which path gets
    // suppressed. Documenting the current behaviour is the point.
    const { server, vaultRoot } = await bootWritable();
    const res = await post(server, "/api/note/alpha-note/rename", { slug: "---" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as NotePayload).note.slug).toBe("note");
    await expect(readNoteFile(vaultRoot, "note")).resolves.toContain("Alpha Note");
  });

  it("400s a body that is not { slug: string }", async () => {
    const { server } = await bootWritable();
    for (const body of ["{}", '{"slug":1}', '{"slug":""}', "[]", "not json", ""]) {
      const res = await post(server, "/api/note/alpha-note/rename", body);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: "expected { slug: string }" });
    }
  });
});

describe("DELETE /api/note/:slug", () => {
  it("unlinks the file", async () => {
    const { server, vaultRoot } = await bootWritable();
    const res = await send(server, "DELETE", "/api/note/alpha-note");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    await expect(readNoteFile(vaultRoot, "alpha-note")).rejects.toThrow();
  });

  it("404s for a missing note", async () => {
    const { server } = await bootWritable();
    const res = await send(server, "DELETE", "/api/note/no-such-note");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such note" });
  });

  it("404s a traversal slug, and deletes nothing", async () => {
    const { server, vaultRoot } = await bootWritable();
    for (const slug of ["..", "..%2fescape", "nested/note", ""]) {
      expect((await send(server, "DELETE", `/api/note/${slug}`)).status, slug).toBe(404);
    }
    await expect(readNoteFile(vaultRoot, "alpha-note")).resolves.toContain("the body of alpha");
  });
});

describe("write routes and §5.1", () => {
  // The security gate runs in `handleRequest` before any routing, so these
  // are inherited rather than re-implemented. They are asserted per route
  // anyway: "inherited" is a property of the current call order, and the
  // whole point of a gate is that it cannot be routed around by accident.
  const writes: Array<[label: string, method: string, path: string, body: unknown]> = [
    ["save", "POST", "/api/note/alpha-note", { body: "x" }],
    ["rename", "POST", "/api/note/alpha-note/rename", { slug: "other" }],
    ["delete", "DELETE", "/api/note/alpha-note", undefined],
  ];

  for (const [label, method, path, body] of writes) {
    it(`${label} is refused with no Origin at all`, async () => {
      // The CSRF shape: a valid cookie (the browser attaches it to *any*
      // request to this origin) and no provenance. §5.1 requires Origin on
      // every non-GET precisely so this cannot be a write.
      const { server, vaultRoot } = await bootWritable();
      const res = await fetch(server.url + path, {
        method,
        headers: { cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("forbidden\n");
      // …and nothing happened. A 403 that still wrote would be the worst of
      // both worlds, so the file is checked rather than the status alone.
      await expect(readNoteFile(vaultRoot, "alpha-note")).resolves.toContain("the body of alpha");
    });

    it(`${label} is refused with a foreign Origin`, async () => {
      const { server, vaultRoot } = await bootWritable();
      const res = await fetch(server.url + path, {
        method,
        headers: {
          cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`,
          origin: "http://evil.example",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status).toBe(403);
      await expect(readNoteFile(vaultRoot, "alpha-note")).resolves.toContain("the body of alpha");
    });

    it(`${label} is refused with no token`, async () => {
      const { server, vaultRoot } = await bootWritable();
      const res = await fetch(server.url + path, {
        method,
        headers: { origin: server.url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status).toBe(403);
      await expect(readNoteFile(vaultRoot, "alpha-note")).resolves.toContain("the body of alpha");
    });

    it(`${label} is refused with a foreign Host (DNS rebinding)`, async () => {
      const { server, vaultRoot } = await bootWritable();
      const response = await rawSocket(server.port, [
        `${method} ${path} HTTP/1.1`,
        "Host: evil.example",
        `Origin: ${server.url}`,
        `Cookie: ${DEFAULT_COOKIE_NAME}=${TOKEN}`,
        "Content-Type: application/json",
        `Content-Length: ${body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body))}`,
        "Connection: close",
        "",
        body === undefined ? "" : JSON.stringify(body),
      ].join("\r\n"));
      expect(response).toContain("403");
      await expect(readNoteFile(vaultRoot, "alpha-note")).resolves.toContain("the body of alpha");
    });

    it(`${label} does not become a token handoff via ?t=`, async () => {
      // The handoff is `GET`-only in `createSecurityPolicy`. If it were not,
      // a page that learned the token could turn a write into a redirect
      // that also *set the cookie*, which is credential planting.
      const { server } = await bootWritable();
      const res = await fetch(`${server.url}${path}?t=${TOKEN}`, {
        method,
        headers: { origin: server.url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    });
  }
});

describe("self-write suppression (§6)", () => {
  it("suppresses the note's path before each write", async () => {
    // Before, not after: `fs.watch` can deliver an event while the write
    // syscall is still returning, so a window opened afterwards is a window
    // that opened second. The recorder captures the file's contents at the
    // moment `suppress` is called, which is what makes the ordering
    // assertable without a real watcher.
    const seen: Array<{ path: string; bodyAtCall: string }> = [];
    const { server, vaultRoot } = await bootWritable({
      suppress: (absPath) => {
        seen.push({ path: absPath, bodyAtCall: readFileSyncSafe(absPath) });
      },
    });
    const notes = join(vaultRoot, "notes");

    await post(server, "/api/note/alpha-note", { body: "saved" });
    expect(seen).toEqual([{ path: join(notes, "alpha-note.md"), bodyAtCall: expect.stringContaining("the body of alpha") }]);

    seen.length = 0;
    await send(server, "DELETE", "/api/note/alpha-note");
    expect(seen.map((s) => s.path)).toEqual([join(notes, "alpha-note.md")]);
  });

  it("suppresses both ends of a rename", async () => {
    // Only suppressing the source would broadcast the *arrival* at the
    // destination, which is the same feedback loop with an extra step.
    const seen: string[] = [];
    const { server, vaultRoot } = await bootWritable({ suppress: (absPath) => void seen.push(absPath) });
    await post(server, "/api/note/alpha-note/rename", { slug: "moved" });
    expect(seen).toEqual([join(vaultRoot, "notes", "alpha-note.md"), join(vaultRoot, "notes", "moved.md")]);
  });

  it("does not suppress a path it could not resolve", async () => {
    // A traversal slug has no legitimate absolute path. Suppressing one
    // would mean either fabricating a path or handing `null` to a watcher
    // that would resolve it against the process's cwd.
    const seen: string[] = [];
    const { server } = await bootWritable({ suppress: (absPath) => void seen.push(absPath) });
    await post(server, "/api/note/..%2fescape", { body: "x" });
    await send(server, "DELETE", "/api/note/..%2fescape");
    expect(seen).toEqual([]);
  });

  it("suppresses the rename's destination as `slugify` will write it", async () => {
    // Suppressing the *requested* string would open the window over
    // `notes/Alpha Renamed.md` while the write went to
    // `notes/alpha-renamed.md` — a suppression that is present, plausible
    // and useless.
    const seen: string[] = [];
    const { server, vaultRoot } = await bootWritable({ suppress: (absPath) => void seen.push(absPath) });
    await post(server, "/api/note/alpha-note/rename", { slug: "Alpha Renamed" });
    expect(seen).toEqual([join(vaultRoot, "notes", "alpha-note.md"), join(vaultRoot, "notes", "alpha-renamed.md")]);
  });

  it("writes fine with no watcher and no suppress hook", async () => {
    // The route tests boot without a watcher, which is also the shape of a
    // degraded session (§14). A write must not require the hook to exist.
    const { server } = await bootWritable({ suppress: undefined });
    expect((await post(server, "/api/note/alpha-note", { body: "x" })).status).toBe(200);
  });

  it("takes `suppress` from the watcher when the caller supplies one", async () => {
    // The real wiring: `run.ts` hands `startWorkspaceServer` a watcher, and
    // the watcher is the thing that owns the window. Requiring the caller to
    // *also* pass `suppress` would be a second place to forget it.
    const seen: string[] = [];
    const watcher: Watcher = {
      start: async () => {},
      close: async () => {},
      suppress(absPath: string) {
        seen.push(absPath);
      },
    };
    const { server, vaultRoot } = await bootWritable({ watcher });
    await post(server, "/api/note/alpha-note", { body: "x" });
    expect(seen).toEqual([join(vaultRoot, "notes", "alpha-note.md")]);
  });

  it("an explicit `suppress` wins over the watcher's", async () => {
    const explicit: string[] = [];
    const fromWatcher: string[] = [];
    const watcher: Watcher = {
      start: async () => {},
      close: async () => {},
      suppress: (p) => void fromWatcher.push(p),
    };
    const { server } = await bootWritable({ watcher, suppress: (p) => void explicit.push(p) });
    await post(server, "/api/note/alpha-note", { body: "x" });
    expect(explicit).toHaveLength(1);
    expect(fromWatcher).toEqual([]);
  });

  it("a watcher without `suppress` is not an error", async () => {
    const watcher: Watcher = { start: async () => {}, close: async () => {} };
    const { server } = await bootWritable({ watcher });
    expect((await post(server, "/api/note/alpha-note", { body: "x" })).status).toBe(200);
  });
});

// --- the P5 exit criterion -----------------------------------------------------------

describe("P5 exit: a browser-authored note is byte-compatible with an Obsidian one (§11)", () => {
  /**
   * The Obsidian-shaped note. Every line here is one the engine's subset
   * cannot represent, and each is a different failure mode:
   *
   *  - `aliases:` inline array — an unknown key with punctuation in it;
   *  - `cssclass:` — a bare unknown scalar;
   *  - the `tags:` **block list** — an *owned* key in a syntax the serializer
   *    cannot write, which is the case that would be silently rewritten to
   *    `tags: []` with two orphaned children left underneath;
   *  - a YAML comment and a blank line — content with no key at all;
   *  - `nested:` with an indented child — a map the parser has no concept of.
   */
  const OBSIDIAN_FRONT_MATTER = [
    "title: Auth Boundary",
    "aliases: [Auth Boundary, ADR-7]",
    "cssclass: wide-table",
    "tags:",
    "  - architecture",
    "  - security",
    "# a comment the parser has no concept of",
    "",
    "nested:",
    "  key: value",
    "publish: true",
    "created: 2026-01-02T03:04:05.000Z",
    "source: human",
  ];

  it("preserves every unknown line byte-for-byte across a browser save", async () => {
    const { server, vaultRoot } = await bootFresh();
    const before = await writeNoteFile(vaultRoot, "auth-boundary", OBSIDIAN_FRONT_MATTER, "The original body.");

    // Read it the way the editor does…
    const loaded = (await (await get(server, "/api/note/auth-boundary")).json()) as NotePayload;
    expect(loaded.note.body).toBe("The original body.");

    // …and save it the way the editor does.
    const saved = await post(server, "/api/note/auth-boundary", {
      body: "The body, rewritten in a browser textarea.",
      expectedRevision: loaded.revision,
    });
    expect(saved.status).toBe(200);

    const after = await readNoteFile(vaultRoot, "auth-boundary");

    // The claim, stated line by line rather than as one blob, so a failure
    // names the line that was destroyed.
    const beforeLines = frontMatterOf(before);
    const afterLines = frontMatterOf(after);
    for (const line of [
      "aliases: [Auth Boundary, ADR-7]",
      "cssclass: wide-table",
      "tags:",
      "  - architecture",
      "  - security",
      "# a comment the parser has no concept of",
      "",
      "nested:",
      "  key: value",
      "publish: true",
      "created: 2026-01-02T03:04:05.000Z",
    ]) {
      expect(afterLines, line).toContain(line);
    }

    // Order is preserved too — a set-equal check would pass on a block that
    // had been sorted, and a reordered front matter is a diff in the user's
    // git history that they did not make.
    const kept = (lines: string[]): string[] => lines.filter((l) => !l.startsWith("updated:"));
    expect(kept(afterLines)).toEqual(kept(beforeLines));

    // The block list is *frozen*, not rewritten: no `tags: [...]` line was
    // emitted alongside it, which is the duplication that would leave the
    // user with two `tags` properties.
    expect(afterLines.filter((l) => l.startsWith("tags:"))).toEqual(["tags:"]);

    // The only intended change: the body, plus the `updated` bump the save
    // asked for.
    expect(after).toContain("The body, rewritten in a browser textarea.");
    expect(after).not.toContain("The original body.");
    expect(afterLines.filter((l) => l.startsWith("updated:"))).toHaveLength(1);
  });

  it("survives repeated saves — one cycle is a fixed point", async () => {
    // Idempotence at the HTTP layer. `frontmatterRoundTrip.test.ts` proves it
    // for `parse ∘ serialize`; this proves the browser's *path* to those
    // functions did not add a lossy step of its own, which is the only part
    // §11 P5's exit criterion is about.
    const { server, vaultRoot } = await bootFresh();
    await writeNoteFile(vaultRoot, "auth-boundary", OBSIDIAN_FRONT_MATTER, "Body.");

    let revision = ((await (await get(server, "/api/note/auth-boundary")).json()) as NotePayload).revision;
    for (let i = 0; i < 3; i += 1) {
      const res = await post(server, "/api/note/auth-boundary", { body: `Body ${i}.`, expectedRevision: revision });
      expect(res.status).toBe(200);
      revision = ((await res.json()) as NotePayload).revision;
    }

    const after = frontMatterOf(await readNoteFile(vaultRoot, "auth-boundary"));
    // Not "still contains" — *exactly* the original block, modulo the one
    // line the engine owns and was asked to move.
    expect(after.filter((l) => !l.startsWith("updated:"))).toEqual(
      OBSIDIAN_FRONT_MATTER.filter((l) => !l.startsWith("updated:")),
    );
  });

  it("preserves the block through a rename as well as a save", async () => {
    const { server, vaultRoot } = await bootFresh();
    await writeNoteFile(vaultRoot, "auth-boundary", OBSIDIAN_FRONT_MATTER, "Body.");
    expect((await post(server, "/api/note/auth-boundary/rename", { slug: "auth-edge" })).status).toBe(200);

    const after = frontMatterOf(await readNoteFile(vaultRoot, "auth-edge"));
    expect(after.filter((l) => !l.startsWith("updated:"))).toEqual(
      OBSIDIAN_FRONT_MATTER.filter((l) => !l.startsWith("updated:")),
    );
  });
});

/** The front-matter block of a note file, fences excluded. */
function frontMatterOf(text: string): string[] {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match?.[1] === undefined) throw new Error("no front matter block");
  return match[1].split("\n");
}

// --- okf files -----------------------------------------------------------------------

describe("GET /api/okf/:rel", () => {
  it("returns a file from the derived index", async () => {
    const { server } = await boot();
    const res = await get(server, "/api/okf/repository/identity.json");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as OkfFilePayload;
    expect(payload.path).toBe("repository/identity.json");
    expect(JSON.parse(payload.body)).toHaveProperty("name");
  });

  it("404s for a missing file", async () => {
    const { server } = await boot();
    const res = await get(server, "/api/okf/repository/nope.json");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such okf file" });
  });

  describe("path traversal", () => {
    const attempts = [
      "../package.json",
      "../../etc/passwd",
      "%2e%2e%2fpackage.json",
      "..%2f..%2f..%2fetc%2fpasswd",
      "repository/../../package.json",
      "/etc/passwd",
      "%2E%2E%2F%2E%2E%2Fpackage.json",
      "....//package.json",
    ];

    for (const attempt of attempts) {
      it(`refuses ${JSON.stringify(attempt)}`, async () => {
        const { server } = await boot();
        const res = await get(server, `/api/okf/${attempt}`);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("root:");
      });
    }

    it("cannot read a real file that sits just outside .okf", async () => {
      // The sharpest version: the target definitely exists, so a 404 can
      // only mean the guard refused rather than the file being absent.
      const { server, cwd } = await bootFresh();
      await fs.writeFile(join(cwd, "SECRET.txt"), "sensitive\n", "utf8");
      for (const attempt of ["../SECRET.txt", "%2e%2e%2fSECRET.txt", "repository/../../SECRET.txt"]) {
        const res = await get(server, `/api/okf/${attempt}`);
        expect(res.status, attempt).toBe(404);
        expect(await res.text()).not.toContain("sensitive");
      }
    });
  });
});

// --- search --------------------------------------------------------------------------

describe("GET /api/search", () => {
  it("returns ranked hits", async () => {
    const { server } = await boot();
    const res = await get(server, "/api/search?q=alpha");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as SearchPayload;
    expect(payload.query).toBe("alpha");
    expect(payload.hits.length).toBeGreaterThan(0);
    expect(payload.hits[0]?.summary.slug).toBe("alpha-note");
  });

  it("returns an empty result for an absent or empty q, not a 400", async () => {
    // The search box sends a request on every keystroke, including the one
    // that clears it. A 400 there would be noise in the console forever.
    const { server } = await boot();
    for (const path of ["/api/search", "/api/search?q=", "/api/search?q=%20"]) {
      const res = await get(server, path);
      expect(res.status, path).toBe(200);
      expect(((await res.json()) as SearchPayload).hits).toEqual([]);
    }
  });

  it("treats a query with no matches as an empty result", async () => {
    const { server } = await boot();
    const payload = (await (await get(server, "/api/search?q=zzzznothing")).json()) as SearchPayload;
    expect(payload.hits).toEqual([]);
  });
});

// --- open ---------------------------------------------------------------------------

describe("POST /api/open", () => {
  it("opens an existing note", async () => {
    const { server } = await boot();
    const res = await post(server, "/api/open", { slug: "alpha-note" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ opened: true });
  });

  it("404s when the note cannot be opened", async () => {
    const { server } = await boot();
    const res = await post(server, "/api/open", { slug: "missing" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ opened: false });
  });

  it("400s on a body that is not { slug: string }", async () => {
    const { server } = await boot();
    for (const body of ["{}", '{"slug":1}', '{"slug":null}', "[]", '"str"', "not json", ""]) {
      const res = await post(server, "/api/open", body);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: "expected { slug: string }" });
    }
  });

  it("refuses an oversized body instead of buffering it", async () => {
    // Without a cap, any local process that can reach the port could stream
    // gigabytes into the pi session's heap.
    const { server } = await boot();
    const res = await post(server, "/api/open", JSON.stringify({ slug: "x".repeat(MAX_BODY_BYTES + 1024) }));
    expect(res.status).toBe(400);
  });

  it("passes a traversal slug through to the core guard, which refuses it", async () => {
    // No `openNote` override here: the real `openNoteInEditor` must reject
    // the slug via `resolveNotePath` before any shell-out.
    const { server } = await boot({ openNote: undefined });
    for (const slug of ["../escape", "../../etc/passwd", "nested/note", ""]) {
      const res = await post(server, "/api/open", { slug });
      expect(res.status, slug).toBe(404);
      expect(await res.json()).toEqual({ opened: false });
    }
  });

  it("is rejected without an Origin header, even with a valid cookie", async () => {
    // The CSRF case: a state change with no provenance.
    const { server } = await boot();
    const res = await fetch(server.url + "/api/open", {
      method: "POST",
      headers: { cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "alpha-note" }),
    });
    expect(res.status).toBe(403);
  });

  it("is rejected with a foreign Origin", async () => {
    const { server } = await boot();
    const res = await fetch(server.url + "/api/open", {
      method: "POST",
      headers: {
        cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`,
        origin: "http://evil.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "alpha-note" }),
    });
    expect(res.status).toBe(403);
  });
});

// --- events -----------------------------------------------------------------------

describe("GET /events", () => {
  it("503s when no SSE hub was injected", async () => {
    // P1b wires the real hub. Until then — and in every route test — the
    // endpoint must fail honestly rather than hang the browser on a stream
    // that never produces a frame.
    const { server } = await boot();
    const res = await get(server, "/events");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("live updates unavailable");
  });

  it("hands the raw request and response to the hub", async () => {
    // The route must not write anything itself: SSE needs the socket
    // un-ended, with headers the hub chooses. Anything written here would
    // be a header the hub then could not set.
    let attached = 0;
    const hub: SseHub = {
      attach: (req, res) => {
        attached += 1;
        expect(req.url).toBe("/events");
        expect(res.headersSent).toBe(false);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end();
      },
      broadcast: () => {},
      clientCount: () => 1,
      close: () => {},
    };
    const { server } = await boot({ sse: hub, idleMs: 0 });
    const res = await get(server, "/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.text();
    expect(attached).toBe(1);
  });

  it("resets the idle countdown when a client attaches", async () => {
    // §5.4: a workspace with a live stream is not idle. The route calls
    // `onActivity`, which cancels the timer armed at boot.
    let cancelled = 0;
    const hub = stubHub(1);
    hub.attach = (_req, res) => res.end();
    const { server } = await boot({
      sse: hub,
      idleMs: 1000,
      setTimer: () => ({}),
      clearTimer: () => {
        cancelled += 1;
      },
    });
    expect(cancelled).toBe(0);
    await (await get(server, "/events")).text();
    expect(cancelled).toBe(1);
  });
});

// --- security, end to end ------------------------------------------------------------

describe("security over the wire", () => {
  it("403s every route without a token", async () => {
    const { server } = await boot();
    for (const path of ["/", "/app.js", "/api/graph", "/api/note/alpha-note", "/api/okf/x", "/api/search?q=a", "/events"]) {
      const res = await raw(server, path);
      expect(res.status, path).toBe(403);
      // The body says nothing about which layer refused: telling a prober
      // they cleared the Host allowlist and merely lack a token is free
      // reconnaissance.
      expect(await res.text()).toBe("forbidden\n");
    }
  });

  it("403s a rebinding Host even with a valid cookie", async () => {
    // The attack loopback binding does not stop. `fetch` will not let us set
    // `Host` directly, so send the request line by hand.
    const { server } = await boot();
    const res = await rawSocket(server.port, [
      "GET /api/graph HTTP/1.1",
      "Host: evil.com",
      `Cookie: ${DEFAULT_COOKIE_NAME}=${TOKEN}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    expect(res).toContain("403");
  });

  it("accepts localhost and [::1] as Host", async () => {
    const { server } = await boot();
    for (const host of [`localhost:${server.port}`, `[::1]:${server.port}`]) {
      const res = await rawSocket(server.port, [
        "GET /api/graph HTTP/1.1",
        `Host: ${host}`,
        `Cookie: ${DEFAULT_COOKIE_NAME}=${TOKEN}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      expect(res, host).toContain("200 OK");
    }
  });

  it("performs the token→cookie handoff and drops the token from the URL", async () => {
    const { server } = await boot();
    const res = await fetch(server.entryUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("location")).not.toContain(TOKEN);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${DEFAULT_COOKIE_NAME}=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    // The handoff response must never be cached — that would re-materialise
    // the token the redirect exists to erase.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("the cookie the handoff sets is accepted on the next request", async () => {
    // The round trip a browser actually performs.
    const { server } = await boot();
    const handoff = await fetch(server.entryUrl, { redirect: "manual" });
    const setCookie = handoff.headers.get("set-cookie") ?? "";
    const pair = setCookie.split(";")[0] ?? "";
    const res = await fetch(server.url + "/api/graph", { headers: { cookie: pair } });
    expect(res.status).toBe(200);
    await res.json();
  });

  it("403s a handoff with the wrong token", async () => {
    const { server } = await boot();
    const res = await fetch(`${server.url}/?t=wrong`, { redirect: "manual" });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("never emits a CORS header on any route, success or failure", async () => {
    // An `Access-Control-Allow-Origin` header is precisely the instruction
    // that would let a rebinding attacker's JavaScript read our responses.
    const { server } = await boot();
    const responses = await Promise.all([
      get(server, "/"),
      get(server, "/app.js"),
      get(server, "/api/graph"),
      get(server, "/api/note/alpha-note"),
      get(server, "/api/note/missing"),
      get(server, "/api/okf/repository/identity.json"),
      get(server, "/api/search?q=a"),
      get(server, "/events"),
      post(server, "/api/open", { slug: "alpha-note" }),
      raw(server, "/api/graph"),
      raw(server, "/nope"),
    ]);
    for (const res of responses) {
      await res.text();
      for (const header of [
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-expose-headers",
        "access-control-max-age",
      ]) {
        expect(res.headers.get(header), `${res.url} → ${header}`).toBeNull();
      }
    }
  });

  it("sets nosniff and no-referrer on every response", async () => {
    const { server } = await boot();
    for (const res of [await get(server, "/api/graph"), await get(server, "/"), await raw(server, "/x")]) {
      await res.text();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
});

// --- unrouted --------------------------------------------------------------------

describe("unrouted requests", () => {
  it("404s an unknown path", async () => {
    const { server } = await boot();
    for (const path of ["/nope", "/api", "/api/", "/api/nope", "/app.js/extra", "/events/x"]) {
      const res = await get(server, path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("not found\n");
    }
  });

  it("404s a known path under the wrong method", async () => {
    const { server } = await boot();
    for (const [method, path] of [
      ["POST", "/"],
      ["POST", "/api/graph"],
      ["GET", "/api/open"],
      // `DELETE /api/note/:slug` is a real route as of P5, so the wrong-method
      // case moved to a method nothing serves — and to the sub-resource
      // shapes, which must not be reachable by prefix.
      ["PUT", "/api/note/alpha-note"],
      ["PATCH", "/api/note/alpha-note"],
      ["GET", "/api/note/alpha-note/rename"],
      ["DELETE", "/api/note/alpha-note/rename"],
      ["POST", "/api/note/alpha-note/nonsense"],
      ["GET", "/api/note/alpha-note/extra/deep"],
    ] as const) {
      const res = await fetch(server.url + path, {
        method,
        headers: { cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`, origin: server.url },
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("404s a malformed request target rather than throwing", async () => {
    const { server } = await boot();
    const res = await rawSocket(server.port, [
      "GET /%zz HTTP/1.1",
      `Host: 127.0.0.1:${server.port}`,
      `Cookie: ${DEFAULT_COOKIE_NAME}=${TOKEN}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    expect(res).toContain("404");
  });
});

// --- lifecycle ---------------------------------------------------------------------

describe("lifecycle (§5.4)", () => {
  it("binds an ephemeral loopback port, never a fixed one", async () => {
    const a = await boot();
    const b = await boot();
    expect(a.server.port).toBeGreaterThan(0);
    expect(a.server.port).not.toBe(b.server.port);
    expect(a.server.url).toBe(`http://127.0.0.1:${a.server.port}`);
  });

  it("generates a token when none is supplied", async () => {
    const { server } = await boot({ token: undefined });
    expect(server.token).toHaveLength(43);
    expect(server.entryUrl).toContain(server.token);
  });

  it("close() releases the port and is idempotent", async () => {
    const { server } = await boot();
    const { port } = server;
    await server.close();
    await server.close();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("defaults the idle timeout to 30 minutes", () => {
    expect(DEFAULT_IDLE_MS).toBe(30 * 60 * 1000);
  });

  it("arms the idle timer at boot when a hub is present, and shuts down when it fires", async () => {
    // A workspace nobody connected to should still release its port.
    let fire: (() => void) | null = null;
    let armed = 0;
    let unrefed = 0;
    let shutdown = false;
    const hub = stubHub(0);

    const { server } = await boot({
      sse: hub,
      idleMs: 1,
      setTimer: (fn) => {
        armed += 1;
        fire = fn;
        return {
          unref: () => {
            unrefed += 1;
          },
        };
      },
      clearTimer: () => {},
      onIdleShutdown: () => {
        shutdown = true;
      },
    });

    expect(armed).toBe(1);
    // A pending shutdown must not be the reason the process stays alive.
    expect(unrefed).toBe(1);
    expect(fire).not.toBeNull();
    const port = server.port;
    (fire as unknown as () => void)();
    // `close()` inside the timer callback is async.
    await new Promise((r) => setTimeout(r, 50));
    expect(shutdown).toBe(true);
    expect(hub.closed).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("cancels the countdown while a client is attached and re-arms when it leaves", async () => {
    const timers: Array<() => void> = [];
    let cancelled = 0;
    const hub = stubHub(0);
    const { server } = await boot({
      sse: hub,
      idleMs: 1000,
      setTimer: (fn) => {
        timers.push(fn);
        return { id: timers.length } as TimerHandle;
      },
      clearTimer: () => {
        cancelled += 1;
      },
    });

    expect(timers).toHaveLength(1); // armed at boot: nobody has connected

    hub.count = 1;
    server.noteActivity(); // a client attached
    expect(cancelled).toBe(1);
    expect(timers).toHaveLength(1); // not re-armed: someone is here

    hub.count = 0;
    server.noteActivity(); // the last client left
    expect(timers).toHaveLength(2); // countdown restarts
  });

  it("never arms a timer when idleMs is 0", async () => {
    let armed = 0;
    const { server } = await boot({
      sse: stubHub(0),
      idleMs: 0,
      setTimer: () => {
        armed += 1;
        return {};
      },
      clearTimer: () => {},
    });
    server.noteActivity();
    server.noteActivity();
    expect(armed).toBe(0);
  });

  it("does not arm the timer at boot when there is no hub", async () => {
    // With `/events` answering 503 there is no such thing as a client, so
    // there is nothing for an idle countdown to be counting down from. The
    // server must stay up until its owner closes it.
    let armed = 0;
    await boot({
      idleMs: 1000,
      setTimer: () => {
        armed += 1;
        return {};
      },
      clearTimer: () => {},
    });
    expect(armed).toBe(0);
  });

  it("uses real timers by default, and unrefs them", async () => {
    // The default `setTimer`/`clearTimer` are only exercised when nothing is
    // injected. A pending 30-minute shutdown that kept the event loop alive
    // would make this very test hang, so the assertion is partly the fact
    // that the suite finishes.
    const hub = stubHub(0);
    const { server } = await boot({ sse: hub, idleMs: 60_000 });
    // Arms at boot with a real `setTimeout`, then cancels with a real
    // `clearTimeout` when a client shows up.
    hub.count = 1;
    server.noteActivity();
    hub.count = 0;
    server.noteActivity();
    await server.close(); // cancels the pending real timer
  });

  it("falls back to resolveVaultRoot when no vault is given", async () => {
    // `PI_WEAVE_VAULT` is what the adapter sets; a server booted without an
    // explicit root must honour it rather than inventing a default.
    const { cwd, vaultRoot } = await sharedWorkspace();
    const server = await withVaultEnv(vaultRoot, () => startWorkspaceServer({ cwd, token: TOKEN, idleMs: 0 }));
    running.push(server);
    const html = await (await get(server, "/")).text();
    expect(html).toContain(JSON.stringify(vaultRoot).slice(1, -1));
  });

  it("builds its own cache when none is injected", async () => {
    const { cwd, vaultRoot } = await sharedWorkspace();
    const server = await startWorkspaceServer({ cwd, vaultRoot, token: TOKEN, idleMs: 0 });
    running.push(server);
    expect(server.cache).toBeInstanceOf(WorkspaceCache);
    const res = await get(server, "/api/graph");
    expect(res.status).toBe(200);
    await res.json();
  });

  it("gives every boot a distinct session id", async () => {
    // The client uses it to tell "I missed frames" from "this is a different
    // server" across an EventSource reconnect.
    const a = await boot();
    const b = await boot();
    expect(a.server.session).not.toBe(b.server.session);
    expect(a.server.session).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not re-arm after close", async () => {
    let armed = 0;
    const hub = stubHub(0);
    const { server } = await boot({
      sse: hub,
      idleMs: 1000,
      setTimer: () => {
        armed += 1;
        return {};
      },
      clearTimer: () => {},
    });
    const atBoot = armed;
    await server.close();
    server.noteActivity();
    expect(armed).toBe(atBoot);
  });

  it("starts and closes an injected watcher", async () => {
    let started = 0;
    let closedTimes = 0;
    const watcher: Watcher = {
      start: async () => {
        started += 1;
      },
      close: async () => {
        closedTimes += 1;
      },
    };
    const { server } = await boot({ watcher });
    expect(started).toBe(1);
    expect(closedTimes).toBe(0);
    await server.close();
    expect(closedTimes).toBe(1);
    await server.close();
    expect(closedTimes).toBe(1); // idempotent
  });

  it("closes the hub exactly once", async () => {
    const hub = stubHub(0);
    const { server } = await boot({ sse: hub, idleMs: 0 });
    await server.close();
    await server.close();
    expect(hub.closeCalls).toBe(1);
  });

  it("uses the fallback cookie name when asked (§5.1 footnote 1)", async () => {
    const { server } = await boot({ cookieName: "weave_token" });
    const res = await fetch(server.entryUrl, { redirect: "manual" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`weave_token=${TOKEN}`);
    expect(cookie).not.toContain("Secure");
    const ok = await fetch(server.url + "/api/graph", { headers: { cookie: `weave_token=${TOKEN}` } });
    expect(ok.status).toBe(200);
    await ok.json();
  });

  it("resolves the committed bundle relative to the module, not the cwd", () => {
    // The server runs in whatever directory the user invoked pi from, which
    // is never the package root.
    expect(defaultBundlePath()).toMatch(/src[/\\]web[/\\]client[/\\]dist[/\\]app\.js$/);
  });
});

// --- helpers ---------------------------------------------------------------------

interface StubHub extends SseHub {
  count: number;
  closed: boolean;
  closeCalls: number;
}

function stubHub(initial: number): StubHub {
  const hub: StubHub = {
    count: initial,
    closed: false,
    closeCalls: 0,
    attach: (_req, res) => res.end(),
    broadcast: () => {},
    clientCount: () => hub.count,
    close: () => {
      hub.closed = true;
      hub.closeCalls += 1;
    },
  };
  return hub;
}

/**
 * Send a raw HTTP request and return the whole response as text.
 *
 * `fetch` refuses to set `Host` — it is a forbidden header, which is exactly
 * why the allowlist works — so the only way to test the rebinding case is to
 * write the request line ourselves.
 */
async function rawSocket(port: number, request: string): Promise<string> {
  const { connect } = await import("node:net");
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let out = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      out += chunk;
    });
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}
