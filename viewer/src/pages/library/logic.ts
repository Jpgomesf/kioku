// Pure filter, sort and formatting logic for the Library. No React, so it is easy to test.

import type {
  Area,
  MatchedBy,
  NoteKind,
  NoteOrigin,
  NoteStatus,
  NoteSummary,
  SearchHit,
} from "../../api";
import { formatDay, formatDayTime } from "../../app/dates";
import type { LibraryParams } from "../../app/router";

export const KIND_CHIPS: readonly { kind: NoteKind; label: string }[] = [
  { kind: "decision", label: "Decisions" },
  { kind: "question", label: "Questions" },
  { kind: "fix", label: "Fixes" },
  { kind: "convention", label: "Conventions" },
  { kind: "item", label: "Items" },
];

const KINDS: readonly NoteKind[] = [
  "decision",
  "question",
  "item",
  "fix",
  "convention",
  "preference",
  "note",
  "topic",
  "ticket",
  "pull-request",
];

export type StatusFilter = NoteStatus | "all";
export type OriginFilter = NoteOrigin | "any";

export interface LibraryFilters {
  kinds: NoteKind[];
  status: StatusFilter;
  origin: OriginFilter;
  /** ISO date; only notes updated on or after it. */
  since: string | null;
  /** True when `since` came from "last-visit"; it is written back as that word. */
  sinceLastVisit?: boolean;
  query: string;
}

/** The URL word for "changed since your last visit". */
export const LAST_VISIT = "last-visit";

/** The backend's largest list and search sizes, owned by the API contract. */
import { MAX_NOTE_LIST, MAX_SEARCH } from "../../api";

export { MAX_NOTE_LIST, MAX_SEARCH };

const STATUS_ORDER: readonly StatusFilter[] = ["active", "legacy", "draft", "all"];
const ORIGIN_ORDER: readonly OriginFilter[] = ["any", "file", "agent"];

function isKind(value: string): value is NoteKind {
  return (KINDS as readonly string[]).includes(value);
}

/** Read the route's params. Unknown values fall back to the defaults.
 * `since=last-visit` resolves to `lastVisit` (an ISO date). */
export function filtersFromParams(
  params: LibraryParams,
  lastVisit: string | null = null,
): LibraryFilters {
  const kinds = (params.kind ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(isKind);
  const status = STATUS_ORDER.find((s) => s === params.status) ?? "active";
  const origin = ORIGIN_ORDER.find((o) => o === params.origin) ?? "any";
  const base = { kinds: [...new Set(kinds)], status, origin, query: params.q ?? "" };
  if (params.since === LAST_VISIT) {
    return { ...base, since: lastVisit ?? sevenDaysAgo(), sinceLastVisit: true };
  }
  const since = params.since && !Number.isNaN(Date.parse(params.since)) ? params.since : null;
  return { ...base, since };
}

/** The params that describe these filters; defaults are left out of the URL. */
export function paramsFromFilters(filters: LibraryFilters): LibraryParams {
  const params: LibraryParams = {};
  const q = filters.query.trim();
  if (q) params.q = filters.query;
  if (filters.kinds.length > 0) params.kind = filters.kinds.join(",");
  if (filters.status !== "active") params.status = filters.status;
  if (filters.origin !== "any") params.origin = filters.origin;
  if (filters.since) params.since = filters.sinceLastVisit ? LAST_VISIT : filters.since;
  return params;
}

export function toggleKind(kinds: readonly NoteKind[], kind: NoteKind): NoteKind[] {
  return kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
}

export function nextStatus(status: StatusFilter): StatusFilter {
  return STATUS_ORDER[(STATUS_ORDER.indexOf(status) + 1) % STATUS_ORDER.length] ?? "active";
}

export function nextOrigin(origin: OriginFilter): OriginFilter {
  return ORIGIN_ORDER[(ORIGIN_ORDER.indexOf(origin) + 1) % ORIGIN_ORDER.length] ?? "any";
}

export function matchesFilters(note: NoteSummary, filters: LibraryFilters): boolean {
  if (filters.kinds.length > 0 && !filters.kinds.includes(note.kind)) return false;
  if (filters.status !== "all" && note.status !== filters.status) return false;
  if (filters.origin !== "any" && note.origin !== filters.origin) return false;
  if (filters.since && Date.parse(note.updatedAt) < Date.parse(filters.since)) return false;
  return true;
}

/** Newest first; ties broken by key so the order is stable. */
export function compareNotes(a: NoteSummary, b: NoteSummary): number {
  const byDate = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  return byDate !== 0 ? byDate : a.key.localeCompare(b.key);
}

export function filterAndSort(
  notes: readonly NoteSummary[],
  filters: LibraryFilters,
): NoteSummary[] {
  return notes.filter((n) => matchesFilters(n, filters)).sort(compareNotes);
}

/** Move a selection by `delta`, clamped to the list. -1 means nothing is selected. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}

export const formatDate = (iso: string): string => formatDay(iso);
export const formatDateTime = (iso: string): string => formatDayTime(iso);

const MATCH_WORDS: Record<MatchedBy, string> = {
  label: "label",
  text: "text",
  meaning: "meaning",
  linked: "link",
};

/** "Matched by text and meaning", or "Linked from <title>". */
export function matchedByText(matchedBy: readonly MatchedBy[], linkedFrom: string | null): string {
  if (linkedFrom && matchedBy.every((m) => m === "linked")) return `Linked from ${linkedFrom}`;
  const words = matchedBy.map((m) => MATCH_WORDS[m]);
  if (words.length === 0) return "Matched";
  const list =
    words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return `Matched by ${list}`;
}

export function originText(origin: NoteOrigin, source: string | null): string {
  if (origin === "agent") return "saved by an agent";
  return source ? `from ${source}` : "from a file";
}

export function statusLabel(status: StatusFilter): string {
  return status === "all" ? "Status: any" : `Status: ${status}`;
}

export function originLabel(origin: OriginFilter): string {
  if (origin === "file") return "Origin: file";
  if (origin === "agent") return "Origin: agent";
  return "Origin: any";
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

export function sevenDaysAgo(now: number = Date.now()): string {
  return new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
}

/** Search hits that pass the same filters as the list. */
export function filterHits(hits: readonly SearchHit[], filters: LibraryFilters): SearchHit[] {
  return hits.filter((h) => matchesFilters(h.note, filters));
}

/** The header's counts, from the loaded notes. Null until they are ready. */
export function countsLine(notes: readonly NoteSummary[] | null, area: Area | null): string | null {
  if (!notes) return null;
  const active = notes.filter((n) => n.status === "active").length;
  const legacy = notes.filter((n) => n.status === "legacy").length;
  const parts = [
    `${active.toLocaleString("en-US")} active`,
    `${legacy.toLocaleString("en-US")} legacy`,
  ];
  if (area?.source) parts.push(`imported from ${area.source}`);
  if (notes.length >= MAX_NOTE_LIST) {
    parts.push(`showing the first ${MAX_NOTE_LIST.toLocaleString("en-US")}`);
  }
  return parts.join(" · ");
}

/** The area button's label and vault. The vault is null until the area list names it. */
export function areaLabel(
  domain: string,
  area: Area | null,
): { label: string; vault: string | null } {
  if (area && area.domain === domain) return { label: area.label, vault: area.vault };
  return { label: domain.split("/").at(-1) || domain, vault: null };
}

export function footText(count: number, searching: boolean, filters: LibraryFilters): string {
  if (searching)
    return `${plural(count, "result")}, best first, from the top ${MAX_SEARCH} before filters`;
  const noun = filters.kinds.length === 1 && filters.kinds[0] === "decision" ? "decision" : "note";
  const since = filters.since ? ` changed since ${formatDate(filters.since)}` : "";
  return `${plural(count, noun)}${since}`;
}

/** Stable React keys for a list that may hold duplicates: repeats get "#2", "#3". */
export function uniqueKeys(bases: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return bases.map((base) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}
