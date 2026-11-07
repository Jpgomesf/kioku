import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData } from "../../api";
import { getGraph as mockGraph } from "../../api/graph/mock";
import { setCurrentArea } from "../../app/area";
import { graphHref } from "../../app/router";

const getGraph = vi.fn<(q: { domain: string }) => Promise<GraphData>>();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  getGraph: (q: { domain: string }) => getGraph(q),
}));

const { GraphPage } = await import("./index");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; host: HTMLElement }> = [];

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  getGraph.mockReset();
  window.history.replaceState(null, "", "#/");
});

function render(domain: string | undefined) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  act(() => root.render(<GraphPage domain={domain} />));
  return host;
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

describe("GraphPage", () => {
  it("shows a loading line, then the graph", async () => {
    let resolve: (g: GraphData) => void = () => undefined;
    getGraph.mockImplementation(() => new Promise((r) => (resolve = r)));
    const host = render("demo");
    expect(host.textContent).toContain("Loading");
    await act(async () => resolve(mockGraph({ domain: "demo" })));
    await settle();
    expect(host.textContent).toContain("notes and");
  });

  it("says when the graph didn't load", async () => {
    getGraph.mockRejectedValue(new Error("store is closed"));
    const host = render("demo");
    await settle();
    expect(host.textContent).toContain("The graph didn't load");
    expect(host.textContent).toContain("store is closed");
  });

  it("follows the area picker even when the URL names a domain", async () => {
    getGraph.mockImplementation(async (q) => mockGraph(q));
    setCurrentArea("demo");
    render("demo");
    await settle();
    act(() => setCurrentArea("local"));
    expect(window.location.hash).toBe(graphHref("local"));
  });
});
