import type { AppConfig } from "../config.js";
import { RULE, day, pct, usd } from "../backtest/format.js";
import type { EvaluationInput } from "../backtest/optimizer.js";
import { loadAaveAprSeries } from "../backtest/lendingYield.js";
import { candidateSpec, describeCandidate } from "../backtest/optimizer.js";
import {
  formatScenarioDetail,
  formatScenarioTable,
  formatWindows,
  rankScenario,
  selectWindows,
  sweepScenario,
} from "../backtest/scenario.js";
import { saveRun, runDir } from "../backtest/runStore.js";
import { writeScenarioCsv } from "../backtest/csv.js";
import { logger } from "../utils/logger.js";
import { loadPrices } from "./backtest.js";
import { captureProvenance } from "../backtest/provenance.js";

/**
 * Optimize for a market SCENARIO rather than for one stretch of history:
 * every window matching the profile is scored, and configurations are ranked
 * on their median across windows.
 */
export async function runScenarioMode(cfg: AppConfig): Promise<void> {
  const prices = await loadPrices(cfg.csvFile, cfg.aprFile, cfg.minPoolTvlUsd);
  const opt = cfg.optimizer;
  const filter = opt.scenario;


  const aaveYield = cfg.aaveYieldFile
    ? { series: loadAaveAprSeries(cfg.aaveYieldFile), bufferUsdc: cfg.lendBufferUsdc }
    : undefined;
  const input: Omit<EvaluationInput, "prices"> = {
    base: cfg.grid,
    estimatedGasUsd: cfg.estimatedGasUsd,
    gas: cfg.gas,
    lendingGasLegs: cfg.lendingGasLegs,
    autoCenter: opt.autoCenter,
    aaveYield,
  };

  console.log(RULE);
  console.log("SCENARIO OPTIMIZATION");
  console.log(RULE);
  console.log();
  console.log(`Data file:         ${cfg.csvFile}`);
  console.log(
    `History:           ${day(prices[0]!.timestamp)} → ${day(prices[prices.length - 1]!.timestamp)} (${prices.length} observations)`,
  );
  console.log(`Initial capital:   ${usd(cfg.grid.initialUsdc + cfg.grid.initialEth * prices[0]!.price)}`);
  console.log(`Run label:         ${cfg.runLabel}`);
  console.log();

  const windows = selectWindows(prices, filter);
  if (windows.length === 0) {
    console.log(
      `No ${filter.months}-month window in this data has a move between ` +
        `${pct(filter.moveMin, 0)} and ${pct(filter.moveMax, 0)}. Widen the filter.`,
    );
    return;
  }
  console.log(formatWindows(windows, filter));
  console.log();

  const started = Date.now();
  const sweep = sweepScenario(opt.axes, windows, input);
  console.log(
    `Tested ${sweep.results.length} configurations × ${windows.length} windows ` +
      `(${sweep.skipped} skipped) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log();

  console.log(formatScenarioTable(sweep.results, opt.metric, opt.top, windows.length));
  console.log();

  const best = rankScenario(sweep.results, opt.metric)[0]!;
  console.log(formatScenarioDetail(best));

  // Archive using the median window as the headline, so the saved run is
  // representative rather than the luckiest one.
  const sorted = [...best.perWindow].sort(
    (a, b) => a.metrics.returnPercent - b.metrics.returnPercent,
  );
  const medianEntry = sorted[Math.floor(sorted.length / 2)]!;
  const scLpActive =
    prices.some((p) => (p.feeAprPct ?? 0) > 0) ||
    cfg.grid.lpFeeAprPct > 0 ||
    cfg.grid.lpPoolLiquidityUsd > 0;
  const scCalibration = prices.some((p) => (p.feeAprPct ?? 0) > 0)
    ? ("measured-apr-series" as const)
    : cfg.grid.lpFeeAprPct > 0
      ? ("constant-apr" as const)
      : cfg.grid.lpPoolLiquidityUsd > 0
        ? ("volume-share" as const)
        : ("none" as const);
  const scProvenance = captureProvenance({
    pricesFile: cfg.csvFile,
    aprFile: cfg.aprFile,
    lpFeeIncomeActive: scLpActive,
    lpCalibration: scCalibration,
    // The backtester does not model money-market yield; the live bot's Aave
    // lending is a separate concern and is never included in these figures.
    lendingYield: false,
  });
  const runPath = saveRun(cfg.resultsDir, {
    label: cfg.runLabel,
    mode: "optimize",
    createdAt: new Date().toISOString(),
    provenance: scProvenance,
    dataFile: `${cfg.csvFile} [scenario ${filter.moveMin}..${filter.moveMax}% / ${windows.length}w]`,
    periodStart: medianEntry.window.prices[0]!.timestamp,
    periodEnd: medianEntry.window.prices[medianEntry.window.prices.length - 1]!.timestamp,
    initialCapital: medianEntry.metrics.finalPortfolioValue - 0,
    metric: opt.metric,
    configsTested: sweep.results.length,
    axes: opt.axes,
    spec: candidateSpec(best.candidate),
    description: describeCandidate(best.candidate),
    metrics: medianEntry.metrics,
  });
  const csvPath = writeScenarioCsv(
    rankScenario(sweep.results, opt.metric),
    `${runDir(cfg.resultsDir, cfg.runLabel)}/scenario.csv`,
  );
  logger.info("Scenario results written", {
    label: cfg.runLabel,
    runPath,
    csvPath,
    windows: windows.length,
  });
}
