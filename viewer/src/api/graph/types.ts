// Graph. Serde twin: src-tauri/src/commands/graph.rs.
import type { NoteKind, NoteStatus } from "../notes/types";

export interface GraphNode {
  key: string;
  domain: string;
  title: string;
  kind: NoteKind;
  status: NoteStatus;
  degree: number;
  tags: string[];
  /** Last update, ISO 8601 UTC like NoteSummary.updatedAt. */
  updatedAt: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  suggested: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphQuery {
  domain: string;
  /** Focus note; when set, only its neighbourhood is returned. */
  focus?: string;
  /** Hops from the focus note (default 1). */
  depth?: number;
}
