import { call } from "../core";
import type { GraphData, GraphQuery } from "./types";

export const getGraph = (query: GraphQuery): Promise<GraphData> =>
  call("get_graph", { query }, async () => (await import("./mock")).getGraph(query));
