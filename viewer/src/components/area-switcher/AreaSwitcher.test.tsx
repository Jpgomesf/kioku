import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentArea, setCurrentArea } from "../../app/area";
import { closeOverlay, openOverlay } from "../../app/overlay";
import { AREAS, activeLabel, key, render, type, wait } from "../palette/testkit";
import { AreaSwitcher } from "./index";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, listAreas: async () => AREAS, getVaultsConfig: async () => ({ vaults: [] }) };
});

beforeEach(() => {
  setCurrentArea("personal/kioku");
  render(<AreaSwitcher />);
});

afterEach(async () => {
  act(() => closeOverlay());
  await wait(220);
  document.body.innerHTML = "";
});

const input = () => document.activeElement as HTMLInputElement;

describe("AreaSwitcher", () => {
  it("starts on the current area and lists it once", async () => {
    act(() => openOverlay("area-switcher"));
    await wait(0);
    expect(activeLabel()).toContain("kioku");
    const kioku = document.querySelectorAll('[role="option"][aria-current="true"]');
    expect(kioku).toHaveLength(1);
  });

  it("chooses an area with Enter", async () => {
    act(() => openOverlay("area-switcher"));
    await wait(0);
    type(input(), "notes");
    key(input(), "Enter");
    expect(getCurrentArea()).toBe("work/notes");
  });

  it("moves with the arrow keys and scrolls the option into view", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    act(() => openOverlay("area-switcher"));
    await wait(0);
    const before = activeLabel();
    key(input(), "ArrowDown");
    expect(activeLabel()).not.toBe(before);
    expect(scroll).toHaveBeenCalled();
  });

  it("says when nothing matches, outside the listbox", async () => {
    act(() => openOverlay("area-switcher"));
    await wait(0);
    type(input(), "zzz");
    const status = document.querySelector('[role="status"]');
    expect(status?.textContent).toBe("No area matches.");
    expect(status?.closest('[role="listbox"]')).toBeNull();
  });
});
