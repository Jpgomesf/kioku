import type { ReactNode } from "react";

export type PillTone =
  | "active"
  | "legacy"
  | "draft"
  | "unverified"
  | "neutral"
  | "finding"
  | "down";

export interface StatusPillProps {
  tone: PillTone;
  children: ReactNode;
}

export function StatusPill({ tone, children }: StatusPillProps) {
  return <span className={`k-pill k-pill-${tone}`}>{children}</span>;
}
