/**
 * Route handling for the workspace server (weave-workspace §5.3).
 *
 * | Method | Path                     | Response                                     |
 * | ------ | ------------------------ | -------------------------------------------- |
 * | GET    | `/`                      | the HTML shell, with its per-response nonce  |
 * | GET    | `/app.js`                | the committed bundle, `Cache-Control: no-store` |
 * | GET    | `/api/graph`             | {@link GraphPayload}, ETag'd on `stamp`      |
 * | GET    | `/api/note/:slug`        | {@link NotePayload} — the note plus its revision |
 * | POST   | `/api/note/:slug`        | update; {@link NotePayload} or a `409` (§5.3, P5) |
 * | POST   | `/api/note/:slug/rename` | rename; {@link NotePayload} or a `409`       |
 * | DELETE | `/api/note/:slug`        | {@link DeleteNoteResult} — hard delete       |
 * | GET    | `/api/okf/:rel`          | {@link OkfFilePayload}                       |
 * | GET    | `/api/search?q=`         | {@link SearchPayload}                        |
 * | POST   | `/api/open`              | {@link OpenResult} — hand the note to `$EDITOR` |
 * | GET    | `/events`                | the SSE stream (delegated to an injected hub) |
 *
 * ## The write routes (P5)
 *
 * Three of them, and every one goes through the same security gate as every
 * read: {@link handleRequest} calls `security.authorize` **before** it routes,
 * so there is no way to add a route that skips it. That matters more for
 * writes than for reads, because §5.1's Origin rule is asymmetric — absent on
 * a `GET` is fine (a browser omits it on same-origin navigation), absent on
 * anything else is a `403`, and that asymmetry is the CSRF defence. It lives
 * in `checkOrigin` rather than here precisely so a new write route inherits
 * it rather than remembering it.
 *
 * `MutationResult` → status is the one mapping this file owns:
 *
 * | Core result           | Status | Body |
 * | --------------------- | -----: | ---- |
 * | `ok`                  | `200`  | {@link NotePayload}, re-read so the revision is the one just written |
 * | `reason: "missing"`   | `404`  | {@link ErrorPayload} |
 * | `reason: "conflict"`  | `409`  | {@link ConflictPayload} with the **current note and revision** |
 * | `reason: "collision"` | `409`  | {@link ConflictPayload} with the taken slug |
 *
 * `409` for both failures, with `reason` telling them apart in the body. They
 * are the same *kind* of answer — "the vault is not in the state you thought
 * it was" — and the client's response to each is a question for the user, so
 * splitting them across two status codes would buy a distinction the HTTP
 * layer has no use for while making the client branch twice.
 *
 * ## Self-write suppression (§6)
 *
 * Every one of these writes lands in the vault the watcher is watching, so
 * without suppression a save is a change event, which is a broadcast, which
 * makes the client refetch the note it just saved — and, worse, arrive
 * mid-typing with a "the file changed" prompt about its own keystroke. The
 * watcher exposes `suppress(absPath, ms)` for exactly this;
 * {@link RouteDeps.suppress} is the injected form, called with the note's
 * absolute path **before** the mutation runs, so the window is already open
 * when the write hits the filesystem.
 *
 * ## Shape
 *
 * {@link handleRequest} takes {@link RouteDeps} — every capability it needs,
 * injected — and a `ServerResponse`. It never constructs a cache, reads an
 * environment variable, or knows what port it is on. That is what lets
 * `tests/web/routes.test.ts` drive the real thing over a real socket with a
 * temp vault, and what lets P1b's SSE hub arrive as a constructor argument
 * rather than an import.
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
 * and `resolveNotePath` (via `getNoteWithRevision`) rejects anything that is not
 * a flat slug. Re-implementing either check here would be a second
 * implementation to keep in sync, which is how traversal bugs are actually
 * born.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceSnapshot } from "../../core/cache/workspace";
import { WorkspaceCache } from "../../core/cache/workspace";
import { readOkfFileForView } from "../../core/graph/current";
import type { GraphModel as CoreGraphModel } from "../../core/graph/model";
import { openNoteInEditor } from "../../core/openInEditor";
import type { MutationResult, RevisionedNote } from "../../core/vault";
import { slugify } from "../../core/slug";
import { deleteNote, getNoteWithRevision, renameNote, resolveNotePath, searchNotes, updateNote } from "../../core/vault";
import { deriveTagIndex, type TaggedNote } from "../../core/view/links";
import type {
  ChangeEvent,
  ConflictPayload,
  DeleteNoteResult,
  GraphPayload,
  NotePayload,
  OkfFilePayload,
  OpenResult,
  RenameNoteRequest,
  SaveNoteRequest,
  SearchPayload,
  ViewNote,
} from "../shared/wire";
import { WIRE_MODEL_OMITTED_KEYS } from "../shared/wire";
import { renderPage } from "./page";
import type { RequestFacts, SecurityPolicy } from "./security";
import { requestFacts } from "./security";

/**
 * The SSE hub contract.
 *
 * Declared here, in the consumer, rather than in the implementation: this
 * file is what needs the capability, and stating it here means the hub can
 * be written, replaced or omitted without `routes.ts` changing. It is also
 * the seam that lets the route tests boot a server with **no** hub and
 * assert the `503`.
 *
 * Implemented by `src/web/server/sse.ts`.
 */
export interface SseHub {
  /** Adopt a request/response pair as a long-lived event stream. */
  attach(req: IncomingMessage, res: ServerResponse): void;
  /** Fan a change out to every attached client. */
  broadcast(event: ChangeEvent): void;
  /** Currently attached clients. Drives the idle-shutdown timer (§5.4). */
  clientCount(): number;
  /** End every stream and stop the heartbeat. Idempotent. */
  close(): void;
}

/**
 * The file watcher contract.
 *
 * Same reasoning as {@link SseHub} — the server owns the lifecycle, so it
 * declares the shape it will start and stop, and P1b's `watcher.ts` supplies
 * it. Deliberately minimal: the watcher's *output* reaches the world through
 * the hub it was constructed with, not through a return value here.
 *
 * Implemented by `src/web/server/watcher.ts`.
 */
export interface Watcher {
  /** Begin watching. Resolves once the watches are established. */
  start(): Promise<void>;
  /** Stop watching and release every handle. Idempotent. */
  close(): Promise<void>;
  /**
   * Ignore events for `absPath` briefly — the §6 self-write window.
   *
   * **Optional**, and that is a deliberate contract choice rather than
   * timidity. This interface is the *lifecycle* one: start, close. A future
   * watcher over a remote filesystem or a stamp poller may have no concept
   * of "a path I am about to write", and making suppression mandatory would
   * force it to implement a no-op to satisfy a contract it does not
   * participate in. `server.ts` bridges it to {@link RouteDeps.suppress}
   * when it is present, and writes simply happen unsuppressed when it is
   * not — which is the correct degradation: one spurious refetch, never a
   * lost edit.
   */
  suppress?(absPath: string): void;
}

/** Everything a route needs, injected. */
export interface RouteDeps {
  cwd: string;
  vaultRoot: string;
  /** Random per-boot id, echoed into the page bootstrap. */
  session: string;
  cache: WorkspaceCache;
  security: SecurityPolicy;
  /** Absent → `/events` answers `503`. Wired by P1b. */
  sse?: SseHub | undefined;
  /** Absolute path of the committed bundle. Injectable for tests. */
  bundlePath: string;
  /** Test seam for `POST /api/open`; defaults to the real editor shell-out. */
  openNote?: ((slug: string) => Promise<boolean>) | undefined;
  /**
   * Read a note plus its revision. Defaults to core's `getNoteWithRevision`.
   *
   * A seam for the same reason {@link RouteDeps.openNote} is one, and it
   * earns its place on a specific branch: after a successful write this is
   * called again to obtain the revision of the bytes now on disk, and it can
   * legitimately return `null` — a `weave_note` delete or an `rm` in another
   * terminal, landing in the window between the write and the re-read. That
   * is a genuine race with a correct answer (`404`: the write happened, and
   * the note is gone anyway), and it is unreachable from a test without
   * being able to make the read fail on demand. The alternative was a
   * coverage-ignore comment over a branch that really can fire in
   * production, which is the wrong trade.
   */
  readNote?: ((slug: string) => Promise<RevisionedNote | null>) | undefined;
  /** Called when an SSE client attaches or detaches — resets the idle timer. */
  onActivity?: (() => void) | undefined;
  /**
   * Ignore filesystem events for `absPath` for a moment (§6).
   *
   * The watcher's `suppress`, injected. Absent in the route tests, which
   * boot without a watcher — a write with nothing to suppress is a write,
   * not an error, so this is optional rather than a required no-op the
   * caller has to supply.
   */
  suppress?: ((absPath: string) => void) | undefined;
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
 * "grow structure inside `detail`" move §4.2/§4.3 rule out. The caller
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
    // npm allowlist is empty (§9: the published package has zero runtime
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
 * the SSE dedupe (which shares this key) discarded the frame that would have
 * prompted a refetch. A digest changes if and only if the bytes change, which
 * is the property both consumers actually need.
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
 * header and every SSE frame: at 128 bits an accidental collision between two
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
    const handled = await routeNote(deps, method, path.slice("/api/note/".length), req, res);
    if (handled) return;
  }
  if (method === "GET" && path.startsWith("/api/okf/")) {
    return sendOkf(deps, path.slice("/api/okf/".length), res);
  }
  if (method === "GET" && path === "/api/search") return sendSearch(deps, query, res);
  if (method === "POST" && path === "/api/open") return openNote(deps, req, res);
  if (method === "GET" && path === "/events") return attachSse(deps, req, res);

  sendText(res, 404, "not found\n");
}

// --- handlers ----------------------------------------------------------------

function sendShell(deps: RouteDeps, res: ServerResponse): void {
  const page = renderPage({
    bootstrap: { cwd: deps.cwd, vaultRoot: deps.vaultRoot, session: deps.session },
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
    // §5.3. The artifact changes on rebuild and the server may outlive one.
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
 * no `toGraphPayload`, no `JSON.stringify`, and — the point of §15.6's cost
 * requirement — **no hashing at all**. The first request after a real change
 * gets a new snapshot object, misses, and pays once for the whole build.
 *
 * A `WeakMap` rather than a one-slot cache so that a request racing a rebuild
 * cannot evict the entry the other request is about to read, and so entries
 * for superseded snapshots are collected with them. The key is the snapshot
 * rather than the model because the payload depends on the notes too (§4.3).
 */
const renderedGraphs = new WeakMap<WorkspaceSnapshot, { body: string; etag: string }>();

/**
 * The stamp `/api/graph` would serve for this snapshot.
 *
 * Exported so the SSE liveness bridge broadcasts the **same** key the ETag
 * carries (§6). Two derivations of "the current stamp" would be two things to
 * keep in sync, and the failure mode is silent: frames that never match the
 * validator the client then sends. It shares {@link renderGraph}'s memo, so
 * asking for the stamp after the route has rendered the same snapshot — the
 * common case, since a change triggers both — costs nothing.
 */
export function graphStamp(snapshot: WorkspaceSnapshot): string {
  // The memo stores the quoted ETag; the frame wants the bare digest.
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
  // name a slug this graph has no node for (§4.3).
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
 * Returns `false` for a method/shape this family does not serve, so the
 * caller falls through to its own `404` rather than this function owning a
 * second copy of the not-found response. That is also what keeps
 * `DELETE /api/graph` and `PUT /api/note/x` answering the same `404` as any
 * other unrouted request: the family claims a request or it does not.
 *
 * The `rest` after the slug is matched **exactly**, not by prefix. A slug can
 * never legitimately contain `/` — `resolveNotePath` rejects it — so
 * `/api/note/a/b` is not a note named `a` with a sub-resource `b`, it is a
 * request for nothing, and it gets the `404` it deserves.
 */
async function routeNote(
  deps: RouteDeps,
  method: string,
  target: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const cut = target.indexOf("/");
  const slug = cut === -1 ? target : target.slice(0, cut);
  const rest = cut === -1 ? "" : target.slice(cut);

  if (rest === "" && method === "GET") {
    await sendNote(deps, slug, res);
    return true;
  }
  if (rest === "" && method === "POST") {
    await saveNote(deps, slug, req, res);
    return true;
  }
  if (rest === "" && method === "DELETE") {
    await removeNote(deps, slug, res);
    return true;
  }
  if (rest === "/rename" && method === "POST") {
    await moveNote(deps, slug, req, res);
    return true;
  }
  return false;
}

async function sendNote(deps: RouteDeps, rawSlug: string, res: ServerResponse): Promise<void> {
  // Traversal is `resolveNotePath`'s job, inside `getNoteWithRevision`: an
  // unsafe slug returns null before anything touches the disk. `%2e%2e%2f`
  // was already decoded by `parseTarget`, so what arrives here is the literal
  // `../` the guard is written to reject.
  //
  // `getNoteWithRevision` rather than `readNoteForView`, because the editor
  // cannot save safely without the revision it read at load, and fetching it
  // separately would leave a window in which the two disagree. It stats
  // before it reads, so a writer landing between the two calls yields a
  // revision *older* than the content — the save that follows is refused
  // rather than silently accepted (see core's own note on the ordering).
  const current = await readNote(deps, rawSlug);
  if (current === null) {
    sendJson(res, 404, { error: "no such note" });
    return;
  }
  sendJson(res, 200, notePayload(current), { "cache-control": "no-store" });
}

/** {@link RouteDeps.readNote}, or core's. One resolution, used by both routes. */
function readNote(deps: RouteDeps, slug: string): Promise<RevisionedNote | null> {
  const read = deps.readNote ?? ((s: string) => getNoteWithRevision(deps.vaultRoot, s));
  return read(slug);
}

/**
 * Core's `RevisionedNote` → the wire's {@link NotePayload}.
 *
 * The projection is `readNoteForView`'s, restated: a `Note` carries `body`,
 * the five managed fields **and** `frontMatter`, the verbatim block P5a added
 * so unknown keys survive a write. `frontMatter` must not cross the wire.
 * Not because it is secret, but because shipping it would invite a client to
 * send it back, and the moment a browser round-trips a user's raw metadata
 * through JSON the preservation guarantee stops being "the write path re-reads
 * the file" and becomes "the client remembered to return the block unedited".
 * The first is enforced by core; the second is a hope.
 *
 * So the field is dropped **explicitly**, by naming what is kept. A spread
 * with a `delete` would be exempt from the excess-property check and would
 * ship the block the day someone adds a sixth field — the same reasoning
 * `summarizeNote` gives for dropping it there.
 */
function notePayload(current: RevisionedNote): NotePayload {
  const { note } = current;
  const view: ViewNote = {
    slug: note.slug,
    title: note.title,
    body: note.body,
    created: note.created,
    updated: note.updated,
    tags: note.tags,
    source: note.source,
  };
  return { note: view, revision: current.revision };
}

/**
 * Answer a core {@link MutationResult}.
 *
 * The whole status mapping, in one function shared by both write routes, so
 * "a conflict is a 409" is a fact about this server rather than about
 * whichever handler was written most recently.
 *
 * A success re-reads the note through {@link getNoteWithRevision} rather than
 * returning the `Note` core handed back. Core's value is correct about
 * *content* and says nothing about *revision*, and the client's next save
 * needs a revision that matches the bytes now on disk — deriving one from the
 * write we just performed would mean re-implementing `revisionOf` out here,
 * against a stat this function does not have. The re-read costs one `stat`
 * plus one `readFile` on a file that is certainly in the page cache, and it
 * is the only way to hand back a revision that is true rather than inferred.
 *
 * The `null` branch is not dead code being defensive: between the write and
 * the re-read, a `weave_note` delete or an `rm` in another terminal can
 * genuinely remove the file. `404` is then the honest answer — the write did
 * happen, and the note is gone anyway.
 */
async function sendMutation(deps: RouteDeps, result: MutationResult, res: ServerResponse): Promise<void> {
  if (!result.ok) {
    sendMutationFailure(result, res);
    return;
  }
  const written = await readNote(deps, result.note.slug);
  if (written === null) {
    sendJson(res, 404, { error: "no such note" });
    return;
  }
  sendJson(res, 200, notePayload(written), { "cache-control": "no-store" });
}

function sendMutationFailure(failure: Extract<MutationResult, { ok: false }>, res: ServerResponse): void {
  if (failure.reason === "missing") {
    sendJson(res, 404, { error: "no such note" });
    return;
  }
  const payload: ConflictPayload =
    failure.reason === "conflict"
      ? {
          error: "the note changed on disk since it was read",
          reason: "conflict",
          // The whole note, not just its revision (§11 P5.3). This is what
          // lets the client offer reload-or-overwrite without a second round
          // trip — and the second round trip is another window in which the
          // file moves again, which would make the prompt itself stale.
          current: notePayload(failure.current),
        }
      : { error: "a note with that slug already exists", reason: "collision", slug: failure.slug };
  sendJson(res, 409, payload, { "cache-control": "no-store" });
}

/**
 * Open the watcher's self-write window for a slug, if there is a watcher.
 *
 * Called **before** the mutation, never after: `fs.watch` can deliver an
 * event while the write syscall is still returning, and a window opened
 * afterwards is a window that opens second. Suppressing a path the write then
 * fails to touch costs nothing — the entry expires on its own.
 *
 * An unsafe slug resolves to `null` and is skipped rather than suppressed;
 * the mutation is about to refuse it anyway, and suppressing a path we could
 * not resolve would mean either fabricating one or passing `null` down to a
 * watcher that would `resolve()` it into the process's cwd.
 */
function suppressSlug(deps: RouteDeps, slug: string): void {
  const path = resolveNotePath(deps.vaultRoot, slug);
  if (path !== null) deps.suppress?.(path);
}

async function saveNote(deps: RouteDeps, slug: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const input = parseSaveRequest(body);
  if (input === null) {
    sendJson(res, 400, { error: "expected { body?: string, meta?: object, expectedRevision?: string }" });
    return;
  }
  suppressSlug(deps, slug);
  await sendMutation(deps, await updateNote(deps.vaultRoot, slug, input), res);
}

async function moveNote(deps: RouteDeps, slug: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const target = typeof body === "object" && body !== null ? (body as Partial<RenameNoteRequest>).slug : undefined;
  if (typeof target !== "string" || target.length === 0) {
    sendJson(res, 400, { error: "expected { slug: string }" });
    return;
  }
  // Both ends: the file disappears from one path and appears at another, and
  // the watcher sees two events. Suppressing only the source would broadcast
  // the arrival, which is the same feedback loop with an extra step.
  //
  // `slugify` on the destination, because that is what `renameNote` will
  // apply before it touches the disk. Suppressing the *requested* string
  // would open the window over `notes/Alpha Renamed.md` while the write went
  // to `notes/alpha-renamed.md` — a suppression that is present, plausible
  // and useless, which is worse than an absent one.
  suppressSlug(deps, slug);
  suppressSlug(deps, slugify(target));
  await sendMutation(deps, await renameNote(deps.vaultRoot, slug, target), res);
}

async function removeNote(deps: RouteDeps, slug: string, res: ServerResponse): Promise<void> {
  suppressSlug(deps, slug);
  const result = await deleteNote(deps.vaultRoot, slug);
  if (!result.ok) {
    sendJson(res, 404, { error: "no such note" });
    return;
  }
  const payload: DeleteNoteResult = { deleted: true };
  sendJson(res, 200, payload, { "cache-control": "no-store" });
}

/**
 * Narrow a decoded request body to core's `UpdateNoteInput`, or `null`.
 *
 * An **allowlist**, field by field, and that is the point rather than
 * ceremony. `updateNote` spreads `input.meta` over the note's metadata, so
 * anything that reaches it reaches the front matter: passing the parsed body
 * straight through would let a local process `POST {"meta":{"created":"…"}}`
 * and rewrite a field the API deliberately does not expose, or
 * `{"meta":{"updated":"1970-…"}}` and make an edit look older than the state
 * it overwrote. Only `title`, `tags` and `source` are copied, and `source`
 * only when it is one of the three legal values — a note claiming
 * `source: "verified"` would render with a provenance badge nothing in the
 * palette matches.
 *
 * `null` for a body that is not an object, so the caller has exactly one
 * failure branch. An **empty** object is valid: a save with no fields bumps
 * `updated`, which is a meaningful (if unusual) request and not worth a
 * special case.
 */
export function parseSaveRequest(value: unknown): SaveNoteRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: SaveNoteRequest = {};

  if (raw["body"] !== undefined) {
    if (typeof raw["body"] !== "string") return null;
    out.body = raw["body"];
  }
  if (raw["expectedRevision"] !== undefined) {
    if (typeof raw["expectedRevision"] !== "string") return null;
    out.expectedRevision = raw["expectedRevision"];
  }
  if (raw["meta"] !== undefined) {
    const meta = parseSaveMeta(raw["meta"]);
    if (meta === null) return null;
    out.meta = meta;
  }
  return out;
}

/** The three metadata fields a client may set. See {@link parseSaveRequest}. */
function parseSaveMeta(value: unknown): NonNullable<SaveNoteRequest["meta"]> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: NonNullable<SaveNoteRequest["meta"]> = {};

  if (raw["title"] !== undefined) {
    if (typeof raw["title"] !== "string") return null;
    out.title = raw["title"];
  }
  if (raw["tags"] !== undefined) {
    const tags = raw["tags"];
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) return null;
    out.tags = tags as string[];
  }
  if (raw["source"] !== undefined) {
    const source = raw["source"];
    if (source !== "human" && source !== "agent" && source !== "generated") return null;
    out.source = source;
  }
  return out;
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

function attachSse(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): void {
  const hub = deps.sse;
  if (hub === undefined) {
    sendText(res, 503, "pi-weave: live updates unavailable\n");
    return;
  }
  hub.attach(req, res);
  deps.onActivity?.();
}
