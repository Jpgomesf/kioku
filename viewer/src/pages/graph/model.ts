// What the graph shows: the type filters, and the cards around a focus note, with busy
// types folded into "N more decisions" groups.
import {
  type GraphData,
  type GraphEdge,
  type GraphNode,
  kindLabel,
  type NoteKind,
  TOPIC_KIND,
} from "../../api";
import { type ColourSlots, DEFAULT_SLOTS, slotOf } from "./colours";
import type { Point } from "./layout";

export interface Filters {
  /** Types the viewer turned off; empty shows every type. */
  hidden: ReadonlySet<NoteKind>;
  suggested: boolean;
  topicLabels: boolean;
  legacy: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  hidden: new Set(),
  suggested: true,
  topicLabels: true,
  legacy: true,
};

export function isVisible(node: GraphNode, f: Pick<Filters, "hidden" | "legacy">): boolean {
  if (f.hidden.has(node.kind)) return false;
  return f.legacy || node.status !== "legacy";
}

/** Hides a shown type or shows a hidden one. */
export function toggleHidden(f: Filters, kind: NoteKind): Filters {
  const hidden = new Set(f.hidden);
  if (!hidden.delete(kind)) hidden.add(kind);
  return { ...f, hidden };
}

export interface Neighbour {
  node: GraphNode;
  edge: GraphEdge;
  /** True when the edge points from the focus note to this one. */
  outgoing: boolean;
}

/** Coloured types first in slot order, then the rest by label, then by title. */
export function neighboursOf(
  data: GraphData,
  focus: string,
  slots: ColourSlots = DEFAULT_SLOTS,
): Neighbour[] {
  const byKey = new Map(data.nodes.map((n) => [n.key, n]));
  const seen = new Set<string>();
  const out: Neighbour[] = [];
  for (const edge of data.edges) {
    const outgoing = edge.source === focus;
    const other = outgoing ? edge.target : edge.target === focus ? edge.source : null;
    if (!other || other === focus || seen.has(other)) continue;
    const node = byKey.get(other);
    if (!node) continue;
    seen.add(other);
    out.push({ node, edge, outgoing });
  }
  const rank = (kind: NoteKind) => {
    const slot = slotOf(slots, kind);
    return slot < 0 ? slots.length : slot;
  };
  return out.sort(
    (a, b) =>
      rank(a.node.kind) - rank(b.node.kind) ||
      kindLabel(a.node.kind).localeCompare(kindLabel(b.node.kind)) ||
      // Recorded links first, so cards never fold them behind suggestions.
      Number(a.edge.suggested) - Number(b.edge.suggested) ||
      a.node.title.localeCompare(b.node.title) ||
      a.node.key.localeCompare(b.node.key),
  );
}

/**
 * The notes within `hops` links of `focus` (1 or 2). A second-hop note carries the edge
 * from the first-hop note that reaches it. `keep` filters every hop before the next one
 * expands, so the walk never passes through a hidden note or a filtered link.
 */
export function neighboursWithin(
  data: GraphData,
  focus: string,
  hops: 1 | 2,
  slots: ColourSlots = DEFAULT_SLOTS,
  keep: (n: Neighbour) => boolean = () => true,
): Neighbour[] {
  const first = neighboursOf(data, focus, slots).filter(keep);
  if (hops === 1) return first;
  const seen = new Set([focus, ...first.map((n) => n.node.key)]);
  const second: Neighbour[] = [];
  for (const near of first) {
    for (const far of neighboursOf(data, near.node.key, slots)) {
      if (seen.has(far.node.key) || !keep(far)) continue;
      seen.add(far.node.key);
      second.push(far);
    }
  }
  return [...first, ...second];
}

export type Card =
  | { type: "note"; neighbour: Neighbour }
  | { type: "group"; kind: NoteKind; members: Neighbour[] };

/** How many of one kind show as cards before the rest fold into a group. */
export const GROUP_AFTER = 3;

export function cardsFor(neighbours: Neighbour[], expanded: ReadonlySet<NoteKind>): Card[] {
  const byKind = new Map<NoteKind, Neighbour[]>();
  for (const n of neighbours) {
    const list = byKind.get(n.node.kind) ?? [];
    list.push(n);
    byKind.set(n.node.kind, list);
  }
  const cards: Card[] = [];
  for (const [kind, list] of byKind) {
    if (list.length <= GROUP_AFTER || expanded.has(kind)) {
      for (const neighbour of list) cards.push({ type: "note", neighbour });
      continue;
    }
    for (const neighbour of list.slice(0, GROUP_AFTER - 1)) cards.push({ type: "note", neighbour });
    cards.push({ type: "group", kind, members: list.slice(GROUP_AFTER - 1) });
  }
  return cards;
}

export function cardKey(card: Card): string {
  return card.type === "note" ? card.neighbour.node.key : `group:${card.kind}`;
}

/**
 * Screen-space offsets of the cards from the focus card at the closest step: an ellipse
 * that grows with the number of cards so 200-pixel cards never overlap, then shrinks to fit
 * the stage when given one.
 */
export function cardSlots(count: number, view?: { width: number; height: number }): Point[] {
  if (count === 0) return [];
  const rings = Math.max(1, Math.ceil(count / 8));
  const slots: Point[] = [];
  let placed = 0;
  for (let r = 0; r < rings; r += 1) {
    const inRing = Math.min(8, count - placed);
    const rx = 300 + r * 230;
    const ry = 150 + r * 110;
    for (let i = 0; i < inRing; i += 1) {
      const angle = -Math.PI / 2 + ((i + (r % 2) * 0.5) / inRing) * Math.PI * 2;
      slots.push({ x: Math.round(Math.cos(angle) * rx), y: Math.round(Math.sin(angle) * ry) });
    }
    placed += inRing;
  }
  if (!view) return slots;
  const maxX = Math.max(...slots.map((p) => Math.abs(p.x)), 1);
  const maxY = Math.max(...slots.map((p) => Math.abs(p.y)), 1);
  const fit = Math.min(1, (view.width / 2 - 110) / maxX, (view.height / 2 - 40) / maxY);
  const k = Math.max(fit, 0.3);
  return k === 1 ? slots : slots.map((p) => ({ x: Math.round(p.x * k), y: Math.round(p.y * k) }));
}

/** Search the graph by key or title; exact key first. */
export function findNodes(nodes: GraphNode[], query: string, limit = 6): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = nodes.filter((n) => n.key.toLowerCase() === q);
  const rest = nodes.filter(
    (n) =>
      n.key.toLowerCase() !== q &&
      (n.key.toLowerCase().includes(q) || n.title.toLowerCase().includes(q)),
  );
  return [...exact, ...rest].slice(0, limit);
}

/** Dot radius in world units, growing with the number of links. */
export function dotRadius(node: GraphNode): number {
  if (node.kind === TOPIC_KIND) return 9 + Math.min(Math.sqrt(node.degree) * 2, 14);
  return 2.2 + Math.min(Math.sqrt(node.degree) * 0.9, 5);
}

/** Counts with thousands separators: 1,594 notes. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-GB");
}

/** Sentence case for a relation name: "in topic" becomes "In topic". */
export function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
