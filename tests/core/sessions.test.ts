/**

 * L2 — session scan core (docs/session-scan.md): discovery, JSONL parsing,

 * digest rendering, and the incremental hash-while-reading scan into vault

 * notes. All roots are injected fixture directories; the summarizer is a

 * fake — no network, no pi.

 */

import { promises as fs } from "node:fs";

import { homedir } from "node:os";

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {

  DEFAULT_SESSIONS_ROOT,

  SESSIONS_ENV_VAR,

  deriveSessionTitle,

  listSessionFiles,

  migrateLegacySessionNotes,

  parseSessionDigest,

  peekSessionHeader,

  projectTagOf,

  readSessionNoteIndex,

  renderSessionDigest,

  resolveSessionsRoot,

  runSessionScan,

  sessionHasContent,

  sessionNoteBody,

  sessionNoteFields,

  sessionNoteTags,

  writeSessionNote,

  type SessionChain,

  type SessionDigest,

  type SessionScanOptions,

} from "../../src/core";

import { getNote } from "../../src/core/vault";

import { makeTempDir, writeFixture } from "../helpers";

/** Read a session note by its nested slug (`sessions/<name>`). */

function getNoteAt(vault: string, name: string) {

  return getNote(vault, `sessions/${name}`);

}

/** Build a session JSONL body from typed entry objects. */

function jsonl(lines: unknown[]): string {

  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

}

function header(id: string, cwd = "/tmp/proj", ts = "2026-08-22T06:33:12.008Z"): Record<string, unknown> {

  return { type: "session", version: 3, id, timestamp: ts, cwd };

}

/** A minimal digest for rendering tests. */

function digest(overrides: Partial<SessionDigest> = {}): SessionDigest {

  return {

    id: "01a0282c-6048",

    cwd: "/Users/x/pi-weave",

    parentSession: null,

    startedAt: "2026-08-22T06:33:12.008Z",

    endedAt: "2026-08-22T06:40:00.000Z",

    name: null,

    models: [],

    userCount: 0,

    assistantCount: 0,

    toolResultCount: 0,

    errors: 0,

    bashCount: 0,

    tools: {},

    firstUserMessage: null,

    userMessages: [],

    compactions: [],

    branchSummaries: [],

    lastAssistantText: null,

    ...overrides,

  };

}

interface ScanDeps {

  sessions: string;

  vault: string;

  calls: { path: string; content: string }[];

}

async function scan(deps: ScanDeps, overrides: Partial<SessionScanOptions> = {}) {

  let counter = 0;

  return runSessionScan({

    sessionsRoot: deps.sessions,

    vaultRoot: deps.vault,

    summarize: async ({ path, content }) => {

      deps.calls?.push({ path, content });

      return `Summary #${++counter}`;

    },

    ...overrides,

  });

}

describe("resolveSessionsRoot", () => {

  it("defaults to ~/.pi/agent/sessions", () => {

    expect(resolveSessionsRoot({})).toBe(join(homedir(), ".pi", "agent", "sessions"));

    expect(DEFAULT_SESSIONS_ROOT).toBe(join(homedir(), ".pi", "agent", "sessions"));

  });

  it("honors the PI_WEAVE_SESSIONS override and ignores blanks", () => {

    expect(resolveSessionsRoot({ PI_WEAVE_SESSIONS: "/tmp/sx" })).toBe("/tmp/sx");

    expect(resolveSessionsRoot({ PI_WEAVE_SESSIONS: "   " })).toBe(DEFAULT_SESSIONS_ROOT);

  });

});

describe("listSessionFiles", () => {

  it("finds .jsonl across project dirs, ignores everything else, sorts newest first", async () => {

    const root = await makeTempDir();

    try {

      await writeFixture(root, "--a--/old_1.jsonl", "{}\n");

      await writeFixture(root, "--b--/new_2.jsonl", "{}\n");

      await writeFixture(root, "--b--/notes.txt", "nope");

      await writeFixture(root, "loose.jsonl", "{}\n"); // not inside a project dir: ignored

      await fs.utimes(join(root, "--a--", "old_1.jsonl"), new Date(1000), new Date(1000));

      await fs.utimes(join(root, "--b--", "new_2.jsonl"), new Date(3000), new Date(3000));

      // One level deep is the pi layout (sessions/<encoded-cwd>/<file>.jsonl).

      const files = await listSessionFiles(root);

      expect(files.map((f) => f.name)).toEqual(["new_2.jsonl", "old_1.jsonl"]);

      expect(files[0]?.bytes).toBe(3);

      const limited = await listSessionFiles(root, { limit: 1 });

      expect(limited.map((f) => f.name)).toEqual(["new_2.jsonl"]);

    } finally {

      await fs.rm(root, { recursive: true, force: true });

    }

  });

  it("returns empty for a missing root", async () => {

    expect(await listSessionFiles(join(await makeTempDir(), "absent"))).toEqual([]);

  });

});

describe("parseSessionDigest", () => {

  it("extracts header, name, models, counts, tools, and texts", () => {

    const d = parseSessionDigest(

      jsonl([

        header("aaaa-bbbb", "/tmp/my-app"),

        { type: "model_change", id: "x", parentId: null, timestamp: "t", provider: "ollama", modelId: "k3" },

        { type: "session_info", id: "y", parentId: "x", timestamp: "t", name: "Fix the deadlock" },

        { type: "message", id: "m1", parentId: "x", timestamp: "2026-08-22T06:35:00Z", message: { role: "user", content: "hey\nfix the deadlock please" } },

        {

          type: "message",

          id: "m2",

          parentId: "m1",

          timestamp: "2026-08-22T06:36:00Z",

          message: {

            role: "assistant",

            content: [

              { type: "thinking", thinking: "hmm" },

              { type: "text", text: "On it." },

              { type: "toolCall", id: "c1", name: "edit", arguments: {} },

            ],

            provider: "ollama",

            model: "k3",

            stopReason: "toolUse",

          },

        },

        { type: "message", id: "m3", parentId: "m2", timestamp: "2026-08-22T06:37:00Z", message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [], isError: true } },

        { type: "message", id: "m4", parentId: "m3", timestamp: "2026-08-22T06:38:00Z", message: { role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false } },

        { type: "message", id: "m5", parentId: "m4", timestamp: "2026-08-22T06:39:00Z", message: { role: "user", content: [{ type: "text", text: "thanks" }, { type: "image", data: "xx", mimeType: "image/png" }] } },

        { type: "compaction", id: "cp1", parentId: "m5", timestamp: "2026-08-22T06:39:30Z", summary: "Goal: fix deadlock." },

        { type: "branch_summary", id: "br1", parentId: "cp1", timestamp: "2026-08-22T06:39:40Z", summary: "Left branch tried approach A." },

        { type: "label", id: "lb1", parentId: "br1", timestamp: "2026-08-22T06:39:50Z", targetId: "m1", label: "checkpoint" },

        { type: "custom", id: "cu1", parentId: "lb1", timestamp: "2026-08-22T06:39:55Z", customType: "x", data: {} },

        { type: "message", id: "m6", parentId: "cu1", timestamp: "2026-08-22T06:40:00Z", message: { role: "weird-role", content: "?" } },

      ]),

    );

    expect(d).not.toBeNull();

    expect(d!.id).toBe("aaaa-bbbb");

    expect(d!.cwd).toBe("/tmp/my-app");

    expect(d!.parentSession).toBeNull();

    expect(d!.startedAt).toBe("2026-08-22T06:33:12.008Z");

    expect(d!.endedAt).toBe("2026-08-22T06:40:00Z");

    expect(d!.name).toBe("Fix the deadlock");

    expect(d!.models).toEqual(["ollama/k3"]);

    expect(d!.userCount).toBe(2);

    expect(d!.assistantCount).toBe(1);

    expect(d!.toolResultCount).toBe(1);

    expect(d!.errors).toBe(1);

    expect(d!.bashCount).toBe(1);

    expect(d!.tools).toEqual({ edit: 1 });

    expect(d!.firstUserMessage).toBe("hey\nfix the deadlock please");

    expect(d!.userMessages).toEqual(["hey\nfix the deadlock please", "thanks"]);

    expect(d!.compactions).toEqual(["Goal: fix deadlock."]);

    expect(d!.branchSummaries).toEqual(["Left branch tried approach A."]);

    expect(d!.lastAssistantText).toBe("On it.");

  });

  it("tolerates malformed lines, header-less files, and id-less headers", () => {

    expect(parseSessionDigest("not json\n{\"type\":\"session\",\"id\":\"x\"}")).not.toBeNull();

    expect(parseSessionDigest("{\"type\":\"message\",\"id\":\"m\"}\n")).toBeNull();

    expect(parseSessionDigest("{\"type\":\"session\",\"cwd\":\"/x\"}\n")).toBeNull();

    expect(parseSessionDigest("")).toBeNull();

    // duplicate headers: first wins; later one ignored

    const d = parseSessionDigest(

      jsonl([header("first"), { type: "session", version: 3, id: "second", timestamp: "t", cwd: "/y" }]),

    );

    expect(d?.id).toBe("first");

  });

  it("records parentSession for forked sessions and dedupes models", () => {

    const d = parseSessionDigest(

      jsonl([

        { ...header("kid"), parentSession: "/sessions/parent.jsonl" },

        { type: "model_change", id: "a", parentId: null, timestamp: "t", provider: "p", modelId: "m1" },

        { type: "message", id: "m1", parentId: "a", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "p", model: "m1", stopReason: "stop" } },

        { type: "message", id: "m2", parentId: "m1", timestamp: "t3", message: { role: "assistant", content: [], provider: "q", model: "m2", stopReason: "error" } },

      ]),

    );

    expect(d?.parentSession).toBe("/sessions/parent.jsonl");

    expect(d?.models).toEqual(["p/m1", "q/m2"]);

    expect(d?.errors).toBe(1);

  });

});

describe("peekSessionHeader", () => {

  it("reads identity, project, and start time from the header line only", () => {

    expect(peekSessionHeader(jsonl([header("abc", "/tmp/p", "2026-01-01T00:00:00Z")]) + "{}\n")).toEqual({

      id: "abc",

      cwd: "/tmp/p",

      startedAt: "2026-01-01T00:00:00Z",

    });

    expect(peekSessionHeader("{}\n")).toBeNull();

    expect(peekSessionHeader("not json\n")).toBeNull();

    expect(peekSessionHeader("\n\n")).toBeNull();

  });

});

describe("sessionHasContent", () => {

  it("requires user activity, shell use, or pre-written summaries", () => {

    expect(sessionHasContent(digest())).toBe(false);

    expect(sessionHasContent(digest({ userCount: 1 }))).toBe(true);

    expect(sessionHasContent(digest({ bashCount: 1 }))).toBe(true);

    expect(sessionHasContent(digest({ compactions: ["x"] }))).toBe(true);

    expect(sessionHasContent(digest({ branchSummaries: ["x"] }))).toBe(true);

  });

});

describe("renderSessionDigest", () => {

  it("renders all sections and stays deterministic", () => {

    const d = digest({

      name: "Named session",

      models: ["p/m1"],

      userCount: 2,

      assistantCount: 3,

      toolResultCount: 4,

      errors: 1,

      tools: { read: 3, bash: 5 },

      userMessages: ["first\nmultiline ask", "second"],

      compactions: ["Compacted goal."],

      branchSummaries: ["Branch note."],

      lastAssistantText: "All done.",

    });

    const text = renderSessionDigest(d);

    expect(text).toContain("Session 01a0282c-6048 (2026-08-22T06:33:12.008Z → 2026-08-22T06:40:00.000Z)");

    expect(text).toContain("Project: /Users/x/pi-weave");

    expect(text).toContain("Name: Named session");

    expect(text).toContain("Models: p/m1");

    expect(text).toContain("Messages: 2 user, 3 assistant, 4 tool results, 1 errors");

    expect(text).toContain("Tools: bash ×5, read ×3");

    expect(text).toContain("1. first multiline ask");

    expect(text).toContain("[1] Compacted goal.");

    expect(text).toContain("[1] Branch note.");

    expect(text).toContain("## Last assistant message\nAll done.");

  });

  it("omits empty sections and falls back when timestamps are absent", () => {

    const text = renderSessionDigest(digest({ startedAt: "", endedAt: "", cwd: "" }));

    expect(text).toContain("Session 01a0282c-6048 (unknown time)");

    expect(text).not.toContain("Project:");

    expect(text).not.toContain("Tools:");

    expect(text).not.toContain("## User messages");

    expect(text).not.toContain("## Compaction summaries");

    expect(text).not.toContain("## Branch summaries");

    expect(text).not.toContain("## Last assistant message");

  });

  it("keeps identical start/end as a single timestamp and respects maxChars", () => {

    const d = digest({ endedAt: d0().startedAt });

    expect(renderSessionDigest(d)).toContain(`(${d.startedAt})`);

    const capped = renderSessionDigest(digest({ userMessages: ["x".repeat(50)] }), { maxChars: 40 });

    expect(capped.length).toBe(40);

    expect(capped.endsWith("…")).toBe(true);

  });

  function d0(): SessionDigest {

    return digest();

  }

});

describe("deriveSessionTitle", () => {

  it("prefers the session name, then the first user message, then the id — unprefixed", () => {

    expect(deriveSessionTitle(digest({ name: "Refactor auth" }))).toBe("Refactor auth");

    expect(deriveSessionTitle(digest({ firstUserMessage: "hey\nread the design" }))).toBe(

      "hey read the design",

    );

    expect(deriveSessionTitle(digest({ id: "abcdef1234567890" }))).toBe("session abcdef12");

    expect(deriveSessionTitle(digest({ id: "" }))).toBe("session unknown");

  });

  it("clips long titles to 80 characters with an ellipsis", () => {

    const title = deriveSessionTitle(digest({ name: "x".repeat(120) }));

    expect(title.length).toBeLessThanOrEqual(80);

    expect(title.endsWith("…")).toBe(true);

  });

});

describe("session note derivation", () => {

  it("tags with the project directory name, slugified", () => {

    expect(sessionNoteTags(digest({ cwd: "/Users/x/My App!" }))).toEqual(["pi-session", "my-app"]);

    expect(sessionNoteTags(digest({ cwd: "" }))).toEqual(["pi-session"]);

    expect(projectTagOf("")).toBe("");

  });

  it("renders chain links when neighbours are known", () => {

    const chain: SessionChain = { previous: "earlier-session", next: "later-session" };

    const body = sessionNoteBody({

      digest: digest(),

      file: { path: "/s.jsonl" },

      hash: "h",

      summary: "s",

      model: null,

      at: "t",

      chain,

    });

    expect(body).toContain("- Previous session: [[earlier-session]]");

    expect(body).toContain("- Next session: [[later-session]]");

    const noChain = sessionNoteBody({

      digest: digest(),

      file: { path: "/s.jsonl" },

      hash: "h",

      summary: "s",

      model: null,

      at: "t",

    });

    expect(noChain).not.toContain("Previous session");

    expect(noChain).not.toContain("Next session");

  });

  it("carries identity fields for the incremental-skip marker", () => {

    const rec = {

      digest: digest(),

      file: { path: "/sessions/a.jsonl" },

      hash: "cafe",

      summary: "s",

      model: "p/m",

      at: "2026-08-23T09:00:00.000Z",

    };

    expect(sessionNoteFields(rec)).toEqual({

      session_id: "01a0282c-6048",

      session_hash: "cafe",

      session_cwd: "/Users/x/pi-weave",

      session_file: "/sessions/a.jsonl",

      session_start: "2026-08-22T06:33:12.008Z",

    });

    // a session without a start timestamp simply omits the field

    expect(Object.keys(sessionNoteFields({ ...rec, digest: digest({ startedAt: "" }) }))).not.toContain(

      "session_start",

    );

  });

  it("renders the Details block with counts, tools, and provenance", () => {

    const rec = {

      digest: digest({ userCount: 2, assistantCount: 3, toolResultCount: 4, errors: 2, bashCount: 1, tools: { read: 3 }, models: ["p/m"] }),

      file: { path: "/sessions/a.jsonl" },

      hash: "cafe",

      summary: "Did the thing.",

      model: "p/m",

      at: "2026-08-23T09:00:00.000Z",

    };

    const body = sessionNoteBody(rec);

    expect(body.startsWith("Did the thing.\n\n## Details")).toBe(true);

    expect(body).toContain("- Messages: 2 user · 3 assistant · 4 tool results (2 errors)");

    expect(body).toContain("- Tools: read ×3");

    expect(body).toContain("- Shell commands (direct): 1");

    expect(body).toContain("- Models: p/m");

    expect(body).toContain("- Transcript: `/sessions/a.jsonl`");

    expect(body).toContain("- Summarized: 2026-08-23T09:00:00.000Z by p/m");

  });

  it("omits optional Details lines when there is nothing to report", () => {

    const body = sessionNoteBody({

      digest: digest({ startedAt: "", endedAt: "", cwd: "" }),

      file: { path: "/s.jsonl" },

      hash: "h",

      summary: "s",

      model: null,

      at: "t",

    });

    expect(body).toContain("- Started: unknown");

    expect(body).toContain("- Project: `unknown`");

    expect(body).not.toContain("- Tools:");

    expect(body).not.toContain("- Shell commands");

    expect(body).not.toContain("- Models:");

    expect(body).toContain("- Summarized: t");

  });

});

describe("readSessionNoteIndex", () => {

  it("indexes session notes by id, skipping unrelated and malformed notes", async () => {

    const vault = await makeTempDir();

    try {

      await fs.mkdir(join(vault, "notes", "sessions"), { recursive: true });

      await fs.writeFile(

        join(vault, "notes", "sessions", "one.md"),

        "---\ntitle: One\nsource: generated\nsession_id: aaa\nsession_hash: h1\nsession_cwd: /tmp/p\nsession_start: 2026-08-22T06:33:12.008Z\n---\n\nbody\n",

        "utf8",

      );

      await fs.writeFile(join(vault, "notes", "sessions", "two.md"), "---\ntitle: Two\n---\n\nno marker\n", "utf8");

      await fs.writeFile(join(vault, "notes", "sessions", "broken.md"), "not front matter at all", "utf8");

      await fs.writeFile(join(vault, "notes", "sessions", "ignore.txt"), "skip", "utf8");

      await fs.writeFile(

        join(vault, "notes", "sessions", "zz-dup.md"),

        "---\ntitle: Dup\nsession_id: aaa\nsession_hash: nope\n---\n\nx\n",

        "utf8",

      );

      const index = await readSessionNoteIndex(vault);

      expect(index.get("aaa")).toEqual({

        slug: "sessions/one",

        hash: "h1",

        cwd: "/tmp/p",

        startedAt: "2026-08-22T06:33:12.008Z",

      });

      expect(index.size).toBe(1); // duplicate id: first (sorted) wins

      expect(await readSessionNoteIndex(join(vault, "absent"))).toEqual(new Map());

    } finally {

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

});

describe("runSessionScan", () => {

  async function makeScenario() {

    const sessions = await makeTempDir();

    const vault = await makeTempDir();

    const deps: ScanDeps = { sessions, vault, calls: [] };

    return { sessions, vault, deps };

  }

  const SESSION_A = jsonl([

    header("aaaa-bbbb-cccc", "/tmp/proj"),

    { type: "message", id: "m1", parentId: null, timestamp: "2026-08-22T06:35:00Z", message: { role: "user", content: "build the memory feature" } },

    { type: "message", id: "m2", parentId: "m1", timestamp: "2026-08-22T06:36:00Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }], provider: "p", model: "m", stopReason: "stop" } },

  ]);

  async function putSession(sessions: string, name: string, content: string, mtimeMs?: number) {

    await writeFixture(sessions, `--proj--/${name}`, content);

    if (mtimeMs !== undefined) {

      await fs.utimes(join(sessions, "--proj--", name), new Date(mtimeMs), new Date(mtimeMs));

    }

  }

  it("writes one generated note per session with hash front matter and tags", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "a.jsonl", SESSION_A);

      const result = await scan(deps, { model: "testprovider/test-model", now: () => new Date("2026-08-23T09:00:00Z") });

      expect(result).toMatchObject({ discovered: 1, considered: 1, written: 1, created: 1, updated: 0, skippedFresh: 0 });

      expect(deps.calls).toHaveLength(1);

      expect(deps.calls[0]!.content).toContain("Session aaaa-bbbb-cccc");

      expect(deps.calls[0]!.content).toContain("## User messages");

      const note = await getNoteAt(vault, "build-the-memory-feature");

      expect(note).not.toBeNull();

      expect(note!.source).toBe("generated");

      expect(note!.tags).toEqual(["pi-session", "proj"]);

      expect(note!.title).toBe("build the memory feature");

      expect(note!.created).toBe("2026-08-23T09:00:00.000Z");

      const raw = await fs.readFile(join(vault, "notes", "sessions", "build-the-memory-feature.md"), "utf8");

      expect(raw).toContain("session_id: aaaa-bbbb-cccc");

      expect(raw).toContain(`session_hash: ${await hashOf(SESSION_A)}`);

      expect(raw).toContain("session_cwd: /tmp/proj");

      expect(raw).toContain("- Transcript: `");

      expect(raw).toContain("- Summarized: 2026-08-23T09:00:00.000Z by testprovider/test-model");

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("skips unchanged sessions on re-scan without calling the model", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "a.jsonl", SESSION_A);

      await scan(deps);

      const before = deps.calls.length;

      const second = await scan(deps);

      expect(second).toMatchObject({ written: 0, created: 0, updated: 0, skippedFresh: 1 });

      expect(deps.calls.length).toBe(before);

      // and the note is still there, exactly one

      expect(await getNoteAt(vault, "build-the-memory-feature")).not.toBeNull();

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("re-summarizes a grown session in place, keeping slug, created, and title", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "a.jsonl", SESSION_A);

      const summarize = counterSummarizer();

      const first = await scan(deps, {

        now: () => new Date("2026-08-23T09:00:00Z"),

        summarize,

      });

      expect(first.created).toBe(1);

      await putSession(sessions, "a.jsonl", SESSION_A + jsonl([

        { type: "message", id: "m3", parentId: "m2", timestamp: "2026-08-22T07:00:00Z", message: { role: "user", content: "now also add tests" } },

      ]));

      const second = await scan(deps, {

        now: () => new Date("2026-08-23T10:00:00Z"),

        summarize,

      });

      expect(second).toMatchObject({ created: 0, updated: 1, written: 1 });

      const note = await getNoteAt(vault, "build-the-memory-feature");

      expect(note).not.toBeNull();

      expect(note!.created).toBe("2026-08-23T09:00:00.000Z"); // creation preserved

      expect(note!.updated).toBe("2026-08-23T10:00:00.000Z"); // bumped

      expect(note!.body).toContain("Summary #2");

      const raw = await fs.readFile(join(vault, "notes", "sessions", "build-the-memory-feature.md"), "utf8");

      expect(raw).toContain(`session_hash: ${await hashOf(SESSION_A + jsonl([

        { type: "message", id: "m3", parentId: "m2", timestamp: "2026-08-22T07:00:00Z", message: { role: "user", content: "now also add tests" } },

      ]))}`);

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("updates a renamed note in place (marker lookup, not slug lookup)", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "a.jsonl", SESSION_A);

      const summarize = counterSummarizer();

      await scan(deps, { summarize });

      await fs.rename(

        join(vault, "notes", "sessions", "build-the-memory-feature.md"),

        join(vault, "notes", "sessions", "human-renamed-me.md"),

      );

      await putSession(sessions, "a.jsonl", SESSION_A + jsonl([

        { type: "message", id: "m3", parentId: "m2", timestamp: "t", message: { role: "user", content: "more" } },

      ]));

      const result = await scan(deps, { summarize });

      expect(result.updated).toBe(1);

      expect(result.created).toBe(0);

      const renamed = await getNoteAt(vault, "human-renamed-me");

      expect(renamed).not.toBeNull();

      expect(renamed!.body).toContain("Summary #2");

      expect(renamed!.body).toContain("2 user");

      // no duplicate appeared under the derived slug

      expect(await getNoteAt(vault, "build-the-memory-feature")).toBeNull();

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("preserves human edits (unknown front matter, raw tail, title) across re-summarization", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "a.jsonl", SESSION_A);

      const summarize = counterSummarizer();

      await scan(deps, { summarize });

      const notePath = join(vault, "notes", "sessions", "build-the-memory-feature.md");

      // The generated title contains ":", so the serializer quotes it.

      await fs.writeFile(

        notePath,

        (await fs.readFile(notePath, "utf8")).replace(

          "title: build the memory feature",

          "title: Human title\nmyspecialkey: keepme",

        ),

        "utf8",

      );

      let raw = await fs.readFile(notePath, "utf8");

      raw += "\n---\n\n## Raw\n<!-- NEVER edit below this line. -->\n\n```\nmy human scribble\n```\n";

      await fs.writeFile(notePath, raw.replace("Summary #1", "Human summary"), "utf8");

      await putSession(sessions, "a.jsonl", SESSION_A + jsonl([

        { type: "message", id: "m3", parentId: "m2", timestamp: "t", message: { role: "user", content: "more" } },

      ]));

      await scan(deps, { summarize });

      const after = await fs.readFile(notePath, "utf8");

      expect(after).toContain("title: Human title");

      expect(after).toContain("myspecialkey: keepme");

      expect(after).toContain("NEVER edit below this line");

      expect(after).toContain("my human scribble");

      expect(after).toContain("Summary #2"); // body re-summarized above the tail

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("considers only the maxSessions newest files", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      const OLD = SESSION_A.replace(

        "build the memory feature",

        "paint the fence",

      ).replace("aaaa-bbbb-cccc", "7777-0000-0000");

      await putSession(sessions, "old.jsonl", OLD, 1000);

      await putSession(sessions, "new.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "ffff-1111-2222"), 2000);

      const result = await scan(deps, { maxSessions: 1 });

      expect(result).toMatchObject({ discovered: 2, considered: 1, created: 1 });

      expect(deps.calls[0]?.path).toContain("new.jsonl");

      expect(await getNoteAt(vault, "paint-the-fence")).toBeNull(); // old one not scanned

      expect(await getNoteAt(vault, "build-the-memory-feature")).not.toBeNull();

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("skips oversized files before reading them", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "big.jsonl", SESSION_A);

      const result = await scan(deps, { maxFileBytes: 3 });

      expect(result).toMatchObject({ discovered: 1, considered: 0, skippedTooBig: 1 });

      expect(deps.calls).toHaveLength(0);

      expect(await getNoteAt(vault, "build-the-memory-feature")).toBeNull();

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("counts empty and header-less sessions without spending tokens", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "empty.jsonl", jsonl([header("zzz")]));

      await putSession(sessions, "nosession.jsonl", "{\"type\":\"message\"}\n");

      const result = await scan(deps);

      expect(result).toMatchObject({ considered: 2, skippedEmpty: 1, skippedUnreadable: 1, written: 0 });

      expect(deps.calls).toHaveLength(0);

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("counts an unreadable file as unreadable without touching the others", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "doomed.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "dddd-0000-1111"), 2000);

      await putSession(sessions, "fine.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "eeee-0000-2222"), 1000);

      // The listing stats it fine; the phase-1 read then fails.

      await fs.chmod(join(sessions, "--proj--", "doomed.jsonl"), 0o000);

      const result = await scan(deps, { concurrency: 1 });

      expect(result).toMatchObject({ considered: 2, skippedUnreadable: 1, written: 1 });

      expect(deps.calls[0]?.path).toContain("fine.jsonl");

      expect(await fs.readdir(join(vault, "notes", "sessions"))).toEqual(["build-the-memory-feature.md"]);

    } finally {

      await fs.chmod(join(sessions, "--proj--", "doomed.jsonl"), 0o644).catch(() => {});

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("collects per-session failures without aborting the run", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "bad.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "bbbb-1111-2222"), 2000);

      await putSession(sessions, "good.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "cccc-2222-3333"), 1000);

      let n = 0;

      const result = await scan(deps, {

        concurrency: 1,

        summarize: async () => {

          n += 1;

          if (n === 1) throw new Error("model exploded");

          return "fine";

        },

      });

      expect(result.failed).toHaveLength(1);

      expect(result.failed[0]?.path).toContain("bad.jsonl");

      expect(result.failed[0]?.error).toBe("model exploded");

      expect(result.written).toBe(1);

      // A blank summary is also a failure (no silent empty notes). The other

      // session is hash-fresh by now, so only the failed one re-costs a call.

      const emptySummary = await scan(deps, {

        summarize: async () => "   ",

      });

      expect(emptySummary.skippedFresh).toBe(1);

      expect(emptySummary.failed).toHaveLength(1);

      expect(emptySummary.failed[0]?.error).toContain("empty summary");

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("stops scheduling new work when aborted mid-run", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "a1.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "1111-0000-0000"), 1000);

      await putSession(sessions, "a2.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "2222-0000-0000"), 2000);

      await putSession(sessions, "a3.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "3333-0000-0000"), 3000);

      const controller = new AbortController();

      const seen: string[] = [];

      const result = await scan(deps, {

        concurrency: 1,

        signal: controller.signal,

        summarize: async ({ path }) => {

          seen.push(path);

          if (seen.length === 2) controller.abort();

          return "s";

        },

      });

      expect(seen.length).toBe(2);

      expect(result.written).toBe(2);

      expect(result.considered).toBe(3);

      // Same first message => same derived slug; the identity guard gives the

      // second session its own note instead of overwriting the first.

      const files = (await fs.readdir(join(vault, "notes", "sessions"))).sort();

      expect(files).toEqual([

        "build-the-memory-feature-2.md",

        "build-the-memory-feature.md",

      ]);

      const firstNote = await getNoteAt(vault, "build-the-memory-feature");

      const secondNote = await getNoteAt(vault, "build-the-memory-feature-2");

      expect(firstNote!.body).toContain("3333-0000-0000"); // newest scanned first

      expect(secondNote!.body).toContain("2222-0000-0000");

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("reports progress for every candidate", async () => {

    const { sessions, vault, deps } = await makeScenario();

    try {

      await putSession(sessions, "a.jsonl", SESSION_A);

      await putSession(sessions, "b.jsonl", SESSION_A.replace("aaaa-bbbb-cccc", "bbbb-9999-9999"));

      const progress: { current: number; total: number; path: string }[] = [];

      await scan(deps, { onProgress: (p) => progress.push(p) });

      expect(progress.map((p) => p.current)).toEqual([1, 2]);

      expect(progress.every((p) => p.total === 2)).toBe(true);

    } finally {

      await fs.rm(sessions, { recursive: true, force: true });

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

});

/** A summarizer whose "Summary #N" counter survives across scans in one test. */

function counterSummarizer(): (input: { path: string; content: string }) => Promise<string> {

  let n = 0;

  return async () => `Summary #${++n}`;

}

/** sha1 of a string, mirroring the engine's hashContent. */

async function hashOf(text: string): Promise<string> {

  const { createHash } = await import("node:crypto");

  return createHash("sha1").update(text).digest("hex");

}

describe("migrateLegacySessionNotes", () => {

  const LEGACY = (id: string, title: string): string =>

    [

      "---",

      `title: "${title}"`,

      "created: 2026-08-23T09:00:00.000Z",

      "updated: 2026-08-23T09:30:00.000Z",

      "tags: [pi-session, proj]",

      "source: generated",

      `session_id: ${id}`,

      "session_hash: cafe",

      "session_cwd: /tmp/proj",

      "---",

      "",

      "The summary.",

      "",

      "## Details",

      "",

      `- Session: \`${id}\``,

      "- Started: 2026-08-22T06:33:12.008Z · ended: 2026-08-22T07:00:00Z",

      "- Transcript: `/x.jsonl`",

      "",

    ].join("\n");

  it("moves session notes out of notes/, stripping prefixes and backfilling session_start", async () => {

    const vault = await makeTempDir();

    try {

      await fs.mkdir(join(vault, "notes"), { recursive: true });

      await fs.writeFile(

        join(vault, "notes", "pi-session-what-is-this.md"),

        LEGACY("id-1", "Pi session: What is this?"),

        "utf8",

      );

      await fs.writeFile(join(vault, "notes", "regular.md"), "---\ntitle: Regular\n---\n\nhuman\n", "utf8");

      const moved = await migrateLegacySessionNotes(vault);

      expect(moved).toBe(1);

      // gone from notes/, present in notes/sessions/, renamed without the prefix

      await expect(fs.access(join(vault, "notes", "pi-session-what-is-this.md"))).rejects.toThrow();

      const raw = await fs.readFile(join(vault, "notes", "sessions", "what-is-this.md"), "utf8");

      expect(raw).toContain("title: What is this?"); // prefix stripped

      expect(raw).toContain('session_start: "2026-08-22T06:33:12.008Z"'); // backfilled

      expect(raw).toContain("session_id: id-1");

      // the human note is untouched

      expect((await getNote(vault, "regular"))!.body).toBe("human");

    } finally {

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

  it("leaves a legacy note alone when its target is unwritable", async () => {
    const vault = await makeTempDir();
    try {
      await fs.mkdir(join(vault, "notes"), { recursive: true });
      // A FILE squatting where the sessions directory must go makes the
      // mkdir (and therefore the move) fail for the whole collection.
      await fs.writeFile(join(vault, "notes", "sessions"), "not a dir", "utf8");
      await fs.writeFile(join(vault, "notes", "pi-session-stuck.md"), LEGACY("id-9", "Pi session: Stuck"), "utf8");
      expect(await migrateLegacySessionNotes(vault)).toBe(0);
      await expect(fs.access(join(vault, "notes", "pi-session-stuck.md"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it("is idempotent, migrates the interim vault/sessions/ layout too, and keeps colliding legacy notes", async () => {

    const vault = await makeTempDir();

    try {

      expect(await migrateLegacySessionNotes(vault)).toBe(0); // no notes dir

      // interim layout: vault-level sessions/ folder (pre-nested-notes scan)

      await fs.mkdir(join(vault, "sessions"), { recursive: true });

      await fs.writeFile(

        join(vault, "sessions", "interim.md"),

        LEGACY("id-3", "Interim"),

        "utf8",

      );

      expect(await migrateLegacySessionNotes(vault)).toBe(1);

      await expect(fs.access(join(vault, "sessions", "interim.md"))).rejects.toThrow();

      await expect(fs.access(join(vault, "notes", "sessions", "interim.md"))).resolves.toBeUndefined();

      await fs.mkdir(join(vault, "notes"), { recursive: true });

      await fs.writeFile(

        join(vault, "notes", "pi-session-clash.md"),

        LEGACY("id-2", "Pi session: Clash"),

        "utf8",

      );

      // same session already migrated under the same name by an earlier pass

      await fs.writeFile(

        join(vault, "notes", "sessions", "clash.md"),

        LEGACY("id-2", "Clash"),

        "utf8",

      );

      // The sessions/ copy carries the same session id — it is the

      // authoritative, rescanned one, so the stale legacy duplicate goes.

      expect(await migrateLegacySessionNotes(vault)).toBe(1);

      await expect(fs.access(join(vault, "notes", "pi-session-clash.md"))).rejects.toThrow();

      // second full migration run is a clean no-op once the dir is empty

      await fs.rm(join(vault, "notes", "pi-session-clash.md"), { force: true });

      expect(await migrateLegacySessionNotes(vault)).toBe(0);

    } finally {

      await fs.rm(vault, { recursive: true, force: true });

    }

  });

});
