import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphModel } from "../../src/core/graph/model";
import { startViewer, buildCurrentGraph } from "../../src/pi/viewer/server";
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
    expect(out).toContain('class="wikilink">the link<');
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
