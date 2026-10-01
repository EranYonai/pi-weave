import { describe, expect, it } from "vitest";
import { WorkspaceServerController } from "../../src/web/server/controller";

describe("WorkspaceServerController", () => {
  it("closes every server when repositories switch concurrently", async () => {
    const closed: string[] = [];
    let signalClosing!: () => void;
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => { signalClosing = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseClose = resolve; });
    const controller = new WorkspaceServerController({
      vaultRoot: () => "/vault",
      startServer: async ({ cwd }) => ({
        port: 1,
        entryUrl: `http://127.0.0.1/${cwd}`,
        async close() {
          if (cwd === "/a") {
            signalClosing();
            await blocked;
          }
          closed.push(cwd);
        },
      }) as never,
    });

    await controller.run("/a");
    const second = controller.run("/b");
    await closing;
    const third = controller.run("/c");
    releaseClose();
    const [b, c] = await Promise.all([second, third]);
    expect(b.session.cwd).toBe("/b");
    expect(c.session.cwd).toBe("/c");
    expect(closed).toEqual(["/a", "/b"]);
    await controller.close();
    expect(closed).toEqual(["/a", "/b", "/c"]);
  });
});
