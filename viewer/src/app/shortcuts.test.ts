import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOverlay, currentOverlay, isMac } from "./overlay";
import { useGlobalShortcuts } from "./shortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;

function Host() {
  useGlobalShortcuts();
  return null;
}

beforeEach(() => {
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Host)));
});
afterEach(() => {
  act(() => {
    closeOverlay();
    root.unmount();
  });
});

const mod = () => (isMac() ? { metaKey: true } : { ctrlKey: true });
const other = () => (isMac() ? { ctrlKey: true } : { metaKey: true });
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));
  });

describe("global shortcuts", () => {
  it("toggles the palette and the switcher", () => {
    press("k", mod());
    expect(currentOverlay()).toBe("palette");
    press("o", mod());
    expect(currentOverlay()).toBe("area-switcher");
    press("o", mod());
    expect(currentOverlay()).toBeNull();
  });
  it("ignores Shift, Alt and the other platform's modifier", () => {
    press("k", { ...mod(), shiftKey: true });
    press("k", { ...mod(), altKey: true });
    press("k", other());
    expect(currentOverlay()).toBeNull();
  });
  it("closes with Escape", () => {
    press("k", mod());
    press("Escape");
    expect(currentOverlay()).toBeNull();
  });
  it("leaves input-method keys alone", () => {
    press("k", { ...mod(), isComposing: true });
    expect(currentOverlay()).toBeNull();
  });
});
