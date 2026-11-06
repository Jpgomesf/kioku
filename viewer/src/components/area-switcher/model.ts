// What the area switcher lists: Recent first, then areas grouped by vault. A query matches
// area names, vault names and folder paths. Pure, so it is tested.
import type { Area } from "../../api";

export interface AreaEntry {
  area: Area;
  /** Folders mapped to this area in the vaults file. */
  paths: readonly string[];
}

export interface AreaGroup {
  /** "Recent", or a vault name. */
  title: string;
  /** Unique per group so Recent and the vault group can list the same area. */
  id: string;
  areas: Area[];
}

export function matchesArea(entry: AreaEntry, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [entry.area.label, entry.area.domain, entry.area.vault, ...entry.paths]
    .join(" ")
    .toLowerCase();
  return words.every((word) => hay.includes(word));
}

export function groupAreas(
  entries: readonly AreaEntry[],
  query: string,
  recent: readonly string[],
): AreaGroup[] {
  const found = entries.filter((e) => matchesArea(e, query));
  const groups: AreaGroup[] = [];
  const shown = new Set<string>();
  if (!query.trim()) {
    const recentAreas = recent
      .map((domain) => found.find((e) => e.area.domain === domain)?.area)
      .filter((a): a is Area => a !== undefined);
    for (const a of recentAreas) shown.add(a.domain);
    if (recentAreas.length > 0) groups.push({ title: "Recent", id: "recent", areas: recentAreas });
  }
  const vaults: string[] = [];
  for (const e of found) if (!vaults.includes(e.area.vault)) vaults.push(e.area.vault);
  for (const vault of vaults) {
    // An area shown in Recent isn't repeated in its vault's group.
    const areas = found
      .filter((e) => e.area.vault === vault && !shown.has(e.area.domain))
      .map((e) => e.area);
    if (areas.length > 0) groups.push({ title: vault, id: `vault-${vault}`, areas });
  }
  return groups;
}

/** "1,594" or "empty": the bare note count the board shows. */
export function countLabel(area: Pick<Area, "noteCount">): string {
  if (area.noteCount === 0) return "empty";
  return area.noteCount.toLocaleString("en-US");
}

/** Spoken form of the count, such as "1,594 notes". */
export function countWords(area: Pick<Area, "noteCount">): string {
  if (area.noteCount === 0) return "empty";
  return `${countLabel(area)} ${area.noteCount === 1 ? "note" : "notes"}`;
}

export type AreaKey = "up" | "down" | "open";

/** Which switcher action a key press means, or null to let it through. */
export function areaKey(event: {
  key: string;
  altKey: boolean;
  isComposing?: boolean;
}): AreaKey | null {
  if (event.altKey || event.isComposing) return null;
  if (event.key === "ArrowDown") return "down";
  if (event.key === "ArrowUp") return "up";
  if (event.key === "Enter") return "open";
  return null;
}

/** Flatten the groups into the order the arrow keys move through. */
export function flatOptions(groups: readonly AreaGroup[]): { id: string; area: Area }[] {
  return groups.flatMap((g) => g.areas.map((area) => ({ id: `${g.id}:${area.domain}`, area })));
}
