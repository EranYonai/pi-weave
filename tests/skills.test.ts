import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../skills");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

describe("packaged skills", () => {
  it("only link to files that exist", () => {
    const broken: string[] = [];
    for (const file of markdownFiles(skillsRoot)) {
      for (const [, target] of readFileSync(file, "utf8").matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (target === undefined || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(resolve(dirname(file), target))) broken.push(`${file} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("teach the notepad to flag conflicting decisions", () => {
    const skill = readFileSync(join(skillsRoot, "weave-notepad/SKILL.md"), "utf8");
    expect(skill).toContain("## Second thoughts");
    expect(skill).toContain("(superseded ");
  });
});
