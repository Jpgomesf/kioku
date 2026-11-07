import { commandError, READ_ONLY_MESSAGE } from "../core";
import type {
  AccessRequest,
  DiffLine,
  VaultApp,
  VaultConfig,
  VaultsConfig,
  VisibilityChange,
  VisibilityPreview,
} from "./types";

// Mirrors src-tauri/src/data/vaults_file.rs APPS.
const APP_SPECS: Omit<VaultApp, "canRead">[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    provider: "anthropic",
    description: "Anthropic models",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    provider: "anthropic",
    description: "Anthropic models",
  },
  {
    id: "kilo",
    name: "Kilo with local models",
    provider: "local",
    description: "Runs on this Mac, nothing leaves it",
  },
  { id: "codex", name: "Codex", provider: "openai", description: "OpenAI models" },
  { id: "gemini", name: "Gemini CLI", provider: "google", description: "Google models" },
  { id: "kimi", name: "Kimi", provider: "moonshot", description: "Moonshot models" },
  { id: "deepseek", name: "DeepSeek", provider: "deepseek", description: "DeepSeek models" },
  { id: "other", name: "Other apps", provider: "other", description: "Any other hosted model" },
];

const apps = (providers: string[]): VaultApp[] =>
  APP_SPECS.map((spec) => ({ ...spec, canRead: providers.includes(spec.provider) }));

const VAULTS: VaultConfig[] = [
  {
    name: "personal",
    paths: ["~"],
    gitRemotes: [],
    domains: ["personal/kioku", "local", "demo"],
    providers: ["anthropic", "local"],
    areas: [{ domain: "personal/kioku", paths: ["~/projects/personal/mcp/kioku"] }],
    defaultDomain: "local",
    apps: apps(["anthropic", "local"]),
  },
  {
    name: "work",
    paths: ["~/projects/work"],
    gitRemotes: ["github.com/example-work/*"],
    domains: ["work", "work/handbook"],
    providers: ["anthropic", "local", "openai"],
    areas: [{ domain: "work/handbook", paths: ["~/projects/work/handbook"] }],
    defaultDomain: "work",
    apps: apps(["anthropic", "local", "openai"]),
  },
];

/** Provider sets the generated vaults cycle through. */
const PREVIEW_SETS = [
  ["anthropic", "local"],
  ["anthropic"],
  ["local"],
  ["anthropic", "local", "openai"],
  ["anthropic", "google"],
  [],
];

/**
 * Extra generated vaults, for trying the Vaults page at scale in a browser: set localStorage
 * "kioku.viewer.mock.vaults" to a count (up to 500). Generic names only: this repo is public.
 */
function previewVaults(): VaultConfig[] {
  let count = 0;
  try {
    count = Number(globalThis.localStorage?.getItem("kioku.viewer.mock.vaults") ?? 0);
  } catch {
    count = 0;
  }
  if (!Number.isFinite(count) || count <= 0) return [];
  return Array.from({ length: Math.min(Math.floor(count), 500) }, (_, i) => {
    const name = `client-${String(i + 1).padStart(3, "0")}`;
    const providers = PREVIEW_SETS[i % PREVIEW_SETS.length] ?? [];
    const areas = Array.from({ length: i % 4 }, (_, j) => ({
      domain: `${name}/area-${j + 1}`,
      paths: [`~/work/clients/${name}/area-${j + 1}`],
    }));
    return {
      name,
      paths: [`~/work/clients/${name}`],
      gitRemotes: [],
      domains: [name, ...areas.map((a) => a.domain)],
      providers,
      areas,
      defaultDomain: name,
      apps: apps(providers),
    };
  });
}

const allVaults = (): VaultConfig[] => [...VAULTS, ...previewVaults()];

export const getVaultsConfig = (): VaultsConfig => structuredClone({ vaults: allVaults() });

function findApp(vault: string, appId: string): { vault?: VaultConfig; app?: VaultApp } {
  const v = allVaults().find((x) => x.name === vault);
  return { vault: v, app: v?.apps.find((a) => a.id === appId) };
}

function providersLine(list: string[]): string {
  return `providers = [${list.map((p) => `"${p}"`).join(", ")}]`;
}

export function previewVisibility(changes: VisibilityChange[]): VisibilityPreview {
  const summary: string[] = [];
  const diff: DiffLine[] = [];
  for (const vaultName of [...new Set(changes.map((c) => c.vault))]) {
    const vault = allVaults().find((v) => v.name === vaultName);
    if (!vault) continue;
    const next = new Set(vault.providers);
    for (const c of changes.filter((x) => x.vault === vaultName)) {
      const { app } = findApp(vaultName, c.app);
      if (!app) continue;
      if (c.canRead) next.add(app.provider);
      else next.delete(app.provider);
      summary.push(
        `${app.name} ${c.canRead ? "could read" : "could no longer read"} every note in ${vaultName}.`,
      );
    }
    diff.push({ kind: "context", text: `name = "${vault.name}"` });
    diff.push({ kind: "remove", text: providersLine(vault.providers) });
    diff.push({ kind: "add", text: providersLine([...next]) });
  }
  return {
    summary,
    diff,
    checks: [
      { label: "Kioku accepts the change.", passed: true },
      { label: "No folder moves to another vault.", passed: true },
    ],
  };
}

export function applyVisibility(_changes: VisibilityChange[]): void {
  throw commandError("read_only", READ_ONLY_MESSAGE);
}

export const listAccessRequests = (): AccessRequest[] => [
  {
    id: "req-1",
    app: "codex",
    vault: "personal",
    reason: "From a session in ~/projects/personal/mcp/kioku",
    requestedAt: "2026-11-05T05:20:00Z",
  },
];

export function respondAccessRequest(_id: string, _approve: boolean): void {
  throw commandError("read_only", READ_ONLY_MESSAGE);
}
