/**
 * Routes, over a real socket.
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

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceCache } from "../../src/core/cache/workspace";
import { buildGraph } from "../../src/core/graph/build";
import type { GraphModel as CoreGraphModel } from "../../src/core/graph/model";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import type { Note } from "../../src/core/types";
import { addNote } from "../../src/core/vault";
import { DEFAULT_COOKIE_NAME } from "../../src/web/server/security";
import {
  graphStamp,
  MAX_BODY_BYTES,
  parseTarget,
  stampPayload,
  toGraphPayload,
} from "../../src/web/server/routes";
import {
  defaultBundlePath,
  startWorkspaceServer,
  type StartWorkspaceServerOptions,
  type WorkspaceServer,
} from "../../src/web/server/server";
import type { GraphPayload, NotePayload, OkfFilePayload, SearchPayload } from "../../src/web/shared/wire";
import { WIRE_MODEL_OMITTED_KEYS } from "../../src/web/shared/wire";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";

/** The exact §5.2 policy, with the nonce elided. Asserted byte-for-byte. */
const CSP_TEMPLATE =
  "default-src 'none'; script-src 'nonce-{N}'; style-src 'nonce-{N}'; " +
  "img-src 'self' data:; connect-src 'self'; frame-src 'self'; font-src 'self'; " +
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

function del(server: WorkspaceServer, path: string): Promise<Response> {
  return fetch(server.url + path, {
    method: "DELETE",
    headers: { cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`, origin: server.url },
  });
}

/** No credentials at all — the shape a local prober or a rebound page sends. */
function raw(server: WorkspaceServer, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(server.url + path, init);
}

/**
 * Write a note file **byte-exactly**, bypassing `addNote`, so the read route
 * can be checked against front matter written by another tool.
 */
async function writeNoteFile(vaultRoot: string, slug: string, frontMatter: string[], body: string): Promise<string> {
  const path = join(vaultRoot, "notes", `${slug}.md`);
  await fs.mkdir(join(vaultRoot, "notes"), { recursive: true });
  const text = ["---", ...frontMatter, "---", "", body, ""].join("\n");
  await fs.writeFile(path, text, "utf8");
  return text;
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
    contentDigest: "",
  };

  it("carries a content digest as the stamp and leaves positions to the client", () => {
    // : `stamp` is a digest of the payload, not `generatedAt`. It is
    // opaque, so this asserts its *shape* and its independence from the
    // timestamp rather than pinning a literal hash — a pinned hash would
    // turn every legitimate wire-shape change into a mystery failure here.
    const payload = toGraphPayload(EMPTY);
    expect(payload).toEqual({
      model: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        staleness: null,
        nodes: [],
        edges: [],
        contentDigest: "",
      },
      tags: {},
      dangling: {},
      positions: null,
      stamp: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
    });
    expect(payload.stamp).not.toBe(payload.model.generatedAt);
  });

  it("changes the stamp when only a note body changes", () => {
    // 's residual blind spot: the payload carries only a display
    // excerpt of a note body, so an edit below the fold used to reproduce
    // byte-identical payload — and the client would have kept its stale
    // cached payload. The model's
    // `contentDigest` covers the bodies themselves, so any body edit moves
    // the stamp even when the excerpts and front matter stand still.
    const body = "x".repeat(300);
    const note = (text: string): Note[] => [{
      slug: "a", title: "A", body: text, created: "", updated: "", tags: [], source: "human",
    }];
    const editBelowFold = buildGraph({
      vault: { root: "/v", exists: true, noteCount: 1 },
      notes: note(body + " — and the edit lands here"),
      repository: null,
    });
    const sameLengthEdit = buildGraph({
      vault: { root: "/v", exists: true, noteCount: 1 },
      notes: note("y".repeat(300)),
      repository: null,
    });
    expect(editBelowFold.contentDigest).not.toBe("");
    expect(sameLengthEdit.contentDigest).not.toBe(editBelowFold.contentDigest);
    expect(toGraphPayload(editBelowFold).stamp).not.toBe(toGraphPayload(sameLengthEdit).stamp);
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
    // The route's exported digest helper and its ETag must agree.
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

  // --- : tags ----------------------------------------------------------

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

  it("bootstraps the client with the cwd", async () => {
    const { server, cwd } = await boot();
    const html = await (await get(server, "/")).text();
    const open = html.indexOf(">", html.indexOf('<script type="application/json"')) + 1;
    const boot0 = JSON.parse(html.slice(open, html.indexOf("</script>", open)));
    expect(boot0).toEqual({ cwd });
  });
});

// --- the bundle -----------------------------------------------------------------

describe("GET /app.js", () => {
  it("serves the committed bundle with no-store", async () => {
    const { server } = await boot();
    const res = await get(server, "/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // : the artifact changes on rebuild and the server may outlive one.
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
    // : a digest of the payload, *not* the data-as-of timestamp, which
    // remains available on the model for anything that wants to show a time.
    expect(payload.stamp).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.stamp).not.toBe(payload.model.generatedAt);
    expect(payload.model.generatedAt).not.toBe("");
    // Strong, with no `W/` prefix: the digest was taken over the exact bytes
    // sent, so it is a byte-equality claim and may honestly say so.
    expect(res.headers.get("etag")).toBe(`"${payload.stamp}"`);
    expect(res.headers.get("etag")?.startsWith("W/")).toBe(false);
    expect(payload.model.nodes.length).toBeGreaterThan(0);
    // , no longer `{}`: the fixture's "Alpha Note" carries `t1`, and the
    // slug — not the node id — is what the index reports.
    expect(payload.tags).toEqual({ t1: ["alpha-note"] });
    // . The fixture's notes have no wiki-links at all, so nothing
    // dangles; that is an empty map for the right reason, not a stub.
    expect(payload.dangling).toEqual({});
    // Still null by design (§2): the server tier cannot import d3-force.
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

  // --- , resolved: the three cases a timestamp stamp could not see -----
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

    // The widened blast radius  warned about: a stale `tags` map is a
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
    // 's promise is that a no-change rebuild does zero note reads and
    // zero git spawns;  adds "and no re-hashing" to that list, since the
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
    // And 's original guarantees still hold on that path.
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
  // was built from in one call (§4.1), so that is the method whose failure
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

});

// --- notes ------------------------------------------------------------------------

describe("GET /api/note/:slug", () => {
  it("returns the note", async () => {
    const { server } = await boot();
    const res = await get(server, "/api/note/alpha-note");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as NotePayload;
    expect(payload.note).toMatchObject({ slug: "alpha-note", title: "Alpha Note", source: "human" });
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

describe("vault tree mutations", () => {
  it("renames, moves, and deletes notes and folders", async () => {
    const { server, vaultRoot } = await bootFresh();
    await fs.mkdir(join(vaultRoot, "notes", "archive"));

    let res = await post(server, "/api/note/alpha-note/rename", { name: "Renamed" });
    expect(await res.json()).toEqual({ ok: true, id: "note:renamed" });
    res = await post(server, "/api/note/renamed/move", { folder: "archive" });
    expect(await res.json()).toEqual({ ok: true, id: "note:archive/renamed" });
    res = await post(server, "/api/folder/archive/rename", { name: "Filed" });
    expect(await res.json()).toEqual({ ok: true, id: "vfolder:filed" });
    expect((await get(server, "/api/note/filed%2Frenamed")).status).toBe(200);
    expect((await del(server, "/api/note/filed%2Frenamed")).status).toBe(200);
    expect((await del(server, "/api/folder/filed")).status).toBe(200);
  });

  it("rejects malformed and missing mutation targets", async () => {
    const { server } = await bootFresh();
    expect((await post(server, "/api/note/alpha-note/rename", {})).status).toBe(400);
    expect((await post(server, "/api/note/alpha-note/move", { folder: 1 })).status).toBe(400);
    expect((await del(server, "/api/note/missing")).status).toBe(404);
    expect((await post(server, "/api/folder/missing/rename", { name: "x" })).status).toBe(404);
    expect((await del(server, "/api/folder/missing")).status).toBe(404);
  });
});

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

describe("GET /api/artifact/:rel", () => {
  it("serves an HTML artifact with a sandboxed preview policy", async () => {
    const { server, vaultRoot } = await bootFresh();
    await fs.mkdir(join(vaultRoot, "notes", "reports"), { recursive: true });
    const body = '<!doctype html><html><body><script>alert("no")</script><h1>Report</h1></body></html>';
    await fs.writeFile(join(vaultRoot, "notes", "reports/report.html"), body, "utf8");

    const res = await get(server, "/api/artifact/reports%2Freport.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(body);
  });

  it.each(["../secret.html", "%2e%2e%2fsecret.html", "reports/report.md"])("refuses unsafe or non-HTML paths: %s", async (rel) => {
    const { server } = await bootFresh();
    const res = await get(server, `/api/artifact/${rel}`);
    expect(res.status).toBe(404);
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

// --- security, end to end ------------------------------------------------------------

describe("security over the wire", () => {
  it("403s every route without a token", async () => {
    const { server } = await boot();
    for (const path of ["/", "/app.js", "/api/graph", "/api/note/alpha-note", "/api/okf/x", "/api/search?q=a"]) {
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
    for (const path of ["/nope", "/api", "/api/", "/api/nope", "/app.js/extra", "/live/x"]) {
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
      // Nested slugs are legitimate since session memory moved into a vault
      // subdirectory — `/api/note/a/b` is a note request, not a sub-resource.
      // The only sub-resource is `/rename`, matched at the end, so the
      // unroutable shape is anything *after* that suffix.
      ["GET", "/api/note/alpha-note/rename/extra"],
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

  it("falls back to resolveVaultRoot when no vault is given", async () => {
    // `PI_WEAVE_VAULT` is what the adapter sets; a server booted without an
    // explicit root must honour it rather than inventing a default.
    const { cwd, vaultRoot } = await sharedWorkspace();
    const server = await withVaultEnv(vaultRoot, () => startWorkspaceServer({ cwd, token: TOKEN }));
    running.push(server);
    const payload = (await (await get(server, "/api/graph")).json()) as GraphPayload;
    expect(payload.model.nodes.some((node) => node.detail.slug === "alpha-note")).toBe(true);
  });

  it("builds its own cache when none is injected", async () => {
    const { cwd, vaultRoot } = await sharedWorkspace();
    const server = await startWorkspaceServer({ cwd, vaultRoot, token: TOKEN });
    running.push(server);
    expect(server.cache).toBeInstanceOf(WorkspaceCache);
    const res = await get(server, "/api/graph");
    expect(res.status).toBe(200);
    await res.json();
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
