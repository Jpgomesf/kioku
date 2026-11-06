// The colour picks, every note type with its count (each a toggle that also highlights its
// notes on hover or focus), and the display switches.
import { useId, useMemo, useState } from "react";
import { type GraphData, kindCounts, kindLabelPlural, type NoteKind, TOPIC_KIND } from "../../api";
import { type ColourSlots, SLOT_NAMES, slotOf } from "./colours";
import { type Filters, formatCount, toggleHidden } from "./model";

export interface LegendProps {
  data: GraphData;
  filters: Filters;
  onChange: (next: Filters) => void;
  slots: ColourSlots;
  onAssign: (index: number, kind: NoteKind | null) => void;
  /** The type whose notes stand out, or null to clear it. */
  onHighlight: (kind: NoteKind | null) => void;
}

/** Rows shown before "Show all". */
export const TYPES_SHOWN = 8;

const SWITCHES: Array<{ key: "suggested" | "topicLabels" | "legacy"; label: string }> = [
  { key: "suggested", label: "Links reflect suggests" },
  { key: "topicLabels", label: "Topic labels" },
  { key: "legacy", label: "Legacy notes" },
];

function swatchClass(slots: ColourSlots, kind: NoteKind): string {
  if (kind === TOPIC_KIND) return "k-swatch-topic";
  const slot = slotOf(slots, kind);
  return slot < 0 ? "k-swatch-other" : `k-swatch-${slot + 1}`;
}

function Swatch({ className, ring = false }: { className: string; ring?: boolean }) {
  return (
    <svg className="k-swatch" viewBox="0 0 12 12" aria-hidden="true">
      <circle className={className} cx="6" cy="6" r={ring ? 4.5 : 5} />
    </svg>
  );
}

export function Legend({ data, filters, onChange, slots, onAssign, onHighlight }: LegendProps) {
  const idBase = useId();
  const [showAll, setShowAll] = useState(false);
  const counts = useMemo(() => kindCounts(data.nodes), [data]);
  const colourable = useMemo(() => {
    const list = counts.filter((c) => c.kind !== TOPIC_KIND);
    // A saved pick the area no longer has stays selectable, so the select shows it.
    for (const kind of slots) {
      if (kind !== null && !list.some((c) => c.kind === kind)) list.push({ kind, count: 0 });
    }
    return list;
  }, [counts, slots]);
  // A hidden type stays listed when collapsed, so it can always be turned back on.
  const rows = showAll
    ? counts
    : counts.filter((c, i) => i < TYPES_SHOWN || filters.hidden.has(c.kind));

  return (
    <div className="k-legend graph-legend">
      <div className="k-legend-group">
        <h2 className="k-list-title">Colours</h2>
        {SLOT_NAMES.map((name, i) => {
          const id = `${idBase}-colour-${i}`;
          return (
            <div key={name} className="k-legend-colour">
              <label htmlFor={id} className="k-legend-colour-name">
                <Swatch className={`k-swatch-${i + 1}`} />
                {name}
              </label>
              <select
                id={id}
                className="k-select k-legend-select"
                value={slots[i] ?? ""}
                onChange={(e) => onAssign(i, e.target.value === "" ? null : e.target.value)}
              >
                <option value="">No colour</option>
                {colourable.map((c) => (
                  <option key={c.kind} value={c.kind}>
                    {kindLabelPlural(c.kind)} ({formatCount(c.count)})
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <div className="k-legend-group">
        <h2 className="k-list-title">Note types</h2>
        {rows.map(({ kind, count }) => (
          <button
            key={kind}
            type="button"
            className="k-type-row"
            aria-pressed={!filters.hidden.has(kind)}
            onClick={() => onChange(toggleHidden(filters, kind))}
            onMouseEnter={() => onHighlight(kind)}
            onMouseLeave={() => onHighlight(null)}
            onFocus={() => onHighlight(kind)}
            onBlur={() => onHighlight(null)}
          >
            <Swatch className={swatchClass(slots, kind)} ring={kind === TOPIC_KIND} />
            <span className="k-grow">{kindLabelPlural(kind)}</span>
            <span className="k-num">{formatCount(count)}</span>
          </button>
        ))}
        {(showAll ? counts.length > TYPES_SHOWN : rows.length < counts.length) && (
          <button
            type="button"
            className="k-btn k-btn-sm k-legend-more"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show fewer" : `Show all ${formatCount(counts.length)} types`}
          </button>
        )}
      </div>
      <div className="k-legend-group">
        <h2 className="k-list-title">Show</h2>
        {SWITCHES.map((s) => (
          <button
            key={s.key}
            type="button"
            role="switch"
            aria-checked={filters[s.key]}
            className="k-switch-row"
            onClick={() => onChange({ ...filters, [s.key]: !filters[s.key] })}
          >
            {s.label}
            <span className="k-switch k-switch-sm" aria-hidden="true">
              <span className="k-switch-knob" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
