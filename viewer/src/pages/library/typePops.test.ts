import { describe, expect, it } from "vitest";
import { foldMs, POP_IN_MS, POP_OUT_MS, popProps } from "./typePops";

const delayOf = (props: ReturnType<typeof popProps>) =>
  Number.parseInt(String((props.style as Record<string, string>)["--pop-delay"]), 10);

describe("type chip pops", () => {
  it("pops in slower than out", () => {
    expect(POP_IN_MS).toBeGreaterThan(POP_OUT_MS);
    expect(popProps(0, 1, false).style).toMatchObject({ "--pop-ms": `${POP_IN_MS}ms` });
    expect(popProps(0, 1, true).style).toMatchObject({ "--pop-ms": `${POP_OUT_MS}ms` });
  });

  it("keeps a long row quick: the cascade's delays stay within their spread", () => {
    const count = 24;
    const lastIn = delayOf(popProps(count - 1, count, false));
    const firstOut = delayOf(popProps(0, count, true));
    expect(lastIn).toBeLessThanOrEqual(320);
    expect(firstOut).toBeLessThanOrEqual(220);
    // Out goes the other way round: the last chip leaves first.
    expect(delayOf(popProps(count - 1, count, true))).toBe(0);
    expect(foldMs(count)).toBe(firstOut + POP_OUT_MS);
  });

  it("takes no time to fold nothing, and one pop for one chip", () => {
    expect(foldMs(0)).toBe(0);
    expect(foldMs(1)).toBe(POP_OUT_MS);
  });
});
