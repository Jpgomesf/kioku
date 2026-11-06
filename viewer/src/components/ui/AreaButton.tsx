import { Kbd } from "./Kbd";

export interface AreaButtonProps {
  /** The area's short label, such as "kioku". Never repeats the vault. */
  label: string;
  vault: string;
  expanded: boolean;
  onClick: () => void;
}

/** The view's heading and its one way to change area: "kioku in personal ⌘O". */
export function AreaButton({ label, vault, expanded, onClick }: AreaButtonProps) {
  return (
    <button
      type="button"
      className="k-area-button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onClick}
    >
      <span className="k-area-title">{label}</span>
      <span className="k-area-in">in {vault}</span>
      <Kbd>⌘O</Kbd>
    </button>
  );
}
