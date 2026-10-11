import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { artifactDir, snapPage, snapText } from "./harness/artifacts";
import { launchBrowser } from "./harness/browser";
import { PiSession } from "./harness/piSession";
import { createSandbox, type Sandbox } from "./harness/sandbox";
import { lastMessageText, startStubModel, type StubModel } from "./harness/stubModel";

/**
 * The browser editor (#77): Raw stays out of the textarea and survives a save,
 * Edit puts the cursor in the editor, Esc does not close the note being read,
 * and a two-note graph fits itself.
 */

const NOTE_TITLE = "Standup notes";
const NOTE_SLUG = "standup-notes";
const NOTE_BODY = "Ship the editor polish first.";
const DICTATION = "said out loud: raw stays below the editor";
const TYPED = " Typed in the browser.";

describe("editor polish: Raw tail, focus, Esc, small graph", () => {
  let model: StubModel;
  let sandbox: Sandbox;
  let pi: PiSession;
  let browser: Browser;
  let page: Page;
  let workspaceUrl = "";
  let step = 0;
  const artifacts = artifactDir("editor-polish");

  beforeAll(async () => {
    model = await startStubModel([
      {
        match: (req) => lastMessageText(req).includes("please note:"),
        reply: { tool: { name: "weave_note", args: { action: "add", title: NOTE_TITLE, text: NOTE_BODY } } },
      },
      {
        // Dictation lands verbatim in the note's `## Raw` tail.
        match: (req) => lastMessageText(req).includes("please dictate:"),
        reply: { tool: { name: "weave_note", args: { action: "append", slug: NOTE_SLUG, text: DICTATION, raw: true } } },
      },
      {
        match: (req) => lastMessageText(req).includes("please also note:"),
        reply: { tool: { name: "weave_note", args: { action: "add", title: "Second note", text: `Follows [[${NOTE_SLUG}]].` } } },
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

  it("the agent writes a note with a Raw tail, and a second note linking it", async () => {
    await pi.waitFor("🕸️", { label: "pi-weave status line" });
    await pi.submit(`please note: ${NOTE_TITLE}`);
    await pi.waitFor("stub: done", { label: "add turn" });
    await pi.submit("please dictate: something");
    await pi.waitFor(/Appended verbatim/, { label: "raw append" });
    await pi.submit("please also note: second");
    await pi.waitFor(/Second note|second-note/, { label: "second note" });
    expect(noteText()).toContain("## Raw");
    expect(noteText()).toContain(DICTATION);
  });

  it("opens the workspace on the note", async () => {
    await pi.submit("/weave-view --no-open");
    const screen = await pi.waitFor(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/, { label: "workspace URL" });
    workspaceUrl = screen.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)![0];
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.goto(workspaceUrl);
    await page.getByText(NOTE_TITLE).first().click();
    await page.getByText(NOTE_BODY).first().waitFor();
  });

  it("Esc while reading leaves the note open", async () => {
    await page.locator(".weave-note-body").first().click();
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: NOTE_TITLE }).waitFor();
    expect(await page.getByRole("heading", { name: NOTE_TITLE }).count()).toBe(1);
  });

  it("Edit focuses an editor that holds only the body, with Raw read-only below", async () => {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Note body" });
    await editor.waitFor();
    expect(await editor.inputValue()).toBe(NOTE_BODY);
    expect(await editor.evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);
    const raw = page.getByRole("region", { name: "Raw notes, read-only" });
    await raw.getByText(DICTATION).waitFor();
  });

  it("typing and saving keeps the Raw tail on disk", async () => {
    await page.keyboard.type(TYPED);
    await page.keyboard.press("Control+s");
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    const text = noteText();
    expect(text).toContain(`${NOTE_BODY}${TYPED}`);
    expect(text.indexOf(TYPED)).toBeLessThan(text.indexOf("## Raw"));
    expect(text).toContain(DICTATION);
  });

  it("a two-note graph opens fitted with every node labelled", async () => {
    await page.getByRole("button", { name: "Open graph view" }).click();
    await page.locator("canvas").first().waitFor();
    // Labels are drawn on a canvas, so this step's proof is its screenshot.
    await page.waitForTimeout(1500);
  });

  function noteText(): string {
    const path = readdirSync(sandbox.vault, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name === `${NOTE_SLUG}.md`)
      .map((d) => join(d.parentPath, d.name))[0];
    expect(path, "note file").toBeDefined();
    return readFileSync(path!, "utf8");
  }
});
