/**
 * Pure graph builder: knowledge workspace inputs → GraphModel.
 *
 * No I/O, no clock access, no harness imports (design §21,
 * docs/weave-view.md §3). Stability contract: identical inputs produce
 * byte-identical JSON (ids derive from slugs/paths only; `generatedAt` is
 * derived from input timestamps, never from the wall clock) — that is what
 * makes the page's refresh-polling cheap.
 */

import type { Note, RepoIndex, StalenessReport, VaultStatus } from "../types";
import { createHash } from "node:crypto";
import type { SummaryRecord } from "../summaries";
import type { EdgeKind, GraphEdge, GraphModel, GraphNode } from "./model";
import { buildPathIndex, resolveMentions, type PathIndex } from "./mentions";
import { extractWikilinks } from "./wikilinks";

/** Hard cap on note nodes (docs/weave-view.md M3 guard). */
export const DEFAULT_MAX_NOTES = 500;

export interface BuildGraphInput {
  vault: VaultStatus;
  /** Full notes including bodies (for wiki-link extraction). */
  notes: Note[];
  /** Repository half; null when cwd is not an indexed git repository. */
  repository: { index: RepoIndex; staleness: StalenessReport } | null;
  /** Deep-scan summaries keyed by repo-relative path (docs/scan-modes.md). */
  summaries?: ReadonlyMap<string, SummaryRecord>;
}

const SHORT_SHA_LEN = 7;
const PREVIEW_LEN = 240;

/** Hex length of {@link noteBodyDigest} and of the model's `contentDigest`. */
const DIGEST_HEX_LEN = 32;

/**
 * Content fingerprint of one note body. Pure, deterministic, truncated to
 * 128 bits — a change-detection key, not a security boundary.
 */
export function noteBodyDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, DIGEST_HEX_LEN);
}

/**
 * The model's `contentDigest`: one hash over every note's slug and body
 * digest, slug-sorted so it does not depend on note order. Empty when there
 * are no notes — which is still a distinct value from any non-empty vault.
 */
export function noteContentDigest(notes: readonly Note[]): string {
  const hash = createHash("sha256");
  for (const note of [...notes].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    hash.update(`${note.slug}\u0000${noteBodyDigest(note.body)}\n`);
  }
  return hash.digest("hex").slice(0, DIGEST_HEX_LEN);
}

function moduleDetail(
  path: string,
  fileCount: number,
  summaries: ReadonlyMap<string, SummaryRecord> | undefined,
): Record<string, string> {
  const detail: Record<string, string> = { path, files: String(fileCount) };
  if (summaries) {
    const prefix = path === "." ? "" : `${path}/`;
    let count = 0;
    for (const target of summaries.keys()) {
      if (target.startsWith(prefix)) count += 1;
    }
    if (count > 0) detail["summarized files"] = String(count);
  }
  return detail;
}

function preview(body: string): string {
  const flat = body.trim().replace(/\s+/g, " ");
  return flat.length > PREVIEW_LEN ? `${flat.slice(0, PREVIEW_LEN)}…` : flat;
}

/** Data-as-of marker: newest timestamp present in the inputs (ISO strings compare lexicographically). */
export function dataTimestamp(input: BuildGraphInput): string {
  let max = "";
  for (const note of input.notes) {
    if (note.updated > max) max = note.updated;
  }
  const repoStamp = input.repository?.index.updated ?? "";
  if (repoStamp > max) max = repoStamp;
  if (input.summaries) {
    for (const rec of input.summaries.values()) {
      if (rec.at > max) max = rec.at;
    }
  }
  return max;
}

/**
 * Parse a remote into display label + canonical url. Core `remotes()` emits
 * bare deduped URLs, but hand-written fixtures (or future sources) may use
 * "name url"; both are accepted. Bare URLs get their label from the last
 * path segment (works for scp-style `git@host:org/repo.git` too).
 */
function parseRemote(raw: string): { label: string; url: string } {
  const s = raw.trim();
  const named = /^\s*(\S+)\s+(\S.*)$/.exec(s);
  if (named && named[1] !== undefined && named[2] !== undefined && !named[1].includes("://") && !named[1].includes("@")) {
    return { label: named[1], url: named[2].trim() };
  }
  const noTrail = s.replace(/\/+$/, "");
  const afterColon = noTrail.split(":").pop() ?? noTrail;
  const tail = afterColon.split("/").pop() ?? afterColon;
  return { label: tail.replace(/\.git$/, ""), url: s };
}

function buildVaultSide(
  input: BuildGraphInput,
  maxNotes: number,
  nodes: GraphNode[],
  edges: GraphEdge[],
  danglingLinks: Record<string, string[]>,
  paths: PathIndex,
): string[] {
  const truncated = input.notes.length > maxNotes;
  const kept = input.notes.slice(0, maxNotes);

  const vaultDetail: Record<string, string> = {
    root: input.vault.root,
    notes: String(input.vault.noteCount),
  };
  if (truncated) {
    vaultDetail.warning = `Graph shows the ${maxNotes} most recent notes — the vault holds ${input.vault.noteCount}. Wiki-links to older notes are omitted.`;
  }
  nodes.push({ id: "vault", kind: "vault", label: "Vault", provenance: null, detail: vaultDetail });

  const keptSlugs = new Set(kept.map((n) => n.slug));
  for (const note of kept) {
    const links = extractWikilinks(note.body);
    const resolved = links.filter((slug) => keptSlugs.has(slug));
    const detail: Record<string, string> = {
      slug: note.slug,
      source: note.source,
      updated: note.updated,
    };
    if (note.tags.length > 0) detail.tags = note.tags.join(", ");
    // The names, not just the count (§4.2). `detail` keeps carrying the count
    // because it is what the TUI's side panel prints; the structured targets
    // go on the model, where a UI can turn them into ghost nodes.
    const dangling = links.filter((slug) => !keptSlugs.has(slug));
    if (dangling.length > 0) {
      detail["dangling links"] = String(dangling.length);
      danglingLinks[note.slug] = dangling;
    }
    detail.preview = preview(note.body);

    nodes.push({ id: `note:${note.slug}`, kind: "note", label: note.title, provenance: note.source, detail });
    edges.push({ source: "vault", target: `note:${note.slug}`, kind: "contains" });
    for (const target of resolved) {
      edges.push({ source: `note:${note.slug}`, target: `note:${target}`, kind: "links-to" });
    }
    // A note body naming a repo path → `mentions` (§4.4). Emitted after the
    // wiki-links so a note's edges read vault-ward first, then code-ward, and
    // only for paths that are already nodes — `paths` is built from the repo
    // index, so a mention of an unindexed file resolves to its enclosing
    // module or to nothing at all. Never to a phantom node.
    for (const target of resolveMentions(note.body, paths)) {
      edges.push({ source: `note:${note.slug}`, target, kind: "mentions" });
    }
  }
  return [...keptSlugs];
}

function buildRepositorySide(
  repository: NonNullable<BuildGraphInput["repository"]>,
  summaries: ReadonlyMap<string, SummaryRecord> | undefined,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const { index, staleness } = repository;
  const { identity, git, structure } = index;

  const repoDetail: Record<string, string> = {
    root: identity.root,
    files: String(structure.fileCount),
    state: staleness.state,
  };
  const languages = Object.entries(structure.languages)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
  if (languages.length > 0) repoDetail.languages = languages;
  if (staleness.reasons.length > 0) repoDetail.stale = staleness.reasons[0] ?? "";
  nodes.push({ id: "repository", kind: "repository", label: identity.name, provenance: null, detail: repoDetail });

  const branch = git.branch.length > 0 ? git.branch : "(detached)";
  nodes.push({
    id: "gitState",
    kind: "gitState",
    label: `${branch} @ ${git.headSha.slice(0, SHORT_SHA_LEN)}`,
    provenance: null,
    detail: {
      branch,
      commit: git.headSha,
      "uncommitted changes": String(git.changedFiles.length),
      captured: git.capturedAt,
    },
  });
  edges.push({ source: "repository", target: "gitState", kind: "anchored-at" });

  for (const remote of identity.remotes) {
    const { label, url } = parseRemote(remote);
    // Id keys off the URL (the actual identity — two names can collide).
    nodes.push({ id: `external:${url}`, kind: "external", label, provenance: null, detail: { url } });
    edges.push({ source: "repository", target: `external:${url}`, kind: "contains" });
  }

  for (const pkg of structure.packages) {
    nodes.push({
      id: `package:${pkg.manifestPath}`,
      kind: "package",
      label: pkg.name,
      provenance: null,
      detail: { manifest: pkg.manifestPath, kind: pkg.kind },
    });
    edges.push({ source: "repository", target: `package:${pkg.manifestPath}`, kind: "contains" });
  }

  for (const mod of structure.modules) {
    const label = mod.path === "(root)" ? "./ (root files)" : mod.path;
    nodes.push({
      id: `module:${mod.path}`,
      kind: "module",
      label,
      provenance: null,
      detail: moduleDetail(mod.path, mod.fileCount, summaries),
    });
    edges.push({ source: "repository", target: `module:${mod.path}`, kind: "contains" });
  }

  for (const entry of structure.entryPoints) {
    const detail: Record<string, string> = { path: entry };
    const sum = summaries?.get(entry);
    if (sum) {
      detail.summary = sum.summary;
      detail["summarized at"] = sum.at;
      if (sum.model !== null) detail["summarized by"] = sum.model;
    }
    nodes.push({ id: `entryPoint:${entry}`, kind: "entryPoint", label: entry, provenance: null, detail });
    edges.push({ source: "repository", target: `entryPoint:${entry}`, kind: "contains" });
  }

  // Render the derived .okf index as an expandable subtree under its module.
  // Files nest by directory: okf.json at the root, repository/*.json under a
  // "repository" folder, and summary files under a "summaries" folder so a
  // large summary set never explodes the tree. Ids are path-derived (stable).
  if (structure.okFiles && structure.okFiles.length > 0) {
    const okRoot = "module:.okf";
    const repoDir = "module:.okf/repository";
    const sumDir = "module:.okf/repository/summaries";
    const okChildren: string[] = [];
    const repoChildren: string[] = [];
    const sumChildren: string[] = [];
    for (const f of structure.okFiles) {
      const rel = f.replace(/^\.okf\//, "");
      const id = `okf:${rel}`;
      const label = rel.split("/").pop() ?? rel;
      nodes.push({ id, kind: "file", label, provenance: null, detail: { path: rel } });
      if (rel.startsWith("repository/summaries/")) sumChildren.push(id);
      else if (rel.startsWith("repository/")) repoChildren.push(id);
      else okChildren.push(id);
    }
    okChildren.forEach((c) => edges.push({ source: okRoot, target: c, kind: "contains" }));
    if (repoChildren.length > 0 || sumChildren.length > 0) {
      nodes.push({ id: repoDir, kind: "module", label: "repository", provenance: null, detail: { path: ".okf/repository" } });
      edges.push({ source: okRoot, target: repoDir, kind: "contains" });
      repoChildren.forEach((c) => edges.push({ source: repoDir, target: c, kind: "contains" }));
      if (sumChildren.length > 0) {
        nodes.push({ id: sumDir, kind: "module", label: "summaries", provenance: null, detail: { path: ".okf/repository/summaries" } });
        edges.push({ source: repoDir, target: sumDir, kind: "contains" });
        sumChildren.forEach((c) => edges.push({ source: sumDir, target: c, kind: "contains" }));
      }
    }
  }
}

/**
 * Build the graph model for the viewer. Notes are capped at `maxNotes`
 * (docs/weave-view.md M3); the vault node carries a warning when truncated.
 */
export function buildGraph(input: BuildGraphInput, options: { maxNotes?: number } = {}): GraphModel {
  const maxNotes = options.maxNotes ?? DEFAULT_MAX_NOTES;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const danglingLinks: Record<string, string[]> = {};
  // Built before the vault side, because that is where `mentions` edges are
  // emitted and they need to know which repo paths are real nodes. Derived
  // from the same `structure` arrays `buildRepositorySide` walks, so the two
  // cannot disagree about which ids exist. Empty when there is no repository:
  // a vault-only graph has nothing to mention.
  const paths = input.repository === null
    ? (new Map<string, string>() as PathIndex)
    : buildPathIndex(input.repository.index.structure);
  buildVaultSide(input, maxNotes, nodes, edges, danglingLinks, paths);
  if (input.repository !== null) {
    buildRepositorySide(input.repository, input.summaries, nodes, edges);
  }
  return {
    generatedAt: dataTimestamp(input),
    staleness: input.repository?.staleness ?? null,
    nodes,
    edges,
    danglingLinks,
    // The same slice the vault side kept, so the digest describes exactly
    // the notes that have nodes. Slug-ordered inside, hence order-stable.
    contentDigest: noteContentDigest(input.notes.slice(0, maxNotes)),
  };
}

export type { EdgeKind, GraphEdge, GraphModel, GraphNode, NodeKind } from "./model";
export { buildPathIndex, extractPathMentions, resolveMentions, type PathIndex } from "./mentions";
