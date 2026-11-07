import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { sentenceCase, shortDate, toParagraphs } from "./body";
import { NoteBody } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

function render(node: ReactNode): { container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return { container };
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("toParagraphs", () => {
  it("keeps table rows and quote lines on their own lines", () => {
    expect(toParagraphs("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> one\n> two")).toEqual([
      ["| a | b |", "| --- | --- |", "| 1 | 2 |"],
      ["> one", "> two"],
    ]);
  });

  it("splits on blank lines and joins wrapped lines", () => {
    expect(toParagraphs("One\nline.\n\n  \nTwo.\r\n\r\nThree.")).toEqual([
      ["One line."],
      ["Two."],
      ["Three."],
    ]);
  });
  it("drops an empty body", () => {
    expect(toParagraphs("  \n\n ")).toEqual([]);
  });
  it("keeps list items and headings on their own lines", () => {
    expect(toParagraphs("Steps:\n- install\n- run\n\n## Context\nWhy.")).toEqual([
      ["Steps:", "- install", "- run"],
      ["## Context", "Why."],
    ]);
  });
  it("keeps fenced lines as they are", () => {
    expect(toParagraphs("Run:\n```\nmake lint\n\nmake test\n```\nDone.")).toEqual([
      ["Run:"],
      ["```", "make lint", "", "make test", "```"],
      ["Done."],
    ]);
  });
});

describe("NoteBody", () => {
  it("renders one paragraph per block", () => {
    const { container } = render(<NoteBody body={"A\n\nB"} />);
    expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["A", "B"]);
  });
  it("renders kept line breaks", () => {
    const { container } = render(<NoteBody body={"- a\n- b"} />);
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });
  it("keeps HTML as text", () => {
    const html = '<img src=x onerror="alert(1)"><b>bold</b>';
    const { container } = render(<NoteBody body={html} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe(html);
  });
});

describe("shortDate", () => {
  const now = new Date("2026-11-06T00:00:00Z");
  it("formats day and month in the current year", () => {
    expect(shortDate("2026-11-05T10:00:00Z", now)).toBe("5 Nov");
    expect(shortDate("soon", now)).toBe("soon");
  });
  it("adds the year outside the current one", () => {
    expect(shortDate("2024-03-01", now)).toBe("1 Mar 2024");
  });
});

describe("sentenceCase", () => {
  it("capitalises the first letter", () => {
    expect(sentenceCase("supersedes")).toBe("Supersedes");
  });
});
