import { describe, expect, it } from "vitest";
import { pctToTicks } from "../src/config.js";
import { CenteredRangeStrategy } from "../src/strategy/centeredRange.js";
import { getSqrtRatioAtTick, sqrtRatioToPrice } from "../src/utils/math.js";

/**
 * The live LP bot must trigger where the passive-LP backtest
 * (src/lp/passiveLp.ts) triggers, or a configuration chosen by `npm run lp`
 * means something different on-chain.
 */
describe("pctToTicks", () => {
  it("round-trips a percentage into a price ratio", () => {
    for (const pct of [1, 2, 5, 10, 20, 50]) {
      const ticks = pctToTicks(pct);
      const ratio = 1.0001 ** ticks;
      expect(ratio).toBeCloseTo(1 + pct / 100, 3);
    }
  });

  it("is monotonic and positive for positive widths", () => {
    expect(pctToTicks(5)).toBeGreaterThan(0);
    expect(pctToTicks(10)).toBeGreaterThan(pctToTicks(5));
  });
});

describe("live trigger matches the backtest convention", () => {
  // passiveLp: recentre when price is beyond hi + halfWidth * buffer/100,
  // i.e. at centre * (1 + rangePct/100 * (1 + buffer/100)).
  const rangePct = 5;
  const bufferPct = 50;
  const widthTicks = pctToTicks(rangePct);
  const thresholdTicks = pctToTicks(rangePct * (1 + bufferPct / 100));

  it("places the trigger beyond the range edge", () => {
    expect(thresholdTicks).toBeGreaterThan(widthTicks);
  });

  it("fires at the same price the backtest would", () => {
    const centerTick = -198180;
    const centerPrice = priceAt(centerTick);
    // Backtest trigger price, derived independently of tick math.
    const halfWidth = centerPrice * (rangePct / 100);
    const expected = centerPrice + halfWidth * (1 + bufferPct / 100);
    const actual = priceAt(centerTick + thresholdTicks);
    expect(actual / expected).toBeCloseTo(1, 2);
  });

  it("holds inside the trigger and rebalances at it", () => {
    const strategy = new CenteredRangeStrategy({ widthTicks, thresholdTicks });
    const range = { lowerTick: -198180 - widthTicks, upperTick: -198180 + widthTicks };
    const center = Math.floor((range.lowerTick + range.upperTick) / 2);
    expect(strategy.shouldRebalance(center + thresholdTicks - 1, range)).toBe(false);
    expect(strategy.shouldRebalance(center + thresholdTicks, range)).toBe(true);
    // Symmetric on the downside.
    expect(strategy.shouldRebalance(center - thresholdTicks, range)).toBe(true);
  });

  it("still rebalances while out of range but inside the buffer only at the trigger", () => {
    const strategy = new CenteredRangeStrategy({ widthTicks, thresholdTicks });
    const range = { lowerTick: -198180 - widthTicks, upperTick: -198180 + widthTicks };
    const center = Math.floor((range.lowerTick + range.upperTick) / 2);
    // Just past the upper edge: out of range, earning nothing, but the
    // buffer says wait.
    expect(strategy.shouldRebalance(center + widthTicks + 1, range)).toBe(false);
  });
});

/** WETH/USDC price at a tick, matching the pool's token ordering. */
function priceAt(tick: number): number {
  return sqrtRatioToPrice(getSqrtRatioAtTick(tick), 18, 6);
}
