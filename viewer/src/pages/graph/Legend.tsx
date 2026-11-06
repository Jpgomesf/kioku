// Note types with their counts, each a toggle, and the display switches.
import { useMemo } from "react";
import type { GraphData } from "../../api";
import { type Filters, formatCount, type TypeGroup, typeGroup } from "./model";

export interface LegendProps {
  data: GraphData;
  filters: Filters;
  onChange: (next: Filters) => void;
}

type Shape = "dot" | "ring" | "square";

const TYPES: Array<{ group: TypeGroup; label: string; swatch: string; shape: Shape }> = [
  { group: "decision", label: "Decisions", swatch: "k-swatch-decision", shape: "dot" },
  { group: "question", label: "Questions", swatch: "k-swatch-question", shape: "dot" },
  { group: "ticket", label: "Tickets and items", swatch: "k-swatch-item", shape: "dot" },
  { group: "pull-request", label: "Pull requests", swatch: "k-swatch-item", shape: "square" },
  { group: "topic", label: "Topics", swatch: "k-swatch-topic", shape: "ring" },
  { group: "other", label: "Other notes", swatch: "k-swatch-other", shape: "dot" },
];

const SWITCHES: Array<{ key: "suggested" | "topicLabels" | "legacy"; label: string }> = [
  { key: "suggested", label: "Links reflect suggests" },
  { key: "topicLabels", label: "Topic labels" },
  { key: "legacy", label: "Legacy notes" },
];

function Swatch({ swatch, shape }: { swatch: string; shape: Shape }) {
  return (
    <svg className="k-swatch" viewBox="0 0 12 12" aria-hidden="true">
      {shape === "square" ? (
        <rect className={swatch} x="1" y="1" width="10" height="10" />
      ) : (
        <circle className={swatch} cx="6" cy="6" r={shape === "ring" ? 4.5 : 5} />
      )}
    </svg>
  );
}

export function Legend({ data, filters, onChange }: LegendProps) {
  const counts = useMemo(() => {
    const out = new Map<TypeGroup, number>();
    for (const n of data.nodes) out.set(typeGroup(n.kind), (out.get(typeGroup(n.kind)) ?? 0) + 1);
    return out;
  }, [data]);
  const row = (t: (typeof TYPES)[number]) => (
    <button
      key={t.group}
      type="button"
      className="k-type-row"
      aria-pressed={filters[t.group]}
      onClick={() => onChange({ ...filters, [t.group]: !filters[t.group] })}
    >
      <Swatch swatch={t.swatch} shape={t.shape} />
      <span className="k-grow">{t.label}</span>
      <span className="k-num">{formatCount(counts.get(t.group) ?? 0)}</span>
    </button>
  );
  const on = TYPES.filter((t) => filters[t.group]);
  const off = TYPES.filter((t) => !filters[t.group]);
  return (
    <div className="k-legend graph-legend">
      <div className="k-legend-group">
        <h2 className="k-list-title">Note types</h2>
        {on.map(row)}
        {off.length > 0 && (
          <p className="k-legend-note">Hidden. They show in grey when you turn them on.</p>
        )}
        {off.map(row)}
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
