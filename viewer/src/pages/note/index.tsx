// The note reading page: one serif column, a margin with findings, source and graph.
import { Fragment, type RefObject, useEffect, useRef, useState } from "react";
import {
  type CommandError,
  type Finding,
  getNote,
  listReflectRuns,
  type Note,
  type NoteKind,
  type ReflectRun,
  toCommandError,
} from "../../api";
import { graphHref, libraryHref, navigate, noteHref, reflectHref } from "../../app/router";
import { openPalette } from "../../components/palette";
import { Button, EmptyState, FindingCallout, Icon, Kbd, StatusPill } from "../../components/ui";
import { latestFinished } from "../reflect/state";
import { sentenceCase, shortDate, toParagraphs } from "./body";
import "./note.css";

export interface NotePageProps {
  domain: string;
  noteKey: string;
}

/** A finding with the run it came from, since finding ids are unique only within a run. */
export interface NoteFinding {
  runId: string;
  runAt: string;
  finding: Finding;
}

type Load =
  | { state: "loading" }
  | { state: "error"; error: CommandError }
  | { state: "ready"; note: Note; findings: NoteFinding[] };

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

const MAX_CALLOUTS = 2;
const HISTORY_SHOWN = 5;

/** Findings naming `key` in the newest finished run only; older runs are superseded. */
export function latestFindings(runs: ReflectRun[], key: string): NoteFinding[] {
  const run = latestFinished(runs);
  if (!run) return [];
  return run.findings
    .filter((f) => f.noteKeys.includes(key))
    .map((finding) => ({ runId: run.id, runAt: run.finishedAt ?? run.startedAt, finding }));
}

async function loadNote(
  domain: string,
  key: string,
): Promise<{ note: Note; findings: NoteFinding[] }> {
  // Findings are extra: a failed reflect lookup must not hide the note.
  const [note, runs] = await Promise.all([
    getNote(domain, key),
    listReflectRuns(domain).catch((): ReflectRun[] => []),
  ]);
  return { note, findings: latestFindings(runs, key) };
}

export function NotePage({ domain, noteKey }: NotePageProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const firstLoad = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the load on retry.
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    loadNote(domain, noteKey).then(
      (r) => live && setLoad({ state: "ready", ...r }),
      (e: unknown) => live && setLoad({ state: "error", error: toCommandError(e) }),
    );
    return () => {
      live = false;
    };
  }, [domain, noteKey, attempt]);

  // Move focus to the new title after a navigation or retry, not on the first app load.
  useEffect(() => {
    if (load.state === "loading") return;
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    titleRef.current?.focus({ preventScroll: true });
  }, [load.state]);

  const ready = load.state === "ready";
  return (
    <section className="page-reading note-page" aria-labelledby="note-title">
      {ready ? null : (
        <h1 id="note-title" className="k-sr" tabIndex={-1} ref={titleRef}>
          Note {noteKey}
        </h1>
      )}
      {load.state === "loading" ? (
        <p className="k-count" role="status">
          Loading {noteKey}…
        </p>
      ) : load.state === "error" ? (
        <ErrorState
          error={load.error}
          noteKey={noteKey}
          domain={domain}
          retry={() => setAttempt((a) => a + 1)}
        />
      ) : (
        <NoteView note={load.note} findings={load.findings} titleRef={titleRef} />
      )}
      <CommandBar />
    </section>
  );
}

function ErrorState({
  error,
  noteKey,
  domain,
  retry,
}: {
  error: CommandError;
  noteKey: string;
  domain: string;
  retry: () => void;
}) {
  if (error.code === "not_found") {
    return (
      <EmptyState
        title={`No note ${noteKey} in ${domain}`}
        action={
          <a className="k-btn" href={libraryHref()}>
            Open the library
          </a>
        }
      >
        It may have moved to another area or never existed.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      title={`Couldn't open ${noteKey}`}
      action={<Button onClick={retry}>Try again</Button>}
    >
      {error.message}
    </EmptyState>
  );
}

function NoteView({
  note,
  findings,
  titleRef,
}: {
  note: Note;
  findings: NoteFinding[];
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [allHistory, setAllHistory] = useState(false);
  const suggested = note.links.filter((l) => l.suggested).length;
  const recorded = note.links.length - suggested;
  // The contract does not promise an order, so sort newest first here.
  const history = [...note.revisions].sort((a, b) => b.at.localeCompare(a.at));
  const shownHistory = allHistory ? history : history.slice(0, HISTORY_SHOWN);
  const n = findings.length;
  return (
    <div className="note-layout">
      <article className="note-column">
        <header className="k-note-head">
          <p className="k-meta">
            <span className="k-key">{note.key}</span> · {KIND_LABEL[note.kind]},{" "}
            {shortDate(note.updatedAt)}
          </p>
          <h1 id="note-title" tabIndex={-1} ref={titleRef}>
            {note.title}
          </h1>
          <div className="k-facts">
            <StatusPill tone={note.status}>{note.status}</StatusPill>
            {n > 0 ? (
              <StatusPill tone="finding">
                <Icon name="finding" /> {n} {n === 1 ? "finding" : "findings"}
              </StatusPill>
            ) : null}
            <span className="k-fact">
              {note.origin === "file" ? "from a KB file" : "saved by an agent"}
            </span>
            {note.tags.map((t) => (
              <span key={t} className="k-fact">
                {t}
              </span>
            ))}
          </div>
        </header>

        <NoteBody body={note.body} />

        {note.links.length > 0 ? (
          <section className="note-section" aria-labelledby="note-links">
            <h2 id="note-links" className="k-section-label">
              Links
            </h2>
            <dl className="k-dl">
              {note.links.map((l) => (
                <div
                  key={`${l.relation}-${l.targetDomain}-${l.targetKey}`}
                  style={{ display: "contents" }}
                >
                  <dt>
                    {sentenceCase(l.relation)}
                    {l.suggested ? " (suggested)" : ""}
                  </dt>
                  <dd>
                    <a href={noteHref(l.targetDomain, l.targetKey)}>
                      <span className="k-mono">{l.targetKey}</span>
                      {l.targetTitle ? ` · ${l.targetTitle}` : ""}
                    </a>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {history.length > 0 ? (
          <section className="note-section" aria-labelledby="note-history">
            <h2 id="note-history" className="k-section-label">
              History
            </h2>
            <ol className="k-history">
              {shownHistory.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: revisions have no id; date plus order is identity.
                <li key={`${r.at}-${i}`}>
                  rev {r.revision} · {shortDate(r.at)} · {r.summary}
                </li>
              ))}
            </ol>
            {history.length > HISTORY_SHOWN ? (
              <Button
                size="sm"
                variant="quiet"
                aria-expanded={allHistory}
                onClick={() => setAllHistory((v) => !v)}
              >
                {allHistory ? "Show the last five" : `Show all ${history.length} revisions`}
              </Button>
            ) : null}
          </section>
        ) : null}
      </article>

      <aside className="note-margin" aria-label="About this note">
        <Findings findings={findings} origin={note.origin} domain={note.domain} />
        <section aria-labelledby="note-source">
          <h2 id="note-source" className="k-section-label">
            Source
          </h2>
          {note.origin === "file" ? (
            <>
              {note.sourcePath ? (
                <p>
                  Imported from <span className="k-mono">{note.sourcePath}</span>.
                </p>
              ) : (
                <p>
                  Imported from a KB file. Key <span className="k-mono">{note.key}</span>.
                </p>
              )}
              <Button size="sm" aria-disabled="true" aria-describedby="note-editor-hint">
                Open in editor
              </Button>
              <p id="note-editor-hint" className="k-count">
                Not built yet.
              </p>
            </>
          ) : (
            <p>Saved by an agent with memory_save; no source file.</p>
          )}
        </section>
        <section aria-labelledby="note-graph">
          <h2 id="note-graph" className="k-section-label">
            In the graph
          </h2>
          <p>
            {recorded} recorded {recorded === 1 ? "link" : "links"}
            {suggested > 0 ? `, ${suggested} suggested by reflect` : ""}
          </p>
          <a className="k-btn k-btn-sm" href={graphHref(note.domain, note.key)}>
            Show in graph
          </a>
        </section>
      </aside>
    </div>
  );
}

function Findings({
  findings,
  origin,
  domain,
}: {
  findings: NoteFinding[];
  origin: Note["origin"];
  domain: string;
}) {
  if (findings.length === 0) return null;
  if (findings.length > MAX_CALLOUTS) {
    return (
      <FindingCallout compact>
        <a href={reflectHref(domain)}>{findings.length} findings</a> from the last Reflect run.
      </FindingCallout>
    );
  }
  return (
    <>
      {findings.map(({ runId, runAt, finding }) => (
        <FindingCallout
          key={`${runId}/${finding.id}`}
          kind={`Reflect · ${shortDate(runAt)}${finding.state === "unverified" ? ", not confirmed" : ""}`}
          compact
          actions={
            <>
              <Button size="sm" onClick={() => navigate(reflectHref(domain, finding.id))}>
                Show the finding
              </Button>
              <Button size="sm" aria-disabled="true" title="Not built yet">
                {origin === "file" ? "Fix it in the KB" : "Draft a fix"}
              </Button>
            </>
          }
        >
          {finding.text}
        </FindingCallout>
      ))}
    </>
  );
}

/** The body as plain-text blocks; React escapes the text, so HTML stays text. */
export function NoteBody({ body }: { body: string }) {
  const blocks = toParagraphs(body);
  if (blocks.length === 0) return <p className="k-count">This note has no body.</p>;
  return (
    <div className="k-note-body note-prose">
      {blocks.map((lines, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity beyond order.
        <p key={i} className={lines[0]?.trimStart().startsWith("```") ? "note-code" : undefined}>
          {lines.map((line, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond order.
            <Fragment key={j}>
              {j > 0 ? <br /> : null}
              {line}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

function CommandBar() {
  return (
    <div className="note-bar">
      <button type="button" className="note-bar-field" onClick={openPalette}>
        <span className="note-bar-label">Go to</span>
        <span className="note-bar-placeholder">A note, an area or a command</span>
        <Kbd>⌘K</Kbd>
      </button>
      <a className="k-pill" href="#/health">
        Health
      </a>
      <a className="k-pill" href="#/vaults">
        Vaults
      </a>
    </div>
  );
}
