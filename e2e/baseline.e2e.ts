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
 * The baseline journey: open pi with pi-weave loaded, run the slash commands,
 * have the (stub) agent write a note, open /weave-view in a browser, click
 * around, and quit. Steps run in order and share one pi session; each `it`
 * is one thing a person would do.
 */

const NOTE_TITLE = "Launch checklist";
const NOTE_BODY = "Ship the e2e baseline. Ask every PR to run it.";

describe("baseline: pi + pi-weave + /weave-view", () => {
  let model: StubModel;
  let sandbox: Sandbox;
  let pi: PiSession;
  let browser: Browser;
  let page: Page;
  let workspaceUrl = "";
  let step = 0;
  const artifacts = artifactDir("baseline");

  beforeAll(async () => {
    model = await startStubModel([
      {
        // "please note: <title>" → the agent calls weave_note add.
        match: (req) => lastMessageText(req).includes("please note:"),
        reply: { tool: { name: "weave_note", args: { action: "add", title: NOTE_TITLE, text: NOTE_BODY } } },
      },
    ]);
    sandbox = createSandbox({ modelBaseUrl: model.baseUrl });
    pi = new PiSession(sandbox);
    pi.start();
    browser = await launchBrowser();
  });

  // Steps build on each other, so after the first failure the rest are
  // skipped instead of each timing out against a broken session.
  let broken = false;
  beforeEach((ctx) => {
    if (broken) ctx.skip();
  });

  // Every step leaves pi's screen and (once open) the browser page behind,
  // pass or fail, under e2e/.artifacts/baseline/.
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

  it("starts pi with pi-weave loaded", async () => {
    // The status line pi-weave owns is the proof the extension loaded.
    await pi.waitFor("🕸️", { label: "pi-weave status line" });
    expect(pi.screen()).toContain("stub-model");
  });

  it("/weave shows the dashboard", async () => {
    await pi.submit("/weave");
    await pi.waitFor(`Vault (${sandbox.vault})`, { label: "dashboard vault line" });
  });

  it("the agent can write a note with weave_note", async () => {
    await pi.submit(`please note: ${NOTE_TITLE}`);
    await pi.waitFor("stub: done", { label: "agent turn to finish" });

    const toolNames = (model.requests[0]?.tools ?? []).map((t) => t.function?.name);
    expect(toolNames).toContain("weave_note");

    const notes = listMarkdown(sandbox.vault);
    const note = notes.find((path) => readFileSync(path, "utf8").includes(NOTE_BODY));
    expect(note, `no note with the body in ${notes.join(", ")}`).toBeDefined();
  });

  it("/weave-view --no-open starts the browser workspace", async () => {
    await pi.submit("/weave-view --no-open");
    const screen = await pi.waitFor(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/, { label: "workspace URL" });
    workspaceUrl = screen.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)![0];
    await pi.waitFor(/web:\d+/, { label: "web marker in status line" });
  });

  it("the workspace loads and lists the note", async () => {
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.goto(workspaceUrl);
    await page.getByText("Your knowledge, connected.").waitFor();
    await page.getByRole("button", { name: "Toggle notes sidebar" }).waitFor();
    await page.getByText(NOTE_TITLE).first().waitFor();
  });

  it("clicking the note opens it", async () => {
    await page.getByText(NOTE_TITLE).first().click();
    await page.getByText("Ship the e2e baseline").first().waitFor();
  });

  it("the graph view opens", async () => {
    await page.getByRole("button", { name: "Open graph view" }).click();
    await page.locator("canvas").first().waitFor();
  });

  it("search finds the note", async () => {
    await page.getByRole("button", { name: "Search notes and repository" }).click();
    await page.keyboard.type("Launch");
    await page.getByText(NOTE_TITLE).first().waitFor();
    await page.keyboard.press("Escape");
  });

  it("settings open", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByText("Appearance").first().waitFor();
  });

  it("quitting pi shuts the workspace down", async () => {
    await page.close();
    await pi.stop();
    await expect(fetch(workspaceUrl)).rejects.toThrow();
  });
});

function listMarkdown(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => join(d.parentPath, d.name));
}
