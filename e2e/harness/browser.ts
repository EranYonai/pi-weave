import { chromium, type Browser } from "playwright-core";

/**
 * Headless Chromium for driving the /weave-view workspace.
 *
 * playwright-core never downloads a browser on install. It finds one in the
 * usual Playwright cache (or PLAYWRIGHT_BROWSERS_PATH); if there is none, run
 * `npx playwright-core install chromium` once. PI_WEAVE_E2E_CHROMIUM points at
 * a specific Chromium/Chrome binary instead.
 */
export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.PI_WEAVE_E2E_CHROMIUM;
  try {
    return await chromium.launch(executablePath ? { executablePath } : {});
  } catch (error) {
    throw new Error(
      `e2e: could not start Chromium (${(error as Error).message.split("\n")[0]}).\n` +
        "Install one with `npx playwright-core install chromium`, or set PI_WEAVE_E2E_CHROMIUM to a Chromium binary.",
    );
  }
}
