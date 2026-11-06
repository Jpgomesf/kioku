import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Chip } from "./Chip";
import { Switch } from "./Switch";

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
