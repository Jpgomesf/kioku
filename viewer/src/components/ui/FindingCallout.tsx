import type { ReactNode } from "react";

export interface FindingCalloutProps {
  /** The finding's kind, shown in bold: "Orphan", "Suggested link", "Contradicts". */
  kind?: string;
  children: ReactNode;
  /** Two small buttons: show the evidence, and fix it at the source. */
  actions?: ReactNode;
  compact?: boolean;
}

/** Says that something about a note needs review, and offers the step that fixes it. */
export function FindingCallout({ kind, children, actions, compact = false }: FindingCalloutProps) {
  return (
    <div className={`k-finding${compact ? " k-finding-compact" : ""}`} role="note">
      <p>
        {kind ? <strong>{kind}: </strong> : null}
        {children}
      </p>
      {actions ? <div className="k-finding-actions">{actions}</div> : null}
    </div>
  );
}
