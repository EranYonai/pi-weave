import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphModel } from "../../src/core/graph/model";
import { startViewer, buildCurrentGraph, openNoteCommand, openNoteInEditor } from "../../src/pi/viewer/server";
import { renderPage } from "../../src/pi/viewer/page";
import { browserCommand } from "../../src/pi/viewer/browser";
import { addNote } from "../../src/core/vault";
import { buildRepoIndex, writeRepoIndex } from "../../src/core/repoIndex";
import { commitAll, gitInit, makeTempDir, writeFixture } from "../helpers";

async function httpGet(url: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const res = await fetch(url);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, text: await res.text() };
}

describe("renderPage", () => {
  it("is a self-contained HTML page with no external resources", () => {
    const page = renderPage();
    expect(page).toContain("<title>pi-weave");
    expect(page).toContain("graph.json");
    expect(page).not.toMatch(/src=["']https?:/);
    expect(page).not.toMatch(/href=["']https?:/);
  });

  it("rendered page contains no backtick and no template substitution (single-file invariant)", () => {
    const page = renderPage();
    expect(page).not.toContain("`");
    expect(page).not.toContain("${");
  });
});

describe("browserCommand", () => {
  it("maps each platform to its opener", () => {
    expect(browserCommand("http://x", "darwin")).toEqual({ command: "open", args: ["http://x"] });
    expect(browserCommand("http://x", "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", "http://x"] });
    expect(browserCommand("http://x", "linux")).toEqual({ command: "xdg-open", args: ["http://x"] });
    expect(browserCommand("http://x")).toHaveProperty("command"); // default platform branch
  });
});

describe("weave-view server", () => {
  it("serves the page at / with a CSP header, and 404s unknown routes", async () => {
    const server = await startViewer({ cwd: await makeTempDir() });
    try {
      const root = await httpGet(server.url + "/");
      expect(root.status).toBe(200);
      expect(root.headers["content-type"]).toContain("text/html");
      expect(root.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(root.headers["content-security-policy"]).toContain("script-src");
      expect(root.text).toContain("knowledge view");

      const missing = await httpGet(server.url + "/nope");
      expect(missing.status).toBe(404);

      const nonGet = await fetch(server.url + "/", { method: "POST" });
      expect(nonGet.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("serves a fresh graph per request — a new note appears without restart", async () => {
    const cwd = await makeTempDir();
    const vault = await makeTempDir();
    const server = await startViewer({ cwd, vaultRoot: vault });
    try {
      const before = JSON.parse((await httpGet(server.url + "/graph.json")).text) as GraphModel;
      expect(before.nodes.map((n) => n.id)).toEqual(["vault"]);

      await addNote(vault, { title: "Live note", body: "hello [[now-visible]]", tags: [], source: "human" });
      await addNote(vault, { title: "now visible", body: "x", tags: [], source: "agent" });

      const after = JSON.parse((await httpGet(server.url + "/graph.json")).text) as GraphModel;
      const ids = after.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(["note:live-note", "note:now-visible", "vault"]);
      expect(after.edges).toContainEqual({ source: "note:live-note", target: "note:now-visible", kind: "links-to" });
      expect(after.nodes.find((n) => n.id === "note:now-visible")?.provenance).toBe("agent");
    } finally {
      await server.stop();
    }
  });

  it("includes the repository side when cwd is an indexed repo, with staleness", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.ts", "export const x = 1;\n");
    commitAll(repo, "init");
    const index = await buildRepoIndex(repo);
    expect(index).not.toBeNull();
    if (index !== null) await writeRepoIndex(repo, index);

    const server = await startViewer({ cwd: join(repo, "."), vaultRoot: await makeTempDir() });
    try {
      const graph = JSON.parse((await httpGet(server.url + "/graph.json")).text) as GraphModel;
      expect(graph.nodes.some((n) => n.id === "repository")).toBe(true);
      expect(graph.nodes.some((n) => n.id === "gitState")).toBe(true);
      expect(graph.staleness?.state).toBe("fresh");

      // Dirty the tree → next request reports stale (no caching anywhere).
      await writeFixture(repo, "dirty.ts", "x");
      const later = JSON.parse((await httpGet(server.url + "/graph.json")).text) as GraphModel;
      expect(later.staleness?.state).toBe("stale");
    } finally {
      await server.stop();
    }
  });

  it("buildCurrentGraph skips a repo without an index and degrades on a corrupt index", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "a.ts", "x");
    commitAll(repo, "init");

    const vault = await makeTempDir();
    // No index at all → vault-only graph
    let graph = await buildCurrentGraph(repo, vault);
    expect(graph.nodes.some((n) => n.id === "repository")).toBe(false);

    // Corrupt okf.json → treated as unindexed, never throws
    await fs.mkdir(join(repo, ".okf"), { recursive: true });
    await fs.writeFile(join(repo, ".okf", "okf.json"), "not json", "utf8");
    graph = await buildCurrentGraph(repo, vault);
    expect(graph.nodes.some((n) => n.id === "repository")).toBe(false);
  });

  it("buildCurrentGraph surfaces a handwritten entry-point summary sidecar", async () => {
    const repo = await makeTempDir();
    gitInit(repo);
    await writeFixture(repo, "src/index.ts", "export const x = 1;\n");
    commitAll(repo, "init");
    const index = await buildRepoIndex(repo);
    if (index !== null) await writeRepoIndex(repo, index);

    // Handwritten sidecar for the entry point (deep-scan output shape).
    const summariesDir = join(repo, ".okf", "repository", "summaries");
    await fs.mkdir(summariesDir, { recursive: true });
    await fs.writeFile(
      join(summariesDir, "src--index.ts.summary.md"),
      [
        "---",
        "target: src/index.ts",
        "source: generated",
        "content_hash: abc",
        "at: 2026-08-23T12:00:00.000Z",
        "model: test/model",
        "---",
        "Entry point summary.",
        "",
      ].join("\n"),
      "utf8",
    );

    const graph = await buildCurrentGraph(repo, await makeTempDir());
    const entry = graph.nodes.find((n) => n.id === "entryPoint:src/index.ts");
    expect(entry?.detail.summary).toBe("Entry point summary.");
    expect(entry?.detail["summarized by"]).toBe("test/model");
  });

  it("gives two servers distinct ports and stops idempotently", async () => {
    const a = await startViewer({ cwd: await makeTempDir() });
    const b = await startViewer({ cwd: await makeTempDir() });
    try {
      expect(a.port).not.toBe(b.port);
      expect(a.url).toContain(String(a.port));
    } finally {
      await a.stop();
      await a.stop(); // idempotent — must not throw
      await b.stop();
    }
    // After stop, connections refuse.
    await expect(httpGet(a.url + "/")).rejects.toThrow();
  });

  it("honors PI_WEAVE_VIEW_PORT when set to a valid pin", async () => {
    const socket = await (async () => {
      const { createServer } = await import("node:net");
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      await new Promise<void>((r) => probe.close(() => r()));
      return port;
    })();
    const before = process.env.PI_WEAVE_VIEW_PORT;
    process.env.PI_WEAVE_VIEW_PORT = String(socket);
    try {
      const server = await startViewer({ cwd: await makeTempDir() });
      try {
        expect(server.port).toBe(socket);
      } finally {
        await server.stop();
      }
    } finally {
      if (before === undefined) delete process.env.PI_WEAVE_VIEW_PORT;
      else process.env.PI_WEAVE_VIEW_PORT = before;
    }
  });
});

describe("weave-view /note/<slug> route", () => {
  it("serves a note body live, 404s unknown slugs, and refuses traversal", async () => {
    const vault = await makeTempDir();
    await addNote(vault, { title: "Panel Note", body: "# Hello\n\nSome **markdown**.", tags: ["x"], source: "human" });
    const server = await startViewer({ cwd: await makeTempDir(), vaultRoot: vault });
    try {
      const ok = await httpGet(`${server.url}/note/panel-note`);
      expect(ok.status).toBe(200);
      const note = JSON.parse(ok.text) as { slug: string; body: string; source: string };
      expect(note.slug).toBe("panel-note");
      expect(note.body).toContain("**markdown**");
      expect(note.source).toBe("human");

      const missing = await httpGet(`${server.url}/note/ghost`);
      expect(missing.status).toBe(404);

      const traversal = await httpGet(`${server.url}/note/..%2F..%2Fetc%2Fpasswd`);
      expect(traversal.status).toBe(404);

      const post = await fetch(`${server.url}/note/panel-note`, { method: "POST" });
      expect(post.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("readNoteForView returns null for unsafe slugs without touching disk", async () => {
    const { readNoteForView } = await import("../../src/pi/viewer/server");
    const vault = await makeTempDir();
    expect(await readNoteForView(vault, "../escape")).toBeNull();
    expect(await readNoteForView(vault, "missing")).toBeNull();
  });
});

describe("page pure functions (extract-and-run)", () => {
  interface PureFns {
    focusNeighborhood: (id: string, edges: { source: string; target: string; kind: string }[]) => Record<string, number>;
    deriveBacklinks: (edges: { source: string; target: string; kind: string }[]) => Record<string, string[]>;
    applyFilter: (items: { kind: string; provenance: string | null }[], kind: string | null, prov: string | null) => { kind: string; provenance: string | null }[];
    sortRows: (rows: { label: string; updated: string; links: number; provenance: string }[], key: string) => { label: string; updated: string; links: number; provenance: string }[];
    counts: (nodes: { provenance: string | null }[]) => { total: number; human: number; agent: number; generated: number; structural: number };
    relTime: (iso: string, now: number) => string;
    linksOf: (id: string, edges: { source: string; target: string; kind: string }[]) => number;
    listLabel: (node: { kind: string; label: string; detail: Record<string, string> }) => string;
    listTree: (model: { nodes: { id: string; kind: string; label: string; provenance: string | null; detail: Record<string, string> }[]; edges: { source: string; target: string; kind: string }[] }, state: { kindFilter: string; provFilter: string; recentDays: number; query: string; listSort: string; listExpanded: Record<string, number>; showInternals?: boolean }) => { id: string; depth: number; hasKids: boolean; expanded: boolean }[];
  }
  function extractScript(html: string): string {
    const m = /<script>([\s\S]*)<\/script>/.exec(html);
    if (!m || m[1] === undefined) throw new Error("no script in page");
    return m[1];
  }
  function pureFns(html: string): PureFns {
    const m = /\/\/ ===== pure =====([\s\S]*?)\/\/ ===== end pure =====/.exec(extractScript(html));
    if (!m || m[1] === undefined) throw new Error("pure block not found");
    const make = new Function(
      m[1] +
        "; return { focusNeighborhood: focusNeighborhood, deriveBacklinks: deriveBacklinks, " +
        "applyFilter: applyFilter, sortRows: sortRows, counts: counts, relTime: relTime, " +
        "linksOf: linksOf, listLabel: listLabel, listTree: listTree };",
    );
    return make() as PureFns;
  }
  const fns = pureFns(renderPage());

  it("focusNeighborhood returns the 1-hop neighborhood including the node", () => {
    const edges = [
      { source: "a", target: "b", kind: "links-to" },
      { source: "c", target: "a", kind: "links-to" },
      { source: "b", target: "d", kind: "links-to" },
    ];
    const nb = fns.focusNeighborhood("a", edges);
    expect(nb).toEqual({ a: 1, b: 1, c: 1 });
    expect(nb.d).toBeUndefined(); // 2-hop excluded
  });

  it("deriveBacklinks maps each target to its incoming links-to sources", () => {
    const edges = [
      { source: "a", target: "b", kind: "links-to" },
      { source: "c", target: "b", kind: "links-to" },
      { source: "a", target: "c", kind: "contains" }, // non-links-to ignored
    ];
    const bl = fns.deriveBacklinks(edges);
    expect(bl.b).toEqual(["a", "c"]);
    expect(bl.c).toBeUndefined();
  });

  it("applyFilter filters by kind and provenance independently", () => {
    const items = [
      { kind: "note", provenance: "human" },
      { kind: "note", provenance: "agent" },
      { kind: "module", provenance: "generated" },
    ];
    expect(fns.applyFilter(items, "note", null)).toHaveLength(2);
    expect(fns.applyFilter(items, null, "generated")).toHaveLength(1);
    expect(fns.applyFilter(items, "note", "human")).toEqual([items[0]]);
    expect(fns.applyFilter(items, null, null)).toHaveLength(3);
  });

  it("sortRows sorts by name, updated, links, and provenance", () => {
    const rows = [
      { label: "beta", updated: "2026-01-01", links: 1, provenance: "agent" },
      { label: "alpha", updated: "2026-03-01", links: 5, provenance: "human" },
      { label: "gamma", updated: "2026-02-01", links: 3, provenance: "generated" },
    ];
    expect(fns.sortRows(rows, "name").map((r) => r.label)).toEqual(["alpha", "beta", "gamma"]);
    expect(fns.sortRows(rows, "updated").map((r) => r.label)).toEqual(["alpha", "gamma", "beta"]);
    expect(fns.sortRows(rows, "links").map((r) => r.label)).toEqual(["alpha", "gamma", "beta"]);
    expect(fns.sortRows(rows, "provenance").map((r) => r.label)).toEqual(["beta", "gamma", "alpha"]);
    // does not mutate the input
    expect(rows.map((r) => r.label)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("counts tallies provenance split and structural nodes", () => {
    const nodes = [
      { provenance: "human" },
      { provenance: "human" },
      { provenance: "agent" },
      { provenance: "generated" },
      { provenance: null },
    ];
    const c = fns.counts(nodes);
    expect(c).toEqual({ total: 5, human: 2, agent: 1, generated: 1, structural: 1 });
  });

  it("relTime renders relative human time", () => {
    const now = Date.parse("2026-03-01T12:00:00Z");
    expect(fns.relTime("2026-03-01T11:59:30Z", now)).toBe("just now");
    expect(fns.relTime("2026-03-01T11:30:00Z", now)).toBe("30m ago");
    expect(fns.relTime("2026-03-01T09:00:00Z", now)).toBe("3h ago");
    expect(fns.relTime("2026-02-20T12:00:00Z", now)).toBe("9d ago");
    expect(fns.relTime("2025-12-01T12:00:00Z", now)).toBe("3mo ago");
    expect(fns.relTime("2024-03-01T12:00:00Z", now)).toBe("2y ago");
    expect(fns.relTime("", now)).toBe("");
    expect(fns.relTime("not-a-date", now)).toBe("");
  });

  it("linksOf counts incident edges", () => {
    const edges = [
      { source: "a", target: "b", kind: "contains" },
      { source: "b", target: "c", kind: "links-to" },
    ];
    expect(fns.linksOf("b", edges)).toBe(2);
    expect(fns.linksOf("a", edges)).toBe(1);
    expect(fns.linksOf("z", edges)).toBe(0);
  });

  it("listTree builds an expandable index tree, nesting entry points under modules", () => {
    const model = {
      nodes: [
        { id: "repository", kind: "repository", label: "repo", provenance: null, detail: {} },
        { id: "module:src", kind: "module", label: "src", provenance: null, detail: { path: "src" } },
        { id: "entryPoint:src/index.ts", kind: "entryPoint", label: "src/index.ts", provenance: null, detail: { path: "src/index.ts" } },
        { id: "entryPoint:main.ts", kind: "entryPoint", label: "main.ts", provenance: null, detail: { path: "main.ts" } },
        { id: "vault", kind: "vault", label: "Vault", provenance: null, detail: {} },
        { id: "note:a", kind: "note", label: "A", provenance: "human", detail: {} },
      ],
      edges: [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "entryPoint:src/index.ts", kind: "contains" },
        { source: "repository", target: "entryPoint:main.ts", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    };
    const state = {
      kindFilter: "", provFilter: "", recentDays: 0, query: "", listSort: "name",
      listExpanded: { vault: 1, repository: 1, "module:src": 1 }, showInternals: true,
    };
    const rows = fns.listTree(model, state);
    const ids = rows.map((r) => r.id);
    expect(ids[0]).toBe("repository");
    expect(ids).toContain("module:src");
    expect(ids).toContain("entryPoint:main.ts");
    // src/index.ts is nested under module:src (depth 2), not a direct child of repository
    expect(rows.find((r) => r.id === "entryPoint:src/index.ts")?.depth).toBe(2);
    expect(rows.find((r) => r.id === "entryPoint:main.ts")?.depth).toBe(1);
    expect(ids.indexOf("module:src")).toBeLessThan(ids.indexOf("entryPoint:src/index.ts"));
  });

  it("listTree nests the git anchor (anchored-at) under the repository, not as a stray root", () => {
    const model = {
      nodes: [
        { id: "repository", kind: "repository", label: "repo", provenance: null, detail: {} },
        { id: "gitState", kind: "gitState", label: "main @ abc1234", provenance: null, detail: {} },
        { id: "module:src", kind: "module", label: "src", provenance: null, detail: { path: "src" } },
        { id: "vault", kind: "vault", label: "Vault", provenance: null, detail: {} },
        { id: "note:a", kind: "note", label: "A", provenance: "human", detail: {} },
      ],
      edges: [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "gitState", kind: "anchored-at" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    };
    const state = {
      kindFilter: "", provFilter: "", recentDays: 0, query: "", listSort: "name",
      listExpanded: { vault: 1, repository: 1 }, showInternals: true,
    };
    const rows = fns.listTree(model, state);
    // exactly two roots: vault and repository (order follows node input)
    const roots = rows.filter((r) => r.depth === 0).map((r) => r.id).sort();
    expect(roots).toEqual(["repository", "vault"]);
    // gitState sits under repository (depth 1), not as a third root
    expect(rows.find((r) => r.id === "gitState")?.depth).toBe(1);
    expect(rows.find((r) => r.id === "repository")?.expanded).toBe(true);
  });

  it("listLabel disambiguates external remotes and packages that collide with the repo name", () => {
    expect(fns.listLabel({ kind: "external", label: "pi-weave", detail: { url: "https://github.com/EranYonai/pi-weave.git" } }))
      .toBe("github.com/EranYonai/pi-weave");
    expect(fns.listLabel({ kind: "package", label: "pi-weave", detail: { manifest: "package.json" } }))
      .toBe("pi-weave (package.json)");
    // non-colliding kinds keep their raw label
    expect(fns.listLabel({ kind: "module", label: "src/core", detail: {} })).toBe("src/core");
    // scp-style bare URLs still resolve to a readable label
    expect(fns.listLabel({ kind: "external", label: "demo", detail: { url: "git@github.com:acme/demo.git" } }))
      .toBe("github.com:acme/demo");
  });

  it("listTree collapses unexpanded branches and prunes to matches under a filter", () => {
    const model = {
      nodes: [
        { id: "repository", kind: "repository", label: "repo", provenance: null, detail: {} },
        { id: "module:src", kind: "module", label: "src", provenance: null, detail: { path: "src" } },
        { id: "entryPoint:src/index.ts", kind: "entryPoint", label: "src/index.ts", provenance: null, detail: { path: "src/index.ts" } },
        { id: "entryPoint:main.ts", kind: "entryPoint", label: "main.ts", provenance: null, detail: { path: "main.ts" } },
        { id: "vault", kind: "vault", label: "Vault", provenance: null, detail: {} },
        { id: "note:a", kind: "note", label: "A", provenance: "human", detail: {} },
      ],
      edges: [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "entryPoint:src/index.ts", kind: "contains" },
        { source: "repository", target: "entryPoint:main.ts", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    };
    // repository collapsed → only the roots are shown
    let rows = fns.listTree(model, {
      kindFilter: "", provFilter: "", recentDays: 0, query: "", listSort: "name",
      listExpanded: {}, showInternals: true,
    });
    expect(rows.map((r) => r.id)).toEqual(["repository", "vault"]);
    expect(rows.find((r) => r.id === "repository")?.expanded).toBe(false);
    // kind filter auto-expands ancestors so the matching file stays reachable
    rows = fns.listTree(model, {
      kindFilter: "entryPoint", provFilter: "", recentDays: 0, query: "", listSort: "name",
      listExpanded: {}, showInternals: true,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("repository");
    expect(ids).toContain("module:src");
    expect(ids).toContain("entryPoint:src/index.ts");
    expect(rows.find((r) => r.id === "repository")?.expanded).toBe(true);
    expect(rows.find((r) => r.id === "module:src")?.expanded).toBe(true);
  });

  it("listTree hides repo plumbing (internals) by default and reveals them when requested", () => {
    const model = {
      nodes: [
        { id: "repository", kind: "repository", label: "repo", provenance: null, detail: {} },
        { id: "gitState", kind: "gitState", label: "main @ ab", provenance: null, detail: {} },
        { id: "external:x", kind: "external", label: "acme", provenance: null, detail: {} },
        { id: "package:y", kind: "package", label: "demo", provenance: null, detail: {} },
        { id: "entryPoint:src/index.ts", kind: "entryPoint", label: "src/index.ts", provenance: null, detail: { path: "src/index.ts" } },
        { id: "module:src", kind: "module", label: "src", provenance: null, detail: { path: "src" } },
        { id: "vault", kind: "vault", label: "Vault", provenance: null, detail: {} },
        { id: "note:a", kind: "note", label: "A", provenance: "agent", detail: {} },
      ],
      edges: [
        { source: "repository", target: "module:src", kind: "contains" },
        { source: "repository", target: "gitState", kind: "anchored-at" },
        { source: "repository", target: "external:x", kind: "contains" },
        { source: "repository", target: "package:y", kind: "contains" },
        { source: "repository", target: "entryPoint:src/index.ts", kind: "contains" },
        { source: "vault", target: "note:a", kind: "contains" },
      ],
    };
    const base = { kindFilter: "", provFilter: "", recentDays: 0, query: "", listSort: "name", listExpanded: { vault: 1, repository: 1, "module:src": 1 } };
    const hidden = fns.listTree(model, { ...base });
    const hiddenIds = hidden.map((r) => r.id);
    // plumbing is gone by default, notes/modules remain
    expect(hiddenIds).toContain("note:a");
    expect(hiddenIds).toContain("module:src");
    expect(hiddenIds).not.toContain("gitState");
    expect(hiddenIds).not.toContain("external:x");
    expect(hiddenIds).not.toContain("package:y");
    expect(hiddenIds).not.toContain("entryPoint:src/index.ts");
    // toggling showInternals reveals them again
    const shown = fns.listTree(model, { ...base, showInternals: true });
    const shownIds = shown.map((r) => r.id);
    expect(shownIds).toContain("gitState");
    expect(shownIds).toContain("external:x");
    expect(shownIds).toContain("package:y");
    expect(shownIds).toContain("entryPoint:src/index.ts");
  });

  it("listTree nests .okf file nodes under the .okf module as an expandable subtree", () => {
    const model = {
      nodes: [
        { id: "repository", kind: "repository", label: "repo", provenance: null, detail: {} },
        { id: "module:.okf", kind: "module", label: ".okf", provenance: null, detail: { path: ".okf" } },
        { id: "module:.okf/repository", kind: "module", label: "repository", provenance: null, detail: { path: ".okf/repository" } },
        { id: "module:.okf/repository/summaries", kind: "module", label: "summaries", provenance: null, detail: { path: ".okf/repository/summaries" } },
        { id: "okf:okf.json", kind: "file", label: "okf.json", provenance: null, detail: {} },
        { id: "okf:repository/git.json", kind: "file", label: "git.json", provenance: null, detail: {} },
        { id: "okf:repository/summaries/a.md", kind: "file", label: "a.md", provenance: null, detail: {} },
        { id: "vault", kind: "vault", label: "Vault", provenance: null, detail: {} },
      ],
      edges: [
        { source: "repository", target: "module:.okf", kind: "contains" },
        { source: "module:.okf", target: "module:.okf/repository", kind: "contains" },
        { source: "module:.okf/repository", target: "module:.okf/repository/summaries", kind: "contains" },
        { source: "module:.okf", target: "okf:okf.json", kind: "contains" },
        { source: "module:.okf/repository", target: "okf:repository/git.json", kind: "contains" },
        { source: "module:.okf/repository/summaries", target: "okf:repository/summaries/a.md", kind: "contains" },
      ],
    };
    const state = {
      kindFilter: "", provFilter: "", recentDays: 0, query: "", listSort: "name",
      listExpanded: { vault: 1, repository: 1, "module:.okf": 1, "module:.okf/repository": 1, "module:.okf/repository/summaries": 1 },
    };
    const rows = fns.listTree(model, state);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("module:.okf");
    // .okf file nodes are present and nested (not hidden as internals)
    expect(ids).toContain("okf:okf.json");
    expect(ids).toContain("okf:repository/git.json");
    expect(ids).toContain("okf:repository/summaries/a.md");
    expect(rows.find((r) => r.id === "module:.okf")?.hasKids).toBe(true);
    // nesting depths: okf.json under .okf, git.json under repository, summary under summaries
    expect(rows.find((r) => r.id === "okf:okf.json")?.depth).toBe(2);
    expect(rows.find((r) => r.id === "okf:repository/git.json")?.depth).toBe(3);
    expect(rows.find((r) => r.id === "okf:repository/summaries/a.md")?.depth).toBe(4);
  });
});

describe("openNoteCommand", () => {
  it("respects $EDITOR and $VISUAL, splitting args", () => {
    expect(openNoteCommand("/v/n.md", { EDITOR: "code --wait" })).toEqual({ command: "code", args: ["--wait", "/v/n.md"] });
    expect(openNoteCommand("/v/n.md", { VISUAL: "vim" })).toEqual({ command: "vim", args: ["/v/n.md"] });
    expect(openNoteCommand("/v/n.md", {})).toHaveProperty("command"); // platform fallback
  });
});

describe("openNoteInEditor", () => {
  it("refuses unsafe slugs and missing notes without shelling out", async () => {
    const vault = await makeTempDir();
    let called = false;
    const spy = () => {
      called = true;
      return { command: "true", args: [] };
    };
    expect(await openNoteInEditor(vault, "../escape", spy)).toBe(false);
    expect(await openNoteInEditor(vault, "missing", spy)).toBe(false);
    expect(called).toBe(false);
  });

  it("opens an existing note via the injected command", async () => {
    const vault = await makeTempDir();
    await addNote(vault, { title: "Open Me", body: "x", tags: [], source: "human" });
    const opened: string[] = [];
    const spy = (p: string) => {
      opened.push(p);
      return { command: "true", args: [] };
    };
    expect(await openNoteInEditor(vault, "open-me", spy)).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("open-me.md");
  });
});

describe("weave-view /open/<slug> route", () => {
  it("opens an existing note via the injected command and 404s otherwise", async () => {
    const vault = await makeTempDir();
    await addNote(vault, { title: "Open Route", body: "x", tags: [], source: "human" });
    const opened: string[] = [];
    const server = await startViewer({
      cwd: await makeTempDir(),
      vaultRoot: vault,
      openCommand: (p) => {
        opened.push(p);
        return { command: "true", args: [] };
      },
    });
    try {
      const ok = await fetch(`${server.url}/open/open-route`, { method: "POST" });
      expect(ok.status).toBe(200);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain("open-route.md");

      const missing = await fetch(`${server.url}/open/ghost`, { method: "POST" });
      expect(missing.status).toBe(404);

      const traversal = await fetch(`${server.url}/open/..%2F..%2Fetc%2Fpasswd`, { method: "POST" });
      expect(traversal.status).toBe(404);

      // GET is not allowed on /open
      const get = await fetch(`${server.url}/open/open-route`);
      expect(get.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe("page script (real browser JS, executed through node)", () => {
  function extractScript(html: string): string {
    const m = /<script>([\s\S]*)<\/script>/.exec(html);
    if (!m || m[1] === undefined) throw new Error("no script in page");
    return m[1];
  }

  it("the whole page script parses as valid JS", () => {
    const js = extractScript(renderPage());
    expect(() => new Function(js)).not.toThrow();
  });

  it("exposes the merged Explore (graph+list) and Health surfaces, status strip, and detail tabs", () => {
    const page = renderPage();
    // Graph and List are merged into one Explore surface (list is a sidebar)
    expect(page).toContain('data-surface="graph"');
    expect(page).toContain('id="list-toggle"');
    expect(page).toContain('data-surface="health"');
    expect(page).not.toContain('data-surface="list"');
    // list sidebar is open by default on the Explore surface
    expect(page).toContain('class="list-open"');
    // overview-first status strip
    expect(page).toContain('id="status"');
    expect(page).toContain('id="stamp"');
    // detail tabs (Overview merges metadata + body; no separate Body tab)
    expect(page).toContain('data-ptab="overview"');
    expect(page).toContain('data-ptab="links"');
    expect(page).toContain('data-ptab="backlinks"');
    expect(page).not.toContain('data-ptab="body"');
    // focus + open-in-editor actions
    expect(page).toContain('id="pfocus"');
    expect(page).toContain('id="popen"');
    // provenance is style-first: ring + glyph + filter, never color alone
    expect(page).toContain('PROV_GLYPH');
    expect(page).toContain('prov-filter');
    // dark + light token sets
    expect(page).toContain('data-theme="dark"');
    expect(page).toContain('data-theme="light"');
  });

  it("the List surface is an expandable index tree (chevrons + toggle)", () => {
    const page = renderPage();
    expect(page).toContain("listTree");
    expect(page).toContain("data-toggle");
    expect(page).toContain("listExpanded");
    expect(page).toContain("▸");
    expect(page).toContain("▾");
  });

  it("the embedded markdown renderer handles the supported syntax", () => {
    const js = extractScript(renderPage());
    const mdBlock = /function esc\([\s\S]*?\n  \}\n(?=\n  \/\/ ---------- visibility)/.exec(js)?.[0];
    if (!mdBlock) throw new Error("markdown block not found");
    const makeRenderer = new Function(mdBlock + "; return renderMd;") as () => (s: string) => string;
    const renderMd = makeRenderer();

    const out = renderMd("# Title\n\nHello **bold**, *ital*, `code`, [[a-note|the link]]\n\n- one\n- two\n\n> quoted\n\n```js\nvar x = 1;\n```");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>ital</em>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("class='wikilink'");
    expect(out).toContain(">the link</a>");
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("<blockquote>quoted</blockquote>");
    expect(out).toContain("<pre><code>var x = 1;");
  });

  it("the markdown renderer neutralizes script and javascript: URLs", () => {
    const js = extractScript(renderPage());
    const mdBlock = /function esc\([\s\S]*?\n  \}\n(?=\n  \/\/ ---------- visibility)/.exec(js)?.[0];
    if (!mdBlock) throw new Error("markdown block not found");
    const makeRenderer = new Function(mdBlock + "; return renderMd;") as () => (s: string) => string;
    const renderMd = makeRenderer();

    const out = renderMd("<script>alert(1)</script>\n\n[click](javascript:alert(1)) [ok](https://ok.dev)");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="https://ok.dev"');
  });
});

describe("physics (real tick loop, extracted from the page)", () => {
  it("a fully-expanded 60-node graph settles inside the viewport without NaN or blow-up", () => {
    const js = (/<script>([\s\S]*)<\/script>/.exec(renderPage()) ?? [])[1];
    if (!js) throw new Error("no script");
    const tickSrc = (/function tick\(\) \{[\s\S]*?\n  \}\n(?=\n  var edgeLines)/.exec(js) ?? [])[0];
    if (!tickSrc) throw new Error("tick() not found in page script");

    const W = 1440, H = 900;
    const model = { edges: [] as { source: string; target: string; kind: string }[] };
    const sim: Record<string, { x: number; y: number; vx: number; vy: number; visible: boolean; fixed: boolean }> = {};
    for (let i = 0; i < 60; i++) {
      const id = `n${i}`;
      sim[id] = { x: W / 2 + Math.cos(i * 2.4) * (24 + i), y: H / 2 + Math.sin(i * 2.4) * (24 + i), vx: 0, vy: 0, visible: true, fixed: false };
      model.edges.push({ source: "n0", target: id, kind: "contains" }); // star — worst case for repulsion
      if (i > 2) model.edges.push({ source: `n${i - 2}`, target: id, kind: "links-to" });
    }
    const run = new Function(
      "sim", "model", "W", "H",
      `var REST = { contains: 105, "anchored-at": 130, "links-to": 160, mentions: 160 };
       var alpha = 0.6; ${tickSrc}
       for (var i = 0; i < 1100; i++) tick();
       return { alpha: alpha, sim: sim };`,
    ) as (s: typeof sim, m: typeof model, w: number, h: number) => { alpha: number; sim: typeof sim };

    const { alpha, sim: out } = run(sim, model, W, H);
    expect(alpha).toBeLessThan(0.008); // settles at/below the relaxation pin floor: loop would stop
    const xs = Object.values(out).map((n) => n.x);
    const ys = Object.values(out).map((n) => n.y);
    for (const v of [...xs, ...ys]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(W);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(H);
    // settled: nodes spread apart (not piled on one point) but stay in view
    const spreadX = Math.max(...xs) - Math.min(...xs);
    expect(spreadX).toBeGreaterThan(80);
    expect(spreadX).toBeLessThan(W * 0.98);
    // and no two nodes sit on top of each other
    let closest = Infinity;
    const pts = Object.values(out);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]!, b = pts[j]!;
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(closest).toBeGreaterThan(10);
  });
});
