import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialLayout } from "../../src/web/shared/workspace";
import { createWorkspaceStateStore, defaultWorkspaceStateDir } from "../../src/web/server/workspace-state";
import { DEFAULT_COOKIE_NAME } from "../../src/web/server/security";
import { startWorkspaceServer, type WorkspaceServer } from "../../src/web/server/server";
import { gitInit, makeTempDir } from "../helpers";

const TOKEN = "workspace-state-test-token-12345678901234567890";
const VIEW_A = "1e7d9d0a-21f2-4d27-a522-5673e4e31f7b";
const VIEW_B = "2e7d9d0a-21f2-4d27-a522-5673e4e31f7b";
const running: WorkspaceServer[] = [];

afterEach(async () => Promise.all(running.splice(0).map((server) => server.close())));

async function serverFor(cwd: string, vaultRoot: string, presentationStateDir: string): Promise<WorkspaceServer> {
  const server = await startWorkspaceServer({ cwd, vaultRoot, presentationStateDir, token: TOKEN });
  running.push(server);
  return server;
}

function authenticated(server: WorkspaceServer, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(server.url + path, {
    ...init,
    headers: {
      cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`,
      ...(init.method === "POST" ? { origin: server.url, "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function save(server: WorkspaceServer, viewId: string, layout: unknown): Promise<Response> {
  return authenticated(server, "/api/workspace-state", { method: "POST", body: JSON.stringify({ viewId, layout }) });
}

describe("workspace presentation state", () => {
  it("uses the user's pi-weave presentation config directory by default", () => {
    expect(defaultWorkspaceStateDir()).toMatch(/pi-weave[/\\]presentation$/);
  });

  it("returns an authenticated fresh view id and restores the latest layout after a server restart", async () => {
    const cwd = await makeTempDir();
    const vaultRoot = await makeTempDir();
    const stateDir = await makeTempDir();
    gitInit(cwd);
    const first = await serverFor(cwd, vaultRoot, stateDir);
    const id = (await (await authenticated(first, "/api/workspace-state")).json() as { viewId: string }).viewId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    const empty = await (await authenticated(first, "/api/workspace-state")).json() as { layout: unknown };
    expect(empty.layout).toBeNull();
    const layout = { ...initialLayout(), theme: "dark" as const, preferences: { ...initialLayout().preferences, accent: "rose" as const, fontSize: 18, spellcheck: false } };
    expect((await save(first, id, layout)).status).toBe(200);
    await first.close();
    running.splice(running.indexOf(first), 1);

    const second = await serverFor(cwd, vaultRoot, stateDir);
    const restored = await (await authenticated(second, "/api/workspace-state")).json() as { viewId: string; layout: unknown };
    expect(restored.viewId).not.toBe(id);
    expect(restored.layout).toEqual(layout);
    expect((await fetch(second.url + "/api/workspace-state")).status).toBe(403);
  });

  it("rejects malformed layouts and traversal-like view ids", async () => {
    const server = await serverFor(await makeTempDir(), await makeTempDir(), await makeTempDir());
    const malformed = await authenticated(server, "/api/workspace-state", { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
    expect((await save(server, VIEW_A, { ...initialLayout(), ratio: 9 })).status).toBe(400);
    expect((await save(server, "../../outside", initialLayout())).status).toBe(400);
    expect((await save(server, VIEW_A, { ...initialLayout(), extra: true })).status).toBe(400);
    const oversized = JSON.stringify({ viewId: VIEW_A, layout: initialLayout(), extra: "x".repeat(270_000) });
    expect((await authenticated(server, "/api/workspace-state", { method: "POST", body: oversized })).status).toBe(400);
    await expect((await createWorkspaceStateStore(await makeTempDir(), await makeTempDir(), await makeTempDir())).write("../../bad", initialLayout())).rejects.toThrow("viewId must be a UUID");
  });

  it("isolates snapshots by canonical vault and repository roots", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const stateDir = await makeTempDir();
    gitInit(cwd);
    const original = await createWorkspaceStateStore(cwd, vault, stateDir);
    await original.write(VIEW_A, initialLayout());
    expect(await (await createWorkspaceStateStore(cwd, await makeTempDir(), stateDir)).readLatest()).toBeNull();
    expect(await (await createWorkspaceStateStore(await makeTempDir(), vault, stateDir)).readLatest()).toBeNull();
  });

  it("keeps concurrent views isolated within the same workspace", async () => {
    const cwd = await makeTempDir(); const vault = await makeTempDir(); const stateDir = await makeTempDir();
    const first = createWorkspaceStateStore(cwd, vault, stateDir);
    const second = createWorkspaceStateStore(cwd, vault, stateDir);
    const a = { ...initialLayout(), theme: "dark" as const };
    const b = { ...initialLayout(), theme: "light" as const };
    await Promise.all([first.write(VIEW_A, a), second.write(VIEW_B, b)]);
    const [identity] = await fs.readdir(stateDir);
    const dir = join(stateDir, identity!);
    expect(JSON.parse(await fs.readFile(join(dir, `${VIEW_A}.json`), "utf8")).layout).toEqual(a);
    expect(JSON.parse(await fs.readFile(join(dir, `${VIEW_B}.json`), "utf8")).layout).toEqual(b);
    await fs.utimes(join(dir, `${VIEW_B}.json`), new Date(2030, 0), new Date(2030, 0));
    expect(await first.readLatest()).toEqual(b);
  });

  it("uses normalized absolute paths while roots do not exist yet", async () => {
    const cwd = await makeTempDir();
    const vault = join(await makeTempDir(), "not-created-yet");
    const store = await createWorkspaceStateStore(cwd, vault, await makeTempDir());
    await store.write(VIEW_A, initialLayout());
    expect(await store.readLatest()).toEqual(initialLayout());
  });

  it("ignores corrupt snapshots and retains at most eight views", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const stateDir = await makeTempDir();
    const store = await createWorkspaceStateStore(cwd, vault, stateDir);
    for (let i = 1; i <= 9; i++) {
      const id = `${i.toString(16).padStart(8, "0")}-21f2-4d27-a522-5673e4e31f7b`;
      await store.write(id, initialLayout());
    }
    const [workspaceDir] = await fs.readdir(stateDir);
    const files = await fs.readdir(join(stateDir, workspaceDir!));
    expect(files).toHaveLength(8);
    await fs.writeFile(join(stateDir, workspaceDir!, files[0]!), "not json");
    const wrongId = files[1]!;
    await fs.writeFile(join(stateDir, workspaceDir!, wrongId), JSON.stringify({ version: 1, viewId: "wrong", layout: initialLayout() }));
    const badLayout = files[2]!;
    await fs.writeFile(join(stateDir, workspaceDir!, badLayout), JSON.stringify({ version: 1, viewId: badLayout.slice(0, -5), layout: {} }));
    expect(await store.readLatest()).toEqual(initialLayout());
  });

  it("propagates non-missing read errors instead of treating them as empty state", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const stateDir = await makeTempDir();
    const store = await createWorkspaceStateStore(cwd, vault, stateDir);
    await store.write(VIEW_A, initialLayout());
    const [workspaceDir] = await fs.readdir(stateDir);
    const path = join(stateDir, workspaceDir!);
    await fs.rm(path, { recursive: true });
    await fs.writeFile(path, "not a directory");
    await expect(store.readLatest()).rejects.toThrow();
  });

  it("returns filesystem write failures as server errors", async () => {
    const stateDir = await makeTempDir();
    const server = await serverFor(await makeTempDir(), await makeTempDir(), stateDir);
    const identity = await (await authenticated(server, "/api/workspace-state")).json() as { viewId: string };
    expect((await save(server, identity.viewId, initialLayout())).status).toBe(200);
    const [workspaceDir] = await fs.readdir(stateDir);
    const snapshot = join(stateDir, workspaceDir!, `${identity.viewId}.json`);
    await fs.rm(snapshot);
    await fs.mkdir(snapshot);
    const failed = await save(server, identity.viewId, initialLayout());
    expect(failed.status).toBe(500);
    expect(await failed.text()).toContain("pi-weave:");
  });
});
