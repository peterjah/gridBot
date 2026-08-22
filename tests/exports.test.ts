import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GridStrategy } from "../src/grid/gridStrategy.js";
import { LinearCostFillModel } from "../src/grid/fillModel.js";
import { runBacktest } from "../src/backtest/backtester.js";
import { writeEquityCsv, writeResetCsv, writeTradeLedger } from "../src/backtest/csv.js";
import { applyNamedConfig, parseArgs } from "../src/cli.js";
import type { AppConfig } from "../src/config.js";
import type { GridConfig } from "../src/grid/types.js";
import type { PricePoint } from "../src/data/provider.js";
import { applyAprSeries, loadAprSeries } from "../src/data/aprSeries.js";

const T0 = Date.UTC(2025, 0, 1) / 1000;

function base(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    initialUsdc: 10_000,
    initialEth: 0,
    centerPrice: 4000,
    spacingPercent: 1,
    levelsAbove: 5,
    levelsBelow: 5,
    orderSizeUsd: 1000,
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
    regimeMaxMovePct: 0,
    regimeLookbackPoints: 336,
    regenMinSeconds: 3600,
    volLookbackPoints: 24,
    maxVolPerStep: 0.005,
    resetBreakerK: 3,
    resetBreakerWindowSeconds: 30 * 24 * 3600,
    ...overrides,
  };
}

function walk(steps: number, drift = -0.0008): PricePoint[] {
  const points: PricePoint[] = [];
  let price = 4000;
  let seed = 424242;
  for (let i = 0; i < steps; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    price *= 1 + drift + (seed / 2147483648 - 0.5) * 0.006;
    points.push({ timestamp: T0 + i * 3600, price });
  }
  return points;
}

function runOnce() {
  const prices = walk(1200);
  const cfg = base({ centerPrice: prices[0]!.price });
  const strategy = new GridStrategy(cfg, new LinearCostFillModel(cfg.feeBps, cfg.slippageBps));
  return { result: runBacktest(strategy, prices, 0.02), prices };
}

describe("CSV exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "gridbot-csv-"));

  it("writes a trade ledger whose rows match the in-memory trades", () => {
    const { result } = runOnce();
    const path = writeTradeLedger(result, join(dir, "trades.csv"));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const trades = result.strategy.getState().trades;
    expect(lines).toHaveLength(trades.length + 1);
    expect(lines[0]).toContain("realized_grid_pnl");
    expect(lines[0]).toContain("realized_reset_pnl");
    expect(lines[0]).toContain("reset_id");

    const header = lines[0]!.split(",");
    const rows = lines.slice(1).map((l) => l.split(","));
    const col = (row: string[], name: string) => row[header.indexOf(name)]!;

    // Portfolio value on every row must equal usdc + eth * price.
    for (const row of rows) {
      const usdc = Number(col(row, "usdc_balance"));
      const eth = Number(col(row, "eth_balance"));
      const value = Number(col(row, "portfolio_value"));
      expect(Number.isFinite(value)).toBe(true);
      expect(usdc).toBeGreaterThanOrEqual(-1e-9);
      expect(eth).toBeGreaterThanOrEqual(-1e-9);
    }

    // Liquidation rows carry a reset id; grid rows do not.
    for (const row of rows) {
      const action = col(row, "action");
      const resetId = col(row, "reset_id");
      if (action === "LIQUIDATE") expect(Number(resetId)).toBeGreaterThan(0);
      else expect(resetId).toBe("");
    }
  });

  it("writes one reset row per reset", () => {
    const { result } = runOnce();
    const path = writeResetCsv(result.resets, join(dir, "resets.csv"));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(result.resets.length + 1);
    expect(lines[0]).toContain("reset_pnl");
    expect(lines[0]).toContain("drawdown_before_pct");
  });

  it("writes one equity row per sample", () => {
    const { result } = runOnce();
    const path = writeEquityCsv(result, join(dir, "equity.csv"));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(result.samples.length + 1);
  });
});

describe("CLI", () => {
  it("parses flags and values", () => {
    const args = parseArgs(["--spacing", "2", "--fixed-center", "--csv", "data/x.csv"]);
    expect(args).toEqual({ spacing: "2", "fixed-center": "true", csv: "data/x.csv" });
  });

  it("applies an inline named configuration", () => {
    const cfg = { grid: base() } as AppConfig;
    applyNamedConfig(cfg, "spacing=2,width=20,reset=3,order=5");
    expect(cfg.grid.spacingPercent).toBe(2);
    expect(cfg.grid.resetBufferLevels).toBe(3);
    expect(cfg.grid.orderSizeUsd).toBe(500); // 5% of $10,000
    // ±20% at 2% spacing → 9 levels each side.
    expect(cfg.grid.levelsAbove).toBe(9);
    expect(cfg.grid.levelsBelow).toBe(9);
  });

  it("resolves width against the final spacing regardless of key order", () => {
    const cfg = { grid: base() } as AppConfig;
    applyNamedConfig(cfg, "width=20,spacing=2");
    expect(cfg.grid.levelsAbove).toBe(9);
  });

  it("rejects unknown keys", () => {
    const cfg = { grid: base() } as AppConfig;
    expect(() => applyNamedConfig(cfg, "wobble=3")).toThrow(/unknown key/);
    expect(() => applyNamedConfig(cfg, "spacing=abc")).toThrow(/bad entry/);
  });
});

describe("APR series join", () => {
  const dir = mkdtempSync(join(tmpdir(), "gridbot-apr-"));

  it("attaches the daily APR and drops uncovered observations", () => {
    const path = join(dir, "apr.csv");
    writeFileSync(path, "date,apr_pct,tvl_usd\n2025-01-01,50,1000000\n2025-01-02,80,1000000\n");
    const series = loadAprSeries(path);
    expect(series.size).toBe(2);

    const day1 = Date.UTC(2025, 0, 1) / 1000;
    const prices = [
      { timestamp: day1, price: 4000 },
      { timestamp: day1 + 3600, price: 4010 },
      { timestamp: day1 + 86_400, price: 4020 },
      // 2025-01-03 is outside the series: must be dropped, not back-filled.
      { timestamp: day1 + 2 * 86_400, price: 4030 },
    ];
    const applied = applyAprSeries(prices, series);
    expect(applied.prices).toHaveLength(3);
    expect(applied.dropped).toBe(1);
    expect(applied.prices[0]!.feeAprPct).toBe(50);
    expect(applied.prices[2]!.feeAprPct).toBe(80);
    expect(applied.prices[0]!.poolTvlUsd).toBe(1_000_000);
  });

  it("drops days when the pool was too thin to deploy into", () => {
    const path = join(dir, "thin.csv");
    writeFileSync(path, "date,apr_pct,tvl_usd\n2025-01-01,900,11000\n2025-01-02,60,20000000\n");
    const day1 = Date.UTC(2025, 0, 1) / 1000;
    const prices = [
      { timestamp: day1, price: 4000 },
      { timestamp: day1 + 86_400, price: 4010 },
    ];
    const applied = applyAprSeries(prices, loadAprSeries(path), 1_000_000);
    // The 900%-APR day sat on $11k of TVL: not a real opportunity at size.
    expect(applied.prices).toHaveLength(1);
    expect(applied.droppedThinPool).toBe(1);
    expect(applied.prices[0]!.feeAprPct).toBe(60);
  });

  it("rejects a malformed series", () => {
    const path = join(dir, "bad.csv");
    writeFileSync(path, "date,apr_pct\nnot-a-row\n");
    expect(() => loadAprSeries(path)).toThrow(/expected/);
  });
});
