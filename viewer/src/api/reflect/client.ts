import { call } from "../core";
import type { ReflectRun, ReflectSettings } from "./types";

const load = () => import("./mock");

export const listReflectRuns = (domain: string): Promise<ReflectRun[]> =>
  call("list_reflect_runs", { domain }, async () => (await load()).listReflectRuns(domain));
export const getReflectSettings = (): Promise<ReflectSettings> =>
  call("get_reflect_settings", {}, async () => (await load()).getReflectSettings());
export const startReflect = (domain: string): Promise<ReflectRun> =>
  call("start_reflect", { domain }, async () => (await load()).startReflect(domain));
/** Read-only in this build: rejects with code "read_only". */
export const saveReflectSettings = (settings: ReflectSettings): Promise<void> =>
  call("save_reflect_settings", { settings }, async () =>
    (await load()).saveReflectSettings(settings),
  );
/** Read-only in this build: rejects with code "read_only". */
export const dismissFinding = (run: string, finding: string): Promise<void> =>
  call("dismiss_finding", { run, finding }, async () =>
    (await load()).dismissFinding(run, finding),
  );
