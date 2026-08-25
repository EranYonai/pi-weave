/**
 * The P5 exit criterion, end to end (weave-workspace §11 P5).
 *
 * > *Exit: a note authored in the browser and a note authored in Obsidian are
 * > byte-compatible.*
 *
 * ## Why this file exists when three others already test pieces of it
 *
 * `tests/core/frontmatterRoundTrip.test.ts` proves `parse ∘ serialize` is a
 * fixed point. `tests/web/routes.test.ts` proves the HTTP write route
 * preserves an Obsidian-shaped block. `tests/web/client-editor.test.ts`
 * proves the editor's state machine. Each is necessary and none of them is
 * the exit criterion, because the criterion is about a **path**, and a path
 * assembled from three individually-correct pieces is exactly the shape of
 * the bug §2.1 records: two hops that are each legal, composing into one
 * that is not.
 *
 * So this drives the criterion through the code the browser actually runs —
 * `editor.model.ts` deciding, `editor.controller.ts` fetching, `api.ts`
 * encoding, over a real socket into a real vault — and asserts the bytes on
 * disk afterwards. The only thing standing in for the browser is `fetch`
 * itself, which the client takes as an injected port precisely so that this
 * is possible without a DOM (§10).
 *
 * ## What "byte-compatible" is taken to mean
 *
 * Every line of the front-matter block that the engine does not own comes
 * back **identical**, in its **original position**, with no line added and
 * none removed. The one permitted difference is `updated:`, which the save
 * explicitly asked to move. That is stated as an array equality rather than
 * a set of `toContain` checks, because a block that had been silently sorted
 * would pass the latter and is still a diff in the user's git history that
 * they did not make.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike, HttpRequest, HttpResponse } from "../../src/web/client/api";
import { createEditor, type EditorHandle } from "../../src/web/client/note/editor.controller";
import { fetchNote } from "../../src/web/client/api";
import type { EditorState } from "../../src/web/client/note/editor.model";
import { DEFAULT_COOKIE_NAME } from "../../src/web/server/security";
import { startWorkspaceServer, type WorkspaceServer } from "../../src/web/server/server";
import { makeTempDir } from "../helpers";

const TOKEN = "test-token-" + "x".repeat(32);

const running: WorkspaceServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

/**
 * The Obsidian-shaped note.
 *
 * Every line is one the engine's subset cannot represent, and each is a
 * different way a naive serializer destroys data:
 *
 *  - `aliases:` — an unknown key whose value contains the punctuation a
 *    line-oriented parser is most likely to choke on;
 *  - `cssclass:` — a plain unknown scalar;
 *  - the `tags:` **block list** — an *owned* key in a syntax the serializer
 *    cannot write. This is the dangerous one: a rewrite to `tags: []` would
 *    orphan the two indented children underneath it, and appending a second
 *    `tags:` further down would leave the user with a duplicated property;
 *  - a comment and a blank line — content belonging to no key at all;
 *  - `nested:` with an indented child — a map the parser has no concept of.
 */
const OBSIDIAN_FRONT_MATTER: readonly string[] = [
  "title: Auth Boundary",
  "aliases: [Auth Boundary, ADR-7]",
  "cssclass: wide-table",
  "tags:",
  "  - architecture",
  "  - security",
  "# a YAML comment the parser has no concept of",
  "",
  "nested:",
  "  key: value",
  "publish: true",
  "created: 2026-01-02T03:04:05.000Z",
  "source: human",
];

const ORIGINAL_BODY = "The body as Obsidian left it.\n\nWith a second paragraph.";

interface Fixture {
  server: WorkspaceServer;
  vaultRoot: string;
  /** `fetch`, with the cookie and Origin a browser would attach (§5.1). */
  fetch: FetchLike;
}

/**
 * A vault holding one Obsidian-authored note, and a client-shaped `fetch`
 * pointed at a server over it.
 *
 * The note is written as **bytes**, not through `addNote`: `addNote` can only
 * produce the canonical five-key block, and the whole question here is what
 * happens to a block it could not have written.
 */
async function fixture(): Promise<Fixture> {
  const vaultRoot = await makeTempDir();
  await fs.mkdir(join(vaultRoot, "notes"), { recursive: true });
  await fs.writeFile(
    join(vaultRoot, "notes", "auth-boundary.md"),
    ["---", ...OBSIDIAN_FRONT_MATTER, "---", "", ORIGINAL_BODY, ""].join("\n"),
    "utf8",
  );

  const server = await startWorkspaceServer({ cwd: await makeTempDir(), vaultRoot, token: TOKEN });
  running.push(server);

  // The browser's `fetch`, minus the browser. `credentials: "same-origin"`
  // and the cookie jar are what `api.dom.ts` and the browser supply between
  // them; Node's `fetch` manages no jar, so the two headers are attached
  // here. Everything else — the method, the content type, the body — comes
  // from `api.ts`, which is the point.
  const impl: FetchLike = (url: string, init?: HttpRequest) =>
    fetch(server.url + url, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      headers: { ...init?.headers, cookie: `${DEFAULT_COOKIE_NAME}=${TOKEN}`, origin: server.url },
      ...(init?.body === undefined ? {} : { body: init.body }),
    }) as unknown as Promise<HttpResponse>;

  return { server, vaultRoot, fetch: impl };
}

/** The note file, verbatim. */
function readNote(vaultRoot: string, slug = "auth-boundary"): Promise<string> {
  return fs.readFile(join(vaultRoot, "notes", `${slug}.md`), "utf8");
}

/** The front-matter block of a note file, fences excluded. */
function frontMatterOf(text: string): string[] {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match?.[1] === undefined) throw new Error("no front matter block");
  return match[1].split("\n");
}

/** The block minus the one line the engine owns and was asked to move. */
function preserved(lines: readonly string[]): string[] {
  return lines.filter((line) => !line.startsWith("updated:"));
}

/** A real editor over a real server, plus a way to await its round trips. */
function editorOver(f: Fixture): { editor: EditorHandle; settle(): Promise<void>; state(): EditorState } {
  const editor = createEditor({
    fetch: f.fetch,
    // Nothing to navigate to: this suite is about one note's bytes.
    select: () => {},
    onChange: () => {},
  });
  // Captured before the return so `settle` and `state` share one binding.
  const state = () => editor.state();
  return {
    editor,
    // The controller's save is fire-and-forget by design (`api.ts` returns
    // failures as values, so there is nothing to await). The save goes over
    // a real socket into a real vault — HTTP round trip plus a disk write —
    // so a fixed macrotask timeout is a race against CI load. Poll instead:
    // the reducer moves status synchronously to "saving", and a save only
    // leaves it once `api.ts` has resolved ("saved"/"error"/conflict).
    settle: () =>
      new Promise<void>((resolve) => {
        const deadline = Date.now() + 5000;
        const tick = () => {
          if (state().status !== "saving" || Date.now() >= deadline) resolve();
          else setTimeout(tick, 5);
        };
        setTimeout(tick, 5);
      }),
    state,
  };
}

/** Load the note into the editor exactly as `workspace.ts` does. */
async function load(f: Fixture, editor: EditorHandle): Promise<void> {
  const result = await fetchNote(f.fetch, "auth-boundary");
  if (!result.ok) throw new Error(`fixture: load failed (${result.kind})`);
  editor.send({ type: "loaded", payload: result.data });
}

describe("P5 exit: the browser save path is byte-compatible with Obsidian (§11)", () => {
  it("preserves every line the engine does not own, in order, across a real save", async () => {
    const f = await fixture();
    const { editor, settle, state } = editorOver(f);
    const before = frontMatterOf(await readNote(f.vaultRoot));

    await load(f, editor);
    // What the user does: ⌘E, type, ⌘S.
    editor.send({ type: "toggle" });
    editor.send({ type: "draft", text: "Rewritten in a browser textarea." });
    editor.send({ type: "save" });
    await settle();

    expect(state().status).toBe("saved");

    const after = await readNote(f.vaultRoot);
    // The claim, as an equality: a block that had been silently sorted or had
    // gained a line would pass a `toContain` sweep and is still a diff the
    // user did not make.
    expect(preserved(frontMatterOf(after))).toEqual(preserved(before));
    // And the intended change did happen.
    expect(after).toContain("Rewritten in a browser textarea.");
    expect(after).not.toContain("The body as Obsidian left it.");
  });

  it("does not rewrite the tags block list, nor duplicate it", async () => {
    // The single most destructive case: `tags` is an *owned* key written in a
    // syntax the serializer cannot produce. Rewriting the parent as
    // `tags: []` orphans the children; appending a second `tags:` leaves the
    // user with two properties of the same name.
    const f = await fixture();
    const { editor, settle } = editorOver(f);
    await load(f, editor);
    editor.send({ type: "toggle" });
    editor.send({ type: "draft", text: "changed" });
    editor.send({ type: "save" });
    await settle();

    const lines = frontMatterOf(await readNote(f.vaultRoot));
    expect(lines.filter((l) => l.startsWith("tags"))).toEqual(["tags:"]);
    expect(lines).toContain("  - architecture");
    expect(lines).toContain("  - security");
    // Adjacency, not just presence: children that survived but were hoisted
    // away from their parent would still be corrupt YAML.
    const head = lines.indexOf("tags:");
    expect(lines.slice(head, head + 3)).toEqual(["tags:", "  - architecture", "  - security"]);
  });

  it("is a fixed point: repeated browser saves change nothing but the body", async () => {
    const f = await fixture();
    const { editor, settle, state } = editorOver(f);
    await load(f, editor);
    editor.send({ type: "toggle" });

    for (let i = 0; i < 3; i += 1) {
      editor.send({ type: "draft", text: `Revision ${i}.` });
      editor.send({ type: "save" });
      await settle();
      // Each save must succeed against the revision the previous one
      // returned. A `409` here would mean the editor conflicts with its own
      // writes, which is the failure that makes an editor unusable long
      // before anyone notices a front-matter key is missing.
      expect(state().status, `save ${i}`).toBe("saved");
      expect(state().conflict).toBeNull();
    }

    const lines = frontMatterOf(await readNote(f.vaultRoot));
    expect(preserved(lines)).toEqual(preserved(OBSIDIAN_FRONT_MATTER));
    expect(await readNote(f.vaultRoot)).toContain("Revision 2.");
  });

  it("preserves the block when the user overwrites a conflict", async () => {
    // The overwrite path drops `expectedRevision`, which is a *different*
    // request shape reaching a different branch of `updateNote`. Preservation
    // must not be a property of the happy path alone.
    const f = await fixture();
    const { editor, settle, state } = editorOver(f);
    await load(f, editor);
    editor.send({ type: "toggle" });
    editor.send({ type: "draft", text: "mine" });

    // Somebody else writes, through the same route, while the editor holds a
    // now-historical revision.
    await f.fetch("/api/note/auth-boundary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "theirs" }),
    });

    editor.send({ type: "save" });
    await settle();
    expect(state().conflict?.reason).toBe("conflict");
    // The draft is intact — the user's paragraph survived the refusal.
    expect(state().draft).toBe("mine");

    editor.send({ type: "overwrite" });
    await settle();
    expect(state().status).toBe("saved");

    const after = await readNote(f.vaultRoot);
    expect(after).toContain("mine");
    expect(preserved(frontMatterOf(after))).toEqual(preserved(OBSIDIAN_FRONT_MATTER));
  });

  it("preserves the block when the user reloads a conflict instead", async () => {
    const f = await fixture();
    const { editor, settle, state } = editorOver(f);
    await load(f, editor);
    editor.send({ type: "toggle" });
    editor.send({ type: "draft", text: "mine" });

    await f.fetch("/api/note/auth-boundary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "theirs" }),
    });

    editor.send({ type: "save" });
    await settle();
    editor.send({ type: "reload" });

    // Reload is local — it adopts the note the `409` already delivered — so
    // the disk is whatever the other writer left, front matter and all.
    expect(state().draft).toBe("theirs");
    expect(preserved(frontMatterOf(await readNote(f.vaultRoot)))).toEqual(preserved(OBSIDIAN_FRONT_MATTER));
  });

  it("round-trips the body itself, not just the metadata", async () => {
    // The front matter is the famous half of the bug, but a body mangled on
    // the way through would be the same class of failure. Markdown that
    // *looks* like front matter, and trailing whitespace, are the two shapes
    // most likely to be eaten.
    const f = await fixture();
    const { editor, settle } = editorOver(f);
    await load(f, editor);
    editor.send({ type: "toggle" });
    const lines = ["# Heading", "", "---", "", "A horizontal rule above, and a `---` that is not front matter.", "", "- a", "- b"];
    const body = lines.join("\n");
    editor.send({ type: "draft", text: body });
    editor.send({ type: "save" });
    await settle();

    const reloaded = await fetchNote(f.fetch, "auth-boundary");
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.data.note.body).toBe(body);
  });

  it("never sends the raw front-matter block back to the server", async () => {
    // Preservation is a property of core re-reading the file it is about to
    // overwrite. If the block ever travelled to the browser and back, it
    // would instead be a property of the browser having returned it
    // unedited — which is a hope, not a guarantee. Asserted on the wire.
    const bodies: string[] = [];
    const f = await fixture();
    const spy: FetchLike = (url, init) => {
      if (init?.body !== undefined) bodies.push(init.body);
      return f.fetch(url, init);
    };
    const editor = createEditor({ fetch: spy, select: () => {}, onChange: () => {} });

    const loaded = await fetchNote(spy, "auth-boundary");
    if (!loaded.ok) throw new Error("fixture: load failed");
    // Not on the way in, either.
    expect(JSON.stringify(loaded.data)).not.toContain("aliases");
    editor.send({ type: "loaded", payload: loaded.data });
    editor.send({ type: "toggle" });
    editor.send({ type: "draft", text: "changed" });
    editor.send({ type: "save" });
    await new Promise<void>((resolve) => void setTimeout(resolve, 20));

    expect(bodies).toHaveLength(1);
    for (const key of ["aliases", "cssclass", "publish", "nested", "frontMatter"]) {
      expect(bodies[0], key).not.toContain(key);
    }
    // What it *does* send: the body and the revision, and nothing else.
    expect(Object.keys(JSON.parse(bodies[0] ?? "{}")).sort()).toEqual(["body", "expectedRevision"]);
  });
});
