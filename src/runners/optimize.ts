import type { AppConfig } from "../config.js";
import { RULE, day, pct, signedUsd, usd } from "../backtest/format.js";
import {
  describeCandidate,
  evaluate,
  formatBenchmarkComparison,
  formatRankedTable,
  rank,
  sweep,
} from "../backtest/optimizer.js";
import type { EvaluationInput } from "../backtest/optimizer.js";
import {
  evaluateAcrossPeriods,
  formatPeriodTable,
  splitPeriods,
  trainTestSplit,
} from "../backtest/periods.js";
import { writeOptimizationCsv } from "../backtest/csv.js";
import { candidateSpec } from "../backtest/optimizer.js";
import { runDir, saveRun } from "../backtest/runStore.js";
import type { RunSummary } from "../backtest/runStore.js";
import { logger } from "../utils/logger.js";
import { loadPrices } from "./backtest.js";

/**
 * Grid parameter optimization (spec sections 9-15).
 *
 * Deliberately NOT "find the highest historical return and stop": the run
 * prints the ranked table, the regime breakdown of the winner, and an
 * out-of-sample train/test result, so a configuration that only works on one
 * lucky stretch of history is visible as such.
 */
export async function runOptimizeMode(cfg: AppConfig): Promise<void> {
  const prices = await loadPrices(cfg.csvFile, cfg.aprFile, cfg.minPoolTvlUsd);
  const opt = cfg.optimizer;

  const input: Omit<EvaluationInput, "prices"> = {
    base: cfg.grid,
    estimatedGasUsd: cfg.estimatedGasUsd,
    autoCenter: opt.autoCenter,
  };

  const capital = cfg.grid.initialUsdc + cfg.grid.initialEth * prices[0]!.price;

  console.log(RULE);
  console.log("GRID PARAMETER OPTIMIZATION");
  console.log(RULE);
  console.log();
  console.log(`Initial capital:   ${usd(capital)}`);
  console.log(`Pair:              ETH/USDC`);
  console.log(
    `Period:            ${day(prices[0]!.timestamp)} → ${day(prices[prices.length - 1]!.timestamp)} (${prices.length} observations)`,
  );
  console.log(`Data file:         ${cfg.csvFile}`);
  console.log(`Ranking metric:    ${opt.metric}`);
  console.log(`Run label:         ${cfg.runLabel}`);
  console.log(`Grid center:       ${opt.autoCenter ? "auto (first price of each period)" : usd(cfg.grid.centerPrice)}`);
  console.log(`Costs:             ${cfg.grid.feeBps} bps fee / ${cfg.grid.slippageBps} bps slippage / ${usd(cfg.estimatedGasUsd)} gas per trade`);
  console.log();
  console.log(`Spacings:          ${opt.axes.spacings.map((s) => `${s}%`).join(", ")}`);
  console.log(`Widths:            ${opt.axes.widths.map((w) => `±${w}%`).join(", ")}`);
  console.log(`Reset buffers:     ${opt.axes.resetBuffers.join(", ")}`);
  console.log(`Order allocations: ${opt.axes.orderFractions.map((o) => `${o}%`).join(", ")}`);
  if (opt.axes.maxVols?.length) {
    console.log(`Volatility gates:  ${opt.axes.maxVols.join(", ")}`);
  }
  if (opt.axes.inventoryCaps?.length) {
    console.log(
      `Inventory caps:    ${opt.axes.inventoryCaps.map((c) => (c <= 0 ? "none" : `${c}%`)).join(", ")}`,
    );
  }
  if (opt.axes.cooldownHours?.length) {
    console.log(`Cooldowns:         ${opt.axes.cooldownHours.map((h) => `${h}h`).join(", ")}`);
  }
  console.log();

  const started = Date.now();
  const result = sweep(opt.axes, { ...input, prices });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`Configurations generated: ${result.generated}`);
  console.log(`Configurations tested:    ${result.metrics.length}`);
  console.log(`Configurations skipped:   ${result.skipped.length} (infeasible — see reasons below)`);
  console.log(`Elapsed:                  ${elapsed}s`);
  console.log();

  if (result.metrics.length === 0) {
    console.log("No feasible configuration. Skip reasons:");
    for (const s of summarizeSkips(result.skipped)) console.log(`  ${s}`);
    return;
  }

  const summarized = summarizeSkips(result.skipped);
  if (summarized.length > 0) {
    console.log("Skip reasons:");
    for (const s of summarized) console.log(`  ${s}`);
    console.log();
  }

  console.log(formatRankedTable(result.metrics, opt.metric, opt.top, opt.axes));
  console.log();

  // How the winner would look under the other ranking metrics — a config that
  // only wins on one metric is a warning sign, not a recommendation.
  console.log(RULE);
  console.log("BEST CONFIGURATION (in-sample)");
  console.log(RULE);
  console.log();
  const best = rank(result.metrics, opt.metric)[0]!;
  console.log(describeCandidate(best.candidate));
  console.log();
  console.log(`Final value:       ${usd(best.finalPortfolioValue)}`);
  console.log(`Return:            ${pct(best.returnPercent)}`);
  console.log(`Max drawdown:      ${pct(best.maxDrawdownPct)}`);
  console.log(`Risk-adjusted:     ${best.riskAdjustedScore.toFixed(2)}  (return / |maxDD|)`);
  console.log();
  console.log(`Grid P&L:          ${signedUsd(best.totalGridPnL)}`);
  console.log(`Reset P&L:         ${signedUsd(best.totalResetPnL)}`);
  console.log(`Unrealized P&L:    ${signedUsd(best.unrealizedPnL)}`);
  console.log(`Fees:              ${signedUsd(-best.totalFees)}`);
  console.log(`Slippage:          ${signedUsd(-best.totalSlippage)}`);
  console.log(`Gas:               ${signedUsd(-best.totalGas)}`);
  console.log();
  console.log(`Trades:            ${best.numberOfTrades} (${best.completedCycles} completed cycles)`);
  console.log(`Resets:            ${best.numberOfResets}`);
  console.log(`Average reset loss:${signedUsd(best.averageResetLoss).padStart(13)}`);
  console.log(`Worst reset loss:  ${signedUsd(best.maxResetLoss)}`);
  console.log(`Max ETH exposure:  ${best.maxEthExposurePct.toFixed(1)}% of portfolio`);
  console.log();
  console.log(formatBenchmarkComparison(best));
  console.log(RULE);
  console.log();

  // Market-regime breakdown of the winning configuration.
  const periods = splitPeriods(prices);
  console.log(formatPeriodTable(evaluateAcrossPeriods(best.candidate, periods, input)));
  console.log();

  // Out-of-sample check: refit on the training window only.
  console.log(RULE);
  console.log(`OUT-OF-SAMPLE VALIDATION (${Math.round(opt.trainFraction * 100)}% train / ${Math.round((1 - opt.trainFraction) * 100)}% test)`);
  console.log(RULE);
  console.log();
  let outOfSample: RunSummary["outOfSample"];
  try {
    const { train, test } = trainTestSplit(prices, opt.trainFraction);
    const trainSweep = sweep(opt.axes, { ...input, prices: train });
    if (trainSweep.metrics.length === 0) {
      console.log("No feasible configuration on the training window.");
    } else {
      const trainBest = rank(trainSweep.metrics, opt.metric)[0]!;
      const testMetrics = evaluate(trainBest.candidate, { ...input, prices: test });
      console.log(`Best configuration on TRAIN: ${describeCandidate(trainBest.candidate)}`);
      console.log();
      console.log(`TRAIN  ${day(train[0]!.timestamp)} → ${day(train[train.length - 1]!.timestamp)}`);
      console.log(`  Return:          ${pct(trainBest.returnPercent)}`);
      console.log(`  Max drawdown:    ${pct(trainBest.maxDrawdownPct)}`);
      console.log(`  Resets:          ${trainBest.numberOfResets}`);
      console.log();
      console.log(`TEST   ${day(test[0]!.timestamp)} → ${day(test[test.length - 1]!.timestamp)}`);
      console.log(`  Return:          ${pct(testMetrics.returnPercent)}`);
      console.log(`  Max drawdown:    ${pct(testMetrics.maxDrawdownPct)}`);
      console.log(`  Grid P&L:        ${signedUsd(testMetrics.totalGridPnL)}`);
      console.log(`  Reset P&L:       ${signedUsd(testMetrics.totalResetPnL)}`);
      console.log(`  Resets:          ${testMetrics.numberOfResets}`);
      console.log(`  vs ETH hold:     ${pct(testMetrics.benchmarks.vsEthPct)} pts`);
      console.log(`  vs USDC:         ${pct(testMetrics.benchmarks.vsUsdcPct)} pts`);
      console.log();
      console.log(
        `Out-of-sample decay: ${pct(testMetrics.returnPercent - trainBest.returnPercent)} pts (test − train)`,
      );
      outOfSample = {
        trainReturnPct: trainBest.returnPercent,
        testReturnPct: testMetrics.returnPercent,
        testMaxDrawdownPct: testMetrics.maxDrawdownPct,
        testResets: testMetrics.numberOfResets,
        spec: candidateSpec(trainBest.candidate),
      };
    }
  } catch (error) {
    console.log(`Skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(RULE);

  const dir = runDir(cfg.resultsDir, cfg.runLabel);
  const csvPath = writeOptimizationCsv(rank(result.metrics, opt.metric), `${dir}/optimization.csv`);
  const runPath = saveRun(cfg.resultsDir, {
    label: cfg.runLabel,
    mode: "optimize",
    createdAt: new Date().toISOString(),
    dataFile: cfg.csvFile,
    periodStart: prices[0]!.timestamp,
    periodEnd: prices[prices.length - 1]!.timestamp,
    initialCapital: capital,
    metric: opt.metric,
    configsTested: result.metrics.length,
    configsSkipped: result.skipped.length,
    axes: opt.axes,
    spec: candidateSpec(best.candidate),
    description: describeCandidate(best.candidate),
    metrics: best,
    outOfSample,
  });
  logger.info("Optimization results written", {
    label: cfg.runLabel,
    csvPath,
    runPath,
    rows: result.metrics.length,
  });
}

/** Group skip reasons so the log stays readable at hundreds of candidates. */
function summarizeSkips(skipped: { reason: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const s of skipped) {
    // Collapse the varying amounts inside a reason into its shape.
    const key = s.reason.replace(/\$[\d,.]+/g, "$X").replace(/[\d.]+%/g, "N%").replace(/\d+/g, "N");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${String(count).padStart(5)} × ${reason}`);
}
