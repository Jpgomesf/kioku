import { type InputHTMLAttributes, useId } from "react";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";

export interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Shortcut hint, such as ⌘K, when the palette shares it. */
  shortcut?: string;
  /** Only when it says something true about ranking or scope. */
  hint?: string;
}

/** A labelled search input with the Search icon. */
export function SearchField({
  label,
  value,
  onChange,
  shortcut,
  hint,
  id,
  ...rest
}: SearchFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  return (
    <div className="k-field">
      <label className="k-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="k-field-control">
        <Icon name="search" />
        <input
          {...rest}
          id={inputId}
          type="search"
          value={value}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </div>
      {hint ? (
        <p id={hintId} className="k-field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
