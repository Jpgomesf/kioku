import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/app/mock", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/app/mock")>();
  return {
    getAppInfo: vi.fn(real.getAppInfo),
    checkForUpdates: vi.fn(real.checkForUpdates),
    listReleaseNotes: vi.fn(real.listReleaseNotes),
  };
});

import { commandError } from "../../api";
import * as mock from "../../api/app/mock";
import { describeUpdate, GuidePage, resolveSection } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.mocked(mock.getAppInfo).mockReset();
  vi.mocked(mock.listReleaseNotes).mockReset();
  vi.mocked(mock.checkForUpdates).mockReset();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(section: string) {
  await act(async () => {
    root.render(<GuidePage section={section} />);
  });
  await flush();
}

async function clickCheck() {
  await act(async () => checkButton().click());
  await flush();
}

function fail(message: string, code: "unavailable" | "not_implemented" = "unavailable"): never {
  throw commandError(code, message);
}

function checkButton(): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Check for updates"),
  );
  if (button === undefined) throw new Error("no check button");
  return button;
}

describe("resolveSection", () => {
  it("falls back to getting started", () => {
    expect(resolveSection(null)).toBe("getting-started");
    expect(resolveSection("nope")).toBe("getting-started");
    expect(resolveSection("updates")).toBe("updates");
  });
});

describe("describeUpdate", () => {
  const base = { configured: true, current: "0.1.0", checkedAt: null };
  it("covers not set up, available and up to date", () => {
    expect(describeUpdate({ ...base, latest: null, available: false }).text).toBe(
      "Updates aren't set up yet.",
    );
    expect(describeUpdate({ ...base, latest: "0.2.0", available: true })).toEqual({
      tone: "finding",
      text: "Version 0.2.0 is available.",
    });
    expect(describeUpdate({ ...base, latest: "0.1.0", available: false }).tone).toBe("active");
  });
});

describe("What's new", () => {
  it("renders releases with the current version marked", async () => {
    vi.mocked(mock.getAppInfo).mockReturnValue({
      version: "0.1.0",
      channel: "stable",
      readOnly: true,
      canAuthenticate: false,
    });
    vi.mocked(mock.listReleaseNotes).mockReturnValue([
      { version: "0.1.0", date: null, title: "First build.", changes: ["A", "A"] },
    ]);
    await render("whats-new");
    await vi.waitFor(() => expect(host.querySelector('[id="release-0.1.0"]')).not.toBeNull());
    const heading = host.querySelector('[id="release-0.1.0"]');
    expect(heading?.textContent).toContain("v0.1.0");
    expect(heading?.textContent).toContain("You're on this version");
    expect(heading?.textContent).not.toContain("First build.");
    expect(host.querySelector("time")).toBeNull();
    expect(host.querySelectorAll(".k-bullets li")).toHaveLength(1);
  });

  it("shows the command error's message", async () => {
    vi.mocked(mock.getAppInfo).mockReturnValue({
      version: "0.1.0",
      channel: "stable",
      readOnly: true,
      canAuthenticate: false,
    });
    vi.mocked(mock.listReleaseNotes).mockImplementation(() => fail("database offline"));
    await render("whats-new");
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("database offline");
    expect(host.textContent).not.toContain("[object Object]");
  });

  it("says when there are no notes", async () => {
    vi.mocked(mock.getAppInfo).mockReturnValue({
      version: "0.1.0",
      channel: "stable",
      readOnly: true,
      canAuthenticate: false,
    });
    vi.mocked(mock.listReleaseNotes).mockReturnValue([]);
    await render("whats-new");
    expect(host.textContent).toContain("No release notes yet.");
  });
});

describe("Updates", () => {
  it("shows the version and a check result", async () => {
    vi.mocked(mock.getAppInfo).mockReturnValue({
      version: "0.1.0",
      channel: "beta",
      readOnly: true,
      canAuthenticate: false,
    });
    vi.mocked(mock.checkForUpdates).mockReturnValue({
      configured: true,
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      checkedAt: null,
    });
    await render("updates");
    expect(host.textContent).toContain("Beta");
    await clickCheck();
    expect(host.textContent).toContain("Version 0.2.0 is available.");
  });

  it("shows errors as text and treats not_implemented as not set up", async () => {
    vi.mocked(mock.getAppInfo).mockImplementation(() => fail("database offline"));
    vi.mocked(mock.checkForUpdates).mockImplementation(() => fail("no network"));
    await render("updates");
    expect(host.textContent).toContain("Couldn't read the app version. database offline");
    await clickCheck();
    expect(host.textContent).toContain("Couldn't check. no network");
    expect(host.textContent).not.toContain("[object Object]");

    vi.mocked(mock.checkForUpdates).mockImplementation(() => fail("later", "not_implemented"));
    await clickCheck();
    expect(host.textContent).toContain("Updates aren't set up yet.");
  });

  it("keeps the button focusable while checking", async () => {
    vi.mocked(mock.getAppInfo).mockReturnValue({
      version: "0.1.0",
      channel: "stable",
      readOnly: true,
      canAuthenticate: false,
    });
    vi.mocked(mock.checkForUpdates).mockImplementation(() => new Promise(() => {}) as never);
    await render("updates");
    await clickCheck();
    const button = host.querySelector("button");
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
  });
});
