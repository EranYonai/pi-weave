/**
 * The four security layers of the loopback workspace server
 * (weave-workspace §5.1).
 *
 * ## Why any of this, on 127.0.0.1
 *
 * The retired viewer bound loopback and stopped there —
 * `git show cef1177:src/pi/viewer/server.ts` has **zero** matches for
 * `token`, `Origin` or `Host`. Loopback is not an authorisation boundary:
 *
 *  - every process running as the user can reach the port, and can find it
 *    by scanning a few thousand ports faster than a page loads;
 *  - **any website the user visits** can reach it too, via DNS rebinding —
 *    `evil.com` resolves to a real address for the page load, then re-answers
 *    with `127.0.0.1` on a second lookup, and the browser now treats our
 *    server as same-origin with the attacker's JavaScript.
 *
 * So four layers, each defeating something the others do not:
 *
 * | # | Layer | Defeats |
 * | - | ----- | ------- |
 * | 1 | bind `127.0.0.1`, port `0` | remote reachability; a guessable port |
 * | 2 | {@link isAllowedHost} | DNS rebinding |
 * | 3 | {@link timingSafeMatch} over a 256-bit token | local processes, blind CSRF |
 * | 4 | {@link checkOrigin} | cross-origin writes from a page that got past 2 |
 *
 * Layer 2 is the one that carries the rebinding case, and the reason it
 * works is worth stating: the rebinding attacker controls DNS, not the
 * browser. The browser sends `Host: evil.com` because that is the name in
 * the URL bar, and it cannot be talked out of it — `fetch` rejects an
 * attempt to set `Host` as a forbidden header. An allowlist of
 * `127.0.0.1:PORT` / `localhost:PORT` / `[::1]:PORT` therefore rejects every
 * rebound request while costing a legitimate one a string compare.
 *
 * Layer 4 is deliberately asymmetric, because `Origin` is asymmetric:
 * browsers omit it on same-origin GET *navigations*, so requiring it would
 * break typing the URL into the address bar. Validate-if-present on GET,
 * require on everything else — which is where state changes live.
 *
 * ## Everything here is a pure function of request facts
 *
 * {@link RequestFacts} is four strings, not an `IncomingMessage`, so the
 * table tests in `tests/web/security.test.ts` enumerate the matrix directly
 * instead of constructing sockets. {@link requestFacts} is the one adapter
 * from Node's request object, and it is the only part of this module that
 * knows HTTP exists.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

// --- token -------------------------------------------------------------------

/**
 * Token entropy. 256 bits: not guessable by a local process in the lifetime
 * of a pi session, and short enough in base64url (43 chars) to survive being
 * pasted into a terminal.
 */
export const TOKEN_BYTES = 32;

/** A fresh per-session token. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` **throws** on a length mismatch (`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`),
 * which is the trap this wrapper exists to close: a caller that passes it
 * two user-controlled strings has written a crash, not a comparison. The
 * length pre-check is not a timing leak worth caring about — our token's
 * length is a constant of the program, so an attacker learns nothing they
 * could not read in this file.
 *
 * Byte length, not `String.length`: a multi-byte character would make the
 * two disagree and re-introduce the throw.
 */
export function timingSafeMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  // Zero-length buffers compare equal in `timingSafeEqual`, which would make
  // "" a valid token against an "" secret. Callers never hold an empty
  // token, but a truncated env var is one typo away, so refuse explicitly.
  if (left.length === 0) return false;
  return timingSafeEqual(left, right);
}

// --- host and origin ---------------------------------------------------------

/**
 * The `Host` values a legitimate request can carry. IPv6 loopback is
 * included in bracketed form because that is what a browser sends for
 * `http://[::1]:PORT/`.
 */
export function allowedHosts(port: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/** The `Origin` values matching {@link allowedHosts}. Always `http:`. */
export function allowedOrigins(port: number): ReadonlySet<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
}

/**
 * Layer 2. An absent `Host` is a deny: HTTP/1.1 requires it, and the only
 * clients that omit it are hand-rolled ones probing the port.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return allowedHosts(port).has(host);
}

/**
 * Layer 4. Returns `true` when the request may proceed.
 *
 *  - present and allowlisted → ok, any method;
 *  - present and foreign → denied, any method (this is the cross-origin
 *    write, and also a cross-origin read attempt worth refusing early);
 *  - absent on `GET`/`HEAD` → ok, because browsers omit it on same-origin
 *    navigations and we would otherwise reject the address bar;
 *  - absent on anything else → denied. A state-changing request with no
 *    provenance is exactly the shape of a form-post CSRF.
 */
export function checkOrigin(method: string, origin: string | undefined, port: number): boolean {
  if (origin !== undefined) return allowedOrigins(port).has(origin);
  const safe = method === "GET" || method === "HEAD";
  return safe;
}

// --- cookies -----------------------------------------------------------------

/**
 * Default cookie name. The `__Host-` prefix is a browser-enforced
 * commitment: the cookie must be `Secure`, must have `Path=/`, and must
 * carry **no** `Domain` — which together mean no sibling origin and no
 * subdomain can set or overwrite it. That closes cookie-injection, where an
 * attacker plants their own token so that any request the user makes is
 * attributed to a session the attacker also holds.
 *
 * `Secure` on `http://127.0.0.1` is legal because loopback is a
 * [secure context](https://w3c.github.io/webappsec-secure-contexts/), and
 * Chrome/Firefox/Safari all honour it there. §5.1 footnote 1 asks for a
 * fallback anyway, which is {@link FALLBACK_COOKIE_NAME}: same value, no
 * prefix, no `Secure`, and therefore none of the guarantees above. It exists
 * so a browser that disagrees costs a config flag rather than a redesign.
 */
export const DEFAULT_COOKIE_NAME = "__Host-weave";

/** Prefix-free fallback for a browser that rejects `Secure` on loopback. */
export const FALLBACK_COOKIE_NAME = "weave_token";

/** Query parameter carrying the token on the one-shot handoff URL. */
export const TOKEN_QUERY_PARAM = "t";

/**
 * Parse a `Cookie` request header into a map.
 *
 * Lenient by design — this is header parsing on an attacker-reachable path,
 * so anything malformed is skipped rather than thrown. A pair with no `=` is
 * dropped; a value containing `=` keeps it (base64url does not produce one,
 * but a fallback-named cookie set by something else might).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    // `eq === 0` is a nameless pair ("=v"); `eq === -1` has no separator at
    // all. Both are malformed, and `<= 0` covers them together — which also
    // means a name can never be the empty string below.
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The `Set-Cookie` value for the handoff.
 *
 * `HttpOnly` keeps the token out of `document.cookie`, so an XSS in the
 * client (or in a note's rendered Markdown) cannot exfiltrate it.
 * `SameSite=Strict` means the browser will not attach it to any
 * cross-site-initiated request at all, which is a second, independent answer
 * to the CSRF that {@link checkOrigin} covers.
 *
 * No `Max-Age`: a session cookie dies with the browser session, and the
 * server dies with the pi session, so persisting it would only widen the
 * window in which a stale token exists.
 */
export function buildSetCookie(name: string, token: string): string {
  const attrs = [`${name}=${token}`, "HttpOnly", "SameSite=Strict", "Path=/"];
  // `Secure` is mandatory for `__Host-`; the fallback name exists precisely
  // to be usable without it.
  if (name.startsWith("__Host-")) attrs.push("Secure");
  return attrs.join("; ");
}

// --- the decision ------------------------------------------------------------

/**
 * Everything the policy needs from a request. Four strings, so the matrix is
 * table-testable without a socket.
 */
export interface RequestFacts {
  method: string;
  /** Request target as sent, e.g. `/api/graph?x=1`. Never a full URL. */
  url: string;
  host: string | undefined;
  origin: string | undefined;
  /** Raw `Cookie` header. */
  cookie: string | undefined;
}

/** Minimal structural view of a Node request — avoids importing `http` types. */
export interface IncomingLike {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Read {@link RequestFacts} off a Node request.
 *
 * Node lower-cases header names and collapses duplicates for these four, but
 * a duplicated `Host` still arrives as an array on some proxies; taking the
 * first would let an attacker append an allowlisted value to a foreign one.
 * An array is therefore treated as absent, which fails closed.
 */
export function requestFacts(req: IncomingLike): RequestFacts {
  return {
    method: req.method ?? "GET",
    url: req.url ?? "/",
    host: single(req.headers["host"]),
    origin: single(req.headers["origin"]),
    cookie: single(req.headers["cookie"]),
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * What the server should do with a request.
 *
 *  - `allow`: proceed to routing.
 *  - `handoff`: the URL carried a valid token; set the cookie and `302` to
 *    {@link SecurityDecision.location}, dropping the token from the address
 *    bar (and therefore from `Referer`, from shell history, and from
 *    anything that later reads the tab's URL).
 *  - `deny`: respond `403` with `reason`. The reason is for the server log
 *    and the test table, never for the response body — telling a prober
 *    which layer stopped them is free reconnaissance.
 */
export type SecurityDecision =
  | { kind: "allow" }
  | { kind: "handoff"; location: string; setCookie: string }
  | { kind: "deny"; status: 403; reason: DenyReason };

export type DenyReason = "host" | "origin" | "token";

export interface SecurityOptions {
  port: number;
  /** Defaults to a fresh {@link generateToken}. */
  token?: string;
  /** Defaults to {@link DEFAULT_COOKIE_NAME}. */
  cookieName?: string;
}

export interface SecurityPolicy {
  readonly token: string;
  readonly cookieName: string;
  /** `http://127.0.0.1:PORT` — the canonical origin of this server. */
  readonly origin: string;
  /** The one-shot handoff URL to hand to a browser. */
  readonly entryUrl: string;
  authorize(facts: RequestFacts): SecurityDecision;
}

/**
 * Bind the four layers to a port and a token.
 *
 * A factory rather than free functions with a port argument everywhere: the
 * allowlists are derived from the port, and deriving them once at bind time
 * makes it impossible to check a request against the wrong port — the class
 * of bug where a server restarts on a new port and an allowlist captured
 * earlier keeps accepting the old one.
 */
export function createSecurityPolicy(opts: SecurityOptions): SecurityPolicy {
  const token = opts.token ?? generateToken();
  const cookieName = opts.cookieName ?? DEFAULT_COOKIE_NAME;
  const { port } = opts;
  const origin = `http://127.0.0.1:${port}`;
  const setCookie = buildSetCookie(cookieName, token);

  return {
    token,
    cookieName,
    origin,
    entryUrl: `${origin}/?${TOKEN_QUERY_PARAM}=${token}`,

    authorize(facts: RequestFacts): SecurityDecision {
      // Order matters: cheapest and most decisive first, and never leak
      // whether a token was *nearly* right to a caller who failed layer 2.
      if (!isAllowedHost(facts.host, port)) return { kind: "deny", status: 403, reason: "host" };
      if (!checkOrigin(facts.method, facts.origin, port)) {
        return { kind: "deny", status: 403, reason: "origin" };
      }

      const cookies = parseCookies(facts.cookie);
      const held = cookies[cookieName];
      if (held !== undefined && timingSafeMatch(held, token)) return { kind: "allow" };

      // No valid cookie. A GET may still be the one-shot handoff.
      const query = queryToken(facts.url);
      if (query !== null && facts.method === "GET" && timingSafeMatch(query, token)) {
        return { kind: "handoff", location: stripTokenParam(facts.url), setCookie };
      }
      return { kind: "deny", status: 403, reason: "token" };
    },
  };
}

/**
 * The `t` parameter of a request target, or `null`.
 *
 * Parsed against a fixed dummy base because `req.url` is a path, not an
 * absolute URL, and `new URL` demands one. The base is never used for
 * anything but parsing.
 */
function queryToken(url: string): string | null {
  return parseTarget(url).searchParams.get(TOKEN_QUERY_PARAM);
}

/**
 * The same target with `t` removed — the `302` location.
 *
 * Other parameters survive, so a deep link like `/?t=…&note=alpha` still
 * lands on the note after the handoff.
 */
function stripTokenParam(url: string): string {
  const parsed = parseTarget(url);
  parsed.searchParams.delete(TOKEN_QUERY_PARAM);
  const query = parsed.searchParams.toString();
  return query.length > 0 ? `${parsed.pathname}?${query}` : parsed.pathname;
}

/** Dummy origin for parsing an origin-form request target. */
const PARSE_BASE = "http://weave.invalid";

function parseTarget(url: string): URL {
  try {
    return new URL(url, PARSE_BASE);
  } catch {
    // `new URL` is remarkably hard to break with an origin-form target, but
    // the request line is attacker-controlled and a throw here would be a
    // 500 on an unauthenticated path. Fail closed to a token-less root.
    return new URL("/", PARSE_BASE);
  }
}
