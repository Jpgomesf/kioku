// Turns the page's visible notes and links into the renderer's Scene, so the renderer never
// sees the API types, the filters or the colour slots.
import { type GraphEdge, type GraphNode, TOPIC_KIND } from "../../api";
import { type ColourSlots, slotOf } from "./colours";
import type { Point } from "./layout";
import type { Scene, SceneEdge, SceneNode, Tone } from "./scene";

const SLOT_TONES: readonly Tone[] = ["slot1", "slot2", "slot3"];

/** A type's tone: its colour slot, "topic" for topics, "other" for every unpicked type. */
export function toneOf(slots: ColourSlots, kind: string): Tone {
  if (kind === TOPIC_KIND) return "topic";
  return SLOT_TONES[slotOf(slots, kind)] ?? "other";
}

/** The notes and links to draw. Callers pass only visible ones; notes without a position and
 * links to them are left out. */
export function toScene(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  positions: ReadonlyMap<string, Point>,
  slots: ColourSlots,
): Scene {
  const sceneNodes: SceneNode[] = [];
  const index = new Map<string, number>();
  for (const n of nodes) {
    const p = positions.get(n.key);
    if (!p) continue;
    index.set(n.key, sceneNodes.length);
    sceneNodes.push({
      key: n.key,
      x: p.x,
      y: p.y,
      size: 1 + n.degree,
      tone: toneOf(slots, n.kind),
      legacy: n.status === "legacy",
    });
  }
  const sceneEdges: SceneEdge[] = [];
  for (const e of edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined) continue;
    sceneEdges.push({ a, b, suggested: e.suggested });
  }
  return { nodes: sceneNodes, edges: sceneEdges };
}
