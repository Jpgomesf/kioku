import { useId } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Hide the visible label (it stays the group's name). */
  hideLabel?: boolean;
}

/** Two to four options for one setting, such as Manual or Automatic. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  hideLabel = false,
}: SegmentedControlProps<T>) {
  const id = useId();
  return (
    <div className="k-seg-field">
      <span id={id} className={hideLabel ? "k-sr" : "k-seg-label"}>
        {label}
      </span>
      <fieldset className="k-seg" aria-labelledby={id}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
