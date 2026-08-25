import { describe, expect, it } from "vitest";
import { CenteredRangeStrategy } from "../src/strategy/centeredRange.js";
import { centerTick, distanceFromCenter } from "../src/strategy/rebalance.js";
import { planBalancingSwap } from "../src/uniswap/swap.js";

const SPACING = 60;

function isAligned(tick: number, spacing: number): boolean {
  return ((tick % spacing) + spacing) % spacing === 0;
}

function makeStrategy(width = 1200, threshold = 600) {
  return new CenteredRangeStrategy({ widthTicks: width, thresholdTicks: threshold });
}

describe("CenteredRangeStrategy.computeRange", () => {
  it("centers the range on the current tick", () => {
    const s = makeStrategy();
    const range = s.computeRange({ currentTick: 1000, tickSpacing: SPACING });
    // alignDown(-200) = -240, alignUp(2200) = 2220
    expect(range.lowerTick).toBe(-240);
    expect(range.upperTick).toBe(2220);
    expect(isAligned(range.lowerTick, SPACING)).toBe(true);
    expect(isAligned(range.upperTick, SPACING)).toBe(true);
  });

  it("aligns ticks to tick spacing", () => {
    const s = makeStrategy();
    const range = s.computeRange({ currentTick: 1234, tickSpacing: SPACING });
    expect(range.lowerTick).toBe(Math.floor((1234 - 1200) / SPACING) * SPACING);
    expect(range.upperTick).toBe(Math.ceil((1234 + 1200) / SPACING) * SPACING);
    expect(range.lowerTick < 1234).toBe(true);
    expect(range.upperTick > 1234).toBe(true);
  });

  it("keeps the current tick inside the range for negative ticks", () => {
    const s = makeStrategy();
    const range = s.computeRange({ currentTick: -50000, tickSpacing: SPACING });
    expect(range.lowerTick).toBeLessThan(-50000);
    expect(range.upperTick).toBeGreaterThan(-50000);
    expect(isAligned(range.lowerTick, SPACING)).toBe(true);
    expect(isAligned(range.upperTick, SPACING)).toBe(true);
  });

  it("rejects invalid configuration", () => {
    expect(() => new CenteredRangeStrategy({ widthTicks: 0, thresholdTicks: 1 })).toThrow();
    expect(() => new CenteredRangeStrategy({ widthTicks: 100, thresholdTicks: 0 })).toThrow();
    // A threshold at or beyond the range edge is legal: the backtested optimum
    // lets the position drift out of range before re-centring.
    expect(() => new CenteredRangeStrategy({ widthTicks: 100, thresholdTicks: 150 })).not.toThrow();
  });
});

describe("CenteredRangeStrategy.shouldRebalance", () => {
  it("does not rebalance inside the threshold", () => {
    const s = makeStrategy(1200, 600);
    // Position centered at 0: [-1200, 1200]
    const range = { lowerTick: -1200, upperTick: 1200 };
    expect(s.shouldRebalance(0, range)).toBe(false);
    expect(s.shouldRebalance(599, range)).toBe(false);
    expect(s.shouldRebalance(-599, range)).toBe(false);
  });

  it("rebalances when price moves beyond the threshold", () => {
    const s = makeStrategy(1200, 600);
    const range = { lowerTick: -1200, upperTick: 1200 };
    expect(s.shouldRebalance(600, range)).toBe(true);
    expect(s.shouldRebalance(-600, range)).toBe(true);
    expect(s.shouldRebalance(5000, range)).toBe(true);
  });

  it("always rebalances when there is no position", () => {
    const s = makeStrategy();
    expect(s.shouldRebalance(0, null)).toBe(true);
  });

  it("has hysteresis after rebalancing (new position centered on current tick)", () => {
    const s = makeStrategy(1200, 600);
    // Price drifted to tick 700 -> rebalance triggers.
    const oldRange = { lowerTick: -1200, upperTick: 1200 };
    expect(s.shouldRebalance(700, oldRange)).toBe(true);

    // New position is centered around 700.
    const newRange = s.computeRange({ currentTick: 700, tickSpacing: SPACING });
    // [-540, 1920] -> center 690, within threshold of 700
    expect(distanceFromCenter(700, newRange)).toBeLessThan(600);
    expect(s.shouldRebalance(700, newRange)).toBe(false);
  });
});

describe("planBalancingSwap", () => {
  it("returns null when balances already fit the ratio", () => {
    expect(planBalancingSwap(100n, 200n, 150n, 300n)).toBeNull();
    expect(planBalancingSwap(100n, 200n, 100n, 200n)).toBeNull();
  });

  it("plans token0 -> token1 when token1 is deficient", () => {
    const plan = planBalancingSwap(100n, 200n, 300n, 50n);
    expect(plan).not.toBeNull();
    expect(plan!.zeroForOne).toBe(true);
    expect(plan!.amountIn).toBe(200n); // excess token0
  });

  it("plans token1 -> token0 when token0 is deficient", () => {
    const plan = planBalancingSwap(100n, 200n, 20n, 400n);
    expect(plan).not.toBeNull();
    expect(plan!.zeroForOne).toBe(false);
    expect(plan!.amountIn).toBe(200n); // excess token1
  });

  it("handles zero balances and zero requirements", () => {
    // Nothing to swap with -> no swap possible.
    expect(planBalancingSwap(100n, 200n, 0n, 0n)).toBeNull();
    expect(planBalancingSwap(0n, 0n, 100n, 100n)).toBeNull();
  });
});
