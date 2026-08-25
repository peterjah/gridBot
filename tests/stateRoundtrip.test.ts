import { describe, expect, it } from "vitest";
import { GridStrategy } from "../src/grid/gridStrategy.js";
import { LinearCostFillModel } from "../src/grid/fillModel.js";
import type { GridConfig } from "../src/grid/types.js";

function cfg(): GridConfig {
  return {
    initialUsdc: 10_000,
    initialEth: 0.5,
    centerPrice: 4000,
    spacingPercent: 1,
    levelsAbove: 5,
    levelsBelow: 5,
    orderSizeUsd: 1000,
    executionMode: "taker",
    feeBps: 5,
    slippageBps: 3,
    minEthUsd: 0,
    maxEthUsd: Number.POSITIVE_INFINITY,
    resetSellFraction: 1,
    resetUnderwaterSkipPct: 0,
    lpFeeBps: 5,
    lpVenueVolumeSharePct: 5,
    lpPoolLiquidityUsd: 0,
    lpFeeAprPct: 0,
    lpReferenceRangePct: 0,
    regimeMaxMovePct: 0,
    regimeLookbackPoints: 336,
    resetBufferLevels: 1,
    regenMinSeconds: 60,
    volLookbackPoints: 4,
    maxVolPerStep: 0.05,
    resetConfirmObservations: 0,
    resetVolPostpone: false,
    resetHardDrawdownPct: 25,
    resetHardInventoryLossPct: 0,
    resetSkipCooldownWhenFlat: false,
    resetBreakerK: 3,
    resetBreakerWindowSeconds: 30 * 24 * 3600,
  };
}

const T0 = 1_700_000_000;

describe("strategy state serialization", () => {
  it("roundtrips exactly after trading and resets", () => {
    const s = new GridStrategy(cfg(), new LinearCostFillModel(5, 3));
    // Drive some activity: buys, sells, and at least one reset.
    const prices = [4000, 3960, 4000, 3920, 3960, 3880, 3800, 3700, 3600, 3560];
    prices.forEach((p, i) => s.onPriceUpdate(p, T0 + i * 3600));
    // Cooldown rebuilds along the way; push past it.
    let t = T0 + prices.length * 3600;
    for (let i = 0; i < 30; i++) {
      s.onPriceUpdate(3560 + i * 0.01, t);
      t += 120;
    }

    const snap = s.serializeState();
    const before = JSON.stringify(s.getState());

    const s2 = new GridStrategy(cfg(), new LinearCostFillModel(5, 3));
    s2.restoreSerializedState(snap);

    expect(JSON.stringify(s2.getState())).toBe(before);
    expect(s2.serializeState()).toBe(snap);
    expect(s2.initialCapital).toBe(s.initialCapital);
    expect(s2.externalDebits).toBe(s.externalDebits);
    expect(s2.feeIncome).toBe(s.feeIncome);
    expect(s2.costBasisUsd()).toBeCloseTo(s.costBasisUsd(), 10);
  });

  it("continues identically after restore (same future actions)", () => {
    function runTo(withRestoreAt: number | null): string {
      const s = new GridStrategy(cfg(), new LinearCostFillModel(5, 3));
      [4000, 3960, 4000].forEach((p, i) => s.onPriceUpdate(p, T0 + i * 3600));

      if (withRestoreAt !== null) {
        const snap = s.serializeState();
        // Simulate a failed execution after further internal updates.
        s.onPriceUpdate(3920, T0 + 3 * 3600);
        s.restoreSerializedState(snap);
      }

      const later = [3920, 4000, 3960];
      later.forEach((p, i) => s.onPriceUpdate(p, T0 + (4 + i) * 3600));
      const st = s.getState();
      return JSON.stringify({
        trades: st.trades.map((t) => [t.side, t.levelPrice]),
        usdc: st.usdc,
        cycles: st.completedCycles,
      });
    }

    // Restoring to the pre-failure snapshot must yield the same trajectory
    // as never having taken the failed step.
    expect(runTo(null)).toBe(runTo(T0));
  });

  it("rejects unknown state versions", () => {
    const s = new GridStrategy(cfg(), new LinearCostFillModel(0, 0));
    expect(() => s.restoreSerializedState(JSON.stringify({ v: 99 }))).toThrow(/version/);
  });
});
