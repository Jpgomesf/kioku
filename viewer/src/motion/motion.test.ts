import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PresenceState, staggerStyle, usePrefersReducedMotion, usePresence } from "./index";
import { runViewTransition } from "./viewTransition";

type Listener = () => void;

function mockMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const mq = {
    matches: initial,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
  return {
    set(value: boolean) {
      mq.matches = value;
      for (const l of listeners) l();
    },
  };
}

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seen: boolean[] = [];
function Probe() {
  seen.push(usePrefersReducedMotion());
  return null;
}

describe("usePrefersReducedMotion", () => {
  it("follows the media query", () => {
    const media = mockMatchMedia(false);
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBe(false);
    act(() => media.set(true));
    expect(seen.at(-1)).toBe(true);
    act(() => root.unmount());
  });
});

describe("runViewTransition", () => {
  it("runs the update directly without the API", async () => {
    const update = vi.fn();
    const doc = {} as Document;
    await runViewTransition(update, { reduced: false, doc });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("uses startViewTransition when present", async () => {
    const update = vi.fn();
    const start = vi.fn((fn: () => void) => {
      fn();
      return { finished: Promise.resolve() };
    });
    const doc = { startViewTransition: start } as unknown as Document;
    await runViewTransition(update, { reduced: false, doc });
    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("skips the API under reduced motion", async () => {
    const update = vi.fn();
    const start = vi.fn();
    const doc = { startViewTransition: start } as unknown as Document;
    await runViewTransition(update, { reduced: true, doc });
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("runViewTransition fallbacks", () => {
  it("runs the update when start throws, and clears the type", async () => {
    const update = vi.fn();
    const root = document.createElement("html");
    const doc = {
      documentElement: root,
      startViewTransition: () => {
        throw new Error("no");
      },
    } as unknown as Document;
    await runViewTransition(update, { reduced: false, doc, type: "route" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(root.dataset.transition).toBeUndefined();
  });

  it("marks the root with the type while it runs", async () => {
    const root = document.createElement("html");
    let during: string | undefined;
    const doc = {
      documentElement: root,
      startViewTransition: (fn: () => void) => {
        fn();
        during = root.dataset.transition;
        return { finished: Promise.resolve() };
      },
    } as unknown as Document;
    await runViewTransition(() => undefined, { reduced: false, doc, type: "route" });
    expect(during).toBe("route");
    expect(root.dataset.transition).toBeUndefined();
  });
});

const states: PresenceState[] = [];
function Panel({ open }: { open: boolean }) {
  states.push(usePresence(open));
  return null;
}

describe("usePresence", () => {
  it("enters without flashing when mounted open", () => {
    mockMatchMedia(false);
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout"] });
    states.length = 0;
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Panel, { open: true })));
    act(() => vi.advanceTimersByTime(50));
    expect(states[0]).toBe("entering");
    expect(states.at(-1)).toBe("entered");
    expect([...new Set(states)]).toEqual(["entering", "entered"]);
    act(() => root.render(createElement(Panel, { open: false })));
    expect(states.at(-1)).toBe("leaving");
    act(() => vi.advanceTimersByTime(500));
    expect(states.at(-1)).toBe("gone");
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("staggers capped at eight items", () => {
    expect(staggerStyle(2)).toEqual({ animationDelay: "40ms" });
    expect(staggerStyle(50)).toEqual({ animationDelay: "160ms" });
  });
});

describe("runViewTransition data-transition", () => {
  it("keeps the attribute while a newer transition runs after an older one ends", async () => {
    const root = document.createElement("html");
    const ends: Array<() => void> = [];
    const doc = {
      documentElement: root,
      startViewTransition: (fn: () => void) => {
        fn();
        return { finished: new Promise<void>((resolve) => ends.push(resolve)) };
      },
    } as unknown as Document;
    const first = runViewTransition(() => {}, { reduced: false, doc, type: "route" });
    const second = runViewTransition(() => {}, { reduced: false, doc, type: "route" });
    ends[0]?.();
    await first;
    expect(root.dataset.transition).toBe("route");
    ends[1]?.();
    await second;
    expect(root.dataset.transition).toBeUndefined();
  });

  it("clears a typed transition's attribute when an untyped one starts meanwhile", async () => {
    const root = document.createElement("html");
    const ends: Array<() => void> = [];
    const doc = {
      documentElement: root,
      startViewTransition: (fn: () => void) => {
        fn();
        return { finished: new Promise<void>((resolve) => ends.push(resolve)) };
      },
    } as unknown as Document;
    const typed = runViewTransition(() => {}, { reduced: false, doc, type: "route" });
    const untyped = runViewTransition(() => {}, { reduced: false, doc });
    ends[0]?.();
    await typed;
    expect(root.dataset.transition).toBeUndefined();
    ends[1]?.();
    await untyped;
  });
});
