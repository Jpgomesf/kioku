import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDraftState, resetDraftStore, setDraft } from "./draft";

const failRequests = { value: false };

vi.mock("../../api/vaults/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api/vaults/client")>();
  return {
    ...real,
    listAccessRequests: () =>
      failRequests.value
        ? Promise.reject(new Error("not implemented yet"))
        : real.listAccessRequests(),
  };
});

// The client imports its mock lazily on the first call. Load it now, so the first test
// doesn't race that import when the whole suite runs at once.
await import("../../api/vaults/mock");
const { ReviewPage, VaultsPage } = await import("./index");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetDraftStore();
  failRequests.value = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const buttonNamed = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const chipNamed = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>(".k-chip")].find((b) =>
    b.textContent?.includes(text),
  );
const rows = () => [...host.querySelectorAll<HTMLTableRowElement>("tbody tr")];
const rowNames = () => rows().map((r) => r.dataset.vault);
const rowButton = (vault: string) =>
  host.querySelector<HTMLButtonElement>(`tr[data-vault="${vault}"] .vaults-name`);
/** The switch where a vault's row meets a provider's column. */
const cell = (vault: string, provider: string) =>
  host.querySelector<HTMLElement>(
    `tr[data-vault="${vault}"] td[data-provider="${provider}"] [role="switch"]`,
  );
const searchInput = () => host.querySelector<HTMLInputElement>(".vaults-toolbar input");

function type(input: HTMLInputElement | null, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(select: HTMLSelectElement | null, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(select, value);
    select?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("VaultsPage", () => {
  it("shows the draft bar after a switch and Discard clears it", async () => {
    act(() => root.render(<VaultsPage />));
    await settle();
    const first = host.querySelector<HTMLElement>('[role="switch"]');
    expect(first).not.toBeNull();
    act(() => first?.click());
    await settle();
    expect(host.querySelector(".vaults-draft")?.textContent).toContain("2 apps change");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("2 apps change");
    act(() => buttonNamed("Discard")?.click());
    await settle();
    expect(host.querySelector(".vaults-draft")).toBeNull();
    expect(document.activeElement?.id).toBe("vaults-title");
  });

  it("still shows the vaults when the request list fails", async () => {
    failRequests.value = true;
    act(() => root.render(<VaultsPage />));
    await settle();
    expect(rows().length).toBe(2);
    expect(host.textContent).toContain("Couldn't check for access requests.");
  });

  it("drops the request when the person turns its switch back off", async () => {
    act(() => root.render(<VaultsPage />));
    await settle();
    act(() => buttonNamed("Review the request")?.click());
    expect(getDraftState().request?.id).toBe("req-1");
    act(() => root.render(<VaultsPage key="again" />));
    await settle();
    act(() => cell("personal", "openai")?.click());
    expect(getDraftState().request).toBeNull();
  });
});

describe("access matrix", () => {
  it("names each switch by its vault and its provider", async () => {
    act(() => root.render(<VaultsPage />));
    await settle();
    const ids = cell("personal", "anthropic")?.getAttribute("aria-labelledby")?.split(" ") ?? [];
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(" ")).toBe(
      "personal Anthropic",
    );
    // The column says which apps switch together.
    expect(host.querySelector("thead")?.textContent).toContain("Claude Code, Claude Desktop");
  });

  it("narrows the rows by search, by an app that can read them, and by requests", async () => {
    act(() => root.render(<VaultsPage />));
    await settle();
    type(searchInput(), "handbook");
    expect(rowNames()).toEqual(["work"]);
    expect(host.querySelector(".vaults-count")?.textContent).toContain("1 of 2 vaults");
    act(() => buttonNamed("Clear filters")?.click());
    expect(rowNames()).toEqual(["personal", "work"]);
    choose(host.querySelector<HTMLSelectElement>(".vaults-readable select"), "openai");
    expect(rowNames()).toEqual(["work"]);
    choose(host.querySelector<HTMLSelectElement>(".vaults-readable select"), "");
    act(() => chipNamed("Has a request")?.click());
    expect(rowNames()).toEqual(["personal"]);
  });

  it("switches a provider for every row shown from its column", async () => {
    act(() => root.render(<VaultsPage />));
    await settle();
    const codexColumn = () =>
      [...host.querySelectorAll<HTMLButtonElement>(".vaults-col-toggle")].find((b) =>
        b.getAttribute("aria-label")?.includes("Codex"),
      );
    expect(codexColumn()?.getAttribute("aria-label")).toBe("Let Codex read the 2 vaults shown");
    act(() => codexColumn()?.click());
    expect(cell("personal", "openai")?.getAttribute("aria-checked")).toBe("true");
    expect(cell("personal", "openai")?.closest("td")?.className).toContain("vaults-cell-changed");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("1 app changes");
    // All on now: the same button turns them all off.
    expect(codexColumn()?.textContent).toBe("None");
    act(() => codexColumn()?.click());
    expect(cell("work", "openai")?.getAttribute("aria-checked")).toBe("false");
  });

  it("opens a vault's folders and areas beside the matrix, and closes them", async () => {
    act(() => root.render(<VaultsPage />));
    await settle();
    act(() => rowButton("work")?.click());
    const details = () => host.querySelector(".vaults-details");
    expect(details()?.querySelector("h2")?.textContent).toBe("work");
    expect(details()?.textContent).toContain("~/projects/work/handbook");
    expect(rowButton("work")?.getAttribute("aria-expanded")).toBe("true");
    act(() =>
      details()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(details()).toBeNull();
  });

  it("keeps a hundred and more vaults to one row each, searchable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "kioku.viewer.mock.vaults" ? "150" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    act(() => root.render(<VaultsPage />));
    await settle();
    expect(rows().length).toBe(152);
    type(searchInput(), "client-14");
    expect(rows().length).toBe(10);
    vi.unstubAllGlobals();
  });
});

describe("ReviewPage", () => {
  it("never pretends it saved in a read-only build", async () => {
    setDraft({ "personal\nopenai": true });
    act(() => root.render(<ReviewPage />));
    await settle();
    act(() => buttonNamed("Allow")?.click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Not saved");
    expect(host.textContent).not.toContain("Saved.");
  });

  it("takes a declined grant out of the draft even when the answer can't be recorded", async () => {
    setDraft(
      { "personal\nopenai": true },
      { id: "req-1", vault: "personal", app: "codex", provider: "openai" },
    );
    act(() => root.render(<ReviewPage />));
    await settle();
    act(() => buttonNamed("Don't allow")?.click());
    await settle();
    expect(getDraftState().draft).toEqual({});
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't record your answer",
    );
  });
});
