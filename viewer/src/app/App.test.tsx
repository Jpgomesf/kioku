import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pages/library", () => ({
  LibraryPage: ({ params }: { params: { kind?: string } }) => {
    if (params.kind === "boom") throw new Error("library broke");
    return <h1>Library {params.kind ?? ""}</h1>;
  },
}));
vi.mock("../pages/health", () => ({ HealthPage: () => <h1>Health page</h1> }));
vi.mock("../pages/graph", () => ({ GraphPage: () => <h1>Graph page</h1> }));
vi.mock("../pages/guide", () => ({ GuidePage: () => <h1>Guide page</h1> }));
vi.mock("../pages/note", () => ({ NotePage: () => <h1>Note page</h1> }));
vi.mock("../pages/reflect", () => ({ ReflectPage: () => <h1>Reflect page</h1> }));
vi.mock("../pages/vaults", () => ({
  VaultsPage: () => <h1>Vaults page</h1>,
  ReviewPage: () => <h1>Review page</h1>,
}));
vi.mock("../components/shell/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../components/palette", () => ({ Palette: () => null }));
vi.mock("../components/area-switcher", () => ({ AreaSwitcher: () => null }));
vi.mock("../components/ui/Toast", () => ({ ToastHost: () => null }));
vi.mock("./shortcuts", () => ({ useGlobalShortcuts: () => undefined }));

import { App } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type VTSlot = { startViewTransition?: unknown };

function setReduced(value: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: value && q.includes("reduce"),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

let root: Root;
let host: HTMLDivElement;
const originalMatch = window.matchMedia;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.matchMedia = originalMatch;
  delete (document as unknown as VTSlot).startViewTransition;
  vi.restoreAllMocks();
});

function mount(hash: string) {
  window.location.hash = hash;
  act(() => root.render(<App />));
}

describe("App route swap", () => {
  it("shows the new page on the first navigation away from a crash", () => {
    setReduced(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount("#/library?kind=boom");
    expect(host.textContent).toContain("This view stopped working");
    go("#/health");
    expect(host.textContent).toContain("Health page");
    expect(host.textContent).not.toContain("stopped working");
  });

  it("logs nothing under reduced motion", () => {
    setReduced(true);
    const error = vi.spyOn(console, "error");
    mount("#/library");
    go("#/health");
    go("#/reflect");
    expect(host.textContent).toContain("Reflect page");
    expect(error).not.toHaveBeenCalled();
  });

  it("animates page changes only", () => {
    setReduced(false);
    const start = vi.fn((fn: () => void) => {
      fn();
      return { finished: Promise.resolve() };
    });
    (document as unknown as VTSlot).startViewTransition = start;
    mount("#/library?kind=decision");
    go("#/library?kind=gotcha");
    expect(host.textContent).toContain("Library gotcha");
    go("#/graph?domain=demo");
    go("#/graph?domain=demo&focus=a");
    expect(start).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Graph page");
  });

  it("scrolls the main pane to the top on a page change", () => {
    setReduced(true);
    mount("#/library");
    const main = host.querySelector("main");
    if (!main) throw new Error("no main");
    main.scrollTop = 300;
    go("#/health");
    expect(main.scrollTop).toBe(0);
    expect(document.activeElement).toBe(main);
  });
});
