import { describe, expect, it } from "vitest";
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
  sqrtRatioToPrice,
  applySlippageBps,
} from "../src/utils/math.js";

// Known reference values from Uniswap V3 TickMath tests.
const SQRT_RATIO_AT_0 = 1n << 96n; // 79228162514264337593543950336
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

describe("getSqrtRatioAtTick", () => {
  it("returns Q96 at tick 0", () => {
    expect(getSqrtRatioAtTick(0)).toBe(SQRT_RATIO_AT_0);
  });

  it("matches known boundary values", () => {
    expect(getSqrtRatioAtTick(-887272)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(887272)).toBe(MAX_SQRT_RATIO);
  });

  it("is monotonically increasing", () => {
    let prev = 0n;
    for (let tick = -887200; tick <= 887200; tick += 10000) {
      const r = getSqrtRatioAtTick(tick);
      expect(r > prev).toBe(true);
      prev = r;
    }
  });

  it("is symmetric: sqrt(-t) * sqrt(t) ~= 2^192", () => {
    const a = getSqrtRatioAtTick(-60);
    const b = getSqrtRatioAtTick(60);
    const product = (a * b) >> 96n;
    // Within rounding tolerance of 2^96.
    expect(product).toBeGreaterThan((1n << 96n) - 1000000n);
    expect(product).toBeLessThan((1n << 96n) + 1000000n);
  });

  it("throws for out-of-bounds ticks", () => {
    expect(() => getSqrtRatioAtTick(-887273)).toThrow();
    expect(() => getSqrtRatioAtTick(887273)).toThrow();
    expect(() => getSqrtRatioAtTick(1.5 as unknown as number)).toThrow();
  });
});

describe("getTickAtSqrtRatio", () => {
  it("inverts getSqrtRatioAtTick", () => {
    for (const tick of [-887272, -100000, -60, -1, 0, 1, 60, 100000, 887272]) {
      expect(getTickAtSqrtRatio(getSqrtRatioAtTick(tick))).toBe(tick);
    }
  });
});

describe("sqrtRatioToPrice", () => {
  it("returns 1 at tick 0 with equal decimals", () => {
    expect(sqrtRatioToPrice(SQRT_RATIO_AT_0, 18, 18)).toBeCloseTo(1);
  });

  it("adjusts for decimals (USDC/WETH style)", () => {
    // humanPrice = raw * 10^(dec0 - dec1)
    expect(sqrtRatioToPrice(SQRT_RATIO_AT_0, 6, 18)).toBeCloseTo(1e-12);
    expect(sqrtRatioToPrice(SQRT_RATIO_AT_0, 18, 6)).toBeCloseTo(1e12);
  });
});

describe("getAmountsForLiquidity / getLiquidityForAmounts roundtrip", () => {
  const lower = getSqrtRatioAtTick(-1200);
  const upper = getSqrtRatioAtTick(1200);

  it("all-token0 below range", () => {
    const L = 10n ** 18n;
    const { amount0, amount1 } = getAmountsForLiquidity(getSqrtRatioAtTick(-1300), lower, upper, L);
    expect(amount1).toBe(0n);
    expect(amount0).toBeGreaterThan(0n);
    const L2 = getLiquidityForAmounts(getSqrtRatioAtTick(-1300), lower, upper, amount0, 0n);
    expect(L2).toBeGreaterThanOrEqual(L - 10n);
    expect(L2).toBeLessThanOrEqual(L);
  });

  it("all-token1 above range", () => {
    const L = 10n ** 18n;
    const { amount0, amount1 } = getAmountsForLiquidity(getSqrtRatioAtTick(1300), lower, upper, L);
    expect(amount0).toBe(0n);
    expect(amount1).toBeGreaterThan(0n);
    const L2 = getLiquidityForAmounts(getSqrtRatioAtTick(1300), lower, upper, 0n, amount1);
    expect(L2).toBeGreaterThanOrEqual(L - 10n);
    expect(L2).toBeLessThanOrEqual(L);
  });

  it("in-range position requires both tokens and roundtrips", () => {
    const L = 10n ** 18n;
    const current = getSqrtRatioAtTick(0);
    const { amount0, amount1 } = getAmountsForLiquidity(current, lower, upper, L);
    expect(amount0).toBeGreaterThan(0n);
    expect(amount1).toBeGreaterThan(0n);
    const L2 = getLiquidityForAmounts(current, lower, upper, amount0, amount1);
    // Rounding down may lose at most a tiny amount of liquidity.
    expect(L2).toBeLessThanOrEqual(L);
    expect(L).toBeLessThanOrEqual(L2 + 1000n);
  });

  it("limits liquidity to the scarcer token", () => {
    const current = getSqrtRatioAtTick(0);
    const huge = 1n << 200n;
    // Providing only one side of an in-range position yields zero liquidity
    // (matches Uniswap LiquidityAmounts behavior).
    expect(getLiquidityForAmounts(current, lower, upper, huge, 0n)).toBe(0n);
    expect(getLiquidityForAmounts(current, lower, upper, 0n, huge)).toBe(0n);
  });

  it("rejects inverted ranges", () => {
    expect(() => getAmountsForLiquidity(1n, upper, lower, 1n)).toThrow();
    expect(() => getLiquidityForAmounts(1n, upper, lower, 1n, 1n)).toThrow();
  });
});

describe("applySlippageBps", () => {
  it("scales amounts down by basis points", () => {
    expect(applySlippageBps(10_000n, 100)).toBe(9900n); // 1%
    expect(applySlippageBps(10_000n, 0)).toBe(10_000n);
    expect(applySlippageBps(999n, 5000)).toBe(499n); // floor
  });
});
