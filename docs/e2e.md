# End-to-end tests

`npm run e2e` opens real pi with this checkout's pi-weave loaded, types slash commands and prompts into it, opens `/weave-view` in headless
Chromium, clicks around, and quits. It takes a few seconds and needs no API key.

It is separate from `npm test` and the coverage gate. CI runs it as its own `e2e` job on every PR.

## Run it

```bash
npm ci
npx playwright-core install chromium   # once per machine; skip if a Playwright Chromium is already cached
npm run e2e
```

Needs `tmux` on the PATH (macOS: `brew install tmux`; Debian/Ubuntu: `apt-get install tmux`).

- **Evidence.** Every step writes pi's screen (`NN-step.txt`) and, once the browser is open, a screenshot (`NN-step.png`) to
  `e2e/.artifacts/<scenario>/`, pass or fail. CI uploads that folder as the `e2e-artifacts` artifact. Point it elsewhere with
  `PI_WEAVE_E2E_ARTIFACTS=/some/dir`.
- **Keep the sandbox.** `PI_WEAVE_E2E_KEEP=1 npm run e2e` leaves the temp `$HOME`, vault and demo repo on disk and prints the path.
- **Chromium.** `PI_WEAVE_E2E_CHROMIUM=/path/to/chromium` uses a specific binary. Playwright's usual `PLAYWRIGHT_BROWSERS_PATH` is honoured.
- **One file.** `npm run e2e -- e2e/baseline` runs one scenario.

## What a run does

Each scenario builds a sandbox (`e2e/harness/sandbox.ts`): a temp `$HOME` and pi agent dir, an empty vault (`PI_WEAVE_VAULT`) and a small
git repo with one commit. Pi starts in that repo inside a private tmux server and gets an environment built from scratch, so your real
`~/.pi`, `~/.okf`, API keys and tmux sessions are never touched.

The model is a stub (`e2e/harness/stubModel.ts`): a local HTTP server that speaks the OpenAI streaming protocol and answers from a list of
rules. A rule matches a request (usually on the newest user message) and replies with text or a tool call. After any tool result it says
`stub: done`, so a scripted turn always ends.

`e2e/baseline.e2e.ts` is the baseline journey:

1. pi starts and the pi-weave status line (`🕸️ …`) appears
2. `/weave` shows the dashboard
3. a prompt makes the stub agent call `weave_note add`; the note file lands in the vault
4. `/weave-view --no-open` prints the workspace URL and adds `web:PORT` to the status line
5. in Chromium: the workspace loads and lists the note, clicking it opens it, the graph view opens, search finds it, Settings opens
6. quitting pi (Ctrl+D) shuts the workspace server down

Steps share one pi session and run in order; after the first failure the rest are skipped so the report shows the real cause.

## Testing your branch with it

When you change something a person would see in pi or the workspace, prove it end to end on your branch:

1. `npm run e2e` first, to confirm the baseline still passes with your change.
2. Add your own steps. Small additions to the baseline journey go in `e2e/baseline.e2e.ts`; a feature with its own flow gets a new
   `e2e/<feature>.e2e.ts` that copies the baseline's `beforeAll`/`afterAll` setup.
3. Run it again and look at the screenshots in `e2e/.artifacts/` yourself. Attach the useful ones to the PR.

The building blocks:

```ts
// pi, in the terminal (e2e/harness/piSession.ts)
await pi.submit("/weave-scan");                 // type a line + Enter
pi.press("q");                                  // keys: "Enter", "Escape", "C-c", "Tab", …
await pi.waitFor("index refreshed");            // screen incl. scrollback; string or RegExp
await pi.waitForGone("some panel text");        // visible screen only, e.g. a panel closed
pi.visible();                                   // what is on screen right now

// the model (e2e/harness/stubModel.ts): scripted agent turns
startStubModel([
  {
    match: (req) => lastMessageText(req).includes("please append"),
    reply: { tool: { name: "weave_note", args: { action: "append", slug: "launch-checklist", text: "more" } } },
  },
]);
model.requests;                                 // every request pi sent, e.g. to check which tools it offered

// the browser workspace: plain Playwright on the URL from /weave-view --no-open
await page.getByRole("button", { name: "Open graph view" }).click();
```

Tips:

- Wait for text, never sleep. `waitFor` searches scrollback, so wait for something unique to the step you just took.
- Prefer accessible names (`getByRole(..., { name })`, `aria-label`, `title`) over CSS classes in the browser; they survive restyling.
- Assert on disk too: the vault is plain Markdown at `sandbox.vault`.
- Don't add real network or a real model. If a feature needs the model to do something, add a stub rule.
