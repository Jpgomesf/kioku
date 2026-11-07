// The Library: the current area's notes, filters kept in the route, and a preview pane.
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Area,
  type CommandError,
  type Finding,
  kindCounts,
  kindLabelPlural,
  listAreas,
  listNotes,
  listReflectRuns,
  type NoteSummary,
  type SearchHit,
  searchNotes,
  toCommandError,
} from "../../api";
import { useCurrentArea } from "../../app/area";
import { replaceEntry } from "../../app/history";
import { useOverlay } from "../../app/overlay";
import { type LibraryParams, libraryHref, navigate, noteHref } from "../../app/router";
import { openAreaSwitcher } from "../../components/area-switcher";
import {
  AreaButton,
  Button,
  Chip,
  EmptyState,
  Kbd,
  SearchField,
  StatusPill,
  showToast,
} from "../../components/ui";
import { useFlip } from "../../motion";
import { latestFinished } from "../reflect/state";
import {
  areaLabel,
  countsLine,
  filterAndSort,
  filterHits,
  filtersFromParams,
  footText,
  formatDate,
  inStatus,
  kindChips,
  type LibraryFilters,
  MAX_NOTE_LIST,
  MAX_SEARCH,
  matchedByText,
  matchesFilters,
  moveIndex,
  type OriginFilter,
  paramsFromFilters,
  plural,
  type StatusFilter,
  sevenDaysAgo,
  toggleKind,
} from "./logic";
import { NotePreview } from "./NotePreview";
import { markReviewed, useLastVisit } from "./useLastVisit";
import "./library.css";

export interface LibraryPageProps {
  params: LibraryParams;
}

/** Rows rendered at a time; more are added on request, so 1,600 notes stay fast. */
const PAGE = 100;
const SEARCH_DELAY_MS = 200;
const rowId = (key: string) => `library-row-${key}`;

/** The selected note per area, kept for the session so coming back from a note keeps its place. */
const lastSelected = new Map<string, string>();

type Load<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; error: CommandError };

interface Row {
  note: NoteSummary;
  matched: string | null;
}

interface Tagged<T> {
  domain: string;
  value: T;
}

function useAreaData(domain: string, reloadToken: number) {
  const [notes, setNotes] = useState<Load<NoteSummary[]>>({ state: "loading" });
  const [area, setArea] = useState<Tagged<Area | null> | null>(null);
  const [run, setRun] = useState<Tagged<{ findings: Finding[]; at: string | null }> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken only retries.
  useEffect(() => {
    let live = true;
    setNotes({ state: "loading" });
    listNotes({ domain, status: "all", limit: MAX_NOTE_LIST })
      .then((value) => live && setNotes({ state: "ready", value }))
      .catch((e: unknown) => live && setNotes({ state: "error", error: toCommandError(e) }));
    listAreas()
      .then(
        (areas) =>
          live && setArea({ domain, value: areas.find((a) => a.domain === domain) ?? null }),
      )
      .catch(() => live && setArea({ domain, value: null }));
    listReflectRuns(domain)
      .then((runs) => {
        if (!live) return;
        const latest = latestFinished(runs);
        setRun({
          domain,
          value: {
            findings: latest?.findings ?? [],
            at: latest ? (latest.finishedAt ?? latest.startedAt) : null,
          },
        });
      })
      .catch(() => live && setRun({ domain, value: { findings: [], at: null } }));
    return () => {
      live = false;
    };
  }, [domain, reloadToken]);

  // Values from the previous area are ignored until this area's requests answer.
  return {
    notes,
    area: area?.domain === domain ? area.value : null,
    findings: run?.domain === domain ? run.value.findings : [],
    findingsAt: run?.domain === domain ? run.value.at : null,
  };
}

interface SearchState {
  /** The area the hits belong to, so another area's hits are never shown as this one's. */
  domain: string;
  hits: Load<SearchHit[]> | null;
  pending: boolean;
}

function useSearch(
  domain: string,
  query: string,
  includeLegacy: boolean,
  attempt: number,
): { hits: Load<SearchHit[]> | null; pending: boolean } {
  const [result, setResult] = useState<SearchState>({ domain, hits: null, pending: false });
  const text = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt only retries.
  useEffect(() => {
    if (!text) {
      setResult({ domain, hits: null, pending: false });
      return;
    }
    let live = true;
    // Keep this area's last results on screen while the next search runs.
    setResult((prev) => ({
      domain,
      hits:
        prev.domain === domain && prev.hits?.state === "ready" ? prev.hits : { state: "loading" },
      pending: true,
    }));
    const timer = window.setTimeout(() => {
      searchNotes({ scope: { domain }, text, limit: MAX_SEARCH, includeLegacy })
        .then(
          (value) => live && setResult({ domain, hits: { state: "ready", value }, pending: false }),
        )
        .catch(
          (e: unknown) =>
            live &&
            setResult({
              domain,
              hits: { state: "error", error: toCommandError(e) },
              pending: false,
            }),
        );
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [domain, text, includeLegacy, attempt]);
  if (!text) return { hits: null, pending: false };
  // Until this area's search has started, show it as loading rather than the last area's hits.
  if (result.domain !== domain || result.hits === null) {
    return { hits: { state: "loading" }, pending: true };
  }
  return { hits: result.hits, pending: result.pending };
}

const ORIGIN_CHIPS: readonly { origin: OriginFilter; label: string }[] = [
  { origin: "file", label: "From a file" },
  { origin: "agent", label: "Saved by an agent" },
];

const STATUS_CHIPS: readonly { status: StatusFilter; label: string; pressedFor: StatusFilter[] }[] =
  [
    { status: "all", label: "Include legacy", pressedFor: ["all", "legacy"] },
    { status: "draft", label: "Drafts", pressedFor: ["draft"] },
  ];

export function LibraryPage({ params }: LibraryPageProps) {
  const domain = useCurrentArea();
  const switcherOpen = useOverlay() === "area-switcher";
  const lastVisit = useLastVisit(domain);
  const filters = useMemo(() => filtersFromParams(params, lastVisit), [params, lastVisit]);
  const [reload, setReload] = useState(0);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const { notes, area, findings, findingsAt } = useAreaData(domain, reload);
  const [draft, setDraft] = useState(filters.query);
  const { hits, pending } = useSearch(domain, draft, filters.status !== "active", searchAttempt);
  // Tied to the area: the page stays mounted across an area switch, and each area keeps its
  // own remembered row.
  const [selection, setSelection] = useState<{ domain: string; key: string | null }>(() => ({
    domain,
    key: lastSelected.get(domain) ?? null,
  }));
  const selectedKey =
    selection.domain === domain ? selection.key : (lastSelected.get(domain) ?? null);
  const setSelectedKey = useCallback(
    (key: string | null) => setSelection({ domain, key }),
    [domain],
  );
  const [shown, setShown] = useState(PAGE);
  const gridRef = useRef<HTMLTableElement>(null);
  const restoring = useRef(selectedKey !== null);

  // Keep the field in step with every route change (palette, sidebar, back button, Clear).
  // Keyed on the route only: typing replaces the URL without a route change, so a rebuild of
  // the filters for another reason (Mark as reviewed) must not reset the field.
  useEffect(() => setDraft(params.q ?? ""), [params]);

  useEffect(() => {
    if (selectedKey) lastSelected.set(domain, selectedKey);
  }, [domain, selectedKey]);

  const update = (next: Partial<LibraryFilters>) =>
    navigate(libraryHref(paramsFromFilters({ ...filters, query: draft, ...next })));

  const onQuery = (value: string) => {
    setDraft(value);
    // Replace the hash quietly so typing does not flood history with entries; the entry
    // keeps its place, so a note's Back button still names the Library.
    const href = libraryHref(paramsFromFilters({ ...filters, query: value }));
    replaceEntry(href);
  };

  const onClear = () => {
    setDraft("");
    navigate(libraryHref());
  };

  const findingsByKey = useMemo(() => {
    const map = new Map<string, Finding[]>();
    for (const f of findings) {
      for (const key of f.noteKeys) map.set(key, [...(map.get(key) ?? []), f]);
    }
    return map;
  }, [findings]);

  const allNotes = notes.state === "ready" ? notes.value : null;
  // Over the notes in the chosen status, not the filtered list: the chips stay put as the other
  // filters change, and a draft or legacy note doesn't add a count the list then hides.
  const areaKinds = useMemo(
    () => (allNotes ? kindCounts(allNotes.filter((n) => inStatus(n, filters.status))) : null),
    [allNotes, filters.status],
  );
  // Tied to the area, so switching areas starts collapsed again.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const typesExpanded = expandedFor === domain;
  const typeChips = kindChips(areaKinds, filters.kinds, typesExpanded);
  const moreRef = useRef<HTMLButtonElement>(null);
  const filtersRef = useRef<HTMLFieldSetElement>(null);
  // More types and Fewer types animate the chips' reflow (motion/flip.ts).
  const flipFilters = useFlip(filtersRef);
  const refocusChips = useRef(false);

  // A cleared chip that showed only because it was selected unmounts with focus on it; move
  // focus to a button that stays so the next Tab doesn't restart at the sidebar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once the new kinds render.
  useEffect(() => {
    if (!refocusChips.current) return;
    refocusChips.current = false;
    (moreRef.current ?? filtersRef.current?.querySelector<HTMLButtonElement>(".k-chip"))?.focus();
  }, [filters.kinds]);

  const onKindToggle = (kind: string) => {
    const kinds = toggleKind(filters.kinds, kind);
    const next = kindChips(areaKinds, kinds, typesExpanded);
    refocusChips.current = !next.chips.some((c) => c.kind === kind);
    update({ kinds });
  };
  const notesByKey = useMemo(() => new Map((allNotes ?? []).map((n) => [n.key, n])), [allNotes]);
  const listed = useMemo(
    () => (allNotes ? filterAndSort(allNotes, filters) : []),
    [allNotes, filters],
  );
  const searching = hits !== null;

  const rows: Row[] = useMemo(() => {
    if (hits?.state === "ready") {
      return filterHits(hits.value, filters).map((h) => ({
        note: h.note,
        matched: matchedByText(h.matchedBy, h.linkedFrom),
      }));
    }
    return listed.map((note) => ({ note, matched: null }));
  }, [hits, listed, filters]);

  // Reset paging when the list changes shape.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter or area change.
  useEffect(() => setShown(PAGE), [filters, domain, searching]);

  const selectedIndex = rows.findIndex((r) => r.note.key === selectedKey);
  const visible = rows.slice(0, Math.max(shown, selectedIndex + 1));
  const selected = selectedIndex >= 0 ? rows[selectedIndex]?.note : undefined;

  useEffect(() => {
    if (!selectedKey) return;
    const row = document.getElementById(rowId(selectedKey));
    row?.scrollIntoView?.({ block: "nearest" });
  }, [selectedKey]);

  // Back from a note: once the list first shows, put focus back on the restored row's grid.
  // Only that first time: if the row is filtered out, a later match must not steal focus.
  const listShown = (hits ?? notes).state === "ready";
  useEffect(() => {
    if (!restoring.current || !listShown) return;
    restoring.current = false;
    if (selectedIndex >= 0) gridRef.current?.focus();
  }, [listShown, selectedIndex]);

  const onSelect = useCallback((key: string) => setSelectedKey(key), [setSelectedKey]);

  const onTableKey = (event: KeyboardEvent<HTMLTableElement>) => {
    const deltas: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: 10,
      PageUp: -10,
    };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      const next = moveIndex(selectedIndex, delta, rows.length);
      setSelectedKey(rows[next]?.note.key ?? null);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setSelectedKey(rows[event.key === "Home" ? 0 : rows.length - 1]?.note.key ?? null);
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      navigate(noteHref(selected.domain, selected.key));
    }
  };

  const { label, vault } = areaLabel(domain, area);
  // The full timestamp, so the label shows the same local day with the chip off and on.
  const sinceDate = lastVisit ?? sevenDaysAgo();
  const counts = countsLine(allNotes, area);
  // Only when legacy notes are what the other filters would show, so a type whose notes are
  // all legacy leads to "Show legacy notes" rather than "Clear filters".
  const legacyHidden =
    !draft.trim() &&
    filters.status === "active" &&
    rows.length === 0 &&
    (allNotes ?? []).some((n) => matchesFilters(n, { ...filters, status: "legacy" }));

  return (
    <section className="page-panes library" aria-labelledby="library-title">
      <div className="library-list">
        <header className="library-head">
          <h1 id="library-title" className="library-title">
            {vault ? (
              <AreaButton
                label={label}
                vault={vault}
                expanded={switcherOpen}
                onClick={openAreaSwitcher}
              />
            ) : (
              <button
                type="button"
                className="k-area-button"
                aria-haspopup="dialog"
                aria-expanded={switcherOpen}
                onClick={openAreaSwitcher}
              >
                <span className="k-area-title">{label}</span>
                <Kbd>⌘O</Kbd>
              </button>
            )}
          </h1>
          {counts ? <p className="k-count">{counts}</p> : null}
        </header>

        <SearchField
          label="Search memory"
          value={draft}
          onChange={onQuery}
          placeholder={`Search ${label}`}
          hint={
            searching
              ? `Ranked by label, text, meaning and links. The top ${MAX_SEARCH} are filtered; turn filters off if they hide every hit.`
              : undefined
          }
        />

        <fieldset ref={filtersRef} className="k-chips library-filters">
          <legend className="k-sr">Filters</legend>
          <Chip
            pressed={filters.since !== null}
            onToggle={(on) =>
              update(
                on
                  ? { since: sinceDate, sinceLastVisit: true }
                  : { since: null, sinceLastVisit: false },
              )
            }
          >
            Changed since {formatDate(filters.since ?? sinceDate)}
          </Chip>
          {filters.since !== null && filters.sinceLastVisit ? (
            <button
              type="button"
              className="k-btn k-btn-quiet k-btn-sm"
              onClick={() => {
                markReviewed(domain);
                showToast({ tone: "ok", text: "Marked as reviewed." });
              }}
            >
              Mark as reviewed
            </button>
          ) : null}
          {typeChips.chips.map((c) => (
            <Chip
              key={c.kind}
              pressed={filters.kinds.includes(c.kind)}
              onToggle={() => onKindToggle(c.kind)}
            >
              {kindLabelPlural(c.kind)}
              {c.count === null ? null : (
                <>
                  {" "}
                  <span className="library-chip-count">{c.count}</span>
                </>
              )}
            </Chip>
          ))}
          {typeChips.overflow > 0 ? (
            <button
              ref={moreRef}
              type="button"
              className="k-btn k-btn-quiet k-btn-sm"
              aria-expanded={typesExpanded}
              onClick={() => {
                flipFilters();
                setExpandedFor(typesExpanded ? null : domain);
              }}
            >
              {typesExpanded ? "Fewer types" : `More types (${typeChips.hidden})`}
            </button>
          ) : null}
          {ORIGIN_CHIPS.map((c) => (
            <Chip
              key={c.origin}
              pressed={filters.origin === c.origin}
              onToggle={(on) => update({ origin: on ? c.origin : "any" })}
            >
              {c.label}
            </Chip>
          ))}
          {STATUS_CHIPS.map((c) => (
            <Chip
              key={c.status}
              pressed={c.pressedFor.includes(filters.status)}
              onToggle={(on) => update({ status: on ? c.status : "active" })}
            >
              {c.label}
            </Chip>
          ))}
        </fieldset>

        <ListBody
          notes={notes}
          hits={hits}
          rows={rows}
          query={draft.trim()}
          areaLabel={label}
          legacyHidden={legacyHidden}
          onRetry={
            hits?.state === "error"
              ? () => setSearchAttempt((n) => n + 1)
              : () => setReload((n) => n + 1)
          }
          onClear={onClear}
          onShowLegacy={() => update({ status: "all" })}
        >
          {pending ? (
            <p className="k-sr" role="status">
              Searching…
            </p>
          ) : null}
          <div className="library-scroll">
            <table
              ref={gridRef}
              className={`k-table library-table${pending ? " library-pending" : ""}`}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an ARIA grid on a table is the standard pattern for a keyboard-driven row list.
              role="grid"
              aria-label={searching ? "Search results" : "Notes"}
              aria-rowcount={rows.length + 1}
              aria-activedescendant={selected ? rowId(selected.key) : undefined}
              aria-busy={pending}
              tabIndex={0}
              onKeyDown={onTableKey}
              onFocus={() => {
                if (!selected && rows[0]) setSelectedKey(rows[0].note.key);
              }}
            >
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ note, matched }, i) => (
                  <NoteRow
                    key={note.key}
                    index={i + 2}
                    note={note}
                    matched={matched}
                    findings={(findingsByKey.get(note.key)?.length ?? 0) || note.findingCount}
                    selected={note.key === selectedKey}
                    onSelect={onSelect}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <footer className="library-foot">
            <span className="k-count">{footText(rows.length, searching, filters)}</span>
            {visible.length < rows.length ? (
              <Button size="sm" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - visible.length)} more
              </Button>
            ) : null}
          </footer>
        </ListBody>
      </div>

      <aside className="library-preview" aria-label="Preview">
        {selected ? (
          <NotePreview
            summary={selected}
            findings={findingsByKey.get(selected.key) ?? []}
            notesByKey={allNotes ? notesByKey : undefined}
            findingsAt={findingsAt}
          />
        ) : (
          <EmptyState title="No note selected">
            Pick a note to read it here. Use the arrow keys to move and Enter to open it.
          </EmptyState>
        )}
      </aside>
    </section>
  );
}

interface ListBodyProps {
  notes: Load<NoteSummary[]>;
  hits: Load<SearchHit[]> | null;
  rows: Row[];
  query: string;
  areaLabel: string;
  legacyHidden: boolean;
  onRetry: () => void;
  onClear: () => void;
  onShowLegacy: () => void;
  children: ReactNode;
}

function ListBody({
  notes,
  hits,
  rows,
  query,
  areaLabel: label,
  legacyHidden,
  onRetry,
  onClear,
  onShowLegacy,
  children,
}: ListBodyProps) {
  const source = hits ?? notes;
  if (source.state === "loading") {
    return (
      <p className="k-count" role="status">
        {hits ? "Searching…" : "Loading notes…"}
      </p>
    );
  }
  if (source.state === "error") {
    return (
      <EmptyState
        title={hits ? "Search failed" : "Notes could not be loaded"}
        action={
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {source.error.message}
      </EmptyState>
    );
  }
  if (rows.length > 0) return <>{children}</>;
  if (!query && notes.state === "ready" && notes.value.length === 0) {
    return (
      <EmptyState title={`No notes in ${label} yet`}>
        Notes saved here will show up in this list.
      </EmptyState>
    );
  }
  if (!query && legacyHidden) {
    return (
      <EmptyState
        title="Only legacy notes here"
        action={
          <Button size="sm" onClick={onShowLegacy}>
            Show legacy notes
          </Button>
        }
      >
        Legacy notes are hidden by default.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      title={query ? `No notes match “${query}”` : "No notes match these filters"}
      action={
        <Button size="sm" onClick={onClear}>
          {query ? "Clear the search" : "Clear filters"}
        </Button>
      }
    >
      {query ? "Try other words, or search with fewer filters." : "Turn a filter off to see more."}
    </EmptyState>
  );
}

interface NoteRowProps {
  index: number;
  note: NoteSummary;
  matched: string | null;
  findings: number;
  selected: boolean;
  onSelect: (key: string) => void;
}

const NoteRow = memo(function NoteRow({
  index,
  note,
  matched,
  findings,
  selected,
  onSelect,
}: NoteRowProps) {
  return (
    <tr
      id={rowId(note.key)}
      data-key={note.key}
      aria-rowindex={index}
      aria-selected={selected}
      className={note.status === "legacy" ? "k-legacy-row" : undefined}
      onClick={() => onSelect(note.key)}
      onDoubleClick={() => navigate(noteHref(note.domain, note.key))}
    >
      <td className="k-key">
        <a href={noteHref(note.domain, note.key)} tabIndex={-1} className="library-key">
          {note.key}
        </a>
      </td>
      <td className="k-title">
        {note.title}
        {matched ? <span className="library-matched">{matched}</span> : null}
      </td>
      <td>
        {findings > 0 ? (
          <StatusPill tone="finding">{plural(findings, "finding")}</StatusPill>
        ) : (
          <StatusPill tone={note.status}>{note.status}</StatusPill>
        )}
      </td>
      <td className="k-date">{formatDate(note.updatedAt)}</td>
    </tr>
  );
});
