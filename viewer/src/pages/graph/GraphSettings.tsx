// The graph's settings box, copying Obsidian's: four collapsible sections, open by default
// under the gear, and every change applied at once so the graph answers while you drag. Beyond
// Obsidian, it colours and separates the graph by colour group or by brain region (the clusters
// the links form), lists what the canvas names so each part can be reached from the keyboard,
// and sets how many links away a hovered or selected note lights up.
import { type KeyboardEvent, type ReactNode, useId } from "react";
import {
  Icon,
  IconButton,
  SegmentedControl,
  type SegmentOption,
  Switch,
} from "../../components/ui";
import { FORCE_RANGES, type Forces } from "./forces";
import { DISTINCT_COLOURS, paletteColour } from "./palette";
import {
  type ColourBy,
  clampNumber,
  DISPLAY_RANGES,
  type GraphClusters,
  type GraphDisplay,
  type GraphFilters,
  type GraphGroup,
  MAX_GROUPS,
  type PanelState,
  type Range,
  type SeparateBy,
  type GraphSettings as Settings,
  toHighlightDepth,
} from "./settings";
import "./graphSettings.css";

/** A part of the graph the canvas names: a brain region, or a colour group while the graph is
 * separated by them. */
export interface NamedPart {
  id: number;
  /** As the canvas shows it, with its size ("billing · 120"). */
  name: string;
  /** The colour its notes are drawn in, when they share one; null when they do not. */
  colour: string | null;
}

export interface GraphSettingsProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onReset: () => void;
  panel: PanelState;
  onPanelChange: (next: PanelState) => void;
  onHighlight: (query: string | null) => void;
  onClose: () => void;
  /** Replays how the area grew, as Obsidian's Animate button does. */
  onAnimate: () => void;
  /** What the canvas names, largest first; listed under Region labels. */
  named?: readonly NamedPart[];
  /** Frames a named part, as a click on its name on the canvas does. */
  onZoomTo?: (id: number) => void;
}

type SectionId = keyof PanelState["sections"];

const COLOUR_BY: readonly SegmentOption<ColourBy>[] = [
  { value: "groups", label: "Groups" },
  { value: "regions", label: "Brain regions" },
];

const SEPARATE_BY: readonly SegmentOption<SeparateBy>[] = [
  { value: "none", label: "None" },
  { value: "groups", label: "Colour groups" },
  { value: "regions", label: "Brain regions" },
];

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
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** One line under the row saying what the setting does; it also describes the switch. */
  hint?: string;
}) {
  const labelId = useId();
  const hintId = useId();
  const row = (
    <div className="gs-row">
      <span id={labelId}>{label}</span>
      <Switch
        small
        checked={checked}
        onChange={onChange}
        labelledBy={labelId}
        describedBy={hint ? hintId : undefined}
      />
    </div>
  );
  if (!hint) return row;
  return (
    <div className="gs-switch">
      {row}
      <p id={hintId} className="gs-hint">
        {hint}
      </p>
    </div>
  );
}

/** The parts the canvas names, as buttons that frame each one: the way to them from the
 * keyboard and for screen readers, which never see the canvas, and the key to their colours. */
function NamedParts({
  parts,
  groups,
  onZoomTo,
}: {
  parts: readonly NamedPart[];
  /** True while the parts are colour groups rather than brain regions. */
  groups: boolean;
  onZoomTo: (id: number) => void;
}) {
  return (
    <ul className="gs-parts" aria-label={groups ? "Named colour groups" : "Named brain regions"}>
      {parts.map((part) => (
        <li key={part.id}>
          <button
            type="button"
            className="gs-part"
            aria-label={`Zoom to ${part.name}`}
            onClick={() => onZoomTo(part.id)}
          >
            {part.colour && (
              <span
                className="gs-part-swatch"
                style={{ background: part.colour }}
                aria-hidden="true"
              />
            )}
            <span className="gs-part-name">{part.name}</span>
          </button>
        </li>
      ))}
    </ul>
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
  hint,
}: {
  label: string;
  value: number;
  range: Range;
  onChange: (next: number) => void;
  /** One line under the track saying what the setting does; it also describes the slider. */
  hint?: string;
}) {
  const inputId = useId();
  const hintId = useId();
  return (
    <div className="gs-slider">
      <label htmlFor={inputId}>{label}</label>
      {/* The value sits left of the track, as in Obsidian. */}
      <div className="gs-slider-track">
        <output htmlFor={inputId}>{format(value, range.step)}</output>
        <input
          id={inputId}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          aria-valuetext={format(value, range.step)}
          aria-describedby={hint ? hintId : undefined}
          onChange={(e) => onChange(clampNumber(Number(e.currentTarget.value), range, value))}
        />
      </div>
      {hint && (
        <p id={hintId} className="gs-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A setting with two or three answers, as a small segmented control the width of the box. */
function Choice<T extends string>(props: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="gs-choice">
      <SegmentedControl {...props} />
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
      <label className="gs-swatch" style={{ background: group.color }} title="Colour">
        <input
          type="color"
          aria-label={`${name} colour`}
          value={group.color}
          onChange={(e) => onChange({ ...group, color: e.currentTarget.value.toLowerCase() })}
        />
      </label>
      <IconButton icon="close" label={`Remove ${name.toLowerCase()}`} onClick={onRemove} />
    </div>
  );
}

/** Whether the groups colour or separate the graph. Only then are their rows listed: with colours
 * from brain regions and nothing separated by group, the rows would show colours nothing uses. */
function groupsInUse(clusters: GraphClusters): boolean {
  return clusters.colourBy === "groups" || clusters.separateBy === "groups";
}

/** The first palette colour no group uses, so a new group never looks like an existing one. */
function unusedColour(groups: readonly GraphGroup[]): string {
  const used = new Set(groups.map((g) => g.color));
  let i = 0;
  while (used.has(paletteColour(i)) && i < MAX_GROUPS + 1) i += 1;
  return paletteColour(i);
}

/** The box. Where focus goes when it closes is the page's call: the box opens with the page,
 * so whatever had focus when it mounted is not what opened it. */
export function GraphSettings({
  settings,
  onChange,
  onReset,
  panel,
  onPanelChange,
  onHighlight,
  onClose,
  onAnimate,
  named = [],
  onZoomTo,
}: GraphSettingsProps) {
  const hintId = useId();
  const setFilters = (patch: Partial<GraphFilters>) =>
    onChange({ ...settings, filters: { ...settings.filters, ...patch } });
  const setDisplay = (patch: Partial<GraphDisplay>) =>
    onChange({ ...settings, display: { ...settings.display, ...patch } });
  const setForce = (key: keyof Forces, value: number) =>
    onChange({ ...settings, forces: { ...settings.forces, [key]: value } });
  const setClusters = (patch: Partial<GraphClusters>) => {
    const clusters = { ...settings.clusters, ...patch };
    // A row that goes away under the pointer gets no mouseleave, so its highlight would stay.
    if (groupsInUse(settings.clusters) && !groupsInUse(clusters)) onHighlight(null);
    onChange({ ...settings, clusters });
  };
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

  const { colourBy, separateBy } = settings.clusters;

  return (
    <section className="gs-panel" aria-label="Graph settings" onKeyDown={onKeyDown}>
      {/* Only the two small icons, as in Obsidian; the panel's name is its aria-label. */}
      <div className="gs-head">
        <IconButton icon="restore" label="Restore default settings" onClick={onReset} />
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>

      {section(
        "filters",
        "Filters",
        <>
          <div className="gs-search">
            <span className="gs-search-icon" aria-hidden="true">
              <Icon name="search" size={12} />
            </span>
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
          </div>
          <p id={hintId} className="gs-hint">
            Try type:, tag:, path: or -word to exclude
          </p>
          <SwitchRow
            label="Tags"
            checked={settings.filters.tags}
            onChange={(tags) => setFilters({ tags })}
          />
          <SwitchRow
            label="Orphans"
            checked={settings.filters.orphans}
            onChange={(orphans) => setFilters({ orphans })}
          />
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
        </>,
      )}

      {section(
        "groups",
        "Groups",
        <>
          <Choice
            label="Colour by"
            options={COLOUR_BY}
            value={colourBy}
            onChange={(next) => setClusters({ colourBy: next })}
          />
          {colourBy === "regions" && (
            <p className="gs-hint">
              Up to {DISTINCT_COLOURS} of the largest brain regions, clusters of notes that link
              mostly to each other, get a colour each.
              {separateBy === "groups"
                ? " The groups below still separate the graph."
                : " Region labels, under Display, lists them."}
            </p>
          )}
          {groupsInUse(settings.clusters) && (
            <>
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
            </>
          )}
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
          <Slider
            label="Highlight depth"
            value={settings.display.highlightDepth}
            range={DISPLAY_RANGES.highlightDepth}
            hint="How many links away a hovered or selected note lights up"
            onChange={(v) =>
              setDisplay({ highlightDepth: toHighlightDepth(v, settings.display.highlightDepth) })
            }
          />
          <div className="gs-actions">
            <button type="button" className="k-btn gs-animate" onClick={onAnimate}>
              Animate
            </button>
          </div>
          <SwitchRow
            label="Topic labels"
            checked={settings.display.topicLabels}
            onChange={(topicLabels) => setDisplay({ topicLabels })}
          />
          {/* Separated by colour group, the clusters on screen are the groups, so the canvas
              names them instead: region names would float over clusters they don't describe. */}
          <SwitchRow
            label="Region labels"
            checked={settings.display.regionLabels}
            onChange={(regionLabels) => setDisplay({ regionLabels })}
            hint={
              separateBy === "groups"
                ? "Names each colour group while the graph is separated by them; click a name to zoom to it"
                : "Names each brain region on the canvas; click a name to zoom to it"
            }
          />
          {settings.display.regionLabels && named.length > 0 && onZoomTo && (
            <NamedParts parts={named} groups={separateBy === "groups"} onZoomTo={onZoomTo} />
          )}
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
          <Choice
            label="Separate by"
            options={SEPARATE_BY}
            value={separateBy}
            onChange={(next) => setClusters({ separateBy: next })}
          />
          {/* With nothing to separate the strength would do nothing, so it shows only when it acts. */}
          {separateBy !== "none" && (
            <Slider
              label="Separation"
              value={settings.forces.separation}
              range={FORCE_RANGES.separation}
              onChange={(v) => setForce("separation", v)}
            />
          )}
        </>,
      )}
    </section>
  );
}
