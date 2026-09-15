import { describe, expect, it } from "vitest";
import type { PricePoint } from "../src/data/provider.js";
import { assertLpReconciles, runPassiveLp } from "../src/lp/passiveLp.js";
import type { PassiveLpConfig } from "../src/lp/passiveLp.js";

const base: Omit<PassiveLpConfig, "parkedYieldAprPct"> = {
  initialUsdc: 10_000,
  initialEth: 0,
  rangePct: 5,
  recenterBufferPct: 50,
  recenterMinHours: 24,
  feeBps: 5,
  slippageBps: 3,
  referenceRangePct: 25,
  // Tight threshold so the filter parks for most of the series.
  regimeMaxMovePct: 1,
  regimeLookbackPoints: 24,
  regimeMetric: "displacement",
  hedgeRatioPct: 0,
  hedgeBorrowAprPct: 3,
  hedgeWhileParkedOnly: false,
  parkDwellHours: 0,
  unparkDwellHours: 24,
};

/** Calm, then a sustained ramp that keeps the filter parked. */
function series(points: number, aprPct = 50): PricePoint[] {
  const start = 1_800_000_000;
  return Array.from({ length: points }, (_, i) => ({
    timestamp: start + i * 3600,
    price: 3000 * (i < 60 ? 1 : 1 + 0.4 * ((i - 60) / points)),
    feeAprPct: aprPct,
  }));
}

describe("parked yield", () => {
  it("is inert at zero, reproducing the previous behaviour", () => {
    const r = runPassiveLp({ ...base, parkedYieldAprPct: 0 }, series(600), 0.02);
    expect(r.parkedYieldUsd).toBe(0);
  });

  it("accrues only while parked", () => {
    const parked = runPassiveLp({ ...base, parkedYieldAprPct: 5 }, series(600), 0.02);
    expect(parked.timeParkedPct).toBeGreaterThan(10);
    expect(parked.parkedYieldUsd).toBeGreaterThan(0);

    // Filter off: never parks, so there is nothing to lend.
    const never = runPassiveLp(
      { ...base, regimeMaxMovePct: 0, parkedYieldAprPct: 5 },
      series(600),
      0.02,
    );
    expect(never.timeParkedPct).toBe(0);
    expect(never.parkedYieldUsd).toBe(0);
  });

  it("raises the return of a parking configuration", () => {
    const without = runPassiveLp({ ...base, parkedYieldAprPct: 0 }, series(600), 0.02);
    const with_ = runPassiveLp({ ...base, parkedYieldAprPct: 5 }, series(600), 0.02);
    expect(with_.returnPct).toBeGreaterThan(without.returnPct);
  });

  it("scales with the rate", () => {
    const low = runPassiveLp({ ...base, parkedYieldAprPct: 2 }, series(600), 0.02);
    const high = runPassiveLp({ ...base, parkedYieldAprPct: 8 }, series(600), 0.02);
    expect(high.parkedYieldUsd / low.parkedYieldUsd).toBeGreaterThan(3);
    expect(high.parkedYieldUsd / low.parkedYieldUsd).toBeLessThan(5);
  });

  /**
   * Interest accrues into parkedCash, so without attribution it would read as
   * the position appreciating while holding nothing.
   */
  it("is reported as income, not position performance", () => {
    const without = runPassiveLp({ ...base, parkedYieldAprPct: 0 }, series(600), 0.02);
    const with_ = runPassiveLp({ ...base, parkedYieldAprPct: 5 }, series(600), 0.02);
    // Position P&L must be unaffected by the money-market rate.
    expect(with_.positionPnlUsd).toBeCloseTo(without.positionPnlUsd, 6);
  });

  it("keeps the accounting identity at every rate", () => {
    for (const parkedYieldAprPct of [0, 1, 5, 20]) {
      const r = runPassiveLp({ ...base, parkedYieldAprPct }, series(600), 0.02);
      expect(() => assertLpReconciles(r)).not.toThrow();
      expect(Math.abs(r.residual)).toBeLessThan(1e-6);
    }
  });
});
