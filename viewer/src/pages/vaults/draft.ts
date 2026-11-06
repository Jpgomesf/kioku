// The unsaved visibility change, shared by the Vaults page and its review step.
// A switch stands for a provider, so the draft is keyed by vault and provider.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type AccessRequest,
  getVaultsConfig,
  listAccessRequests,
  type VaultApp,
  type VaultConfig,
  type VaultsConfig,
  type VisibilityChange,
} from "../../api";

/** "vault\nprovider" -> the drafted canRead. Only differences from the saved file are kept. */
export type Draft = Readonly<Record<string, boolean>>;

/** The access request the draft answers, with the change it asks for. */
export interface DraftRequest {
  id: string;
  vault: string;
  app: string;
  provider: string;
}

export interface DraftState {
  draft: Draft;
  /** Set while the draft still grants what an access request asked for. */
  request: DraftRequest | null;
  /** Requests put off with "Not now" or answered this session. */
  dismissed: readonly string[];
}

export const draftKey = (vault: string, provider: string): string => `${vault}\n${provider}`;

/** What the saved file says: a provider can read when any of its apps can. */
export function savedCanRead(vault: VaultConfig, provider: string): boolean {
  return vault.apps.some((a) => a.provider === provider && a.canRead);
}

export function draftedCanRead(vault: VaultConfig, provider: string, draft: Draft): boolean {
  return draft[draftKey(vault.name, provider)] ?? savedCanRead(vault, provider);
}

/** Set a provider's switch; setting it back to the saved value drops it from the draft. */
export function setDrafted(
  draft: Draft,
  vault: VaultConfig,
  provider: string,
  canRead: boolean,
): Draft {
  const key = draftKey(vault.name, provider);
  const { [key]: _old, ...rest } = draft;
  return canRead === savedCanRead(vault, provider) ? rest : { ...rest, [key]: canRead };
}

/** One change per app whose access differs from the saved file. */
export function draftChanges(config: VaultsConfig, draft: Draft): VisibilityChange[] {
  const changes: VisibilityChange[] = [];
  for (const vault of config.vaults) {
    for (const app of vault.apps) {
      const next = draftedCanRead(vault, app.provider, draft);
      if (next !== app.canRead) changes.push({ vault: vault.name, app: app.id, canRead: next });
    }
  }
  return changes;
}

/** True when `changes` still grant what the request asked for. */
export function requestIsCurrent(
  request: { vault: string; app: string },
  changes: VisibilityChange[],
): boolean {
  return changes.some((c) => c.vault === request.vault && c.app === request.app && c.canRead);
}

export function appOf(config: VaultsConfig, vault: string, appId: string): VaultApp | undefined {
  return config.vaults.find((v) => v.name === vault)?.apps.find((a) => a.id === appId);
}

/** Requests still worth showing: not put off, and for an app that can't read yet. */
export function openRequests(
  config: VaultsConfig,
  requests: readonly AccessRequest[],
  dismissed: readonly string[],
): AccessRequest[] {
  return requests.filter(
    (r) => !dismissed.includes(r.id) && appOf(config, r.vault, r.app)?.canRead === false,
  );
}

// The store.
let state: DraftState = { draft: {}, request: null, dismissed: [] };
const listeners = new Set<() => void>();

function update(next: DraftState): void {
  state = next;
  for (const l of listeners) l();
}

export const getDraftState = (): DraftState => state;

const keepRequest = (draft: Draft, request: DraftRequest | null): DraftRequest | null =>
  request && draft[draftKey(request.vault, request.provider)] === true ? request : null;

export function setDraft(draft: Draft, request: DraftRequest | null = state.request): void {
  update({ ...state, draft, request: keepRequest(draft, request) });
}

export function discardDraft(): void {
  update({ ...state, draft: {}, request: null });
}

/** Turn the request's switch back to the saved value and stop showing the request. */
export function declineRequest(vault: VaultConfig, request: DraftRequest): void {
  const draft = setDrafted(
    state.draft,
    vault,
    request.provider,
    savedCanRead(vault, request.provider),
  );
  const dismissed = state.dismissed.includes(request.id)
    ? state.dismissed
    : [...state.dismissed, request.id];
  update({ draft, request: null, dismissed });
}

export function dismissRequest(id: string): void {
  if (!state.dismissed.includes(id)) update({ ...state, dismissed: [...state.dismissed, id] });
}

/** For tests. */
export function resetDraftStore(): void {
  update({ draft: {}, request: null, dismissed: [] });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDraftState(): DraftState {
  return useSyncExternalStore(subscribe, getDraftState, getDraftState);
}

/** How many access requests still need an answer, as the Vaults page counts them. */
export function useOpenRequestCount(): number {
  const { dismissed } = useDraftState();
  const [data, setData] = useState<{ config: VaultsConfig; requests: AccessRequest[] } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    Promise.all([getVaultsConfig(), listAccessRequests()]).then(
      ([config, requests]) => live && setData({ config, requests }),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, []);
  return data ? openRequests(data.config, data.requests, dismissed).length : 0;
}

/** Every provider id kioku accepts, in plain words. */
export const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  local: "this Mac",
  anthropic: "Anthropic",
  openai: "OpenAI",
  moonshot: "Moonshot",
  deepseek: "DeepSeek",
  google: "Google",
  other: "another provider",
};

/** The provider in plain words, such as "Anthropic" or "this Mac". */
export function providerWords(provider: string): string {
  return PROVIDER_WORDS[provider] ?? provider;
}

export const isLocalProvider = (provider: string): boolean => provider === "local";

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
