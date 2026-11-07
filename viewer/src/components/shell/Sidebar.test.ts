import { describe, expect, it } from "vitest";
import { servicesSummary } from "./Sidebar";

const ok = { state: "running" as const, detail: "" };

describe("services line", () => {
  it("never says running before a real answer", () => {
    expect(servicesSummary({ kind: "loading" })).toEqual({
      tone: "loading",
      text: "Checking services…",
    });
    expect(servicesSummary({ kind: "error", message: "not implemented yet" })).toEqual({
      tone: "unknown",
      text: "Services unknown",
    });
  });
  it("reports the worst service state", () => {
    const status = {
      postgres: ok,
      qdrant: ok,
      ollama: ok,
      embeddingModel: "m",
      embeddingProvider: "ollama" as const,
      embeddingLocal: true,
      embeddingReader: "this Mac",
    };
    expect(servicesSummary({ kind: "ok", status }).text).toBe("All services running");
    expect(
      servicesSummary({
        kind: "ok",
        status: { ...status, ollama: { state: "degraded", detail: "GPU" } },
      }).tone,
    ).toBe("degraded");
    const down = servicesSummary({
      kind: "ok",
      status: { ...status, qdrant: { state: "down", detail: "" } },
    });
    expect(down).toEqual({ tone: "down", text: "Qdrant is down" });
  });
});
