import { demoGraph } from "../fixtures";
import type { ServiceStatus, Stats } from "./types";

export const getStats = (): Stats => ({
  domains: [
    { domain: "personal/kioku", active: 4, legacy: 0 },
    { domain: "local", active: 2, legacy: 0 },
    { domain: "demo", active: 267, legacy: 36 },
  ],
  links: demoGraph.edges.length + 7,
  pendingVectors: 0,
});

export const getServiceStatus = (): ServiceStatus => ({
  postgres: { state: "running", detail: "notes" },
  qdrant: { state: "running", detail: "vectors" },
  ollama: { state: "running", detail: "GPU" },
  embeddingModel: "nomic-embed-text",
  embeddingProvider: "ollama",
  embeddingLocal: true,
  embeddingReader: "this Mac",
});
