import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** The fact: "No notes match "touch id"". Never a bare "No results". */
  title: string;
  children: ReactNode;
  /** One next step. */
  action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="k-empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
