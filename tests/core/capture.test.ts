import { promises as fs } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  formatDuration,
  formatTimestamp,
  formatTranscript,
  listTranscripts,
  newTranscriptCount,
  readTranscript,
  saveTranscript,
  setTranscriptStatus,
  takeInbox,
} from "../../src/core/capture";
import { executeNoteAction } from "../../src/core/noteAction";
import { addNote, getNote, setNoteFields } from "../../src/core/vault";
import { formatDashboard, formatStatusLine, getWorkspaceStatus } from "../../src/core/workspace";
import { createWorkspaceCommands } from "../../src/core/workspaceCommands";
import { makeTempDir, writeFixture } from "../helpers";

let vault: string;
beforeEach(async () => {
  vault = await makeTempDir();
});

const meeting = (title: string, recorded: string, capture: string) =>
  saveTranscript(vault, {
    title,
    recorded: new Date(recorded),
    duration: 2520,
    segments: [
      { start: 4.2, text: " Okay,  let's start. " },
      { start: 19, text: "" },
      { start: 3725, text: "Then step two." },
    ],
    capture,
  });

describe("transcript formatting", () => {
  it("formats timestamps and durations", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(3725.9)).toBe("01:02:05");
    expect(formatTimestamp(-3)).toBe("00:00:00");
    expect(formatDuration(40)).toBe("40s");
    expect(formatDuration(2520)).toBe("42m");
    expect(formatDuration(3900)).toBe("1h 05m");
    expect(formatDuration(-1)).toBe("0s");
  });

  it("writes one timed line per segment and drops blank ones", () => {
    expect(formatTranscript([{ start: 4, text: " a\n b " }, { start: 5, text: "  " }])).toBe("[00:00:04] a b");
    expect(formatTranscript([])).toBe("_Nothing was transcribed._");
  });
});

describe("transcript notes", () => {
  it("saves a transcript into meetings/ as a new, generated note", async () => {
    const note = await meeting("Design sync", "2026-11-09T07:00:00.000Z", "cap_one");
    expect(note.slug).toBe("meetings/design-sync");
    expect(note.source).toBe("generated");
    expect(note.created).toBe("2026-11-09T07:00:00.000Z");
    const text = await fs.readFile(join(vault, "notes", "meetings", "design-sync.md"), "utf8");
    expect(text).toContain("kind: transcript\nrecorded: \"2026-11-09T07:00:00.000Z\"\nduration: 2520\nstatus: new\ncapture: cap_one\n---");
    expect(text).toContain("[00:00:04] Okay, let's start.\n[01:02:05] Then step two.");
    const again = await meeting("Design sync", "2026-11-10T07:00:00.000Z", "cap_two");
    expect(again.slug).toBe("meetings/design-sync-2");
  });

  it("lists transcripts newest first and ignores other notes", async () => {
    await meeting("Older", "2026-11-01T07:00:00.000Z", "cap_a");
    await meeting("Newer", "2026-11-09T07:00:00.000Z", "cap_b");
    await addNote(vault, { title: "Plain", body: "not a meeting", folder: "meetings" });
    await writeFixture(vault, "notes/meetings/nested/deep.md", "---\ntitle: Deep\nkind: transcript\nduration: x\n---\nhi\n");
    await writeFixture(vault, "notes/meetings/readme.txt", "ignored");
    const list = await listTranscripts(vault);
    expect(list.map((item) => item.slug)).toEqual(["meetings/newer", "meetings/older", "meetings/nested/deep"]);
    expect(list[2]).toMatchObject({ title: "Deep", duration: 0, status: "read", recorded: "" });
    expect(await newTranscriptCount(vault)).toBe(2);
  });

  it("reads nothing from a vault without meetings", async () => {
    expect(await listTranscripts(vault)).toEqual([]);
    expect(readTranscript("x", "no front matter")).toBeNull();
    expect(readTranscript("x", "---\ntitle: X\n---\nbody")).toBeNull();
    expect(readTranscript("meetings/x", "---\nkind: transcript\ncreated: 2026-01-01\n---\n")).toMatchObject({ title: "meetings/x", recorded: "2026-01-01" });
  });

  it("marks transcripts read and new, keeping the body and other fields", async () => {
    const note = await meeting("Sync", "2026-11-09T07:00:00.000Z", "cap_c");
    expect(await setTranscriptStatus(vault, note.slug, "read")).toBe(true);
    const read = await getNote(vault, note.slug);
    expect(read?.body).toBe(note.body);
    expect(read?.frontMatter).toContain("status: read");
    expect(read?.frontMatter).toContain("capture: cap_c");
    expect(await setTranscriptStatus(vault, "meetings/missing", "read")).toBe(false);
    expect(await setNoteFields(vault, "../escape", { status: "read" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("takes the inbox once", async () => {
    expect((await takeInbox(vault)).text).toContain("No new meeting transcripts");
    await meeting("Sync", "2026-11-09T07:00:00.000Z", "cap_d");
    const first = await takeInbox(vault);
    expect(first.text).toContain("1 new meeting transcript, now marked read:");
    expect(first.text).toContain("- meetings/sync: Sync (2026-11-09 07:00, 42m)");
    expect(first.transcripts[0]?.status).toBe("read");
    await writeFixture(vault, "notes/meetings/a.md", "---\ntitle: A\nkind: transcript\nstatus: new\n---\n");
    await writeFixture(vault, "notes/meetings/b.md", "---\ntitle: B\nkind: transcript\nstatus: new\n---\n");
    const second = await takeInbox(vault);
    expect(second.text).toContain("2 new meeting transcripts");
    expect(second.text).toContain("(unknown time, 0s)");
    expect((await takeInbox(vault)).transcripts).toEqual([]);
  });
});

describe("the inbox in every harness", () => {
  it("counts new meetings in the status line and dashboard", async () => {
    await meeting("Sync", "2026-11-09T07:00:00.000Z", "cap_e");
    const status = await getWorkspaceStatus(vault, { vaultRoot: vault });
    expect(status.vault.newTranscripts).toBe(1);
    expect(formatStatusLine(status)).toBe("🕸️ 1 note · 1 new meeting (/weave-inbox)");
    expect(formatDashboard(status)).toContain("1 new meeting transcript(s) — run /weave-inbox");
    await takeInbox(vault);
    const after = await getWorkspaceStatus(vault, { vaultRoot: vault });
    expect(after.vault.newTranscripts).toBeUndefined();
    expect(formatStatusLine({ ...after, vault: { ...after.vault, newTranscripts: 3 }, repository: { root: "/r", name: "r", summaryCount: 2 } })).toBe(
      "🕸️ 1 note · 2 summaries · 3 new meetings (/weave-inbox)",
    );
  });

  it("answers weave_note action inbox", async () => {
    await meeting("Sync", "2026-11-09T07:00:00.000Z", "cap_f");
    const result = await executeNoteAction({ action: "inbox" }, vault, () => new Date(), null);
    expect(result.text).toContain("meetings/sync");
    expect(result.details).toMatchObject({ action: "inbox" });
  });

  it("runs /weave-inbox as a shared command", async () => {
    const previous = process.env.PI_WEAVE_VAULT;
    process.env.PI_WEAVE_VAULT = vault;
    try {
      const out: string[] = [];
      const commands = createWorkspaceCommands({
        getSession: async (id) => ({ id, cwd: vault, model: null }),
        getDigest: async () => {
          throw new Error("unused");
        },
        sessionSource: () => "",
        generate: async () => "",
        output: async (_id, text) => out.push(text),
      });
      await meeting("Sync", "2026-11-09T07:00:00.000Z", "cap_g");
      await commands.commands.find((command) => command.name === "weave-inbox")!.execute("s", "");
      expect(out[0]).toContain("meetings/sync");
    } finally {
      if (previous === undefined) delete process.env.PI_WEAVE_VAULT;
      else process.env.PI_WEAVE_VAULT = previous;
    }
  });
});
