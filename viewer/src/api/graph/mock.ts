import { demoGraph, LARGE_DOMAIN, largeGraph, noteNode, sampleNotes } from "../fixtures";
import type { GraphData, GraphEdge, GraphNode, GraphQuery } from "./types";

/** Topic pages of the demo area; each synthetic key carries its topic (demo-<topic>-NNN). */
const DEMO_TOPICS = [
  "search",
  "indexing",
  "storage",
  "vaults",
  "imports",
  "ranking",
  "upkeep",
  "clients",
  "graph",
  "access",
];

function capitalise(word: string): string {
  return `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;
}

/**
 * The whole demo area with topic pages and a few tickets and pull requests added, so the
 * graph page has rings and squares to draw. Focused queries keep using the plain graph.
 */
function richDemo(): GraphData {
  const nodes: GraphNode[] = demoGraph.nodes.map((n) => ({ ...n }));
  const edges: GraphEdge[] = [...demoGraph.edges];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const bump = (key: string) => {
    const n = byKey.get(key);
    if (n) n.degree += 1;
  };
  for (const topic of DEMO_TOPICS) {
    const key = `topic-${topic}`;
    const members = demoGraph.nodes.filter((n) => n.key.startsWith(`demo-${topic}-`));
    const node: GraphNode = {
      key,
      domain: "demo",
      title: capitalise(topic),
      kind: "topic",
      status: "active",
      degree: 0,
      tags: [topic],
      updatedAt: "2026-06-01T09:00:00Z",
    };
    nodes.push(node);
    byKey.set(key, node);
    for (const m of members.filter((_, i) => i % 3 === 0)) {
      edges.push({ source: m.key, target: key, relation: "in topic", suggested: false });
      bump(m.key);
      bump(key);
    }
  }
  // Key, type, title, links, tags, last update: the work items arrive late in the area's story.
  const work: Array<[string, GraphNode["kind"], string, string[], string[], string]> = [
    [
      "T-101",
      "ticket",
      "Move indexing onto the jobs worker",
      ["jobs-worker", "demo-indexing-001"],
      ["ops"],
      "2026-10-20T10:00:00Z",
    ],
    [
      "T-102",
      "ticket",
      "Show retired notes dimmed in search",
      ["demo-search-010", "demo-search-020"],
      ["search"],
      "2026-10-22T10:00:00Z",
    ],
    [
      "PR-17",
      "pull-request",
      "feat: queue indexing jobs",
      ["T-101", "jobs-worker"],
      ["ops", "release"],
      "2026-10-28T10:00:00Z",
    ],
    [
      "PR-18",
      "pull-request",
      "fix: keep legacy notes out of ranking",
      ["T-102", "demo-ranking-005"],
      ["search", "release"],
      "2026-11-02T10:00:00Z",
    ],
  ];
  for (const [key, kind, title, links, tags, updatedAt] of work) {
    const node: GraphNode = {
      key,
      domain: "demo",
      title,
      kind,
      status: "active",
      degree: 0,
      tags,
      updatedAt,
    };
    nodes.push(node);
    byKey.set(key, node);
    for (const target of links) {
      if (!byKey.has(target)) continue;
      edges.push({
        source: key,
        target,
        relation: kind === "ticket" ? "tracks" : "implements",
        suggested: false,
      });
      bump(key);
      bump(target);
    }
  }
  return { nodes, edges };
}

function graphFor(domain: string): GraphData {
  if (domain === "demo") return demoGraph;
  if (domain === LARGE_DOMAIN) return largeGraph();
  const notes = sampleNotes.filter((n) => n.domain === domain);
  return {
    nodes: notes.map(noteNode),
    edges: notes.flatMap((n) =>
      n.links.map((l) => ({
        source: n.key,
        target: l.targetKey,
        relation: l.relation,
        suggested: l.suggested,
      })),
    ),
  };
}

/** The notes within `depth` hops of `focus`, expanding one frozen frontier per hop. */
export function neighbourhood(data: GraphData, focus: string, depth: number): GraphData {
  const keep = new Set([focus]);
  let frontier = new Set([focus]);
  for (let d = 0; d < depth && frontier.size > 0; d += 1) {
    const next = new Set<string>();
    for (const e of data.edges) {
      if (frontier.has(e.source) && !keep.has(e.target)) next.add(e.target);
      if (frontier.has(e.target) && !keep.has(e.source)) next.add(e.source);
    }
    for (const k of next) keep.add(k);
    frontier = next;
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.key)),
    edges: data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

let richCache: GraphData | null = null;

export function getGraph(q: GraphQuery): GraphData {
  if (q.focus) return neighbourhood(graphFor(q.domain), q.focus, q.depth ?? 1);
  if (q.domain === "demo") {
    richCache ??= richDemo();
    return richCache;
  }
  return graphFor(q.domain);
}
