// Vaults and visibility. Serde twin: src-tauri/src/commands/vaults.rs.

export interface VaultArea {
  domain: string;
  paths: string[];
}

/** One app that may read a vault, with its one switch. */
export interface VaultApp {
  /** App id, such as "claude-code". */
  id: string;
  name: string;
  /** Provider id written to the vault's providers list. */
  provider: string;
  /** One line, such as "Anthropic models". */
  description: string;
  canRead: boolean;
}

export interface VaultConfig {
  name: string;
  paths: string[];
  gitRemotes: string[];
  domains: string[];
  providers: string[];
  areas: VaultArea[];
  /** Where new notes go when no area matches, such as "local". */
  defaultDomain: string | null;
  apps: VaultApp[];
}

export interface VaultsConfig {
  vaults: VaultConfig[];
}

export interface VisibilityChange {
  vault: string;
  /** App id, such as "claude-code". */
  app: string;
  canRead: boolean;
}

export type DiffLineKind = "add" | "remove" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface PreviewCheck {
  label: string;
  passed: boolean;
}

export interface VisibilityPreview {
  summary: string[];
  diff: DiffLine[];
  checks: PreviewCheck[];
}

export interface AppliedVisibility {
  /** Where the old vaults file was backed up, home-relative; null when nothing changed. */
  backup: string | null;
}

export interface AccessRequest {
  id: string;
  app: string;
  vault: string;
  reason: string;
  requestedAt: string;
}
