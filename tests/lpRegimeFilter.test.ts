import { describe, expect, it } from "vitest";
import type { PricePoint } from "../src/data/provider.js";
import { assertLpReconciles, runPassiveLp } from "../src/lp/passiveLp.js";
import type { PassiveLpConfig } from "../src/lp/passiveLp.js";

const base: Omit<PassiveLpConfig, "regimeMaxMovePct"> = {
  initialUsdc: 10_000,
  initialEth: 0,
  rangePct: 5,
  recenterBufferPct: 50,
  recenterMinHours: 24,
  feeBps: 5,
  slippageBps: 3,
  referenceRangePct: 25,
  regimeLookbackPoints: 24,
  hedgeRatioPct: 0,
  hedgeBorrowAprPct: 3,
  hedgeWhileParkedOnly: false,
  regimeMetric: "displacement" as const,
};

/** Flat for `calm` points, then a steady one-way ramp. */
function calmThenCrash(calm: number, crash: number, dropPct = 40): PricePoint[] {
  const out: PricePoint[] = [];
  const start = 1_700_000_000;
  for (let i = 0; i < calm; i++) {
    out.push({ timestamp: start + i * 3600, price: 3000, feeAprPct: 50 });
  }
  for (let i = 0; i < crash; i++) {
    const f = 1 - (dropPct / 100) * ((i + 1) / crash);
    out.push({ timestamp: start + (calm + i) * 3600, price: 3000 * f, feeAprPct: 50 });
  }
  return out;
}

describe("LP regime filter", () => {
  it("is inert when disabled", () => {
    const data = calmThenCrash(100, 300);
    const off = runPassiveLp({ ...base, regimeMaxMovePct: 0 }, data, 0.02);
    expect(off.timeParkedPct).toBe(0);
    expect(off.parkEvents).toBe(0);
  });

  it("stands aside during a sustained move", () => {
    const data = calmThenCrash(100, 300);
    const on = runPassiveLp({ ...base, regimeMaxMovePct: 5 }, data, 0.02);
    expect(on.parkEvents).toBeGreaterThan(0);
    expect(on.timeParkedPct).toBeGreaterThan(0);
  });

  it("cuts the loss of a one-way crash", () => {
    const data = calmThenCrash(100, 300, 50);
    const off = runPassiveLp({ ...base, regimeMaxMovePct: 0 }, data, 0.02);
    const on = runPassiveLp({ ...base, regimeMaxMovePct: 5 }, data, 0.02);
    expect(on.returnPct).toBeGreaterThan(off.returnPct);
  });

  it("keeps the accounting identity with the filter active", () => {
    for (const threshold of [0, 2, 5, 10, 25]) {
      const r = runPassiveLp({ ...base, regimeMaxMovePct: threshold }, calmThenCrash(100, 300), 0.02);
      expect(() => assertLpReconciles(r)).not.toThrow();
      expect(Math.abs(r.residual)).toBeLessThan(1e-6);
    }
  });

  it("earns no fees while parked", () => {
    // Everything after the calm prefix is a big move, so a tight threshold
    // parks and stays parked; fee income must stop accruing there.
    const data = calmThenCrash(50, 400, 60);
    const on = runPassiveLp({ ...base, regimeMaxMovePct: 2 }, data, 0.02);
    const off = runPassiveLp({ ...base, regimeMaxMovePct: 0 }, data, 0.02);
    expect(on.timeParkedPct).toBeGreaterThan(20);
    expect(on.feeIncomeUsd).toBeLessThan(off.feeIncomeUsd);
  });

  it("charges swap cost and gas for standing aside", () => {
    const data = calmThenCrash(100, 300);
    const on = runPassiveLp({ ...base, regimeMaxMovePct: 5 }, data, 0.02);
    expect(on.gasUsd).toBeGreaterThan(0);
    expect(on.swapCostUsd).toBeGreaterThan(0);
  });

  it("is causal: a future move cannot park the position early", () => {
    // Two series identical up to the crash point. The regime decision at any
    // index may only depend on prices at or before it, so the samples before
    // the divergence must match exactly.
    const calm = 200;
    const a = calmThenCrash(calm, 200, 40);
    const b = calmThenCrash(calm, 200, 80);
    const ra = runPassiveLp({ ...base, regimeMaxMovePct: 5 }, a, 0.02);
    const rb = runPassiveLp({ ...base, regimeMaxMovePct: 5 }, b, 0.02);
    for (let i = 0; i < calm; i++) {
      expect(rb.samples[i]!.parked).toBe(ra.samples[i]!.parked);
      expect(rb.samples[i]!.portfolioValue).toBeCloseTo(ra.samples[i]!.portfolioValue, 9);
    }
  });

  it("holds no ETH while parked", () => {
    const on = runPassiveLp({ ...base, regimeMaxMovePct: 5 }, calmThenCrash(100, 300), 0.02);
    for (const s of on.samples) {
      if (s.parked) expect(s.eth).toBe(0);
    }
  });

  it("respects the dwell time between park changes", () => {
    // Alternating regime with a 24h dwell cannot flip on every hourly point.
    const data: PricePoint[] = [];
    const start = 1_700_000_000;
    for (let i = 0; i < 600; i++) {
      data.push({
        timestamp: start + i * 3600,
        price: 3000 * (1 + 0.09 * Math.sin(i / 3)),
        feeAprPct: 50,
      });
    }
    const r = runPassiveLp({ ...base, regimeMaxMovePct: 5 }, data, 0.02);
    // At most one state change per 24h over 600 hours.
    expect(r.parkEvents).toBeLessThanOrEqual(Math.ceil(600 / 24));
  });
});
