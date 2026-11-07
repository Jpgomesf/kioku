// Turns the page's visible notes and links into the renderer's Scene, so the renderer never
// sees the API types, the filters or the colour groups. Positions start at the origin: the
// live layout moves them in place through renderer.setPositions.
import { type GraphEdge, type GraphNode, TOPIC_KIND } from "../../api";
import type { Scene, SceneEdge, SceneNode } from "./scene";

/** The notes and links to draw. Callers pass only visible ones; links to a note that is not
 * among `nodes` are left out. `colourOf` must return a concrete CSS colour, not a var(). */
export function toScene(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  colourOf: (node: GraphNode) => string,
): Scene {
  const sceneNodes: SceneNode[] = [];
  const index = new Map<string, number>();
  for (const n of nodes) {
    index.set(n.key, sceneNodes.length);
    sceneNodes.push({
      key: n.key,
      x: 0,
      y: 0,
      size: 1 + n.degree,
      color: colourOf(n),
      topic: n.kind === TOPIC_KIND,
      legacy: n.status === "legacy",
      label: n.title,
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
