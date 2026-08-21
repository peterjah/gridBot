import { describe, expect, it } from "vitest";
import { alignTickDown, alignTickUp, clampTick, MAX_TICK, MIN_TICK } from "../src/utils/ticks.js";

describe("tick alignment", () => {
  it("aligns down to spacing multiples", () => {
    expect(alignTickDown(125, 10)).toBe(120);
    expect(alignTickDown(120, 10)).toBe(120);
    expect(alignTickDown(-125, 10)).toBe(-130);
    expect(alignTickDown(-120, 10)).toBe(-120);
  });

  it("aligns up to spacing multiples", () => {
    expect(alignTickUp(125, 10)).toBe(130);
    expect(alignTickUp(120, 10)).toBe(120);
    expect(alignTickUp(-125, 10)).toBe(-120);
    expect(alignTickUp(-120, 10)).toBe(-120);
  });

  it("works with real Uniswap spacings (10, 60, 200)", () => {
    for (const spacing of [10, 60, 200]) {
      const t = 123456;
      const down = alignTickDown(t, spacing);
      const up = alignTickUp(t, spacing);
      expect(down % spacing).toBe(0);
      expect(up % spacing).toBe(0);
      expect(down).toBeLessThanOrEqual(t);
      expect(up).toBeGreaterThanOrEqual(t);
    }
  });
});

describe("clampTick", () => {
  it("clamps to valid bounds", () => {
    expect(clampTick(MIN_TICK - 1000)).toBe(MIN_TICK);
    expect(clampTick(MAX_TICK + 1000)).toBe(MAX_TICK);
    expect(clampTick(42)).toBe(42);
  });
});
