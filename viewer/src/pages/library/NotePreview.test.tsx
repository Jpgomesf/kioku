import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Finding, Note, NoteSummary } from "../../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ getNote: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...api,
}));

const { NotePreview } = await import("./NotePreview");

const summary = (key: string): NoteSummary => ({
  key,
  domain: "demo",
  title: `Title ${key}`,
  kind: "decision",
  status: "active",
  origin: "agent",
  tags: [],
  linkCount: 0,
  findingCount: 0,
  source: null,
  updatedAt: "2026-11-01T10:00:00Z",
});

const note = (key: string): Note => ({
  ...summary(key),
  body: "Body.",
  aliases: [],
  links: [],
  revisions: Array.from({ length: 8 }, (_, i) => ({
    revision: 8 - i,
    at: `2026-10-0${i + 1}T10:00:00Z`,
    summary: `change ${key} ${i}`,
    origin: "agent" as const,
  })),
  revision: 8,
  sourcePath: null,
});

const finding = (id: string): Finding => ({ id, state: "confirmed", text: id, noteKeys: ["a"] });

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  }
}

const buttons = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes(text));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.getNote.mockImplementation(async (_d: string, key: string) => note(key));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("NotePreview", () => {
  it("marks only the copied finding's command as copied", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    act(() =>
      root.render(<NotePreview summary={summary("a")} findings={[finding("f1"), finding("f2")]} />),
    );
    await settle();
    const [first] = buttons(host, "Copy a fix command");
    await act(async () => first?.click());
    expect(buttons(host, "Command copied")).toHaveLength(1);
    expect(buttons(host, "Copy a fix command")).toHaveLength(1);
  });

  it("collapses the history again when another note is selected", async () => {
    act(() => root.render(<NotePreview summary={summary("a")} findings={[]} />));
    await settle();
    await act(async () => buttons(host, "Show all")[0]?.click());
    expect(host.textContent).toContain("change a 7");
    act(() => root.render(<NotePreview summary={summary("b")} findings={[]} />));
    await settle();
    expect(host.textContent).toContain("change b 0");
    expect(host.textContent).not.toContain("change b 7");
  });
});
