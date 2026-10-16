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
 * and a two-note graph fits itself. Raw is editable in a folded box of its
 * own, and an edit there reaches the disk.
 */

const NOTE_TITLE = "Standup notes";
const NOTE_SLUG = "standup-notes";
const NOTE_BODY = "Ship the editor polish first.";
const DICTATION = "said out loud: raw stays below the editor";
const TYPED = " Typed in the browser.";
const EDITED = "said out loud: and fixed a typo in Raw";
// A long dictation: Raw folds away so it never outgrows the note above it.
const LONG_DICTATION = Array.from({ length: 24 }, (_, i) => `line ${i + 1} of a long dictated ramble about the launch`).join("\n");

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
        match: (req) => lastMessageText(req).includes("please ramble:"),
        reply: { tool: { name: "weave_note", args: { action: "append", slug: NOTE_SLUG, text: LONG_DICTATION, raw: true } } },
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
    await pi.submit("please ramble: on");
    await expect.poll(() => noteText().includes("line 24 of a long dictated ramble"), { timeout: 15_000 }).toBe(true);
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
    // Reading folds the Raw tail into one line under the prose, as editing does.
    const fold = page.locator(".weave-raw-read");
    await fold.getByText("2 entries captured").waitFor();
    expect(await fold.getAttribute("open")).toBeNull();
    expect(await page.getByText("line 24 of a long dictated ramble").isVisible()).toBe(false);
  });

  it("Esc while reading leaves the note open", async () => {
    // The prose itself: the body's centre is the folded Raw toggle now.
    await page.locator(".weave-note-body").getByText(NOTE_BODY).click();
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: NOTE_TITLE }).waitFor();
    expect(await page.getByRole("heading", { name: NOTE_TITLE }).count()).toBe(1);
  });

  it("Edit focuses an editor that holds only the body, with Raw folded below", async () => {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Note body" });
    await editor.waitFor();
    expect(await editor.inputValue()).toBe(NOTE_BODY);
    expect(await editor.evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);
    const raw = page.getByRole("region", { name: "Raw notes" });
    await raw.getByText("2 entries captured").waitFor();
    expect(await raw.getByRole("button", { name: "Raw" }).getAttribute("aria-expanded")).toBe("false");
    expect(await page.getByRole("textbox", { name: "Raw notes text" }).count()).toBe(0);
  });

  it("a pause in typing saves by itself and keeps the Raw tail on disk", async () => {
    await page.keyboard.type(TYPED);
    const bar = page.getByRole("toolbar", { name: "Editing" });
    await bar.getByText("Unsaved changes").waitFor();
    await bar.getByText(/^Saved /).waitFor();
    const text = noteText();
    expect(text).toContain(`${NOTE_BODY}${TYPED}`);
    expect(text.indexOf(TYPED)).toBeLessThan(text.indexOf("## Raw"));
    expect(text).toContain(DICTATION);
    // Still editing until Done (or Esc).
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  });

  it("opening Raw shows its words in their own box, capped in height", async () => {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Raw" }).click();
    const raw = page.getByRole("textbox", { name: "Raw notes text" });
    await raw.waitFor();
    expect(await raw.inputValue()).toContain(DICTATION);
    expect(await raw.inputValue()).toContain("line 24 of a long dictated ramble");
    // The opening (rule, heading, notice) is not in the box.
    expect(await raw.inputValue()).not.toContain("## Raw");
    const box = await raw.boundingBox();
    expect(box!.height).toBeLessThan(320);
  });

  it("editing Raw and pressing ⌘S writes the change to disk", async () => {
    const raw = page.getByRole("textbox", { name: "Raw notes text" });
    await raw.fill((await raw.inputValue()).replace(DICTATION, EDITED));
    await page.keyboard.press("Control+s");
    await page.getByRole("toolbar", { name: "Editing" }).getByText(/^Saved /).waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    const text = noteText();
    expect(text).toContain(EDITED);
    expect(text).not.toContain(DICTATION);
    expect(text).toContain(`${NOTE_BODY}${TYPED}`);
    expect(text).toContain("line 24 of a long dictated ramble");
    expect(text.indexOf(TYPED)).toBeLessThan(text.indexOf("## Raw"));
    expect(text.indexOf("## Raw")).toBeLessThan(text.indexOf(EDITED));
  });

  it("Context floats as a card that folds to a pill and docks as a column", async () => {
    const card = page.locator(".weave-context-float");
    await card.getByText("Context", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Hide context sidebar" }).click();
    await page.getByRole("button", { name: /^Show context/ }).click();
    await card.getByRole("button", { name: "Dock context as a column" }).click();
    await page.getByRole("button", { name: "Float context over the page" }).waitFor();
    expect(await page.locator(".weave-context-float").count()).toBe(0);
    await page.getByRole("button", { name: "Float context over the page" }).click();
    await card.waitFor();
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
