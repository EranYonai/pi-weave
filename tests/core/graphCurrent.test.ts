import { describe, expect, it } from "vitest";
import {
  buildCurrentGraph,
  readNoteForView,
  readOkfFileForView,
  readRepositorySide,
  type ViewNote,
} from "../../src/core/graph/current";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import { addNote } from "../../src/core/vault";
import { commitAll, gitInit, makeTempDir, withVaultEnv, writeFixture } from "../helpers";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("buildCurrentGraph (core)", () => {
  it("builds a fresh vault-only graph per call (no caching)", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const cwd = await makeTempDir();
      let model = await buildCurrentGraph(cwd, vault);
      expect(model.nodes.some((n) => n.id === "vault")).toBe(true);
      expect(model.nodes.some((n) => n.kind === "note")).toBe(false);

      await addNote(vault, { title: "First", body: "hello", source: "human" });
      model = await buildCurrentGraph(cwd, vault);
      expect(model.nodes.some((n) => n.kind === "note")).toBe(true);
      // staleness is null outside a git repo
      expect(model.staleness).toBeNull();
    });
  });

  it("includes the repository side when cwd is an indexed git repo, with staleness", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const repo = await makeTempDir();
      gitInit(repo);
      await writeFixture(repo, "src/index.ts", "export const x = 1;\n");
      commitAll(repo, "init");
      const index = await buildRepoIndex(repo);
      expect(index).not.toBeNull();
      await writeRepoIndex(repo, index!);

      const model = await buildCurrentGraph(repo, vault);
      expect(model.nodes.some((n) => n.id === "repository")).toBe(true);
      expect(model.staleness).not.toBeNull();
    });
  });

  it("skips a repo without an index and degrades to vault-only", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const repo = await makeTempDir();
      gitInit(repo);
      commitAll(repo, "init"); // git repo, but no .okf index
      const model = await buildCurrentGraph(repo, vault);
      expect(model.nodes.some((n) => n.id === "repository")).toBe(false);
      expect(model.staleness).toBeNull();
    });
  });

  it("degrades on a corrupt index without throwing", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const repo = await makeTempDir();
      gitInit(repo);
      await writeFixture(repo, "src/index.ts", "x\n");
      commitAll(repo, "init");
      await mkdir(join(repo, ".okf", "repository"), { recursive: true });
      await writeFile(join(repo, ".okf", "repository", "structure.json"), "{not json", "utf8");
      await writeFile(
        join(repo, ".okf", "repository", "identity.json"),
        JSON.stringify({ name: "demo", root: repo, remotes: [], defaultBranch: "main" }),
        "utf8",
      );
      await writeFile(join(repo, ".okf", "repository", "git.json"), "{}", "utf8");

      // corrupt structure.json → readRepoIndex returns null → vault-only graph
      const model = await buildCurrentGraph(repo, vault);
      expect(model.nodes.some((n) => n.id === "repository")).toBe(false);
    });
  });

  it("surfaces a handwritten entry-point summary sidecar in node detail", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      const repo = await makeTempDir();
      gitInit(repo);
      await writeFixture(repo, "src/index.ts", "export const x = 1;\n");
      commitAll(repo, "init");
      const index = await buildRepoIndex(repo);
      await writeRepoIndex(repo, index!);
      await mkdir(join(repo, ".okf", "repository", "summaries"), { recursive: true });
      await writeFile(
        join(repo, ".okf", "repository", "summaries", "src--index.ts.summary.md"),
        "---\ntarget: src/index.ts\nsource: generated\ncontent_hash: abc\nat: 2026-04-01T00:00:00.000Z\nmodel: ollama/x\n---\n\nA summary.",
        "utf8",
      );

      const model = await buildCurrentGraph(repo, vault);
      const ep = model.nodes.find((n) => n.id === "entryPoint:src/index.ts");
      expect(ep?.detail.summary).toBe("A summary.");
    });
  });
});

describe("readNoteForView (core)", () => {
  it("returns null for unsafe slugs without touching disk", async () => {
    const vault = await makeTempDir();
    expect(await readNoteForView(vault, "../escape")).toBeNull();
    expect(await readNoteForView(vault, "a/b")).toBeNull();
    expect(await readNoteForView(vault, "")).toBeNull();
  });

  it("returns the note shape for an existing note", async () => {
    const vault = await makeTempDir();
    await addNote(vault, { title: "Hello", body: "body text", source: "agent", tags: ["t1"] });
    const summaries = await import("../../src/core/vault").then((m) => m.listNotes(vault));
    const slug = summaries[0]!.slug;
    const note = await readNoteForView(vault, slug);
    expect(note).not.toBeNull();
    expect((note as ViewNote).title).toBe("Hello");
    expect((note as ViewNote).body).toBe("body text");
    expect((note as ViewNote).source).toBe("agent");
    expect((note as ViewNote).tags).toEqual(["t1"]);
  });

  it("returns null for a missing note", async () => {
    const vault = await makeTempDir();
    expect(await readNoteForView(vault, "does-not-exist")).toBeNull();
  });
});

describe("readOkfFileForView (core)", () => {
  it("reads a file and rejects traversal or missing paths", async () => {
    const repo = await makeTempDir();
    await mkdir(join(repo, ".okf", "repository"), { recursive: true });
    await writeFile(join(repo, ".okf", "repository", "git.json"), '{"branch":"main"}', "utf8");
    await writeFile(join(repo, "secret.txt"), "top secret", "utf8");

    const good = await readOkfFileForView(repo, "repository/git.json");
    expect(good?.body).toContain("main");
    expect(good?.path).toBe("repository/git.json");

    const missing = await readOkfFileForView(repo, "repository/absent.json");
    expect(missing).toBeNull();

    const traversal = await readOkfFileForView(repo, "../../secret.txt");
    expect(traversal).toBeNull();
  });

  it("refuses absolute and rooted escapes", async () => {
    const repo = await makeTempDir();
    expect(await readOkfFileForView(repo, "/etc/passwd")).toBeNull();
  });
});

// Integration: builders ⇄ view-model boundary sanity (model invariants).
describe("buildCurrentGraph ⇄ GraphModel invariants", () => {
  it("returns a GraphModel with stable ids (slugs/paths only)", async () => {
    const vault = await makeTempDir();
    await withVaultEnv(vault, async () => {
      await addNote(vault, { title: "Stable", body: "[[Other]]", source: "human" });
      await addNote(vault, { title: "Other", body: "back", source: "agent" });
      const cwd = await makeTempDir();
      const a = await buildCurrentGraph(cwd, vault);
      const b = await buildCurrentGraph(cwd, vault);
      expect(a.nodes.map((n) => n.id).sort()).toEqual(b.nodes.map((n) => n.id).sort());
      // a note links to the other
      expect(a.edges.some((e) => e.kind === "links-to")).toBe(true);
    });
  });
});

// Shared by the cached and uncached graph paths, so it gets its own coverage.
describe("readRepositorySide (core)", () => {
  it("returns the index, staleness, and summaries for an indexed repo", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "src/index.ts", "export const x = 1;\n");
    commitAll(repo, "init");
    await writeRepoIndex(repo, (await buildRepoIndex(repo))!);

    const side = await readRepositorySide(repo);
    expect(side).not.toBeNull();
    expect(side!.repository?.index.scope).toBe("repository");
    expect(side!.repository?.staleness.state).toBe("fresh");
    expect(side!.summaries).toBeInstanceOf(Map);
  });

  it("returns null outside a git repository", async () => {
    expect(await readRepositorySide(await makeTempDir())).toBeNull();
  });

  it("returns null for a git repo with no .okf index", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    commitAll(repo, "init");
    expect(await readRepositorySide(repo)).toBeNull();
  });
});
