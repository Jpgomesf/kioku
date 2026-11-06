import { describe, expect, it } from "vitest";
import {
  dismissFinding,
  getReflectSettings,
  listReflectRuns,
  saveReflectSettings,
  startReflect,
} from "./mock";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return undefined;
}

describe("reflect mock", () => {
  it("answers writes with read_only, like the desktop app", () => {
    const run = listReflectRuns("personal/kioku")[0];
    expect(run).toBeDefined();
    expect(codeOf(() => startReflect("personal/kioku"))).toBe("read_only");
    expect(codeOf(() => saveReflectSettings(getReflectSettings()))).toBe("read_only");
    expect(codeOf(() => dismissFinding(run?.id ?? "", "f1"))).toBe("read_only");
    expect(listReflectRuns("personal/kioku")[0]?.findings.some((f) => f.id === "f1")).toBe(true);
  });
});
