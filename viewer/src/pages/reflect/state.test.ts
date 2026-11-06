import { describe, expect, it } from "vitest";
import type { ReflectSettings } from "../../api";
import {
  areaLabel,
  canRun,
  formatDay,
  harnessDetail,
  initialSelection,
  isRunning,
  isStalled,
  newestRun,
  nextRunText,
  openFindings,
  parseThreshold,
  reachText,
  roleProblems,
  sameAppWarning,
  selectedHarnesses,
  setAfterImport,
  setAfterSavesOn,
  setMode,
  setNightly,
  setPermission,
  setRole,
  setThreshold,
  toggleHarness,
} from "./state";

const base: ReflectSettings = {
  mode: "automatic",
  harnesses: [
    { id: "a", name: "A", provider: "P", vaultsReadable: ["personal", "work"], status: "ready" },
    { id: "b", name: "B", provider: "Q", vaultsReadable: ["work"], status: "needs-skill" },
    { id: "c", name: "C", provider: "R", vaultsReadable: [], status: "not-connected" },
  ],
  roles: { worker: "a", reviewer: "b", report: "a" },
  triggers: { afterImport: true, nightlyAt: "02:00", afterSaves: { threshold: 25, soFar: 5 } },
  permission: "report-only",
};

describe("reflect settings state", () => {
  it("selects ready harnesses and those holding a role", () => {
    expect(initialSelection(base)).toEqual(["a", "b"]);
  });

  it("moves a role off a harness that is unselected", () => {
    const next = toggleHarness(base, ["a", "b"], "b");
    expect(next.selected).toEqual(["a"]);
    expect(next.settings.roles.reviewer).toBe("a");
    expect(selectedHarnesses(next.settings, next.selected).map((h) => h.id)).toEqual(["a"]);
  });

  it("keeps settings order when reselecting", () => {
    expect(toggleHarness(base, ["b"], "a").selected).toEqual(["a", "b"]);
  });

  it("clamps the threshold and ignores bad input", () => {
    expect(setThreshold(base, "0").triggers.afterSaves?.threshold).toBe(1);
    expect(setThreshold(base, "40").triggers.afterSaves?.threshold).toBe(40);
    expect(setThreshold(base, "")).toBe(base);
    const off = setAfterSavesOn(base, false, null);
    expect(off.triggers.afterSaves).toBeNull();
    expect(setThreshold(off, "10")).toBe(off);
  });

  it("does not mutate the input", () => {
    setNightly(base, false);
    expect(base.triggers.nightlyAt).toBe("02:00");
  });

  it("describes the next run", () => {
    expect(nextRunText(setMode(base, "manual"))).toBe(
      "Only when you run the command or press Run now.",
    );
    expect(nextRunText(base)).toBe(
      "After the next KB import, once 20 more notes change, or tonight at 02:00.",
    );
    const none = setNightly(
      setAfterSavesOn({ ...base, triggers: { ...base.triggers, afterImport: false } }, false, null),
      false,
    );
    expect(nextRunText(none)).toMatch(/No trigger is on/);
  });

  it("describes what a harness can read", () => {
    expect(base.harnesses.map(harnessDetail)).toEqual([
      "P · can read personal and work",
      "Q · can read work only",
      "R · not connected to Kioku",
    ]);
  });

  it("keeps the reviewer off the worker when another app is selected", () => {
    const three: ReflectSettings = {
      ...base,
      harnesses: ["a", "b", "d"].map((id) => ({
        id,
        name: id.toUpperCase(),
        provider: "P",
        vaultsReadable: ["work"],
        status: "ready" as const,
      })),
      roles: { worker: "a", reviewer: "b", report: "a" },
    };
    const next = toggleHarness(three, ["a", "b", "d"], "b");
    expect(next.settings.roles).toEqual({ worker: "a", reviewer: "d", report: "a" });
    expect(sameAppWarning(next.settings)).toBeNull();
  });

  it("warns when one app both checks and disproves", () => {
    const next = toggleHarness(base, ["a", "b"], "b");
    expect(next.settings.roles).toEqual({ worker: "a", reviewer: "a", report: "a" });
    expect(sameAppWarning(next.settings)).toBe(
      "A would check its own findings. Pick a different app to disprove them.",
    );
    expect(sameAppWarning(base)).toBeNull();
  });

  it("leaves roles alone when the last harness is unselected", () => {
    const next = toggleHarness(base, ["a"], "a");
    expect(next.selected).toEqual([]);
    expect(next.settings.roles).toEqual(base.roles);
  });

  it("sets a role, the permission and the import trigger", () => {
    expect(setRole(base, "report", "b").roles.report).toBe("b");
    expect(setPermission(base, "propose-fixes").permission).toBe("propose-fixes");
    expect(setAfterImport(base, false).triggers.afterImport).toBe(false);
  });

  it("restores the threshold and counter when turned back on", () => {
    const custom = setThreshold(base, "40");
    const off = setAfterSavesOn(custom, false, custom.triggers.afterSaves);
    const on = setAfterSavesOn(off, true, custom.triggers.afterSaves);
    expect(on.triggers.afterSaves).toEqual({ threshold: 40, soFar: 5 });
  });

  it("parses whole numbers only", () => {
    expect(parseThreshold("1e3")).toBe(1000);
    expect(parseThreshold("2.9")).toBeNull();
    expect(parseThreshold("")).toBeNull();
    expect(parseThreshold("99999")).toBe(10_000);
  });

  it("says the next note change once the threshold is reached", () => {
    const reached = setThreshold(base, "3");
    expect(nextRunText(reached)).toBe(
      "After the next KB import, at the next note change, or tonight at 02:00.",
    );
  });

  it("lists three vaults", () => {
    const h = {
      id: "x",
      name: "X",
      provider: "P",
      vaultsReadable: ["a", "b", "c"],
      status: "ready" as const,
    };
    expect(harnessDetail(h)).toBe("P · can read a, b and c");
  });

  it("says when a role holder can't read the area or needs the skill", () => {
    expect(roleProblems(base, "personal")).toEqual([
      "B needs the reflect skill first.",
      "B can't read personal, so it can't check this area.",
    ]);
    expect(canRun(base, "personal")).toBe(false);
    expect(
      canRun({ ...base, roles: { worker: "a", reviewer: "a", report: "a" } }, "personal"),
    ).toBe(true);
  });

  it("explains a reviewer that reads fewer vaults", () => {
    expect(reachText(base)).toBe("B only checks work, the vault Q may read.");
  });

  it("formats days and area labels", () => {
    const now = new Date("2026-11-06T12:00:00");
    expect(formatDay("2026-11-05T12:00:00", now)).toBe("5 Nov");
    expect(formatDay("2025-11-05T12:00:00", now)).toBe("5 Nov 2025");
    expect(areaLabel("personal/kioku")).toBe("kioku");
    expect(areaLabel("demo")).toBe("demo");
  });

  it("merges open findings across finished runs", () => {
    const f = (id: string) => ({ id, state: "confirmed" as const, text: id, noteKeys: [] });
    const run = (id: string, startedAt: string, findings: ReturnType<typeof f>[], done = true) => ({
      id,
      domain: "d",
      startedAt,
      finishedAt: done ? startedAt : null,
      harness: "a",
      findings,
    });
    const open = openFindings([
      run("old", "2026-11-01", [f("x"), f("y")]),
      run("new", "2026-11-05", []),
      run("mid", "2026-11-03", [f("x")]),
      run("live", "2026-11-06", [f("z")], false),
    ]);
    expect(open.map((o) => `${o.run.id}/${o.finding.id}`)).toEqual(["mid/x", "old/y"]);
  });

  it("judges running and stalled by the newest run only", () => {
    const run = (id: string, startedAt: string, done: boolean) => ({
      id,
      domain: "d",
      startedAt,
      finishedAt: done ? startedAt : null,
      harness: "a",
      findings: [],
    });
    const now = Date.parse("2026-11-05T12:00:00Z");
    const crashed = run("crashed", "2026-10-01T10:00:00Z", false);
    const newest = newestRun([crashed, run("done", "2026-11-05T10:00:00Z", true)]);
    expect(newest?.id).toBe("done");
    expect(newest && isStalled(newest, now)).toBe(false);
    const abandoned = run("abandoned", "2026-11-05T11:55:00Z", false);
    const later = newestRun([abandoned, run("done", "2026-11-05T11:58:00Z", true)]);
    expect(later && isRunning(later, now)).toBe(false);
    expect(newestRun([])).toBeNull();
  });
});
