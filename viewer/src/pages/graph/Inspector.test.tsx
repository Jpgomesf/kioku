import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphEdge, GraphNode } from "../../api";
import { Inspector, type InspectorProps } from "./Inspector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node = (key: string): GraphNode => ({
  key,
  domain: "t",
  title: `Title of ${key}`,
  kind: "decision",
  status: "active",
  degree: 1,
  tags: [],
  updatedAt: "2026-11-01T10:00:00Z",
});

const link = (source: string, target: string, suggested = false): GraphEdge => ({
  source,
  target,
  relation: "related",
  suggested,
});

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/** A note "a" linked to every other key given; all of them visible unless said otherwise. */
function setup(overrides: Partial<InspectorProps> = {}, others = ["b", "c"]) {
  const a = node("a");
  const data: GraphData = {
    nodes: [a, ...others.map(node)],
    edges: others.map((k) => link("a", k)),
  };
  const props: InspectorProps = {
    node: a,
    data,
    visibleKeys: new Set(data.nodes.map((n) => n.key)),
    rank: () => 0,
    colourOf: () => "#8a8b93",
    onFocus: vi.fn(),
    onAround: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<Inspector {...props} />));
  return {
    host,
    props,
    rerender: (next: Partial<InspectorProps>) =>
      act(() => root?.render(<Inspector {...props} {...next} />)),
  };
}

const scrollerOf = (host: HTMLElement) => host.querySelector<HTMLElement>(".ins-scroll");
const headings = (host: HTMLElement) =>
  [...host.querySelectorAll(".ins-scroll h3")].map((h) => h.textContent);
const rowKeys = (host: HTMLElement) =>
  [...host.querySelectorAll(".graph-link .k-mono")].map((e) => e.textContent);

/** jsdom has no layout: give an element the box a browser would. */
function boxAt(el: Element, top: number, bottom: number) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    top,
    bottom,
    left: 0,
    right: 300,
    width: 300,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
}

/** Rows 40px tall from the list's top, with the list showing the first `shown` pixels. */
function layOut(host: HTMLElement, scrolled: number, shown = 100) {
  const scroller = scrollerOf(host) as HTMLElement;
  boxAt(scroller, 0, shown);
  [...scroller.querySelectorAll("li")].forEach((li, i) => {
    boxAt(li, i * 40 - scrolled, (i + 1) * 40 - scrolled);
  });
  act(() => {
    scroller.dispatchEvent(new Event("scroll"));
  });
}

describe("Inspector", () => {
  it("leaves out links to notes the filters hide", () => {
    const { host } = setup({ visibleKeys: new Set(["a", "b"]) });
    expect(rowKeys(host)).toEqual(["b"]);
  });

  it("keeps the header and the actions out of the scrolling list", () => {
    const { host, props } = setup();
    const scroller = scrollerOf(host) as HTMLElement;
    const title = host.querySelector("#graph-inspector-title");
    const open = [...host.querySelectorAll("a")].find((el) => el.textContent === "Open the note");
    const around = [...host.querySelectorAll("button")].find(
      (el) => el.textContent === "Around this note",
    );
    const close = host.querySelector('button[aria-label="Clear the selection"]');
    expect(title?.textContent).toBe("Title of a");
    expect(host.querySelector(".ins-head")?.textContent).toContain("a");
    expect(host.querySelector<HTMLElement>(".ins-swatch")?.style.background).not.toBe("");
    expect(open?.getAttribute("href")).toContain("a");
    for (const fixed of [title, open, around, close]) {
      expect(fixed).not.toBeNull();
      expect(scroller.contains(fixed as Node)).toBe(false);
    }
    // The rows scroll on their own, and come after the actions for the keyboard too.
    expect(scroller.querySelectorAll("li")).toHaveLength(2);
    const order = (open as Node).compareDocumentPosition(scroller);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => (around as HTMLButtonElement).click());
    expect(props.onAround).toHaveBeenCalledTimes(1);
  });

  it("names the direct links with their count", () => {
    const { host, rerender } = setup();
    expect(headings(host)).toEqual(["2 direct links"]);
    rerender({ visibleKeys: new Set(["a", "b"]) });
    expect(headings(host)).toEqual(["1 direct link"]);
    rerender({ visibleKeys: new Set(["a"]) });
    expect(headings(host)).toEqual([]);
    expect(host.textContent).toContain("No recorded links.");
  });

  it("lists suggested links apart, with their count", () => {
    const a = node("a");
    const data: GraphData = {
      nodes: [a, node("b"), node("c")],
      edges: [link("a", "b"), link("c", "a", true)],
    };
    const { host } = setup({ data, visibleKeys: new Set(["a", "b", "c"]) });
    expect(headings(host)).toEqual(["1 direct link", "1 suggested link"]);
    expect(host.querySelector(".graph-links-suggested")?.textContent).toContain("Linked from");
    expect(host.querySelector(".k-finding")?.textContent).toContain("Reflect suggests linking");
  });

  it("lists the notes further away from their depths, nearest first", () => {
    const depths = new Map([
      ["a", 0],
      ["b", 1],
      ["far2", 2],
      ["far3", 3],
      ["also3", 3],
      // A tag is not a note, a hidden note has no row, and a direct link keeps its own row.
      ["tag:idea", 2],
      ["hidden", 2],
      ["c", 2],
    ]);
    const others = ["b", "c", "far2", "far3", "also3", "hidden"];
    const a = node("a");
    const data: GraphData = {
      nodes: [a, ...others.map(node)],
      edges: [link("a", "b"), link("a", "c"), link("b", "far2"), link("far2", "far3")],
    };
    const visibleKeys = new Set(["a", "b", "c", "far2", "far3", "also3"]);
    const { host, props } = setup({ data, visibleKeys, depths });
    expect(headings(host)).toEqual([
      "2 direct links",
      "1 note 2 links away",
      "2 notes 3 links away",
    ]);
    expect(rowKeys(host)).toEqual(["b", "c", "far2", "also3", "far3"]);
    // Further notes have no relation of their own to show.
    const far = [...host.querySelectorAll(".graph-link")].find((b) =>
      b.textContent?.includes("far2"),
    );
    expect(far?.querySelector(".graph-link-rel")).toBeNull();
    act(() => (far as HTMLButtonElement).click());
    expect(props.onFocus).toHaveBeenCalledWith("far2");
  });

  it("lists the first 25 notes of a farther level and counts the rest", () => {
    // "a" links to "b", which links to 30 notes: all 2 links away from "a".
    const far = Array.from({ length: 30 }, (_, i) => `far${String(i).padStart(2, "0")}`);
    const a = node("a");
    const data: GraphData = {
      nodes: [a, node("b"), ...far.map(node)],
      edges: [link("a", "b"), ...far.map((k) => link("b", k))],
    };
    const depths = new Map([["a", 0], ["b", 1], ...far.map((k) => [k, 2] as const)]);
    const { host } = setup({ data, visibleKeys: new Set(depths.keys()), depths });
    expect(headings(host)).toEqual(["1 direct link", "30 notes 2 links away"]);
    expect(rowKeys(host)).toEqual(["b", ...far.slice(0, 25)]);
    const rest = host.querySelector(".ins-scroll > .k-legend-note");
    expect(rest?.textContent).toBe("And 5 more");
    // It is not a row, so the scroll hint counts only rows.
    expect(rest?.closest("li")).toBeNull();
  });

  it("lists nothing farther from depths counted from another note", () => {
    // a - b - x - z, with "a" selected and "b" hovered at depth 2: z is 2 links from b, not a.
    const a = node("a");
    const data: GraphData = {
      nodes: [a, node("b"), node("x"), node("z")],
      edges: [link("a", "b"), link("b", "x"), link("x", "z")],
    };
    const fromB = new Map([
      ["b", 0],
      ["a", 1],
      ["x", 1],
      ["z", 2],
    ]);
    const visibleKeys = new Set(["a", "b", "x", "z"]);
    const { host, rerender } = setup({ data, visibleKeys, depths: fromB });
    expect(headings(host)).toEqual(["1 direct link"]);
    expect(rowKeys(host)).toEqual(["b"]);
    // Counted from "a", x is 2 links away and z 3.
    const fromA = new Map([
      ["a", 0],
      ["b", 1],
      ["x", 2],
      ["z", 3],
    ]);
    rerender({ data, visibleKeys, depths: fromA });
    expect(headings(host)).toEqual(["1 direct link", "1 note 2 links away", "1 note 3 links away"]);
    expect(rowKeys(host)).toEqual(["b", "x", "z"]);
  });

  it("fades the bottom and says how many rows are below, until the end", () => {
    const { host } = setup({}, ["b", "c", "d", "e", "f"]);
    const body = scrollerOf(host) as HTMLElement;
    // Five 40px rows in a 100px list: two are shown, three are below.
    layOut(host, 0);
    expect(body.querySelector(".ins-more")?.textContent).toBe("Scroll for 3 more");
    layOut(host, 40);
    expect(body.querySelector(".ins-more")?.textContent).toBe("Scroll for 2 more");
    layOut(host, 100);
    expect(body.querySelector(".ins-more")).toBeNull();
  });

  it("hides the hint from screen readers and the Tab order, which reach every row", () => {
    const { host } = setup({}, ["b", "c", "d", "e", "f"]);
    layOut(host, 0);
    const hint = host.querySelector<HTMLButtonElement>(".ins-more button");
    expect(hint?.getAttribute("aria-hidden")).toBe("true");
    expect(hint?.tabIndex).toBe(-1);
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".ins-scroll li button")];
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.tabIndex).toBe(0);
  });

  it("scrolls on by most of a page when the hint is clicked", () => {
    const { host } = setup({}, ["b", "c", "d", "e", "f"]);
    const scroller = scrollerOf(host) as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
    layOut(host, 0);
    act(() => host.querySelector<HTMLButtonElement>(".ins-more button")?.click());
    expect(scroller.scrollTop).toBe(80);
  });

  it("leaves focus where it was when the hint is pressed", () => {
    const { host } = setup({}, ["b", "c", "d", "e", "f"]);
    const scroller = scrollerOf(host) as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
    layOut(host, 0);
    const row = host.querySelector<HTMLButtonElement>(".ins-scroll li button") as HTMLElement;
    row.focus();
    const hint = host.querySelector<HTMLButtonElement>(".ins-more button") as HTMLElement;
    // Browsers move focus to a pressed button as the default action of its mousedown; jsdom
    // does not, so check that the default is cancelled.
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      hint.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
    act(() => hint.click());
    expect(scroller.scrollTop).toBe(80);
    expect(document.activeElement).toBe(row);
  });

  it("starts a newly selected note's links at the top", () => {
    const { host, rerender } = setup({}, ["b", "c", "d"]);
    const scroller = scrollerOf(host) as HTMLElement;
    scroller.scrollTop = 120;
    rerender({ node: node("b") });
    expect(scroller.scrollTop).toBe(0);
  });

  it("says a note's status only when it is not active", () => {
    const { host, rerender } = setup();
    expect(host.querySelector(".ins-meta .k-pill")).toBeNull();
    rerender({ node: { ...node("a"), status: "legacy" } });
    expect(host.querySelector(".ins-meta .k-pill")?.textContent).toBe("legacy");
  });
});
