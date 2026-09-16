/**
 * Route handling for the workspace server.
 *
 * | Method | Path                     | Response                                     |
 * | ------ | ------------------------ | -------------------------------------------- |
 * | GET    | `/`                      | the HTML shell, with its per-response nonce  |
 * | GET    | `/app.js`                | the committed bundle, `Cache-Control: no-store` |
 * | GET    | `/api/graph`             | {@link GraphPayload}, ETag'd on `stamp`      |
 * | GET    | `/api/note/:slug`        | {@link NotePayload}                          |
 * | GET    | `/api/okf/:rel`          | {@link OkfFilePayload}                       |
 * | GET    | `/api/search?q=`         | {@link SearchPayload}                        |
 * | POST   | `/api/open`              | {@link OpenResult} — hand the note to `$EDITOR` |
 *
 * ## Shape
 *
 * {@link handleRequest} takes {@link RouteDeps} — every capability it needs,
 * injected — and a `ServerResponse`. It never constructs a cache, reads an
 * environment variable, or knows what port it is on. That is what lets
 * `tests/web/routes.test.ts` drive the real thing over a real socket with a
 * temp vault without browser-specific state.
 *
 * ## Two things this file deliberately never does
 *
 * **No CORS headers, ever.** Not `Access-Control-Allow-Origin`, not even
 * echoing our own origin, and no `OPTIONS` preflight handler. There is no
 * legitimate cross-origin consumer of this server, and an
 * `Access-Control-Allow-Origin` header is precisely the instruction that
 * would tell a browser to hand a rebinding attacker's JavaScript the
 * response body it otherwise could not read. A test asserts the absence.
 *
 * **No path resolution of its own.** `/api/okf/:rel` and `/api/note/:slug`
 * carry untrusted path fragments straight from the URL. Both are handed to
 * the existing core guards — `readOkfFileForView` anchors under `<cwd>/.okf`
 * and `resolveNotePath` (via `getNote`) rejects unsafe slugs.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceSnapshot } from "../../core/cache/workspace";
import { WorkspaceCache } from "../../core/cache/workspace";
import { readOkfFileForView } from "../../core/graph/current";
import type { GraphModel as CoreGraphModel } from "../../core/graph/model";
import { openNoteInEditor } from "../../core/openInEditor";
import type { Note } from "../../core/types";
import { getNote, searchNotes } from "../../core/vault";
import { deriveTagIndex, type TaggedNote } from "../../core/view/links";
import type {
  GraphPayload,
  NotePayload,
  OkfFilePayload,
  OpenResult,
  SearchPayload,
  ViewNote,
} from "../shared/wire";
import { WIRE_MODEL_OMITTED_KEYS } from "../shared/wire";
import { renderPage } from "./page";
import type { RequestFacts, SecurityPolicy } from "./security";
import { requestFacts } from "./security";

/** Everything a route needs, injected. */
export interface RouteDeps {
  cwd: string;
  vaultRoot: string;
  cache: WorkspaceCache;
  security: SecurityPolicy;
  /** Absolute path of the committed bundle. Injectable for tests. */
  bundlePath: string;
  /** Test seam for `POST /api/open`; defaults to the real editor shell-out. */
  openNote?: ((slug: string) => Promise<boolean>) | undefined;
}

const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";

/** Headers every response carries, regardless of route. */
function baseHeaders(): Record<string, string> {
  return {
    // Belt to the CSP's braces: the shell declares `default-src 'none'`, but
    // JSON responses have no CSP and a content-sniffing browser that decides
    // an `/api/note` body is HTML would render attacker-controlled note text
    // as markup on our origin.
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...baseHeaders(), "content-type": JSON_TYPE, ...extra });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...baseHeaders(), "content-type": TEXT_TYPE });
  res.end(body);
}

/**
 * `403`, with a body that says nothing.
 *
 * The {@link SecurityPolicy} knows *which* layer refused, and that
 * information stays in the server's own logs. Returning it would tell a
 * prober whether they had cleared the Host allowlist and were now merely
 * missing a token, which is the difference between a dead end and a
 * roadmap.
 */
function sendForbidden(res: ServerResponse): void {
  sendText(res, 403, "forbidden\n");
}

/** Parsed request target: path plus query, both already decoded where safe. */
interface Target {
  /** Percent-decoded pathname, or `null` when the encoding was malformed. */
  path: string | null;
  query: URLSearchParams;
}

/**
 * Split a request target.
 *
 * `decodeURIComponent` throws on a lone `%` or an invalid escape — both
 * trivially reachable from a hand-crafted request — so a malformed target
 * becomes `path: null` and then a `404`, not a `500`.
 *
 * Decoding happens **before** any route match, which is the correct order:
 * matching on the raw string and decoding afterwards is how `%2e%2e%2f`
 * slips past a prefix check. The decoded fragment is then handed to a core
 * guard that resolves and re-checks it, so there is no second decode later.
 */
export function parseTarget(url: string): Target {
  const raw = url.length > 0 ? url : "/";
  const qmark = raw.indexOf("?");
  const rawPath = qmark === -1 ? raw : raw.slice(0, qmark);
  const query = new URLSearchParams(qmark === -1 ? "" : raw.slice(qmark + 1));
  let path: string | null;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = null;
  }
  return { path, query };
}

/**
 * Read a JSON request body, bounded.
 *
 * The cap is not about our own client — it is about a local process that can
 * reach the port and, without one, could stream gigabytes into a pi session's
 * heap. `null` on anything that is not a small, well-formed JSON object, so
 * the caller has exactly one failure branch.
 */
export const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  // `IncomingMessage` yields Buffers unless `setEncoding` was called, and we
  // never call it — so no string branch, which would be untestable dead code
  // pretending to be defensive.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Build the wire payload from a freshly-built model.
 *
 * Takes the **core** `GraphModel`, not the wire one: the derived indexes it
 * hoists to the payload's top level (`tags`, `dangling`) are read off the
 * core shape, and the wire model is what comes *out* of here.
 *
 * `notes` is what the graph was built from. It is a separate argument because
 * the graph deliberately does not carry structured tags — `detail.tags` is a
 * comma-joined display string and re-parsing it here would be exactly the
 * "grow structure inside `detail`" move / rule out. The caller
 * already holds the notes (the cache read them to build the model), so this
 * costs nothing. Omitted → `tags: {}`, which is what a caller that genuinely
 * has no note list should ship.
 */
export function toGraphPayload(model: CoreGraphModel, notes: readonly TaggedNote[] = []): GraphPayload {
  const payload: GraphPayload = {
    model: toWireModel(model),
    // tag → slugs (§4.3). `deriveTagIndex` returns an ordered array because
    // order is meaningful (count desc, tag asc); the wire field is a record,
    // so that ordering survives only as JSON key insertion order. Good enough
    // deliberately: a client that wants the ranking re-derives it from the
    // array lengths, and the alternative — putting an array on the wire under
    // a field the contract calls `Record<string, string[]>` — would be a
    // breaking change to a settled shape for a fact the client can compute.
    tags: Object.fromEntries(deriveTagIndex(notes).map((t) => [t.tag, t.slugs])),
    // slug → unresolved wikilink targets (§4.2), carried on the model since
    // the builder stopped discarding the names.
    dangling: model.danglingLinks,
    // Still `null`, and deliberately: server-side layout needs
    // `src/web/shared/layout`, which imports d3-force, and the server tier's
    // npm allowlist is empty (: the published package has zero runtime
    // dependencies). The client runs the identical `shared/layout` code
    // itself, so this is a division of labour rather than a gap.
    positions: null,
    // Filled in below: the digest covers every field above, so it cannot be
    // computed until they exist. `""` is never observable — no caller sees
    // the payload before {@link stampPayload} replaces it.
    stamp: "",
  };
  return stampPayload(payload);
}

/**
 * Serialize a payload and stamp it with the digest of its own bytes
 * (weave-workspace §5.3, §15.6).
 *
 * ## Why a digest and not `generatedAt`
 *
 * `stamp` used to be `model.generatedAt`, the **max of the input
 * timestamps**. That made it blind to any change that does not move the
 * maximum, and three of those are reachable: editing a note's body or its
 * front-matter tags without bumping `updated`, and deleting a note that is
 * not the newest. In each the payload differs and the old stamp did not, so a
 * conditional GET answered `304` and the client kept stale data — and, worse,
 * a client-side comparison could discard the update that would have
 * prompted a refetch. A digest changes if and only if the bytes change, which
 * is the property both consumers actually need.
 *
 * The digest is exact, but the payload is only an *excerpt* of the workspace:
 * a note body below `PREVIEW_LEN` does not appear in the payload at all, so
 * a body-only edit used to reproduce byte-identical payload and re-open the
 * same hole through both dedupe layers. `GraphModel.contentDigest` — hashed
 * over the note bodies themselves — closes that; see `core/graph/model.ts`.
 *
 * `generatedAt` keeps its own, different job: it is the human-facing
 * "data as of" marker on the model, and the status bar still reads it.
 *
 * ## Why hash the serialized form rather than the object
 *
 * The digest is taken over the exact `JSON.stringify` output that is then
 * written to the socket, so "the digest changes iff the served bytes change"
 * is true by construction rather than by an argument about which fields were
 * fed to the hash. It also makes the ETag **strong**: a strong validator
 * asserts byte-for-byte equality of the representation, and that is precisely
 * what was compared.
 *
 * ## Determinism
 *
 * No canonicalisation step, because the inputs are already canonical and a
 * second ordering pass would be a second thing to keep correct.
 * `buildGraph` is documented byte-deterministic (ids derive from slugs and
 * paths; nothing reads the wall clock), `deriveTagIndex` emits count-desc /
 * tag-asc with **codepoint** tiebreaks precisely so it does not vary with the
 * host locale, and `danglingLinks` is populated in the builder's note order,
 * which is `updated` descending with a slug tiebreak — itself a function of
 * payload content. Two independent builds of identical input therefore
 * produce identical bytes; `tests/web/routes.test.ts` pins that directly.
 */
export function stampPayload(payload: GraphPayload): GraphPayload {
  // Hashed with `stamp: ""` in place, so the digest is a function of the
  // *content* fields only. Hashing a payload that already carried a stamp
  // would fold the previous digest into the new one and make the value
  // depend on how many times it had been stamped.
  const stamp = digestOf(JSON.stringify({ ...payload, stamp: "" }));
  return { ...payload, stamp };
}

/**
 * The digest function. SHA-256, truncated to 128 bits and hex-encoded.
 *
 * Truncation is safe here and worth the 32 bytes it saves on every ETag
 * header values: at 128 bits an accidental collision between two
 * payloads is far below the probability of the cache being wrong for any
 * other reason. This is a cache validator, not a security boundary — nobody
 * is choosing our note contents to force a collision, and if they could, they
 * could simply edit the note.
 */
function digestOf(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex").slice(0, 32);
}

/**
 * Drop the core-only fields from the model before it goes on the wire.
 *
 * `WireGraphModel` is deliberately narrower than core's `GraphModel`
 * (`src/web/shared/graph.ts`): `danglingLinks` is republished as
 * `GraphPayload.dangling` and must not also ride along inside `model`.
 * TypeScript's structural typing will happily assign the wider object to the
 * narrower type and then serialize every key it actually has, so the
 * narrowing has to be enforced at runtime — here, once, at the only place
 * that builds a payload.
 *
 * The key list comes from `WIRE_MODEL_OMITTED_KEYS` rather than being
 * repeated inline, so a second omission cannot be declared in `shared/` and
 * forgotten in `server/`.
 */
function toWireModel(model: CoreGraphModel): GraphPayload["model"] {
  const copy: Record<string, unknown> = { ...model };
  for (const key of WIRE_MODEL_OMITTED_KEYS) delete copy[key];
  return copy as unknown as GraphPayload["model"];
}


/**
 * The security gate, then the route.
 *
 * Split from {@link route} so the ordering is visible in one screen: no
 * handler below runs until the request has cleared all four layers. The one
 * exception is the handoff, which is answered here because it is a
 * *security* response — a `302` that exists only to move a token out of the
 * URL — and not a route anyone can address.
 */
export async function handleRequest(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const facts = requestFacts(req);
  const decision = deps.security.authorize(facts);

  if (decision.kind === "deny") {
    sendForbidden(res);
    return;
  }
  if (decision.kind === "handoff") {
    res.writeHead(302, {
      ...baseHeaders(),
      "set-cookie": decision.setCookie,
      location: decision.location,
      // The handoff URL contains the token. Caching it anywhere — including
      // the browser's own back/forward cache — re-materialises the thing the
      // redirect exists to erase.
      "cache-control": "no-store",
    });
    res.end();
    return;
  }

  try {
    await route(deps, facts, req, res);
  } catch (err) {
    // A handler that threw after writing headers cannot be rescued; ending
    // the socket is all that is left, and leaving it open would hang the
    // browser tab on a request that is never coming back.
    if (res.headersSent) {
      res.end();
      return;
    }
    sendText(res, 500, `pi-weave: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function route(
  deps: RouteDeps,
  facts: RequestFacts,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { path, query } = parseTarget(facts.url);
  if (path === null) {
    sendText(res, 404, "not found\n");
    return;
  }
  const method = facts.method;

  if (method === "GET" && path === "/") return sendShell(deps, res);
  if (method === "GET" && path === "/app.js") return sendBundle(deps, res);
  if (method === "GET" && path === "/api/graph") return sendGraph(deps, req, res);
  if (path.startsWith("/api/note/")) {
    const handled = await routeNote(deps, method, path.slice("/api/note/".length), res);
    if (handled) return;
  }
  if (method === "GET" && path.startsWith("/api/okf/")) {
    return sendOkf(deps, path.slice("/api/okf/".length), res);
  }
  if (method === "GET" && path === "/api/search") return sendSearch(deps, query, res);
  if (method === "POST" && path === "/api/open") return openNote(deps, req, res);
  sendText(res, 404, "not found\n");
}

// --- handlers ----------------------------------------------------------------

function sendShell(deps: RouteDeps, res: ServerResponse): void {
  const page = renderPage({
    bootstrap: { cwd: deps.cwd },
  });
  res.writeHead(200, {
    ...baseHeaders(),
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": page.csp,
    // The nonce is per-response, so a cached copy would be served with a
    // nonce the CSP header no longer matches and the page would silently
    // refuse to run its own script.
    "cache-control": "no-store",
  });
  res.end(page.html);
}

async function sendBundle(deps: RouteDeps, res: ServerResponse): Promise<void> {
  let source: Buffer;
  try {
    source = await readFile(deps.bundlePath);
  } catch {
    // A missing bundle means someone is running from a checkout that has not
    // been built. Say so in the body — this one is a developer error, not a
    // prober, and it is reachable only after authentication.
    sendText(res, 404, "pi-weave: web bundle missing; run `npm run build:web`\n");
    return;
  }
  res.writeHead(200, {
    ...baseHeaders(),
    "content-type": "text/javascript; charset=utf-8",
    // . The artifact changes on rebuild and the server may outlive one.
    "cache-control": "no-store",
  });
  res.end(source);
}

/**
 * Serialized payload + ETag, memoized per snapshot **identity**
 * (weave-workspace §4.1).
 *
 * `WorkspaceCache` returns the *identical* snapshot object while nothing on
 * disk has moved, so this map turns a warm `/api/graph` into a pure lookup:
 * no `toGraphPayload`, no `JSON.stringify`, and — the point of 's cost
 * requirement — **no hashing at all**. The first request after a real change
 * gets a new snapshot object, misses, and pays once for the whole build.
 *
 * A `WeakMap` rather than a one-slot cache so that a request racing a rebuild
 * cannot evict the entry the other request is about to read, and so entries
 * for superseded snapshots are collected with them. The key is the snapshot
 * rather than the model because the payload depends on the notes too (§4.1).
 */
const renderedGraphs = new WeakMap<WorkspaceSnapshot, { body: string; etag: string }>();

/**
 * The stamp `/api/graph` would serve for this snapshot.
 *
 * Exported for tests and for the conditional client contract. It shares
 * {@link renderGraph}'s memo, so asking for the stamp after the route has
 * rendered the same snapshot costs nothing.
 */
export function graphStamp(snapshot: WorkspaceSnapshot): string {
  // The memo stores the quoted ETag; the response exposes the bare digest.
  return renderGraph(snapshot).etag.slice(1, -1);
}

/** Serialize + digest a snapshot, or return the memoized rendering. */
function renderGraph(snapshot: WorkspaceSnapshot): { body: string; etag: string } {
  const hit = renderedGraphs.get(snapshot);
  if (hit !== undefined) return hit;
  const payload = toGraphPayload(snapshot.model, snapshot.notes);
  // Serialized once and kept: this exact string is what the digest was taken
  // over, so writing anything else would make the strong ETag a lie.
  const rendered = { body: JSON.stringify(payload), etag: `"${payload.stamp}"` };
  renderedGraphs.set(snapshot, rendered);
  return rendered;
}

async function sendGraph(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // `snapshot()`, not `graph()`: the tag index has to be derived from the
  // same (already capped) note list the model was built from, or a tag could
  // name a slug this graph has no node for (§4.2).
  const snapshot = await deps.cache.snapshot();
  const { body, etag } = renderGraph(snapshot);

  // The ETag is a digest of the serialized payload (§15.6, resolved), so it
  // moves if and only if the bytes the client would receive have moved. The
  // three cases the old timestamp stamp missed — a body edit, a tag edit, and
  // the deletion of a non-newest note, none of which advance `generatedAt` —
  // all change it.
  const conditional = req.headers["if-none-match"];
  if (matchesEtag(etag, typeof conditional === "string" ? conditional : undefined)) {
    res.writeHead(304, { ...baseHeaders(), etag, "cache-control": "no-cache" });
    res.end();
    return;
  }
  // The memoized string, not a re-serialization: the digest was taken over
  // these exact bytes, which is what entitles the ETag to be strong.
  //
  // `no-cache`, not `no-store`: the client *should* keep the body and
  // revalidate, which is the entire point of the ETag.
  res.writeHead(200, {
    ...baseHeaders(),
    "content-type": JSON_TYPE,
    etag,
    "cache-control": "no-cache",
  });
  res.end(body);
}

/**
 * `If-None-Match` matching, weak-comparison style.
 *
 * A `*` matches anything with a representation, and a list is comma-
 * separated.
 *
 * The validator we *emit* is strong (no `W/` prefix), and honestly so: it is
 * a digest of the exact bytes sent, so equal ETag really does mean equal
 * representation rather than merely equivalent. What we *accept* is
 * deliberately more forgiving — `W/` is stripped from incoming candidates
 * because RFC 9110 requires weak comparison for `If-None-Match` anyway, and
 * an intermediary that weakened our tag in transit should still get its
 * `304` rather than a pointless full body.
 */
function matchesEtag(etag: string, header: string | undefined): boolean {
  if (header === undefined) return false;
  const want = normalizeEtag(etag);
  return header.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || normalizeEtag(trimmed) === want;
  });
}

function normalizeEtag(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}

/**
 * Everything under `/api/note/`, in one place.
 *
 * Returns `false` for methods this family does not serve, so the caller
 * falls through to its own `404`. Core's `resolveNotePath` remains the
 * traversal guard for whatever slug arrives.
 */
async function routeNote(
  deps: RouteDeps,
  method: string,
  target: string,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET") {
    await sendNote(deps, target, res);
    return true;
  }
  return false;
}

async function sendNote(deps: RouteDeps, rawSlug: string, res: ServerResponse): Promise<void> {
  // Traversal is `resolveNotePath`'s job, inside `getNote`: an
  // unsafe slug returns null before anything touches the disk. `%2e%2e%2f`
  // was already decoded by `parseTarget`, so what arrives here is the literal
  // `../` the guard is written to reject.
  //
  const current = await getNote(deps.vaultRoot, rawSlug);
  if (current === null) {
    sendJson(res, 404, { error: "no such note" });
    return;
  }
  sendJson(res, 200, notePayload(current), { "cache-control": "no-store" });
}



function notePayload(note: Note): NotePayload {
  const view: ViewNote = {
    slug: note.slug,
    title: note.title,
    body: note.body,
    created: note.created,
    updated: note.updated,
    tags: note.tags,
    source: note.source,
  };
  return { note: view };
}

async function sendOkf(deps: RouteDeps, rel: string, res: ServerResponse): Promise<void> {
  // Anchored under `<cwd>/.okf` by `readOkfFileForView`, which resolves and
  // then re-checks the prefix — the only correct order.
  const file = await readOkfFileForView(deps.cwd, rel);
  if (file === null) {
    sendJson(res, 404, { error: "no such okf file" });
    return;
  }
  const payload: OkfFilePayload = file;
  sendJson(res, 200, payload, { "cache-control": "no-store" });
}

async function sendSearch(deps: RouteDeps, query: URLSearchParams, res: ServerResponse): Promise<void> {
  const q = query.get("q") ?? "";
  // `searchNotes` already returns `[]` for an empty query, so a missing `q`
  // is an empty result rather than a `400`. The search box sends one on
  // every keystroke, including the one that clears it.
  const payload: SearchPayload = { query: q, hits: await searchNotes(deps.vaultRoot, q) };
  sendJson(res, 200, payload, { "cache-control": "no-store" });
}

async function openNote(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const slug = typeof body === "object" && body !== null ? (body as { slug?: unknown }).slug : undefined;
  if (typeof slug !== "string") {
    sendJson(res, 400, { error: "expected { slug: string }" });
    return;
  }
  const open = deps.openNote ?? ((s: string) => openNoteInEditor(deps.vaultRoot, s));
  const opened = await open(slug);
  const payload: OpenResult = { opened };
  // `404` rather than `200 {opened:false}` for a missing note: the client
  // shows an error either way, and a status code keeps the failure visible
  // in a network panel.
  sendJson(res, opened ? 200 : 404, payload, { "cache-control": "no-store" });
}
