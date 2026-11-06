import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { lastVisitFor, markReviewed, resetLastVisitSession, useLastVisit } from "./useLastVisit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "kioku.viewer.library.lastVisit";

function Probe({ out }: { out: (v: string | null) => void }) {
  out(useLastVisit("demo"));
  return null;
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  resetLastVisitSession();
  window.localStorage.setItem(KEY, JSON.stringify({ demo: "2026-10-01T09:00:00.000Z" }));
});

describe("useLastVisit", () => {
  it("keeps the earlier visit across remounts and under StrictMode", () => {
    const seen: (string | null)[] = [];
    for (let i = 0; i < 2; i += 1) {
      const host = document.createElement("div");
      const root = createRoot(host);
      act(() =>
        root.render(
          <StrictMode>
            <Probe out={(v) => seen.push(v)} />
          </StrictMode>,
        ),
      );
      act(() => root.unmount());
    }
    expect(new Set(seen)).toEqual(new Set(["2026-10-01T09:00:00.000Z"]));
  });

  it("doesn't move just because the Library opened", () => {
    lastVisitFor("demo");
    resetLastVisitSession();
    expect(lastVisitFor("demo")).toBe("2026-10-01T09:00:00.000Z");
  });

  it("moves when the area is marked as reviewed", () => {
    markReviewed("demo", new Date("2026-11-06T12:00:00Z"));
    resetLastVisitSession();
    expect(lastVisitFor("demo")).toBe("2026-11-06T12:00:00.000Z");
  });
});
