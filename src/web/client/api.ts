/**
 * Typed wrappers over the workspace server's endpoints (weave-workspace §5.3).
 *
 * One function per route, each returning a discriminated {@link ApiResult}
 * rather than throwing. That is the whole design decision here, and it is
 * driven by §6: the client refetches on every poll and on every explicit
 * refresh, so a failed request is a *normal, frequent* occurrence — the
 * server may be mid-restart, the session may have been killed, the token may
 * have rotated. Exceptions are for the unexpected, and none of these are.
 * A caller that must handle "the server went away" on every call is better
 * served by a value it cannot forget to check than by a `catch` it can.
 *
 * ## `fetch` is injected
 *
 * Not `globalThis.fetch`. Two reasons, and the second is the load-bearing
 * one:
 *
 *  1. There is no DOM test environment in this repository and §10 forbids
 *     adding one, so the only way to test this file is to hand it a fake.
 *  2. This module is a `.ts`, not a `.tsx`, which means it is compiled by the
 *     **root** `tsconfig.json` when a test imports it — and that project has
 *     no `DOM` lib. So `Response`, `RequestInit` and `fetch` are not merely
 *     inconvenient to reference, they do not exist as types here. {@link
 *     HttpResponse} and {@link FetchLike} are the minimal structural ports
 *     that both the real `fetch` and a two-line fake satisfy.
 *
 * ## The 304 contract
 *
 * `GET /api/graph` is ETag'd on `stamp`, which the server derives from input
 * timestamps rather than the wall clock — so an unchanged workspace produces
 * a byte-identical stamp and `If-None-Match` is a *true* conditional GET.
 * {@link fetchGraph} therefore takes the previously-held payload and returns
 * it unchanged on a `304`. Returning `null` instead, and making the caller
 * remember that `null` means "keep what you have" rather than "there is
 * nothing", is exactly the sort of API that produces a blank column once a
 * fortnight.
 */

import type { GraphPayload, MutationResult, NotePayload, OpenResult, SearchPayload, ViewNote } from "../shared/wire";

// --- the injected HTTP port ------------------------------------------------------

/**
 * The slice of `Response` this module reads.
 *
 * Structural, so the platform `Response` satisfies it without a cast, and so
 * a fake is an object literal. `json()` is typed `Promise<unknown>` rather
 * than the DOM's `Promise<any>` on purpose: `any` would silently disable
 * every check below, which is precisely the layer where an unchecked
 * assumption about the server's output becomes a runtime crash.
 */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** The slice of `RequestInit` this module sets. */
export interface HttpRequest {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: { readonly aborted: boolean };
}

/** The injected `fetch`. The platform's satisfies this structurally. */
export type FetchLike = (url: string, init?: HttpRequest) => Promise<HttpResponse>;

// --- results ----------------------------------------------------------------------

/**
 * Why a request did not produce data.
 *
 * Five cases, because the client reacts differently to each:
 *
 * - `auth` — a `403`. The four security layers (§5.1) refused us. The session
 *   is over; reconnecting will not help and the UI must say so rather than
 *   spinning.
 * - `missing` — a `404`. Normal: a note was deleted between the frame that
 *   announced it and the fetch that wanted it.
 * - `server` — any other non-2xx. Transient; a retry is reasonable.
 * - `malformed` — 2xx with a body that is not what the route promised. Rarer
 *   and more alarming than a network failure, because it means the two sides
 *   disagree about the contract; separated so it can be surfaced differently.
 * - `network` — `fetch` itself rejected. The server is gone or the socket
 *   died mid-flight.
 */
export type ApiErrorKind = "auth" | "missing" | "server" | "malformed" | "network";

export interface ApiFailure {
  readonly ok: false;
  readonly kind: ApiErrorKind;
  /** HTTP status, or `0` when the request never completed. */
  readonly status: number;
  /** Short, human-facing. Safe to render — never carries a response body. */
  readonly message: string;
}

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly data: T;
  /**
   * `true` when the server answered `304` and `data` is the caller's own
   * previous value. Lets a caller skip re-deriving anything downstream.
   */
  readonly cached: boolean;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

function success<T>(data: T, cached = false): ApiSuccess<T> {
  return { ok: true, data, cached };
}

function failure(kind: ApiErrorKind, status: number, message: string): ApiFailure {
  return { ok: false, kind, status, message };
}

/** Map a non-2xx status to the kind a caller should branch on. */
export function classifyStatus(status: number): ApiErrorKind {
  if (status === 403) return "auth";
  if (status === 404) return "missing";
  return "server";
}

/** The user-facing sentence for a status. Deliberately terse and generic. */
export function messageForStatus(status: number): string {
  if (status === 403) return "not authorised — this workspace session has ended";
  if (status === 404) return "not found";
  return `server error (${status})`;
}

// --- the request core ---------------------------------------------------------------

/**
 * Perform a request and validate the decoded body.
 *
 * Every route goes through here, so there is exactly one place that decides
 * what a rejection, a bad status or an unparseable body means — and exactly
 * one place to look when that decision turns out to be wrong.
 *
 * `guard` is not optional and not a cast. The body arrives from a socket, and
 * "the status was 200" says nothing about the shape: a proxy can interpose,
 * a stale server build can answer an old shape, and `JSON.parse` will happily
 * hand back a number. Narrowing here means every caller below receives a
 * value that has actually been inspected.
 */
async function request<T>(
  fetchImpl: FetchLike,
  url: string,
  guard: (value: unknown) => value is T,
  init?: HttpRequest,
): Promise<ApiResult<T>> {
  let response: HttpResponse;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    // `fetch` rejects on DNS failure, connection refused, and a socket that
    // dies mid-body. All of them are "the server is not there".
    return failure("network", 0, error instanceof Error ? error.message : "network request failed");
  }

  if (!response.ok) return failure(classifyStatus(response.status), response.status, messageForStatus(response.status));

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A truncated response, or an HTML error page from something upstream.
    return failure("malformed", response.status, "response was not valid JSON");
  }

  if (!guard(body)) return failure("malformed", response.status, "response did not match the expected shape");
  return success(body);
}

// --- structural guards ----------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  // `typeof null === "object"`, and an array is an object too — both would
  // pass a naive check and then fail on property access three frames later.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * `GraphPayload`, checked at the depth the client actually depends on.
 *
 * `model.nodes` and `model.edges` are verified to be arrays and `stamp` to be
 * a string, because those three are what the columns index into and what the
 * conditional request compares. Individual node fields are not walked: a per-node
 * validation pass on every refetch is real cost on a large graph, and a
 * malformed node degrades one row rather than crashing the app. The cutoff is
 * "what breaks the shell if absent", not "everything the type declares".
 */
export function isGraphPayload(value: unknown): value is GraphPayload {
  if (!isObject(value)) return false;
  if (typeof value["stamp"] !== "string") return false;
  const model = value["model"];
  if (!isObject(model)) return false;
  if (!Array.isArray(model["nodes"]) || !Array.isArray(model["edges"])) return false;
  return isObject(value["tags"]) && isObject(value["dangling"]);
}

/** `ViewNote`. Every field is rendered, so every field is checked. */
export function isViewNote(value: unknown): value is ViewNote {
  if (!isObject(value)) return false;
  for (const key of ["slug", "title", "body", "created", "updated", "source"]) {
    if (typeof value[key] !== "string") return false;
  }
  return isStringArray(value["tags"]);
}

/** `NotePayload` — the note response wrapper. */
export function isNotePayload(value: unknown): value is NotePayload {
  return isObject(value) && isViewNote(value["note"]);
}

/** `SearchPayload`. Hits are checked as an array; ranking tolerates junk. */
export function isSearchPayload(value: unknown): value is SearchPayload {
  return isObject(value) && typeof value["query"] === "string" && Array.isArray(value["hits"]);
}

/** `OpenResult`. */
export function isOpenResult(value: unknown): value is OpenResult {
  return isObject(value) && typeof value["opened"] === "boolean";
}

export function isMutationResult(value: unknown): value is MutationResult {
  return isObject(value) && value["ok"] === true && (value["id"] === undefined || typeof value["id"] === "string");
}

// --- routes --------------------------------------------------------------------------

/**
 * `GET /api/graph`, conditionally.
 *
 * @param previous the payload currently held, or `null` on first load. When
 *   present its `stamp` is sent as `If-None-Match` and a `304` returns it
 *   back with `cached: true`.
 */
export async function fetchGraph(fetchImpl: FetchLike, previous: GraphPayload | null = null): Promise<ApiResult<GraphPayload>> {
  const headers = previous === null ? undefined : { "if-none-match": `"${previous.stamp}"` };

  let response: HttpResponse;
  try {
    response = await fetchImpl("/api/graph", headers === undefined ? {} : { headers });
  } catch (error) {
    return failure("network", 0, error instanceof Error ? error.message : "network request failed");
  }

  // Handled before the `ok` check: `304` is *not* ok by the Fetch spec's
  // definition (which is 200–299), so testing `ok` first would misclassify
  // the success case as a server error. This is the one place the generic
  // path above cannot serve, which is why this route does not use it.
  if (response.status === 304) {
    // A `304` with nothing to return means we sent an `If-None-Match` we did
    // not have, which is a bug rather than a cache hit. Refuse it loudly
    // rather than handing back a `null` typed as a payload.
    if (previous === null) return failure("malformed", 304, "server sent 304 for an unconditional request");
    return success(previous, true);
  }
  if (!response.ok) return failure(classifyStatus(response.status), response.status, messageForStatus(response.status));

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure("malformed", response.status, "response was not valid JSON");
  }
  if (!isGraphPayload(body)) return failure("malformed", response.status, "response did not match the expected shape");
  return success(body);
}

/**
 * `GET /api/note/:slug`.
 *
 * The slug is percent-encoded here and traversal-checked *there* — the
 * server hands it to `resolveNotePath`, which rejects unsafe slugs. Doing our
 * own check as well would be a second implementation to
 * keep in sync, which is how traversal bugs are actually born (see
 * `routes.ts`). Encoding is still required, because an unencoded `#` or `?`
 * would silently truncate the path.
 *
 * Returns a {@link NotePayload}, not a bare `ViewNote`, so the response shape
 * stays explicit at the HTTP boundary.
 */
export function fetchNote(fetchImpl: FetchLike, slug: string): Promise<ApiResult<NotePayload>> {
  return request(fetchImpl, `/api/note/${encodeURIComponent(slug)}`, isNotePayload);
}

/** `GET /api/search?q=`. An empty query is valid and returns no hits. */
export function fetchSearch(fetchImpl: FetchLike, query: string, signal?: { readonly aborted: boolean }): Promise<ApiResult<SearchPayload>> {
  return request(fetchImpl, `/api/search?q=${encodeURIComponent(query)}`, isSearchPayload, signal === undefined ? undefined : { signal });
}

/**
 * `POST /api/open` — hand the selected note to the user's editor.
 *
 * A missing note answers `404` with `{opened:false}`, which surfaces here as
 * a `missing` failure rather than a success carrying `false`. The status code
 * is the server's chosen signal (see `routes.ts`) and collapsing it into the
 * body would hide the failure from a network panel.
 */
export function openNote(fetchImpl: FetchLike, slug: string): Promise<ApiResult<OpenResult>> {
  return request(fetchImpl, "/api/open", isOpenResult, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
}

function mutation(fetchImpl: FetchLike, url: string, method: string, body?: unknown): Promise<ApiResult<MutationResult>> {
  return request(fetchImpl, url, isMutationResult, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

const noteUrl = (slug: string, suffix = ""): string => `/api/note/${encodeURIComponent(slug)}${suffix}`;
const folderUrl = (path: string, suffix = ""): string => `/api/folder/${path.split("/").map(encodeURIComponent).join("/")}${suffix}`;

export const renameNote = (fetchImpl: FetchLike, slug: string, name: string) => mutation(fetchImpl, noteUrl(slug, "/rename"), "POST", { name });
export const moveNote = (fetchImpl: FetchLike, slug: string, folder: string | null) => mutation(fetchImpl, noteUrl(slug, "/move"), "POST", { folder });
export const deleteNote = (fetchImpl: FetchLike, slug: string) => mutation(fetchImpl, noteUrl(slug), "DELETE");
export const createFolder = (fetchImpl: FetchLike, path: string) => mutation(fetchImpl, folderUrl(path), "POST");
export const renameFolder = (fetchImpl: FetchLike, path: string, name: string) => mutation(fetchImpl, folderUrl(path, "/rename"), "POST", { name });
export const deleteFolder = (fetchImpl: FetchLike, path: string) => mutation(fetchImpl, folderUrl(path), "DELETE");
