import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOverlay,
  currentOverlay,
  hasCommandKey,
  openOverlay,
  type Presence,
  toggleOverlay,
  usePresence,
} from "./overlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => closeOverlay());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("overlay store", () => {
  it("keeps one overlay open at a time", () => {
    openOverlay("palette");
    openOverlay("area-switcher");
    expect(currentOverlay()).toBe("area-switcher");
    closeOverlay("palette");
    expect(currentOverlay()).toBe("area-switcher");
    closeOverlay("area-switcher");
    expect(currentOverlay()).toBeNull();
  });
  it("toggles", () => {
    toggleOverlay("palette");
    expect(currentOverlay()).toBe("palette");
    toggleOverlay("palette");
    expect(currentOverlay()).toBeNull();
  });
  it("picks the command key by platform", () => {
    expect(hasCommandKey({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(hasCommandKey({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(hasCommandKey({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(hasCommandKey({ metaKey: true, ctrlKey: false }, false)).toBe(false);
  });
});

function Probe({ states }: { states: Presence[] }) {
  states.push(usePresence("palette"));
  return null;
}

function mount(states: Presence[]) {
  const host = document.createElement("div");
  act(() => createRoot(host).render(createElement(Probe, { states })));
}

describe("usePresence", () => {
  it("stays mounted through the fade, then unmounts", () => {
    vi.useFakeTimers();
    const states: Presence[] = [];
    mount(states);
    act(() => openOverlay("palette"));
    expect(states.at(-1)?.mounted).toBe(true);
    act(() => closeOverlay());
    expect(states.at(-1)).toMatchObject({ mounted: true, closing: true });
    act(() => vi.advanceTimersByTime(200));
    expect(states.at(-1)?.mounted).toBe(false);
  });
  it("unmounts at once when the other overlay takes over", () => {
    const states: Presence[] = [];
    mount(states);
    act(() => openOverlay("palette"));
    act(() => openOverlay("area-switcher"));
    expect(states.at(-1)?.mounted).toBe(false);
  });
  it("unmounts at once under reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("reduce"),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    const states: Presence[] = [];
    mount(states);
    act(() => openOverlay("palette"));
    expect(states.at(-1)?.style).toEqual({});
    act(() => closeOverlay());
    expect(states.at(-1)?.mounted).toBe(false);
  });
  it("starts a new session on every open", () => {
    const states: Presence[] = [];
    mount(states);
    act(() => openOverlay("palette"));
    const first = states.at(-1)?.session;
    act(() => closeOverlay());
    act(() => openOverlay("palette"));
    expect(states.at(-1)?.session).not.toBe(first);
  });
});
