// The access matrix's logic: a column per model provider, and which vaults the search and
// filters leave. Pure, so the page and its tests share it.
import type { AccessRequest, VaultConfig, VaultsConfig } from "../../api";
import { appOf, type Draft, draftedCanRead, providerWords, savedCanRead } from "./draft";

/** One provider's column: its switch decides for every app on it. */
export interface ProviderColumn {
  provider: string;
  /** The column's heading, such as "Anthropic" or "This Mac". */
  title: string;
  /** The apps on the provider, such as ["Claude Code", "Claude Desktop"]. */
  apps: string[];
}

const COLUMN_TITLES: Readonly<Record<string, string>> = { local: "This Mac", other: "Other" };

/** The providers the vaults' apps use, in the order the apps come. */
export function providerColumns(config: VaultsConfig): ProviderColumn[] {
  const columns = new Map<string, ProviderColumn>();
  for (const vault of config.vaults) {
    for (const app of vault.apps) {
      const column = columns.get(app.provider) ?? {
        provider: app.provider,
        title: COLUMN_TITLES[app.provider] ?? providerWords(app.provider),
        apps: [],
      };
      if (!column.apps.includes(app.name)) column.apps.push(app.name);
      columns.set(app.provider, column);
    }
  }
  return [...columns.values()];
}

export interface MatrixFilters {
  query: string;
  /** A provider that must be able to read the vault, or "" for any. */
  readableBy: string;
  /** Only vaults an app has asked to read. */
  asking: boolean;
  /** Only vaults the draft changes. */
  changed: boolean;
}

export const NO_FILTERS: MatrixFilters = {
  query: "",
  readableBy: "",
  asking: false,
  changed: false,
};

export const isFiltered = (f: MatrixFilters): boolean =>
  f.query.trim() !== "" || f.readableBy !== "" || f.asking || f.changed;

/** True when every word of the query is in the vault's name, folders, remotes or areas. */
export function vaultMatches(vault: VaultConfig, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [
    vault.name,
    ...vault.paths,
    ...vault.gitRemotes,
    ...vault.domains,
    ...vault.areas.flatMap((a) => [a.domain, ...a.paths]),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/** The provider an open request asks for, per vault. */
export function askedProviders(
  config: VaultsConfig,
  requests: readonly AccessRequest[],
): Map<string, Set<string>> {
  const asked = new Map<string, Set<string>>();
  for (const r of requests) {
    const provider = appOf(config, r.vault, r.app)?.provider;
    if (!provider) continue;
    const set = asked.get(r.vault) ?? new Set<string>();
    set.add(provider);
    asked.set(r.vault, set);
  }
  return asked;
}

/** True when the draft changes any of the vault's switches. */
export function draftChangesVault(vault: VaultConfig, draft: Draft): boolean {
  return vault.apps.some(
    (a) => draftedCanRead(vault, a.provider, draft) !== savedCanRead(vault, a.provider),
  );
}

/** The vaults the search and filters leave, in the file's order. */
export function filterVaults(
  config: VaultsConfig,
  filters: MatrixFilters,
  draft: Draft,
  asked: Map<string, Set<string>>,
): VaultConfig[] {
  return config.vaults.filter(
    (v) =>
      vaultMatches(v, filters.query) &&
      (filters.readableBy === "" || draftedCanRead(v, filters.readableBy, draft)) &&
      (!filters.asking || asked.has(v.name)) &&
      (!filters.changed || draftChangesVault(v, draft)),
  );
}
