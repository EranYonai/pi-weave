import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createVaultBackup } from "../../src/web/server/backup";
import { startWorkspaceServer } from "../../src/web/server/server";
import { makeTempDir, writeFixture } from "../helpers";

it("archives complete vault bytes, empty folders and linked content; cleans temporary output", async () => {
  const vault = await makeTempDir();
  const linked = await makeTempDir();
  const note = "---\nsource: human\n---\n# café\n原文\n";
  await writeFixture(vault, "notes/café.md", note);
  await writeFixture(vault, ".metadata/config.json", '{"source":"human"}');
  await writeFixture(vault, "__proto__", "ordinary file");
  await fs.mkdir(join(vault, "empty"));
  const image = Uint8Array.from({ length: 200000 }, (_, index) => index % 251);
  await fs.writeFile(join(vault, "image.png"), image);
  await writeFixture(linked, "linked.txt", "linked content");
  await fs.symlink(linked, join(vault, "linked"));
  await fs.symlink(join(vault, "notes/café.md"), join(vault, "alias.md"));
  const backup = await createVaultBackup(vault);
  const entries = unzipSync(await fs.readFile(backup.path));
  expect(new TextDecoder().decode(entries["notes/café.md"])).toBe(note);
  expect(entries["image.png"]).toEqual(image);
  expect(entries["empty/"]).toEqual(new Uint8Array());
  expect(new TextDecoder().decode(entries["linked/linked.txt"])).toBe("linked content");
  expect(new TextDecoder().decode(entries["alias.md"])).toBe(note);
  expect(new TextDecoder().decode(entries[".metadata/config.json"])).toBe('{"source":"human"}');
  expect(new TextDecoder().decode(entries["__proto__"])).toBe("ordinary file");
  // Verify with an independent archive reader, not only the generating library.
  expect(execFileSync("unzip", ["-t", backup.path], { encoding: "utf8" })).toContain("No errors detected");
  await backup.dispose();
  await expect(fs.stat(backup.path)).rejects.toThrow();
  expect(await fs.readFile(join(vault, "notes/café.md"), "utf8")).toBe(note);
});

it("creates a valid empty vault archive", async () => {
  const backup = await createVaultBackup(await makeTempDir());
  expect(unzipSync(await fs.readFile(backup.path))).toEqual({});
  await backup.dispose();
});

describe("backup failures", () => {
  it("rejects link cycles, broken links, special entries and ambiguous archive paths", async () => {
    const cycle = await makeTempDir();
    await fs.symlink(cycle, join(cycle, "cycle"));
    await expect(createVaultBackup(cycle)).rejects.toThrow("cycle");
    const broken = await makeTempDir();
    await fs.symlink(join(broken, "absent"), join(broken, "broken"));
    await expect(createVaultBackup(broken)).rejects.toThrow("ENOENT");
    const invalid = await makeTempDir();
    await writeFixture(invalid, "..\\escape", "bad archive path");
    await expect(createVaultBackup(invalid)).rejects.toThrow("filename");
    const special = await makeTempDir();
    execFileSync("mkfifo", [join(special, "pipe")]);
    await expect(createVaultBackup(special)).rejects.toThrow("Unsupported vault entry");
    const big = await makeTempDir();
    const sparse = await fs.open(join(big, "large"), "w");
    await sparse.truncate(0x100000000); await sparse.close();
    await expect(createVaultBackup(big)).rejects.toThrow("ZIP format limits");
  });
});

it("offers an authenticated attachment and reports backup errors before sending ZIP bytes", async () => {
  const cwd = await makeTempDir(); const vaultRoot = await makeTempDir();
  await writeFixture(vaultRoot, "notes/one.md", "# One");
  const server = await startWorkspaceServer({ cwd, vaultRoot, presentationStateDir: await makeTempDir() });
  try {
    expect((await fetch(`${server.url}/api/backup`)).status).toBe(403);
    const headers = { cookie: `${server.security.cookieName}=${server.token}` };
    const response = await fetch(`${server.url}/api/backup`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/attachment; filename="weave-vault-.*\.zip"/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new TextDecoder().decode(unzipSync(new Uint8Array(await response.arrayBuffer()))["notes/one.md"])).toBe("# One");
    const state = await fetch(`${server.url}/api/workspace-state`, { headers });
    expect(((await state.json()) as { info: unknown }).info).toEqual({ vaultRoot, version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    await fs.symlink(join(vaultRoot, "missing"), join(vaultRoot, "broken"));
    const failed = await fetch(`${server.url}/api/backup`, { headers });
    expect(failed.status).toBe(500);
    expect(failed.headers.get("content-type")).toContain("text/plain");
  } finally { await server.close(); }
});
