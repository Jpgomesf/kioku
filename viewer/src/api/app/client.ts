import { call } from "../core";
import type { AppInfo, ReleaseNote, UpdateStatus } from "./types";

const load = () => import("./mock");

export const getAppInfo = (): Promise<AppInfo> =>
  call("get_app_info", {}, async () => (await load()).getAppInfo());
export const checkForUpdates = (): Promise<UpdateStatus> =>
  call("check_for_updates", {}, async () => (await load()).checkForUpdates());
export const listReleaseNotes = (): Promise<ReleaseNote[]> =>
  call("list_release_notes", {}, async () => (await load()).listReleaseNotes());
