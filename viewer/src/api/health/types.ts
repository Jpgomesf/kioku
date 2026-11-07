// Health. Serde twin: src-tauri/src/commands/health.rs.

export interface DomainStats {
  domain: string;
  active: number;
  legacy: number;
}

export interface Stats {
  domains: DomainStats[];
  links: number;
  pendingVectors: number;
}

export type ServiceState = "running" | "degraded" | "down";

export interface ServiceHealth {
  state: ServiceState;
  detail: string;
}

export interface ServiceStatus {
  postgres: ServiceHealth;
  qdrant: ServiceHealth;
  ollama: ServiceHealth;
  embeddingModel: string;
  /** Which API embeddings go through. */
  embeddingProvider: "ollama" | "openai";
  /** Whether note text stays on this machine when it is embedded. */
  embeddingLocal: boolean;
  /** Who reads the text when it isn't local, in plain words ("OpenAI"). */
  embeddingReader: string;
}
