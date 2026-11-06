// The command palette (⌘K): recent notes or notes from search with what matched them, then
// commands. ↑↓ move, Enter opens, ⌘Enter opens in the graph, Tab searches the whole vault,
// Esc closes.
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import {
  type Area,
  listNotes,
  type NoteSummary,
  type SearchHit,
  type SearchScope,
  searchNotes,
  toCommandError,
} from "../../api";
import { useCurrentArea } from "../../app/area";
import {
  closeOverlay,
  hasCommandKey,
  isMac,
  loadAreas,
  moveActive,
  openOverlay,
  useOverlay,
  usePresence,
} from "../../app/overlay";
import { navigate } from "../../app/router";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";
import {
  buildOptions,
  type PaletteOption,
  type PaletteSection,
  paletteKey,
  sinceDate,
} from "./model";
import "./overlay.css";

export { type PaletteKey, paletteKey } from "./model";

export const openPalette = (): void => openOverlay("palette");
export const closePalette = (): void => closeOverlay("palette");
export const usePaletteOpen = (): boolean => useOverlay() === "palette";

const SEARCH_DELAY_MS = 120;
const SEARCH_LIMIT = 6;
const RECENT_LIMIT = 4;
const SECTIONS: readonly PaletteSection[] = ["Recent", "Notes", "Commands"];

export function Palette() {
  const { mounted, closing, session, style } = usePresence("palette");
  if (!mounted) return null;
  return (
    <Dialog
      key={session}
      label="Command palette"
      onClose={closePalette}
      className="k-overlay-shell"
      placement="top"
    >
      <PalettePanel style={style} closing={closing} />
    </Dialog>
  );
}

type AreaState =
  | { status: "loading" }
  | { status: "done"; area: Area | null }
  | { status: "error" };

function useArea(domain: string): AreaState {
  const [state, setState] = useState<AreaState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    loadAreas()
      .then((areas) => {
        if (live)
          setState({ status: "done", area: areas.find((a) => a.domain === domain) ?? null });
      })
      .catch(() => {
        if (live) setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [domain]);
  return state;
}

function useRecentNotes(domain: string): NoteSummary[] {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  useEffect(() => {
    let live = true;
    listNotes({ domain, limit: 50 })
      .then((found) => {
        if (!live) return;
        const sorted = [...found].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        setNotes(sorted.slice(0, RECENT_LIMIT));
      })
      .catch(() => {
        if (live) setNotes([]);
      });
    return () => {
      live = false;
    };
  }, [domain]);
  return notes;
}

export type SearchStatus = "idle" | "loading" | "error" | "done";

interface SearchResult {
  /** Only hits for the current text and scope; stale hits are never shown. */
  hits: SearchHit[];
  status: SearchStatus;
  error: string | null;
}

interface SearchState {
  key: string;
  hits: SearchHit[];
  error: string | null;
}

function searchKey(q: string, scope: SearchScope): string {
  return JSON.stringify([q, scope]);
}

function useSearch(text: string, domain: string, vault: string | null, wholeVault: boolean) {
  const q = text.trim();
  // Only the vault of a widened search matters, so the vault loading doesn't search again.
  const scopeVault = wholeVault ? vault : null;
  const key = searchKey(q, scopeVault ? { vault: scopeVault } : { domain });
  const [state, setState] = useState<SearchState | null>(null);
  useEffect(() => {
    if (!q) return;
    const scope: SearchScope = scopeVault ? { vault: scopeVault } : { domain };
    const key = searchKey(q, scope);
    let live = true;
    const timer = window.setTimeout(() => {
      searchNotes({ scope, text: q, limit: SEARCH_LIMIT })
        .then((hits) => {
          if (live) setState({ key, hits, error: null });
        })
        .catch((error: unknown) => {
          if (live) setState({ key, hits: [], error: toCommandError(error).message });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q, scopeVault, domain]);
  if (!q) return { hits: [], status: "idle", error: null } satisfies SearchResult;
  if (state?.key !== key)
    return { hits: [], status: "loading", error: null } satisfies SearchResult;
  if (state.error) return { hits: [], status: "error", error: state.error } satisfies SearchResult;
  return { hits: state.hits, status: "done", error: null } satisfies SearchResult;
}

function statusText(
  search: SearchResult,
  noteCount: number,
  commandCount: number,
  scope: string,
): string {
  if (search.status === "loading") return "Searching…";
  if (search.status === "error") return `Search failed: ${search.error ?? "unknown error"}`;
  if (search.status === "done" && noteCount === 0) return `No notes match in ${scope}.`;
  if (search.status === "done") {
    const notes = `${noteCount} ${noteCount === 1 ? "note" : "notes"}`;
    const cmds = `${commandCount} ${commandCount === 1 ? "command" : "commands"}`;
    return `${notes}, ${cmds} in ${scope}`;
  }
  return "";
}

function PalettePanel({ style, closing }: { style: CSSProperties; closing: boolean }) {
  const domain = useCurrentArea();
  const areaState = useArea(domain);
  const area = areaState.status === "done" ? areaState.area : null;
  const vault = area?.vault ?? null;
  const recent = useRecentNotes(domain);
  const [query, setQuery] = useState("");
  const [wholeVault, setWholeVault] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const search = useSearch(query, domain, vault, wholeVault);
  const since = useMemo(() => sinceDate(domain), [domain]);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const scopeId = `${baseId}-scope`;
  const statusId = `${baseId}-status`;
  const mac = isMac();

  const options = useMemo(
    () => buildOptions({ query, hits: search.hits, recent, since, vault, wholeVault }),
    [query, search.hits, recent, since, vault, wholeVault],
  );
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.id === activeId),
  );
  const current = options[activeIndex];
  const optionId = (o: PaletteOption) => `${baseId}-${o.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const activeDomId = current ? optionId(current) : undefined;

  useEffect(() => {
    if (activeDomId) document.getElementById(activeDomId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeDomId]);

  const widen = () => {
    setWholeVault(true);
    setActiveId(null);
  };

  const run = (option: PaletteOption | undefined, inGraph: boolean) => {
    if (!option || closing) return;
    if (option.action.type === "search-vault") {
      widen();
      return;
    }
    closePalette();
    navigate(inGraph && option.graphHref ? option.graphHref : option.action.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (closing || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const key = paletteKey(event, mac);
    if (key === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === "down" || key === "up") {
      const next = moveActive(activeIndex, key === "down" ? 1 : -1, options.length);
      setActiveId(options[next]?.id ?? null);
    } else if (key === "tab") {
      if (query.trim() && vault) widen();
    } else {
      run(current, key === "open-graph");
    }
  };

  const areaName = area?.label ?? domain;
  const scopeText = wholeVault && vault ? `all of ${vault}` : areaName;
  const sections = SECTIONS.map((name) => ({
    name,
    items: options.filter((o) => o.section === name),
  })).filter((s) => s.items.length > 0);
  const noteCount = options.filter((o) => o.section === "Notes").length;
  const status = statusText(search, noteCount, options.length - noteCount, scopeText);
  const vaultHint =
    query.trim() && !wholeVault && !vault
      ? areaState.status === "loading"
        ? "Finding the vault…"
        : "The whole-vault search is unavailable: this area's vault is unknown."
      : "";

  return (
    <div
      className="k-palette"
      style={style}
      inert={closing}
      data-closing={closing ? "" : undefined}
    >
      <div className="k-palette-input">
        <Icon name="search" />
        <input
          data-autofocus
          type="text"
          role="combobox"
          aria-label="Search notes and commands"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeDomId}
          aria-describedby={`${scopeId} ${statusId}`}
          placeholder="Search notes and commands"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setWholeVault(false);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <span id={scopeId} className="k-palette-scope">
          {wholeVault && vault ? (
            <span className="k-palette-scope-area">all of {vault}</span>
          ) : (
            <>
              <span className="k-palette-scope-area">{areaName}</span>
              {vault && ` in ${vault}`}
            </>
          )}
        </span>
        <Kbd>esc</Kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="k-palette-list">
        {sections.map((section) => (
          // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group", not a fieldset.
          <div key={section.name} role="group" aria-labelledby={`${baseId}-${section.name}`}>
            <div id={`${baseId}-${section.name}`} className="k-palette-section k-section-label">
              {section.name}
            </div>
            {section.items.map((option) => {
              const selected = option === current;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keys go through the search field (aria-activedescendant).
                <div
                  key={option.id}
                  id={optionId(option)}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  className="k-palette-item"
                  onMouseMove={() => {
                    if (!closing && activeId !== option.id) setActiveId(option.id);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => run(option, hasCommandKey(event, mac))}
                >
                  {option.code ? (
                    <span className="k-mono">{option.code}</span>
                  ) : (
                    <Icon name={option.icon ?? "forward"} />
                  )}
                  <span className="k-grow">
                    <span className="k-palette-title">{option.label}</span>
                    {option.meta && <span className="k-palette-meta">{option.meta}</span>}
                  </span>
                  {option.hint ? <Kbd>{option.hint}</Kbd> : selected && <Kbd>↵</Kbd>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p id={statusId} role="status" className="k-palette-empty">
        {[status, vaultHint].filter(Boolean).join(" ")}
      </p>
      <div className="k-palette-foot">
        <span>
          <Kbd>↑↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>{mac ? "⌘↵" : "Ctrl ↵"}</Kbd> open in graph
        </span>
        <span>
          <Kbd>⇥</Kbd> search the whole vault
        </span>
        <span className="k-palette-foot-end">
          Exact IDs and titles first, then words and meaning
        </span>
      </div>
    </div>
  );
}
