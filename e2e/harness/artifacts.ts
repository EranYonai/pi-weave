import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { REPO_ROOT } from "./piSession";

/**
 * Where a run leaves its evidence: browser screenshots and pi screen dumps,
 * named by step. Defaults to e2e/.artifacts/<scenario>/ (gitignored); override
 * with PI_WEAVE_E2E_ARTIFACTS. Handy for attaching to a PR or reading after a
 * failure. Each run starts the scenario's folder fresh.
 */
export function artifactDir(scenario: string): string {
  const base = process.env.PI_WEAVE_E2E_ARTIFACTS
    ? resolve(process.env.PI_WEAVE_E2E_ARTIFACTS)
    : join(REPO_ROOT, "e2e", ".artifacts");
  const dir = join(base, scenario);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function snapPage(dir: string, name: string, page: Page): Promise<void> {
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

export function snapText(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, `${name}.txt`), text);
}
