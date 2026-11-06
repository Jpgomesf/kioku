import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Area,
  getServiceStatus,
  getStats,
  listAreas,
  listNotes,
  listReflectRuns,
  listVaults,
  type NoteSummary,
  type ReflectRun,
  type ServiceStatus,
  type Stats,
  type Vault,
} from "../../api";
import { libraryHref, noteHref, reflectHref } from "../../app/router";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { StatusPill } from "../../components/ui/StatusPill";
import { showToast } from "../../components/ui/Toast";
import { usePrefersReducedMotion } from "../../motion";
import {
  areaRows,
  DRAFT_LIMIT,
  draftsOnly,
  formatChecked,
  formatCount,
  formatDay,
  formatTime,
  labelFor,
  latestRun,
  overallLabel,
  REFRESH_COMMAND,
  runningRun,
  STATE_LABEL,
  STATE_TONE,
  serviceCards,
  summarizeRun,
  totals,
  worstState,
} from "./derive";
import "./health.css";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Drafts {
  notes: NoteSummary[];
  /** True when an area returned the full limit, so there may be more. */
  capped: boolean;
  failedAreas: number;
}

export interface Runs {
  latest: ReflectRun | null;
  running: ReflectRun | null;
  failedAreas: number;
}

export interface HealthData {
  status: Result<ServiceStatus>;
  stats: Result<Stats>;
  areas: Area[];
  vaults: Vault[];
  drafts: Result<Drafts>;
  runs: Result<Runs>;
  checkedAt: Date;
}

function errorText(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const { message } = err as { message: unknown };
    if (typeof message === "string") return message;
  }
  return "Kioku did not answer.";
}

function settle<T>(r: PromiseSettledResult<T>): Result<T> {
  return r.status === "fulfilled"
    ? { ok: true, value: r.value }
    : { ok: false, error: errorText(r.reason) };
}

function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/** Per area, so one failing area keeps the rest. Fails only when every area fails. */
async function perDomain<T, R>(
  domains: string[],
  load: (domain: string) => Promise<T>,
  combine: (values: T[], failed: number) => R,
): Promise<Result<R>> {
  const results = await Promise.allSettled(domains.map(load));
  const values = fulfilled(results);
  const failed = results.length - values.length;
  const firstError = results.find((r) => r.status === "rejected");
  if (domains.length > 0 && values.length === 0 && firstError) {
    return settle(firstError as PromiseSettledResult<R>);
  }
  return { ok: true, value: combine(values, failed) };
}

export async function loadHealth(): Promise<HealthData> {
  const [status, stats, areas, vaults] = await Promise.allSettled([
    getServiceStatus(),
    getStats(),
    listAreas(),
    listVaults(),
  ]);
  const statsResult = settle(stats);
  const domains = statsResult.ok ? statsResult.value.domains.map((d) => d.domain) : [];
  const failedStats: Result<never> = {
    ok: false,
    error: statsResult.ok ? "" : statsResult.error,
  };
  const [drafts, runs] = await Promise.all([
    statsResult.ok
      ? perDomain(
          domains,
          (domain) => listNotes({ domain, status: "draft", limit: DRAFT_LIMIT }),
          (lists, failedAreas): Drafts => ({
            notes: draftsOnly(lists.flat()),
            capped: lists.some((l) => l.length >= DRAFT_LIMIT),
            failedAreas,
          }),
        )
      : failedStats,
    statsResult.ok
      ? perDomain(domains, listReflectRuns, (lists, failedAreas): Runs => {
          const all = lists.flat();
          return { latest: latestRun(all), running: runningRun(all), failedAreas };
        })
      : failedStats,
  ]);
  return {
    status: settle(status),
    stats: statsResult,
    areas: areas.status === "fulfilled" ? areas.value : [],
    vaults: vaults.status === "fulfilled" ? vaults.value : [],
    drafts,
    runs,
    checkedAt: new Date(),
  };
}

export function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const latest = useRef(0);
  const inFlight = useRef(false);
  const reduced = usePrefersReducedMotion();

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    latest.current += 1;
    const id = latest.current;
    setBusy(true);
    loadHealth()
      .then((d) => {
        if (id !== latest.current) return;
        setData(d);
        setLoadId(id);
      })
      .finally(() => {
        if (id !== latest.current) return;
        inFlight.current = false;
        setBusy(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    return () => {
      latest.current += 1;
      inFlight.current = false;
    };
  }, [refresh]);

  const copyCommand = () => {
    const done = () => showToast({ tone: "ok", text: `Copied ${REFRESH_COMMAND}` });
    if (!navigator.clipboard) {
      showToast({ tone: "error", text: "Copy is not available here." });
      return;
    }
    navigator.clipboard
      .writeText(REFRESH_COMMAND)
      .then(done)
      .catch(() => showToast({ tone: "error", text: "Could not copy the command." }));
  };

  const refreshing = busy && data !== null && !reduced;
  let subtitle = "";
  if (data)
    subtitle = `Checked ${formatChecked(data.checkedAt)} from Kioku's stats and the last reflect run`;
  else if (busy) subtitle = "Checking…";

  return (
    <section
      className={`page${refreshing ? " health-refreshing" : ""}`}
      aria-labelledby="health-title"
      aria-busy={busy}
    >
      <header className="health-head">
        <div>
          <h1 id="health-title">Health</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <Button onClick={refresh} aria-disabled={busy}>
          <span className="health-refresh-icon" aria-hidden="true">
            <Icon name="refresh" />
          </span>
          {busy ? "Checking…" : "Check again"}
        </Button>
      </header>

      {data ? (
        <HealthBody key={loadId} data={data} onCopy={copyCommand} />
      ) : (
        <p className="health-note">Loading health…</p>
      )}
    </section>
  );
}

function SectionError({ text }: { text: string }) {
  return (
    <p role="alert" className="health-note health-error">
      Could not check: {text}
    </p>
  );
}

function ServicesSection({ data }: { data: HealthData }) {
  if (!data.status.ok) {
    return (
      <section className="health-section" aria-labelledby="health-services">
        <h2 id="health-services" className="k-section-label">
          Services
        </h2>
        <SectionError text={data.status.error} />
      </section>
    );
  }
  const pending = data.stats.ok ? data.stats.value.pendingVectors : null;
  const cards = serviceCards(data.status.value, pending ?? 0);
  const overall = worstState(cards.map((c) => c.state));
  return (
    <section className="health-section" aria-labelledby="health-services">
      <h2 id="health-services" className="k-section-label">
        Services · {overallLabel(overall)}
      </h2>
      <ul className="health-services">
        {cards.map((c) => (
          <li key={c.id} className="health-service">
            <span className="health-service-top">
              <span className="k-service-name">{c.name}</span>
              <StatusPill tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</StatusPill>
            </span>
            <span className="health-service-role">
              {pending === null && c.id === "qdrant"
                ? "Vector index, rebuilt from PostgreSQL"
                : c.role}
            </span>
            <span className="k-mono health-service-detail">{c.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AreasSection({ data }: { data: HealthData }) {
  return (
    <section className="health-section health-areas" aria-labelledby="health-areas">
      <h2 id="health-areas" className="k-section-label">
        Notes by area
      </h2>
      {data.stats.ok ? (
        <AreasTable data={data} stats={data.stats.value} />
      ) : (
        <SectionError text={data.stats.error} />
      )}
    </section>
  );
}

function AreasTable({ data, stats }: { data: HealthData; stats: Stats }) {
  const rows = areaRows(stats.domains, data.areas, data.vaults);
  const sum = totals(rows);
  return (
    <>
      <table className="k-table health-table">
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col">Domain</th>
            <th scope="col" className="k-num">
              Active
            </th>
            <th scope="col" className="k-num">
              Legacy
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.domain}>
              <th scope="row">
                {r.label}
                {r.vault ? <span className="health-vault"> in {r.vault}</span> : null}
              </th>
              <td className="k-key">{r.domain}</td>
              <td className="k-num">{formatCount(r.active)}</td>
              <td className="k-num">{formatCount(r.legacy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="health-note">
        {formatCount(sum.active)} active and {formatCount(sum.legacy)} legacy notes,{" "}
        {formatCount(stats.links)} links. Legacy notes are retired, not deleted, and can be
        restored.
      </p>
    </>
  );
}

function ChecksSection({ data, onCopy }: { data: HealthData; onCopy: () => void }) {
  const drafts = data.drafts;
  const shown = drafts.ok ? drafts.value.notes.slice(0, DRAFT_LIMIT) : [];
  const total = drafts.ok ? drafts.value.notes.length : 0;
  const more = drafts.ok && (drafts.value.capped || total > shown.length);
  const pending = data.stats.ok ? data.stats.value.pendingVectors : null;
  return (
    <section className="health-section health-checks-section" aria-labelledby="health-checks">
      <h2 id="health-checks" className="k-section-label">
        Checks
      </h2>
      <ul className="k-services-list health-checks">
        <li className="k-service">
          <div className="k-service-main">
            <span className="k-service-name">KB notes that differ from the code</span>
            <span className="k-count">No drift scan in this build. Run one from Claude Code.</span>
          </div>
          <Button size="sm" onClick={onCopy}>
            <Icon name="copy" /> Copy {REFRESH_COMMAND} for Claude Code
          </Button>
        </li>
        <li className="k-service">
          <div className="k-service-main">
            <span className="health-check-title">
              <span className="k-service-name">Undecided drafts</span>
              {drafts.ok ? (
                <span className="health-check-count">
                  {formatCount(total)}
                  {more ? "+" : ""}
                </span>
              ) : null}
            </span>
            {drafts.ok ? (
              <>
                {shown.map((n) => (
                  <a key={`${n.domain}/${n.key}`} href={noteHref(n.domain, n.key)}>
                    <span className="k-mono">{n.key}</span> {n.title}
                  </a>
                ))}
                {more ? <a href={libraryHref({ status: "draft" })}>And more in Library</a> : null}
                {drafts.value.failedAreas > 0 ? (
                  <span className="k-count">
                    {drafts.value.failedAreas} {drafts.value.failedAreas === 1 ? "area" : "areas"}{" "}
                    could not be checked.
                  </span>
                ) : null}
              </>
            ) : (
              <SectionError text={drafts.error} />
            )}
          </div>
        </li>
        <li className="k-service">
          <div className="k-service-main">
            <span className="health-check-title">
              <span className="k-service-name">Notes waiting for vectors</span>
              {pending !== null ? (
                <span className={`health-check-count${pending === 0 ? " health-check-ok" : ""}`}>
                  {formatCount(pending)}
                </span>
              ) : null}
            </span>
          </div>
        </li>
      </ul>
    </section>
  );
}

function ReflectSection({ data }: { data: HealthData }) {
  const runs = data.runs;
  const summary = runs.ok ? summarizeRun(runs.value.latest) : null;
  const areaLabel = (domain: string) => labelFor(domain, data.areas, data.vaults);
  const confirmed = summary ? summary.run.findings.filter((f) => f.state === "confirmed") : [];
  return (
    <section className="health-section" aria-labelledby="health-reflect">
      <div className="health-reflect-head">
        <h2 id="health-reflect" className="k-section-label">
          Last reflect run
        </h2>
        {summary ? (
          <span className="health-note-inline">
            {formatDay(summary.run.startedAt)} · {areaLabel(summary.run.domain)} ·{" "}
            {summary.confirmed} confirmed, {summary.unverified} unverified
          </span>
        ) : null}
      </div>
      {!runs.ok ? <SectionError text={runs.error} /> : null}
      {runs.ok && runs.value.running ? (
        <p className="health-note">
          Running since {formatTime(runs.value.running.startedAt)} in{" "}
          {areaLabel(runs.value.running.domain)}
        </p>
      ) : null}
      {runs.ok && !summary ? <p className="health-note">No reflect run yet.</p> : null}
      {summary && confirmed.length > 0 ? (
        <ul className="health-findings">
          {confirmed.map((f) => {
            const key = f.noteKeys[0];
            return (
              <li key={f.id}>
                <StatusPill tone="finding">confirmed</StatusPill>
                <span className="health-finding-text">{f.text}</span>
                {key ? <a href={noteHref(summary.run.domain, key)}>Open</a> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="health-reflect-foot">
        <a className="k-btn" href={reflectHref(summary?.run.domain)}>
          Open Reflect
        </a>
        <span className="health-note-inline">Nothing changes until you review the findings.</span>
      </div>
    </section>
  );
}

function HealthBody({ data, onCopy }: { data: HealthData; onCopy: () => void }) {
  return (
    <div className="health-body">
      <ServicesSection data={data} />
      <div className="health-row">
        <AreasSection data={data} />
        <ChecksSection data={data} onCopy={onCopy} />
      </div>
      <ReflectSection data={data} />
    </div>
  );
}
