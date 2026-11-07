// Obsidian-style search queries for the graph's filter and colour groups. A query is a list of
// terms that must all match; parsing never throws, so whatever the viewer types is usable.

export interface QueryTarget {
  key: string;
  title: string;
  kind: string;
}

type Field = "type" | "path" | "text";

interface Term {
  field: Field;
  value: string;
  negate: boolean;
}

/** A parsed query. Treat it as opaque: build it with parseQuery, use it with matchesQuery. */
export type Query = { readonly terms: readonly Term[] };

/** Same shape as a type id: lowercase words joined by single hyphens, so "Design review" finds design-review. */
function normaliseType(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0)
    .join("-");
}

/** Splits on spaces, keeping "quoted phrases" (also after an operator, as in type:"design review") whole. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

function toTerm(token: string): Term | null {
  let rest = token;
  let negate = false;
  if (rest.startsWith("-") && rest.length > 1) {
    negate = true;
    rest = rest.slice(1);
  }
  const match = /^(type|path):(.*)$/i.exec(rest);
  if (match) {
    const field = (match[1] ?? "").toLowerCase() as Field;
    const raw = match[2] ?? "";
    const value = field === "type" ? normaliseType(raw) : raw.trim();
    // "type:" with nothing after it is still being typed; ignore it instead of matching nothing.
    return value === "" ? null : { field, value, negate };
  }
  const value = rest.trim().toLowerCase();
  return value === "" ? null : { field: "text", value, negate };
}

export function parseQuery(text: string): Query {
  const terms: Term[] = [];
  for (const token of tokens(typeof text === "string" ? text : "")) {
    const term = toTerm(token);
    if (term) terms.push(term);
  }
  return { terms };
}

function termMatches(term: Term, note: QueryTarget): boolean {
  switch (term.field) {
    case "type":
      return note.kind === term.value;
    case "path":
      return note.key.startsWith(term.value);
    case "text":
      return (
        note.title.toLowerCase().includes(term.value) || note.key.toLowerCase().includes(term.value)
      );
  }
}

/** Whether every term matches; the empty query matches everything. */
export function matchesQuery(query: Query, note: QueryTarget): boolean {
  return query.terms.every((term) => termMatches(term, note) !== term.negate);
}

/** The colour of the first group whose query matches, as in Obsidian; empty group queries match nothing. */
export function groupColour(
  groups: ReadonlyArray<{ query: Query; color: string }>,
  note: QueryTarget,
): string | null {
  for (const group of groups) {
    if (group.query.terms.length > 0 && matchesQuery(group.query, note)) return group.color;
  }
  return null;
}
