// The graph's settings panel, copying Obsidian's: hidden behind a button, four collapsible
// sections, and every change applied at once so the graph answers while you drag.
import { type KeyboardEvent, type ReactNode, useEffect, useId } from "react";
import { Icon, IconButton, Switch } from "../../components/ui";
import { FORCE_RANGES, type Forces } from "./forces";
import { paletteColour } from "./palette";
import {
  clampNumber,
  DISPLAY_RANGES,
  type GraphDisplay,
  type GraphFilters,
  type GraphGroup,
  MAX_GROUPS,
  type PanelState,
  type Range,
  type GraphSettings as Settings,
} from "./settings";
import "./graphSettings.css";

export interface GraphSettingsProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onReset: () => void;
  panel: PanelState;
  onPanelChange: (next: PanelState) => void;
  onHighlight: (query: string | null) => void;
  onClose: () => void;
}

type SectionId = keyof PanelState["sections"];

let groupCounter = 0;
function newGroupId(): string {
  groupCounter += 1;
  return `group-${Date.now().toString(36)}-${groupCounter}`;
}

function Section({
  id,
  title,
  panel,
  onPanelChange,
  children,
}: {
  id: SectionId;
  title: string;
  panel: PanelState;
  onPanelChange: (next: PanelState) => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  const open = panel.sections[id];
  return (
    <section className="gs-section">
      <button
        type="button"
        className="gs-section-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onPanelChange({ ...panel, sections: { ...panel.sections, [id]: !open } })}
      >
        <span className={`gs-chevron${open ? "" : " gs-chevron-closed"}`}>
          <Icon name="chevron" size={12} />
        </span>
        {title}
      </button>
      {open && (
        <div id={bodyId} className="gs-section-body">
          {children}
        </div>
      )}
    </section>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const labelId = useId();
  return (
    <div className="gs-row">
      <span id={labelId}>{label}</span>
      <Switch small checked={checked} onChange={onChange} labelledBy={labelId} />
    </div>
  );
}

function format(value: number, step: number): string {
  return step >= 1 ? String(Math.round(value)) : value.toFixed(2).replace(/\.?0+$/, "");
}

function Slider({
  label,
  value,
  range,
  onChange,
}: {
  label: string;
  value: number;
  range: Range;
  onChange: (next: number) => void;
}) {
  const inputId = useId();
  return (
    <div className="gs-slider">
      <div className="gs-slider-label">
        <label htmlFor={inputId}>{label}</label>
        <output htmlFor={inputId}>{format(value, range.step)}</output>
      </div>
      <input
        id={inputId}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(clampNumber(Number(e.currentTarget.value), range, value))}
      />
    </div>
  );
}

function GroupRow({
  group,
  index,
  onChange,
  onRemove,
  onHighlight,
}: {
  group: GraphGroup;
  index: number;
  onChange: (next: GraphGroup) => void;
  onRemove: () => void;
  onHighlight: (query: string | null) => void;
}) {
  const name = `Group ${index + 1}`;
  // An empty query matches nothing as a group, so it highlights nothing either.
  const highlight = (query: string) => onHighlight(query.trim() === "" ? null : query);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only previews the group; focus does the same for keyboards
    <div
      className="gs-group"
      onMouseEnter={() => highlight(group.query)}
      onMouseLeave={() => onHighlight(null)}
      onFocus={() => highlight(group.query)}
      onBlur={(e) => {
        // Moving between this row's own fields keeps the highlight.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHighlight(null);
      }}
    >
      <label className="gs-swatch" style={{ background: group.color }} title="Colour">
        <input
          type="color"
          aria-label={`${name} colour`}
          value={group.color}
          onChange={(e) => onChange({ ...group, color: e.currentTarget.value.toLowerCase() })}
        />
      </label>
      <input
        type="text"
        className="gs-input"
        aria-label={`${name} query`}
        placeholder="Enter query"
        spellCheck={false}
        value={group.query}
        onChange={(e) => {
          const query = e.currentTarget.value;
          onChange({ ...group, query });
          highlight(query);
        }}
      />
      <IconButton icon="close" label={`Remove ${name.toLowerCase()}`} onClick={onRemove} />
    </div>
  );
}

/** The first palette colour no group uses, so a new group never looks like an existing one. */
function unusedColour(groups: readonly GraphGroup[]): string {
  const used = new Set(groups.map((g) => g.color));
  let i = 0;
  while (used.has(paletteColour(i)) && i < MAX_GROUPS + 1) i += 1;
  return paletteColour(i);
}

export function GraphSettings({
  settings,
  onChange,
  onReset,
  panel,
  onPanelChange,
  onHighlight,
  onClose,
}: GraphSettingsProps) {
  const hintId = useId();
  // Give focus back to whatever opened the panel (the settings button) when it closes.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  const setFilters = (patch: Partial<GraphFilters>) =>
    onChange({ ...settings, filters: { ...settings.filters, ...patch } });
  const setDisplay = (patch: Partial<GraphDisplay>) =>
    onChange({ ...settings, display: { ...settings.display, ...patch } });
  const setForce = (key: keyof Forces, value: number) =>
    onChange({ ...settings, forces: { ...settings.forces, [key]: value } });
  const setGroups = (groups: GraphGroup[]) => onChange({ ...settings, groups });

  const onKeyDown = (e: KeyboardEvent) => {
    // Keys typed in the panel are not graph shortcuts.
    e.stopPropagation();
    if (e.key === "Escape") onClose();
  };

  const section = (id: SectionId, title: string, children: ReactNode) => (
    <Section id={id} title={title} panel={panel} onPanelChange={onPanelChange}>
      {children}
    </Section>
  );

  return (
    <section className="gs-panel" aria-label="Graph settings" onKeyDown={onKeyDown}>
      <div className="gs-head">
        <span className="gs-title">Graph settings</span>
        <IconButton icon="restore" label="Restore default settings" onClick={onReset} />
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>

      {section(
        "filters",
        "Filters",
        <>
          <input
            type="search"
            className="gs-input"
            aria-label="Search notes"
            aria-describedby={hintId}
            placeholder="Search notes"
            spellCheck={false}
            value={settings.filters.query}
            onChange={(e) => setFilters({ query: e.currentTarget.value })}
          />
          <p id={hintId} className="gs-hint">
            Words, "phrases", type:decision, path:folder/, -word to exclude
          </p>
          <SwitchRow
            label="Legacy notes"
            checked={settings.filters.legacy}
            onChange={(legacy) => setFilters({ legacy })}
          />
          <SwitchRow
            label="Links Reflect suggests"
            checked={settings.filters.suggested}
            onChange={(suggested) => setFilters({ suggested })}
          />
          <SwitchRow
            label="Orphans"
            checked={settings.filters.orphans}
            onChange={(orphans) => setFilters({ orphans })}
          />
        </>,
      )}

      {section(
        "groups",
        "Groups",
        <>
          {settings.groups.map((group, i) => (
            <GroupRow
              key={group.id}
              group={group}
              index={i}
              onHighlight={onHighlight}
              onChange={(next) =>
                setGroups(settings.groups.map((g) => (g.id === group.id ? next : g)))
              }
              onRemove={() => {
                onHighlight(null);
                setGroups(settings.groups.filter((g) => g.id !== group.id));
              }}
            />
          ))}
          <button
            type="button"
            className="k-btn gs-new-group"
            disabled={settings.groups.length >= MAX_GROUPS}
            onClick={() =>
              setGroups([
                ...settings.groups,
                { id: newGroupId(), query: "", color: unusedColour(settings.groups) },
              ])
            }
          >
            New group
          </button>
        </>,
      )}

      {section(
        "display",
        "Display",
        <>
          <SwitchRow
            label="Arrows"
            checked={settings.display.arrows}
            onChange={(arrows) => setDisplay({ arrows })}
          />
          <Slider
            label="Text fade threshold"
            value={settings.display.textFade}
            range={DISPLAY_RANGES.textFade}
            onChange={(textFade) => setDisplay({ textFade })}
          />
          <Slider
            label="Node size"
            value={settings.display.nodeSize}
            range={DISPLAY_RANGES.nodeSize}
            onChange={(nodeSize) => setDisplay({ nodeSize })}
          />
          <Slider
            label="Link thickness"
            value={settings.display.linkThickness}
            range={DISPLAY_RANGES.linkThickness}
            onChange={(linkThickness) => setDisplay({ linkThickness })}
          />
          <SwitchRow
            label="Topic labels"
            checked={settings.display.topicLabels}
            onChange={(topicLabels) => setDisplay({ topicLabels })}
          />
        </>,
      )}

      {section(
        "forces",
        "Forces",
        <>
          <Slider
            label="Center force"
            value={settings.forces.center}
            range={FORCE_RANGES.center}
            onChange={(v) => setForce("center", v)}
          />
          <Slider
            label="Repel force"
            value={settings.forces.repel}
            range={FORCE_RANGES.repel}
            onChange={(v) => setForce("repel", v)}
          />
          <Slider
            label="Link force"
            value={settings.forces.link}
            range={FORCE_RANGES.link}
            onChange={(v) => setForce("link", v)}
          />
          <Slider
            label="Link distance"
            value={settings.forces.distance}
            range={FORCE_RANGES.distance}
            onChange={(v) => setForce("distance", v)}
          />
        </>,
      )}
    </section>
  );
}
