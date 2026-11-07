import { commandError } from "../core";
import {
  areas,
  demoGraph,
  LARGE_DOMAIN,
  largeGraph,
  makeNote,
  sampleNotes,
  summariesIn,
  vaults,
} from "../fixtures";
import {
  type Area,
  MAX_NOTE_LIST,
  type Note,
  type NoteQuery,
  type NoteSummary,
  type Vault,
} from "./types";

function titleOf(domain: string, key: string): string | null {
  const found =
    sampleNotes.find((n) => n.domain === domain && n.key === key) ??
    (domain === LARGE_DOMAIN ? largeGraph() : demoGraph).nodes.find(
      (n) => n.domain === domain && n.key === key,
    );
  return found?.title ?? null;
}

export const listVaults = (): Vault[] => vaults;
export const listAreas = (): Area[] => areas;

export function listNotes(q: NoteQuery): NoteSummary[] {
  const text = q.text?.trim().toLowerCase() ?? "";
  return summariesIn(q.domain)
    .filter((n) => !q.kinds || q.kinds.length === 0 || q.kinds.includes(n.kind))
    .filter((n) => !q.status || q.status === "all" || n.status === q.status)
    .filter((n) => !q.origin || n.origin === q.origin)
    .filter((n) => !q.since || n.updatedAt >= q.since)
    .filter(
      (n) =>
        !text ||
        n.title.toLowerCase().includes(text) ||
        n.key.includes(text) ||
        n.tags.some((t) => t.includes(text)),
    )
    .slice(0, Math.min(q.limit ?? MAX_NOTE_LIST, MAX_NOTE_LIST));
}

export function getNote(domain: string, key: string): Note {
  const found = sampleNotes.find((n) => n.domain === domain && n.key === key);
  if (found)
    return {
      ...found,
      links: found.links.map((l) => ({ ...l, targetTitle: titleOf(l.targetDomain, l.targetKey) })),
    };
  const graph = domain === LARGE_DOMAIN ? largeGraph() : demoGraph;
  const g = graph.nodes.find((n) => n.domain === domain && n.key === key);
  if (!g) throw commandError("not_found", `No note ${key} in ${domain}.`);
  const links = graph.edges
    .filter((e) => e.source === key || e.target === key)
    .map((e) => ({
      targetKey: e.source === key ? e.target : e.source,
      targetDomain: domain,
      targetTitle: titleOf(domain, e.source === key ? e.target : e.source),
      relation: e.relation,
      suggested: e.suggested,
    }));
  return makeNote({
    key,
    domain,
    title: g.title,
    body: `Demo note about ${g.title.toLowerCase()}.`,
    kind: g.kind,
    status: g.status,
    origin: "file",
    tags: ["demo"],
    links,
    updatedAt: "2026-10-29",
  });
}
