import { areas, summariesIn } from "../fixtures";
import { MAX_SEARCH, type SearchHit, type SearchQuery } from "./types";

export function searchNotes(q: SearchQuery): SearchHit[] {
  const t = q.text.trim().toLowerCase();
  if (!t) return [];
  const domains =
    "domain" in q.scope
      ? [q.scope.domain]
      : areas.filter((a) => "vault" in q.scope && a.vault === q.scope.vault).map((a) => a.domain);
  return domains
    .flatMap(summariesIn)
    .filter((n) => q.includeLegacy || n.status !== "legacy")
    .filter((n) => n.title.toLowerCase().includes(t) || n.key.includes(t))
    .slice(0, Math.min(q.limit ?? MAX_SEARCH, MAX_SEARCH))
    .map((n, i) => ({
      note: n,
      score: 1 / (i + 1),
      matchedBy: n.key.includes(t) ? ["label"] : ["text", "meaning"],
      linkedFrom: null,
      snippet: n.title,
    }));
}
