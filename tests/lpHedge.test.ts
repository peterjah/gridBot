import { describe, expect, it } from "vitest";
import type { PricePoint } from "../src/data/provider.js";
import { assertLpReconciles, runPassiveLp } from "../src/lp/passiveLp.js";
import type { PassiveLpConfig } from "../src/lp/passiveLp.js";

const base: Omit<PassiveLpConfig, "hedgeRatioPct"> = {
  initialUsdc: 10_000,
  initialEth: 0,
  rangePct: 5,
  recenterBufferPct: 50,
  recenterMinHours: 24,
  feeBps: 5,
  slippageBps: 3,
  referenceRangePct: 25,
  regimeMaxMovePct: 0,
  regimeLookbackPoints: 24,
  hedgeBorrowAprPct: 3,
  hedgeWhileParkedOnly: false,
  regimeMetric: "displacement" as const,
};

/** A steady one-way move, which is where directional exposure bites. */
function ramp(points: number, endMultiple: number, aprPct = 50): PricePoint[] {
  const start = 1_700_000_000;
  return Array.from({ length: points }, (_, i) => ({
    timestamp: start + i * 3600,
    price: 3000 * (1 + (endMultiple - 1) * (i / (points - 1))),
    feeAprPct: aprPct,
  }));
}

describe("hedged passive LP", () => {
  it("keeps the accounting identity at every ratio", () => {
    for (const hedgeRatioPct of [0, 25, 50, 100]) {
      for (const move of [0.6, 1.0, 1.5]) {
        const r = runPassiveLp({ ...base, hedgeRatioPct }, ramp(400, move), 0.02);
        expect(() => assertLpReconciles(r)).not.toThrow();
      }
    }
  });

  it("is inert when the ratio is zero", () => {
    const r = runPassiveLp({ ...base, hedgeRatioPct: 0 }, ramp(400, 0.7), 0.02);
    expect(r.hedgePnlUsd).toBe(0);
    expect(r.hedgeCostUsd).toBe(0);
    expect(r.hedgeRebalances).toBe(0);
  });

  it("gains on the short leg when price falls", () => {
    const r = runPassiveLp({ ...base, hedgeRatioPct: 100 }, ramp(400, 0.6), 0.02);
    expect(r.hedgePnlUsd).toBeGreaterThan(0);
  });

  it("loses on the short leg when price rises", () => {
    const r = runPassiveLp({ ...base, hedgeRatioPct: 100 }, ramp(400, 1.4), 0.02);
    expect(r.hedgePnlUsd).toBeLessThan(0);
  });

  it("cuts the loss of a sustained downtrend", () => {
    const data = ramp(400, 0.6);
    const un = runPassiveLp({ ...base, hedgeRatioPct: 0 }, data, 0.02);
    const hedged = runPassiveLp({ ...base, hedgeRatioPct: 100 }, data, 0.02);
    expect(hedged.returnPct).toBeGreaterThan(un.returnPct);
  });

  it("reduces the spread of outcomes across up and down moves", () => {
    const spread = (ratio: number): number => {
      const up = runPassiveLp({ ...base, hedgeRatioPct: ratio }, ramp(400, 1.4), 0.02).returnPct;
      const down = runPassiveLp({ ...base, hedgeRatioPct: ratio }, ramp(400, 0.6), 0.02).returnPct;
      return Math.abs(up - down);
    };
    // That is what hedging buys: less dependence on direction.
    expect(spread(100)).toBeLessThan(spread(0));
  });

  it("charges borrow interest and swap costs for the short", () => {
    const r = runPassiveLp({ ...base, hedgeRatioPct: 100 }, ramp(400, 1.0), 0.02);
    expect(r.hedgeCostUsd).toBeGreaterThan(0);
    expect(r.hedgeRebalances).toBeGreaterThan(0);
  });

  it("costs money in a flat market, where there is nothing to hedge", () => {
    const flat = ramp(400, 1.0);
    const un = runPassiveLp({ ...base, hedgeRatioPct: 0 }, flat, 0.02);
    const hedged = runPassiveLp({ ...base, hedgeRatioPct: 100 }, flat, 0.02);
    expect(hedged.returnPct).toBeLessThan(un.returnPct);
  });

  it("hedges nothing while deployed when limited to the parked leg", () => {
    // No regime filter means the bot never parks, so a parked-only hedge has
    // no exposure to cover. This is the shipped live behaviour.
    const r = runPassiveLp(
      { ...base, hedgeRatioPct: 100, hedgeWhileParkedOnly: true },
      ramp(400, 0.6),
      0.02,
    );
    expect(r.hedgePnlUsd).toBe(0);
  });
});
