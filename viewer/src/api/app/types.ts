// App info and updates. Serde twin: src-tauri/src/commands/app.rs.

export type UpdateChannel = "stable" | "beta";

export interface AppInfo {
  version: string;
  channel: UpdateChannel;
  /** True while every command that would change a vault returns read_only. */
  readOnly: boolean;
  /** True once a person can confirm changes with Touch ID or a password. */
  canAuthenticate: boolean;
}

export interface UpdateStatus {
  /** False until signing keys and an update endpoint exist. */
  configured: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: string | null;
}

export interface ReleaseNote {
  version: string;
  /** The release date (YYYY-MM-DD), or null for an unreleased build. */
  date: string | null;
  title: string;
  changes: string[];
}
