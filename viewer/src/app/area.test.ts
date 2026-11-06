import { describe, expect, it, vi } from "vitest";

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

describe("area store", () => {
  it("switches the area and remembers it", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
    const { getCurrentArea, setCurrentArea } = await import("./area");
    expect(getCurrentArea()).toBe("personal/kioku");
    setCurrentArea("demo");
    expect(getCurrentArea()).toBe("demo");
    expect(storage.getItem("kioku.viewer.area")).toBe("demo");
    setCurrentArea("local");
    setCurrentArea("demo");
    expect(JSON.parse(storage.getItem("kioku.viewer.recentAreas") ?? "[]")).toEqual([
      "demo",
      "local",
    ]);
    vi.unstubAllGlobals();
  });
  it("still works when storage is blocked", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const { getCurrentArea, setCurrentArea } = await import("./area");
    setCurrentArea("local");
    expect(getCurrentArea()).toBe("local");
    vi.unstubAllGlobals();
  });
});

describe("reconcileAreas", () => {
  it("replaces an area that doesn't exist and drops unknown recents", async () => {
    const storage = memoryStorage();
    storage.setItem("kioku.viewer.area", "gone/area");
    storage.setItem("kioku.viewer.recentAreas", JSON.stringify(["gone/area", "demo"]));
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
    const { getCurrentArea, reconcileAreas } = await import("./area");
    const known = [
      { domain: "demo", noteCount: 300 },
      { domain: "local", noteCount: 2 },
    ];
    reconcileAreas(known, ["local"]);
    expect(getCurrentArea()).toBe("local");
    expect(storage.getItem("kioku.viewer.recentAreas")).toBe(JSON.stringify(["demo"]));
    storage.setItem("kioku.viewer.area", "gone/area");
    vi.resetModules();
    const again = await import("./area");
    again.reconcileAreas(known);
    expect(again.getCurrentArea()).toBe("demo");
  });

  it("keeps a listed area", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.resetModules();
    const { getCurrentArea, reconcileAreas } = await import("./area");
    reconcileAreas([{ domain: "personal/kioku", noteCount: 4 }]);
    expect(getCurrentArea()).toBe("personal/kioku");
  });
});
