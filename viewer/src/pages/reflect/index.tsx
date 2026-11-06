import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type AfterSaves,
  dismissFinding as apiDismissFinding,
  type Finding,
  getAppInfo,
  getReflectSettings,
  listAreas,
  listReflectRuns,
  type ReflectRun,
  type ReflectSettings,
  saveReflectSettings,
  startReflect,
  toCommandError,
} from "../../api";
import { setCurrentArea, useCurrentArea } from "../../app/area";
import { noteHref } from "../../app/router";
import {
  Button,
  dismissToast,
  EmptyState,
  FindingCallout,
  Icon,
  SegmentedControl,
  StatusPill,
  showToast,
} from "../../components/ui";
import {
  areaLabel,
  canRun,
  formatDay,
  harnessDetail,
  initialSelection,
  isRunning,
  isStalled,
  newestRun,
  nextRunText,
  type OpenFinding,
  openFindings,
  parseThreshold,
  ROLE_LABELS,
  ROLE_NAMES,
  reachText,
  roleProblems,
  sameAppWarning,
  selectedHarnesses,
  setAfterImport,
  setAfterSavesOn,
  setMode,
  setNightly,
  setPermission,
  setRole,
  setThreshold,
  toggleHarness,
} from "./state";
import "./reflect.css";

/** Matches the toast's lifetime, so Undo stays possible until the call goes out. */
const UNDO_MS = 6000;
export const POLL_MS = 3000;

type PillTone = "active" | "finding" | "neutral";
const STATUS: Record<string, { tone: PillTone; label: string }> = {
  ready: { tone: "active", label: "Ready" },
  "needs-skill": { tone: "finding", label: "Needs the skill" },
  "not-connected": { tone: "neutral", label: "Not connected" },
};

type LoadStatus = "loading" | "ready" | "error";

function runLabel(run: ReflectRun, names: Map<string, string>): string {
  return `${formatDay(run.startedAt)} run · ${names.get(run.harness) ?? run.harness}`;
}

/** Remounts the body on an area change, so no state or request crosses areas. */
export function ReflectPage({ domain: wanted, finding }: { domain?: string; finding?: string }) {
  const current = useCurrentArea();
  // A link such as #/reflect?domain=demo&finding=f1 opens that area once; the area picker
  // can still move away from it afterwards.
  useEffect(() => {
    if (wanted) setCurrentArea(wanted);
  }, [wanted]);
  const domain = current;
  return (
    <ReflectBody
      key={domain}
      domain={domain}
      finding={wanted === undefined || wanted === domain ? finding : undefined}
    />
  );
}

function ReflectBody({ domain, finding: target }: { domain: string; finding?: string }) {
  const [settings, setSettings] = useState<ReflectSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTry, setLoadTry] = useState(0);
  const [readOnly, setReadOnly] = useState(false);
  const [buildReadOnly, setBuildReadOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [runs, setRuns] = useState<ReflectRun[]>([]);
  const [runsStatus, setRunsStatus] = useState<LoadStatus>("loading");
  const [runsTry, setRunsTry] = useState(0);
  const [vault, setVault] = useState<string | null>(
    domain.includes("/") ? (domain.split("/")[0] ?? null) : null,
  );
  const [hidden, setHidden] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const [focusAfter, setFocusAfter] = useState<string | null>(null);

  const mounted = useRef(true);
  const saved = useRef<ReflectSettings | null>(null);
  const saveId = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const lastAfter = useRef<AfterSaves | null>(null);
  const pending = useRef(new Map<string, OpenFinding>());
  const undoTimer = useRef<number | null>(null);
  const watched = useRef(new Set<string>());
  const dismissRefs = useRef(new Map<string, HTMLButtonElement>());
  const reviewHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    getAppInfo()
      .then((info) => {
        if (live && info.readOnly) setBuildReadOnly(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    void loadTry;
    let live = true;
    setLoadError(null);
    getReflectSettings()
      .then((s) => {
        if (!live) return;
        saved.current = s;
        lastAfter.current = s.triggers.afterSaves;
        setSettings(s);
        setSelected(initialSelection(s));
      })
      .catch((e: unknown) => {
        if (live) setLoadError(toCommandError(e).message);
      });
    return () => {
      live = false;
    };
  }, [loadTry]);

  useEffect(() => {
    let live = true;
    listAreas()
      .then((areas) => {
        const area = areas.find((a) => a.domain === domain);
        if (live && area) setVault(area.vault);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [domain]);

  useEffect(() => {
    void runsTry;
    let live = true;
    setRunsStatus("loading");
    listReflectRuns(domain)
      .then((list) => {
        if (!live) return;
        setRuns(list);
        setRunsStatus("ready");
      })
      .catch(() => {
        if (live) setRunsStatus("error");
      });
    return () => {
      live = false;
    };
  }, [domain, runsTry]);

  // A run that never finished and started long ago is stalled, not running. Only the
  // newest run counts: a later finished run supersedes an older one that crashed.
  const newest = newestRun(runs);
  const unfinished = newest !== null && isRunning(newest);
  const stalled = newest !== null && isStalled(newest);

  // Poll while a run is going, including one started before this page opened.
  useEffect(() => {
    if (!unfinished) return;
    void pollTick;
    let live = true;
    const timer = window.setTimeout(() => {
      listReflectRuns(domain)
        .then((list) => {
          if (!live) return;
          const finished = list.filter((r) => watched.current.has(r.id) && r.finishedAt !== null);
          for (const r of finished) watched.current.delete(r.id);
          setRuns(list);
          setPollTick((n) => n + 1);
          if (finished.length > 0) showToast({ tone: "ok", text: "The run finished." });
        })
        .catch(() => {
          // Try again on the next tick; a failed poll says nothing about the run.
          if (live) setPollTick((n) => n + 1);
        });
    }, POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [domain, pollTick, unfinished]);

  const flushPending = useCallback(() => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
    const batch = [...pending.current.values()];
    pending.current.clear();
    for (const { run, finding } of batch) {
      apiDismissFinding(run.id, finding.id).catch((e: unknown) => {
        if (!mounted.current) return;
        setHidden((h) => h.filter((k) => k !== finding.id));
        showToast({ tone: "error", text: toCommandError(e).message });
      });
    }
  }, []);

  // Send dismissals still in their undo window when the page closes, and close their
  // toast so no Undo is left that can't work.
  useEffect(
    () => () => {
      if (pending.current.size > 0) {
        flushPending();
        dismissToast();
      }
    },
    [flushPending],
  );

  useEffect(() => {
    if (focusAfter === null) return;
    const target = dismissRefs.current.get(focusAfter);
    target?.focus();
    if (!target || document.activeElement !== target) reviewHeading.current?.focus();
    setFocusAfter(null);
  }, [focusAfter]);

  const locked = readOnly || buildReadOnly;

  const update = (next: ReflectSettings) => {
    setSettings(next);
    // In a read-only build the mode can still be switched to look at, but nothing is saved.
    if (locked) return;
    if (next.triggers.afterSaves) lastAfter.current = next.triggers.afterSaves;
    saveId.current += 1;
    const id = saveId.current;
    // One save at a time, so an older save never lands after a newer one.
    saveChain.current = saveChain.current
      .then(() => saveReflectSettings(next))
      .then(() => {
        saved.current = next;
      })
      .catch((e: unknown) => {
        if (!mounted.current || id !== saveId.current) return;
        const err = toCommandError(e);
        if (err.code === "read_only") {
          setReadOnly(true);
          return;
        }
        if (saved.current) setSettings(saved.current);
        showToast({ tone: "error", text: `Settings weren't saved. ${err.message}` });
      });
  };

  const runNow = async () => {
    setStarting(true);
    try {
      const run = await startReflect(domain);
      if (!mounted.current) return;
      watched.current.add(run.id);
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
    } catch (e: unknown) {
      if (!mounted.current) return;
      const err = toCommandError(e);
      if (err.code === "read_only") setReadOnly(true);
      else showToast({ tone: "error", text: err.message });
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const copyCommand = async () => {
    const command = `/reflect ${domain}`;
    try {
      await navigator.clipboard.writeText(command);
      showToast({ tone: "ok", text: `Copied ${command}. Paste it into Claude Code.` });
    } catch {
      showToast({ tone: "error", text: "Couldn't copy. Select the command and copy it." });
    }
  };

  const restoreAll = () => {
    if (pending.current.size === 0) {
      dismissToast();
      showToast({ tone: "info", text: "That finding was already dismissed." });
      return;
    }
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
    const keys = [...pending.current.keys()];
    pending.current.clear();
    setHidden((h) => h.filter((k) => !keys.includes(k)));
    dismissToast();
    setFocusAfter(keys[0] ?? null);
  };

  const dismiss = (item: OpenFinding, order: readonly string[]) => {
    if (locked) return;
    const key = item.finding.id;
    const at = order.indexOf(key);
    const next = order[at + 1] ?? order[at - 1] ?? null;
    setHidden((h) => [...h, key]);
    setFocusAfter(next ?? "");
    pending.current.set(key, item);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(flushPending, UNDO_MS);
    const count = pending.current.size;
    const note = item.finding.noteKeys[0];
    const text =
      count > 1
        ? `Dismissed ${count} findings.`
        : note
          ? `Dismissed the finding on ${note}.`
          : "Dismissed the finding.";
    showToast({ tone: "info", text, action: { label: "Undo", onClick: restoreAll } });
  };

  if (!settings) {
    return (
      <section className="page" aria-labelledby="reflect-title" aria-busy={loadError === null}>
        <h1 id="reflect-title">Reflect</h1>
        {loadError === null ? (
          <p className="reflect-hint">Loading…</p>
        ) : (
          <EmptyState
            title="Reflect settings didn't load"
            action={<Button onClick={() => setLoadTry((n) => n + 1)}>Try again</Button>}
          >
            {loadError}
          </EmptyState>
        )}
      </section>
    );
  }

  const picked = selectedHarnesses(settings, selected);
  const names = new Map(settings.harnesses.map((h) => [h.id, h.name]));
  const finished = runs
    .filter((r) => r.finishedAt !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const latest = finished[0];
  const open = openFindings(runs).filter((o) => !hidden.includes(o.finding.id));
  const running = starting || unfinished;
  const label = areaLabel(domain);
  const warning = sameAppWarning(settings);
  const reach = reachText(settings);
  const problems = roleProblems(settings, vault);
  const runnable = picked.length > 0 && canRun(settings, vault);
  const runBlocked =
    picked.length === 0
      ? "Check an app above to run reflect."
      : !runnable
        ? "The apps that check and disprove must be ready and able to read this area."
        : null;
  const automatic = settings.mode === "automatic";

  return (
    <section className="page" aria-labelledby="reflect-title">
      <div className="reflect">
        <header className="reflect-head">
          <div>
            <h1 id="reflect-title">Reflect</h1>
            <p className="reflect-lede">
              Agents audit what memory says: decisions that disagree, notes the code has moved past,
              links nobody recorded. You decide what changes.
            </p>
          </div>
          <SegmentedControl
            label="How it runs"
            value={settings.mode}
            options={[
              { value: "manual", label: "Manual" },
              { value: "automatic", label: "Automatic" },
            ]}
            onChange={(mode) => update(setMode(settings, mode))}
          />
        </header>
        {locked ? (
          <p id="reflect-read-only" className="reflect-fixed">
            Changes are read-only in this build.
          </p>
        ) : null}

        <div className="reflect-cols">
          <div className="reflect-col">
            <section className="reflect-section" aria-labelledby="reflect-apps">
              <h2 id="reflect-apps" className="k-section-label">
                Apps that run it
              </h2>
              {settings.harnesses.length === 0 ? (
                <p className="reflect-hint">No app can run Reflect yet.</p>
              ) : (
                <ul className="k-harness">
                  {settings.harnesses.map((h) => {
                    const status = STATUS[h.status] ?? STATUS["not-connected"];
                    const inputId = `harness-${h.id}`;
                    const pillId = `harness-${h.id}-status`;
                    return (
                      <li key={h.id}>
                        <input
                          id={inputId}
                          type="checkbox"
                          checked={selected.includes(h.id)}
                          disabled={locked || h.status === "not-connected"}
                          aria-describedby={pillId}
                          onChange={() => {
                            const next = toggleHarness(settings, selected, h.id);
                            setSelected(next.selected);
                            update(next.settings);
                          }}
                        />
                        <label htmlFor={inputId}>
                          <span className="k-app-name">{h.name}</span>
                          <span className="k-app-desc">{harnessDetail(h)}</span>
                        </label>
                        <span id={pillId}>
                          {status ? (
                            <StatusPill tone={status.tone}>{status.label}</StatusPill>
                          ) : null}
                        </span>
                        {h.status === "needs-skill" ? (
                          <Button
                            size="sm"
                            aria-label={`Install the skill for ${h.name}`}
                            onClick={() =>
                              showToast({ tone: "info", text: "Installing skills comes later." })
                            }
                          >
                            Install the skill
                          </Button>
                        ) : null}
                        {h.status === "not-connected" ? (
                          <Button
                            size="sm"
                            aria-label={`Connect ${h.name}`}
                            onClick={() =>
                              showToast({ tone: "info", text: "Connecting apps comes later." })
                            }
                          >
                            Connect
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="reflect-section" aria-labelledby="reflect-split">
              <h2 id="reflect-split" className="k-section-label">
                Split the work
              </h2>
              <div className="k-selects">
                {ROLE_NAMES.map((role) => (
                  <RoleSelect
                    key={role}
                    label={ROLE_LABELS[role]}
                    value={settings.roles[role]}
                    disabled={locked}
                    describedBy={picked.length === 0 ? "reflect-pick-hint" : undefined}
                    options={picked.map((h) => ({ value: h.id, label: h.name }))}
                    onChange={(id) => update(setRole(settings, role, id))}
                  />
                ))}
              </div>
              {picked.length === 0 ? (
                <p id="reflect-pick-hint" className="reflect-hint">
                  Check an app above to run reflect.
                </p>
              ) : null}
              <p className="reflect-hint">
                A finding stands only when a different model can't disprove it.
                {reach ? ` ${reach}` : ""}
              </p>
              {warning ? <p className="reflect-hint reflect-warn">{warning}</p> : null}
              {problems.map((p) => (
                <p key={p} className="reflect-hint reflect-warn">
                  {p}
                </p>
              ))}
            </section>

            {automatic ? (
              <fieldset className="reflect-section" disabled={locked}>
                <legend className="k-section-label">When it runs</legend>
                <label className="k-check">
                  <input
                    type="checkbox"
                    checked={settings.triggers.afterImport}
                    onChange={(e) => update(setAfterImport(settings, e.target.checked))}
                  />
                  After each KB import
                </label>
                <AfterSavesRow settings={settings} onChange={update} previous={lastAfter.current} />
                <label className="k-check">
                  <input
                    type="checkbox"
                    checked={settings.triggers.nightlyAt !== null}
                    onChange={(e) => update(setNightly(settings, e.target.checked))}
                  />
                  Every night at {settings.triggers.nightlyAt ?? "02:00"}
                </label>
              </fieldset>
            ) : (
              <section className="reflect-section" aria-labelledby="reflect-command">
                <h2 id="reflect-command" className="k-section-label">
                  Run it yourself
                </h2>
                <p className="reflect-hint">
                  Paste this into Claude Code to run reflect on {label}.
                </p>
                <div className="reflect-command">
                  <code className="k-mono">/reflect {domain}</code>
                  <Button size="sm" variant="quiet" onClick={copyCommand}>
                    Copy command
                  </Button>
                </div>
              </section>
            )}

            <fieldset className="reflect-section" disabled={locked}>
              <legend className="k-section-label">What agents may do</legend>
              <label className="k-check">
                <input
                  type="radio"
                  name="reflect-permission"
                  checked={settings.permission === "report-only"}
                  onChange={() => update(setPermission(settings, "report-only"))}
                />
                <span>
                  <strong>Report findings.</strong> I decide how to fix them.
                </span>
              </label>
              <label className="k-check">
                <input
                  type="radio"
                  name="reflect-permission"
                  checked={settings.permission === "propose-fixes"}
                  onChange={() => update(setPermission(settings, "propose-fixes"))}
                />
                <span>
                  <strong>Also draft the fixes for me to approve.</strong> KB notes get a pull
                  request to the KB repo; agent notes get a draft revision.
                </span>
              </label>
              <p className="reflect-fixed">
                <Icon name="lock" /> Agents can never change vaults or who can read them.
              </p>
            </fieldset>
          </div>

          <div className="reflect-col">
            <section className="reflect-section" aria-labelledby="reflect-review">
              <div className="k-queue-head">
                <h2
                  id="reflect-review"
                  className="k-section-label"
                  ref={reviewHeading}
                  tabIndex={-1}
                >
                  To review
                </h2>
                {latest ? (
                  <span>
                    {label} · {runLabel(latest, names)}
                  </span>
                ) : null}
              </div>
              <ReviewBody
                status={runsStatus}
                hasRun={latest !== undefined}
                open={open}
                domain={domain}
                target={target}
                locked={locked}
                dismissRefs={dismissRefs.current}
                onRetry={() => setRunsTry((n) => n + 1)}
                onDismiss={dismiss}
              />
            </section>

            <section className="reflect-section" aria-labelledby="reflect-next">
              <h2 id="reflect-next" className="k-section-label">
                Next run
              </h2>
              <div className="reflect-next">
                <p>{running ? `Running on ${label}…` : nextRunText(settings)}</p>
                {stalled && !running ? (
                  <p className="reflect-hint">The last run didn't finish.</p>
                ) : null}
                <Button
                  variant="primary"
                  onClick={runNow}
                  disabled={running || locked || runBlocked !== null}
                  aria-describedby={
                    locked ? "reflect-read-only" : runBlocked ? "reflect-run-why" : undefined
                  }
                >
                  {running ? "Running…" : `Run now on ${label}`}
                </Button>
                {runBlocked && !running && !locked ? (
                  <p id="reflect-run-why" className="reflect-hint">
                    {runBlocked}
                  </p>
                ) : null}
                {running ? (
                  <div
                    className="reflect-progress"
                    role="progressbar"
                    aria-label="Reflect run in progress"
                  >
                    <span />
                  </div>
                ) : null}
              </div>
            </section>

            <section className="reflect-section" aria-labelledby="reflect-how">
              <h2 id="reflect-how" className="k-section-label">
                How it connects
              </h2>
              <p className="reflect-hint">
                Each app gets two things: Kioku's MCP server and the reflect skill. When a trigger
                fires, the viewer starts that app's command line with the skill, as you would by
                hand. The app reads memory, checks the code, and reports its findings back through
                Kioku. Runs use that app's own sign-in and quota.
              </p>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}

interface RoleSelectProps {
  label: string;
  value: string;
  disabled: boolean;
  describedBy: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

function RoleSelect({ label, value, disabled, describedBy, options, onChange }: RoleSelectProps) {
  const id = useId();
  const known = options.some((o) => o.value === value);
  return (
    <div className="k-select-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="k-select"
        value={known ? value : ""}
        disabled={disabled || options.length === 0}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      >
        {known ? null : <option value="">Pick an app</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function AfterSavesRow({
  settings,
  onChange,
  previous,
}: {
  settings: ReflectSettings;
  onChange: (s: ReflectSettings) => void;
  previous: AfterSaves | null;
}) {
  const boxId = useId();
  const numId = useId();
  const leadId = useId();
  const tailId = useId();
  const after = settings.triggers.afterSaves;
  const threshold = after?.threshold ?? previous?.threshold ?? 25;
  const [draft, setDraft] = useState(String(threshold));

  useEffect(() => {
    setDraft(String(threshold));
  }, [threshold]);

  const commit = () => {
    const value = parseThreshold(draft);
    if (value === null) {
      setDraft(String(threshold));
      return;
    }
    setDraft(String(value));
    if (value !== threshold) onChange(setThreshold(settings, String(value)));
  };

  return (
    <div className="k-check reflect-after">
      <input
        id={boxId}
        type="checkbox"
        aria-labelledby={`${leadId} ${numId} ${tailId}`}
        checked={after !== null}
        onChange={(e) => onChange(setAfterSavesOn(settings, e.target.checked, previous))}
      />
      <span className="reflect-check-text">
        <label id={leadId} htmlFor={boxId}>
          When
        </label>
        <input
          id={numId}
          className="reflect-num"
          type="number"
          min={1}
          max={10000}
          aria-label="Notes changed before a run"
          value={draft}
          disabled={after === null}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <label id={tailId} htmlFor={boxId}>
          notes have changed since the last run
        </label>
        {after ? <span className="k-hint">({after.soFar} so far)</span> : null}
      </span>
    </div>
  );
}

interface ReviewBodyProps {
  status: LoadStatus;
  hasRun: boolean;
  open: OpenFinding[];
  domain: string;
  /** A finding to open and scroll to, from #/reflect?finding=. */
  target: string | undefined;
  locked: boolean;
  dismissRefs: Map<string, HTMLButtonElement>;
  onRetry: () => void;
  onDismiss: (item: OpenFinding, order: readonly string[]) => void;
}

function ReviewBody({
  status,
  hasRun,
  open,
  domain,
  target,
  locked,
  dismissRefs,
  onRetry,
  onDismiss,
}: ReviewBodyProps) {
  if (status === "loading" && !hasRun) return <p className="reflect-hint">Loading runs…</p>;
  if (status === "error") {
    return (
      <div className="reflect-command">
        <p className="reflect-hint">Runs didn't load.</p>
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (!hasRun) return <p className="reflect-hint">No run in this area yet.</p>;
  const confirmed = open.filter((o) => o.finding.state === "confirmed");
  const unconfirmed = open.filter((o) => o.finding.state === "unverified");
  const order = [...confirmed, ...unconfirmed].map((o) => o.finding.id);
  const row = (o: OpenFinding) => (
    <li key={o.finding.id}>
      <FindingRow
        item={o}
        domain={domain}
        targeted={o.finding.id === target}
        locked={locked}
        dismissRef={(el) => {
          if (el) dismissRefs.set(o.finding.id, el);
          else dismissRefs.delete(o.finding.id);
        }}
        onDismiss={() => onDismiss(o, order)}
      />
    </li>
  );
  return (
    <>
      {confirmed.length === 0 ? <p className="reflect-hint">Nothing left to review.</p> : null}
      {confirmed.length > 0 ? <ul className="k-queue">{confirmed.map(row)}</ul> : null}
      {unconfirmed.length > 0 ? (
        <details
          className="k-disclosure"
          open={unconfirmed.some((o) => o.finding.id === target) ? true : undefined}
        >
          <summary>
            {unconfirmed.length} {unconfirmed.length === 1 ? "finding wasn't" : "findings weren't"}{" "}
            confirmed
          </summary>
          <ul className="k-queue">{unconfirmed.map(row)}</ul>
        </details>
      ) : null}
    </>
  );
}

function FindingRow({
  item,
  domain,
  targeted,
  locked,
  dismissRef,
  onDismiss,
}: {
  item: OpenFinding;
  domain: string;
  targeted: boolean;
  locked: boolean;
  dismissRef: (el: HTMLButtonElement | null) => void;
  onDismiss: () => void;
}) {
  const { run, finding }: { run: ReflectRun; finding: Finding } = item;
  const textId = useId();
  const first = finding.noteKeys[0];
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!targeted) return;
    box.current?.scrollIntoView?.({ block: "nearest" });
    box.current?.focus({ preventScroll: true });
  }, [targeted]);
  return (
    <div ref={box} tabIndex={targeted ? -1 : undefined} aria-current={targeted || undefined}>
      <FindingCallout
        compact
        actions={
          <>
            {first ? (
              <a
                className="k-btn k-btn-sm"
                href={noteHref(run.domain || domain, first)}
                aria-describedby={textId}
              >
                Fix it in the KB
              </a>
            ) : null}
            <button
              type="button"
              className="k-btn k-btn-quiet k-btn-sm"
              ref={dismissRef}
              aria-describedby={locked ? `${textId} reflect-read-only` : textId}
              disabled={locked}
              onClick={onDismiss}
            >
              Dismiss
            </button>
          </>
        }
      >
        <span id={textId}>{finding.text}</span>
        {finding.noteKeys.length > 0 ? (
          <>
            {" "}
            <span className="reflect-notes">{finding.noteKeys.join(", ")}</span>
          </>
        ) : null}
      </FindingCallout>
    </div>
  );
}
