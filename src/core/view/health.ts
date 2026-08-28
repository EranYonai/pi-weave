/**
 * healthModel — staleness + link health, derived exclusively from the
 * GraphModel (weave-view-tui-design §5.4 / weave-workspace §3).
 *
 * Zero new server/core fields: everything here is a projection of nodes,
 * edges, and `model.staleness`.
 */

import type { GraphModel, GraphNode } from "../graph/model";
import { deriveBacklinks } from "./links";
import { listLabel } from "./tree";
import type { SelectableRow } from "./types";

export interface HealthRow extends SelectableRow {
  text: string;
}

export interface HealthSection {
  heading: string;
  rows: HealthRow[];
}

export interface HealthModel {
  sections: HealthSection[];
}

const HEALTH_LIST_CAP = 10;

export function healthModel(model: GraphModel): HealthModel {
  const byId = new Map<string, GraphNode>();
  for (const n of model.nodes) byId.set(n.id, n);
  const sections: HealthSection[] = [];

  // Repository section
  const repo = byId.get("repository");
  if (repo) {
    const rows: HealthRow[] = [];
    const staleness = model.staleness;
    if (staleness) {
      rows.push({ id: "health:repo:state", text: `state: ${staleness.state}` });
      for (let i = 0; i < staleness.reasons.length; i++) {
        rows.push({ id: `health:repo:reason:${i}`, text: `  ${staleness.reasons[i]}` });
      }
    }
    if (repo.detail.files) rows.push({ id: "health:repo:files", text: `files: ${repo.detail.files}` });
    if (repo.detail.languages) rows.push({ id: "health:repo:langs", text: `languages: ${repo.detail.languages}` });
    let summarized = 0;
    for (const n of model.nodes) {
      if (n.kind !== "module") continue;
      const count = n.detail["summarized files"];
      if (count) summarized += Number(count);
    }
    if (summarized > 0) {
      rows.push({ id: "health:repo:summarized", text: `summarized files: ${summarized} (run /weave-scan deep)` });
    }
    sections.push({ heading: "Repository", rows });
  }

  // Vault section
  const vault = byId.get("vault");
  if (vault) {
    const rows: HealthRow[] = [];
    const noteCount = Number(vault.detail.notes ?? "0");
    rows.push({ id: "health:vault:notes", text: `notes: ${noteCount}` });
    const prov = countProvenance(model.nodes);
    rows.push({
      id: "health:vault:provenance",
      text: `provenance: ● human ${prov.human} · ◐ agent ${prov.agent} · ○ generated ${prov.generated}`,
    });
    if (vault.detail.warning) {
      rows.push({ id: "health:vault:warning", text: vault.detail.warning });
    }
    sections.push({ heading: "Vault", rows });
  }

  // Link health
  const backlinks = deriveBacklinks(model.edges);
  const orphans: GraphNode[] = [];
  const dangling: { node: GraphNode; count: number }[] = [];
  for (const n of model.nodes) {
    if (n.kind !== "note") continue;
    if (!backlinks.has(n.id)) orphans.push(n);
    const dl = n.detail["dangling links"];
    if (dl && Number(dl) > 0) dangling.push({ node: n, count: Number(dl) });
  }
  const degree = new Map<string, number>();
  for (const e of model.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const hubs = [...model.nodes]
    .map((n) => ({ n, d: degree.get(n.id) ?? 0 }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d)
    .slice(0, HEALTH_LIST_CAP);

  const linkRows: HealthRow[] = [];
  if (orphans.length > 0) {
    linkRows.push({ id: "health:link:orphans-h", text: `orphans (${orphans.length}):` });
    const shown = orphans.slice(0, HEALTH_LIST_CAP);
    for (let i = 0; i < shown.length; i++) {
      linkRows.push({ id: `health:link:orphan:${shown[i]!.id}`, text: `  ${listLabel(shown[i]!)}`, target: shown[i]!.id });
    }
    if (orphans.length > HEALTH_LIST_CAP) {
      linkRows.push({ id: "health:link:orphan:more", text: `  … and ${orphans.length - HEALTH_LIST_CAP} more` });
    }
  } else {
    linkRows.push({ id: "health:link:orphans-h", text: "orphans: none" });
  }
  if (dangling.length > 0) {
    linkRows.push({ id: "health:link:dangling-h", text: `dangling links (${dangling.length}):` });
    const shown = dangling.slice(0, HEALTH_LIST_CAP);
    for (let i = 0; i < shown.length; i++) {
      linkRows.push({
        id: `health:link:dangling:${shown[i]!.node.id}`,
        text: `  ${listLabel(shown[i]!.node)} (${shown[i]!.count})`,
        target: shown[i]!.node.id,
      });
    }
    if (dangling.length > HEALTH_LIST_CAP) {
      linkRows.push({ id: "health:link:dangling:more", text: `  … and ${dangling.length - HEALTH_LIST_CAP} more` });
    }
  }
  if (hubs.length > 0) {
    linkRows.push({ id: "health:link:hubs-h", text: `top hubs (by degree):` });
    for (let i = 0; i < hubs.length; i++) {
      linkRows.push({
        id: `health:link:hub:${hubs[i]!.n.id}`,
        text: `  ${listLabel(hubs[i]!.n)} (${hubs[i]!.d})`,
        target: hubs[i]!.n.id,
      });
    }
  }
  sections.push({ heading: "Link health", rows: linkRows });

  return { sections };
}

export interface ProvenanceCounts {
  total: number;
  human: number;
  agent: number;
  generated: number;
  structural: number;
}

export function countProvenance(nodes: readonly GraphNode[]): ProvenanceCounts {
  const c: ProvenanceCounts = { total: nodes.length, human: 0, agent: 0, generated: 0, structural: 0 };
  for (const n of nodes) {
    if (n.provenance === "human") c.human++;
    else if (n.provenance === "agent") c.agent++;
    else if (n.provenance === "generated") c.generated++;
    else c.structural++;
  }
  return c;
}
