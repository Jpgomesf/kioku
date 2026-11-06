import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Chip } from "./Chip";
import { Dialog } from "./Dialog";
import { Switch } from "./Switch";
import { dismissToast, showToast, ToastHost } from "./Toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(node));
  return host;
}

describe("ui primitives", () => {
  it("renders a switch with its state", () => {
    const host = render(<Switch checked label="Claude Code" onChange={() => {}} />);
    const el = host.querySelector('[role="switch"]');
    expect(el?.getAttribute("aria-checked")).toBe("true");
    expect(el?.getAttribute("aria-label")).toBe("Claude Code");
  });
  it("toggles a chip", () => {
    let value = false;
    const host = render(
      <Chip
        pressed={false}
        onToggle={(v) => {
          value = v;
        }}
      >
        Decisions
      </Chip>,
    );
    act(() => host.querySelector("button")?.click());
    expect(value).toBe(true);
  });
});

describe("switch naming and state", () => {
  it("can be named by a visible label and described", () => {
    const host = render(
      <>
        <span id="app-name">Claude Code</span>
        <span id="app-desc">Anthropic models</span>
        <Switch
          checked={false}
          labelledBy="app-name"
          describedBy="app-desc"
          disabled
          onChange={() => {}}
        />
      </>,
    );
    const el = host.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(el?.getAttribute("aria-labelledby")).toBe("app-name");
    expect(el?.getAttribute("aria-describedby")).toBe("app-desc");
    expect(el?.getAttribute("aria-label")).toBeNull();
    expect(el?.disabled).toBe(true);
  });
});

describe("dialog focus and keys", () => {
  const key = (el: Element, init: KeyboardEventInit) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

  it("keeps focus where it is on a click on plain content", () => {
    const host = render(
      <Dialog label="Demo" onClose={() => {}}>
        <input data-autofocus />
        <h2>Section</h2>
      </Dialog>,
    );
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    host.querySelector("h2")?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("wraps Shift+Tab from the panel itself", () => {
    const host = render(
      <Dialog label="Demo" onClose={() => {}}>
        <button type="button">One</button>
        <button type="button">Two</button>
      </Dialog>,
    );
    const panel = host.querySelector<HTMLElement>('[role="dialog"]');
    panel?.focus();
    act(() => {
      if (panel) key(panel, { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement?.textContent).toBe("Two");
  });

  it("does not close on Escape while composing", () => {
    let closed = 0;
    const host = render(
      <Dialog label="Demo" onClose={() => (closed += 1)}>
        <input data-autofocus />
      </Dialog>,
    );
    const input = host.querySelector("input");
    act(() => {
      if (input) key(input, { key: "Escape", isComposing: true });
    });
    expect(closed).toBe(0);
    act(() => {
      if (input) key(input, { key: "Escape" });
    });
    expect(closed).toBe(1);
  });
});

describe("toast announcements", () => {
  it("re-renders the live region text for a repeated toast", () => {
    const host = render(<ToastHost />);
    const region = () => host.querySelector('[role="alert"]')?.firstChild;
    act(() => showToast({ tone: "error", text: "Read only" }));
    const before = region();
    act(() => showToast({ tone: "error", text: "Read only" }));
    expect(region()).not.toBe(before);
    expect(region()?.textContent).toBe("Read only");
    act(() => dismissToast());
  });
});
