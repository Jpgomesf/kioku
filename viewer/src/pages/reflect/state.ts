// Pure settings logic for the Reflect page, kept apart from React so it is easy to test.
import type {
  AfterSaves,
  Finding,
  Harness,
  ReflectMode,
  ReflectPermission,
  ReflectRoles,
  ReflectRun,
  ReflectSettings,
} from "../../api";

export type RoleName = keyof ReflectRoles;

export const ROLE_LABELS: Record<RoleName, string> = {
  worker: "Check each topic",
  reviewer: "Try to disprove each finding",
  report: "Write the report",
};

export const ROLE_NAMES: readonly RoleName[] = ["worker", "reviewer", "report"];

export const DEFAULT_THRESHOLD = 25;
export const DEFAULT_NIGHTLY = "02:00";

/** The harnesses picked at first: those named in a role, plus any that are ready. */
export function initialSelection(settings: ReflectSettings): string[] {
  const inRoles = new Set(Object.values(settings.roles));
  return settings.harnesses
    .filter((h) => h.status === "ready" || inRoles.has(h.id))
    .map((h) => h.id);
}

/** Selected harnesses, in the settings' order. */
export function selectedHarnesses(
  settings: ReflectSettings,
  selected: readonly string[],
): Harness[] {
  return settings.harnesses.filter((h) => selected.includes(h.id));
}

/**
 * Toggle a harness and move any role it held to a harness still selected. An orphaned
 * reviewer goes to one that isn't the worker, unless the worker is the only one left.
 */
export function toggleHarness(
  settings: ReflectSettings,
  selected: readonly string[],
  id: string,
): { settings: ReflectSettings; selected: string[] } {
  const nextSelected = selected.includes(id)
    ? selected.filter((s) => s !== id)
    : settings.harnesses.map((h) => h.id).filter((h) => h === id || selected.includes(h));
  const fallback = nextSelected[0];
  const roles = { ...settings.roles };
  if (fallback !== undefined) {
    if (!nextSelected.includes(roles.worker)) roles.worker = fallback;
    if (!nextSelected.includes(roles.reviewer)) {
      roles.reviewer = nextSelected.find((h) => h !== roles.worker) ?? fallback;
    }
    if (!nextSelected.includes(roles.report)) roles.report = fallback;
  }
  return { settings: { ...settings, roles }, selected: nextSelected };
}

export function setRole(settings: ReflectSettings, role: RoleName, id: string): ReflectSettings {
  return { ...settings, roles: { ...settings.roles, [role]: id } };
}

export function setMode(settings: ReflectSettings, mode: ReflectMode): ReflectSettings {
  return { ...settings, mode };
}

export function setPermission(
  settings: ReflectSettings,
  permission: ReflectPermission,
): ReflectSettings {
  return { ...settings, permission };
}

export function setAfterImport(settings: ReflectSettings, on: boolean): ReflectSettings {
  return { ...settings, triggers: { ...settings.triggers, afterImport: on } };
}

export function setNightly(settings: ReflectSettings, on: boolean): ReflectSettings {
  return {
    ...settings,
    triggers: { ...settings.triggers, nightlyAt: on ? DEFAULT_NIGHTLY : null },
  };
}

/**
 * Turn the "after N changed notes" trigger on or off. Turning it back on restores the last
 * value seen, because the backend owns the soFar counter and the client must not reset it.
 */
export function setAfterSavesOn(
  settings: ReflectSettings,
  on: boolean,
  previous: AfterSaves | null,
): ReflectSettings {
  const afterSaves = on
    ? (settings.triggers.afterSaves ?? previous ?? { threshold: DEFAULT_THRESHOLD, soFar: 0 })
    : null;
  return { ...settings, triggers: { ...settings.triggers, afterSaves } };
}

/** Parse a threshold draft: a whole number, clamped to 1..10,000, or null if it isn't one. */
export function parseThreshold(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  return Math.min(10_000, Math.max(1, value));
}

/** Keep the threshold a whole number from 1 to 10,000; ignore input that isn't one. */
export function setThreshold(settings: ReflectSettings, raw: string): ReflectSettings {
  const current = settings.triggers.afterSaves;
  const value = parseThreshold(raw);
  if (!current || value === null) return settings;
  const threshold = Math.min(10_000, Math.max(1, value));
  return { ...settings, triggers: { ...settings.triggers, afterSaves: { ...current, threshold } } };
}

/** The plain-language line under "Next run". */
export function nextRunText(settings: ReflectSettings): string {
  if (settings.mode === "manual") return "Only when you run the command or press Run now.";
  const { afterImport, nightlyAt, afterSaves } = settings.triggers;
  const parts: string[] = [];
  if (afterImport) parts.push("after the next KB import");
  if (afterSaves) {
    const left = Math.max(0, afterSaves.threshold - afterSaves.soFar);
    parts.push(
      left === 0
        ? "at the next note change"
        : `once ${left} more ${left === 1 ? "note changes" : "notes change"}`,
    );
  }
  if (nightlyAt) parts.push(`tonight at ${nightlyAt}`);
  if (parts.length === 0) return "No trigger is on, so it runs only when you press Run now.";
  const text =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
  return `${text?.charAt(0).toUpperCase()}${text?.slice(1)}.`;
}

/** "Anthropic · can read personal and work" */
export function harnessDetail(h: Harness): string {
  const vaults = h.vaultsReadable;
  if (h.status === "not-connected") return `${h.provider} · not connected to Kioku`;
  if (vaults.length === 0) return `${h.provider} · can read no vault`;
  if (vaults.length === 1) return `${h.provider} · can read ${vaults[0]} only`;
  return `${h.provider} · can read ${vaults.slice(0, -1).join(", ")} and ${vaults.at(-1)}`;
}

/** A muted warning when one app would both check and disprove findings. */
export function sameAppWarning(settings: ReflectSettings): string | null {
  const { worker, reviewer } = settings.roles;
  if (!worker || worker !== reviewer) return null;
  const name = settings.harnesses.find((h) => h.id === worker)?.name ?? worker;
  return `${name} would check its own findings. Pick a different app to disprove them.`;
}

/** Why each role holder can't work on an area in `vault`, in plain language. */
export function roleProblems(settings: ReflectSettings, vault: string | null): string[] {
  const ids = [...new Set(ROLE_NAMES.map((r) => settings.roles[r]))];
  const out: string[] = [];
  for (const id of ids) {
    const h = settings.harnesses.find((x) => x.id === id);
    if (!h) continue;
    if (h.status === "not-connected") out.push(`${h.name} isn't connected to Kioku.`);
    else if (h.status === "needs-skill") out.push(`${h.name} needs the reflect skill first.`);
    if (vault && h.status !== "not-connected" && !h.vaultsReadable.includes(vault)) {
      out.push(`${h.name} can't read ${vault}, so it can't check this area.`);
    }
  }
  return out;
}

/** True when the worker and reviewer can both run on an area in `vault`. */
export function canRun(settings: ReflectSettings, vault: string | null): boolean {
  return [settings.roles.worker, settings.roles.reviewer].every((id) => {
    const h = settings.harnesses.find((x) => x.id === id);
    if (h?.status !== "ready") return false;
    return vault === null || h.vaultsReadable.includes(vault);
  });
}

/** "Codex only checks work, the vault OpenAI may read." when the reviewer reads less. */
export function reachText(settings: ReflectSettings): string | null {
  const worker = settings.harnesses.find((h) => h.id === settings.roles.worker);
  const reviewer = settings.harnesses.find((h) => h.id === settings.roles.reviewer);
  if (!worker || !reviewer || worker.id === reviewer.id) return null;
  const vaults = reviewer.vaultsReadable;
  if (vaults.length === 0 || vaults.length >= worker.vaultsReadable.length) return null;
  const list =
    vaults.length === 1 ? vaults[0] : `${vaults.slice(0, -1).join(", ")} and ${vaults.at(-1)}`;
  const noun = vaults.length === 1 ? "the vault" : "the vaults";
  return `${reviewer.name} only checks ${list}, ${noun} ${reviewer.provider} may read.`;
}

/** "5 Nov", with the year when it isn't the current one. */
export { formatDay } from "../../app/dates";

/** The short label of an area: "personal/kioku" gives "kioku". */
export function areaLabel(domain: string): string {
  return domain.split("/").at(-1) || domain;
}

export interface OpenFinding {
  run: ReflectRun;
  finding: Finding;
}

/**
 * Open findings across every finished run, newest run first, each finding once by id. A
 * newer run with no findings doesn't hide what older runs still have open.
 */
export function openFindings(runs: readonly ReflectRun[]): OpenFinding[] {
  const sorted = runs
    .filter((r) => r.finishedAt !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const seen = new Set<string>();
  const out: OpenFinding[] = [];
  for (const run of sorted) {
    for (const finding of run.findings) {
      if (seen.has(finding.id)) continue;
      seen.add(finding.id);
      out.push({ run, finding });
    }
  }
  return out;
}

/** A run that hasn't finished this long after it started is treated as stalled. */
export const MAX_WAIT_MS = 10 * 60 * 1000;

function startedMs(run: ReflectRun): number {
  const t = Date.parse(run.startedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** True when a run never finished and started more than MAX_WAIT_MS ago. */
export function isStalled(run: ReflectRun, now: number = Date.now()): boolean {
  return run.finishedAt === null && now - startedMs(run) > MAX_WAIT_MS;
}

/** True while a run is going: not finished and not stalled. */
export function isRunning(run: ReflectRun, now: number = Date.now()): boolean {
  return run.finishedAt === null && !isStalled(run, now);
}

/** The newest finished run, or null. */
export function latestFinished(runs: readonly ReflectRun[]): ReflectRun | null {
  let latest: ReflectRun | null = null;
  for (const run of runs) {
    if (run.finishedAt === null) continue;
    if (!latest || startedMs(run) > startedMs(latest)) latest = run;
  }
  return latest;
}

/** Open findings across finished runs that a different model confirmed. */
export function confirmedOpen(runs: readonly ReflectRun[]): OpenFinding[] {
  return openFindings(runs).filter((o) => o.finding.state === "confirmed");
}
