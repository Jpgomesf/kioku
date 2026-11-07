// The graph's regions ("parts of the brain"): groups of notes that link to each other more
// than to the rest, found by Louvain modularity optimisation (Blondel et al. 2008).
//
// Why Louvain: it needs no target count, runs in near-linear time in the links (a 10,000-note,
// 100,000-link area takes well under a second in the worker), and its groups read as the
// clusters a person sees in a well-drawn graph. It moves each note to the neighbouring group
// that gains the most modularity until no move helps, then merges each group into one note
// and repeats on that smaller graph, level by level, while modularity still improves.
// Deterministic for a seed: notes are visited in a seeded order and ties keep a note where it is.
import { seededRandom } from "./simulation";

export interface Communities {
  /** Each note's region, numbered by size, largest first; -1 for a note with no links. */
  assign: Int32Array;
  count: number;
}

/** A level ends when a full pass over its notes gains less modularity than this. */
const MIN_GAIN = 1e-6;
/** Safety bounds: real graphs settle in a few passes and levels, far inside these. */
const MAX_PASSES = 64;
const MAX_LEVELS = 32;

/** One level's graph: notes (or merged groups of notes) and the weights between them. */
interface Level {
  n: number;
  /** Row i of the adjacency is targets[offsets[i]..offsets[i+1]), with matching weights. */
  offsets: Int32Array;
  targets: Int32Array;
  weights: Float64Array;
  /** The weight inside each node: the links within the group it stands for, counted both ways. */
  self: Float64Array;
  /** Each node's total link weight, self included. */
  degree: Float64Array;
}

export function detectCommunities(
  n: number,
  edges: ReadonlyArray<readonly [number, number]>,
  seed: number,
): Communities {
  const size = Math.max(0, Math.floor(n) || 0);
  const first = firstLevel(size, edges);
  let level = first;
  const rand = seededRandom(seed);
  // Which node of the current level each note sits in.
  const at = new Int32Array(size);
  for (let i = 0; i < size; i += 1) at[i] = i;

  for (let depth = 0; depth < MAX_LEVELS && level.n > 1; depth += 1) {
    const community = new Int32Array(level.n);
    for (let i = 0; i < level.n; i += 1) community[i] = i;
    if (!moveNodes(level, community, shuffled(level.n, rand))) break;
    const { next, renumber } = merge(level, community);
    for (let i = 0; i < size; i += 1) {
      at[i] = renumber[community[at[i] as number] as number] as number;
    }
    if (next.n === level.n) break;
    level = next;
  }
  return numberBySize(first.degree, at);
}

/** Notes in a seeded random order: Louvain's result depends on the visiting order. */
function shuffled(n: number, rand: () => number): Int32Array {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = order[i] as number;
    order[i] = order[j] as number;
    order[j] = t;
  }
  return order;
}

/** Links as sorted, unique index pairs, packed as a * n + b with a < b; bad links dropped. */
function cleanPairs(n: number, edges: ReadonlyArray<readonly [number, number]>): Float64Array {
  const codes = new Float64Array(edges.length);
  let m = 0;
  for (const [a, b] of edges) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
    if (a < 0 || b < 0 || a >= n || b >= n) continue;
    codes[m] = Math.min(a, b) * n + Math.max(a, b);
    m += 1;
  }
  const sorted = codes.subarray(0, m).sort();
  let unique = 0;
  for (let k = 0; k < m; k += 1) {
    if (k > 0 && sorted[k] === sorted[k - 1]) continue;
    sorted[unique] = sorted[k] as number;
    unique += 1;
  }
  return sorted.subarray(0, unique);
}

/** The notes and their links as the first level, every link weighing 1. */
function firstLevel(n: number, edges: ReadonlyArray<readonly [number, number]>): Level {
  const pairs = cleanPairs(n, edges);
  const offsets = new Int32Array(n + 1);
  for (const code of pairs) {
    offsets[Math.floor(code / n) + 1] = (offsets[Math.floor(code / n) + 1] as number) + 1;
    offsets[(code % n) + 1] = (offsets[(code % n) + 1] as number) + 1;
  }
  for (let i = 0; i < n; i += 1) {
    offsets[i + 1] = (offsets[i + 1] as number) + (offsets[i] as number);
  }
  const targets = new Int32Array(pairs.length * 2);
  const fill = offsets.slice(0, n);
  for (const code of pairs) {
    const a = Math.floor(code / n);
    const b = code % n;
    targets[fill[a] as number] = b;
    fill[a] = (fill[a] as number) + 1;
    targets[fill[b] as number] = a;
    fill[b] = (fill[b] as number) + 1;
  }
  const degree = new Float64Array(n);
  for (let i = 0; i < n; i += 1) degree[i] = (offsets[i + 1] as number) - (offsets[i] as number);
  return {
    n,
    offsets,
    targets,
    weights: new Float64Array(targets.length).fill(1),
    self: new Float64Array(n),
    degree,
  };
}

/** Σ over groups of (weight inside / 2m) - (total degree / 2m)². */
function modularity(inside: Float64Array, total: Float64Array, m2: number): number {
  let q = 0;
  for (let c = 0; c < inside.length; c += 1) {
    const t = (total[c] as number) / m2;
    q += (inside[c] as number) / m2 - t * t;
  }
  return q;
}

/**
 * Louvain's first phase: move each node, in order, to the neighbouring group that raises
 * modularity most, pass after pass, until a pass gains almost nothing. `community` starts with
 * every node alone and ends with the groups. Returns true if any node moved.
 */
function moveNodes(level: Level, community: Int32Array, order: Int32Array): boolean {
  const { n, offsets, targets, weights, self, degree } = level;
  let m2 = 0;
  for (let i = 0; i < n; i += 1) m2 += degree[i] as number;
  if (m2 === 0) return false;
  // Per group: its total degree and the weight inside it (both ways, selves included).
  const total = Float64Array.from(degree);
  const inside = Float64Array.from(self);
  // The weight from the node being moved to each group it touches; -1 = not touched.
  const toGroup = new Float64Array(n).fill(-1);
  const touched = new Int32Array(n);

  let moved = false;
  let q = modularity(inside, total, m2);
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let moves = 0;
    for (const i of order) {
      const own = community[i] as number;
      const k = degree[i] as number;
      // Its own group comes first, so a tie keeps the node where it is.
      let count = 1;
      touched[0] = own;
      toGroup[own] = 0;
      for (let e = offsets[i] as number; e < (offsets[i + 1] as number); e += 1) {
        const c = community[targets[e] as number] as number;
        if ((toGroup[c] as number) < 0) {
          toGroup[c] = 0;
          touched[count] = c;
          count += 1;
        }
        toGroup[c] = (toGroup[c] as number) + (weights[e] as number);
      }
      // Take the node out, then put it in the group with the best gain:
      // (weight to the group) - (the group's total degree) * k / 2m.
      total[own] = (total[own] as number) - k;
      inside[own] = (inside[own] as number) - 2 * (toGroup[own] as number) - (self[i] as number);
      let best = own;
      let bestGain = 0;
      for (let t = 0; t < count; t += 1) {
        const c = touched[t] as number;
        const gain = (toGroup[c] as number) - ((total[c] as number) * k) / m2;
        if (gain > bestGain) {
          best = c;
          bestGain = gain;
        }
      }
      total[best] = (total[best] as number) + k;
      inside[best] = (inside[best] as number) + 2 * (toGroup[best] as number) + (self[i] as number);
      community[i] = best;
      if (best !== own) moves += 1;
      for (let t = 0; t < count; t += 1) toGroup[touched[t] as number] = -1;
    }
    if (moves === 0) break;
    moved = true;
    const next = modularity(inside, total, m2);
    const gain = next - q;
    q = next;
    if (gain < MIN_GAIN) break;
  }
  return moved;
}

/**
 * Louvain's second phase: each group becomes one node of the next level, with the weights
 * between groups summed and the links inside a group kept as its self weight. Groups are
 * renumbered in order of their lowest node, so the result never depends on hash order.
 */
function merge(level: Level, community: Int32Array): { next: Level; renumber: Int32Array } {
  const { n, offsets, targets, weights, self } = level;
  const renumber = new Int32Array(n).fill(-1);
  let k = 0;
  for (let i = 0; i < n; i += 1) {
    const c = community[i] as number;
    if (renumber[c] === -1) {
      renumber[c] = k;
      k += 1;
    }
  }
  // Members of each new node, as a bucket list.
  const start = new Int32Array(k + 1);
  for (let i = 0; i < n; i += 1) {
    const g = renumber[community[i] as number] as number;
    start[g + 1] = (start[g + 1] as number) + 1;
  }
  for (let g = 0; g < k; g += 1) start[g + 1] = (start[g + 1] as number) + (start[g] as number);
  const members = new Int32Array(n);
  const fill = start.slice(0, k);
  for (let i = 0; i < n; i += 1) {
    const g = renumber[community[i] as number] as number;
    members[fill[g] as number] = i;
    fill[g] = (fill[g] as number) + 1;
  }

  const nextSelf = new Float64Array(k);
  const nextOffsets = new Int32Array(k + 1);
  const rowTargets: number[] = [];
  const rowWeights: number[] = [];
  const acc = new Float64Array(k);
  const seen = new Int32Array(k).fill(-1);
  const list = new Int32Array(k);
  for (let g = 0; g < k; g += 1) {
    let count = 0;
    for (let p = start[g] as number; p < (start[g + 1] as number); p += 1) {
      const i = members[p] as number;
      nextSelf[g] = (nextSelf[g] as number) + (self[i] as number);
      for (let e = offsets[i] as number; e < (offsets[i + 1] as number); e += 1) {
        const h = renumber[community[targets[e] as number] as number] as number;
        const w = weights[e] as number;
        if (h === g) {
          nextSelf[g] = (nextSelf[g] as number) + w;
          continue;
        }
        if (seen[h] !== g) {
          seen[h] = g;
          acc[h] = 0;
          list[count] = h;
          count += 1;
        }
        acc[h] = (acc[h] as number) + w;
      }
    }
    for (let t = 0; t < count; t += 1) {
      const h = list[t] as number;
      rowTargets.push(h);
      rowWeights.push(acc[h] as number);
    }
    nextOffsets[g + 1] = rowTargets.length;
  }
  const nextWeights = Float64Array.from(rowWeights);
  const degree = Float64Array.from(nextSelf);
  for (let g = 0; g < k; g += 1) {
    for (let e = nextOffsets[g] as number; e < (nextOffsets[g + 1] as number); e += 1) {
      degree[g] = (degree[g] as number) + (nextWeights[e] as number);
    }
  }
  return {
    next: {
      n: k,
      offsets: nextOffsets,
      targets: Int32Array.from(rowTargets),
      weights: nextWeights,
      self: nextSelf,
      degree,
    },
    renumber,
  };
}

/** Final numbers: largest region first (ties by lowest note), -1 for notes with no links. */
function numberBySize(degree: Float64Array, at: Int32Array): Communities {
  const n = degree.length;
  const sizes = new Map<number, { size: number; first: number }>();
  for (let i = 0; i < n; i += 1) {
    if (degree[i] === 0) continue;
    const g = at[i] as number;
    const s = sizes.get(g);
    if (s) s.size += 1;
    else sizes.set(g, { size: 1, first: i });
  }
  const ranked = [...sizes.entries()].sort(([, p], [, q]) => q.size - p.size || p.first - q.first);
  const number = new Map(ranked.map(([g], rank) => [g, rank]));
  const assign = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    if (degree[i] !== 0) assign[i] = number.get(at[i] as number) ?? -1;
  }
  return { assign, count: ranked.length };
}
