import type { ServiceStatus } from "./types";

/** Where embeddings run, in plain words: "local" or "sent to OpenAI". */
export function embeddingWhere(status: ServiceStatus): string {
  return status.embeddingLocal ? "local" : `sent to ${status.embeddingReader}`;
}

/** The name of the embedding service row. */
export function embeddingServiceName(status: ServiceStatus): string {
  return status.embeddingProvider === "ollama" ? "Ollama" : "Embeddings";
}
