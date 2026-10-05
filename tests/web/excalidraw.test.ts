import { promises as fs } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { startWorkspaceServer, type WorkspaceServer } from "../../src/web/server/server";
import { createVaultBackup } from "../../src/web/server/backup";
import { WIKILINK_ATTR, artifactKeyOfNode, previewCard, renderWikilink, resolveWikilink, selectedArtifactPath, wikiIndex, wikilinkTargetOf } from "../../src/web/client/note/note.model";
import { graphPreview } from "../../src/web/client/graph/column.model";
import type { GraphPayload, WireGraphNode } from "../../src/web/shared/wire";
import { makeTempDir, writeFixture } from "../helpers";

const scene = JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements: [{ type: "image", fileId: "img" }], files: { img: { dataURL: "data:image/png;base64,aHVtYW4taW1hZ2U=" } }, customData: { human: "café" } }) + "\n";
const running: WorkspaceServer[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())); });

async function setup() {
  const vaultRoot = await makeTempDir();
  await writeFixture(vaultRoot, "notes/diagrams/Auth 'café'.excalidraw", scene);
  const server = await startWorkspaceServer({ cwd: await makeTempDir(), vaultRoot, presentationStateDir: await makeTempDir() });
  running.push(server);
  const headers = { cookie: `${server.security.cookieName}=${server.token}` };
  const get = (slug: string) => fetch(`${server.url}/api/scene/${encodeURIComponent(slug)}`, { headers });
  return { vaultRoot, server, headers, get };
}

describe("scene download and preservation", () => {
  it("requires authentication and sends exact source bytes with safe attachment headers", async () => {
    const { get, server } = await setup();
    expect((await fetch(`${server.url}/api/scene/test.excalidraw`)).status).toBe(403);
    const response = await get("diagrams/Auth 'café'.excalidraw");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"Auth__caf__.excalidraw\"; filename*=UTF-8''Auth%20%27caf%C3%A9%27.excalidraw");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(scene));
  });

  it("supports internal aliases but rejects encoded escapes, external targets and absent files", async () => {
    const { vaultRoot, get } = await setup();
    const outside = await makeTempDir();
    await writeFixture(outside, "outside.excalidraw", scene);
    await fs.symlink(join(vaultRoot, "notes/diagrams/Auth 'café'.excalidraw"), join(vaultRoot, "notes/alias.excalidraw"));
    await fs.symlink(join(outside, "outside.excalidraw"), join(vaultRoot, "notes/outside.excalidraw"));
    expect(await (await get("alias.excalidraw")).text()).toBe(scene);
    for (const slug of ["../outside.excalidraw", "/outside.excalidraw", "diagrams/../alias.excalidraw", "outside.excalidraw", "missing.excalidraw", "diagrams/auth 'café'.excalidraw", "alias.json"]) {
      expect((await get(slug)).status).toBe(404);
    }
  });

  it("offers malformed source for recovery without interpreting or replacing bytes", async () => {
    const { vaultRoot, get } = await setup();
    await writeFixture(vaultRoot, "notes/broken.excalidraw", "{human partial edit\n");
    const response = await get("broken.excalidraw");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{human partial edit\n");
  });

  it("backs up original scene bytes including embedded images and human fields", async () => {
    const root = await makeTempDir();
    await writeFixture(root, "notes/diagrams/flow.excalidraw", scene);
    const backup = await createVaultBackup(root);
    try {
      const entries = unzipSync(await fs.readFile(backup.path));
      expect(Buffer.from(entries["notes/diagrams/flow.excalidraw"]!)).toEqual(Buffer.from(scene));
      expect(JSON.parse(new TextDecoder().decode(entries["notes/diagrams/flow.excalidraw"])).files.img.dataURL).toContain("aHVtYW4taW1hZ2U=");
    } finally { await backup.dispose(); }
  });
});

describe("scene navigation", () => {
  const path = "diagrams/Auth Flow.excalidraw";
  const id = `artifact:${path}`;
  const node: WireGraphNode = { id, kind: "file", label: "Auth Flow", provenance: null, detail: { path, kind: "excalidraw", updated: "2026-10-05" } };
  const payload: GraphPayload = {
    model: { generatedAt: "", staleness: null, nodes: [node, { id: "note:collision", kind: "note", label: path, provenance: "agent", detail: {} }], edges: [], contentDigest: "" },
    tags: {}, dangling: { hub: ["gone.excalidraw"] }, positions: null, stamp: "",
  };

  it("resolves exact filenames ahead of note-title collisions and normalizes local separators", () => {
    const index = wikiIndex(payload, "hub");
    for (const target of [path, `./${path}`, "diagrams\\Auth Flow.excalidraw"]) expect(resolveWikilink(index, target)).toBe(id);
    expect(resolveWikilink(index, "diagrams/auth flow.excalidraw")).toBeNull();
    expect(resolveWikilink(index, "gone.excalidraw")).toBeNull();
    expect(renderWikilink(index, path, "Diagram")).toContain(`${WIKILINK_ATTR}="${id}"`);
    expect(wikilinkTargetOf({ getAttribute: () => id, parentElement: null })).toBe(id);
  });

  it("keeps missing scenes non-actionable and supplies correct hover/selection labels", () => {
    const html = renderWikilink(wikiIndex(payload, "hub"), "gone.excalidraw", "Missing");
    expect(html).not.toContain(WIKILINK_ATTR);
    expect(html).not.toContain("href=");
    expect(previewCard(payload, { slug: id, text: "Diagram" })).toEqual({ ghost: false, title: "Auth Flow", kind: "Excalidraw diagram", text: path });
    expect(selectedArtifactPath(payload, id)).toBe(path);
    expect(artifactKeyOfNode(node)).toBe(`${path}:2026-10-05`);
    expect(graphPreview(payload, id)).toMatchObject({ title: "Auth Flow", kind: "Excalidraw diagram", icon: "file" });
  });
});
