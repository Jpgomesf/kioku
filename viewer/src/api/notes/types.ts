// Vaults, areas and notes. Serde twins live in src-tauri/src/commands/{areas,notes}.rs.

/**
 * A note's type as a lowercase id, such as "decision" or "design-review". Open-ended: it comes
 * from the note's source (an explicit kind: tag, a knowledge base's own type, or a type word
 * among an agent note's tags), and is "note" when nothing names one. The Rust side derives it
 * in src-tauri/src/data/notes.rs (kind_of); labels, plurals and counts come from ./kinds.
 */
export type NoteKind = string;
export type NoteStatus = "active" | "legacy" | "draft";
export type NoteOrigin = "file" | "agent";

export interface Vault {
  name: string;
  domains: string[];
  providers: string[];
}

export interface Area {
  /** Full domain, such as "personal/kioku". */
  domain: string;
  /** Short label shown in the UI, such as "kioku". Never repeats the vault. */
  label: string;
  vault: string;
  /** Active notes only; legacy notes are counted in legacyCount. */
  noteCount: number;
  legacyCount: number;
  /** Where the area's notes are imported from, if anywhere. */
  source: string | null;
}

export interface NoteSummary {
  key: string;
  domain: string;
  title: string;
  kind: NoteKind;
  status: NoteStatus;
  origin: NoteOrigin;
  tags: string[];
  linkCount: number;
  /** Open Reflect findings that name this note. */
  findingCount: number;
  /** Where an imported note came from, such as a knowledge base name. */
  source: string | null;
  updatedAt: string;
}

export interface Link {
  targetKey: string;
  targetDomain: string;
  /** The target note's title, when it could be read. */
  targetTitle: string | null;
  relation: string;
  suggested: boolean;
}

export interface Revision {
  /** The note's content revision; a status change keeps it. */
  revision: number;
  at: string;
  summary: string;
  origin: NoteOrigin;
}

export interface Note {
  key: string;
  domain: string;
  title: string;
  body: string;
  kind: NoteKind;
  status: NoteStatus;
  origin: NoteOrigin;
  aliases: string[];
  tags: string[];
  links: Link[];
  /** Newest first, at most 20. */
  revisions: Revision[];
  /** The note's current content revision. */
  revision: number;
  /** The file an imported note came from, relative to the notes root when under it. */
  sourcePath: string | null;
  updatedAt: string;
}

export interface NoteQuery {
  domain: string;
  kinds?: NoteKind[];
  status?: NoteStatus | "all";
  origin?: NoteOrigin;
  /** Only notes changed on or after this ISO date. */
  since?: string;
  /** Filter text over titles, keys and tags. */
  text?: string;
  /** At most this many; the backend caps it at MAX_NOTE_LIST. */
  limit?: number;
}

/** The most notes list_notes returns (Rust MAX_LIST). */
export const MAX_NOTE_LIST = 10_000;
