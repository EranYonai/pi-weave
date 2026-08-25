/**
 * The platform `fetch`, adapted to `api.ts`'s injected port.
 *
 * `api.ts` deliberately does not name `fetch`, `Response` or `RequestInit`:
 * it is a `.ts` compiled by the **root** `tsconfig.json` whenever a test
 * imports it, and that project has no `DOM` lib, so those types do not exist
 * there. {@link FetchLike} and {@link HttpResponse} are the structural ports
 * that stand in for them.
 *
 * Something still has to call the real thing. That is this file, and it is
 * separate so the untestable surface — one reference to a DOM global — is
 * isolated in four lines rather than smeared through the module that holds
 * all the request logic. Same shape as `domEventSource` in `live.ts`, for the
 * same reason.
 *
 * This module is only reachable from `.tsx` entry points, so it is compiled
 * by `tsconfig.web.json` (which has `DOM`) and never pulled into the root
 * project. That is what lets it name `fetch` at all.
 */

import type { FetchLike, HttpRequest, HttpResponse } from "./api";

/**
 * `globalThis.fetch`, as a {@link FetchLike}.
 *
 * The real `Response` satisfies {@link HttpResponse} structurally — `ok`,
 * `status` and `json()` are all present — so the only work here is dropping
 * the `RequestInit` fields `api.ts` never sets.
 */
export const fetchJson: FetchLike = (url: string, init?: HttpRequest): Promise<HttpResponse> =>
  fetch(url, {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.body === undefined ? {} : { body: init.body }),
    // Loopback only, and the `__Host-weave` cookie is how §5.1 authenticates.
    // `same-origin` is the default in modern browsers; stated explicitly
    // because the whole security model depends on it and a default is a worse
    // place for that dependency than a line of code.
    credentials: "same-origin",
  });
