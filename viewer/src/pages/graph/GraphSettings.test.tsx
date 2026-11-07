import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphSettings } from "./GraphSettings";
import { paletteColour } from "./palette";
import { defaultSettings, type PanelState, type GraphSettings as Settings } from "./settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; host: HTMLElement }> = [];
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

const openPanel: PanelState = {
  open: true,
  sections: { filters: true, groups: true, display: true, forces: true },
};

function setup(
  panel: PanelState = openPanel,
  settings: Settings = defaultSettings([
    { kind: "decision", count: 3 },
    { kind: "question", count: 1 },
  ]),
) {
  const props = {
    settings,
    panel,
    onChange: vi.fn<(next: Settings) => void>(),
    onReset: vi.fn(),
    onPanelChange: vi.fn<(next: PanelState) => void>(),
    onHighlight: vi.fn<(q: string | null) => void>(),
    onClose: vi.fn(),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(<GraphSettings {...props} />));
  return { host, props, settings, root };
}

/** Sets a value the way React's onChange sees it. */
function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const byLabel = (host: HTMLElement, label: string) =>
  host.querySelector<HTMLElement>(`[aria-label="${label}"]`) as HTMLInputElement;

function click(el: Element | null) {
  act(() => (el as HTMLElement).click());
}

describe("GraphSettings", () => {
  it("shows four sections that collapse", () => {
    const { host, props } = setup();
    const heads = [...host.querySelectorAll<HTMLButtonElement>(".gs-section-head")];
    expect(heads.map((h) => h.textContent)).toEqual(["Filters", "Groups", "Display", "Forces"]);
    expect(heads[0]?.getAttribute("aria-expanded")).toBe("true");
    click(heads[2] ?? null);
    expect(props.onPanelChange).toHaveBeenCalledWith({
      ...openPanel,
      sections: { ...openPanel.sections, display: false },
    });
  });

  it("hides a closed section's body", () => {
    const { host } = setup({ ...openPanel, sections: { ...openPanel.sections, forces: false } });
    expect(host.textContent).not.toContain("Repel force");
    expect(host.textContent).toContain("Node size");
  });

  it("sliders call onChange with clamped values", () => {
    const { host, props } = setup();
    const label = [...host.querySelectorAll("label")].find((l) => l.textContent === "Repel force");
    const input = host.querySelector<HTMLInputElement>(`#${CSS.escape(label?.htmlFor ?? "")}`);
    change(input as HTMLInputElement, "15");
    expect(props.onChange.mock.lastCall?.[0].forces.repel).toBe(15);
    const size = [...host.querySelectorAll("label")].find((l) => l.textContent === "Node size");
    const sizeInput = host.querySelector<HTMLInputElement>(`#${CSS.escape(size?.htmlFor ?? "")}`);
    expect(sizeInput?.type).toBe("range");
    change(sizeInput as HTMLInputElement, "3");
    const value = props.onChange.mock.lastCall?.[0].display.nodeSize ?? 0;
    expect(value).toBeGreaterThanOrEqual(0.1);
    expect(value).toBeLessThanOrEqual(5);
  });

  it("toggles filter switches", () => {
    const { host, props } = setup();
    const span = [...host.querySelectorAll("span")].find((s) => s.textContent === "Orphans");
    click(host.querySelector(`[aria-labelledby="${span?.id}"]`));
    expect(props.onChange.mock.lastCall?.[0].filters.orphans).toBe(false);
  });

  it("adds, removes, recolours and highlights groups", () => {
    const { host, props, settings } = setup();
    click([...host.querySelectorAll("button")].find((b) => b.textContent === "New group") ?? null);
    const added = props.onChange.mock.lastCall?.[0].groups;
    expect(added).toHaveLength(3);
    expect(added?.[2]?.color).toBe(paletteColour(2));

    click(byLabel(host, "Remove group 1"));
    expect(props.onChange.mock.lastCall?.[0].groups.map((g) => g.id)).toEqual([
      settings.groups[1]?.id,
    ]);

    change(byLabel(host, "Group 2 colour"), "#123456");
    expect(props.onChange.mock.lastCall?.[0].groups[1]?.color).toBe("#123456");

    const row = host.querySelectorAll(".gs-group")[0] as HTMLElement;
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(props.onHighlight).toHaveBeenLastCalledWith("type:decision");
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(props.onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("restores defaults and closes", () => {
    const { host, props } = setup();
    click(byLabel(host, "Restore default settings"));
    expect(props.onReset).toHaveBeenCalled();
    click(byLabel(host, "Close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    const input = byLabel(host, "Search notes");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("gives a new group a colour no group uses", () => {
    const base = defaultSettings([]);
    const groups = [0, 2].map((i) => ({ id: `g${i}`, query: `x${i}`, color: paletteColour(i) }));
    const { host, props } = setup(openPanel, { ...base, groups });
    click([...host.querySelectorAll("button")].find((b) => b.textContent === "New group") ?? null);
    expect(props.onChange.mock.lastCall?.[0].groups[2]?.color).toBe(paletteColour(1));
  });

  it("highlights nothing for an empty group query", () => {
    const base = defaultSettings([]);
    const { host, props } = setup(openPanel, {
      ...base,
      groups: [{ id: "g", query: " ", color: paletteColour(0) }],
    });
    const row = host.querySelector(".gs-group") as HTMLElement;
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(props.onHighlight).toHaveBeenLastCalledWith(null);
    change(byLabel(host, "Group 1 query"), "");
    expect(props.onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("gives focus back to the opener when it closes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { root, host } = setup();
    mounted.pop();
    byLabel(host, "Close").focus();
    act(() => root.unmount());
    host.remove();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
