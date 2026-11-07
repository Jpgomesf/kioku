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
    expect(s.filters).toEqual({ query: "", legacy: true, suggested: true, orphans: true });
    expect(s.display).toEqual({
      arrows: false,
      textFade: 0,
      nodeSize: 1,
      linkThickness: 1,
      topicLabels: true,
    });
    expect(s.forces).toEqual(DEFAULT_FORCES);
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
  it("starts closed with every section open, and remembers changes", () => {
    const h = renderHook(() => usePanelState());
    expect(h.current()[0]).toEqual({
      open: false,
      sections: { filters: true, groups: true, display: true, forces: true },
    });
    const next: PanelState = {
      open: true,
      sections: { ...h.current()[0].sections, forces: false },
    };
    act(() => h.current()[1](next));
    const again = renderHook(() => usePanelState());
    expect(again.current()[0]).toEqual(next);
  });
});
