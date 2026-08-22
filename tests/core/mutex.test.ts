import { describe, expect, it } from "vitest";
import { withMutationQueue } from "../../src/core/mutex";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("withMutationQueue", () => {
  it("serializes tasks sharing a key, in call order", async () => {
    const order: string[] = [];
    const gate = deferred<void>();

    const first = withMutationQueue("note:a.md", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
      return 1;
    });
    const second = withMutationQueue("note:a.md", async () => {
      order.push("second:start");
      return 2;
    });

    // Drain microtasks: second must not start while first is gated.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    gate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("lets different keys run concurrently", async () => {
    const order: string[] = [];
    const gateA = deferred<void>();
    const a = withMutationQueue("note:a.md", async () => {
      order.push("a:start");
      await gateA.promise;
      order.push("a:end");
    });
    const b = withMutationQueue("note:b.md", async () => {
      order.push("b");
    });
    await b;
    gateA.resolve();
    await a;
    expect(order).toEqual(["a:start", "b", "a:end"]); // b didn't wait for a
  });

  it("propagates a rejection to its own caller without wedging the queue", async () => {
    const boom = new Error("write failed");
    await expect(
      withMutationQueue("note:c.md", async () => { throw boom; }),
    ).rejects.toThrow("write failed");

    const after = await withMutationQueue("note:c.md", async () => "recovered");
    expect(after).toBe("recovered");
  });

  it("passes each task's resolved value through", async () => {
    const [one, two] = await Promise.all([
      withMutationQueue("note:d.md", async () => "one"),
      withMutationQueue("note:d.md", async () => "two"),
    ]);
    expect(one).toBe("one");
    expect(two).toBe("two");
  });
});
