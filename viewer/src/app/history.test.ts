import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backLabel,
  canGoBack,
  pushEntry,
  recordEntry,
  replaceEntry,
  resetHistory,
  usePreviousRoute,
} from "./history";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A link or location.hash change: a new entry with no state, then the router's event. */
function follow(hash: string): void {
  window.history.pushState(null, "", hash);
  recordEntry();
}

/** Back or Forward to an entry the app stamped earlier, as the browser would restore it. */
function traverseTo(place: number, hash: string): void {
  window.history.replaceState({ kiokuPlace: place }, "", hash);
  recordEntry();
}

function Probe() {
  const previous = usePreviousRoute();
  return createElement(
    "span",
    null,
    previous === undefined ? "none" : previous === null ? "unknown" : previous.name,
  );
}

describe("app history", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/library");
    resetHistory();
    recordEntry();
  });
  afterEach(() => {
    window.history.replaceState(null, "", "#/");
  });

  it("knows the page before a note, and stamps each entry with its place", () => {
    expect(canGoBack()).toBe(false);
    follow("#/note/demo/a");
    expect(canGoBack()).toBe(true);
    expect((window.history.state as { kiokuPlace: number }).kiokuPlace).toBe(1);
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    expect(host.textContent).toBe("library");
    // Back to the Library: nothing before it.
    act(() => traverseTo(0, "#/library"));
    expect(host.textContent).toBe("none");
    // Forward again: the Library is behind the note once more.
    act(() => traverseTo(1, "#/note/demo/a"));
    expect(host.textContent).toBe("library");
    act(() => root.unmount());
  });

  it("drops the entries ahead when a new page opens after going back", () => {
    follow("#/note/demo/a");
    follow("#/note/demo/b");
    traverseTo(1, "#/note/demo/a");
    follow("#/graph?domain=demo");
    expect((window.history.state as { kiokuPlace: number }).kiokuPlace).toBe(2);
    follow("#/note/demo/c");
    // Back from c goes to the graph, not to the dropped b.
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    expect(host.textContent).toBe("graph");
    act(() => root.unmount());
  });

  it("keeps the graph's own entries in line, and rewrites without moving", () => {
    follow("#/graph?domain=demo");
    pushEntry("#/graph?domain=demo&focus=a");
    expect((window.history.state as { kiokuPlace: number }).kiokuPlace).toBe(2);
    replaceEntry("#/graph?domain=demo&focus=b");
    expect((window.history.state as { kiokuPlace: number }).kiokuPlace).toBe(2);
    follow("#/note/demo/b");
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    expect(host.textContent).toBe("graph");
    act(() => root.unmount());
  });

  it("says it doesn't know the page before when the app reloaded mid-history", () => {
    follow("#/note/demo/a");
    // A reload: the session's memory is gone, the stamped entry remains.
    resetHistory();
    recordEntry();
    expect(canGoBack()).toBe(true);
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    expect(host.textContent).toBe("unknown");
    act(() => root.unmount());
  });

  it("names each kind of page", () => {
    expect(backLabel({ name: "library", params: {} })).toBe("Library");
    expect(backLabel({ name: "graph", domain: "demo" })).toBe("Graph");
    expect(backLabel({ name: "note", domain: "demo", key: "a" })).toBe("Previous note");
    expect(backLabel({ name: "vaults-review" })).toBe("Vaults");
    expect(backLabel(null)).toBe("Back");
  });
});
