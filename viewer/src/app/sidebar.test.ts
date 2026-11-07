import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCollapsed,
  resetSidebar,
  toggledChoice,
  toggleSidebar,
  useSidebarCollapsed,
} from "./sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("sidebar collapse rules", () => {
  it("follows the window width until the person chooses", () => {
    expect(isCollapsed(null, true)).toBe(true);
    expect(isCollapsed(null, false)).toBe(false);
    expect(isCollapsed("expanded", true)).toBe(false);
    expect(isCollapsed("collapsed", false)).toBe(true);
  });

  it("stores only a choice that differs from what the width picks", () => {
    // Wide: collapsing is a choice, and expanding again goes back to following the width.
    expect(toggledChoice(null, false)).toBe("collapsed");
    expect(toggledChoice("collapsed", false)).toBeNull();
    // Narrow: the other way round.
    expect(toggledChoice(null, true)).toBe("expanded");
    expect(toggledChoice("expanded", true)).toBeNull();
    // A choice made at one width still flips what is on screen at the other.
    expect(toggledChoice("collapsed", true)).toBe("expanded");
    expect(toggledChoice("expanded", false)).toBe("collapsed");
  });
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

/** A media query whose match the test sets, telling its listeners like a real one. */
function fakeNarrow(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  vi.stubGlobal("matchMedia", () => query);
  return (narrow: boolean) => {
    query.matches = narrow;
    for (const l of listeners) l();
  };
}

function Probe() {
  return createElement("span", null, useSidebarCollapsed() ? "rail" : "panel");
}

describe("sidebar collapse store", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    resetSidebar();
  });

  it("collapses on its own when the window narrows, and expands when it widens", () => {
    const setNarrow = fakeNarrow(false);
    act(() => root.render(createElement(Probe)));
    expect(host.textContent).toBe("panel");
    act(() => setNarrow(true));
    expect(host.textContent).toBe("rail");
    act(() => setNarrow(false));
    expect(host.textContent).toBe("panel");
  });

  it("keeps a collapse chosen on a wide window, and remembers it", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    fakeNarrow(false);
    act(() => root.render(createElement(Probe)));
    act(() => toggleSidebar());
    expect(host.textContent).toBe("rail");
    expect(storage.getItem("kioku.viewer.sidebar")).toBe("collapsed");
    act(() => toggleSidebar());
    expect(host.textContent).toBe("panel");
    expect(storage.getItem("kioku.viewer.sidebar")).toBeNull();
  });

  it("lets a narrow window show the full sidebar without remembering a collapse", () => {
    const setNarrow = fakeNarrow(true);
    act(() => root.render(createElement(Probe)));
    expect(host.textContent).toBe("rail");
    act(() => toggleSidebar());
    expect(host.textContent).toBe("panel");
    act(() => toggleSidebar());
    expect(host.textContent).toBe("rail");
    // Collapsing again matched the width, so a wide window shows the full sidebar.
    act(() => setNarrow(false));
    expect(host.textContent).toBe("panel");
  });
});
