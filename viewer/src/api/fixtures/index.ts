// Sample data shared by the mocks. Real keys and titles come from the personal vault
// (personal/kioku, local); everything in "demo" is invented. Mock modules import this
// lazily, so it stays out of the desktop bundle's main chunk.
import type { GraphData, GraphEdge, GraphNode } from "../graph/types";
import type { Area, Note, NoteKind, NoteSummary, Vault } from "../notes/types";

export const vaults: Vault[] = [
  {
    name: "personal",
    domains: ["personal/kioku", "local", "demo", "demo-large"],
    providers: ["anthropic", "local"],
  },
];

/** The large demo area: about 2,000 notes and 16,000 links, for the graph's performance probe. */
export const LARGE_DOMAIN = "demo-large";
const LARGE_NOTES = 2000;
/** Every LEGACY_EVERY-th large note is legacy, so the count is known without building it. */
const LEGACY_EVERY = 15;
const LARGE_LEGACY = Math.ceil(LARGE_NOTES / LEGACY_EVERY);

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
  {
    domain: LARGE_DOMAIN,
    label: "demo-large",
    vault: "personal",
    noteCount: LARGE_NOTES,
    legacyCount: LARGE_LEGACY,
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

// Generic tags and update dates for synthetic notes. They come from their own generator so the
// existing kinds, statuses and links stay exactly as they were.
const DEMO_TAGS = [
  "search",
  "storage",
  "api",
  "ops",
  "onboarding",
  "billing",
  "security",
  "release",
];
/** Synthetic notes' updates spread over the 180 days before this date, so Animate has a story. */
const LAST_UPDATE = Date.UTC(2026, 10, 5, 12);
const DAY_MS = 86_400_000;

/** One to three tags (one note in ten has none), led by a tag tied to the note's cluster. */
function syntheticTags(rand: () => number, cluster: number): string[] {
  if (rand() < 0.1) return [];
  const count = 1 + Math.floor(rand() * 3);
  const tags = new Set([DEMO_TAGS[cluster % DEMO_TAGS.length] ?? "ops"]);
  while (tags.size < count) tags.add(DEMO_TAGS[Math.floor(rand() * DEMO_TAGS.length)] ?? "ops");
  return [...tags];
}

/** An ISO 8601 UTC time, whole seconds, in the same format the backend sends. */
function syntheticUpdate(rand: () => number): string {
  const at = LAST_UPDATE - Math.floor(rand() * 180 * DAY_MS);
  return `${new Date(Math.floor(at / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** A real sample note's date as a full timestamp, so every graph node has one format. */
function noteUpdate(n: Note): string {
  return n.updatedAt.length === 10 ? `${n.updatedAt}T12:00:00Z` : n.updatedAt;
}

/** A sample note as a graph node, its degree counted from its own links. */
export function noteNode(n: Note): GraphNode {
  return {
    key: n.key,
    domain: n.domain,
    title: n.title,
    kind: n.kind,
    status: n.status,
    degree: n.links.length,
    tags: [...n.tags],
    updatedAt: noteUpdate(n),
  };
}

function buildDemoGraph(): GraphData {
  const rand = rng(42);
  const extra = rng(4242);
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
      tags: syntheticTags(extra, i % TOPICS.length),
      updatedAt: syntheticUpdate(extra),
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
    nodes.push(noteNode(n));
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
  if (domain === LARGE_DOMAIN) return largeGraph().nodes.map(syntheticSummary);
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
        tags: n.tags,
        linkCount: n.degree,
        findingCount: 0,
        source: "demo-kb",
        updatedAt: n.updatedAt,
      }),
    );
  return [...real, ...synthetic];
}

function syntheticSummary(n: GraphNode): NoteSummary {
  return {
    key: n.key,
    domain: n.domain,
    title: n.title,
    kind: n.kind,
    status: n.status,
    origin: "file",
    tags: n.tags,
    linkCount: n.degree,
    findingCount: 0,
    source: "demo-kb",
    updatedAt: n.updatedAt,
  };
}

// The large demo area. Clusters of notes that mostly link inside their cluster, a few hubs that
// hundreds of notes link to, and 25 types with a long tail (weights fall off like 1/rank).
const LARGE_CLUSTERS = [
  "search",
  "storage",
  "sync",
  "access",
  "billing",
  "reports",
  "exports",
  "alerts",
  "schedules",
  "forms",
  "media",
  "maps",
];
const LARGE_KINDS: NoteKind[] = [
  "decision",
  "document",
  "question",
  "issue",
  "fix",
  "note",
  "convention",
  "meeting",
  "runbook",
  "design-review",
  "glossary",
  "release-notes",
  "architecture",
  "gotcha",
  "preference",
  "ticket",
  "pull-request",
  "incident",
  "experiment",
  "checklist",
  "data-model",
  "benchmark",
  "interview",
  "roadmap",
  "retro",
];
const LARGE_HUBS = 4;
const LINKS_IN_CLUSTER = 7;

function weightedKind(rand: () => number): NoteKind {
  const weights = LARGE_KINDS.map((_, i) => 1 / (i + 1));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < LARGE_KINDS.length; i += 1) {
    r -= weights[i] ?? 0;
    if (r <= 0) return LARGE_KINDS[i] ?? "note";
  }
  return "note";
}

function buildLargeGraph(): GraphData {
  const rand = rng(7);
  const extra = rng(77);
  const nodes: GraphNode[] = [];
  for (let i = 0; i < LARGE_NOTES; i += 1) {
    const cluster = LARGE_CLUSTERS[i % LARGE_CLUSTERS.length] ?? "misc";
    const hub = i < LARGE_HUBS;
    const kind = hub ? "architecture" : weightedKind(rand);
    nodes.push({
      key: `large-${cluster}-${String(i).padStart(4, "0")}`,
      domain: LARGE_DOMAIN,
      title: hub
        ? `${capitalise(cluster)} overview`
        : `${capitalise(cluster)} ${kind.replace("-", " ")} ${i}`,
      kind,
      status: i % LEGACY_EVERY === LEGACY_EVERY - 1 ? "legacy" : "active",
      degree: 0,
      tags: syntheticTags(extra, i % LARGE_CLUSTERS.length),
      updatedAt: syntheticUpdate(extra),
    });
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, suggested = false) => {
    const from = nodes[a];
    const to = nodes[b];
    if (!from || !to || a === b) return;
    const id = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ source: from.key, target: to.key, relation: "related", suggested });
    from.degree += 1;
    to.degree += 1;
  };
  const clusters = LARGE_CLUSTERS.length;
  const perCluster = Math.floor(LARGE_NOTES / clusters);
  for (let i = LARGE_HUBS; i < LARGE_NOTES; i += 1) {
    const cluster = i % clusters;
    for (let k = 0; k < LINKS_IN_CLUSTER; k += 1) {
      add(i, cluster + clusters * Math.floor(rand() * perCluster), rand() < 0.03);
    }
    if (rand() < 0.75) add(i, Math.floor(rand() * LARGE_NOTES));
    // Each hub collects links from about 300 notes.
    if (rand() < 0.6) add(i, Math.floor(rand() * LARGE_HUBS));
  }
  return { nodes, edges };
}

function capitalise(word: string): string {
  return `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;
}

let largeCache: GraphData | null = null;

/** The large demo area, built on first use. */
export function largeGraph(): GraphData {
  largeCache ??= buildLargeGraph();
  return largeCache;
}
