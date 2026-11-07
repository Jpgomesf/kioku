// Find an area (⌘O): search first, then Recent, then areas grouped by vault.
// Choosing an area calls pickArea() from app/area.ts.
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import { getVaultsConfig } from "../../api";
import { pickArea, useCurrentArea, useRecentAreas } from "../../app/area";
import {
  closeOverlay,
  moveActive,
  openOverlay,
  refreshAreas,
  useOverlay,
  usePresence,
} from "../../app/overlay";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Kbd } from "../ui/Kbd";
import "../palette/overlay.css";
import { type AreaEntry, areaKey, countLabel, countWords, flatOptions, groupAreas } from "./model";

export const openAreaSwitcher = (): void => openOverlay("area-switcher");
export const closeAreaSwitcher = (): void => closeOverlay("area-switcher");
export const useAreaSwitcherOpen = (): boolean => useOverlay() === "area-switcher";

export function AreaSwitcher() {
  const { mounted, closing, session, style } = usePresence("area-switcher");
  if (!mounted) return null;
  return (
    <Dialog
      key={session}
      label="Find an area"
      onClose={closeAreaSwitcher}
      className="k-overlay-shell"
      placement="top"
    >
      <AreaPanel style={style} closing={closing} />
    </Dialog>
  );
}

type Load = "loading" | "failed" | "done";

function useAreaEntries(): { entries: AreaEntry[]; load: Load } {
  const [entries, setEntries] = useState<AreaEntry[]>([]);
  const [load, setLoad] = useState<Load>("loading");
  useEffect(() => {
    let live = true;
    Promise.all([refreshAreas(), getVaultsConfig().catch(() => ({ vaults: [] }))])
      .then(([areas, config]) => {
        if (!live) return;
        const paths = new Map<string, string[]>();
        for (const vault of config.vaults)
          for (const a of vault.areas) paths.set(a.domain, a.paths);
        setEntries(areas.map((area) => ({ area, paths: paths.get(area.domain) ?? [] })));
        setLoad("done");
      })
      .catch(() => {
        if (live) setLoad("failed");
      });
    return () => {
      live = false;
    };
  }, []);
  return { entries, load };
}

function AreaPanel({ style, closing }: { style: CSSProperties; closing: boolean }) {
  const current = useCurrentArea();
  const recent = useRecentAreas();
  const { entries, load } = useAreaEntries();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const groups = useMemo(() => groupAreas(entries, query, recent), [entries, query, recent]);
  const flat = useMemo(() => flatOptions(groups), [groups]);
  // Start on the current area while nothing is chosen and the query is empty.
  const fallback = query.trim()
    ? 0
    : Math.max(
        0,
        flat.findIndex((o) => o.area.domain === current),
      );
  const found = flat.findIndex((o) => o.id === activeId);
  const activeIndex = found >= 0 ? found : fallback;
  const activeOption = flat[activeIndex];
  const domId = (id: string) => `${baseId}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const activeDomId = activeOption ? domId(activeOption.id) : undefined;

  useEffect(() => {
    if (activeDomId) document.getElementById(activeDomId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeDomId]);

  const choose = (domain: string | undefined) => {
    if (!domain || closing) return;
    pickArea(domain);
    closeAreaSwitcher();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (closing || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const key = areaKey(event);
    if (key === null) return;
    event.preventDefault();
    if (key === "open") {
      choose(activeOption?.area.domain);
      return;
    }
    const next = moveActive(activeIndex, key === "down" ? 1 : -1, flat.length);
    setActiveId(flat[next]?.id ?? null);
  };

  let status = "";
  if (load === "loading") status = "Loading areas…";
  else if (load === "failed") status = "Areas could not be loaded.";
  else if (entries.length === 0) status = "No areas yet.";
  else if (flat.length === 0) status = "No area matches.";

  return (
    <div
      className="k-area-panel"
      style={style}
      inert={closing}
      data-closing={closing ? "" : undefined}
    >
      <div className="k-area-search">
        <Icon name="search" />
        <input
          data-autofocus
          type="text"
          role="combobox"
          aria-label="Find an area, a vault or a folder"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeDomId}
          placeholder="Find an area, a vault or a folder"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <Kbd>esc</Kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Areas" className="k-area-list">
        {groups.map((group) => (
          // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group", not a fieldset.
          <div key={group.id} role="group" aria-labelledby={domId(`group-${group.id}`)}>
            <div id={domId(`group-${group.id}`)} className="k-area-group">
              {group.title}
            </div>
            {group.areas.map((area) => {
              const id = `${group.id}:${area.domain}`;
              const isCurrent = area.domain === current;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keys go through the search field (aria-activedescendant).
                <div
                  key={id}
                  id={domId(id)}
                  role="option"
                  aria-selected={activeOption?.id === id}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-label={`${area.label}${group.id === "recent" ? ` in ${area.vault}` : ""}, ${countWords(area)}${isCurrent ? ", current" : ""}`}
                  tabIndex={-1}
                  className="k-area-option"
                  onMouseMove={() => {
                    if (!closing && activeId !== id) setActiveId(id);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(area.domain)}
                >
                  <Icon name={isCurrent ? "check" : "folder"} />
                  <span className="k-grow">
                    {area.label}
                    {group.id === "recent" && <span className="k-area-in"> in {area.vault}</span>}
                  </span>
                  <span className="k-area-count">{countLabel(area)}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p role="status" className="k-palette-empty">
        {status}
      </p>
      <div className="k-area-foot">↑↓ move · ↵ open · matches areas, vaults and folders</div>
    </div>
  );
}
