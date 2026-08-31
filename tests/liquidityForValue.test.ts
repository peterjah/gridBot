import { describe, expect, it } from "vitest";
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getLiquidityForValue,
  getSqrtRatioAtTick,
  valueInToken1,
} from "../src/utils/math.js";
import { planBalancingSwap } from "../src/uniswap/swap.js";

// The live position: WETH/USDC 0.05% on Base, ±5% around tick -198270.
const sqrtP = getSqrtRatioAtTick(-198270);
const sqrtLower = getSqrtRatioAtTick(-198750);
const sqrtUpper = getSqrtRatioAtTick(-197770);

describe("getLiquidityForValue", () => {
  /**
   * The production failure: 0.1414 WETH and 0.000001 USDC planned a position
   * of 4.1e-10 WETH, because min-of-sides collapsed on the empty USDC side.
   */
  it("deploys a one-sided wallet instead of collapsing to nothing", () => {
    const weth = 141_396_878_202_825_451n; // 0.1414 WETH
    const usdc = 1n; // 0.000001 USDC

    const byMin = getLiquidityForAmounts(sqrtP, sqrtLower, sqrtUpper, weth, usdc);
    const byValue = getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, weth, usdc);

    expect(byMin).toBeLessThan(1_000_000n); // effectively zero
    expect(byValue).toBeGreaterThan(byMin * 1_000_000n);
  });

  it("plans a real balancing swap for that wallet", () => {
    const weth = 141_396_878_202_825_451n;
    const usdc = 1n;
    const liquidity = getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, weth, usdc);
    const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, sqrtLower, sqrtUpper, liquidity);

    const plan = planBalancingSwap(amount0, amount1, weth, usdc);
    expect(plan).not.toBeNull();
    expect(plan!.zeroForOne).toBe(true); // sell WETH for USDC
    expect(plan!.amountIn).toBeGreaterThan(0n);
    // ...and it must not try to sell more WETH than the wallet holds.
    expect(plan!.amountIn).toBeLessThanOrEqual(weth);
  });

  it("conserves value: the position it sizes is worth what went in", () => {
    const weth = 141_396_878_202_825_451n;
    const usdc = 1n;
    const have = valueInToken1(sqrtP, weth, usdc);
    const liquidity = getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, weth, usdc);
    const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, sqrtLower, sqrtUpper, liquidity);
    const deployed = valueInToken1(sqrtP, amount0, amount1);
    // Rounding costs a little; nothing material may be left behind.
    const ratio = Number(deployed) / Number(have);
    expect(ratio).toBeGreaterThan(0.999);
    expect(ratio).toBeLessThanOrEqual(1.000001);
  });

  it("handles the mirror case: all USDC, no WETH", () => {
    const liquidity = getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, 0n, 350_000_000n);
    expect(liquidity).toBeGreaterThan(0n);
    const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, sqrtLower, sqrtUpper, liquidity);
    const plan = planBalancingSwap(amount0, amount1, 0n, 350_000_000n);
    expect(plan).not.toBeNull();
    expect(plan!.zeroForOne).toBe(false); // buy WETH with USDC
  });

  it("agrees with min-of-sides when the wallet is already balanced", () => {
    // Take the ratio a position implies, then feed it back.
    const reference = getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, 10n ** 18n, 0n);
    const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, sqrtLower, sqrtUpper, reference);
    const byMin = getLiquidityForAmounts(sqrtP, sqrtLower, sqrtUpper, amount0, amount1);
    const byValue = getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, amount0, amount1);
    const drift = Number(byValue - byMin) / Number(byMin);
    expect(Math.abs(drift)).toBeLessThan(1e-6);
  });

  it("returns zero for an empty wallet", () => {
    expect(getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, 0n, 0n)).toBe(0n);
  });

  it("works when price sits outside the range", () => {
    const below = getSqrtRatioAtTick(-199500); // price under the band
    const above = getSqrtRatioAtTick(-197000); // price over the band
    expect(getLiquidityForValue(below, sqrtLower, sqrtUpper, 10n ** 17n, 0n)).toBeGreaterThan(0n);
    expect(getLiquidityForValue(above, sqrtLower, sqrtUpper, 0n, 100_000_000n)).toBeGreaterThan(0n);
  });

  it("rejects an inverted range", () => {
    expect(() => getLiquidityForValue(sqrtP, sqrtUpper, sqrtLower, 1n, 1n)).toThrow();
  });

  it("scales linearly with the holding", () => {
    const one = getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, 10n ** 18n, 0n);
    const ten = getLiquidityForValue(sqrtP, sqrtLower, sqrtUpper, 10n ** 19n, 0n);
    const ratio = Number(ten) / Number(one);
    expect(ratio).toBeGreaterThan(9.99);
    expect(ratio).toBeLessThan(10.01);
  });
});
