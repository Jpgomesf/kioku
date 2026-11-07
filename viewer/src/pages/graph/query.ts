// Obsidian-style search queries for the graph's filter and colour groups. A query is a list of
// terms that must all match; parsing never throws, so whatever the viewer types is usable.

export interface QueryTarget {
  key: string;
  title: string;
  kind: string;
  tags: readonly string[];
}

/** What a query term looks at: a type, a path prefix, a tag, or words in the title or key. */
export type QueryField = "type" | "path" | "tag" | "text";

interface Term {
  field: QueryField;
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

/** Tags compare without case or a leading #, so tag:#Idea and tag:idea both find "idea". */
function normaliseTag(text: string): string {
  return text.trim().replace(/^#+/, "").toLowerCase();
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
  const match = /^(type|path|tag):(.*)$/i.exec(rest);
  if (match) {
    const field = (match[1] ?? "").toLowerCase() as QueryField;
    const raw = match[2] ?? "";
    const value =
      field === "type" ? normaliseType(raw) : field === "tag" ? normaliseTag(raw) : raw.trim();
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
    case "tag":
      return note.tags.some((t) => normaliseTag(t) === term.value);
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

/** The query's only term when it has one and it is not negated, as a group made for one type
 * or one tag is written ("type:decision"), so the group can be named after it; else null. */
export function soleTerm(query: Query): { field: QueryField; value: string } | null {
  const [term, ...rest] = query.terms;
  return term && rest.length === 0 && !term.negate
    ? { field: term.field, value: term.value }
    : null;
}

/**
 * The position of the first group whose query matches, as in Obsidian, or -1 when none does.
 * Empty group queries match nothing. A note's colour and the cluster it is separated into
 * both come from this one group, so they always agree.
 */
export function groupIndex(groups: ReadonlyArray<{ query: Query }>, note: QueryTarget): number {
  return groups.findIndex(
    (group) => group.query.terms.length > 0 && matchesQuery(group.query, note),
  );
}

/** The colour of the note's group (see groupIndex), or null when no group matches. */
export function groupColour(
  groups: ReadonlyArray<{ query: Query; color: string }>,
  note: QueryTarget,
): string | null {
  return groups[groupIndex(groups, note)]?.color ?? null;
}
