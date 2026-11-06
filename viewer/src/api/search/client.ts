import { call } from "../core";
import type { SearchHit, SearchQuery } from "./types";

export const searchNotes = (query: SearchQuery): Promise<SearchHit[]> =>
  call("search_notes", { query }, async () => (await import("./mock")).searchNotes(query));
