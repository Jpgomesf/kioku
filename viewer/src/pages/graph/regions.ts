// Names for the graph's brain regions (the clusters its links form, see communities.ts), so the
// canvas can label the parts of an area the way a map labels its regions; and for its colour
// groups, which the canvas names in their place while the graph is separated by them.
import {
  type GraphEdge,
  type GraphNode,
  kindCounts,
  kindLabelPlural,
  UNTYPED_KIND,
} from "../../api";
import { formatCount } from "./model";
import { parseQuery, soleTerm } from "./query";
import { LABEL_MAX } from "./renderer-math";
import { isTagKey, tagName } from "./tags";

/** A tag or a type names a region only when at least this share of its notes have it: fewer
 * would not describe the region. */
const NAME_SHARE = 0.25;
/** Only the largest regions are named, so the whole area reads like a map, not a wall of words. */
export const MAX_NAMED_REGIONS = 24;
/** A named region also holds at least this share of the area's notes, and MIN_NOTES of them:
 * sparse areas break into hundreds of small regions that are not parts of anything. */
const MIN_SHARE = 0.01;
const MIN_NOTES = 3;

/** A name a region could take, and the share of its notes the name describes. */
interface Candidate {
  region: number;
  name: string;
  share: number;
}

/**
 * A name per region, indexed by region, for the canvas: a tag that at least a quarter of the
 * region's notes carry, else its most common type in the plural when a quarter have it too,
 * else the title of its best-linked note, followed by its size ("billing · 120"). No two
 * regions share a tag or type: each tag, then each type, goes to the region where the largest
 * share of notes have it (the larger region on a tie), so a tag that runs through the whole
 * area names the one region it is most at home in, and the others move on to their next name.
 * Small regions get "" and stay unnamed.
 *
 * `assign` is each node's region, aligned with `nodes` (-1 for none). Tag nodes are not notes:
 * they neither count towards a region's size nor name it.
 */
export function regionNames(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  assign: Int32Array,
  count: number,
): string[] {
  const members: GraphNode[][] = Array.from({ length: count }, () => []);
  const index = new Map<string, number>();
  let notes = 0;
  nodes.forEach((n, i) => {
    index.set(n.key, i);
    const r = assign[i] ?? -1;
    if (r < 0 || r >= count || isTagKey(n.key)) return;
    members[r]?.push(n);
    notes += 1;
  });
  // Each note's links inside its own region: the best-linked note is the region's hub.
  const inside = new Map<string, number>();
  for (const e of edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const r = assign[a] ?? -1;
    if (r < 0 || r !== assign[b]) continue;
    inside.set(e.source, (inside.get(e.source) ?? 0) + 1);
    inside.set(e.target, (inside.get(e.target) ?? 0) + 1);
  }
  const minNotes = Math.max(MIN_NOTES, Math.ceil(notes * MIN_SHARE));
  const size = (r: number) => members[r]?.length ?? 0;
  const named = members
    .map((_, r) => r)
    .filter((r) => size(r) >= minNotes)
    .sort((p, q) => size(q) - size(p) || p - q)
    .slice(0, MAX_NAMED_REGIONS);

  const base = Array.from({ length: count }, () => "");
  const taken = new Set<string>();
  /** Hands out names best fit first: the highest share, then the larger region. */
  const assignByShare = (candidates: Candidate[]) => {
    candidates.sort(
      (p, q) =>
        q.share - p.share ||
        size(q.region) - size(p.region) ||
        p.region - q.region ||
        p.name.localeCompare(q.name),
    );
    for (const { region, name } of candidates) {
      if (base[region] !== "" || taken.has(name.toLowerCase())) continue;
      base[region] = name;
      taken.add(name.toLowerCase());
    }
  };
  const unnamed = () => named.filter((r) => base[r] === "");
  assignByShare(
    named.flatMap((r) =>
      tagCounts(members[r] ?? [])
        .map(([name, carriers]) => ({ region: r, name, share: carriers / size(r) }))
        .filter((c) => c.share >= NAME_SHARE),
    ),
  );
  assignByShare(
    unnamed().flatMap((r) => {
      const top = kindCounts(members[r] ?? [])[0];
      const share = top ? top.count / size(r) : 0;
      // An untyped note says nothing about what the region holds.
      if (!top || top.kind === UNTYPED_KIND || share < NAME_SHARE) return [];
      return [{ region: r, name: kindLabelPlural(top.kind), share }];
    }),
  );
  for (const r of unnamed()) {
    const hub = bestLinked(members[r] ?? [], inside);
    base[r] = hub ? hub.title.trim() || hub.key : "";
  }
  return base.map((name, r) => (name === "" ? "" : withSize(name, size(r))));
}

/**
 * A name per colour group, indexed like the groups, for the canvas while the graph is separated
 * by them, so the clusters on screen are named for what gathered them: what the group matches
 * (groupLabel) and its size ("Decisions · 120"). `groupOf` is each node's group, aligned with
 * `nodes` (-1 for none). A group with fewer than MIN_NOTES notes gets "" and stays unnamed, as a
 * small region does; tag nodes are not notes and are not counted.
 */
export function groupNames(
  nodes: readonly GraphNode[],
  groupOf: Int32Array,
  queries: readonly string[],
): string[] {
  const sizes = new Int32Array(queries.length);
  nodes.forEach((n, i) => {
    const g = groupOf[i] ?? -1;
    if (g >= 0 && g < queries.length && !isTagKey(n.key)) sizes[g] = (sizes[g] as number) + 1;
  });
  return queries.map((query, g) => {
    const size = sizes[g] as number;
    return size >= MIN_NOTES ? withSize(groupLabel(query), size) : "";
  });
}

/** What a group's query matches, in words: a type's plural label ("Decisions" for
 * type:decision), a tag's name as region names show it, else the query as typed. */
export function groupLabel(query: string): string {
  const term = soleTerm(parseQuery(query));
  if (term?.field === "type") return kindLabelPlural(term.value);
  if (term?.field === "tag") return term.value;
  return query.trim();
}

/** Each tag the region's notes carry and how many carry it. */
function tagCounts(region: readonly GraphNode[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const n of region) {
    for (const tag of new Set(n.tags.map(tagName))) {
      if (tag !== "") counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts];
}

/** The note with the most links inside the region; ties go to more links overall, then the key. */
function bestLinked(
  region: readonly GraphNode[],
  inside: ReadonlyMap<string, number>,
): GraphNode | null {
  let best: GraphNode | null = null;
  let bestInside = -1;
  for (const n of region) {
    const links = inside.get(n.key) ?? 0;
    const better =
      links > bestInside ||
      (links === bestInside &&
        best !== null &&
        (n.degree > best.degree || (n.degree === best.degree && n.key < best.key)));
    if (!better) continue;
    best = n;
    bestInside = links;
  }
  return best;
}

/** "billing · 120", with a long name cut so the size always shows within the label limit. */
function withSize(name: string, size: number): string {
  const suffix = ` · ${formatCount(size)}`;
  const room = Math.max(2, LABEL_MAX - suffix.length);
  const short = name.length <= room ? name : `${name.slice(0, room - 1).trimEnd()}…`;
  return `${short}${suffix}`;
}
