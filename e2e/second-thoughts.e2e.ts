import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { artifactDir, snapPage, snapText } from "./harness/artifacts";
import { launchBrowser } from "./harness/browser";
import { PiSession } from "./harness/piSession";
import { createSandbox, type Sandbox } from "./harness/sandbox";
import { lastIsToolResult, lastMessageText, startStubModel, type StubModel, type StubRequest } from "./harness/stubModel";

/**
 * Second thoughts (skills/weave-notepad, "Second thoughts"): the user states a
 * decision that contradicts an earlier one of theirs. The agent saves it
 * first, asks once, and on "replace" strikes the old decision through
 * instead of deleting it. The raw tail is never touched.
 *
 * The model is scripted, so this proves the skill ships to pi and that the
 * tools and workspace carry the flow it describes, not the model's judgment.
 */

const OLD_DECISION = "2026-09-03: OIDC next quarter, JWT compatibility window";
const NEW_WORDS = "We're going with SAML.";
const QUESTION = 'On Sep 3 you decided "OIDC next quarter, JWT compatibility window" (auth-migration). Should SAML replace it?';
const FINAL_BODY = [
  "**TLDR:** Auth moves to SAML. The Sep 3 OIDC plan is superseded.",
  "",
  "## Decisions",
  "",
  `- ~~${OLD_DECISION}~~ (superseded 2026-10-11)`,
  "- 2026-10-11: Go with SAML.",
].join("\n");

/** Tool results already in this turn, newest last. */
function toolResults(req: StubRequest): string[] {
  const lastUser = req.messages.map((m) => m.role).lastIndexOf("user");
  return req.messages
    .slice(lastUser + 1)
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

function lastUserText(req: StubRequest): string {
  const lastUser = req.messages.map((m) => m.role).lastIndexOf("user");
  return lastMessageText({ messages: req.messages.slice(0, lastUser + 1) });
}

describe("second thoughts: a conflicting decision is flagged and superseded", () => {
  let model: StubModel;
  let sandbox: Sandbox;
  let pi: PiSession;
  let browser: Browser;
  let page: Page;
  let workspaceUrl = "";
  let rawAfterCapture = "";
  let step = 0;
  const artifacts = artifactDir("second-thoughts");

  beforeAll(async () => {
    model = await startStubModel([
      {
        match: (req) => lastMessageText(req).includes("remember the auth decision"),
        reply: {
          tool: {
            name: "weave_note",
            args: { action: "add", title: "Auth migration", source: "human", text: `## Decisions\n\n- ${OLD_DECISION}` },
          },
        },
      },
      // "we're going with SAML": search, append raw, then ask once.
      {
        match: (req) => lastMessageText(req).includes(NEW_WORDS),
        reply: { tool: { name: "weave_note", args: { action: "search", query: "auth" } } },
      },
      {
        match: (req) => lastIsToolResult(req) && lastUserText(req).includes(NEW_WORDS) && toolResults(req).length === 1,
        reply: { tool: { name: "weave_note", args: { action: "append", slug: "auth-migration", raw: true, text: NEW_WORDS } } },
      },
      {
        match: (req) => lastIsToolResult(req) && lastUserText(req).includes(NEW_WORDS),
        reply: { text: `Added. ${QUESTION}` },
      },
      // "Replace it.": finalize with the old decision struck through.
      {
        match: (req) => lastMessageText(req).includes("Replace it."),
        reply: { tool: { name: "weave_note", args: { action: "finalize", slug: "auth-migration", text: FINAL_BODY } } },
      },
    ]);
    sandbox = createSandbox({ modelBaseUrl: model.baseUrl });
    pi = new PiSession(sandbox);
    // The baseline runs pi with --no-skills; load this checkout's skills the way the package does.
    pi.start({ extraArgs: ["--skill", resolve(import.meta.dirname, "..", "skills")] });
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

  it("starts pi with the second-thoughts skill available", async () => {
    await pi.waitFor("🕸️", { label: "pi-weave status line" });
    await pi.submit("remember the auth decision");
    await pi.waitFor("stub: done", { label: "agent turn to finish" });

    const system = JSON.stringify(model.requests[0]?.messages[0]?.content ?? "");
    const skillPath = system.match(/\/[^"\s\\<>]*skills\/weave-notepad\/SKILL\.md/)?.[0];
    expect(skillPath, "pi offers the weave-notepad skill").toBeDefined();
    expect(readFileSync(skillPath!, "utf8")).toContain("## Second thoughts");
  });

  it("the earlier decision is saved as a human note", () => {
    const note = readNote(sandbox.vault);
    expect(note).toContain("source: human");
    expect(note).toContain(`- ${OLD_DECISION}`);
  });

  it("a conflicting decision is captured first, then questioned once", async () => {
    await pi.submit(NEW_WORDS);
    await pi.waitFor("Should SAML replace it?", { label: "the one question" });

    const note = readNote(sandbox.vault);
    expect(note).toContain("## Raw");
    expect(note).toContain(NEW_WORDS);
    expect(note).toContain(`- ${OLD_DECISION}`);
    expect(note).not.toContain("~~");
    rawAfterCapture = note.slice(note.indexOf("## Raw"));
  });

  it("'replace it' strikes the old decision through and keeps Raw intact", async () => {
    await pi.submit("Replace it.");
    await pi.waitFor("Finalized auth-migration", { label: "finalize to finish" });

    const note = readNote(sandbox.vault);
    expect(note).toContain(`~~${OLD_DECISION}~~ (superseded 2026-10-11)`);
    expect(note).toContain("- 2026-10-11: Go with SAML.");
    expect(note.slice(note.indexOf("## Raw"))).toBe(rawAfterCapture);
  });

  it("the workspace shows the superseded decision struck through", async () => {
    await pi.submit("/weave-view --no-open");
    const screen = await pi.waitFor(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/, { label: "workspace URL" });
    workspaceUrl = screen.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/)![0];

    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(10_000);
    await page.goto(workspaceUrl);
    await page.getByText("Auth migration").first().click();
    await page.locator("del, s").filter({ hasText: "OIDC next quarter" }).first().waitFor();
    await page.getByText("Go with SAML").first().waitFor();
    // Superseding in place must not make the note link to itself.
    expect(await page.getByRole("link", { name: "auth-migration" }).count()).toBe(0);
  });
});

function readNote(vault: string): string {
  const path = readdirSync(vault, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => join(d.parentPath, d.name))
    .find((p) => readFileSync(p, "utf8").includes("Auth migration"));
  expect(path, "auth-migration note in the vault").toBeDefined();
  return readFileSync(path!, "utf8");
}
