import { CsvMarketDataProvider } from "../data/csvProvider.js";
import { applyAprSeries, loadAprSeries } from "../data/aprSeries.js";
import { LinearCostFillModel } from "../grid/fillModel.js";
import { GridStrategy } from "../grid/gridStrategy.js";
import type { AppConfig } from "../config.js";
import { assertAccountingReconciles, runBacktest } from "../backtest/backtester.js";
import {
  ethHoldBenchmark,
  passiveLpWithFeesBenchmark,
  staticLpBenchmark,
  usdcOnlyBenchmark,
} from "../backtest/benchmarks.js";
import { formatReport } from "../backtest/report.js";
import {
  formatAllResets,
  formatCenterHistory,
  formatInventoryReport,
  formatResetSummary,
} from "../backtest/resetReport.js";
import { writeEquityCsv, writeResetCsv, writeTradeLedger } from "../backtest/csv.js";
import { loadAaveAprSeries } from "../backtest/lendingYield.js";
import { writeChartReport } from "../backtest/chart.js";
import { candidateFromConfig, runDir, saveRun } from "../backtest/runStore.js";
import { candidateSpec, describeCandidate, metricsFor } from "../backtest/optimizer.js";
import { logger } from "../utils/logger.js";
import { captureProvenance } from "../backtest/provenance.js";

/**
 * Load the configured CSV price series, optionally joined with a daily pool
 * fee APR series. Observations outside the APR series' coverage are dropped,
 * so the backtest never assumes a fee rate it did not measure.
 */
export async function loadPrices(
  csvFile: string,
  aprFile?: string | null,
  minPoolTvlUsd = 0,
) {
  const provider = new CsvMarketDataProvider(csvFile);
  // Wide window: provider filters to whatever the file contains.
  let prices = await provider.getPrices(new Date(0), new Date("2100-01-01"));
  if (prices.length < 2) throw new Error(`Not enough data in ${csvFile}`);

  if (aprFile) {
    const applied = applyAprSeries(prices, loadAprSeries(aprFile), minPoolTvlUsd);
    if (applied.prices.length < 2) {
      throw new Error(`APR series ${aprFile} does not overlap ${csvFile}`);
    }
    logger.info("Joined pool APR series", {
      aprFile,
      kept: applied.prices.length,
      droppedNoApr: applied.dropped,
      droppedThinPool: applied.droppedThinPool,
    });
    prices = applied.prices;
  }

  return prices;
}

/**
 * Deterministic grid backtest over historical CSV data, with full reset,
 * inventory and P&L-decomposition analytics.
 */
export async function runBacktestMode(cfg: AppConfig): Promise<void> {
  const prices = await loadPrices(cfg.csvFile, cfg.aprFile, cfg.minPoolTvlUsd);

  const fillModel = new LinearCostFillModel(cfg.grid.feeBps, cfg.grid.slippageBps);
  const strategy = new GridStrategy(cfg.grid, fillModel);

  // Optional Aave supply-yield model on idle USDC.
  let aaveYield: { series: ReturnType<typeof loadAaveAprSeries>; bufferUsdc: number } | undefined;
  if (cfg.aaveYieldFile) {
    const series = loadAaveAprSeries(cfg.aaveYieldFile);
    logger.info("Aave yield modeling enabled", {
      aaveYieldFile: cfg.aaveYieldFile,
      days: series.length,
      bufferUsdc: cfg.lendBufferUsdc,
      firstAprPct: series[0]!.aprPct,
    });
    aaveYield = { series, bufferUsdc: cfg.lendBufferUsdc };
  }

  const result = runBacktest(strategy, prices, cfg.gas, cfg.lendingGasLegs, aaveYield);
  // Fail loudly rather than reporting numbers that do not add up.
  assertAccountingReconciles(result);

  const benchmarks = [
    usdcOnlyBenchmark({ prices, initialUsdc: cfg.grid.initialUsdc, initialEth: cfg.grid.initialEth }, prices[0]!.price),
    ethHoldBenchmark({ prices, initialUsdc: cfg.grid.initialUsdc, initialEth: cfg.grid.initialEth }),
    staticLpBenchmark({ prices, initialUsdc: cfg.grid.initialUsdc, initialEth: cfg.grid.initialEth }),
  ];

  // Only meaningful when a fee series is loaded; otherwise it degenerates to
  // the no-fee static LP already above.
  if (prices.some((p) => (p.feeAprPct ?? 0) > 0)) {
    const bench = { prices, initialUsdc: cfg.grid.initialUsdc, initialEth: cfg.grid.initialEth };
    const span = Math.max(cfg.grid.levelsAbove, cfg.grid.levelsBelow);
    const gridRangePct = (Math.pow(1 + cfg.grid.spacingPercent / 100, span) - 1) * 100;
    // Matched to the grid's own band, plus a wide reference position.
    benchmarks.push(passiveLpWithFeesBenchmark(bench, gridRangePct));
    benchmarks.push(passiveLpWithFeesBenchmark(bench, 50));
  }

  console.log(formatReport(result, benchmarks, cfg.grid));
  console.log();
  if (result.resets.length > 0) {
    console.log(formatAllResets(result.resets));
    console.log();
  }
  console.log(formatResetSummary(result));
  console.log();
  console.log(formatInventoryReport(result));
  console.log();
  console.log(formatCenterHistory(result));

  // Everything this run produced lands under its own label, so successive
  // experiments accumulate instead of overwriting each other.
  const dir = runDir(cfg.resultsDir, cfg.runLabel);
  const tradesCsv = writeTradeLedger(result, `${dir}/trades.csv`);
  const resetsCsv = writeResetCsv(result.resets, `${dir}/resets.csv`);
  const equityCsv = writeEquityCsv(result, `${dir}/equity.csv`);
  const reportPath = writeChartReport(result, benchmarks, `${dir}/report.html`);

  const candidate = candidateFromConfig(cfg.grid, result.initialCapital);
  const metrics = metricsFor(candidate, result, {
    prices,
    base: cfg.grid,
    estimatedGasUsd: cfg.estimatedGasUsd,
  });
  const runLpActive =
    prices.some((p) => (p.feeAprPct ?? 0) > 0) ||
    cfg.grid.lpFeeAprPct > 0 ||
    cfg.grid.lpPoolLiquidityUsd > 0;
  const runCalibration = prices.some((p) => (p.feeAprPct ?? 0) > 0)
    ? ("measured-apr-series" as const)
    : cfg.grid.lpFeeAprPct > 0
      ? ("constant-apr" as const)
      : cfg.grid.lpPoolLiquidityUsd > 0
        ? ("volume-share" as const)
        : ("none" as const);
  const runProvenance = captureProvenance({
    pricesFile: cfg.csvFile,
    aprFile: cfg.aprFile,
    lpFeeIncomeActive: runLpActive,
    lpCalibration: runCalibration,
    // The backtester does not model money-market yield; the live bot's Aave
    // lending is a separate concern and is never included in these figures.
    lendingYield: false,
  });
  const runPath = saveRun(cfg.resultsDir, {
    label: cfg.runLabel,
    mode: "backtest",
    createdAt: new Date().toISOString(),
    provenance: runProvenance,
    dataFile: cfg.csvFile,
    periodStart: result.start.timestamp,
    periodEnd: result.end.timestamp,
    initialCapital: result.initialCapital,
    spec: candidateSpec(candidate),
    description: describeCandidate(candidate),
    metrics,
  });

  logger.info("Backtest artifacts written", {
    label: cfg.runLabel,
    reportFile: reportPath,
    tradesCsv,
    resetsCsv,
    equityCsv,
    runPath,
  });
}
