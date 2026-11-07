// The data the canvas renderer draws, kept free of React and of the API types so the drawing
// layer can be swapped (for WebGL, say) without touching the page.

export interface SceneNode {
  key: string;
  /** World position. */
  x: number;
  y: number;
  /** 1 = smallest, grows with links. */
  size: number;
  /** Any CSS colour: the page resolves groups and theme tokens before handing it over. */
  color: string;
  /** Drawn as a ring instead of a filled dot. */
  topic: boolean;
  /** Drawn fainter. */
  legacy: boolean;
  /** The note title, drawn under the dot when zoomed in. */
  label: string;
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

export interface DisplayOptions {
  /** Dot size multiplier, 0.1-5. */
  nodeSize: number;
  /** Link width multiplier, 0.1-5. */
  linkThickness: number;
  /** Draw an arrowhead at each link's target end. */
  arrows: boolean;
  /** -3..3 as in Obsidian: higher shows labels at a lower zoom. */
  textFade: number;
}
