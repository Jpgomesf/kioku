// Note types are open text, so labels, plurals and counts are derived from the type id
// instead of looked up in a fixed table. The id itself comes from the backend (kind_of).
import type { NoteKind } from "./types";

/** The type of a note whose source names none. */
export const UNTYPED_KIND: NoteKind = "note";

/** Topic hubs: drawn as neutral rings in the graph and never given a type colour. */
export const TOPIC_KIND: NoteKind = "topic";

/** Same limit as a Kioku tag, which is where a type id comes from. */
const MAX_KIND_BYTES = 512;
const KIND_ID = /^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u;

/** Whether a value, such as one read from the URL, can name a type: lowercase words joined by single hyphens. */
export function isKindId(value: string): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= MAX_KIND_BYTES &&
    value === value.toLowerCase() &&
    KIND_ID.test(value)
  );
}

function words(kind: NoteKind): string[] {
  return kind.split("-").filter((w) => w.length > 0);
}

function capitalise(word: string): string {
  const [head = "", ...rest] = Array.from(word);
  return head.toLocaleUpperCase() + rest.join("");
}

/** "design-review" → "Design review". Sentence case, like the rest of the app. */
export function kindLabel(kind: NoteKind): string {
  const [first, ...rest] = words(kind);
  if (first === undefined) return capitalise(UNTYPED_KIND);
  return [capitalise(first), ...rest].join(" ");
}

const IRREGULAR: Readonly<Record<string, string>> = {
  analysis: "analyses",
  child: "children",
  criterion: "criteria",
  person: "people",
};

function pluralWord(word: string): string {
  const irregular = IRREGULAR[word];
  if (irregular !== undefined) return irregular;
  if (/(?:ss|x|z|ch|sh)$/.test(word)) return `${word}es`;
  // A last word already ending in "s" is read as plural, as in "release-notes".
  if (word.endsWith("s")) return word;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function pluralWords(kind: NoteKind): string[] {
  const all = words(kind);
  const last = all.pop();
  return last === undefined ? [`${UNTYPED_KIND}s`] : [...all, pluralWord(last)];
}

/** "design-review" → "Design reviews", for headings, chips and legend rows. */
export function kindLabelPlural(kind: NoteKind): string {
  const [first = "", ...rest] = pluralWords(kind);
  return [capitalise(first), ...rest].join(" ");
}

/** The noun for a count in running text, lowercase: "decision" for 1, "design reviews" otherwise. */
export function kindNoun(kind: NoteKind, count: number): string {
  if (count === 1) return words(kind).join(" ") || UNTYPED_KIND;
  return pluralWords(kind).join(" ");
}

export interface KindCount {
  kind: NoteKind;
  count: number;
}

/** Each type among the items and how many carry it: most common first, then by label. */
export function kindCounts(items: Iterable<{ kind: NoteKind }>): KindCount[] {
  const counts = new Map<NoteKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || kindLabel(a.kind).localeCompare(kindLabel(b.kind)));
}
