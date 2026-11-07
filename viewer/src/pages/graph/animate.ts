// Animate, as in Obsidian: replays how the area grew. Notes appear in order of their last
// update on the current layout, and a link once both its ends are shown.
import type { Scene } from "./scene";

/** How long the replay takes, about as long as Obsidian's. */
export const ANIMATE_MS = 6000;

/** Each scene node's place in the replay: 0 shows first. Ties keep scene order. */
export function revealRanks(times: readonly string[]): Int32Array {
  const order = times
    .map((_, i) => i)
    .sort((a, b) => {
      const ta = times[a] as string;
      const tb = times[b] as string;
      return ta < tb ? -1 : ta > tb ? 1 : a - b;
    });
  const ranks = new Int32Array(times.length);
  order.forEach((i, r) => {
    ranks[i] = r;
  });
  return ranks;
}

/** The part of `scene` shown once `count` nodes have appeared. */
export function partialScene(scene: Scene, ranks: Int32Array, count: number): Scene {
  if (count >= scene.nodes.length) return scene;
  const to = new Int32Array(scene.nodes.length).fill(-1);
  const nodes: Scene["nodes"] = [];
  scene.nodes.forEach((n, i) => {
    if ((ranks[i] as number) < count) {
      to[i] = nodes.length;
      nodes.push(n);
    }
  });
  const edges: Scene["edges"] = [];
  for (const e of scene.edges) {
    const a = to[e.a] as number;
    const b = to[e.b] as number;
    if (a >= 0 && b >= 0) edges.push({ a, b, suggested: e.suggested });
  }
  return { nodes, edges };
}
