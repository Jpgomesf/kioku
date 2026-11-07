// The access matrix: a row per vault, a column per model provider, a switch where they meet.
// Search and filters narrow the rows; each column can switch every row shown at once. It
// edits the same draft the review step reads, so nothing is saved from here.
import { useId, useMemo, useState } from "react";
import type { AccessRequest, VaultConfig, VaultsConfig } from "../../api";
import { Button, Chip, SearchField, Switch } from "../../components/ui";
import { type Draft, draftedCanRead, listNames, savedCanRead, setDraft, setDrafted } from "./draft";
import {
  askedProviders,
  filterVaults,
  isFiltered,
  type MatrixFilters,
  NO_FILTERS,
  type ProviderColumn,
  providerColumns,
} from "./matrix";

const pluralise = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A safe id fragment from a name, so ids never break on spaces or slashes. */
const idPart = (text: string): string => text.replace(/[^A-Za-z0-9_-]/g, "_");

export interface VaultMatrixProps {
  config: VaultsConfig;
  draft: Draft;
  /** Open requests, marked in their cells. */
  requests: readonly AccessRequest[];
  /** The vault whose details are open, if any. */
  openVault: string | null;
  onOpenVault: (name: string) => void;
}

export function VaultMatrix({ config, draft, requests, openVault, onOpenVault }: VaultMatrixProps) {
  const base = useId();
  const [filters, setFilters] = useState<MatrixFilters>(NO_FILTERS);
  const columns = useMemo(() => providerColumns(config), [config]);
  const asked = useMemo(() => askedProviders(config, requests), [config, requests]);
  const shown = filterVaults(config, filters, draft, asked);
  const changedCount = config.vaults.filter((v) =>
    v.apps.some((a) => draftedCanRead(v, a.provider, draft) !== a.canRead),
  ).length;
  const update = (next: Partial<MatrixFilters>) => setFilters((f) => ({ ...f, ...next }));

  return (
    <section className="vaults-matrix" aria-labelledby={`${base}-caption`}>
      <div className="vaults-toolbar">
        <SearchField
          label="Search vaults"
          value={filters.query}
          onChange={(query) => update({ query })}
          placeholder="Search vaults, folders and areas"
        />
        <div className="vaults-filters">
          <div className="k-select-field vaults-readable">
            <label htmlFor={`${base}-readable`}>Readable by</label>
            <select
              id={`${base}-readable`}
              className="k-select"
              value={filters.readableBy}
              onChange={(e) => update({ readableBy: e.target.value })}
            >
              <option value="">Any app</option>
              {columns.map((c) => (
                <option key={c.provider} value={c.provider}>
                  {listNames(c.apps)}
                </option>
              ))}
            </select>
          </div>
          {asked.size > 0 || filters.asking ? (
            <Chip pressed={filters.asking} onToggle={(asking) => update({ asking })}>
              Has a request <span className="vaults-chip-count">{asked.size}</span>
            </Chip>
          ) : null}
          {changedCount > 0 || filters.changed ? (
            <Chip pressed={filters.changed} onToggle={(changed) => update({ changed })}>
              Changed <span className="vaults-chip-count">{changedCount}</span>
            </Chip>
          ) : null}
        </div>
      </div>
      <p className="vaults-count" aria-live="polite">
        {isFiltered(filters)
          ? `${shown.length} of ${pluralise(config.vaults.length, "vault", "vaults")}`
          : `${pluralise(config.vaults.length, "vault", "vaults")}. Each column is a model provider: the apps under its name switch together.`}
        {isFiltered(filters) ? (
          <Button size="sm" variant="quiet" onClick={() => setFilters(NO_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
      </p>
      <div className="vaults-table-scroll">
        <table className="vaults-table">
          <caption id={`${base}-caption`} className="k-sr">
            Which apps can read each vault
          </caption>
          <thead>
            <tr>
              <th scope="col" className="vaults-th-vault">
                Vault
              </th>
              {columns.map((c) => (
                <th key={c.provider} scope="col" className="vaults-th-provider">
                  <span id={`${base}-col-${idPart(c.provider)}`} className="vaults-col-title">
                    {c.title}
                  </span>
                  <span className="vaults-col-apps">{c.apps.join(", ")}</span>
                  <ColumnToggle column={c} vaults={shown} draft={draft} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((vault) => (
              <VaultRow
                key={vault.name}
                vault={vault}
                columns={columns}
                draft={draft}
                asked={asked.get(vault.name)}
                open={vault.name === openVault}
                base={base}
                onOpen={() => onOpenVault(vault.name)}
              />
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <p className="vaults-none">
            No vault matches.{" "}
            <Button size="sm" variant="quiet" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Switches a provider for every row shown: on unless all are on already, then off. */
function ColumnToggle({
  column,
  vaults,
  draft,
}: {
  column: ProviderColumn;
  vaults: readonly VaultConfig[];
  draft: Draft;
}) {
  const rows = vaults.filter((v) => v.apps.some((a) => a.provider === column.provider));
  const allOn = rows.length > 0 && rows.every((v) => draftedCanRead(v, column.provider, draft));
  const apps = listNames(column.apps);
  const count = pluralise(rows.length, "vault", "vaults");
  const label = allOn
    ? `Stop ${apps} reading the ${count} shown`
    : `Let ${apps} read the ${count} shown`;
  return (
    <Button
      size="sm"
      variant="quiet"
      className="vaults-col-toggle"
      aria-label={label}
      title={label}
      disabled={rows.length === 0}
      onClick={() => {
        let next = draft;
        for (const v of rows) next = setDrafted(next, v, column.provider, !allOn);
        setDraft(next);
      }}
    >
      {allOn ? "None" : "All"}
    </Button>
  );
}

function VaultRow({
  vault,
  columns,
  draft,
  asked,
  open,
  base,
  onOpen,
}: {
  vault: VaultConfig;
  columns: readonly ProviderColumn[];
  draft: Draft;
  asked: Set<string> | undefined;
  open: boolean;
  base: string;
  onOpen: () => void;
}) {
  const rowId = `${base}-row-${idPart(vault.name)}`;
  return (
    <tr data-vault={vault.name} className={open ? "vaults-row-open" : undefined}>
      <th scope="row" className="vaults-th-row">
        <button
          type="button"
          id={rowId}
          className="vaults-name"
          aria-expanded={open}
          onClick={onOpen}
        >
          {vault.name}
        </button>
        <span className="vaults-row-meta">
          {pluralise(vault.areas.length, "area", "areas")} ·{" "}
          <span className="k-mono">{vault.paths.join(", ")}</span>
        </span>
      </th>
      {columns.map((c) => {
        if (!vault.apps.some((a) => a.provider === c.provider)) {
          return <td key={c.provider} data-provider={c.provider} />;
        }
        const checked = draftedCanRead(vault, c.provider, draft);
        const changed = checked !== savedCanRead(vault, c.provider);
        const asking = asked?.has(c.provider) ?? false;
        const askId = `${rowId}-${idPart(c.provider)}-asks`;
        const classes = [changed ? "vaults-cell-changed" : "", asking ? "vaults-cell-asking" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <td key={c.provider} data-provider={c.provider} className={classes || undefined}>
            <Switch
              small
              labelledBy={`${rowId} ${base}-col-${idPart(c.provider)}`}
              describedBy={asking ? askId : undefined}
              checked={checked}
              onChange={(next) => setDraft(setDrafted(draft, vault, c.provider, next))}
            />
            {asking ? (
              <span id={askId} className="vaults-asks">
                Asked
              </span>
            ) : null}
          </td>
        );
      })}
    </tr>
  );
}
