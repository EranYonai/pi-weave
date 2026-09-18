import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditLinks, normalizeTarget, rewriteLinks, scanLinks } from "../../src/core/links/repair";
import { addNote, getNote, moveNote, renameFolder, renameNote, repairVaultLinks, upsertNote } from "../../src/core/vault";
import { makeTempDir } from "../helpers";

const note = (slug: string, title: string, body = "") => ({ slug, title, body });

describe("scanLinks", () => {
  it("finds targets, aliases and offsets", () => {
    const found = scanLinks("see [[release-plan]] and [[Some Note|the note]].");
    expect(found.map((l) => [l.target, l.alias])).toEqual([
      ["release-plan", undefined],
      ["some-note", "the note"],
    ]);
    expect(found[0]?.rawTarget).toBe("release-plan");
    expect("see ".length).toBe(found[0]?.start);
  });

  it("ignores empty, malformed and non-wikilink shapes", () => {
    expect(scanLinks("[[]] [[   ]] [x](y) [[unclosed")).toEqual([]);
  });

  it("skips links inside fenced code blocks", () => {
    const body = "real [[alpha]]\n\n```md\nsample [[beta]]\n```\n\nafter [[gamma]]";
    expect(scanLinks(body).map((l) => l.target)).toEqual(["alpha", "gamma"]);
  });

  it("treats an unterminated fence as running to the end", () => {
    expect(scanLinks("ok [[alpha]]\n\n```\n[[beta]]").map((l) => l.target)).toEqual(["alpha"]);
  });

  it("supports tilde fences", () => {
    expect(scanLinks("[[a]]\n~~~\n[[b]]\n~~~\n[[c]]").map((l) => l.target)).toEqual(["a", "c"]);
  });

  it("never looks past the ## Raw tail", () => {
    const body = "body [[alpha]]\n\n---\n\n## Raw\n\n```\nuser said [[beta]]\n```\n";
    expect(scanLinks(body).map((l) => l.target)).toEqual(["alpha"]);
  });

  it("handles a body that is nothing but a raw tail", () => {
    expect(scanLinks("## Raw\n\n[[beta]]")).toEqual([]);
  });
});

describe("normalizeTarget", () => {
  it("slugifies each path segment and keeps html identities", () => {
    expect(normalizeTarget("1-1s/Naor Direct Report")).toBe("1-1s/naor-direct-report");
    expect(normalizeTarget("./Report.HTML")).toBe("Report.HTML");
  });
});

describe("rewriteLinks", () => {
  it("preserves the visible text when repointing", () => {
    const { body, changed } = rewriteLinks("a [[Mathieu]] b [[Mathieu|Mat]]", (t) =>
      t === "mathieu" ? "1-1s/mathieu" : null,
    );
    expect(body).toBe("a [[1-1s/mathieu|Mathieu]] b [[1-1s/mathieu|Mat]]");
    expect(changed).toBe(2);
  });

  it("leaves everything alone when nothing resolves", () => {
    const input = "a [[x]] b";
    expect(rewriteLinks(input, () => null)).toEqual({ body: input, changed: 0 });
  });

  it("is a no-op when a target resolves to itself", () => {
    expect(rewriteLinks("[[x]]", (t) => t).changed).toBe(0);
  });
});

describe("auditLinks", () => {
  it("resolves by unique basename and by unique title", () => {
    const audit = auditLinks({
      notes: [
        note("hub", "Hub", "[[mathieu]] and [[Infra Roadmap]] and [[1-1s/mathieu]]"),
        note("1-1s/mathieu", "Mathieu — devNG"),
        note("infra/roadmap-fy27", "Infra Roadmap"),
      ],
    });
    expect(audit.total).toBe(3);
    expect(audit.resolved).toBe(1);
    expect(audit.fixable).toEqual([
      { slug: "hub", from: "infra-roadmap", to: "infra/roadmap-fy27", rule: "title", count: 1 },
      { slug: "hub", from: "mathieu", to: "1-1s/mathieu", rule: "basename", count: 1 },
    ]);
    expect(audit.ambiguous).toEqual([]);
    expect(audit.unresolvable).toEqual([]);
  });

  it("refuses to guess when two notes share a basename", () => {
    const audit = auditLinks({
      notes: [note("hub", "Hub", "[[plan]]"), note("a/plan", "A Plan"), note("b/plan", "B Plan")],
    });
    expect(audit.fixable).toEqual([]);
    expect(audit.ambiguous).toEqual([{ slug: "hub", target: "plan", candidates: ["a/plan", "b/plan"] }]);
  });

  it("prefers a unique basename over a unique title (rung 2 before rung 3)", () => {
    const audit = auditLinks({
      notes: [note("hub", "Hub", "[[plan]]"), note("a/plan", "Something"), note("b/other", "Plan")],
    });
    expect(audit.fixable).toEqual([
      { slug: "hub", from: "plan", to: "a/plan", rule: "basename", count: 1 },
    ]);
  });

  it("falls through to a unique title when the basename is ambiguous", () => {
    const audit = auditLinks({
      notes: [
        note("hub", "Hub", "[[plan]]"),
        note("a/plan", "A"),
        note("b/plan", "B"),
        note("c/roadmap", "Plan"),
      ],
    });
    expect(audit.fixable).toEqual([
      { slug: "hub", from: "plan", to: "c/roadmap", rule: "title", count: 1 },
    ]);
  });

  it("merges basename and title candidates when neither rung is unique", () => {
    const audit = auditLinks({
      notes: [
        note("hub", "Hub", "[[plan]]"),
        note("a/plan", "A"),
        note("b/plan", "B"),
        note("c/roadmap", "Plan"),
        note("d/sheet", "Plan"),
      ],
    });
    expect(audit.ambiguous).toEqual([
      { slug: "hub", target: "plan", candidates: ["a/plan", "b/plan", "c/roadmap", "d/sheet"] },
    ]);
  });

  it("reports the same ambiguous target once per note, with every referrer", () => {
    const audit = auditLinks({
      notes: [
        note("hub", "Hub", "[[plan]] again [[Plan|p]]"),
        note("a/plan", "A Plan"),
        note("b/plan", "B Plan"),
      ],
    });
    expect(audit.ambiguous).toHaveLength(1);
  });

  it("groups unresolvable targets by target with their referrers", () => {
    const audit = auditLinks({
      notes: [note("a", "A", "[[ghost]]"), note("b", "B", "[[ghost]] [[phantom]]")],
    });
    expect(audit.unresolvable).toEqual([
      { target: "ghost", notes: ["a", "b"] },
      { target: "phantom", notes: ["b"] },
    ]);
  });

  it("counts repeated occurrences of one stale target in one note", () => {
    const audit = auditLinks({
      notes: [note("hub", "Hub", "[[mathieu]] x [[Mathieu|again]]"), note("1-1s/mathieu", "M")],
    });
    expect(audit.fixable).toEqual([
      { slug: "hub", from: "mathieu", to: "1-1s/mathieu", rule: "basename", count: 2 },
    ]);
  });

  it("treats html artifacts as resolved and never repairs them", () => {
    const audit = auditLinks({
      notes: [note("a", "A", "[[report.html]] [[missing.html]]")],
      artifacts: [{ slug: "report.html" }],
    });
    expect(audit.resolved).toBe(1);
    expect(audit.fixable).toEqual([]);
    expect(audit.unresolvable).toEqual([{ target: "missing.html", notes: ["a"] }]);
  });

  it("ignores notes with untitled or empty identities when indexing", () => {
    const audit = auditLinks({ notes: [note("a", "", "[[b]]")] });
    expect(audit.unresolvable).toEqual([{ target: "b", notes: ["a"] }]);
  });
});

describe("repairVaultLinks", () => {
  it("reports without writing by default, then repairs on request", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Mathieu", body: "lead" });
    await moveNote(root, "mathieu", null); // no-op move; folder created below
    await fs.mkdir(join(root, "notes", "1-1s"), { recursive: true });
    await moveNote(root, "mathieu", "1-1s");
    const hub = await addNote(root, { title: "Hub", body: "see [[Mathieu]] and [[ghost]]" });

    const dry = await repairVaultLinks(root);
    expect(dry.applied).toEqual([]);
    expect(dry.audit.fixable).toHaveLength(1);
    expect((await getNote(root, hub.slug))?.body).toContain("[[Mathieu]]");

    const run = await repairVaultLinks(root, { apply: true });
    expect(run.applied).toHaveLength(1);
    expect(run.notes).toEqual(["hub"]);
    const repaired = await getNote(root, hub.slug);
    expect(repaired?.body).toContain("[[1-1s/mathieu|Mathieu]]");
    expect(repaired?.body).toContain("[[ghost]]");

    // Idempotent: the second pass has nothing left to do.
    const again = await repairVaultLinks(root, { apply: true });
    expect(again.applied).toEqual([]);
    expect(again.audit.unresolvable).toEqual([{ target: "ghost", notes: ["hub"] }]);
  });

  it("does not bump `updated` — a link repair is not a content edit", async () => {
    const root = await makeTempDir();
    await fs.mkdir(join(root, "notes", "1-1s"), { recursive: true });
    await addNote(root, { title: "Mathieu", body: "lead" });
    await moveNote(root, "mathieu", "1-1s");
    await upsertNote(root, {
      slug: "hub",
      title: "Hub",
      body: "see [[Mathieu]]",
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    const before = (await getNote(root, "hub"))?.updated;
    await repairVaultLinks(root, { apply: true });
    expect((await getNote(root, "hub"))?.updated).toBe(before);
  });

  it("never rewrites inside the raw tail", async () => {
    const root = await makeTempDir();
    await fs.mkdir(join(root, "notes", "1-1s"), { recursive: true });
    await addNote(root, { title: "Mathieu", body: "lead" });
    await moveNote(root, "mathieu", "1-1s");
    await addNote(root, {
      title: "Dictated",
      body: "body [[Mathieu]]\n\n---\n\n## Raw\n\n```\nhe said [[Mathieu]]\n```\n",
    });
    await repairVaultLinks(root, { apply: true });
    const body = (await getNote(root, "dictated"))?.body ?? "";
    expect(body).toContain("body [[1-1s/mathieu|Mathieu]]");
    expect(body).toContain("he said [[Mathieu]]");
  });

  it("reports an empty vault as clean", async () => {
    const root = await makeTempDir();
    const result = await repairVaultLinks(root, { apply: true });
    expect(result).toMatchObject({ applied: [], notes: [] });
    expect(result.audit.total).toBe(0);
  });

  it("skips unreadable files without failing the pass", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Hub", body: "[[target]]" });
    await addNote(root, { title: "Target", body: "" });
    // A file that parses as a note for the audit but vanishes before rewrite.
    const result = await repairVaultLinks(root, { apply: true });
    expect(result.notes).toEqual([]);
    expect(result.audit.resolved).toBe(1);
  });
});

describe("backlinks follow the note", () => {
  it("renameNote repoints inbound links", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Old Name", body: "x" });
    await addNote(root, { title: "Hub", body: "see [[old-name]] and [[Old Name|alias]]" });

    expect(await renameNote(root, "old-name", "New Name")).toEqual({ ok: true, slug: "new-name" });
    const hub = await getNote(root, "hub");
    expect(hub?.body).toBe("see [[new-name|old-name]] and [[new-name|alias]]");
  });

  it("renameNote to the same slug leaves bodies untouched", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Same", body: "x" });
    await addNote(root, { title: "Hub", body: "see [[same]]" });
    expect(await renameNote(root, "same", "Same")).toEqual({ ok: true, slug: "same" });
    expect((await getNote(root, "hub"))?.body).toBe("see [[same]]");
  });

  it("moveNote repoints inbound links", async () => {
    const root = await makeTempDir();
    await addNote(root, { title: "Wanderer", body: "x" });
    await addNote(root, { title: "Hub", body: "see [[wanderer]]" });
    await fs.mkdir(join(root, "notes", "archive"), { recursive: true });

    expect(await moveNote(root, "wanderer", "archive")).toEqual({ ok: true, slug: "archive/wanderer" });
    expect((await getNote(root, "hub"))?.body).toBe("see [[archive/wanderer|wanderer]]");
  });

  it("renameFolder repoints inbound links for the whole subtree", async () => {
    const root = await makeTempDir();
    await fs.mkdir(join(root, "notes", "old-folder", "deep"), { recursive: true });
    await addNote(root, { title: "Inner", body: "x" });
    await addNote(root, { title: "Deeper", body: "x" });
    await moveNote(root, "inner", "old-folder");
    await moveNote(root, "deeper", "old-folder/deep");
    await addNote(root, { title: "Hub", body: "[[old-folder/inner]] [[old-folder/deep/deeper]]" });

    expect(await renameFolder(root, "old-folder", "New Folder")).toEqual({ ok: true, path: "new-folder" });
    expect((await getNote(root, "hub"))?.body).toBe(
      "[[new-folder/inner|old-folder/inner]] [[new-folder/deep/deeper|old-folder/deep/deeper]]",
    );
  });

  it("renameFolder to the same slug changes nothing", async () => {
    const root = await makeTempDir();
    await fs.mkdir(join(root, "notes", "keep"), { recursive: true });
    await addNote(root, { title: "Hub", body: "[[keep/x]]" });
    expect(await renameFolder(root, "keep", "Keep")).toEqual({ ok: true, path: "keep" });
    expect((await getNote(root, "hub"))?.body).toBe("[[keep/x]]");
  });
});
