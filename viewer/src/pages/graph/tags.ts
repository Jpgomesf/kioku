// Tags as nodes, as Obsidian's Tags filter draws them: each tag the visible notes carry
// becomes a small node named "#tag", linked to every note that has it, so tags pull their
// notes together in the simulation.
import type { GraphData, GraphEdge, GraphNode } from "../../api";

/** Tag node keys start with this; note keys are paths, so they never do. */
export const TAG_PREFIX = "tag:";
/** The kind tag nodes carry, so type: queries can find them. */
export const TAG_KIND = "tag";

export const isTagKey = (key: string): boolean => key.startsWith(TAG_PREFIX);

/** Tags compare without case or a leading #, as tag: queries do. */
export const tagName = (tag: string): string => tag.trim().replace(/^#+/, "").toLowerCase();

/** The notes plus one node per tag they carry, and a link from each note to its tags. A tag
 * node's update time is its earliest note's, so Animate shows it with that note. */
export function withTags(data: GraphData): GraphData {
  const tags = new Map<string, { node: GraphNode; edges: GraphEdge[] }>();
  for (const n of data.nodes) {
    for (const raw of new Set(n.tags.map(tagName))) {
      if (raw === "") continue;
      const key = `${TAG_PREFIX}${raw}`;
      let entry = tags.get(key);
      if (!entry) {
        entry = {
          node: {
            key,
            domain: n.domain,
            title: `#${raw}`,
            kind: TAG_KIND,
            status: "active",
            degree: 0,
            tags: [raw],
            updatedAt: n.updatedAt,
          },
          edges: [],
        };
        tags.set(key, entry);
      }
      entry.node.degree += 1;
      if (n.updatedAt < entry.node.updatedAt) entry.node.updatedAt = n.updatedAt;
      entry.edges.push({ source: n.key, target: key, relation: "tagged", suggested: false });
    }
  }
  if (tags.size === 0) return data;
  const sorted = [...tags.values()].sort((a, b) => a.node.key.localeCompare(b.node.key));
  return {
    nodes: [...data.nodes, ...sorted.map((t) => t.node)],
    edges: [...data.edges, ...sorted.flatMap((t) => t.edges)],
  };
}
