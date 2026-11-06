import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDay, formatDayTime } from "./dates";

describe("dates", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps date-only strings on their calendar day", () => {
    const now = new Date(2026, 10, 6);
    expect(formatDay("2026-11-04", now)).toBe("4 Nov");
    expect(formatDay("2025-11-04", now)).toBe("4 Nov 2025");
    expect(formatDayTime("2026-11-04", now)).toBe("4 Nov");
  });

  it("shows timestamps in local time", () => {
    const now = new Date(2026, 10, 6);
    const at = new Date(2026, 10, 5, 18, 2).toISOString();
    expect(formatDay(at, now)).toBe("5 Nov");
    expect(formatDayTime(at, now)).toBe("5 Nov 18:02");
  });

  it("returns what doesn't parse", () => {
    expect(formatDay("soon")).toBe("soon");
    expect(formatDay("2026-13-01")).toBe("2026-13-01");
  });
});
