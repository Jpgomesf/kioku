import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assignSlot,
  type ColourSlots,
  colourFor,
  DEFAULT_SLOTS,
  readSlots,
  writeSlots,
} from "./colours";

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

afterEach(() => vi.unstubAllGlobals());

describe("colour slots", () => {
  it("colours decisions and questions by default", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readSlots("demo")).toEqual(["decision", "question", null]);
    expect(colourFor(DEFAULT_SLOTS, "decision")).toBe("var(--type-1)");
    expect(colourFor(DEFAULT_SLOTS, "question")).toBe("var(--type-2)");
    expect(colourFor(DEFAULT_SLOTS, "runbook")).toBe("var(--type-other)");
    expect(colourFor(DEFAULT_SLOTS, "topic")).toBe("var(--type-topic)");
  });

  it("assigns, moves and clears a type, and never colours topics", () => {
    const a = assignSlot(DEFAULT_SLOTS, 2, "runbook");
    expect(a).toEqual(["decision", "question", "runbook"]);
    expect(colourFor(a, "runbook")).toBe("var(--type-3)");
    const moved = assignSlot(a, 0, "question");
    expect(moved).toEqual(["question", null, "runbook"]);
    expect(assignSlot(moved, 2, null)).toEqual(["question", null, null]);
    expect(assignSlot(moved, 1, "topic")).toBe(moved);
  });

  it("holds at most three types", () => {
    let s: ColourSlots = DEFAULT_SLOTS;
    for (const k of ["runbook", "document", "design-review"]) s = assignSlot(s, 2, k);
    expect(s).toHaveLength(3);
    expect(s.filter((k) => k !== null)).toEqual(["decision", "question", "design-review"]);
    expect(assignSlot(s, 5, "fix")).toEqual(s);
  });

  it("saves the picks per area", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    writeSlots("demo", ["runbook", null, "document"]);
    expect(readSlots("demo")).toEqual(["runbook", null, "document"]);
    expect(readSlots("work")).toEqual(DEFAULT_SLOTS);
    expect(localStorage.getItem("kioku.viewer.graph.colours.demo")).toBe(
      '["runbook",null,"document"]',
    );
  });

  it("falls back to the default on junk in storage", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    for (const junk of [
      "not json",
      "{}",
      '["decision","question"]',
      '["decision","decision",null]',
      '["topic",null,null]',
      '["Decision",null,null]',
      "[1,null,null]",
      '["a","b","c","d"]',
    ]) {
      storage.setItem("kioku.viewer.graph.colours.demo", junk);
      expect(readSlots("demo")).toEqual(DEFAULT_SLOTS);
    }
  });

  it("works when storage throws", () => {
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new Error("blocked");
    };
    broken.setItem = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", broken);
    expect(readSlots("demo")).toEqual(DEFAULT_SLOTS);
    expect(() => writeSlots("demo", ["runbook", null, null])).not.toThrow();
  });
});
