import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { Inspector } from "./Inspector";

const node = (key: string): GraphNode => ({
  key,
  domain: "t",
  title: key,
  kind: "decision",
  status: "active",
  degree: 1,
});

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("Inspector", () => {
  it("leaves out links to notes the filters hide", () => {
    const a = node("a");
    const data: GraphData = {
      nodes: [a, node("b"), node("c")],
      edges: [
        { source: "a", target: "b", relation: "related", suggested: false },
        { source: "a", target: "c", relation: "related", suggested: false },
      ],
    };
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <Inspector
          node={a}
          data={data}
          visibleKeys={new Set(["a", "b"])}
          rank={() => 0}
          colourOf={() => "#8a8b93"}
          onFocus={vi.fn()}
          onAround={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
    const rows = [...host.querySelectorAll(".graph-link .k-mono")].map((e) => e.textContent);
    expect(rows).toEqual(["b"]);
  });
});
