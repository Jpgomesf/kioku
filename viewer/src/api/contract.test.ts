// Keeps the frontend's command names in step with the Rust handler list.
import { describe, expect, it } from "vitest";
import libRs from "../../src-tauri/src/lib.rs?raw";
import { isCommandError, toCommandError } from "./core";

const clients = import.meta.glob<string>("./*/client.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

function clientCommands(): string[] {
  return Object.values(clients)
    .flatMap((text) => [...text.matchAll(/call\(\s*"([a-z_]+)"/g)].map((m) => m[1] ?? ""))
    .sort();
}

function rustCommands(): string[] {
  return [...libRs.matchAll(/commands::\w+::(\w+)/g)].map((m) => m[1] ?? "").sort();
}

describe("command contract", () => {
  it("names the same commands on both sides", () => {
    expect(clientCommands()).toEqual(rustCommands());
  });
  it("normalizes rejections into CommandError", () => {
    expect(toCommandError({ code: "read_only", message: "no" })).toEqual({
      code: "read_only",
      message: "no",
    });
    expect(toCommandError(new Error("boom"))).toEqual({ code: "unavailable", message: "boom" });
    expect(isCommandError({ code: "nope", message: "x" })).toBe(false);
  });
  it("mock writes reject with read_only", async () => {
    const { applyVisibility } = await import("./vaults");
    await expect(applyVisibility([])).rejects.toMatchObject({ code: "read_only" });
    const { getNote } = await import("./notes");
    await expect(getNote("demo", "missing")).rejects.toMatchObject({ code: "not_found" });
  });
});
