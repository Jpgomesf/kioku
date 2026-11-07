import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEntry, resetHistory } from "../../app/history";
import { BackButton } from "./BackButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function follow(hash: string): void {
  window.history.pushState(null, "", hash);
  recordEntry();
}

beforeEach(() => {
  window.history.replaceState(null, "", "#/library?kind=decision");
  resetHistory();
  recordEntry();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "#/");
});

const button = () => host.querySelector<HTMLButtonElement>("button.back-button");

describe("BackButton", () => {
  it("goes back to the page the note was opened from, named after it", () => {
    follow("#/note/demo/a");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    act(() => root.render(<BackButton fallback={{ href: "#/library", label: "Library" }} />));
    expect(button()?.textContent).toBe("Library");
    expect(button()?.getAttribute("aria-label")).toBe("Back to Library (⌘[)");
    act(() => button()?.click());
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("names the graph when the note came from it", () => {
    follow("#/graph?domain=demo&focus=a");
    follow("#/note/demo/a");
    act(() => root.render(<BackButton fallback={{ href: "#/library", label: "Library" }} />));
    expect(button()?.textContent).toBe("Graph");
  });

  it("opens the parent page when the app started on the note", () => {
    window.history.replaceState(null, "", "#/note/demo/a");
    resetHistory();
    recordEntry();
    const back = vi.spyOn(window.history, "back");
    act(() => root.render(<BackButton fallback={{ href: "#/library", label: "Library" }} />));
    expect(button()?.textContent).toBe("Library");
    expect(button()?.getAttribute("aria-label")).toBe("Back to Library");
    act(() => button()?.click());
    expect(back).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/library");
  });
});
