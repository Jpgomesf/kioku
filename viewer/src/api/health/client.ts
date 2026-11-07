import { call } from "../core";
import type { ServiceStatus, Stats } from "./types";

const load = () => import("./mock");

export const getStats = (): Promise<Stats> =>
  call("get_stats", {}, async () => (await load()).getStats());
export const getServiceStatus = (): Promise<ServiceStatus> =>
  call("get_service_status", {}, async () => (await load()).getServiceStatus());
