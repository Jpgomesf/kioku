import type { ReleaseNote } from "../../api";

export interface ReleaseEntry extends ReleaseNote {
  isCurrent: boolean;
}

/** Compares dotted versions numerically; a pre-release tag sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const length = Math.max(coreA.length, coreB.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (coreA[i] ?? 0) - (coreB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === preB) return 0;
  if (preA === null) return 1;
  if (preB === null) return -1;
  return comparePrerelease(preA, preB);
}

/** SemVer section 11: numeric identifiers compare as numbers and rank below text ones. */
function comparePrerelease(a: string, b: string): number {
  const idsA = a.split(".");
  const idsB = b.split(".");
  const length = Math.min(idsA.length, idsB.length);
  for (let i = 0; i < length; i += 1) {
    const x = idsA[i] ?? "";
    const y = idsB[i] ?? "";
    const numX = /^\d+$/.test(x);
    const numY = /^\d+$/.test(y);
    if (numX && numY) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (numX !== numY) {
      return numX ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return idsA.length - idsB.length;
}

function splitVersion(version: string): [number[], string | null] {
  const clean = version.trim().replace(/^v/, "");
  const dash = clean.indexOf("-");
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? null : clean.slice(dash + 1);
  const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return [parts, pre];
}

/**
 * One entry per version, newest first. Notes that share a version merge their
 * changes in order, keeping the first title and the latest date.
 */
export function groupReleaseNotes(
  notes: ReleaseNote[],
  currentVersion: string | null,
): ReleaseEntry[] {
  const byVersion = new Map<string, ReleaseNote>();
  for (const note of notes) {
    const key = note.version.trim().replace(/^v/, "");
    const existing = byVersion.get(key);
    if (existing === undefined) {
      byVersion.set(key, { ...note, version: key, changes: [...new Set(note.changes)] });
    } else {
      for (const change of note.changes) {
        if (!existing.changes.includes(change)) existing.changes.push(change);
      }
      if ((note.date ?? "") > (existing.date ?? "")) existing.date = note.date;
      if (existing.title === "") existing.title = note.title;
    }
  }
  const current = currentVersion === null ? null : currentVersion.trim().replace(/^v/, "");
  return [...byVersion.values()]
    .sort(
      (a, b) => compareVersions(b.version, a.version) || (b.date ?? "").localeCompare(a.date ?? ""),
    )
    .map((note) => ({ ...note, isCurrent: note.version === current }));
}

/** True when the date starts with an ISO calendar date, so it fits a `<time dateTime>`. */
export function isIsoDate(date: string | null): date is string {
  return date !== null && /^\d{4}-\d{2}-\d{2}/.test(date);
}

/**
 * "2026-11-06" as "6 Nov", adding the year only outside the current one.
 * Anything unparseable is returned as is.
 */
export function formatReleaseDate(date: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (match === null) return date;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months[Number(match[2]) - 1];
  if (month === undefined) return date;
  const day = `${Number(match[3])} ${month}`;
  return Number(match[1]) === now.getFullYear() ? day : `${day} ${match[1]}`;
}
