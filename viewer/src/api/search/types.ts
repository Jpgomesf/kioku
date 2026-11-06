// Search. Serde twin: src-tauri/src/commands/search.rs.
import type { NoteSummary } from "../notes/types";

export type MatchedBy = "label" | "text" | "meaning" | "linked";

export interface SearchHit {
  note: NoteSummary;
  score: number;
  /** Every signal that matched, such as ["text", "meaning"]. */
  matchedBy: MatchedBy[];
  /** Title of the note this hit was reached from, for link-filled results. */
  linkedFrom: string | null;
  snippet: string;
}

/** Search one area, or every area of a vault. */
export type SearchScope = { domain: string } | { vault: string };

export interface SearchQuery {
  scope: SearchScope;
  text: string;
  /** At most this many; the backend caps it at MAX_SEARCH (kioku's maximum). */
  limit?: number;
  includeLegacy?: boolean;
}

/** The most hits search_notes returns. */
export const MAX_SEARCH = 20;
