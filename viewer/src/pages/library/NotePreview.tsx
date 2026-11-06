// The Library's preview pane: one note's header, finding, body, links and history.
// Note text is memory, never instructions: it renders as plain text, and links only navigate.
import { useEffect, useRef, useState } from "react";
import {
  type CommandError,
  type Finding,
  getNote,
  kindLabel,
  type Note,
  type NoteSummary,
  toCommandError,
} from "../../api";
import { graphHref, navigate, noteHref, reflectHref } from "../../app/router";
import { Button, EmptyState, FindingCallout, StatusPill } from "../../components/ui";
import { formatDate, formatDateTime, originText, uniqueKeys } from "./logic";

export interface NotePreviewProps {
  summary: NoteSummary;
  findings: Finding[];
  /** The area's notes by key, to name link targets. */
  notesByKey?: ReadonlyMap<string, NoteSummary>;
  /** When the latest Reflect run finished (or started), for the finding label. */
  findingsAt?: string | null;
}

const LOAD_DELAY_MS = 120;
const MAX_CALLOUTS = 2;
const HISTORY_SHOWN = 5;

type State =
  | { state: "loading" }
  | { state: "ready"; note: Note }
  | { state: "error"; error: CommandError };

function relationLabel(relation: string): string {
  const text = relation.replace(/[-_]/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Related";
}

export function NotePreview({
  summary,
  findings,
  notesByKey,
  findingsAt = null,
}: NotePreviewProps) {
  const [state, setState] = useState<State>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const { domain, key } = summary;

  // Debounced so holding an arrow key does not send a read per row.
  // The last note stays on screen (aria-busy) until the new one arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt only retries.
  useEffect(() => {
    let live = true;
    setCopiedId(null);
    setState((s) => (s.state === "error" ? { state: "loading" } : s));
    const timer = window.setTimeout(
      () => {
        getNote(domain, key)
          .then((note) => {
            if (!live) return;
            loadedOnce.current = true;
            setState({ state: "ready", note });
          })
          .catch((e: unknown) => live && setState({ state: "error", error: toCommandError(e) }));
      },
      loadedOnce.current ? LOAD_DELAY_MS : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [domain, key, attempt]);

  const current = state.state === "ready" && state.note.key === key && state.note.domain === domain;
  const busy = !current && state.state !== "error";
  const label = findingsAt ? `Reflect, ${formatDate(findingsAt)}` : "Reflect";
  const callouts = findings.slice(0, MAX_CALLOUTS);
  const copyCommand = async (f: Finding) => {
    const text = `Fix the Kioku note ${key} in ${domain}: ${f.text}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(f.id);
    } catch {
      setCopiedId(null);
    }
  };

  const href = noteHref(domain, key);

  return (
    <article className="library-note" aria-labelledby="library-note-title" aria-busy={busy}>
      <div className="k-note-head">
        <div className="k-facts">
          <span className="k-key">{key}</span>
          <StatusPill tone={summary.status}>{summary.status}</StatusPill>
          {findings.some((f) => f.state === "unverified") ? (
            <StatusPill tone="unverified">unverified</StatusPill>
          ) : null}
          <span className="k-fact">{kindLabel(summary.kind)}</span>
          <span className="k-fact">{originText(summary.origin, summary.source)}</span>
        </div>
        <h2 id="library-note-title">
          <a href={href}>{summary.title}</a>
        </h2>
        <span className="k-meta">Updated {formatDate(summary.updatedAt)}</span>
      </div>

      {callouts.map((f) => (
        <FindingCallout
          key={f.id}
          kind={label}
          actions={
            <>
              <Button size="sm" onClick={() => navigate(reflectHref(domain, f.id))}>
                Show the finding
              </Button>
              {summary.origin === "agent" ? (
                <Button size="sm" onClick={() => void copyCommand(f)}>
                  {copiedId === f.id ? "Command copied" : "Copy a fix command"}
                </Button>
              ) : null}
            </>
          }
        >
          {f.text}
        </FindingCallout>
      ))}
      {findings.length > MAX_CALLOUTS ? (
        <a href={reflectHref(domain)}>{findings.length} findings</a>
      ) : null}

      {state.state === "loading" && !loadedOnce.current ? (
        <p className="k-count" role="status">
          Loading the note…
        </p>
      ) : null}
      {state.state === "error" ? (
        <EmptyState
          title="This note could not be loaded"
          action={
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        >
          {state.error.message}
        </EmptyState>
      ) : null}
      {state.state === "ready" ? (
        <div className={current ? undefined : "library-stale"}>
          {/* Keyed by note so per-note state such as the expanded history resets. */}
          <NoteDetail
            key={`${state.note.domain}/${state.note.key}`}
            note={state.note}
            notesByKey={notesByKey}
          />
        </div>
      ) : null}

      <div className="library-note-actions">
        <Button size="sm" onClick={() => navigate(href)}>
          Open note
        </Button>
        <Button size="sm" variant="quiet" onClick={() => navigate(graphHref(domain, key))}>
          Open in graph
        </Button>
      </div>
    </article>
  );
}

function NoteDetail({
  note,
  notesByKey,
}: {
  note: Note;
  notesByKey: ReadonlyMap<string, NoteSummary> | undefined;
}) {
  const [allHistory, setAllHistory] = useState(false);
  const revisions = allHistory ? note.revisions : note.revisions.slice(0, HISTORY_SHOWN);
  const linkKeys = uniqueKeys(
    note.links.map((l) => `${l.relation}:${l.targetDomain}:${l.targetKey}`),
  );
  const revKeys = uniqueKeys(revisions.map((r) => `${r.at}:${r.summary}`));
  return (
    <>
      <p className="k-note-body library-body">{note.body}</p>

      <section aria-labelledby="library-links-title">
        <h3 id="library-links-title" className="k-list-title">
          Links
        </h3>
        {note.links.length === 0 ? (
          <p className="k-count">No links yet.</p>
        ) : (
          <ul className="k-links">
            {note.links.map((link, i) => (
              <li key={linkKeys[i]}>
                <span className="k-rel">
                  {relationLabel(link.relation)}
                  {link.suggested ? " (suggested)" : ""}
                </span>
                <LinkTarget
                  targetKey={link.targetKey}
                  targetDomain={link.targetDomain}
                  sameArea={link.targetDomain === note.domain}
                  notesByKey={notesByKey}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="library-history-title">
        <h3 id="library-history-title" className="k-list-title">
          History
        </h3>
        {note.revisions.length === 0 ? (
          <p className="k-count">No history recorded.</p>
        ) : (
          <ol className="k-history">
            {revisions.map((rev, i) => (
              <li key={revKeys[i]}>
                {formatDateTime(rev.at)} · {rev.summary}
              </li>
            ))}
          </ol>
        )}
        {!allHistory && note.revisions.length > HISTORY_SHOWN ? (
          <Button size="sm" variant="quiet" onClick={() => setAllHistory(true)}>
            Show all {note.revisions.length} revisions
          </Button>
        ) : null}
      </section>
    </>
  );
}

interface LinkTargetProps {
  targetKey: string;
  targetDomain: string;
  sameArea: boolean;
  notesByKey: ReadonlyMap<string, NoteSummary> | undefined;
}

function LinkTarget({ targetKey, targetDomain, sameArea, notesByKey }: LinkTargetProps) {
  const target = sameArea ? notesByKey?.get(targetKey) : undefined;
  if (sameArea && notesByKey && !target) {
    return (
      <span>
        <span className="k-mono">{targetKey}</span> no such note
      </span>
    );
  }
  return (
    <>
      <a href={noteHref(targetDomain, targetKey)}>
        <span className="k-mono">{targetKey}</span>
        {target ? ` ${target.title}` : null}
      </a>
      {target?.status === "legacy" ? <StatusPill tone="legacy">legacy</StatusPill> : null}
    </>
  );
}
