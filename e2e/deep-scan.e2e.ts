import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { artifactDir, snapPage, snapText } from "./harness/artifacts";
import { launchBrowser } from "./harness/browser";
import { PiSession } from "./harness/piSession";
import { createSandbox, type Sandbox } from "./harness/sandbox";
import { lastMessageText, startStubModel, type StubModel, type StubRequest } from "./harness/stubModel";

/**
 * Deep scan by default (#76): no nudges to index the repo, a status line
 * that counts notes, and a bare /weave-scan that writes model summaries.
 */

const SUMMARY = "Stub summary: greets people by name.";

function isDeepScanRequest(req: StubRequest): boolean {
  return req.messages.some((m) => typeof m.content === "string" && m.content.includes("summaries of source files"))
    || JSON.stringify(req.messages).includes("summaries of source files");
}

describe("scan: /weave-scan runs the deep scan", () => {
  let model: StubModel;
  let sandbox: Sandbox;
  let pi: PiSession;
  let browser: Browser;
  let page: Page;
  let workspaceUrl = "";
  let step = 0;
  const artifacts = artifactDir("scan");

  beforeAll(async () => {
    model = await startStubModel([
      { match: isDeepScanRequest, reply: { text: SUMMARY } },
      {
        match: (req) => lastMessageText(req).includes("please note:"),
        reply: { tool: { name: "weave_note", args: { action: "add", title: "Scan plan", text: "Try the deep scan." } } },
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

  it("starts quietly: the status line counts notes and nothing asks for a scan", async () => {
    await pi.waitFor(/🕸️\s+0 notes/, { label: "note-count status line" });
    const screen = pi.screen();
    expect(screen).not.toMatch(/unindexed|knowledge index|stale|Run \/weave-scan/);
    expect(existsSync(join(sandbox.repo, ".okf"))).toBe(false);
  });

  it("the status line counts a note the agent just wrote", async () => {
    await pi.submit("please note: scan plan");
    await pi.waitFor("stub: done", { label: "agent turn to finish" });
    await pi.waitFor(/🕸️\s+1 note\b/, { label: "status line showing 1 note" });
  });

  it("bare /weave-scan summarizes files with the session model", async () => {
    await pi.submit("/weave-scan");
    await pi.waitFor("deep scan complete", { label: "deep scan result", timeoutMs: 30_000 });
    expect(pi.screen()).not.toContain("index refreshed");
    expect(model.requests.some(isDeepScanRequest)).toBe(true);

    const summaries = readdirSync(join(sandbox.repo, ".okf", "repository", "summaries"));
    expect(summaries).toEqual(expect.arrayContaining(["src--index.ts.summary.md"]));
    await pi.waitFor(new RegExp(`1 note · ${summaries.length} summar`), { label: "summaries on the status line" });
  });

  it("/weave reports the summaries instead of index freshness", async () => {
    await pi.submit("/weave");
    await pi.waitFor(/summaries: \d+ file\(s\) — run \/weave-scan to refresh/, { label: "dashboard summaries line" });
    expect(pi.screen()).not.toMatch(/index: (fresh|stale)/);
  });

  it("/weave-scan with an unknown mode prints usage", async () => {
    await pi.submit("/weave-scan shallow");
    await pi.waitFor("usage: /weave-scan [sessions [dir]]", { label: "usage line" });
  });

  it("the workspace shows the repository with its summary", async () => {
    await pi.submit("/weave-view --no-open");
    const screen = await pi.waitFor(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/, { label: "workspace URL" });
    workspaceUrl = screen.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)![0];

    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.goto(workspaceUrl);
    await page.getByText("Your knowledge, connected.").waitFor();
    await page.getByRole("button", { name: "Open graph view" }).click();
    await page.locator("canvas").first().waitFor();
    await page.getByRole("button", { name: "Search notes and repository" }).click();
    await page.keyboard.type("index.ts");
    await page.getByText("src/index.ts").first().waitFor();
  });

  it("quitting pi shuts the workspace down", async () => {
    await page.close();
    await pi.stop();
    await expect(fetch(workspaceUrl)).rejects.toThrow();
  });
});
