import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

export interface ChipProps {
  pressed: boolean;
  onToggle: (next: boolean) => void;
  children: ReactNode;
  /** Extra classes, such as an entry or exit animation. */
  className?: string;
  style?: CSSProperties;
}

/** A filter chip: a toggle button with aria-pressed. */
export function Chip({ pressed, onToggle, children, className, style }: ChipProps) {
  return (
    <button
      type="button"
      className={className ? `k-chip ${className}` : "k-chip"}
      style={style}
      aria-pressed={pressed}
      onClick={() => onToggle(!pressed)}
    >
      <Icon name="check" className="k-chip-check" />
      {children}
    </button>
  );
}
