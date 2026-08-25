import { describe, expect, it } from "vitest";
import { GridStrategy } from "../src/grid/gridStrategy.js";
import { LinearCostFillModel } from "../src/grid/fillModel.js";
import { assertAccountingReconciles, runBacktest } from "../src/backtest/backtester.js";
import type { GridConfig } from "../src/grid/types.js";
import type { PricePoint } from "../src/data/provider.js";

function makeConfig(overrides: Partial<GridConfig> = {}): GridConfig {
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
    resetBufferLevels: 2,
    resetSellFraction: 1,
    resetUnderwaterSkipPct: 0,
    lpFeeBps: 5,
    lpVenueVolumeSharePct: 5,
    lpPoolLiquidityUsd: 0,
    lpFeeAprPct: 0,
    lpReferenceRangePct: 0,
    regimeMaxMovePct: 0,
    regimeLookbackPoints: 336,
    regenMinSeconds: 3600,
    volLookbackPoints: 24,
    maxVolPerStep: 0.005,
    resetConfirmObservations: 0,
    resetVolPostpone: false,
    resetHardDrawdownPct: 25,
    resetHardInventoryLossPct: 0,
    resetSkipCooldownWhenFlat: false,
    resetBreakerK: 3,
    resetBreakerWindowSeconds: 30 * 24 * 3600,
    ...overrides,
  };
}

const T0 = 1_700_000_000;
const H = 3600;

/** Deterministic pseudo-random walk — no Math.random in tests. */
function walk(steps: number, start = 4000, drift = 0, amplitude = 0.006): PricePoint[] {
  const points: PricePoint[] = [];
  let price = start;
  let seed = 12345;
  for (let i = 0; i < steps; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const u = seed / 2147483648 - 0.5;
    price *= 1 + drift + u * amplitude * 2;
    points.push({ timestamp: T0 + i * H, price });
  }
  return points;
}

function run(data: PricePoint[], overrides: Partial<GridConfig> = {}, gas = 0.02) {
  const cfg = makeConfig({ centerPrice: data[0]!.price, ...overrides });
  const strategy = new GridStrategy(cfg, new LinearCostFillModel(cfg.feeBps, cfg.slippageBps));
  return runBacktest(strategy, data, gas);
}

describe("accounting reconciliation", () => {
  it("decomposes the portfolio value exactly on a choppy path", () => {
    const result = run(walk(1200));
    expect(() => assertAccountingReconciles(result)).not.toThrow();
    expect(Math.abs(result.breakdown.residual)).toBeLessThan(1e-6);
  });

  it("reconciles through a sustained downtrend with resets", () => {
    const result = run(walk(2000, 4000, -0.0015));
    expect(result.resets.length).toBeGreaterThan(0);
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });

  it("reconciles through a sustained uptrend", () => {
    const result = run(walk(2000, 4000, 0.0015));
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });

  it("reconciles when the run starts with pre-existing ETH", () => {
    const data = walk(800);
    const result = run(data, { initialEth: 1.5 });
    // Initial capital must be measured at the FIRST observed price.
    expect(result.initialCapital).toBeCloseTo(10_000 + 1.5 * data[0]!.price, 6);
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });

  it("reconciles with resets disabled", () => {
    // Both triggers off: band exits AND the drawdown backstop, which fires
    // independently of resetBufferLevels.
    const result = run(walk(1500, 4000, -0.001), {
      resetBufferLevels: 0,
      resetHardDrawdownPct: 0,
    });
    expect(result.resets).toHaveLength(0);
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });

  it("fires the drawdown backstop even when re-centring is disabled", () => {
    // A backstop that only works when a reset was already going to happen is
    // not a backstop. resetBufferLevels = 0 disables re-centring; the
    // circuit breaker must still protect the book.
    const result = run(walk(1500, 4000, -0.001), {
      resetBufferLevels: 0,
      resetHardDrawdownPct: 25,
    });
    expect(result.resets.length).toBeGreaterThan(0);
    expect(result.resets.every((r) => r.reason === "INVENTORY_LIMIT")).toBe(true);
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });

  it("reconciles with zero costs", () => {
    const result = run(walk(1000), { feeBps: 0, slippageBps: 0 }, 0);
    expect(result.totalFeeUsd).toBe(0);
    expect(result.totalSlippageUsd).toBe(0);
    expect(result.totalGasUsd).toBe(0);
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });

  it("detects a broken decomposition", () => {
    const result = run(walk(600));
    // Corrupt one component: the assertion exists precisely to catch this.
    const broken = {
      ...result,
      breakdown: { ...result.breakdown, residual: 5 },
    };
    expect(() => assertAccountingReconciles(broken)).toThrow(/reconciliation failed/);
  });
});

describe("P&L sources stay distinct", () => {
  it("keeps fees and slippage out of grid P&L", () => {
    const cfg = makeConfig({ feeBps: 5, slippageBps: 3 });
    const s = new GridStrategy(cfg, new LinearCostFillModel(5, 3));
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(3960, T0 + H); // buy at level -1
    s.onPriceUpdate(4000, T0 + 2 * H); // sell at level 0
    const st = s.getState();
    // Gross grid profit is one spacing on the traded notional, measured at
    // level prices: costs must not shrink it.
    const lotNotional = st.trades[0]!.ethAmount * st.trades[0]!.levelPrice;
    expect(st.realizedGridGrossUsd).toBeCloseTo(lotNotional * 0.01, 6);
    expect(st.realizedResetGrossUsd).toBe(0);
    expect(st.totalFeeUsd).toBeGreaterThan(0);
    expect(st.totalSlippageUsd).toBeGreaterThan(0);
  });

  it("books liquidation P&L as reset P&L, never as grid P&L", () => {
    const s = new GridStrategy(
      makeConfig({ feeBps: 0, slippageBps: 0, regenMinSeconds: 10 * H }),
      new LinearCostFillModel(0, 0),
    );
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(3900, T0 + H); // buys
    expect(s.getState().realizedGridGrossUsd).toBe(0);

    // Crash straight out of the band: the remaining buy levels fill on the
    // way down, then everything is dumped at 3000.
    s.onPriceUpdate(3000, T0 + 2 * H);
    const st = s.getState();
    expect(st.eth).toBe(0);
    expect(st.resetRecords).toHaveLength(1);
    // Only BUY levels were crossed on the way down, so no grid cycle closed.
    expect(st.realizedGridGrossUsd).toBe(0);
    const record = st.resetRecords[0]!;
    expect(record.realizedResetPnlUsd).toBeCloseTo(
      record.ethInventoryBefore * 3000 - record.ethCostBasisUsd,
      6,
    );
    expect(st.realizedResetGrossUsd).toBeCloseTo(record.realizedResetPnlUsd, 6);
    expect(st.realizedResetGrossUsd).toBeLessThan(0);
  });

  it("records the cost basis and reason of every reset", () => {
    const result = run(walk(2000, 4000, -0.0015));
    for (const r of result.resets) {
      // Band exits report PRICE_OUTSIDE_GRID; the drawdown backstop reports
      // INVENTORY_LIMIT, and both can occur in one run.
      expect(["PRICE_OUTSIDE_GRID", "INVENTORY_LIMIT"]).toContain(r.reason);
      expect(r.id).toBeGreaterThan(0);
      expect(r.oldBounds.lower).toBeLessThan(r.oldBounds.upper);
      if (r.ethInventoryBefore > 0) {
        expect(r.ethAvgCostPrice).toBeGreaterThan(0);
        expect(r.ethCostBasisUsd).toBeCloseTo(r.ethInventoryBefore * r.ethAvgCostPrice, 6);
        expect(r.usdcRecovered).toBeGreaterThan(0);
      }
      expect(r.portfolioValueBefore).toBeGreaterThan(0);
      expect(r.drawdownBeforePct).toBeLessThanOrEqual(0);
    }
  });

  it("matches per-reset interval aggregates to the trade ledger", () => {
    const result = run(walk(2500, 4000, -0.0012));
    const trades = result.strategy.getState().trades;
    expect(result.resets.length).toBeGreaterThan(0);
    for (const r of result.resets) {
      const interval = trades.filter((t) => t.intervalId === r.id - 1);
      const fees = interval.reduce((a, t) => a + t.feeUsd, 0);
      const gas = interval.reduce((a, t) => a + t.gasUsd, 0);
      expect(r.feesSincePrevUsd).toBeCloseTo(fees, 9);
      expect(r.gasSincePrevUsd).toBeCloseTo(gas, 9);
    }
    // Every trade belongs to exactly one interval, and the sum of the grid
    // components across intervals is the total grid P&L.
    const gridTotal = trades.reduce((a, t) => a + (t.realizedGridGrossUsd ?? 0), 0);
    expect(gridTotal).toBeCloseTo(result.gridPnlUsd, 6);
    const resetTotal = trades.reduce((a, t) => a + (t.realizedResetGrossUsd ?? 0), 0);
    expect(resetTotal).toBeCloseTo(result.resetPnlUsd, 6);
  });
});

describe("inventory analytics", () => {
  it("tracks inventory extremes over the run", () => {
    const result = run(walk(1500, 4000, -0.001));
    const inv = result.inventory;
    expect(inv.maxEth).toBeGreaterThan(0);
    expect(inv.avgEth).toBeGreaterThan(0);
    expect(inv.avgEth).toBeLessThanOrEqual(inv.maxEth);
    expect(inv.maxEthExposurePct).toBeGreaterThan(0);
    expect(inv.maxEthExposurePct).toBeLessThanOrEqual(100);
    expect(inv.avgEthExposurePct).toBeLessThanOrEqual(inv.maxEthExposurePct);
    expect(inv.maxCostBasisUsd).toBeGreaterThan(0);
    expect(inv.maxUsdcUsd).toBeGreaterThan(0);

    // Every sample must satisfy portfolio = usdc + eth * price.
    for (const s of result.samples) {
      expect(s.portfolioValue).toBeCloseTo(s.usdc + s.eth * s.price, 9);
    }
  });
});

describe("reset liquidation policy", () => {
  /** Buy inventory, then crash out of the band in one step. */
  function crashOut(overrides: Partial<GridConfig>) {
    const cfg = makeConfig({ feeBps: 0, slippageBps: 0, regenMinSeconds: 100 * H, ...overrides });
    const s = new GridStrategy(cfg, new LinearCostFillModel(0, 0));
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(3900, T0 + H); // fills several BUY levels
    s.onPriceUpdate(3000, T0 + 2 * H); // exits the band -> reset
    return s;
  }

  it("dumps the whole inventory by default", () => {
    const st = crashOut({}).getState();
    expect(st.eth).toBe(0);
    const r = st.resetRecords[0]!;
    expect(r.ethCarried).toBe(0);
    expect(r.ethLiquidated).toBeCloseTo(r.ethInventoryBefore, 9);
    expect(r.carryReason).toBe("NONE");
  });

  it("sells only the configured fraction", () => {
    const st = crashOut({ resetSellFraction: 0.25 }).getState();
    const r = st.resetRecords[0]!;
    expect(r.ethLiquidated).toBeCloseTo(r.ethInventoryBefore * 0.25, 9);
    expect(r.ethCarried).toBeCloseTo(r.ethInventoryBefore * 0.75, 9);
    expect(r.carryReason).toBe("PARTIAL_POLICY");
    // Carried inventory keeps its cost basis, so it is unrealized, not lost.
    expect(st.eth).toBeCloseTo(r.ethCarried, 9);
    expect(st.costBasisUsd).toBeGreaterThan(0);
  });

  it("carries everything when too far underwater", () => {
    // Bought around 3900, dumping at 3000 is ~23% underwater.
    const st = crashOut({ resetUnderwaterSkipPct: 10 }).getState();
    const r = st.resetRecords[0]!;
    expect(r.carryReason).toBe("UNDERWATER");
    expect(r.ethLiquidated).toBe(0);
    expect(r.realizedResetPnlUsd).toBe(0);
    expect(st.eth).toBeCloseTo(r.ethInventoryBefore, 9);
  });

  it("still liquidates when the position is only slightly underwater", () => {
    const st = crashOut({ resetUnderwaterSkipPct: 90 }).getState();
    expect(st.resetRecords[0]!.carryReason).toBe("NONE");
    expect(st.eth).toBe(0);
  });

  it("reconciles under every policy", () => {
    for (const overrides of [
      {},
      { resetSellFraction: 0.5 },
      { resetSellFraction: 0 },
      { resetUnderwaterSkipPct: 10 },
      { resetSellFraction: 0.25, resetUnderwaterSkipPct: 20 },
    ]) {
      const result = run(walk(2000, 4000, -0.0015), { maxVolPerStep: 1, ...overrides });
      expect(() => assertAccountingReconciles(result)).not.toThrow();
    }
  });

  it("moves the loss between buckets rather than removing it", () => {
    // The carried inventory is still sold eventually — by the NEXT grid — so
    // a carry policy relabels reset P&L as grid P&L instead of avoiding it.
    const data = walk(2000, 4000, -0.0015);
    const dumped = run(data, { maxVolPerStep: 1 });
    // Backstop disabled: this test isolates carry accounting semantics.
    const carried = run(data, { maxVolPerStep: 1, resetSellFraction: 0, resetHardDrawdownPct: 0 });
    expect(carried.resetPnlUsd).toBe(0);
    expect(carried.gridPnlUsd).toBeLessThan(dumped.gridPnlUsd);
    // And it raises exposure, which is the risk the reset exists to bound.
    // Peak exposure saturates near 100% under both policies in a deep
    // downtrend, so the discriminating measure is the average.
    expect(carried.inventory.avgEthExposurePct).toBeGreaterThan(
      dumped.inventory.avgEthExposurePct,
    );
  });
  it("hard-drawdown backstop force-liquidates a carried position", () => {
    // Carry everything (fraction 0) with underwater-skip; the backstop must
    // still cap the damage in a deep trend.
    const data = walk(2000, 4000, -0.0015);
    const withoutBackstop = run(data, {
      maxVolPerStep: 1,
      resetSellFraction: 0,
      resetHardDrawdownPct: 0,
      resetUnderwaterSkipPct: 50,
    });
    const withBackstop = run(data, {
      maxVolPerStep: 1,
      resetSellFraction: 0,
      resetHardDrawdownPct: 25,
      resetUnderwaterSkipPct: 50,
    });
    expect(withoutBackstop.resetPnlUsd).toBe(0);
    expect(withBackstop.resetPnlUsd).toBeLessThan(0); // forced liquidations happened
    // The backstop trades realized losses for lower exposure: in a deep
    // trend it bounds PER-POSITION loss, so total drawdown shrinks and more
    // capital survives.
    expect(withBackstop.maxDrawdownPct).toBeGreaterThan(withoutBackstop.maxDrawdownPct);
    expect(withBackstop.finalPortfolioValue).toBeGreaterThan(
      withoutBackstop.finalPortfolioValue,
    );
    expect(withBackstop.inventory.avgEthExposurePct).toBeLessThan(
      withoutBackstop.inventory.avgEthExposurePct,
    );
  });
});

describe("LP fee income", () => {
  /** Flat price with steady volume: nothing trades, fees still accrue. */
  function flatWithVolume(steps: number, volumeUsd: number): PricePoint[] {
    return Array.from({ length: steps }, (_, i) => ({
      timestamp: T0 + i * H,
      price: 4000,
      volumeUsd,
    }));
  }

  it("earns nothing when capture is zero (the default)", () => {
    const data = flatWithVolume(100, 1_000_000);
    const cfg = makeConfig({
      executionMode: "lp", centerPrice: 4000 });
    const s = new GridStrategy(cfg, new LinearCostFillModel(5, 3));
    const result = runBacktest(s, data, 0.02);
    expect(result.feeIncomeUsd).toBe(0);
    expect(result.finalPortfolioValue).toBeCloseTo(result.initialCapital, 9);
  });

  it("accrues a pro-rata share of the pool's fees while in range", () => {
    const data = flatWithVolume(100, 1_000_000);
    const cfg = makeConfig({
      executionMode: "lp",
      centerPrice: 4000,
      lpFeeBps: 5,
      lpVenueVolumeSharePct: 10,
      lpPoolLiquidityUsd: 90_000,
    });
    const s = new GridStrategy(cfg, new LinearCostFillModel(5, 3));
    const result = runBacktest(s, data, 0.02);
    // Pool volume = 10% of $1M = $100k; pool fees at 5bps = $50.
    // Deployed capital is $5,000 (5 BUY levels x $1,000), so our share is
    // 5000/(5000+90000) = 5.26% -> ~$2.63 per observation. The first
    // observation is the initialization tick and does not accrue.
    expect(result.feeIncomeUsd).toBeGreaterThan(99 * 2.6);
    expect(result.feeIncomeUsd).toBeLessThan(99 * 2.8);
  });

  it("scales fee income with the capital actually deployed", () => {
    // The whole point of the pro-rata term: ten times the capital in the
    // same pool earns materially more, not the same.
    const data = flatWithVolume(100, 1_000_000);
    const lp = { lpFeeBps: 5, lpVenueVolumeSharePct: 10, lpPoolLiquidityUsd: 1_000_000 };
    const income = (initialUsdc: number) => {
      const cfg = makeConfig({
      executionMode: "lp",
        centerPrice: 4000,
        initialUsdc,
        orderSizeUsd: initialUsdc / 10,
        ...lp,
      });
      return runBacktest(
        new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
        data,
        0,
      ).feeIncomeUsd;
    };
    const small = income(10_000);
    const large = income(100_000);
    expect(large).toBeGreaterThan(small * 8);
  });

  it("dilutes as the competing pool liquidity grows", () => {
    const data = flatWithVolume(100, 1_000_000);
    const income = (pool: number) => {
      const cfg = makeConfig({
      executionMode: "lp",
        centerPrice: 4000,
        lpFeeBps: 5,
        lpVenueVolumeSharePct: 10,
        lpPoolLiquidityUsd: pool,
      });
      return runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), data, 0)
        .feeIncomeUsd;
    };
    expect(income(10_000_000)).toBeLessThan(income(100_000) / 10);
  });

  it("earns nothing while price is outside the grid band", () => {
    // Price parked far above the band: no liquidity in range, no fees.
    const data = Array.from({ length: 50 }, (_, i) => ({
      timestamp: T0 + i * H,
      price: 40_000,
      volumeUsd: 1_000_000,
    }));
    const cfg = makeConfig({
      executionMode: "lp",
      centerPrice: 4000,
      lpVenueVolumeSharePct: 10,
      lpPoolLiquidityUsd: 100_000,
      resetBufferLevels: 0,
    });
    const s = new GridStrategy(cfg, new LinearCostFillModel(5, 3));
    expect(runBacktest(s, data, 0).feeIncomeUsd).toBe(0);
  });

  it("keeps fee income out of grid P&L and reconciles", () => {
    const data = walk(1500, 4000, -0.0008).map((p, i) => ({
      ...p,
      volumeUsd: 2_000_000 + i,
    }));
    const cfg = makeConfig({
      executionMode: "lp",
      centerPrice: data[0]!.price,
      lpVenueVolumeSharePct: 10,
      lpPoolLiquidityUsd: 100_000,
      maxVolPerStep: 1,
    });
    const s = new GridStrategy(cfg, new LinearCostFillModel(5, 3));
    const result = runBacktest(s, data, 0.02);
    expect(result.feeIncomeUsd).toBeGreaterThan(0);
    // Fee income is a separate term in the identity, not part of grid P&L.
    expect(result.breakdown.feeIncomeUsd).toBe(result.feeIncomeUsd);
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });
});

describe("causal regime filter", () => {
  it("is off by default", () => {
    const result = run(walk(1200, 4000, -0.002));
    expect(result.resets.every((r) => r.reason !== "REGIME_FILTER")).toBe(true);
  });

  it("stands the grid down on a large trailing move", () => {
    const result = run(walk(1500, 4000, -0.002), {
      maxVolPerStep: 1,
      regimeMaxMovePct: 15,
      regimeLookbackPoints: 100,
    });
    expect(result.resets.some((r) => r.reason === "REGIME_FILTER")).toBe(true);
  });

  it("uses only past observations", () => {
    // Calm for a long stretch, then a violent move at the very end. The
    // filter must not have reacted before the move existed in the data.
    const calm: PricePoint[] = Array.from({ length: 400 }, (_, i) => ({
      timestamp: T0 + i * H,
      price: 4000,
    }));
    const crash: PricePoint[] = Array.from({ length: 60 }, (_, i) => ({
      timestamp: T0 + (400 + i) * H,
      price: 4000 * (1 - 0.01 * (i + 1)),
    }));
    const result = run([...calm, ...crash], {
      centerPrice: 4000,
      maxVolPerStep: 1,
      regimeMaxMovePct: 20,
      regimeLookbackPoints: 50,
      resetBufferLevels: 0,
    });
    const triggered = result.resets.filter((r) => r.reason === "REGIME_FILTER");
    expect(triggered.length).toBeGreaterThan(0);
    // Every trigger must land after the calm stretch ended.
    for (const r of triggered) expect(r.timestamp).toBeGreaterThanOrEqual(T0 + 400 * H);
  });

  it("reconciles with the filter active", () => {
    const result = run(walk(2000, 4000, -0.0015), {
      maxVolPerStep: 1,
      regimeMaxMovePct: 10,
      regimeLookbackPoints: 120,
    });
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });
});

describe("APR-calibrated fee income", () => {
  function flat(steps: number, feeAprPct?: number): PricePoint[] {
    return Array.from({ length: steps }, (_, i) => ({
      timestamp: T0 + i * H,
      price: 4000,
      ...(feeAprPct === undefined ? {} : { feeAprPct }),
    }));
  }

  it("earns the configured APR, time-weighted", () => {
    // 100 hourly observations; the first is the init tick, so 99 hours accrue.
    const cfg = makeConfig({
      executionMode: "lp", centerPrice: 4000, lpFeeAprPct: 50 });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      flat(100),
      0,
    );
    // Deployed capital, not the whole balance: 5 BUY levels x $1,000.
    const deployed = 5 * 1000;
    const expected = deployed * 0.5 * ((99 * H) / (365 * 24 * H));
    expect(result.feeIncomeUsd).toBeGreaterThan(expected * 0.99);
    expect(result.feeIncomeUsd).toBeLessThan(expected * 1.01);
  });

  it("is independent of the sampling interval", () => {
    // The same wall-clock span sampled hourly vs every 4 hours must pay the
    // same fees; otherwise the model rewards denser data.
    const income = (stepHours: number) => {
      const steps = Math.floor(400 / stepHours) + 1;
      const data: PricePoint[] = Array.from({ length: steps }, (_, i) => ({
        timestamp: T0 + i * stepHours * H,
        price: 4000,
      }));
      const cfg = makeConfig({
      executionMode: "lp", centerPrice: 4000, lpFeeAprPct: 50 });
      return runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), data, 0)
        .feeIncomeUsd;
    };
    expect(income(4)).toBeCloseTo(income(1), 1);
  });

  it("prefers a per-observation APR over the configured constant", () => {
    const cfg = makeConfig({
      executionMode: "lp", centerPrice: 4000, lpFeeAprPct: 10 });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      flat(100, 100), // data says 100% APR, config says 10%
      0,
    );
    const expected = 5 * 1000 * 1.0 * ((99 * H) / (365 * 24 * H));
    expect(result.feeIncomeUsd).toBeGreaterThan(expected * 0.9);
  });

  it("dilutes a position that is large relative to the pool", () => {
    const income = (pool: number) => {
      const cfg = makeConfig({
      executionMode: "lp",
        centerPrice: 4000,
        lpFeeAprPct: 50,
        lpPoolLiquidityUsd: pool,
      });
      return runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), flat(100), 0)
        .feeIncomeUsd;
    };
    // $5k deployed against a $5k pool roughly halves the rate; against a
    // $100M pool the dilution is negligible.
    expect(income(5_000)).toBeLessThan(income(100_000_000) * 0.55);
    expect(income(5_000)).toBeGreaterThan(income(100_000_000) * 0.45);
  });

  it("reconciles with APR-based income", () => {
    const data = walk(1500, 4000, -0.0008).map((p) => ({ ...p, feeAprPct: 60 }));
    const cfg = makeConfig({
      executionMode: "lp", centerPrice: data[0]!.price, maxVolPerStep: 1 });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      data,
      0.02,
    );
    expect(result.feeIncomeUsd).toBeGreaterThan(0);
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });
});

describe("pool dilution from the APR series", () => {
  it("scales income down when the position rivals the pool", () => {
    const income = (poolTvlUsd: number) => {
      const data: PricePoint[] = Array.from({ length: 100 }, (_, i) => ({
        timestamp: T0 + i * H,
        price: 4000,
        feeAprPct: 50,
        poolTvlUsd,
      }));
      const cfg = makeConfig({
      executionMode: "lp", centerPrice: 4000 });
      return runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), data, 0)
        .feeIncomeUsd;
    };
    // $5k deployed: against a $5k pool it earns ~half the published rate;
    // against a $100M pool essentially all of it.
    const deep = income(100_000_000);
    expect(income(5_000)).toBeLessThan(deep * 0.55);
    expect(income(5_000)).toBeGreaterThan(deep * 0.45);
    expect(income(20_000_000)).toBeGreaterThan(deep * 0.99);
  });
});

describe("fee income accrues only on deployed capital", () => {
  function flat(steps: number, aprPct: number): PricePoint[] {
    return Array.from({ length: steps }, (_, i) => ({
      timestamp: T0 + i * H,
      price: 4000,
      feeAprPct: aprPct,
    }));
  }

  it("pays nothing on idle cash", () => {
    // Same capital, same APR, different order sizes. A grid committing 5
    // orders of $100 must not earn what one committing 5 orders of $1,000
    // earns — the rest of the balance is in the wallet, not the pool.
    const income = (orderSizeUsd: number) => {
      const cfg = makeConfig({
      executionMode: "lp", centerPrice: 4000, orderSizeUsd });
      return runBacktest(
        new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
        flat(200, 50),
        0,
      ).feeIncomeUsd;
    };
    const small = income(100);
    const large = income(1000);
    expect(large).toBeGreaterThan(small * 9);
  });

  it("never credits more than the portfolio is worth", () => {
    // Order size far larger than the balance: committed capital is capped.
    const cfg = makeConfig({
      executionMode: "lp", centerPrice: 4000, orderSizeUsd: 100_000 });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      flat(200, 100),
      0,
    );
    const ceiling = 10_000 * 1.0 * ((199 * H) / (365 * 24 * H)) * 1.05;
    expect(result.feeIncomeUsd).toBeLessThan(ceiling);
  });

  it("earns nothing while in cooldown", () => {
    // Drive the grid out of its band so it liquidates and cools down, then
    // hold price steady far away: no liquidity deployed, no fees.
    const data: PricePoint[] = [
      { timestamp: T0, price: 4000, feeAprPct: 100 },
      ...Array.from({ length: 100 }, (_, i) => ({
        timestamp: T0 + (i + 1) * H,
        price: 8000,
        feeAprPct: 100,
      })),
    ];
    const cfg = makeConfig({
      executionMode: "lp", centerPrice: 4000, regenMinSeconds: 10_000 * H });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      data,
      0,
    );
    expect(result.feeIncomeUsd).toBe(0);
  });
});

describe("batched gas model", () => {
  /** One observation that crosses several BUY levels at once. */
  function bigDrop(): PricePoint[] {
    return [
      { timestamp: T0, price: 4000 },
      { timestamp: T0 + H, price: 3800 }, // crosses levels -1..-5
    ];
  }

  it("charges the flat model once per fill (unchanged default)", () => {
    const cfg = makeConfig({ centerPrice: 4000, resetBufferLevels: 0 });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      bigDrop(),
      0.02,
    );
    expect(result.buysExecuted).toBeGreaterThan(1);
    expect(result.totalGasUsd).toBeCloseTo(result.buysExecuted * 0.02, 9);
  });

  it("pays the transaction overhead once for a batch, not once per fill", () => {
    const cfg = makeConfig({ centerPrice: 4000, resetBufferLevels: 0 });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      bigDrop(),
      { txOverheadUsd: 1.0, perFillUsd: 0.02, lendingLegUsd: 0 },
    );
    const fills = result.buysExecuted;
    expect(fills).toBeGreaterThan(1);
    // One overhead for the whole batch — not `fills` overheads.
    expect(result.totalGasUsd).toBeCloseTo(1.0 + fills * 0.02, 9);
  });

  it("charges the money-market leg once per transaction", () => {
    const cfg = makeConfig({ centerPrice: 4000, resetBufferLevels: 0 });
    const withLending = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      bigDrop(),
      { txOverheadUsd: 0.1, perFillUsd: 0.02, lendingLegUsd: 0.5 },
      true,
    );
    const without = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      bigDrop(),
      { txOverheadUsd: 0.1, perFillUsd: 0.02, lendingLegUsd: 0.5 },
      false,
    );
    expect(withLending.totalGasUsd - without.totalGasUsd).toBeCloseTo(0.5, 9);
  });

  it("splits batched gas across the ledger so it still sums to the total", () => {
    const cfg = makeConfig({ centerPrice: 4000, resetBufferLevels: 0 });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      bigDrop(),
      { txOverheadUsd: 1.0, perFillUsd: 0.02, lendingLegUsd: 0.3 },
      true,
    );
    const ledgerGas = result.strategy
      .getState()
      .trades.reduce((sum, t) => sum + t.gasUsd, 0);
    expect(ledgerGas).toBeCloseTo(result.totalGasUsd, 9);
    expect(() => assertAccountingReconciles(result)).not.toThrow();
  });
});

describe("fee income and the volatility gate must agree", () => {
  it("earns no quote-side fees while buys are gated", () => {
    // A maker cannot collect fees on an order it would refuse to fill.
    // Choppy prices keep the gate shut; with a flat book there is no
    // inventory earning on the base side either, so income must be zero.
    const data: PricePoint[] = [{ timestamp: T0, price: 4000, feeAprPct: 100 }];
    let price = 4000;
    for (let i = 1; i <= 300; i++) {
      price *= i % 2 === 0 ? 0.97 : 1 / 0.97;
      data.push({ timestamp: T0 + i * H, price, feeAprPct: 100 });
    }
    const cfg = makeConfig({
      executionMode: "lp",
      centerPrice: 4000,
      spacingPercent: 20, // wide, so chop does not cross a level
      maxVolPerStep: 0.0001, // gate permanently shut
      volLookbackPoints: 4,
      resetBufferLevels: 0,
    });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      data,
      0,
    );
    // No buys happened, so nothing earns on the base side, and the gate
    // withdraws the quote side. The only income is the warm-up window before
    // volatility can be estimated at all, where the gate defaults open
    // exactly as `executeBuy` does — a handful of hours out of 300.
    const fullyDeployedForOneRun = 5 * 1000 * 1.0 * ((300 * H) / (365 * 24 * H));
    expect(result.feeIncomeUsd).toBeLessThan(fullyDeployedForOneRun * 0.03);
    expect(result.feeIncomeUsd).toBeGreaterThan(0);
  });

  it("earns fees again once the gate reopens", () => {
    const calm: PricePoint[] = Array.from({ length: 300 }, (_, i) => ({
      timestamp: T0 + i * H,
      price: 4000,
      feeAprPct: 100,
    }));
    const cfg = makeConfig({
      executionMode: "lp",
      centerPrice: 4000,
      maxVolPerStep: 1, // gate open
      volLookbackPoints: 4,
      resetBufferLevels: 0,
    });
    const result = runBacktest(
      new GridStrategy(cfg, new LinearCostFillModel(5, 3)),
      calm,
      0,
    );
    expect(result.feeIncomeUsd).toBeGreaterThan(0);
  });
});

describe("execution mode: taker vs lp", () => {
  /** Oscillate across the centre so grid levels fill repeatedly. */
  function oscillate(steps: number): PricePoint[] {
    return Array.from({ length: steps }, (_, i) => ({
      timestamp: T0 + i * H,
      price: i % 2 === 0 ? 4000 : 3960,
      feeAprPct: 50,
      poolTvlUsd: 20_000_000,
    }));
  }

  it("taker mode charges the pool fee on every grid fill", () => {
    const cfg = makeConfig({ centerPrice: 4000, executionMode: "taker", resetBufferLevels: 0 });
    const r = runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), oscillate(60), 0.02);
    expect(r.buysExecuted).toBeGreaterThan(0);
    expect(r.totalFeeUsd).toBeGreaterThan(0);
    expect(r.totalSlippageUsd).toBeGreaterThan(0);
    expect(r.totalGasUsd).toBeGreaterThan(0);
  });

  it("lp mode charges nothing on a grid crossing", () => {
    // The AMM converts deposited liquidity; the counterparty pays the fee.
    const cfg = makeConfig({ centerPrice: 4000, executionMode: "lp", resetBufferLevels: 0 });
    const r = runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), oscillate(60), 0.02);
    expect(r.buysExecuted).toBeGreaterThan(0);
    expect(r.totalFeeUsd).toBe(0);
    expect(r.totalSlippageUsd).toBe(0);
    expect(r.totalGasUsd).toBe(0);
  });

  it("lp mode still charges re-centring, which is a real transaction", () => {
    // Ramp out of the band so a reset fires: burn + swap + mint costs money.
    const data: PricePoint[] = [];
    let price = 4000;
    for (let i = 0; i < 40; i++) {
      data.push({ timestamp: T0 + i * H, price, feeAprPct: 50, poolTvlUsd: 20_000_000 });
      price *= 1.01;
    }
    const cfg = makeConfig({
      centerPrice: 4000,
      executionMode: "lp",
      initialEth: 2,
      resetBufferLevels: 2,
    });
    const r = runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), data, 0.02);
    expect(r.resets.length).toBeGreaterThan(0);
    // The liquidation swap is charged; the grid crossings before it are not.
    expect(r.totalFeeUsd).toBeGreaterThan(0);
    expect(r.totalGasUsd).toBeGreaterThan(0);
    const liq = r.strategy.getState().trades.filter((t) => t.liquidation);
    const gridT = r.strategy.getState().trades.filter((t) => !t.liquidation);
    expect(liq.every((t) => t.gasUsd > 0)).toBe(true);
    expect(gridT.every((t) => t.gasUsd === 0)).toBe(true);
    expect(gridT.every((t) => t.feeUsd === 0)).toBe(true);
  });

  it("reconciles in lp mode", () => {
    const data = walk(1500, 4000, -0.0008).map((p) => ({
      ...p,
      feeAprPct: 50,
      poolTvlUsd: 20_000_000,
    }));
    const cfg = makeConfig({
      centerPrice: data[0]!.price,
      executionMode: "lp",
      maxVolPerStep: 1,
    });
    const r = runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), data, 0.02);
    expect(() => assertAccountingReconciles(r)).not.toThrow();
  });
});

describe("only deposited liquidity earns pool fees", () => {
  it("taker mode earns no fee income even with an APR series loaded", () => {
    const data: PricePoint[] = Array.from({ length: 200 }, (_, i) => ({
      timestamp: T0 + i * H,
      price: 4000,
      feeAprPct: 100,
      poolTvlUsd: 20_000_000,
    }));
    const cfg = makeConfig({ centerPrice: 4000, executionMode: "taker", resetBufferLevels: 0 });
    const r = runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), data, 0);
    // It deposits nothing, so it earns nothing — it is the one paying the fee.
    expect(r.feeIncomeUsd).toBe(0);
  });

  it("lp mode on the same data does earn", () => {
    const data: PricePoint[] = Array.from({ length: 200 }, (_, i) => ({
      timestamp: T0 + i * H,
      price: 4000,
      feeAprPct: 100,
      poolTvlUsd: 20_000_000,
    }));
    const cfg = makeConfig({ centerPrice: 4000, executionMode: "lp", resetBufferLevels: 0 });
    const r = runBacktest(new GridStrategy(cfg, new LinearCostFillModel(5, 3)), data, 0);
    expect(r.feeIncomeUsd).toBeGreaterThan(0);
  });
});
