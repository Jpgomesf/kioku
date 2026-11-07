import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphSettings, type GraphSettingsProps } from "./GraphSettings";
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
  extra: Partial<GraphSettingsProps> = {},
) {
  const props = {
    ...extra,
    settings,
    panel,
    onChange: vi.fn<(next: Settings) => void>(),
    onReset: vi.fn(),
    onPanelChange: vi.fn<(next: PanelState) => void>(),
    onHighlight: vi.fn<(q: string | null) => void>(),
    onClose: vi.fn(),
    onAnimate: vi.fn(),
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

/** The buttons of the segmented control named `label`. */
function choice(host: HTMLElement, label: string): HTMLButtonElement[] {
  const name = [...host.querySelectorAll(".k-seg-label")].find((s) => s.textContent === label);
  const group = host.querySelector(`[aria-labelledby="${name?.id}"]`);
  if (!name || !group) throw new Error(`no choice named ${label}`);
  return [...group.querySelectorAll("button")];
}

const pressed = (buttons: HTMLButtonElement[]) =>
  buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

/** The range input of the slider labelled `label`, or null when there is none. */
function slider(host: HTMLElement, label: string): HTMLInputElement | null {
  const el = [...host.querySelectorAll("label")].find((l) => l.textContent === label);
  return el ? host.querySelector<HTMLInputElement>(`#${CSS.escape(el.htmlFor)}`) : null;
}

/** The switch named by the visible text `label`. */
const switchFor = (host: HTMLElement, label: string) => {
  const span = [...host.querySelectorAll(".gs-row > span")].find((s) => s.textContent === label);
  return host.querySelector<HTMLButtonElement>(`[aria-labelledby="${span?.id}"]`);
};

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

  it("leaves focus where the page puts it when it closes", () => {
    // The box opens with the page, so what had focus then (a link elsewhere, say) did not open it.
    const before = document.createElement("a");
    before.href = "#/elsewhere";
    const gear = document.createElement("button");
    document.body.append(before, gear);
    before.focus();
    const { root, host } = setup();
    mounted.pop();
    byLabel(host, "Close").focus();
    // The page hands focus to the gear as it closes the box.
    gear.focus();
    act(() => root.unmount());
    host.remove();
    expect(document.activeElement).toBe(gear);
    before.remove();
    gear.remove();
  });

  it("lays out the filters and groups in Obsidian's order, colour choice first", () => {
    const { host } = setup();
    const switches = [...host.querySelectorAll(".gs-section:first-of-type .gs-row > span")].map(
      (el) => el.textContent,
    );
    expect(switches).toEqual(["Tags", "Orphans", "Legacy notes", "Links Reflect suggests"]);
    const groupsBody = host.querySelectorAll(".gs-section-body")[1];
    expect(groupsBody?.firstElementChild?.querySelector(".k-seg-label")?.textContent).toBe(
      "Colour by",
    );
    expect(groupsBody?.children[1]?.textContent).toBe("New group");
    expect(host.querySelector(".gs-head")?.textContent).toBe("");
  });

  it("colours by groups or by brain regions", () => {
    const { host, props } = setup();
    const colourBy = choice(host, "Colour by");
    expect(colourBy.map((b) => b.textContent)).toEqual(["Groups", "Brain regions"]);
    expect(pressed(colourBy)).toEqual(["Groups"]);
    click(colourBy[1] ?? null);
    expect(props.onChange.mock.lastCall?.[0].clusters).toEqual({
      separateBy: "regions",
      colourBy: "regions",
    });
    // A row hovered as the list goes away would otherwise keep its highlight.
    expect(props.onHighlight).toHaveBeenLastCalledWith(null);
  });

  it("puts the groups away while colours come from brain regions", () => {
    const base = defaultSettings([{ kind: "decision", count: 3 }]);
    const { host } = setup(openPanel, {
      ...base,
      clusters: { separateBy: "regions", colourBy: "regions" },
    });
    expect(pressed(choice(host, "Colour by"))).toEqual(["Brain regions"]);
    expect(host.querySelector(".gs-group")).toBeNull();
    expect(host.textContent).not.toContain("New group");
    expect(host.textContent).toContain(
      "Up to 12 of the largest brain regions, clusters of notes that link mostly to each other, get a colour each. Region labels, under Display, lists them.",
    );
    expect(host.textContent).not.toContain("still separate");
  });

  it("keeps the groups listed while they separate the graph, under the region colours' hint", () => {
    const base = defaultSettings([{ kind: "decision", count: 3 }]);
    const { host } = setup(openPanel, {
      ...base,
      clusters: { separateBy: "groups", colourBy: "regions" },
    });
    const groupsBody = host.querySelectorAll(".gs-section-body")[1];
    const parts = [...(groupsBody?.children ?? [])];
    expect(parts[1]?.textContent).toBe(
      "Up to 12 of the largest brain regions, clusters of notes that link mostly to each other, get a colour each. The groups below still separate the graph.",
    );
    expect(parts[2]?.textContent).toBe("New group");
    expect(byLabel(host, "Group 1 query").value).toBe("type:decision");
  });

  it("clears a group's highlight only when Separate by puts the groups away", () => {
    const base = defaultSettings([{ kind: "decision", count: 3 }]);
    const byRegion = setup(openPanel, {
      ...base,
      clusters: { separateBy: "groups", colourBy: "regions" },
    });
    click(choice(byRegion.host, "Separate by")[2] ?? null);
    expect(byRegion.props.onChange.mock.lastCall?.[0].clusters.separateBy).toBe("regions");
    // A row under the pointer as the list goes away would otherwise keep its highlight.
    expect(byRegion.props.onHighlight).toHaveBeenLastCalledWith(null);

    // Coloured by group, the rows stay, and so does what they highlight.
    const byGroup = setup(openPanel, base);
    click(choice(byGroup.host, "Separate by")[0] ?? null);
    expect(byGroup.props.onChange.mock.lastCall?.[0].clusters.separateBy).toBe("none");
    expect(byGroup.props.onHighlight).not.toHaveBeenCalled();
  });

  it("separates by colour group or brain region, with a separation strength", () => {
    const { host, props } = setup();
    const separateBy = choice(host, "Separate by");
    expect(separateBy.map((b) => b.textContent)).toEqual([
      "None",
      "Colour groups",
      "Brain regions",
    ]);
    expect(pressed(separateBy)).toEqual(["Brain regions"]);
    click(separateBy[1] ?? null);
    expect(props.onChange.mock.lastCall?.[0].clusters.separateBy).toBe("groups");
    click(separateBy[0] ?? null);
    expect(props.onChange.mock.lastCall?.[0].clusters.separateBy).toBe("none");

    const separation = slider(host, "Separation");
    expect(separation?.min).toBe("0");
    expect(separation?.max).toBe("1");
    change(separation as HTMLInputElement, "0.8");
    expect(props.onChange.mock.lastCall?.[0].forces.separation).toBe(0.8);
    // The Obsidian forces come first, then the separation.
    const forces = [...host.querySelectorAll(".gs-section")][3];
    const labels = [...(forces?.querySelectorAll("label, .k-seg-label") ?? [])].map(
      (l) => l.textContent,
    );
    expect(labels).toEqual([
      "Center force",
      "Repel force",
      "Link force",
      "Link distance",
      "Separate by",
      "Separation",
    ]);
  });

  it("drops the separation strength when nothing is separated", () => {
    const base = defaultSettings([]);
    const { host } = setup(openPanel, {
      ...base,
      clusters: { ...base.clusters, separateBy: "none" },
    });
    expect(pressed(choice(host, "Separate by"))).toEqual(["None"]);
    expect(slider(host, "Separation")).toBeNull();
    expect(slider(host, "Link distance")).not.toBeNull();
  });

  it("sets the highlight depth in whole links, with a hint", () => {
    const { host, props } = setup();
    const depth = slider(host, "Highlight depth") as HTMLInputElement;
    expect([depth.min, depth.max, depth.step, depth.value]).toEqual(["1", "3", "1", "1"]);
    const hint = document.getElementById(depth.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("How many links away a hovered or selected note lights up");
    change(depth, "3");
    expect(props.onChange.mock.lastCall?.[0].display.highlightDepth).toBe(3);
    change(depth, "2");
    expect(props.onChange.mock.lastCall?.[0].display.highlightDepth).toBe(2);
  });

  it("toggles the region labels", () => {
    const { host, props } = setup();
    const regionLabels = switchFor(host, "Region labels");
    expect(regionLabels?.getAttribute("aria-checked")).toBe("true");
    click(regionLabels);
    expect(props.onChange.mock.lastCall?.[0].display.regionLabels).toBe(false);
  });

  it("closes on Escape from the new controls too", () => {
    const { host, props } = setup();
    const target = choice(host, "Separate by")[0];
    act(() => {
      target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("toggles the tags filter", () => {
    const { host, props } = setup();
    const span = [...host.querySelectorAll("span")].find((s) => s.textContent === "Tags");
    click(host.querySelector(`[aria-labelledby="${span?.id}"]`));
    expect(props.onChange.mock.lastCall?.[0].filters.tags).toBe(true);
  });

  it("calls onAnimate from the Animate button", () => {
    const { host, props } = setup();
    click([...host.querySelectorAll("button")].find((b) => b.textContent === "Animate") ?? null);
    expect(props.onAnimate).toHaveBeenCalledTimes(1);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("calls onAnimate from the wand in the top row", () => {
    const { host, props } = setup();
    click(host.querySelector('.gs-head button[aria-label="Animate"]'));
    expect(props.onAnimate).toHaveBeenCalledTimes(1);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("shows each slider's value left of its track", () => {
    const { host } = setup();
    const track = host.querySelector(".gs-slider-track");
    expect(track?.firstElementChild?.tagName).toBe("OUTPUT");
    expect(track?.lastElementChild?.getAttribute("type")).toBe("range");
  });

  it("lists what the canvas names, each a button that zooms to its part", () => {
    const onZoomTo = vi.fn<(id: number) => void>();
    const named = [
      { id: 2, name: "billing · 120", colour: "#0069cd" },
      { id: 0, name: "Questions · 40", colour: null },
    ];
    const { host } = setup(openPanel, undefined, { named, onZoomTo });
    const parts = [...host.querySelectorAll<HTMLButtonElement>(".gs-part")];
    expect(parts.map((b) => b.textContent)).toEqual(["billing · 120", "Questions · 40"]);
    expect(parts.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Zoom to billing · 120",
      "Zoom to Questions · 40",
    ]);
    expect(host.querySelector(".gs-parts")?.getAttribute("aria-label")).toBe("Named brain regions");
    // Only a part whose notes share a colour shows it.
    expect(host.querySelectorAll(".gs-part-swatch")).toHaveLength(1);
    click(parts[0] ?? null);
    expect(onZoomTo).toHaveBeenCalledWith(2);
    // The switch says what it names, and the hint describes it.
    const hint = switchFor(host, "Region labels")?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(hint)?.textContent).toBe(
      "Names each brain region on the canvas; click a name to zoom to it",
    );
  });

  it("says the canvas names the colour groups while they separate the graph", () => {
    const base = defaultSettings([{ kind: "decision", count: 3 }]);
    const named = [{ id: 0, name: "Decisions · 3", colour: "#0069cd" }];
    const { host } = setup(
      openPanel,
      { ...base, clusters: { separateBy: "groups", colourBy: "groups" } },
      { named, onZoomTo: vi.fn() },
    );
    expect(host.textContent).toContain(
      "Names each colour group while the graph is separated by them",
    );
    expect(host.querySelector(".gs-parts")?.getAttribute("aria-label")).toBe("Named colour groups");
  });

  it("lists nothing while region labels are off", () => {
    const base = defaultSettings([{ kind: "decision", count: 3 }]);
    const named = [{ id: 0, name: "billing · 3", colour: null }];
    const { host } = setup(
      openPanel,
      { ...base, display: { ...base.display, regionLabels: false } },
      { named, onZoomTo: vi.fn() },
    );
    expect(host.querySelector(".gs-parts")).toBeNull();
  });
});
