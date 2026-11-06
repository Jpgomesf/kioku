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
    expect(host.querySelectorAll(".k-vault").length).toBe(2);
    expect(host.textContent).toContain("Couldn't check for access requests.");
  });

  it("drops the request when the person turns its switch back off", async () => {
    act(() => root.render(<VaultsPage />));
    await settle();
    act(() => buttonNamed("Review the request")?.click());
    expect(getDraftState().request?.id).toBe("req-1");
    act(() => root.render(<VaultsPage key="again" />));
    await settle();
    const codex = [...host.querySelectorAll(".k-apps li")].find((li) =>
      li.textContent?.includes("Codex"),
    );
    act(() => codex?.querySelector<HTMLElement>('[role="switch"]')?.click());
    expect(getDraftState().request).toBeNull();
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
