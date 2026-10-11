import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { artifactDir, snapPage, snapText } from "./harness/artifacts";
import { launchBrowser } from "./harness/browser";
import { PiSession } from "./harness/piSession";
import { createSandbox, type Sandbox } from "./harness/sandbox";
import { lastMessageText, startStubModel, type StubModel } from "./harness/stubModel";

/**
 * The recall trail (#78): with /weave-view open, notes the agent searches,
 * reads and writes glow in the workspace, the Context sidebar lists the turn's
 * steps, and pi's status line says how many notes the turn used.
 */

const NOTE_TITLE = "Auth migration";
const NOTE_SLUG = "auth-migration";

describe("recall trail: the agent's note activity shows live in /weave-view", () => {
  let model: StubModel;
  let sandbox: Sandbox;
  let pi: PiSession;
  let browser: Browser;
  let page: Page;
  let workspaceUrl = "";
  let step = 0;
  const artifacts = artifactDir("recall-trail");

  beforeAll(async () => {
    model = await startStubModel([
      {
        match: (req) => lastMessageText(req).includes("please note:"),
        reply: { tool: { name: "weave_note", args: { action: "add", title: NOTE_TITLE, text: "We decided OIDC next quarter." } } },
      },
      {
        match: (req) => lastMessageText(req).includes("what did we decide"),
        reply: { tool: { name: "weave_note", args: { action: "search", query: "auth" } } },
      },
      {
        match: (req) => lastMessageText(req).includes("please append"),
        reply: { tool: { name: "weave_note", args: { action: "append", slug: NOTE_SLUG, text: "SAML too." } } },
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

  const strip = () => page.getByRole("region", { name: "What your agent recalled" });

  it("starts pi with pi-weave loaded", async () => {
    await pi.waitFor("🕸️", { label: "pi-weave status line" });
  });

  it("a turn that writes a note says so in the status line", async () => {
    await pi.submit(`please note: ${NOTE_TITLE}`);
    await pi.waitFor("stub: done", { label: "agent turn to finish" });
    await pi.waitFor("used 1 note", { label: "used-notes count in the status line" });
  });

  it("the workspace opens with the written note glowing", async () => {
    await pi.submit("/weave-view --no-open");
    const screen = await pi.waitFor(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/, { label: "workspace URL" });
    workspaceUrl = screen.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)![0];
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.goto(workspaceUrl);
    await page.getByText(NOTE_TITLE).first().waitFor();
    await page.locator(".weave-row-trail-wrote", { hasText: NOTE_TITLE }).waitFor();
  });

  it("the Context sidebar lists this turn's steps", async () => {
    await page.getByText(NOTE_TITLE).first().click();
    const toggle = page.getByRole("button", { name: "Toggle context sidebar" });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    await strip().getByText("This turn").waitFor();
    await strip().getByText("created").waitFor();
    await strip().getByRole("button", { name: NOTE_TITLE }).waitFor();
  });

  it("a recall turn shows the search and the read, live", async () => {
    await pi.submit("what did we decide about auth?");
    await strip().getByText('searched "auth"').waitFor();
    await strip().getByText("1 hit").waitFor();
    await strip().getByText("read", { exact: true }).waitFor();
    await page.locator(".weave-row-trail-read", { hasText: NOTE_TITLE }).waitFor();
  });

  it("a write turn shows the append, live", async () => {
    await pi.submit("please append SAML");
    await strip().getByText("appended").waitFor();
    await page.locator(".weave-row-trail-wrote", { hasText: NOTE_TITLE }).waitFor();
  });

  it("a turn that touches no note starts empty and clears the count", async () => {
    await pi.submit("hello there");
    await pi.waitFor("stub: ok", { label: "plain turn to finish" });
    await strip().getByText("Nothing recalled yet.").waitFor();
    await pi.waitForGone("used 1 note");
  });

  it("clicking an earlier turn replays it", async () => {
    const turns = strip().getByRole("group", { name: "Earlier turns" }).getByRole("button");
    expect(await turns.count()).toBeGreaterThanOrEqual(4);
    const previous = turns.nth(1);
    await previous.click();
    await expect.poll(() => previous.getAttribute("aria-pressed")).toBe("true");
    await strip().getByText("appended").waitFor();
    await page.locator(".weave-row-trail-wrote", { hasText: NOTE_TITLE }).waitFor();
  });

  it("the graph view shows the glow", async () => {
    await page.getByRole("button", { name: "Open graph view" }).click();
    await page.locator("canvas").first().waitFor();
  });
});
