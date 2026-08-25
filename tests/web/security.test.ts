/**
 * The four security layers (weave-workspace §5.1, §10).
 *
 * Table-driven, because the thing being tested *is* a table: a decision over
 * (Host × Origin × method × token-presence). Enumerating it here rather than
 * over a socket is the point — every one of these cases is a request some
 * local process or hostile page can actually send, and there are more of
 * them than anyone would boot a server for.
 *
 * The cases worth reading twice:
 *
 *  - **`Host: evil.com`** is the DNS-rebinding request. It is the one attack
 *    loopback binding does not stop, and the only thing that stops it is the
 *    allowlist.
 *  - **`Origin` absent on GET** must be *allowed*. Browsers omit it on
 *    same-origin navigations, so a policy that required it would reject the
 *    user typing the URL — the most common request there is.
 *  - **`Origin` absent on POST** must be *denied*, for exactly the same
 *    reason inverted: a state change with no provenance is the shape of a
 *    form-post CSRF.
 *  - **A wrong-length token** must return `false`, not throw.
 *    `timingSafeEqual` raises `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on a
 *    length mismatch, so an unguarded comparison is a `500` on an
 *    unauthenticated path — a denial of service reachable by anyone who can
 *    reach the port.
 */

import { describe, expect, it } from "vitest";
import {
  allowedHosts,
  allowedOrigins,
  buildSetCookie,
  checkOrigin,
  createSecurityPolicy,
  DEFAULT_COOKIE_NAME,
  FALLBACK_COOKIE_NAME,
  generateToken,
  isAllowedHost,
  parseCookies,
  requestFacts,
  timingSafeMatch,
  TOKEN_BYTES,
  TOKEN_QUERY_PARAM,
  type RequestFacts,
} from "../../src/web/server/security";

const PORT = 51234;
const TOKEN = "T".repeat(43); // the length base64url(32 bytes) produces

function facts(over: Partial<RequestFacts> = {}): RequestFacts {
  return {
    method: "GET",
    url: "/",
    host: `127.0.0.1:${PORT}`,
    origin: undefined,
    cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`,
    ...over,
  };
}

function policy(over: { token?: string; cookieName?: string } = {}) {
  return createSecurityPolicy({ port: PORT, token: TOKEN, ...over });
}

// --- layer 1: the token -------------------------------------------------------

describe("generateToken", () => {
  it("is 256 bits of base64url", () => {
    const token = generateToken();
    expect(TOKEN_BYTES).toBe(32);
    // base64url of 32 bytes is 43 unpadded characters.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("="); // base64url, so URL-safe and pad-free
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(seen.size).toBe(50);
  });
});

describe("timingSafeMatch", () => {
  const cases: Array<[label: string, a: string, b: string, expected: boolean]> = [
    ["identical", TOKEN, TOKEN, true],
    ["one character differs", TOKEN, "X" + TOKEN.slice(1), false],
    ["shorter candidate", TOKEN.slice(0, 10), TOKEN, false],
    ["longer candidate", TOKEN + "extra", TOKEN, false],
    ["empty candidate", "", TOKEN, false],
    ["both empty", "", "", false],
    ["multi-byte, same length in code units", "é".repeat(43), TOKEN, false],
    ["multi-byte, identical", "é–漢", "é–漢", true],
  ];

  for (const [label, a, b, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(timingSafeMatch(a, b)).toBe(expected);
    });
  }

  it("never throws on a length mismatch", () => {
    // The whole reason this wrapper exists. `timingSafeEqual` throws
    // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on unequal buffers; a route that
    // let that escape would answer 500 to any unauthenticated caller who
    // sent a short cookie.
    for (const length of [0, 1, 2, 42, 44, 1000]) {
      expect(() => timingSafeMatch("z".repeat(length), TOKEN)).not.toThrow();
    }
  });

  it("treats a same-length multi-byte string as a length mismatch by bytes", () => {
    // "é" is one UTF-16 code unit but two UTF-8 bytes. Comparing by
    // `String.length` would hand `timingSafeEqual` unequal buffers and
    // re-introduce the throw this guard removes.
    expect(() => timingSafeMatch("é".repeat(43), TOKEN)).not.toThrow();
    expect(timingSafeMatch("é".repeat(43), TOKEN)).toBe(false);
  });
});

// --- layer 2: the Host allowlist ---------------------------------------------

describe("isAllowedHost", () => {
  const cases: Array<[host: string | undefined, expected: boolean, why: string]> = [
    [`127.0.0.1:${PORT}`, true, "the canonical loopback host"],
    [`localhost:${PORT}`, true, "the name most users type"],
    [`[::1]:${PORT}`, true, "IPv6 loopback, bracketed as a browser sends it"],
    ["evil.com", false, "a DNS-rebinding request: the browser sends the name in the URL bar"],
    [`evil.com:${PORT}`, false, "rebinding with the right port is still the wrong name"],
    ["127.0.0.1", false, "no port: a different authority, and never what a browser sends"],
    [`127.0.0.1:${PORT + 1}`, false, "a neighbouring pi session's port"],
    [`127.0.0.2:${PORT}`, false, "loopback range, but not the address we bound"],
    [`::1:${PORT}`, false, "unbracketed IPv6 is not the form a browser produces"],
    [`LOCALHOST:${PORT}`, false, "case-sensitive: we compare bytes, not names"],
    [` 127.0.0.1:${PORT}`, false, "leading whitespace is a different header value"],
    ["", false, "empty"],
    [undefined, false, "absent — HTTP/1.1 requires Host, so only a prober omits it"],
  ];

  for (const [host, expected, why] of cases) {
    it(`${JSON.stringify(host)} → ${expected} (${why})`, () => {
      expect(isAllowedHost(host, PORT)).toBe(expected);
    });
  }

  it("derives the allowlist from the port it is given", () => {
    expect([...allowedHosts(80)]).toEqual(["127.0.0.1:80", "localhost:80", "[::1]:80"]);
    expect(isAllowedHost("127.0.0.1:80", 80)).toBe(true);
    expect(isAllowedHost("127.0.0.1:80", 81)).toBe(false);
  });
});

// --- layer 3: the Origin rule ------------------------------------------------

describe("checkOrigin", () => {
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  const cases: Array<[method: string, origin: string | undefined, expected: boolean, why: string]> = [
    ["GET", undefined, true, "browsers omit Origin on same-origin navigations"],
    ["HEAD", undefined, true, "same as GET — safe, and navigable"],
    ["GET", ORIGIN, true, "present and ours"],
    ["GET", `http://localhost:${PORT}`, true, "the other name for the same server"],
    ["GET", `http://[::1]:${PORT}`, true, "IPv6 loopback"],
    ["GET", "http://evil.com", false, "cross-origin read attempt, refused early"],
    ["GET", "null", false, "an opaque origin — a sandboxed iframe or a data: URL"],
    ["GET", `https://127.0.0.1:${PORT}`, false, "scheme is part of an origin; we are http"],
    ["GET", `http://127.0.0.1:${PORT + 1}`, false, "a different port is a different origin"],
    ["POST", undefined, false, "a state change with no provenance: form-post CSRF"],
    ["POST", ORIGIN, true, "present and ours"],
    ["POST", "http://evil.com", false, "the cross-origin write this layer exists for"],
    ["DELETE", undefined, false, "every non-safe method requires Origin"],
    ["PUT", undefined, false, "including ones we do not route"],
    ["OPTIONS", undefined, false, "no preflight path: we emit no CORS headers at all"],
  ];

  for (const [method, origin, expected, why] of cases) {
    it(`${method} + ${JSON.stringify(origin)} → ${expected} (${why})`, () => {
      expect(checkOrigin(method, origin, PORT)).toBe(expected);
    });
  }

  it("derives the origin allowlist from the port", () => {
    expect([...allowedOrigins(80)]).toEqual(["http://127.0.0.1:80", "http://localhost:80", "http://[::1]:80"]);
  });
});

// --- cookies ------------------------------------------------------------------

describe("parseCookies", () => {
  const cases: Array<[header: string | undefined, expected: Record<string, string>]> = [
    [undefined, {}],
    ["", {}],
    ["a=1", { a: "1" }],
    ["a=1; b=2", { a: "1", b: "2" }],
    ["  a = 1 ;  b = 2 ", { a: "1", b: "2" }],
    [`${DEFAULT_COOKIE_NAME}=${TOKEN}`, { [DEFAULT_COOKIE_NAME]: TOKEN }],
    // A value containing "=" keeps it; only the first "=" splits.
    ["a=b=c", { a: "b=c" }],
    // Malformed pairs are skipped, not thrown on: this parses an
    // attacker-reachable header.
    ["novalue", {}],
    ["=novalue", {}],
    ["; ; ;", {}],
    ["a=1; garbage; b=2", { a: "1", b: "2" }],
    ["a=", { a: "" }],
  ];

  for (const [header, expected] of cases) {
    it(`${JSON.stringify(header)} → ${JSON.stringify(expected)}`, () => {
      expect(parseCookies(header)).toEqual(expected);
    });
  }

  it("later duplicates win, deterministically", () => {
    expect(parseCookies("a=1; a=2")).toEqual({ a: "2" });
  });

  it("a whitespace-only name becomes an unlookupable empty key, never a match", () => {
    // `" =1"` has its `=` at index 1, so it survives the `eq <= 0` guard and
    // trims to an empty name. Harmless — no cookie name we ever look up is
    // empty — but worth pinning so the behaviour is chosen rather than
    // stumbled into.
    expect(parseCookies(" =1")).toEqual({ "": "1" });
    expect(policy().authorize(facts({ cookie: " =1" }))).toMatchObject({ reason: "token" });
  });
});

describe("buildSetCookie", () => {
  it("sets every attribute __Host- requires", () => {
    const value = buildSetCookie(DEFAULT_COOKIE_NAME, TOKEN);
    expect(value).toBe(`__Host-weave=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Secure`);
    // The `__Host-` prefix is only honoured with all three of Secure,
    // Path=/, and no Domain — omitting any one silently downgrades it to an
    // ordinary cookie a sibling origin can overwrite.
    expect(value).toContain("Secure");
    expect(value).toContain("Path=/");
    expect(value).not.toContain("Domain");
  });

  it("omits Secure for the prefix-free fallback (§5.1 footnote 1)", () => {
    // The escape hatch if a browser refuses Secure on http://127.0.0.1.
    // Without the prefix, Secure would make the cookie unsettable over
    // plain http in that browser — which is the failure we are working
    // around, not one to reproduce.
    const value = buildSetCookie(FALLBACK_COOKIE_NAME, TOKEN);
    expect(value).toBe(`weave_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
    expect(value).not.toContain("Secure");
  });

  it("always sets HttpOnly and SameSite=Strict", () => {
    // HttpOnly: an XSS in rendered note Markdown cannot read the token.
    // SameSite=Strict: the browser never attaches it to a cross-site
    // request, which is a second, independent answer to CSRF.
    for (const name of [DEFAULT_COOKIE_NAME, FALLBACK_COOKIE_NAME]) {
      const value = buildSetCookie(name, TOKEN);
      expect(value).toContain("HttpOnly");
      expect(value).toContain("SameSite=Strict");
    }
  });
});

// --- requestFacts -------------------------------------------------------------

describe("requestFacts", () => {
  it("reads the four headers the policy needs", () => {
    expect(
      requestFacts({
        method: "POST",
        url: "/api/open",
        headers: { host: "h", origin: "o", cookie: "c", "user-agent": "ignored" },
      }),
    ).toEqual({ method: "POST", url: "/api/open", host: "h", origin: "o", cookie: "c" });
  });

  it("defaults a missing method and url", () => {
    expect(requestFacts({ headers: {} })).toEqual({
      method: "GET",
      url: "/",
      host: undefined,
      origin: undefined,
      cookie: undefined,
    });
  });

  it("treats a duplicated header as absent, which fails closed", () => {
    // A proxy that folds two Host headers into an array must not let an
    // attacker append an allowlisted value to a foreign one and have the
    // first-wins read pick the wrong element.
    const f = requestFacts({ headers: { host: ["evil.com", `127.0.0.1:${PORT}`], origin: ["a", "b"] } });
    expect(f.host).toBeUndefined();
    expect(f.origin).toBeUndefined();
    expect(isAllowedHost(f.host, PORT)).toBe(false);
  });
});

// --- the composed decision ----------------------------------------------------

describe("createSecurityPolicy", () => {
  it("exposes the canonical origin and a one-shot entry URL", () => {
    const p = policy();
    expect(p.origin).toBe(`http://127.0.0.1:${PORT}`);
    expect(p.entryUrl).toBe(`http://127.0.0.1:${PORT}/?${TOKEN_QUERY_PARAM}=${TOKEN}`);
    expect(p.token).toBe(TOKEN);
    expect(p.cookieName).toBe(DEFAULT_COOKIE_NAME);
  });

  it("generates a token and picks the __Host- name by default", () => {
    const p = createSecurityPolicy({ port: PORT });
    expect(p.token).toHaveLength(43);
    expect(p.cookieName).toBe(DEFAULT_COOKIE_NAME);
  });

  it("accepts the fallback cookie name", () => {
    const p = policy({ cookieName: FALLBACK_COOKIE_NAME });
    expect(p.authorize(facts({ cookie: `${FALLBACK_COOKIE_NAME}=${TOKEN}` })).kind).toBe("allow");
    // …and then does not accept the default name, so a stale cookie from a
    // previous configuration is not silently honoured.
    expect(p.authorize(facts({ cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}` })).kind).toBe("deny");
  });

  describe("authorize — the decision matrix", () => {
    type Expected = "allow" | "handoff" | "host" | "origin" | "token";
    const cases: Array<[label: string, over: Partial<RequestFacts>, expected: Expected]> = [
      // Happy paths.
      ["GET with a valid cookie", {}, "allow"],
      ["POST with a valid cookie and our Origin", { method: "POST", origin: `http://127.0.0.1:${PORT}` }, "allow"],
      ["GET via localhost", { host: `localhost:${PORT}` }, "allow"],
      ["GET via IPv6 loopback", { host: `[::1]:${PORT}` }, "allow"],

      // Layer 2 — and it runs first, so a rebinding request never reaches
      // the token comparison at all.
      ["rebinding host", { host: "evil.com" }, "host"],
      ["rebinding host with a valid token in the URL", { host: "evil.com", url: `/?t=${TOKEN}` }, "host"],
      ["absent host", { host: undefined }, "host"],
      ["neighbouring port", { host: `127.0.0.1:${PORT + 1}` }, "host"],

      // Layer 4.
      ["GET with a foreign Origin", { origin: "http://evil.com" }, "origin"],
      ["POST with no Origin", { method: "POST" }, "origin"],
      ["POST with a foreign Origin", { method: "POST", origin: "http://evil.com" }, "origin"],
      ["DELETE with no Origin", { method: "DELETE" }, "origin"],

      // Layer 3.
      ["no cookie at all", { cookie: undefined }, "token"],
      ["empty cookie header", { cookie: "" }, "token"],
      ["cookie with the wrong value", { cookie: `${DEFAULT_COOKIE_NAME}=nope` }, "token"],
      ["cookie under the wrong name", { cookie: `other=${TOKEN}` }, "token"],
      ["cookie with an empty value", { cookie: `${DEFAULT_COOKIE_NAME}=` }, "token"],
      ["cookie one character off", { cookie: `${DEFAULT_COOKIE_NAME}=X${TOKEN.slice(1)}` }, "token"],
      ["cookie of the wrong length", { cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN.slice(0, 10)}` }, "token"],

      // The handoff.
      ["GET /?t=TOKEN with no cookie", { cookie: undefined, url: `/?t=${TOKEN}` }, "handoff"],
      ["GET /?t=WRONG with no cookie", { cookie: undefined, url: "/?t=wrong" }, "token"],
      ["GET /?t= (empty) with no cookie", { cookie: undefined, url: "/?t=" }, "token"],
      [
        "POST /?t=TOKEN — the handoff is GET-only",
        { cookie: undefined, method: "POST", origin: `http://127.0.0.1:${PORT}`, url: `/?t=${TOKEN}` },
        "token",
      ],
      [
        "GET /api/graph?t=TOKEN — a handoff on any path, since the token is what is being spent",
        { cookie: undefined, url: `/api/graph?t=${TOKEN}` },
        "handoff",
      ],
    ];

    for (const [label, over, expected] of cases) {
      it(`${label} → ${expected}`, () => {
        const decision = policy().authorize(facts(over));
        if (expected === "allow" || expected === "handoff") {
          expect(decision.kind).toBe(expected);
        } else {
          expect(decision).toEqual({ kind: "deny", status: 403, reason: expected });
        }
      });
    }

    it("checks Host before Origin before the token", () => {
      // Ordering is a security property, not a style choice: a prober whose
      // Host was rejected must not learn whether their token was also
      // wrong, and the cheapest check should run first.
      const p = policy();
      const everythingWrong = facts({ host: "evil.com", origin: "http://evil.com", cookie: undefined });
      expect(p.authorize(everythingWrong)).toMatchObject({ reason: "host" });
      expect(p.authorize({ ...everythingWrong, host: `127.0.0.1:${PORT}` })).toMatchObject({ reason: "origin" });
      expect(p.authorize({ ...everythingWrong, host: `127.0.0.1:${PORT}`, origin: undefined })).toMatchObject({
        reason: "token",
      });
    });

    it("prefers a valid cookie over the URL token", () => {
      // Already authenticated: no redirect, no re-issued cookie.
      expect(policy().authorize(facts({ url: `/?t=${TOKEN}` })).kind).toBe("allow");
    });
  });

  describe("the handoff response", () => {
    it("strips the token and keeps every other parameter", () => {
      const decision = policy().authorize(facts({ cookie: undefined, url: `/?t=${TOKEN}&note=alpha&x=1` }));
      expect(decision).toMatchObject({ kind: "handoff" });
      if (decision.kind !== "handoff") throw new Error("unreachable");
      // The token leaves the address bar — and therefore Referer, shell
      // history, and anything that later reads the tab's URL — while a deep
      // link still lands where it was aimed.
      expect(decision.location).toBe("/?note=alpha&x=1");
      expect(decision.location).not.toContain(TOKEN);
      expect(decision.setCookie).toBe(buildSetCookie(DEFAULT_COOKIE_NAME, TOKEN));
    });

    it("redirects to a bare path when the token was the only parameter", () => {
      const decision = policy().authorize(facts({ cookie: undefined, url: `/?t=${TOKEN}` }));
      if (decision.kind !== "handoff") throw new Error("expected a handoff");
      expect(decision.location).toBe("/");
    });

    it("preserves the path", () => {
      const decision = policy().authorize(facts({ cookie: undefined, url: `/api/graph?t=${TOKEN}` }));
      if (decision.kind !== "handoff") throw new Error("expected a handoff");
      expect(decision.location).toBe("/api/graph");
    });

    it("the entry URL it advertises is itself a valid handoff", () => {
      // The round trip that matters: whatever `entryUrl` we print must be
      // something `authorize` accepts, or the browser opens on a 403.
      const p = policy();
      const target = p.entryUrl.slice(p.origin.length);
      expect(p.authorize(facts({ cookie: undefined, url: target })).kind).toBe("handoff");
    });

    it("survives a malformed request target by failing closed", () => {
      // `req.url` comes off the request line and is attacker-controlled. A
      // throw inside URL parsing would be a 500 on an unauthenticated path.
      for (const url of ["/%", "//", "/\\", "/?%", "/?t=%zz", ""]) {
        expect(() => policy().authorize(facts({ cookie: undefined, url }))).not.toThrow();
      }
    });
  });
});
