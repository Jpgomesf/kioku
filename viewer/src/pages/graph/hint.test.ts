import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HINT_KEY, HINT_MS, resetFirstVisitHint, useFirstVisitHint } from "./hint";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function Probe() {
  return createElement("span", null, useFirstVisitHint() ? "shown" : "gone");
}

/** One visit to the graph: the page mounts, and later unmounts. */
function visit() {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  return { text: () => host.textContent, leave: () => act(() => root.unmount()) };
}

describe("first-visit hint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFirstVisitHint();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows for five seconds the first time, then never again", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const first = visit();
    expect(first.text()).toBe("shown");
    act(() => vi.advanceTimersByTime(HINT_MS - 1));
    expect(first.text()).toBe("shown");
    act(() => vi.advanceTimersByTime(1));
    expect(first.text()).toBe("gone");
    expect(storage.getItem(HINT_KEY)).toBe("1");
    first.leave();
    // A later launch: only the stored flag remembers.
    resetFirstVisitHint();
    const later = visit();
    expect(later.text()).toBe("gone");
    later.leave();
  });

  it("shows again when the graph was left before the five seconds were up", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const first = visit();
    act(() => vi.advanceTimersByTime(2000));
    first.leave();
    expect(storage.getItem(HINT_KEY)).toBeNull();
    const again = visit();
    expect(again.text()).toBe("shown");
    again.leave();
  });

  it("shows once per launch when storage is blocked", () => {
    vi.stubGlobal("localStorage", undefined);
    const first = visit();
    act(() => vi.advanceTimersByTime(HINT_MS));
    expect(first.text()).toBe("gone");
    first.leave();
    const again = visit();
    expect(again.text()).toBe("gone");
    again.leave();
  });
});
