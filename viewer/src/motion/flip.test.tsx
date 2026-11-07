import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlip } from "./flip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  el: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
}

let calls: Call[] = [];
let host: HTMLDivElement;
let root: Root;

// jsdom has no layout: each element reports the box written in its data-box ("x,y,w,h").
function boxOf(el: Element): DOMRect {
  const [x = 0, y = 0, w = 0, h = 0] = (el.getAttribute("data-box") ?? "0,0,0,0")
    .split(",")
    .map(Number);
  return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y } as DOMRect;
}

/** Two layouts of the same chips: B moves down a row, C goes, N arrives, the row grows. */
function Chips() {
  const ref = useRef<HTMLDivElement>(null);
  const capture = useFlip(ref);
  const [open, setOpen] = useState(false);
  const chips = open
    ? [
        ["a", "0,0,90,30"],
        ["n", "100,0,90,30"],
        ["b", "0,40,90,30"],
      ]
    : [
        ["a", "0,0,90,30"],
        ["b", "100,0,90,30"],
        ["c", "200,0,90,30"],
      ];
  return (
    <>
      <div ref={ref} data-box={open ? "0,0,300,70" : "0,0,300,30"}>
        {chips.map(([key, box]) => (
          <span key={key} data-box={box}>
            {key}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          capture();
          setOpen((o) => !o);
        }}
      >
        toggle
      </button>
    </>
  );
}

beforeEach(() => {
  calls = [];
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return boxOf(this);
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value: function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ el: this, frames, options });
      return { finished: Promise.resolve() };
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

const toggle = () => act(() => host.querySelector<HTMLButtonElement>("button")?.click());
const callFor = (text: string) => calls.find((c) => c.el.textContent === text);

describe("useFlip", () => {
  it("moves the chips that stay, fades new ones in and old ones out, and grows the row", async () => {
    act(() => root.render(<Chips />));
    toggle();
    // b moved from (100, 0) to (0, 40): it starts where it was and glides.
    expect(callFor("b")?.frames).toEqual([
      { transform: "translate(100px, -40px)" },
      { transform: "none" },
    ]);
    // a stayed put: no animation.
    expect(callFor("a")).toBeUndefined();
    // n is new: it fades in, held invisible until its turn.
    expect(callFor("n")?.frames[0]).toMatchObject({ opacity: 0 });
    expect(callFor("n")?.options.fill).toBe("backwards");
    // c is gone from the page; an inert copy fades where it stood.
    const ghost = callFor("c");
    expect(ghost?.el.getAttribute("aria-hidden")).toBe("true");
    expect((ghost?.el as HTMLElement | undefined)?.style.left).toBe("200px");
    expect(ghost?.frames.at(-1)).toMatchObject({ opacity: 0 });
    // The row's height follows from 30 to 70.
    const row = calls.find((c) => c.el === host.querySelector("div"));
    expect(row?.frames.map((f) => f.height)).toEqual(["30px", "70px"]);
    // The copy leaves once its fade ends.
    await act(async () => Promise.resolve());
    expect([...(host.querySelector("div")?.children ?? [])].map((c) => c.textContent)).toEqual([
      "a",
      "n",
      "b",
    ]);
  });

  it("lands at once under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    act(() => root.render(<Chips />));
    toggle();
    expect(calls).toEqual([]);
  });

  it("animates nothing for a commit it wasn't asked about", () => {
    act(() => root.render(<Chips />));
    act(() => root.render(<Chips key="again" />));
    expect(calls).toEqual([]);
  });
});
