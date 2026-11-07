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
  /** A tag node (Tags filter on): a smaller dot labelled "#name". */
  tag: boolean;
  /** Drawn fainter. */
  legacy: boolean;
  /** The note title, drawn under the dot when zoomed in. */
  label: string;
}

export interface SceneEdge {
  /** Indices into nodes. */
  a: number;
  b: number;
  /** A link Reflect suggests: dashed, in the accent, or the stronger neutral when it is a
   * deeper step around a hovered or selected note. */
  suggested: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
}

export interface Emphasis {
  /** The selected note: ringed, and always drawn and named at full strength. */
  focusKey: string | null;
  hoverKey: string | null;
  /** The legend's group highlight, used while depths is null: these notes and the links
   * touching them draw at full strength and the rest fade. */
  lit: ReadonlySet<string> | null;
  /** Set while a note is hovered or selected: 0 for that note (the source), 1..d for notes
   * that many links away. These notes draw at full strength (depths 2 and 3 a little softer)
   * and every other note fades. Only links one step outwards (both ends here, depths one
   * apart) stand out: the source's own in the accent, deeper steps a stronger neutral. */
  depths: ReadonlyMap<string, number> | null;
}

/** Regions of the graph to name on the canvas ("parts of the brain"). */
export interface SceneRegions {
  /** Each note's region, aligned with the nodes of the scene last passed to the renderer
   * (map them by key); -1 for none. */
  assign: Int32Array;
  /** A name per region, indexed by region; an empty name leaves that region unnamed. */
  names: readonly string[];
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
  /** Name every topic at any zoom, placed with the other labels just below region names; when
   * false, only a hovered, selected or dragged topic is named. On unless false. */
  topicLabels?: boolean;
}
