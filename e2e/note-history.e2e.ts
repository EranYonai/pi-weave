import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { artifactDir, snapPage, snapText } from "./harness/artifacts";
import { launchBrowser } from "./harness/browser";
import { PiSession } from "./harness/piSession";
import { createSandbox, type Sandbox } from "./harness/sandbox";
import { lastMessageText, startStubModel, type StubModel } from "./harness/stubModel";
import { COMPACT_TO, encodeRevisions, MAX_REVISIONS } from "../src/core/history";

/**
 * Note history, end to end: the agent writes a note in three steps (add, a
 * dictated Raw append, finalize), you edit it in /weave-view, and the
 * History slider replays all four. Then the Settings switch turns recording
 * off, and a further agent append leaves the log alone.
 */

const TITLE = "Standup with Maya";
const SLUG = "standup-with-maya";
const DICTATION = "Maya says the launch is Friday. Ask Dan about the npm token.";
const SUMMARY = "TLDR: launch Friday.\n\n## Decisions\n- Launch **Friday**";
const EDITED = "TLDR: launch Monday.\n\n## Decisions\n- Launch **Monday** (moved from Friday)";

interface LogLine {
  by: string;
  op: string;
}

describe("note history: every change saved, replayed in /weave-view", () => {
  let model: StubModel;
  let sandbox: Sandbox;
  let pi: PiSession;
  let browser: Browser;
  let page: Page;
  let workspaceUrl = "";
  let step = 0;
  const artifacts = artifactDir("note-history");
  const logPath = (): string => join(sandbox.vault, "history", `${SLUG}.jsonl`);
  const log = (): LogLine[] =>
    readFileSync(logPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogLine);

  beforeAll(async () => {
    model = await startStubModel([
      {
        match: (req) => lastMessageText(req).includes("please note:"),
        reply: { tool: { name: "weave_note", args: { action: "add", title: TITLE, text: "Standup notes." } } },
      },
      {
        match: (req) => lastMessageText(req).includes("please dictate:"),
        reply: { tool: { name: "weave_note", args: { action: "append", slug: SLUG, text: DICTATION, raw: true } } },
      },
      {
        match: (req) => lastMessageText(req).includes("please finalize"),
        reply: { tool: { name: "weave_note", args: { action: "finalize", slug: SLUG, text: SUMMARY } } },
      },
      {
        match: (req) => lastMessageText(req).includes("please add a footnote"),
        reply: { tool: { name: "weave_note", args: { action: "append", slug: SLUG, text: "Footnote while history is off." } } },
      },
    ]);
    sandbox = createSandbox({ modelBaseUrl: model.baseUrl });
    pi = new PiSession(sandbox);
    pi.start();
    browser = await launchBrowser();
  });

  let broken = false;
  beforeEach((ctx) => {
    if (broken) ctx.skip();
  });

  afterEach(async (ctx) => {
    if (ctx.task.result?.state === "fail") broken = true;
    step += 1;
    const name = `${String(step).padStart(2, "0")}-${ctx.task.name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}`;
    if (pi?.isRunning()) snapText(artifacts, name, pi.screen());
    if (page && !page.isClosed()) await snapPage(artifacts, name, page);
  });

  afterAll(async () => {
    await browser?.close();
    await pi?.stop();
    await model?.close();
    sandbox?.cleanup();
  });

  const agentTurn = async (prompt: string, turn: number): Promise<void> => {
    await pi.submit(prompt);
    // Every scripted turn ends with "stub: done"; count them so each wait is for this turn.
    await pi.waitFor(new RegExp(`(stub: done[\\s\\S]*){${turn}}`), { label: `agent turn ${turn}` });
  };

  it("starts pi with pi-weave loaded", async () => {
    await pi.waitFor("🕸️", { label: "pi-weave status line" });
  });

  it("the agent writes a note in three steps, each one saved", async () => {
    await agentTurn(`please note: ${TITLE}`, 1);
    await agentTurn("please dictate: the launch", 2);
    await agentTurn("please finalize the standup", 3);
    expect(log().map((l) => [l.by, l.op])).toEqual([
      ["agent", "create"],
      ["agent", "raw"],
      ["agent", "finalize"],
    ]);
  });

  it("/weave-view --no-open starts the browser workspace", async () => {
    await pi.submit("/weave-view --no-open");
    const screen = await pi.waitFor(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/, { label: "workspace URL" });
    workspaceUrl = screen.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)![0];
  });

  it("you edit the note in the workspace", async () => {
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.goto(workspaceUrl);
    await page.getByText(TITLE).first().click();
    await page.getByText("TLDR: launch Friday.").waitFor();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Note body" }).fill(EDITED);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    // Done saves and closes the editor.
    await page.getByText("TLDR: launch Monday.").waitFor();
    expect(log().at(-1)).toMatchObject({ by: "human", op: "edit" });
  });

  it("History opens on the latest version", async () => {
    await page.getByRole("button", { name: "History", exact: true }).click();
    const group = page.getByRole("group", { name: "Note history" });
    await group.getByText("4 of 4").waitFor();
    await group.getByText("You edited").waitFor();
    // The edit kept the dictation: the Raw tail is still there.
    await page.getByText(DICTATION).waitFor();
  });

  it("the slider steps back to the dictation, with the new words highlighted", async () => {
    await page.getByRole("slider", { name: "Version" }).fill("1");
    const group = page.getByRole("group", { name: "Note history" });
    await group.getByText("2 of 4").waitFor();
    await group.getByText("Agent added words to Raw").waitFor();
    await page.locator("mark", { hasText: "Maya says the launch is Friday" }).waitFor();
    // That version had no summary yet.
    expect(await page.getByText("TLDR: launch").count()).toBe(0);
  });

  it("the first version is the note as the agent created it", async () => {
    await page.getByRole("button", { name: "Previous version" }).click();
    const group = page.getByRole("group", { name: "Note history" });
    await group.getByText("1 of 4").waitFor();
    await group.getByText("Agent created the note").waitFor();
    await page.locator("mark", { hasText: "Standup notes." }).waitFor();
  });

  it("play replays the note to the end", async () => {
    await page.getByRole("button", { name: "Play replay" }).click();
    const group = page.getByRole("group", { name: "Note history" });
    await group.getByText("4 of 4").waitFor();
    await page.getByRole("button", { name: "Play replay" }).waitFor();
    await page.getByText("TLDR: launch Monday.").waitFor();
  });

  it("closing History goes back to the note", async () => {
    await page.getByRole("button", { name: "Close history" }).click();
    await page.getByRole("group", { name: "Note history" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  });

  it("a long history is capped on disk, sent as deltas, and says it was trimmed", async () => {
    // 600 saved versions, written straight into the log: more than the cap.
    const now = readFileSync(join(sandbox.vault, "notes", `${SLUG}.md`), "utf8");
    const body = now.slice(now.indexOf("\n---", 3) + 4).replace(/^\n+/, "");
    const versions = Array.from({ length: 600 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), by: "agent" as const, op: "append" as const,
      body: i === 599 ? body : `${body}\n\nDraft line ${i}.`,
    }));
    writeFileSync(logPath(), encodeRevisions(versions).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    // The next save compacts it.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Note body" }).press("End");
    await page.keyboard.type(" Capped.");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    const kept = Math.floor(MAX_REVISIONS * COMPACT_TO);
    expect(log()).toHaveLength(kept);
    expect(log()[0]).toMatchObject({ trimmed: true });
    // Deltas on the wire, not a full body per version.
    const wire = await page.evaluate(async (slug) => (await fetch(`/api/history/${slug}`)).text(), SLUG);
    const sent = JSON.parse(wire) as { trimmed: boolean; revisions: Array<{ full?: string }> };
    expect(sent.trimmed).toBe(true);
    expect(sent.revisions.filter((revision) => revision.full !== undefined).length).toBeLessThan(kept / 16);
    await page.getByRole("button", { name: "History", exact: true }).click();
    const group = page.getByRole("group", { name: "Note history" });
    await group.getByText(`${kept} of ${kept}`).waitFor();
    await page.getByRole("slider", { name: "Version" }).fill("0");
    await group.getByText(`1 of ${kept}`).waitFor();
    await group.getByText("Older versions were trimmed").waitFor();
    await snapPage(artifacts, "trimmed-history-open", page);
    await page.getByRole("button", { name: "Close history" }).click();
  });

  it("Settings turns history off, in the vault's okf.json", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    const toggle = page.getByRole("checkbox", { name: /Note history/ });
    await expect.poll(() => toggle.isChecked()).toBe(true);
    await toggle.uncheck();
    await expect.poll(() => toggle.isEnabled()).toBe(true);
    expect(await toggle.isChecked()).toBe(false);
    expect(JSON.parse(readFileSync(join(sandbox.vault, "okf.json"), "utf8"))).toMatchObject({ history: false });
    await page.keyboard.press("Escape");
  });

  it("with history off, an agent edit is not recorded", async () => {
    const before = log().length;
    await agentTurn("please add a footnote", 4);
    expect(readFileSync(join(sandbox.vault, "notes", `${SLUG}.md`), "utf8")).toContain("Footnote while history is off.");
    expect(log()).toHaveLength(before);
  });

  it("quitting pi shuts the workspace down", async () => {
    await page.close();
    await pi.stop();
    await expect(fetch(workspaceUrl)).rejects.toThrow();
    expect(existsSync(logPath())).toBe(true);
  });
});
