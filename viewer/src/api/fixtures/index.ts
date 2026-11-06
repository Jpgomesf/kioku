// Sample data shared by the mocks. Real keys and titles come from the personal vault
// (personal/kioku, local); everything in "demo" is invented. Mock modules import this
// lazily, so it stays out of the desktop bundle's main chunk.
import type { GraphData, GraphEdge, GraphNode } from "../graph/types";
import type { Area, Note, NoteKind, NoteSummary, Vault } from "../notes/types";

export const vaults: Vault[] = [
  {
    name: "personal",
    domains: ["personal/kioku", "local", "demo"],
    providers: ["anthropic", "local"],
  },
];

export const areas: Area[] = [
  {
    domain: "personal/kioku",
    label: "kioku",
    vault: "personal",
    noteCount: 4,
    legacyCount: 0,
    source: null,
  },
  {
    domain: "local",
    label: "local",
    vault: "personal",
    noteCount: 2,
    legacyCount: 0,
    source: null,
  },
  {
    domain: "demo",
    label: "demo",
    vault: "personal",
    noteCount: 303,
    legacyCount: 36,
    source: "demo-kb",
  },
];

function note(
  partial: Omit<Note, "aliases" | "revisions" | "revision" | "sourcePath"> &
    Partial<Pick<Note, "aliases" | "sourcePath">>,
): Note {
  return {
    aliases: [],
    sourcePath: partial.origin === "file" ? `${partial.domain}/${partial.key}.md` : null,
    ...partial,
    revision: 1,
    revisions: [
      { revision: 1, at: partial.updatedAt, summary: "Imported", origin: partial.origin },
    ],
  };
}

export const makeNote = note;

const link = (
  targetKey: string,
  targetDomain: string,
  relation = "related",
): Note["links"][number] => ({
  targetKey,
  targetDomain,
  targetTitle: null,
  relation,
  suggested: false,
});

export const sampleNotes: Note[] = [
  note({
    key: "memory-model-tiers",
    domain: "personal/kioku",
    title: "Memory reaches large and small models differently",
    body: "Claude models get no memory hooks and no background jobs: they search Kioku before work that depends on earlier decisions and save decisions as soon as they are confirmed. Small local models need memory pushed to them, as a context pack per prompt.",
    kind: "decision",
    status: "active",
    origin: "file",
    tags: ["memory", "decision", "clients"],
    links: [link("memory-stack", "personal/kioku"), link("memory-workflow", "personal/kioku")],
    updatedAt: "2026-11-06",
  }),
  note({
    key: "memory-stack",
    domain: "personal/kioku",
    title: "Kioku architecture and service ports",
    body: "Kioku keeps note text, links, provenance and an append-only revision history in PostgreSQL; Qdrant holds derived vectors. Search fuses BM25 and dense similarity with RRF, puts exact key, title and alias matches first, and fills trailing slots from explicit links with Personalized PageRank.",
    kind: "note",
    status: "active",
    origin: "file",
    tags: ["memory", "architecture", "docker"],
    links: [
      link("memory-model-tiers", "personal/kioku"),
      link("memory-workflow", "personal/kioku"),
    ],
    updatedAt: "2026-11-06",
  }),
  note({
    key: "memory-workflow",
    domain: "personal/kioku",
    title: "How Kioku notes are written, recalled, and aged",
    body: "Curated Markdown notes carry a stable key, domain, aliases, tags and explicit links. Recall with memory_search, then memory_get on the one or two relevant keys. Retention is a ranking prior; Kioku never hard-deletes.",
    kind: "convention",
    status: "active",
    origin: "file",
    tags: ["memory", "workflow", "retention"],
    links: [link("memory-model-tiers", "personal/kioku")],
    updatedAt: "2026-11-06",
  }),
  note({
    key: "kioku-viewer-design",
    domain: "personal/kioku",
    title: "Kioku Viewer design: canvas, design system and the user's UI rules",
    body: "No breadcrumbs. One area button opens a search-first picker. Services collapse to one status line. The graph is one semantic zoom. Visibility uses one switch per app, reviewed in plain language.",
    kind: "preference",
    status: "active",
    origin: "agent",
    tags: ["viewer", "design", "vaults"],
    links: [link("memory-stack", "personal/kioku"), link("memory-model-tiers", "personal/kioku")],
    updatedAt: "2026-11-06",
  }),
  note({
    key: "viewer-update-channel",
    domain: "personal/kioku",
    title: "Should the viewer ship a beta update channel?",
    body: "Draft. A beta channel would let early builds reach one Mac first. Not decided until signing keys exist.",
    kind: "question",
    status: "draft",
    origin: "agent",
    tags: ["viewer", "release"],
    links: [link("kioku-viewer-design", "personal/kioku")],
    updatedAt: "2026-11-05",
  }),
  note({
    key: "agent-skills-setup",
    domain: "local",
    title: "Where this machine's agent skills come from",
    body: "Skills are installed per tool from their own plugin sources; none are copied into repos.",
    kind: "note",
    status: "active",
    origin: "agent",
    tags: ["skills", "plugins"],
    links: [],
    updatedAt: "2026-11-06",
  }),
  note({
    key: "local-kilo",
    domain: "local",
    title: "Kilo uses the local Strata chat endpoint",
    body: "Kilo talks to a local chat endpoint; its configuration stays on this machine.",
    kind: "note",
    status: "active",
    origin: "file",
    tags: ["local-development", "kilo", "configuration"],
    links: [],
    updatedAt: "2026-11-06",
  }),
  note({
    key: "jobs-worker",
    domain: "demo",
    title: "Jobs worker owns background indexing",
    body: "The jobs worker picks up indexing work from the queue and replaces the batch worker.",
    kind: "decision",
    status: "active",
    origin: "file",
    tags: ["service", "indexing"],
    links: [link("batch-worker-retirement", "demo", "supersedes"), link("local-stack", "demo")],
    updatedAt: "2026-10-29",
  }),
  note({
    key: "batch-worker-retirement",
    domain: "demo",
    title: "Batch worker was retired",
    body: "The nightly batch worker was retired once the jobs worker covered its work.",
    kind: "item",
    status: "legacy",
    origin: "file",
    tags: ["historical", "migration"],
    links: [link("jobs-worker", "demo"), link("local-stack", "demo")],
    updatedAt: "2026-10-29",
  }),
  note({
    key: "local-stack",
    domain: "demo",
    title: "Local development services",
    body: "A database, a vector store and an embedding model run locally for development.",
    kind: "note",
    status: "active",
    origin: "file",
    tags: ["development", "architecture"],
    links: [link("jobs-worker", "demo"), link("batch-worker-retirement", "demo")],
    updatedAt: "2026-10-29",
  }),
];

/** Open Reflect findings per note key, shared by the notes and reflect mocks. */
/** Open findings per note, in step with the reflect mock's latest personal/kioku run. */
export const findingCounts: Record<string, number> = {
  "memory-workflow": 1,
  "memory-stack": 1,
  "memory-model-tiers": 1,
  "kioku-viewer-design": 2,
};

// Deterministic synthetic demo graph (about 300 notes) for the graph page.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Types are open text. Weighted so the demo has a few common types and a long tail, the way an
// imported knowledge base does; RARE places a few one-off types at fixed positions.
const KINDS: NoteKind[] = [
  ...Array<NoteKind>(6).fill("decision"),
  ...Array<NoteKind>(4).fill("document"),
  ...Array<NoteKind>(3).fill("question"),
  ...Array<NoteKind>(3).fill("issue"),
  ...Array<NoteKind>(2).fill("fix"),
  ...Array<NoteKind>(2).fill("note"),
  "convention",
  "meeting",
  "design-review",
  "runbook",
  "glossary",
  "release-notes",
];
const RARE: Readonly<Record<number, NoteKind>> = {
  7: "architecture",
  133: "person",
  211: "data-model",
};
const TOPICS = [
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

function buildDemoGraph(): GraphData {
  const rand = rng(42);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 300; i += 1) {
    const topic = TOPICS[i % TOPICS.length] ?? "misc";
    const picked = KINDS[Math.floor(rand() * KINDS.length)] ?? "note";
    const kind = RARE[i] ?? picked;
    nodes.push({
      key: `demo-${topic}-${String(i).padStart(3, "0")}`,
      domain: "demo",
      title: `${topic[0]?.toUpperCase() ?? ""}${topic.slice(1)} ${kind} ${i}`,
      kind,
      status: rand() < 0.12 ? "legacy" : "active",
      degree: 0,
    });
  }
  for (let i = 1; i < nodes.length; i += 1) {
    const sameTopic = i - TOPICS.length * (1 + Math.floor(rand() * 3));
    const targets = [sameTopic >= 0 ? sameTopic : i - 1];
    if (rand() < 0.35) targets.push(Math.floor(rand() * i));
    for (const t of targets) {
      const a = nodes[i];
      const b = nodes[t];
      if (!a || !b) continue;
      edges.push({ source: a.key, target: b.key, relation: "related", suggested: rand() < 0.08 });
      a.degree += 1;
      b.degree += 1;
    }
  }
  for (const n of sampleNotes.filter((s) => s.domain === "demo")) {
    nodes.push({
      key: n.key,
      domain: n.domain,
      title: n.title,
      kind: n.kind,
      status: n.status,
      degree: n.links.length,
    });
    for (const l of n.links)
      edges.push({ source: n.key, target: l.targetKey, relation: l.relation, suggested: false });
  }
  return { nodes, edges };
}

export const demoGraph: GraphData = buildDemoGraph();

export function summarize(n: Note): NoteSummary {
  return {
    key: n.key,
    domain: n.domain,
    title: n.title,
    kind: n.kind,
    status: n.status,
    origin: n.origin,
    tags: n.tags,
    linkCount: n.links.length,
    findingCount: findingCounts[n.key] ?? 0,
    source: null,
    updatedAt: n.updatedAt,
  };
}

/** Every note summary in an area, including the synthetic demo notes. */
export function summariesIn(domain: string): NoteSummary[] {
  const real = sampleNotes.filter((n) => n.domain === domain).map(summarize);
  if (domain !== "demo") return real;
  const synthetic = demoGraph.nodes
    .filter((n) => n.key.startsWith("demo-"))
    .map(
      (n): NoteSummary => ({
        key: n.key,
        domain: n.domain,
        title: n.title,
        kind: n.kind,
        status: n.status,
        origin: "file",
        tags: [],
        linkCount: n.degree,
        findingCount: 0,
        source: "demo-kb",
        updatedAt: "2026-10-29",
      }),
    );
  return [...real, ...synthetic];
}
