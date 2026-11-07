import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/reflect/client", () => ({
  listReflectRuns: vi.fn(),
  getReflectSettings: vi.fn(),
  startReflect: vi.fn(),
  saveReflectSettings: vi.fn(),
  dismissFinding: vi.fn(),
}));
vi.mock("../../api/app/client", () => ({
  getAppInfo: vi.fn(),
  checkForUpdates: vi.fn(),
  listReleaseNotes: vi.fn(),
}));
vi.mock("../../api/notes/client", () => ({
  listAreas: vi.fn(),
  listVaults: vi.fn(),
  listNotes: vi.fn(),
  getNote: vi.fn(),
}));

import type { ReflectRun, ReflectSettings } from "../../api";
import * as app from "../../api/app/client";
import { commandError } from "../../api/core";
import * as notes from "../../api/notes/client";
import * as reflect from "../../api/reflect/client";
import { setCurrentArea } from "../../app/area";
import { ToastHost } from "../../components/ui";
import { ReflectPage } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

const settings: ReflectSettings = {
  mode: "automatic",
  harnesses: [
    {
      id: "a",
      name: "Alpha",
      provider: "P",
      vaultsReadable: ["personal"],
      status: "ready",
    },
    { id: "b", name: "Beta", provider: "Q", vaultsReadable: ["personal"], status: "ready" },
  ],
  roles: { worker: "a", reviewer: "b", report: "a" },
  triggers: { afterImport: true, nightlyAt: null, afterSaves: { threshold: 25, soFar: 5 } },
  permission: "report-only",
};

const kiokuRun: ReflectRun = {
  id: "r1",
  domain: "personal/kioku",
  startedAt: "2026-11-05T10:00:00Z",
  finishedAt: "2026-11-05T10:05:00Z",
  harness: "a",
  findings: [
    { id: "f1", state: "confirmed", text: "First finding", noteKeys: ["n1"] },
    { id: "f2", state: "confirmed", text: "Second finding", noteKeys: ["n2"] },
  ],
};

let host: HTMLDivElement;
let root: Root;

function text(): string {
  return host.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

beforeEach(() => {
  setCurrentArea("personal/kioku");
  vi.mocked(reflect.getReflectSettings).mockResolvedValue(structuredClone(settings));
  vi.mocked(reflect.listReflectRuns).mockImplementation(async (domain) =>
    domain === "personal/kioku" ? [structuredClone(kiokuRun)] : [],
  );
  vi.mocked(reflect.saveReflectSettings).mockResolvedValue(undefined);
  vi.mocked(reflect.dismissFinding).mockResolvedValue(undefined);
  vi.mocked(notes.listAreas).mockResolvedValue([]);
  vi.mocked(app.getAppInfo).mockResolvedValue({
    version: "0.1.0",
    channel: "stable",
    readOnly: false,
    canAuthenticate: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("ReflectPage", () => {
  it("shows a retry when settings fail to load", async () => {
    vi.mocked(reflect.getReflectSettings).mockRejectedValueOnce(
      commandError("unavailable", "Kioku isn't answering."),
    );
    act(() => root.render(<ReflectPage />));
    await settle();
    expect(text()).toContain("Kioku isn't answering.");
    expect(host.querySelector("section")?.getAttribute("aria-busy")).toBe("false");
    act(() => button("Try again").click());
    await settle();
    expect(text()).toContain("First finding");
  });

  it("keeps the mode viewable when a save is read-only, and says so once", async () => {
    vi.mocked(reflect.saveReflectSettings).mockRejectedValue(
      commandError("read_only", "Changes are read-only in this build."),
    );
    act(() => root.render(<ReflectPage />));
    await settle();
    act(() => button("Manual").click());
    await settle();
    expect(text()).toContain("Changes are read-only in this build.");
    expect(text()).toContain("Run it yourself");
    act(() => button("Automatic").click());
    await settle();
    expect(text()).toContain("When it runs");
    expect(reflect.saveReflectSettings).toHaveBeenCalledTimes(1);
  });

  it("disables Dismiss and Run now in a read-only build", async () => {
    vi.mocked(app.getAppInfo).mockResolvedValue({
      version: "0.1.0",
      channel: "stable",
      readOnly: true,
      canAuthenticate: false,
    });
    act(() => root.render(<ReflectPage />));
    await settle();
    expect(text()).toContain("Changes are read-only in this build.");
    expect(button("Dismiss").disabled).toBe(true);
    expect(button("Run now on kioku").disabled).toBe(true);
    act(() => button("Manual").click());
    await settle();
    expect(text()).toContain("Run it yourself");
    expect(reflect.saveReflectSettings).not.toHaveBeenCalled();
  });

  it("brings a finding back when dismissing it is read-only", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(reflect.dismissFinding).mockRejectedValue(
      commandError("read_only", "Changes are read-only in this build."),
    );
    act(() =>
      root.render(
        <>
          <ReflectPage />
          <ToastHost />
        </>,
      ),
    );
    await settle();
    act(() => button("Dismiss").click());
    expect(text()).not.toContain("First finding");
    await act(async () => {
      vi.advanceTimersByTime(6100);
    });
    await settle();
    expect(reflect.dismissFinding).toHaveBeenCalledTimes(1);
    expect(text()).toContain("First finding");
    vi.useRealTimers();
  });

  it("says Run now is read-only instead of failing with a toast", async () => {
    vi.mocked(reflect.startReflect).mockRejectedValue(
      commandError("read_only", "Changes are read-only in this build."),
    );
    act(() =>
      root.render(
        <>
          <ReflectPage />
          <ToastHost />
        </>,
      ),
    );
    await settle();
    act(() => button("Run now on kioku").click());
    await settle();
    expect(text()).toContain("Changes are read-only in this build.");
    expect(button("Run now on kioku").disabled).toBe(true);
  });

  it("opens the area and finding a link names", async () => {
    setCurrentArea("demo");
    act(() => root.render(<ReflectPage domain="personal/kioku" finding="f2" />));
    await settle();
    expect(text()).toContain("Second finding");
    expect(host.querySelector('[aria-current="true"]')?.textContent).toContain("Second finding");
  });

  it("does not show another area's runs after a switch mid-run", async () => {
    vi.mocked(reflect.startReflect).mockResolvedValue({
      ...kiokuRun,
      id: "r2",
      finishedAt: null,
      findings: [],
    });
    act(() => root.render(<ReflectPage />));
    await settle();
    act(() => button("Run now on kioku").click());
    await settle();
    act(() => setCurrentArea("demo"));
    await settle();
    expect(text()).toContain("No run in this area yet.");
    expect(text()).not.toContain("First finding");
    expect(button("Run now on demo").disabled).toBe(false);
  });

  it("batches dismissals into one Undo that restores all and closes the toast", async () => {
    act(() =>
      root.render(
        <>
          <ReflectPage />
          <ToastHost />
        </>,
      ),
    );
    await settle();
    act(() => button("Dismiss").click());
    expect(document.activeElement?.textContent).toBe("Dismiss");
    act(() => button("Dismiss").click());
    expect(text()).toContain("Dismissed 2 findings.");
    expect(text()).not.toContain("First finding");
    act(() => button("Undo").click());
    expect(text()).toContain("First finding");
    expect(text()).toContain("Second finding");
    expect(text()).not.toContain("Undo");
    expect(reflect.dismissFinding).not.toHaveBeenCalled();
  });
});
