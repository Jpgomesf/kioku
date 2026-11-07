import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KindCount } from "../../api";
import { DEFAULT_FORCES } from "./forces";
import { paletteColour } from "./palette";
import {
  defaultSettings,
  type GraphSettings,
  type PanelState,
  toHighlightDepth,
  useGraphSettings,
  usePanelState,
  validateSettings,
} from "./settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const types: KindCount[] = [
  { kind: "question", count: 2 },
  { kind: "decision", count: 9 },
];

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
});

let probeValue: unknown;
function Probe({ use }: { use: () => unknown }) {
  probeValue = use();
  return null;
}

function renderHook<T>(hook: () => T): { current: () => T; rerender: (h: () => T) => void } {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(<Probe use={hook} />));
  return {
    current: () => probeValue as T,
    rerender: (h) => act(() => root.render(<Probe use={h} />)),
  };
}

describe("defaultSettings", () => {
  it("gives one group per type, most common first, and Obsidian's defaults", () => {
    const s = defaultSettings(types);
    expect(s.groups.map((g) => g.query)).toEqual(["type:decision", "type:question"]);
    expect(s.groups[0]?.color).toBe(paletteColour(0));
    expect(s.filters).toEqual({
      query: "",
      tags: false,
      legacy: true,
      suggested: true,
      orphans: true,
    });
    expect(s.display).toEqual({
      arrows: false,
      textFade: 0,
      nodeSize: 1,
      linkThickness: 1,
      topicLabels: true,
      highlightDepth: 1,
      regionLabels: true,
    });
    expect(s.forces).toEqual(DEFAULT_FORCES);
  });

  it("separates by brain region and colours by group", () => {
    expect(defaultSettings(types).clusters).toEqual({ separateBy: "regions", colourBy: "groups" });
  });
});

describe("toHighlightDepth", () => {
  it("keeps a whole number of links from 1 to 3", () => {
    expect(toHighlightDepth(2, 1)).toBe(2);
    expect(toHighlightDepth(2.6, 1)).toBe(3);
    expect(toHighlightDepth(0, 2)).toBe(1);
    expect(toHighlightDepth(99, 1)).toBe(3);
    expect(toHighlightDepth("2", 3)).toBe(3);
    expect(toHighlightDepth(Number.NaN, 2)).toBe(2);
  });
});

describe("validateSettings", () => {
  const base = defaultSettings(types);
  it("replaces junk with the fallback and clamps numbers", () => {
    expect(validateSettings("junk", base)).toEqual(base);
    const v = validateSettings(
      {
        filters: { query: 5, legacy: false },
        display: { nodeSize: 99, textFade: "x" },
        forces: { repel: -4 },
        groups: [
          { id: "a", query: "x", color: "#ABCDEF" },
          { id: "a", query: "dup", color: "#000000" },
          { id: "b", query: "y", color: "red" },
        ],
      },
      base,
    );
    expect(v.filters.legacy).toBe(false);
    expect(v.filters.query).toBe("");
    // Saved before the tags switch existed: it takes the default.
    expect(v.filters.tags).toBe(false);
    expect(v.display.nodeSize).toBe(5);
    expect(v.display.textFade).toBe(0);
    expect(v.forces.repel).toBe(0);
    expect(v.groups).toEqual([{ id: "a", query: "x", color: "#abcdef" }]);
  });

  it("keeps at most 100 groups", () => {
    const groups = Array.from({ length: 150 }, (_, i) => ({
      id: `g${i}`,
      query: "",
      color: "#000000",
    }));
    expect(validateSettings({ groups }, base).groups).toHaveLength(100);
  });

  it("checks the clusters, the highlight depth and the region labels", () => {
    const v = validateSettings(
      {
        clusters: { separateBy: "groups", colourBy: "regions" },
        display: { highlightDepth: 3, regionLabels: false },
      },
      base,
    );
    expect(v.clusters).toEqual({ separateBy: "groups", colourBy: "regions" });
    expect(v.display.highlightDepth).toBe(3);
    expect(v.display.regionLabels).toBe(false);

    const junk = validateSettings(
      {
        clusters: { separateBy: "everything", colourBy: 7 },
        display: { highlightDepth: 2.4, regionLabels: "yes" },
      },
      base,
    );
    expect(junk.clusters).toEqual(base.clusters);
    expect(junk.display.highlightDepth).toBe(2);
    expect(junk.display.regionLabels).toBe(true);
    expect(validateSettings({ clusters: "none" }, base).clusters).toEqual(base.clusters);
  });

  it("loads settings saved before the clusters, depth and region labels existed", () => {
    const earlier = {
      filters: {
        query: "type:decision",
        tags: true,
        legacy: false,
        suggested: true,
        orphans: false,
      },
      groups: [{ id: "g", query: "type:decision", color: "#123456" }],
      display: { arrows: true, textFade: 1, nodeSize: 2, linkThickness: 0.5, topicLabels: false },
      forces: { center: 0.3, repel: 12, link: 0.8, distance: 120 },
    };
    const v = validateSettings(earlier, base);
    // What was saved is kept...
    expect(v.filters).toEqual(earlier.filters);
    expect(v.groups).toEqual(earlier.groups);
    expect(v.display).toMatchObject(earlier.display);
    expect(v.forces).toMatchObject(earlier.forces);
    // ...and what is new takes its default.
    expect(v.display.highlightDepth).toBe(1);
    expect(v.display.regionLabels).toBe(true);
    expect(v.forces.separation).toBe(DEFAULT_FORCES.separation);
    expect(v.clusters).toEqual(base.clusters);
  });
});

describe("useGraphSettings", () => {
  it("builds defaults once types load, then saves edits per area", () => {
    const h = renderHook(() => useGraphSettings("one", null));
    expect(h.current().settings.groups).toEqual([]);
    h.rerender(() => useGraphSettings("one", types));
    expect(h.current().settings.groups).toHaveLength(2);

    const edited: GraphSettings = { ...h.current().settings, groups: [] };
    act(() => h.current().update(edited));
    expect(h.current().settings.groups).toEqual([]);

    h.rerender(() => useGraphSettings("two", types));
    expect(h.current().settings.groups).toHaveLength(2);

    h.rerender(() => useGraphSettings("one", types));
    expect(h.current().settings.groups).toEqual([]);

    act(() => h.current().reset());
    expect(h.current().settings.groups).toHaveLength(2);
    expect(localStorage.getItem("kioku.viewer.graph.settings.one")).toBeNull();
  });

  it("keeps default groups following the types after an unrelated edit", () => {
    const h = renderHook(() => useGraphSettings("one", null));
    act(() =>
      h.current().update({
        ...h.current().settings,
        forces: { ...DEFAULT_FORCES, repel: 15 },
      }),
    );
    h.rerender(() => useGraphSettings("one", types));
    expect(h.current().settings.groups).toHaveLength(2);
    expect(h.current().settings.forces.repel).toBe(15);
    const stored = JSON.parse(localStorage.getItem("kioku.viewer.graph.settings.one") ?? "{}");
    expect(stored.groups).toBeUndefined();
  });

  it("keeps the same groups array when only forces change after a group edit", () => {
    const h = renderHook(() => useGraphSettings("one", types));
    const edited = h
      .current()
      .settings.groups.map((g, i) => (i === 0 ? { ...g, color: "#123456" } : g));
    act(() => h.current().update({ ...h.current().settings, groups: edited }));
    const groups = h.current().settings.groups;
    act(() =>
      h.current().update({
        ...h.current().settings,
        forces: { ...DEFAULT_FORCES, repel: 3 },
      }),
    );
    expect(h.current().settings.forces.repel).toBe(3);
    expect(h.current().settings.groups).toBe(groups);
  });

  it("saves the clusters and the new display settings with the default groups left out", () => {
    const h = renderHook(() => useGraphSettings("one", types));
    const s = h.current().settings;
    act(() =>
      h.current().update({
        ...s,
        clusters: { separateBy: "groups", colourBy: "regions" },
        display: { ...s.display, highlightDepth: 2, regionLabels: false },
      }),
    );
    const stored = JSON.parse(localStorage.getItem("kioku.viewer.graph.settings.one") ?? "{}");
    expect(stored.groups).toBeUndefined();
    expect(stored.clusters).toEqual({ separateBy: "groups", colourBy: "regions" });
    expect(stored.display.highlightDepth).toBe(2);

    // A fresh page reads them back.
    const again = renderHook(() => useGraphSettings("one", types));
    expect(again.current().settings.clusters).toEqual({
      separateBy: "groups",
      colourBy: "regions",
    });
    expect(again.current().settings.display.regionLabels).toBe(false);
  });

  it("survives junk storage", () => {
    localStorage.setItem("kioku.viewer.graph.settings.one", "{not json");
    const h = renderHook(() => useGraphSettings("one", types));
    expect(h.current().settings).toEqual(defaultSettings(types));
  });

  it("works when storage throws", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
    const h = renderHook(() => useGraphSettings("one", types));
    act(() => h.current().update({ ...h.current().settings, groups: [] }));
    expect(h.current().settings.groups).toEqual([]);
  });
});

describe("usePanelState", () => {
  // Only Forces open, so the box fits the window and the forces are the first thing in it.
  const defaultPanel: PanelState = {
    open: true,
    sections: { filters: false, groups: false, display: false, forces: true },
  };

  it("starts open with only Forces open, and remembers changes", () => {
    const h = renderHook(() => usePanelState());
    expect(h.current()[0]).toEqual(defaultPanel);
    const next: PanelState = {
      open: false,
      sections: { ...h.current()[0].sections, display: true, forces: false },
    };
    act(() => h.current()[1](next));
    const again = renderHook(() => usePanelState());
    expect(again.current()[0]).toEqual(next);
  });

  it("starts a first-version save from the defaults once, then keeps what is saved", () => {
    // Saved by the first version, which had no version field, started closed and opened every section.
    localStorage.setItem(
      "kioku.viewer.graph.panel",
      JSON.stringify({
        open: false,
        sections: { filters: true, groups: true, display: true, forces: false },
      }),
    );
    const h = renderHook(() => usePanelState());
    expect(h.current()[0]).toEqual(defaultPanel);
    // Any change saves this version, so later loads keep the viewer's own layout.
    const next: PanelState = {
      ...defaultPanel,
      sections: { ...defaultPanel.sections, groups: true },
    };
    act(() => h.current()[1](next));
    expect(JSON.parse(localStorage.getItem("kioku.viewer.graph.panel") ?? "{}").version).toBe(2);
    expect(renderHook(() => usePanelState()).current()[0]).toEqual(next);
  });

  it("survives junk storage", () => {
    localStorage.setItem("kioku.viewer.graph.panel", "[1, 2");
    const h = renderHook(() => usePanelState());
    expect(h.current()[0].open).toBe(true);
  });
});
