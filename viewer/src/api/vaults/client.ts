import { call } from "../core";
import type { AccessRequest, VaultsConfig, VisibilityChange, VisibilityPreview } from "./types";

const load = () => import("./mock");

export const getVaultsConfig = (): Promise<VaultsConfig> =>
  call("get_vaults_config", {}, async () => (await load()).getVaultsConfig());
export const previewVisibility = (changes: VisibilityChange[]): Promise<VisibilityPreview> =>
  call("preview_visibility", { changes }, async () => (await load()).previewVisibility(changes));
/** Read-only in this build: rejects with code "read_only". */
export const applyVisibility = (changes: VisibilityChange[]): Promise<void> =>
  call("apply_visibility", { changes }, async () => (await load()).applyVisibility(changes));
export const listAccessRequests = (): Promise<AccessRequest[]> =>
  call("list_access_requests", {}, async () => (await load()).listAccessRequests());
/** Read-only in this build: rejects with code "read_only". */
export const respondAccessRequest = (id: string, approve: boolean): Promise<void> =>
  call("respond_access_request", { id, approve }, async () =>
    (await load()).respondAccessRequest(id, approve),
  );
