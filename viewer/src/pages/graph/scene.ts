// The data the canvas renderer draws, kept free of React and of the API types so the drawing
// layer can be swapped (for WebGL, say) without touching the page.

export type Tone = "slot1" | "slot2" | "slot3" | "other" | "topic";

export interface SceneNode {
  key: string;
  /** World position. */
  x: number;
  y: number;
  /** 1 = smallest, grows with links. */
  size: number;
  tone: Tone;
  /** Drawn fainter. */
  legacy: boolean;
}

export interface SceneEdge {
  /** Indices into nodes. */
  a: number;
  b: number;
  /** A link Reflect suggests: dashed, accent. */
  suggested: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
}

export interface Emphasis {
  focusKey: string | null;
  hoverKey: string | null;
  /** When set, only these notes and the links touching them draw at full strength. */
  lit: ReadonlySet<string> | null;
}
