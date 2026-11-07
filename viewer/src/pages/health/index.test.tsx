import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/reflect/client", () => ({ listReflectRuns: vi.fn() }));
vi.mock("../../api/health/client", () => ({ getStats: vi.fn(), getServiceStatus: vi.fn() }));
vi.mock("../../api/notes/client", () => ({
  listAreas: vi.fn(),
  listVaults: vi.fn(),
  listNotes: vi.fn(),
  getNote: vi.fn(),
}));

import * as health from "../../api/health/client";
import * as notes from "../../api/notes/client";
import * as reflect from "../../api/reflect/client";
import { HealthPage } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const status = {
  postgres: { state: "running" as const, detail: "notes" },
  qdrant: { state: "running" as const, detail: "vectors" },
  ollama: { state: "down" as const, detail: "no answer" },
  embeddingModel: "nomic-embed-text",
  embeddingProvider: "ollama" as const,
  embeddingLocal: true,
  embeddingReader: "this Mac",
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.mocked(health.getServiceStatus).mockResolvedValue(status);
  vi.mocked(health.getStats).mockResolvedValue({
    domains: [{ domain: "demo", active: 2, legacy: 0 }],
    links: 111,
    pendingVectors: 0,
  });
  vi.mocked(notes.listAreas).mockResolvedValue([]);
  vi.mocked(notes.listVaults).mockResolvedValue([]);
  vi.mocked(notes.listNotes).mockResolvedValue([]);
  vi.mocked(reflect.listReflectRuns).mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const checkButton = () =>
  Array.from(host.querySelectorAll("button")).find((b) => b.closest("header")) ?? null;

describe("HealthPage", () => {
  it("shows the loading text, then the services", async () => {
    act(() => root.render(<HealthPage />));
    expect(host.textContent).toContain("Loading health…");
    expect(host.textContent).toContain("Checking…");
    await settle();
    expect(host.textContent).toContain("PostgreSQL");
    expect(host.textContent).toContain("Not reachable");
    expect(host.textContent).toContain("Check again");
  });

  it("keeps the services when a secondary call fails", async () => {
    vi.mocked(reflect.listReflectRuns).mockRejectedValue({ message: "not_implemented" });
    vi.mocked(health.getStats).mockRejectedValue({ message: "database down" });
    act(() => root.render(<HealthPage />));
    await settle();
    expect(host.textContent).toContain("PostgreSQL");
    expect(host.textContent).toContain("Could not check: database down");
    expect(host.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  });

  it("shows a section error when the status call fails, and retries", async () => {
    vi.mocked(health.getServiceStatus).mockRejectedValueOnce({ message: "offline" });
    act(() => root.render(<HealthPage />));
    await settle();
    expect(host.textContent).toContain("Could not check: offline");
    act(() => checkButton()?.click());
    await settle();
    expect(host.textContent).toContain("PostgreSQL");
  });

  it("ignores clicks while a check is running and keeps the button focusable", async () => {
    act(() => root.render(<HealthPage />));
    await settle();
    let release: () => void = () => undefined;
    vi.mocked(health.getStats).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ domains: [], links: 222, pendingVectors: 0 });
        }),
    );
    const button = checkButton();
    act(() => button?.click());
    await settle();
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(health.getStats).toHaveBeenCalledTimes(2);
    await act(async () => release());
    await settle();
    expect(host.textContent).toContain("222 links");
    expect(button?.getAttribute("aria-disabled")).toBe("false");
  });
});
