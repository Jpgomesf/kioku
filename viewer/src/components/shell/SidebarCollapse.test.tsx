import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ok = { state: "running" as const, detail: "" };

vi.mock("../../api", () => ({
  getServiceStatus: () =>
    Promise.resolve({
      postgres: ok,
      qdrant: ok,
      ollama: ok,
      embeddingModel: "m",
      embeddingProvider: "ollama" as const,
      embeddingLocal: true,
      embeddingReader: "this Mac",
    }),
  listAreas: () =>
    Promise.resolve([{ domain: "demo", label: "demo", vault: "personal", noteCount: 3 }]),
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
vi.mock("../../pages/vaults/draft", () => ({ useOpenRequestCount: () => 2 }));

import { resetSidebar } from "../../app/sidebar";
import { Sidebar } from "./Sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Sidebar route={{ name: "library", params: {} }} />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetSidebar();
});

const nav = () => host.querySelector<HTMLElement>("nav.k-sidebar");
// Compared as text: the ⌘\ in a label is an escape inside a CSS selector.
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);
const link = (name: string) =>
  [...host.querySelectorAll<HTMLAnchorElement>("a.k-nav-item")].find((a) =>
    a.textContent?.startsWith(name),
  );

describe("collapsed sidebar", () => {
  it("becomes a rail of icons that keeps every name readable", () => {
    expect(nav()?.hasAttribute("data-collapsed")).toBe(false);
    expect(host.querySelector(".k-area-row")).not.toBeNull();
    act(() => button("Collapse the sidebar (⌘\\)")?.click());
    expect(nav()?.hasAttribute("data-collapsed")).toBe(true);
    // The name stays in the link for screen readers and shows as its tooltip.
    expect(link("Library")?.getAttribute("title")).toBe("Library");
    expect(link("Library")?.querySelector(".k-sr")?.textContent).toBe("Library");
    // The badge stays, with its words.
    expect(link("Vaults and visibility")?.textContent).toContain("2 access requests");
    // Recent areas give way to the search button.
    expect(host.querySelector(".k-area-row")).toBeNull();
    expect(button("Find an area (⌘O)")).not.toBeNull();
    act(() => button("Expand the sidebar (⌘\\)")?.click());
    expect(nav()?.hasAttribute("data-collapsed")).toBe(false);
    expect(link("Library")?.hasAttribute("title")).toBe(false);
  });

  it("expands with the services details from the rail's status dot", async () => {
    act(() => button("Collapse the sidebar (⌘\\)")?.click());
    const services = host.querySelector<HTMLButtonElement>(".sidebar-services-toggle");
    expect(services?.getAttribute("title")).toBe("All services running");
    expect(services?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => services?.click());
    expect(nav()?.hasAttribute("data-collapsed")).toBe(false);
    expect(services?.getAttribute("aria-expanded")).toBe("true");
  });
});
