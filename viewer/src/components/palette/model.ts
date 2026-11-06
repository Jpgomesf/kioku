// What the palette lists for a query: notes from search, then commands. Pure, so it is tested.
import type { MatchedBy, NoteKind, NoteSummary, SearchHit } from "../../api";
import { hasCommandKey } from "../../app/overlay";
import { graphHref, libraryHref, noteHref } from "../../app/router";
import { readLastVisit } from "../../pages/library/useLastVisit";
import type { IconName } from "../ui/Icon";

export type PaletteSection = "Recent" | "Notes" | "Commands";

export type PaletteAction = { type: "navigate"; href: string } | { type: "search-vault" };

export interface PaletteOption {
  id: string;
  section: PaletteSection;
  label: string;
  /** The note key, shown in mono before the label. */
  code?: string;
  meta?: string;
  /** Shown before a command's label. */
  icon?: IconName;
  /** Shortcut hint shown on the right. */
  hint?: string;
  action: PaletteAction;
  /** Where ⌘Enter goes: the note in the graph. */
  graphHref?: string;
}

interface Command {
  id: string;
  label: string;
  words: string;
  icon: IconName;
  action: PaletteAction;
}

const KIND_LABEL: Record<NoteKind, string> = {
  decision: "Decision",
  question: "Question",
  item: "Item",
  fix: "Fix",
  convention: "Convention",
  preference: "Preference",
  note: "Note",
  topic: "Topic",
  ticket: "Ticket",
  "pull-request": "Pull request",
};

const MATCH_WORD: Record<Exclude<MatchedBy, "linked">, string> = {
  label: "name",
  text: "words",
  meaning: "meaning",
};

/** "matched words and meaning", or "linked from X" for a link-filled hit. */
export function matchedByText(hit: Pick<SearchHit, "matchedBy" | "linkedFrom">): string {
  const words = hit.matchedBy
    .filter((m): m is Exclude<MatchedBy, "linked"> => m !== "linked")
    .map((m) => MATCH_WORD[m]);
  if (words.length > 0) {
    const list =
      words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
    return `matched ${list}`;
  }
  if (hit.matchedBy.includes("linked")) {
    return hit.linkedFrom ? `linked from ${hit.linkedFrom}` : "linked";
  }
  return "matched";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "5 Nov" for 2026-11-05. */
export function shortDate(iso: string): string {
  const [, month, day] = iso.slice(0, 10).split("-").map(Number);
  return `${day ?? ""} ${MONTHS[(month ?? 1) - 1] ?? ""}`.trim();
}

/** since: the YYYY-MM-DD date the "changed since" command filters from. */
export function commands(since: string): Command[] {
  return [
    {
      id: "go-library",
      label: "Go to Library",
      words: "notes list",
      icon: "library",
      action: nav(libraryHref()),
    },
    // No domain in the URL, so the graph follows the current area.
    { id: "go-graph", label: "Go to Graph", words: "map", icon: "graph", action: nav("#/graph") },
    {
      id: "go-health",
      label: "Go to Health",
      words: "services status check",
      icon: "health",
      action: nav("#/health"),
    },
    {
      id: "go-reflect",
      label: "Go to Reflect",
      words: "findings audit",
      icon: "finding",
      action: nav("#/reflect"),
    },
    { id: "go-guide", label: "Go to Guide", words: "help", icon: "book", action: nav("#/guide") },
    {
      id: "changes",
      label: `Show notes changed since ${shortDate(since)}`,
      words: "new recent updated changes last visit",
      icon: "library",
      action: nav(libraryHref({ since })),
    },
    {
      id: "open-vaults",
      label: "Open vaults",
      words: "visibility apps access",
      icon: "lock",
      action: nav("#/vaults"),
    },
  ];
}

function nav(href: string): PaletteAction {
  return { type: "navigate", href };
}

function matches(command: Command, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${command.label} ${command.words}`.toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

export interface BuildInput {
  query: string;
  hits: readonly SearchHit[];
  /** Recently changed notes in the area, shown while the query is empty. */
  recent: readonly NoteSummary[];
  /** YYYY-MM-DD date for the "changed since" command. */
  since: string;
  /** Vault name for the "Search all of" command; null when unknown. */
  vault: string | null;
  /** True once the search widened to the whole vault. */
  wholeVault: boolean;
}

export function buildOptions({
  query,
  hits,
  recent,
  since,
  vault,
  wholeVault,
}: BuildInput): PaletteOption[] {
  const text = query.trim();
  const recentNotes: PaletteOption[] = text
    ? []
    : recent.map((note) => ({
        id: `recent:${note.domain}:${note.key}`,
        section: "Recent",
        code: note.key,
        label: note.title,
        meta: KIND_LABEL[note.kind],
        action: nav(noteHref(note.domain, note.key)),
        graphHref: graphHref(note.domain, note.key),
      }));
  const notes: PaletteOption[] = text
    ? hits.map((hit) => ({
        id: `note:${hit.note.domain}:${hit.note.key}`,
        section: "Notes",
        code: hit.note.key,
        label: hit.note.title,
        meta: `${KIND_LABEL[hit.note.kind]} · ${matchedByText(hit)}`,
        action: nav(noteHref(hit.note.domain, hit.note.key)),
        graphHref: graphHref(hit.note.domain, hit.note.key),
      }))
    : [];

  const extra: PaletteOption[] = [];
  if (text && vault && !wholeVault) {
    extra.push({
      id: "search-vault",
      section: "Commands",
      label: `Search all of ${vault} for “${text}”`,
      hint: "⇥",
      icon: "search",
      action: { type: "search-vault" },
    });
  }
  if (text) {
    extra.push({
      id: "library-matches",
      section: "Commands",
      label: "Show every match in Library",
      icon: "library",
      action: nav(libraryHref({ q: text })),
    });
  }
  const listed: PaletteOption[] = commands(since)
    .filter((c) => matches(c, text))
    .map((c) => ({
      id: c.id,
      section: "Commands",
      label: c.label,
      icon: c.icon,
      action: c.action,
    }));

  return [...recentNotes, ...notes, ...extra, ...listed];
}

/**
 * The Library's last visit to this area (YYYY-MM-DD), else seven days ago, as the Library's
 * own chip does. Read-only: the Library records visits.
 */
export function sinceDate(domain: string, now: number = Date.now()): string {
  const visit = readLastVisit(domain);
  if (visit !== null && !Number.isNaN(Date.parse(visit))) return visit.slice(0, 10);
  return new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
}

export type PaletteKey = "up" | "down" | "open" | "open-graph" | "tab";

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** True while an input method is composing text: its keys are left alone. */
  isComposing?: boolean;
}

/** Which palette action a key press means, or null to let it through. mac picks ⌘ over Ctrl. */
export function paletteKey(event: KeyInput, mac: boolean): PaletteKey | null {
  if (event.altKey || event.isComposing) return null;
  switch (event.key) {
    case "ArrowDown":
      return "down";
    case "ArrowUp":
      return "up";
    case "Enter":
      if (!event.metaKey && !event.ctrlKey) return "open";
      return hasCommandKey(event, mac) ? "open-graph" : null;
    case "Tab":
      return event.shiftKey ? null : "tab";
    default:
      return null;
  }
}
