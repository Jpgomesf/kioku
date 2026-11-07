import type {
  Area,
  DomainStats,
  NoteSummary,
  ReflectRun,
  ServiceState,
  ServiceStatus,
  Vault,
} from "../../api";
import { embeddingServiceName } from "../../api/health/where";
import { formatDay as sharedFormatDay } from "../../app/dates";
import type { PillTone } from "../../components/ui/StatusPill";
import { isRunning, latestFinished } from "../reflect/state";

export interface AreaRow {
  domain: string;
  label: string;
  /** Null when no area record or vault names the domain: shown without "in <vault>". */
  vault: string | null;
  active: number;
  legacy: number;
}

export interface ServiceCard {
  id: "postgres" | "qdrant" | "ollama";
  name: string;
  role: string;
  state: ServiceState;
  detail: string;
}

export interface ReflectSummary {
  run: ReflectRun;
  confirmed: number;
  unverified: number;
}

const numberFormat = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return numberFormat.format(n);
}

/** The vault whose domains hold this domain, matched exactly or as a parent area. */
export function vaultFor(domain: string, vaults: Vault[]): string | null {
  for (const vault of vaults) {
    if (vault.domains.some((d) => d === domain || domain.startsWith(`${d}/`))) return vault.name;
  }
  return null;
}

/** The label for a domain, never repeating the vault. */
export function labelFor(domain: string, areas: Area[], vaults: Vault[] = []): string {
  const area = areas.find((a) => a.domain === domain);
  if (area) return area.label;
  const vault = vaultFor(domain, vaults);
  if (vault && domain.startsWith(`${vault}/`)) return domain.slice(vault.length + 1);
  return domain;
}

export function areaRows(stats: DomainStats[], areas: Area[], vaults: Vault[] = []): AreaRow[] {
  const byDomain = new Map(areas.map((a) => [a.domain, a]));
  return stats
    .map((s) => {
      const area = byDomain.get(s.domain);
      const vault = area ? area.vault : vaultFor(s.domain, vaults);
      const label = labelFor(s.domain, areas, vaults);
      return { domain: s.domain, label, vault, active: s.active, legacy: s.legacy };
    })
    .sort((a, b) => (a.vault ?? "").localeCompare(b.vault ?? "") || a.label.localeCompare(b.label));
}

export function totals(rows: AreaRow[]): { active: number; legacy: number } {
  return rows.reduce((t, r) => ({ active: t.active + r.active, legacy: t.legacy + r.legacy }), {
    active: 0,
    legacy: 0,
  });
}

const RANK: Record<ServiceState, number> = { running: 0, degraded: 1, down: 2 };

export function worstState(states: ServiceState[]): ServiceState {
  return states.reduce<ServiceState>((w, s) => (RANK[s] > RANK[w] ? s : w), "running");
}

export function overallLabel(state: ServiceState): string {
  if (state === "running") return "All services running";
  if (state === "degraded") return "Some services degraded";
  return "A service is down";
}

export const STATE_LABEL: Record<ServiceState, string> = {
  running: "Running",
  degraded: "Degraded",
  down: "Not reachable",
};

export const STATE_TONE: Record<ServiceState, PillTone> = {
  running: "active",
  degraded: "finding",
  down: "down",
};

export function serviceCards(status: ServiceStatus, pendingVectors: number): ServiceCard[] {
  const waiting = `${formatCount(pendingVectors)} ${pendingVectors === 1 ? "note" : "notes"} waiting`;
  return [
    {
      id: "postgres",
      name: "PostgreSQL",
      role: "Source of truth: notes, links and revisions",
      state: status.postgres.state,
      detail: status.postgres.detail,
    },
    {
      id: "qdrant",
      name: "Qdrant",
      role: `Vector index, rebuilt from PostgreSQL · ${waiting}`,
      state: status.qdrant.state,
      detail: status.qdrant.detail,
    },
    {
      id: "ollama",
      name: embeddingServiceName(status),
      role: status.embeddingLocal
        ? `Embeddings with ${status.embeddingModel}, on this computer`
        : `Embeddings with ${status.embeddingModel}, sent to ${status.embeddingReader}`,
      state: status.ollama.state,
      detail: status.ollama.detail,
    },
  ];
}

function startTime(run: ReflectRun): number {
  const t = Date.parse(run.startedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function newest(runs: ReflectRun[]): ReflectRun | null {
  let latest: ReflectRun | null = null;
  for (const run of runs) {
    if (!latest || startTime(run) > startTime(latest)) latest = run;
  }
  return latest;
}

/** The most recent finished run across every area, by parsed start time. */
export function latestRun(runs: ReflectRun[]): ReflectRun | null {
  return latestFinished(runs);
}

/**
 * The newest run still in progress, if it started after the last finished one. A run that
 * never finished long after it started is stalled and doesn't count.
 */
export function runningRun(runs: ReflectRun[], now: number = Date.now()): ReflectRun | null {
  const running = newest(runs.filter((r) => isRunning(r, now)));
  const finished = latestRun(runs);
  if (!running) return null;
  if (finished && startTime(finished) >= startTime(running)) return null;
  return running;
}

export function summarizeRun(run: ReflectRun | null): ReflectSummary | null {
  if (!run) return null;
  const confirmed = run.findings.filter((f) => f.state === "confirmed").length;
  return { run, confirmed, unverified: run.findings.length - confirmed };
}

export function draftsOnly(notes: NoteSummary[]): NoteSummary[] {
  return notes.filter((n) => n.status === "draft");
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export const formatDay = (iso: string): string => sharedFormatDay(iso);

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFormat.format(d);
}

export function formatChecked(date: Date): string {
  return `${dateFormat.format(date)} ${timeFormat.format(date)}`;
}

export const REFRESH_COMMAND = "/memory-refresh";

/** How many drafts to ask for per area, and to show. */
export const DRAFT_LIMIT = 5;
