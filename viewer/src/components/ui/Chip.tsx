import type { ReactNode } from "react";
import { Icon } from "./Icon";

export interface ChipProps {
  pressed: boolean;
  onToggle: (next: boolean) => void;
  children: ReactNode;
}

/** A filter chip: a toggle button with aria-pressed. */
export function Chip({ pressed, onToggle, children }: ChipProps) {
  return (
    <button
      type="button"
      className="k-chip"
      aria-pressed={pressed}
      onClick={() => onToggle(!pressed)}
    >
      <Icon name="check" className="k-chip-check" />
      {children}
    </button>
  );
}
