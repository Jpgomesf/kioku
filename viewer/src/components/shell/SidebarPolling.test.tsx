import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const ok = { state: "running" as const, detail: "" };
const running = {
  postgres: ok,
  qdrant: ok,
  ollama: ok,
  embeddingModel: "m",
  embeddingProvider: "ollama" as const,
  embeddingLocal: true,
  embeddingReader: "this Mac",
};
const getServiceStatus = vi.fn();

vi.mock("../../api", () => ({
  getServiceStatus: () => getServiceStatus(),
  listAreas: () => Promise.resolve([]),
  getVaultsConfig: () => Promise.resolve({ vaults: [] }),
  embeddingServiceName: () => "Ollama",
  embeddingWhere: () => "local",
  listAccessRequests: () => Promise.resolve([]),
  listReflectRuns: () => Promise.resolve([]),
  toCommandError: (e: unknown) => ({ message: String(e) }),
}));
vi.mock("../../app/area", () => ({
  pickArea: () => undefined,
  reconcileAreas: () => undefined,
  useCurrentArea: () => "demo",
  useRecentAreas: () => [],
}));
vi.mock("../area-switcher", () => ({ openAreaSwitcher: () => undefined }));
vi.mock("../../pages/vaults/draft", () => ({ useOpenRequestCount: () => 0 }));

import { SERVICES_REFRESH_MS, Sidebar } from "./Sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("services line refresh", () => {
  it("turns to down when a refresh says so", async () => {
    vi.useFakeTimers();
    getServiceStatus.mockResolvedValueOnce(running);
    getServiceStatus.mockResolvedValue({ ...running, qdrant: { state: "down", detail: "" } });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Sidebar route={{ name: "health" }} />));
    const status = () => host.querySelector('[role="status"]')?.textContent;
    expect(status()).toBe("All services running");
    await act(async () => {
      vi.advanceTimersByTime(SERVICES_REFRESH_MS);
    });
    expect(status()).toBe("Qdrant is down");
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("does not let an older slow answer overwrite a newer one", async () => {
    vi.useFakeTimers();
    let failFirst: (e: unknown) => void = () => {};
    getServiceStatus.mockReset();
    getServiceStatus.mockImplementationOnce(() => new Promise((_, reject) => (failFirst = reject)));
    getServiceStatus.mockResolvedValue(running);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Sidebar route={{ name: "health" }} />));
    // A focus event while the first request hangs must not start a second request.
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(getServiceStatus).toHaveBeenCalledTimes(1);
    await act(async () => failFirst("timeout"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    const status = () => host.querySelector('[role="status"]')?.textContent;
    expect(status()).toBe("All services running");
    act(() => root.unmount());
    vi.useRealTimers();
  });
});
