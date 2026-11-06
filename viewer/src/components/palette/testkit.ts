// Shared helpers for the overlay component tests: render, type and press keys in jsdom.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Area, SearchHit } from "../../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function render(node: ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

export function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function key(target: Element, k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
}

export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export function activeLabel(): string | null | undefined {
  const input = document.activeElement;
  const id = input?.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : null;
}

export const area = (domain: string, label: string, vault: string, noteCount = 3): Area => ({
  domain,
  label,
  vault,
  noteCount,
  legacyCount: 0,
  source: null,
});

export const AREAS: Area[] = [
  area("personal/kioku", "kioku", "personal"),
  area("local", "local", "personal"),
  area("demo", "demo", "personal"),
  area("work/notes", "notes", "work"),
];

export function hitFor(key: string, title: string): SearchHit {
  return {
    note: {
      key,
      domain: "personal/kioku",
      title,
      kind: "decision",
      status: "active",
      origin: "agent",
      tags: [],
      linkCount: 0,
      findingCount: 0,
      source: null,
      updatedAt: "2026-01-01T00:00:00Z",
    },
    score: 1,
    matchedBy: ["text"],
    linkedFrom: null,
    snippet: "",
  };
}
