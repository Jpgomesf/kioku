// Vaults and visibility, and the review step a person confirms.
import { type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type AccessRequest,
  type AppInfo,
  applyVisibility,
  getAppInfo,
  getVaultsConfig,
  listAccessRequests,
  previewVisibility,
  respondAccessRequest,
  type VaultApp,
  type VaultConfig,
  type VaultsConfig,
  type VisibilityChange,
  type VisibilityPreview,
} from "../../api";
import { READ_ONLY_MESSAGE, toCommandError } from "../../api/core";
import { navigate } from "../../app/router";
import { Button, ConfirmBlock, EmptyState, Icon, Switch } from "../../components/ui";
import {
  appOf,
  type Draft,
  type DraftRequest,
  declineRequest,
  discardDraft,
  dismissRequest,
  draftChanges,
  draftedCanRead,
  isLocalProvider,
  listNames,
  openRequests,
  providerWords,
  requestIsCurrent,
  setDraft,
  setDrafted,
  useDraftState,
} from "./draft";
import "./vaults.css";

const REVIEW_HREF = "#/vaults/review";

type Load<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ok"; data: T };

/** Load once per `key`; the loader may close over values that `key` stands for. */
function useLoad<T>(load: () => Promise<T>, key: string): Load<T> {
  const [value, setValue] = useState<Load<T>>({ state: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for everything the loader reads.
  useEffect(() => {
    let live = true;
    setValue({ state: "loading" });
    load().then(
      (data) => live && setValue({ state: "ok", data }),
      (error: unknown) =>
        live && setValue({ state: "error", message: toCommandError(error).message }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return value;
}

/** Focus `ref` once `ready`, when nothing else holds focus (as after a route change). */
function useFocusWhenReady(ref: RefObject<HTMLElement | null>, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const active = document.activeElement;
    if (active === null || active === document.body) ref.current?.focus();
  }, [ref, ready]);
}

interface VaultsData {
  config: VaultsConfig;
  requests: AccessRequest[];
  /** True when the request list couldn't be loaded; the vaults still show. */
  requestsFailed: boolean;
}

/** Only the vaults file is required; a failed request list degrades to none. */
const loadVaults = async (): Promise<VaultsData> => {
  const requestsLoad = listAccessRequests().then(
    (requests) => ({ requests, requestsFailed: false }),
    () => ({ requests: [] as AccessRequest[], requestsFailed: true }),
  );
  const config = await getVaultsConfig();
  return { config, ...(await requestsLoad) };
};

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Plain text with folder paths (starting with ~/ or /) set in mono. */
function withPaths(text: string): ReactNode[] {
  return text.split(/((?:~|\/)[^\s,;]*[^\s,;.])/).map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string.
      <span key={`${i}-${part}`} className="k-mono">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

const pluralise = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function Status({ load }: { load: Load<unknown> }) {
  if (load.state === "loading") return <p className="k-hint">Loading vaults…</p>;
  if (load.state === "error")
    return (
      <p className="k-notice" role="alert">
        Couldn't load vaults: {load.message}
      </p>
    );
  return null;
}

export function VaultsPage() {
  const load = useLoad(loadVaults, "");
  const { draft, dismissed } = useDraftState();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useFocusWhenReady(titleRef, load.state === "ok");

  return (
    <section className="page" aria-labelledby="vaults-title">
      <div className="vaults">
        <header className="vaults-head">
          <h1 id="vaults-title" ref={titleRef} tabIndex={-1}>
            Vaults and visibility
          </h1>
          <p>
            Choose which apps can read each vault. An agent can ask for access, but only you can
            give it.
          </p>
        </header>
        <Status load={load} />
        {load.state === "ok" && (
          <VaultsBody data={load.data} draft={draft} dismissed={dismissed} titleRef={titleRef} />
        )}
      </div>
    </section>
  );
}

function VaultsBody({
  data,
  draft,
  dismissed,
  titleRef,
}: {
  data: VaultsData;
  draft: Draft;
  dismissed: readonly string[];
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const requests = openRequests(data.config, data.requests, dismissed);
  const changes = draftChanges(data.config, draft);
  const bannersRef = useRef<HTMLDivElement>(null);

  const review = (request: AccessRequest) => {
    const vault = data.config.vaults.find((v) => v.name === request.vault);
    const app = appOf(data.config, request.vault, request.app);
    if (!vault || !app) return;
    const asked: DraftRequest = {
      id: request.id,
      vault: request.vault,
      app: request.app,
      provider: app.provider,
    };
    setDraft(setDrafted(draft, vault, app.provider, true), asked);
    navigate(REVIEW_HREF);
  };

  const later = (request: AccessRequest) => {
    dismissRequest(request.id);
    // The banner is gone; move focus to the next one, or to the page title.
    queueMicrotask(() => {
      const next = bannersRef.current?.querySelector<HTMLElement>(".k-request h3");
      (next ?? titleRef.current)?.focus();
    });
  };

  const discard = () => {
    discardDraft();
    titleRef.current?.focus();
  };

  const status =
    changes.length > 0
      ? `${changes.length === 1 ? "1 app changes" : `${changes.length} apps change`}. Nothing is saved yet.`
      : "";

  return (
    <>
      <p role="status" className="k-sr">
        {status}
      </p>
      {data.requestsFailed && <p className="k-hint">Couldn't check for access requests.</p>}
      <div ref={bannersRef} className="vaults-banners">
        {requests.map((request) => (
          <RequestBanner
            key={request.id}
            request={request}
            app={appOf(data.config, request.vault, request.app)}
            onReview={() => review(request)}
            onLater={() => later(request)}
          />
        ))}
      </div>
      {data.config.vaults.length === 0 ? (
        <EmptyState title="No vaults file yet">
          So every app can read every area. To split memory into vaults, create the vaults file (by
          default <span className="k-mono">~/.config/kioku/vaults.toml</span>) with{" "}
          <span className="k-mono">scripts/vaults.py add-vault</span> in the Kioku checkout.
        </EmptyState>
      ) : null}
      <div className="vaults-cards">
        {data.config.vaults.map((vault) => (
          <VaultCard
            key={vault.name}
            vault={vault}
            others={data.config.vaults.filter((v) => v.name !== vault.name)}
            draft={draft}
            asking={requests.filter((r) => r.vault === vault.name)}
          />
        ))}
      </div>
      <p className="vaults-foot">
        You review every change before it's saved, and each save keeps a backup of the vaults file.
      </p>
      {changes.length > 0 && <DraftBar status={status} onDiscard={discard} />}
    </>
  );
}

function RequestBanner({
  request,
  app,
  onReview,
  onLater,
}: {
  request: AccessRequest;
  app: VaultApp | undefined;
  onReview: () => void;
  onLater: () => void;
}) {
  const name = app?.name ?? request.app;
  const titleId = useId();
  return (
    <section className="k-request" aria-labelledby={titleId}>
      <Icon name="agent" size={28} />
      <div className="k-request-text">
        <h3 id={titleId} tabIndex={-1}>
          {name} asked to read {request.vault}
        </h3>
        <p>
          {withPaths(request.reason)} at {timeOf(request.requestedAt)}. Kioku turned it away,
          because {request.vault} doesn't let {name} read it.
        </p>
      </div>
      <div className="k-request-actions">
        <Button variant="primary" size="lg" onClick={onReview}>
          Review the request
        </Button>
        <Button size="lg" onClick={onLater}>
          Not now
        </Button>
      </div>
    </section>
  );
}

/** True when another vault claims a folder inside one of this vault's folders. */
function sharesFolders(vault: VaultConfig, others: VaultConfig[]): boolean {
  return vault.paths.some((p) =>
    others.some((o) => o.paths.some((q) => q !== p && q.startsWith(p.endsWith("/") ? p : `${p}/`))),
  );
}

function VaultCard({
  vault,
  others,
  draft,
  asking,
}: {
  vault: VaultConfig;
  others: VaultConfig[];
  draft: Draft;
  asking: AccessRequest[];
}) {
  const base = useId();
  const areas = vault.areas.map((a) => a.domain.split("/").at(-1) ?? a.domain);
  const except = sharesFolders(vault, others) ? ", except folders another vault claims" : "";
  return (
    <article className="k-vault" aria-labelledby={`${base}-name`}>
      <div className="k-vault-head">
        <h3 id={`${base}-name`}>{vault.name}</h3>
        <span>
          {pluralise(vault.areas.length, "area", "areas")} ·{" "}
          <span className="k-mono">{vault.paths.join(", ")}</span>
          {except}
        </span>
      </div>
      <h4 className="k-section-label">Apps that can read it</h4>
      <ul className="k-apps">
        {vault.apps.map((app) => {
          const request = asking.find((r) => r.app === app.id);
          const nameId = `${base}-${app.id}-name`;
          const descId = `${base}-${app.id}-desc`;
          return (
            <li key={app.id} className={request ? "k-app-asking" : undefined}>
              <span className="k-app">
                <span className="k-app-name" id={nameId}>
                  {app.name}
                </span>
                <span className="k-app-desc" id={descId}>
                  {app.description}
                  {request ? ` · asked for access at ${timeOf(request.requestedAt)}` : ""}
                </span>
              </span>
              <Switch
                labelledBy={nameId}
                describedBy={descId}
                checked={draftedCanRead(vault, app.provider, draft)}
                onChange={(next) => setDraft(setDrafted(draft, vault, app.provider, next))}
              />
            </li>
          );
        })}
      </ul>
      <p className="k-apps-note">
        Each switch stands for the model provider an app uses, so apps on the same provider switch
        together.
      </p>
      <details className="k-disclosure">
        <summary>Folders and areas</summary>
        <dl className="k-dl">
          <dt>Folders</dt>
          <dd>
            {vault.paths.map((p) => (
              <span key={p} className="k-mono">
                {p}
              </span>
            ))}
            {except}
          </dd>
          {vault.gitRemotes.length > 0 && (
            <>
              <dt>Git remotes</dt>
              <dd>
                {vault.gitRemotes.map((r) => (
                  <span key={r} className="k-mono">
                    {r}
                  </span>
                ))}
              </dd>
            </>
          )}
          <dt>Domains</dt>
          <dd>
            {vault.domains.map((d) => (
              <span key={d} className="k-fact">
                <span className="k-mono">{d}</span>
              </span>
            ))}
          </dd>
          <dt>Areas</dt>
          <dd>{areas.length > 0 ? areas.join(", ") : "None yet"}</dd>
          <dt>New notes</dt>
          <dd>{vault.defaultDomain ?? "Not set"}</dd>
        </dl>
      </details>
    </article>
  );
}

function DraftBar({ status, onDiscard }: { status: string; onDiscard: () => void }) {
  return (
    <section className="vaults-draft" aria-label="Unsaved change">
      <p>{status}</p>
      <Button onClick={onDiscard}>Discard</Button>
      <Button variant="primary" onClick={() => navigate(REVIEW_HREF)}>
        Review the change
      </Button>
    </section>
  );
}

// The review step.

interface ReviewData {
  config: VaultsConfig;
  requests: AccessRequest[];
  changes: VisibilityChange[];
  preview: VisibilityPreview | null;
}

function reviewTitle(changes: VisibilityChange[], config: VaultsConfig): string {
  const [only] = changes;
  if (changes.length === 1 && only) {
    const name = appOf(config, only.vault, only.app)?.name ?? only.app;
    return only.canRead ? `Let ${name} read ${only.vault}?` : `Stop ${name} reading ${only.vault}?`;
  }
  return `Change who can read ${listNames([...new Set(changes.map((c) => c.vault))])}?`;
}

/** Plain lines about access that this change leaves alone. */
export function unchangedLines(config: VaultsConfig, changes: VisibilityChange[]): string[] {
  const lines: string[] = [];
  const changedVaults = new Set(changes.map((c) => c.vault));
  for (const vault of config.vaults) {
    if (!changedVaults.has(vault.name)) {
      lines.push(`${vault.name}: nothing changes.`);
      continue;
    }
    const kept = vault.apps.filter(
      (a) => !changes.some((c) => c.vault === vault.name && c.app === a.id),
    );
    const can = kept.filter((a) => a.canRead).map((a) => a.name);
    const cannot = kept.filter((a) => !a.canRead).map((a) => a.name);
    if (can.length > 0) lines.push(`${listNames(can)} can still read ${vault.name}.`);
    if (cannot.length > 0) lines.push(`${listNames(cannot)} still can't read ${vault.name}.`);
  }
  return lines;
}

const sends = (name: string): string => (name.endsWith(" apps") ? "send" : "sends");

/** Where the data would go: one line per app that gains access and isn't on this Mac. */
export function warningLines(config: VaultsConfig, changes: VisibilityChange[]): string[] {
  return changes.flatMap((c) => {
    const app = appOf(config, c.vault, c.app);
    if (!c.canRead || !app || isLocalProvider(app.provider)) return [];
    return [`${app.name} ${sends(app.name)} what it reads to ${providerWords(app.provider)}.`];
  });
}

/** "Until now, personal has only been read by A and B." for each vault that gains a reader. */
function contextLines(config: VaultsConfig, changes: VisibilityChange[]): string[] {
  const vaults = [...new Set(changes.filter((c) => c.canRead).map((c) => c.vault))];
  return vaults.flatMap((name) => {
    const readers = config.vaults
      .find((v) => v.name === name)
      ?.apps.filter((a) => a.canRead)
      .map((a) => a.name);
    if (!readers) return [];
    return readers.length > 0
      ? [`Until now, ${name} has only been read by ${listNames(readers)}.`]
      : [`Until now, no app has read ${name}.`];
  });
}

type Outcome =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "failed"; message: string }
  | { kind: "partial"; message: string }
  | { kind: "declineFailed"; message: string; name: string; vault: string }
  | { kind: "saved" };

export function ReviewPage() {
  const { draft, request } = useDraftState();
  // Held here, above the loader, so it survives the reload that clearing the draft causes.
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const key = JSON.stringify(draft);
  const load = useLoad(async (): Promise<ReviewData> => {
    const { config, requests } = await loadVaults();
    const changes = draftChanges(config, draft);
    const preview = changes.length > 0 ? await previewVisibility(changes) : null;
    return { config, requests, changes, preview };
  }, key);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useFocusWhenReady(titleRef, load.state === "ok" || outcome.kind === "saved");

  if (outcome.kind === "saved" || outcome.kind === "partial") {
    return (
      <section className="page" aria-labelledby="review-title">
        <div className="k-review">
          <a className="k-back" href="#/vaults">
            <Icon name="back" />
            Vaults and visibility
          </a>
          <h1 id="review-title" ref={titleRef} tabIndex={-1}>
            Saved
          </h1>
          <p role="status">
            {outcome.kind === "saved"
              ? "Saved. A backup of the old file was kept."
              : `Saved. Couldn't mark the request as answered: ${outcome.message}`}
          </p>
        </div>
      </section>
    );
  }

  const current =
    load.state === "ok" && request && requestIsCurrent(request, load.data.changes)
      ? load.data.requests.find((r) => r.id === request.id)
      : undefined;

  return (
    <section className="page" aria-labelledby="review-title">
      <div className="k-review">
        <a className="k-back" href="#/vaults">
          <Icon name="back" />
          Vaults and visibility
        </a>
        {load.state !== "ok" && (
          <h1 id="review-title" className="k-sr">
            Review a visibility change
          </h1>
        )}
        <Status load={load} />
        {outcome.kind === "declineFailed" && (
          <p className="k-notice vaults-notice" role="alert">
            <Icon name="notice" />
            <span>
              Couldn't record your answer: {outcome.message} {outcome.name} still can't read{" "}
              {outcome.vault}.
            </span>
          </p>
        )}
        {load.state === "ok" && (
          <ReviewBody
            data={load.data}
            request={current && request ? { asked: current, draft: request } : undefined}
            outcome={outcome}
            setOutcome={setOutcome}
            titleRef={titleRef}
          />
        )}
      </div>
    </section>
  );
}

function ReviewBody({
  data,
  request,
  outcome,
  setOutcome,
  titleRef,
}: {
  data: ReviewData;
  request: { asked: AccessRequest; draft: DraftRequest } | undefined;
  outcome: Outcome;
  setOutcome: (outcome: Outcome) => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { config, changes, preview } = data;
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    getAppInfo()
      .then((info) => live && setAppInfo(info))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const unchanged = useMemo(() => unchangedLines(config, changes), [config, changes]);
  const warnings = useMemo(() => warningLines(config, changes), [config, changes]);
  const context = useMemo(() => contextLines(config, changes), [config, changes]);

  if (changes.length === 0 || !preview) {
    return (
      <>
        <h1 id="review-title" ref={titleRef} tabIndex={-1} className="k-sr">
          Review a visibility change
        </h1>
        <EmptyState
          title="No change to review"
          action={
            <a className="k-btn" href="#/vaults">
              Back to vaults
            </a>
          }
        >
          Turn a switch on the Vaults page, then review it here.
        </EmptyState>
      </>
    );
  }

  const busy = outcome.kind === "busy";
  const failedChecks = preview.checks.filter((c) => !c.passed);
  const requester = request ? appOf(config, request.asked.vault, request.asked.app) : undefined;
  const requesterName = requester?.name ?? request?.asked.app ?? "";

  const allow = async () => {
    if (busy || failedChecks.length > 0) return;
    setOutcome({ kind: "busy" });
    let applied = false;
    try {
      await applyVisibility(changes);
      applied = true;
      if (request) await respondAccessRequest(request.asked.id, true);
      setOutcome({ kind: "saved" });
      discardDraft();
    } catch (error) {
      const message = toCommandError(error).message;
      if (applied) {
        setOutcome({ kind: "partial", message });
        discardDraft();
      } else {
        setOutcome({ kind: "failed", message });
      }
    }
  };

  const decline = async () => {
    if (busy) return;
    if (!request) {
      discardDraft();
      navigate("#/vaults");
      return;
    }
    const vault = config.vaults.find((v) => v.name === request.asked.vault);
    // Take the grant out of the draft first, so a failed answer never leaves it staged.
    if (vault) declineRequest(vault, request.draft);
    setOutcome({ kind: "busy" });
    try {
      await respondAccessRequest(request.asked.id, false);
      setOutcome({ kind: "idle" });
      navigate("#/vaults");
    } catch (error) {
      setOutcome({
        kind: "declineFailed",
        message: toCommandError(error).message,
        name: requesterName,
        vault: request.asked.vault,
      });
    }
  };

  const enabling = changes.filter((c) => c.canRead);
  const [onlyEnabling] = enabling;
  const soleApp =
    changes.length === 1 && onlyEnabling
      ? appOf(config, onlyEnabling.vault, onlyEnabling.app)
      : undefined;
  const whatTitle = soleApp ? `What ${soleApp.name} could read` : "What changes";
  const origin = request?.asked.reason ? request.asked.reason.replace(/^From /, "from ") : "";

  return (
    <>
      <header className="k-review-head">
        <h1 id="review-title" ref={titleRef} tabIndex={-1}>
          {reviewTitle(changes, config)}
        </h1>
        <p>
          {request ? (
            <>
              {requesterName} asked at {timeOf(request.asked.requestedAt)}
              {origin ? <>, {withPaths(origin)}</> : null}.{" "}
            </>
          ) : null}
          Nothing changes until you allow it.
        </p>
      </header>
      <div className="k-review-cols">
        <div className="k-review-main">
          <section className="k-review-section" aria-labelledby="review-what">
            <h2 className="k-section-label" id="review-what">
              {whatTitle}
            </h2>
            <ul className="k-reads">
              {preview.summary.map((line) => (
                <li key={line}>
                  <Icon name="eye" />
                  <span>{line}</span>
                </li>
              ))}
              {soleApp && (
                <li>
                  <Icon name="plus" />
                  <span>
                    Every note saved there later, until you turn {soleApp.name} off again.
                  </span>
                </li>
              )}
            </ul>
          </section>
          {unchanged.length > 0 && (
            <section className="k-review-section" aria-labelledby="review-same">
              <h2 className="k-section-label" id="review-same">
                What stays the same
              </h2>
              <ul className="k-bullets">
                {unchanged.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}
          {warnings.length > 0 && (
            <p className="k-notice vaults-notice" role="note">
              <Icon name="notice" />
              <span>{[...warnings, ...context].join(" ")}</span>
            </p>
          )}
          <details className="k-disclosure-box">
            <summary>Show the file change</summary>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the scroller must be reachable by keyboard. */}
            <section className="k-diff-body" aria-label="File change" tabIndex={0}>
              {preview.diff.map((line, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no other identity.
                  key={i}
                  className={`k-diff-line${line.kind === "add" ? " k-diff-add" : line.kind === "remove" ? " k-diff-del" : ""}`}
                >
                  <span className="k-sign" aria-hidden="true">
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
                  </span>
                  {line.kind !== "context" && (
                    <span className="k-sr">{line.kind === "add" ? "added: " : "removed: "}</span>
                  )}
                  <span>{line.text}</span>
                </div>
              ))}
            </section>
          </details>
        </div>
        <div className="k-review-side">
          <section className="k-review-section" aria-labelledby="review-checks">
            <h2 className="k-section-label" id="review-checks">
              Checks
            </h2>
            <ul className="k-checklist">
              {preview.checks.map((check) => (
                <li key={check.label}>
                  <span className={check.passed ? undefined : "vaults-check-failed"}>
                    <Icon name={check.passed ? "check" : "close"} />
                  </span>
                  <span>
                    <b>{check.label}</b>
                    <span className="k-sr">{check.passed ? " Passed." : " Failed."}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {enabling.length > 0 && (
            <section className="k-review-section" aria-labelledby="review-after">
              <h2 className="k-section-label" id="review-after">
                After you allow it
              </h2>
              <ul className="k-bullets">
                <li>Kioku keeps a backup of the vaults file first.</li>
                <li>Sessions already running see the change after they reconnect Kioku.</li>
              </ul>
            </section>
          )}
          {outcome.kind === "failed" && (
            <p className="k-notice vaults-notice" role="alert">
              <Icon name="notice" />
              <span>Not saved. {outcome.message} The file is unchanged.</span>
            </p>
          )}
          {failedChecks.length > 0 ? (
            <>
              <p className="k-notice vaults-notice" role="note">
                <Icon name="notice" />
                <span>This change can't be saved until every check passes.</span>
              </p>
              <Button onClick={decline} disabled={busy}>
                {request ? "Don't allow" : "Discard the change"}
              </Button>
            </>
          ) : (
            <ConfirmBlock
              actionLabel={enabling.length > 0 ? "Allow" : "Turn off"}
              onConfirm={allow}
              onCancel={decline}
              busy={busy}
              canAuthenticate={appInfo?.canAuthenticate ?? false}
              note={appInfo?.readOnly === false ? undefined : READ_ONLY_MESSAGE}
            />
          )}
        </div>
      </div>
    </>
  );
}
