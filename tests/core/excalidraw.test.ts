import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  addNote, ensureVault, EXCALIDRAW_METADATA_LIMIT, getExcalidrawArtifact,
  getNote, readVault, renameFolder, repairVaultLinks,
  resolveExcalidrawPath, statNotes,
} from "../../src/core/vault";
import { buildCurrentGraph } from "../../src/core/graph/current";
import { extractWikilinks } from "../../src/core/graph/wikilinks";
import { auditLinks, normalizeTarget } from "../../src/core/links/repair";
import { WorkspaceCache, classifyPath } from "../../src/core/cache/workspace";
import { makeTempDir } from "../helpers";

const source = '{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[],"appState":{},"files":{},"custom":"kept"}\n';

async function scene(root: string, slug = "diagrams/Auth Flow.excalidraw", content = source): Promise<string> {
  const path = join(root, "notes", slug);
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, content);
  return path;
}

describe("Excalidraw files", () => {
  it("discovers scene metadata without changing bytes or interpreting export origin as authorship", async () => {
    const root = await makeTempDir();
    await ensureVault(root);
    await scene(root);
    await addNote(root, { title: "Companion", body: "[[diagrams/Auth Flow.excalidraw]]", source: "agent" });
    const vault = await readVault(root);
    expect(vault.artifactCount).toBe(1);
    expect(vault.fileCount).toBe(1);
    expect(vault.artifacts).toEqual([expect.objectContaining({
      kind: "excalidraw", slug: "diagrams/Auth Flow.excalidraw", title: "Auth Flow", status: "valid", size: Buffer.byteLength(source),
    })]);
    expect(await fs.readFile(join(root, "notes", "diagrams/Auth Flow.excalidraw"))).toEqual(Buffer.from(source));
    const graph = await buildCurrentGraph(await makeTempDir(), root);
    expect(graph.nodes.find((node) => node.id === "artifact:diagrams/Auth Flow.excalidraw")).toMatchObject({
      kind: "file", provenance: null, detail: { kind: "excalidraw", status: "valid", "link references": "1" },
    });
    expect(graph.edges).toContainEqual({ source: "note:companion", target: "artifact:diagrams/Auth Flow.excalidraw", kind: "links-to" });
    expect(graph.danglingLinks).toEqual({});
    expect((await statNotes(root)).map((stat) => stat.slug).sort()).toEqual(["companion", "diagrams/Auth Flow.excalidraw"]);
  });

  it.each(["{bad JSON", "null", "[]", "{}", '{"type":"other","elements":[]}', '{"type":"excalidraw"}', '{"type":"excalidraw","elements":{}}'])
  ("retains invalid scene %s for recovery", async (content) => {
    const root = await makeTempDir();
    await scene(root, "broken.excalidraw", content);
    expect(await getExcalidrawArtifact(root, "broken.excalidraw")).toMatchObject({ status: "invalid", error: expect.stringContaining("recover") });
    expect(await fs.readFile(join(root, "notes", "broken.excalidraw"))).toEqual(Buffer.from(content));
    const vault = await readVault(root);
    expect(vault.artifactCount).toBe(1);
    expect(vault.artifacts?.[0]).toMatchObject({ status: "invalid" });
    const graph = await buildCurrentGraph(await makeTempDir(), root);
    expect(graph.nodes.find((node) => node.id === "artifact:broken.excalidraw")?.detail).toMatchObject({ status: "invalid", error: expect.any(String) });
  });

  it("bounds metadata validation while preserving large sources", async () => {
    const root = await makeTempDir();
    const content = source.trimEnd() + " ".repeat(EXCALIDRAW_METADATA_LIMIT);
    await scene(root, "large.excalidraw", content);
    expect(await getExcalidrawArtifact(root, "large.excalidraw")).toMatchObject({ status: "unverified", size: Buffer.byteLength(content) });
    expect((await fs.readFile(join(root, "notes", "large.excalidraw"))).equals(Buffer.from(content))).toBe(true);
    const exact = source.trimEnd() + " ".repeat(EXCALIDRAW_METADATA_LIMIT - Buffer.byteLength(source.trimEnd()));
    await scene(root, "limit.excalidraw", exact);
    expect(await getExcalidrawArtifact(root, "limit.excalidraw")).toMatchObject({ status: "valid" });
  });

  it("rejects missing, directory, traversal, wrong-case and unsafe scene paths", async () => {
    const root = await makeTempDir();
    await scene(root);
    for (const slug of ["missing.excalidraw", "diagrams/auth Flow.excalidraw", "Diagrams/Auth Flow.excalidraw", "../escape.excalidraw", "/escape.excalidraw", "diagrams/../escape.excalidraw", "./diagrams/Auth Flow.excalidraw", "diagrams//Auth Flow.excalidraw", "diagrams\\Auth Flow.excalidraw", "bad\0.excalidraw", "scene.json"]) {
      expect(await resolveExcalidrawPath(root, slug)).toBeNull();
      expect(await getExcalidrawArtifact(root, slug)).toBeNull();
    }
    await fs.mkdir(join(root, "notes", "directory.excalidraw"));
    expect(await getExcalidrawArtifact(root, "directory.excalidraw")).toBeNull();
    expect(await getExcalidrawArtifact(await makeTempDir(), "missing.excalidraw")).toBeNull();
  });

  it("allows internal aliases and canonical vault roots while excluding external scene targets", async () => {
    const root = await makeTempDir();
    const external = await makeTempDir();
    const target = await scene(root, "real.excalidraw");
    const outside = await scene(external, "outside.excalidraw");
    await fs.symlink(target, join(root, "notes", "alias.excalidraw"));
    await fs.symlink(outside, join(root, "notes", "external.excalidraw"));
    await fs.symlink(join(external, "notes"), join(root, "notes", "mounted"));
    await fs.writeFile(join(external, "notes", "old.html"), "<title>Mounted HTML</title>");
    await fs.symlink("missing.excalidraw", join(root, "notes", "broken.excalidraw"));
    await fs.mkdir(join(root, "notes", "internal"));
    await scene(root, "internal/nested.excalidraw");
    await fs.symlink(join(root, "notes", "internal"), join(root, "notes", "directory-alias"));
    expect(await resolveExcalidrawPath(root, "alias.excalidraw")).toBe(await fs.realpath(target));
    expect(await resolveExcalidrawPath(root, "directory-alias/nested.excalidraw")).toBe(await fs.realpath(join(root, "notes/internal/nested.excalidraw")));
    expect(await resolveExcalidrawPath(root, "external.excalidraw")).toBeNull();
    expect(await resolveExcalidrawPath(root, "mounted/outside.excalidraw")).toBeNull();
    const vault = await readVault(root);
    expect(vault.artifacts?.map((artifact) => artifact.slug)).toContain("mounted/old.html");
    expect(vault.artifacts?.map((artifact) => artifact.slug)).not.toContain("external.excalidraw");
    expect(vault.artifacts?.map((artifact) => artifact.slug)).not.toContain("mounted/outside.excalidraw");
    const aliasRoot = join(await makeTempDir(), "vault-alias");
    await fs.symlink(root, aliasRoot);
    expect(await resolveExcalidrawPath(aliasRoot, "alias.excalidraw")).toBe(await fs.realpath(target));
  });

  it("survives unreadable scenes without failing vault discovery", async () => {
    const root = await makeTempDir();
    await scene(root, "read-error.excalidraw");
    const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("open error"));
    expect(await getExcalidrawArtifact(root, "read-error.excalidraw")).toBeNull();
    open.mockRestore();
  });

  it("keeps exact scene links and never repairs them into colliding note titles", async () => {
    const target = "diagrams/Auth Flow.excalidraw";
    expect(extractWikilinks(`[[${target}|Diagram]] [[./${target}]] [[diagrams/auth flow.excalidraw]]`)).toEqual([target, "diagrams/auth flow.excalidraw"]);
    expect(normalizeTarget(`./${target}`)).toBe(target);
    const audit = auditLinks({
      notes: [{ slug: "hub", title: "Hub", body: `[[${target}]] [[diagrams/auth flow.excalidraw]] [[gone.excalidraw]]` },
        { slug: "gone-excalidraw", title: "gone.excalidraw", body: "" }],
      artifacts: [{ slug: target }],
    });
    expect(audit.resolved).toBe(1);
    expect(audit.fixable).toEqual([]);
    expect(audit.unresolvable.map((link) => link.target)).toEqual(["diagrams/auth flow.excalidraw", "gone.excalidraw"]);
    const root = await makeTempDir();
    await scene(root);
    await addNote(root, { title: "Hub", body: `[[${target}]]` });
    expect((await repairVaultLinks(root, { apply: true })).audit.resolved).toBe(1);
    expect((await getNote(root, "hub"))?.body).toBe(`[[${target}]]`);
  });

  it("renames diagram folders and rewrites backlinks while keeping scene bytes", async () => {
    const root = await makeTempDir();
    await scene(root);
    await scene(root, "diagrams/deep/Nested.excalidraw");
    await addNote(root, { title: "Hub", body: "[[diagrams/Auth Flow.excalidraw|Overview]] [[diagrams/deep/Nested.excalidraw]]" });
    expect(await renameFolder(root, "diagrams", "Architecture")).toEqual({ ok: true, path: "architecture" });
    expect((await getNote(root, "hub"))?.body).toBe("[[architecture/Auth Flow.excalidraw|Overview]] [[architecture/deep/Nested.excalidraw|diagrams/deep/Nested.excalidraw]]");
    expect(await fs.readFile(join(root, "notes", "architecture/Auth Flow.excalidraw"))).toEqual(Buffer.from(source));
    expect(await resolveExcalidrawPath(root, "diagrams/Auth Flow.excalidraw")).toBeNull();
  });

  it("never repairs a wrong-case scene extension into a Markdown note", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Manual.EXCALIDRAW", body: "An unrelated note" });
    await addNote(root, { title: "Hub", body: "[[Manual.EXCALIDRAW]]" });
    expect(extractWikilinks("[[Manual.EXCALIDRAW]]")).toEqual(["Manual.EXCALIDRAW"]);
    expect(normalizeTarget("./Manual.EXCALIDRAW")).toBe("Manual.EXCALIDRAW");
    const result = await repairVaultLinks(root, { apply: true });
    expect(result.audit.fixable).toEqual([]);
    expect(result.audit.unresolvable.map((link) => link.target)).toContain("Manual.EXCALIDRAW");
    expect((await getNote(root, "hub"))?.body).toBe("[[Manual.EXCALIDRAW]]");
  });

  it("caches scenes, notices external updates and handles explicit invalidation/removal", async () => {
    const root = await makeTempDir();
    const path = await scene(root);
    const cwd = await makeTempDir();
    const cache = new WorkspaceCache({ cwd, vaultRoot: root });
    expect(classifyPath(path, { cwd, vaultRoot: root })).toBe("vault");
    expect(await cache.graph()).toEqual(await buildCurrentGraph(cwd, root));
    const reads = cache.stats().notesRead;
    await cache.graph();
    expect(cache.stats().notesRead).toBe(reads);
    await fs.writeFile(path, "{broken");
    const changed = await cache.graph();
    expect(changed.nodes.find((node) => node.id === "artifact:diagrams/Auth Flow.excalidraw")?.detail.status).toBe("invalid");
    expect(changed).toEqual(await buildCurrentGraph(cwd, root));
    await fs.writeFile(path, source);
    cache.invalidate(path);
    expect((await cache.graph()).nodes.find((node) => node.id === "artifact:diagrams/Auth Flow.excalidraw")?.detail.status).toBe("valid");
    await fs.unlink(path);
    expect((await cache.graph()).nodes.some((node) => node.id.startsWith("artifact:"))).toBe(false);
  });
});
