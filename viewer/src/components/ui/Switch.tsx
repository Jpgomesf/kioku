import type { ButtonHTMLAttributes } from "react";

type Naming = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

export type SwitchProps = Naming &
  Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "onChange" | "role" | "type" | "aria-checked" | "aria-label" | "aria-labelledby"
  > & {
    checked: boolean;
    onChange: (next: boolean) => void;
    /** Id of the one-line description, such as "Anthropic models". */
    describedBy?: string;
    small?: boolean;
  };

/** An on/off switch with role="switch", named by a label or by a visible element's id. */
export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  describedBy,
  small = false,
  className,
  ...rest
}: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`k-switch${small ? " k-switch-sm" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="k-switch-knob" />
    </button>
  );
}
