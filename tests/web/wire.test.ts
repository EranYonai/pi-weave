/**
 * The wire contract (weave-workspace §5.3, §10).
 *
 * Almost all of `src/web/shared/wire.ts` is types, which erase — there is
 * nothing to execute and nothing to test. The two runtime exports are the
 * ones worth pinning:
 *
 *  - {@link CHANGE_SCOPES}, because a scope added to the union without a
 *    matching entry here would pass typecheck and then be silently rejected
 *    by the guard at runtime;
 *  - {@link isChangeEvent}, which parses data off a socket that survives
 *    server restarts and proxy interference. "It is JSON" is not the same as
 *    "it is ours", and the failure mode without a guard is an unhandled
 *    rejection inside an `EventSource` callback, where nothing catches it.
 */

import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_ELEMENT_ID,
  CHANGE_EVENT_NAME,
  CHANGE_SCOPES,
  isChangeEvent,
  type ChangeEvent,
  type ChangeScope,
} from "../../src/web/shared/wire";

describe("CHANGE_SCOPES", () => {
  it("lists every scope in the union, with no duplicates", () => {
    // The exhaustiveness check: assigning the literal array to the union
    // type fails compilation if a scope is missing from the type, and the
    // length check fails at runtime if one is missing from the constant.
    const scopes: readonly ChangeScope[] = ["vault", "repo", "git"];
    expect([...CHANGE_SCOPES].sort()).toEqual([...scopes].sort());
    expect(new Set(CHANGE_SCOPES).size).toBe(CHANGE_SCOPES.length);
  });
});

describe("isChangeEvent", () => {
  const valid: ChangeEvent[] = [
    { scope: "vault", stamp: "2026-01-01T00:00:00.000Z" },
    { scope: "repo", stamp: "" },
    { scope: "git", stamp: "anything" },
  ];

  for (const event of valid) {
    it(`accepts ${JSON.stringify(event)}`, () => {
      expect(isChangeEvent(event)).toBe(true);
    });
  }

  it("accepts a frame carrying extra fields", () => {
    // Forward compatibility: a newer server adding a field must not make an
    // older client reject every frame it sends.
    expect(isChangeEvent({ scope: "vault", stamp: "s", paths: ["a"] })).toBe(true);
  });

  const rejected: Array<[label: string, value: unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "vault"],
    ["a number", 1],
    ["a boolean", true],
    ["an array", ["vault", "s"]],
    ["an empty object", {}],
    ["a missing stamp", { scope: "vault" }],
    ["a missing scope", { stamp: "s" }],
    ["a non-string stamp", { scope: "vault", stamp: 1 }],
    ["a null stamp", { scope: "vault", stamp: null }],
    ["an unknown scope", { scope: "cosmic", stamp: "s" }],
    ["a non-string scope", { scope: 1, stamp: "s" }],
    ["a scope of the wrong case", { scope: "Vault", stamp: "s" }],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(isChangeEvent(value)).toBe(false);
    });
  }

  it("never throws, whatever arrives on the socket", () => {
    // The guard runs inside an `EventSource` callback, where a throw is
    // unhandled and kills liveness for the rest of the session.
    for (const [, value] of rejected) expect(() => isChangeEvent(value)).not.toThrow();
    expect(() => isChangeEvent(Object.create(null))).not.toThrow();
  });

  it("narrows the type for the caller", () => {
    const value: unknown = { scope: "repo", stamp: "s" };
    if (!isChangeEvent(value)) throw new Error("expected a change event");
    // A compile-time assertion as much as a runtime one: `value` is a
    // `ChangeEvent` inside this branch, so these reads typecheck.
    expect(value.scope).toBe("repo");
    expect(value.stamp).toBe("s");
  });
});

describe("protocol constants", () => {
  it("names the SSE event and the bootstrap element", () => {
    // Shared between the server that writes them and the client that reads
    // them — the whole reason they are constants and not string literals in
    // two files.
    expect(CHANGE_EVENT_NAME).toBe("change");
    expect(BOOTSTRAP_ELEMENT_ID).toBe("weave-bootstrap");
    // The id goes into an HTML attribute; keeping it to a safe character set
    // means the shell's escaper never has to alter it.
    expect(BOOTSTRAP_ELEMENT_ID).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
