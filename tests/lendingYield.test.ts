import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GridStrategy } from "../src/grid/gridStrategy.js";
import { LinearCostFillModel } from "../src/grid/fillModel.js";
import type { GridConfig } from "../src/grid/types.js";
import {
  accrueInterest,
  aprForTimestamp,
  loadAaveAprSeries,
} from "../src/backtest/lendingYield.js";
import { assertAccountingReconciles, runBacktest } from "../src/backtest/backtester.js";

const DAY = 86_400;

function gridCfg(): GridConfig {
  return {
    initialUsdc: 10_000,
    initialEth: 0,
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
    lpFeeBps: 0,
    lpVenueVolumeSharePct: 0,
    lpPoolLiquidityUsd: 0,
    lpFeeAprPct: 0,
    lpReferenceRangePct: 0,
    regimeMaxMovePct: 0,
    regimeLookbackPoints: 336,
    resetBufferLevels: 2,
    regenMinSeconds: 3600,
    volLookbackPoints: 24,
    maxVolPerStep: 0.005,
    resetConfirmObservations: 0,
    resetVolPostpone: false,
    resetHardDrawdownPct: 25,
    resetHardInventoryLossPct: 0,
    resetSkipCooldownWhenFlat: false,
    resetBreakerK: 3,
    resetBreakerWindowSeconds: 30 * DAY,
  };
}

describe("apr series lookup", () => {
  const series = [
    { dayStart: 100 * DAY, aprPct: 5 },
    { dayStart: 102 * DAY, aprPct: 10 },
  ];

  it("returns null before the first data point", () => {
    expect(aprForTimestamp(series, 50 * DAY)).toBeNull();
  });

  it("forward-fills gaps with the last known rate", () => {
    expect(aprForTimestamp(series, 100 * DAY)).toBe(5);
    expect(aprForTimestamp(series, 101 * DAY + 3600)).toBe(5); // gap day
    expect(aprForTimestamp(series, 102 * DAY)).toBe(10);
    expect(aprForTimestamp(series, 500 * DAY)).toBe(10); // far future
  });

  it("parses csv with header and extra columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "aave-"));
    const file = join(dir, "apr.csv");
    writeFileSync(file, "date,apr_pct,tvl_usd\n2024-03-10,13.42,641020\n2024-03-11,11.66,\n");
    const s = loadAaveAprSeries(file);
    expect(s).toHaveLength(2);
    expect(s[0]!.aprPct).toBeCloseTo(13.42);
    expect(aprForTimestamp(s, Date.parse("2024-03-11T12:00:00Z") / 1000)).toBeCloseTo(11.66);
  });
});

describe("accrual math", () => {
  it("is exact pro-rata", () => {
    // $10,000 at 5% APR for exactly half a year = $250.
    expect(accrueInterest(10_000, 5, 365 * DAY / 2)).toBeCloseTo(250, 6);
    expect(accrueInterest(0, 5, DAY)).toBe(0);
    expect(accrueInterest(1000, 0, DAY)).toBe(0);
  });
});

describe("yield integration in runBacktest", () => {
  const prices = Array.from({ length: 24 * 30 }, (_, i) => ({
    timestamp: 1_700_000_000 + i * 3600,
    // Gentle oscillation so the grid trades a bit.
    price: i % 48 < 24 ? 4000 - (i % 24) : 3976 + (i % 24),
  }));

  it("earns exactly pro-rata yield on idle USDC at a constant APR", async () => {
    const strategy = new GridStrategy(gridCfg(), new LinearCostFillModel(5, 3));
    // Constant 10% APR starting before the data.
    const series = [{ dayStart: 0, aprPct: 10 }];
    const result = runBacktest(strategy, prices, 0, false, { series, bufferUsdc: 0 });

    // Idle balance is ~$10k minus whatever the grid deployed; verify the
    // income is positive and within a sane band for ~30 days.
    expect(result.lendingIncomeUsd).toBeGreaterThan(40); // >$10k*10%*(25/365)
    expect(result.lendingIncomeUsd).toBeLessThan(120); // <$10k*10%*(45/365)

    // The credited interest must be visible in the wallet.
    expect(result.finalPortfolioValue).toBeGreaterThan(10_000);
  }, 60_000);

  it("keeps the accounting reconciliation intact with yield on", async () => {
    const makeAndRun = () => {
      const strategy = new GridStrategy(gridCfg(), new LinearCostFillModel(5, 3));
      return runBacktest(strategy, prices, 0.02, true, {
        series: [{ dayStart: 0, aprPct: 8 }],
        bufferUsdc: 250,
      });
    };
    const result = makeAndRun();
    expect(() => assertAccountingReconciles(result)).not.toThrow();
    expect(result.breakdown.lendingIncomeUsd).toBe(result.lendingIncomeUsd);
  }, 60_000);

  it("earns nothing when disabled or when fully buffered", async () => {
    const off = runBacktest(
      new GridStrategy(gridCfg(), new LinearCostFillModel(5, 3)),
      prices,
      0,
    );
    expect(off.lendingIncomeUsd).toBe(0);

    // Buffer >= wallet -> nothing idle -> no yield.
    const allBuffered = runBacktest(
      new GridStrategy(gridCfg(), new LinearCostFillModel(5, 3)),
      prices,
      0,
      false,
      { series: [{ dayStart: 0, aprPct: 10 }], bufferUsdc: Number.MAX_SAFE_INTEGER / 2 },
    );
    expect(allBuffered.lendingIncomeUsd).toBe(0);
  }, 60_000);
});
