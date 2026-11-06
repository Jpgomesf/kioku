// Reflect. Serde twin: src-tauri/src/commands/reflect.rs.

export type FindingState = "confirmed" | "unverified";

export interface Finding {
  id: string;
  state: FindingState;
  text: string;
  noteKeys: string[];
}

export interface ReflectRun {
  id: string;
  domain: string;
  startedAt: string;
  finishedAt: string | null;
  harness: string;
  findings: Finding[];
}

export type ReflectMode = "manual" | "automatic";
export type HarnessStatus = "ready" | "needs-skill" | "not-connected";

export interface Harness {
  id: string;
  name: string;
  /** Display words for the model provider, such as "Anthropic" or "Runs on this Mac" (not a provider id). */
  provider: string;
  vaultsReadable: string[];
  status: HarnessStatus;
}

export interface ReflectRoles {
  /** Harness id that finds problems. */
  worker: string;
  /** Harness id that tries to refute each finding. */
  reviewer: string;
  /** Harness id that writes the report. */
  report: string;
}

export interface AfterSaves {
  /** Run after this many new saves. */
  threshold: number;
  /** Saves since the last run. */
  soFar: number;
}

/** When Automatic mode runs. Each trigger is off when false or null. */
export interface ReflectTriggers {
  afterImport: boolean;
  /** Local time of the nightly run, such as "02:00". */
  nightlyAt: string | null;
  afterSaves: AfterSaves | null;
}

export type ReflectPermission = "report-only" | "propose-fixes";

export interface ReflectSettings {
  mode: ReflectMode;
  harnesses: Harness[];
  roles: ReflectRoles;
  triggers: ReflectTriggers;
  permission: ReflectPermission;
}
