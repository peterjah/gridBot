import type { AppConfig } from "../config.js";
import { RULE, day, usd } from "../backtest/format.js";
import type { EvaluationInput } from "../backtest/optimizer.js";
import { loadAaveAprSeries } from "../backtest/lendingYield.js";
import { formatFold, formatWalkForwardSummary, trainTest, walkForward } from "../backtest/walkForward.js";
import { loadPrices } from "./backtest.js";
import { captureProvenance } from "../backtest/provenance.js";
import { annualize } from "../backtest/walkForward.js";
import { runDir } from "../backtest/runStore.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { logger } from "../utils/logger.js";

/**
 * Train/test and walk-forward validation (spec sections 15-16).
 * Answers one question only: do the optimized parameters generalize?
 */
export async function runWalkForwardMode(cfg: AppConfig): Promise<void> {
  const prices = await loadPrices(cfg.csvFile, cfg.aprFile, cfg.minPoolTvlUsd);
  const opt = cfg.optimizer;


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
  const options = { axes: opt.axes, metric: opt.metric, input };

  console.log(RULE);
  console.log("WALK-FORWARD VALIDATION");
  console.log(RULE);
  console.log();
  console.log(`Initial capital:   ${usd(cfg.grid.initialUsdc + cfg.grid.initialEth * prices[0]!.price)}`);
  console.log(
    `Period:            ${day(prices[0]!.timestamp)} → ${day(prices[prices.length - 1]!.timestamp)} (${prices.length} observations)`,
  );
  console.log(`Ranking metric:    ${opt.metric}`);
  console.log(`Train fraction:    ${opt.trainFraction}`);
  console.log(`Folds:             ${opt.folds}`);
  console.log(RULE);
  console.log();

  const single = trainTest(prices, opt.trainFraction, options);
  console.log(formatFold(single));
  console.log();

  const folds = walkForward(prices, opt.folds, options);
  for (const fold of folds) {
    console.log(formatFold(fold));
    console.log();
  }
  console.log(formatWalkForwardSummary(folds));

  // Archive the out-of-sample result with its provenance. This is the number
  // that decides whether an in-sample optimum means anything, so it has to be
  // checkable later against the exact code and data that produced it.
  const provenance = captureProvenance({
    pricesFile: cfg.csvFile,
    aprFile: cfg.aprFile,
    lpFeeIncomeActive:
      prices.some((p) => (p.feeAprPct ?? 0) > 0) ||
      cfg.grid.lpFeeAprPct > 0 ||
      cfg.grid.lpPoolLiquidityUsd > 0,
    lpCalibration: prices.some((p) => (p.feeAprPct ?? 0) > 0)
      ? "measured-apr-series"
      : cfg.grid.lpFeeAprPct > 0
        ? "constant-apr"
        : cfg.grid.lpPoolLiquidityUsd > 0
          ? "volume-share"
          : "none",
    lendingYield: false,
  });

  const dir = runDir(cfg.resultsDir, cfg.runLabel);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/walk-forward.json`;
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        label: cfg.runLabel,
        mode: "walk-forward",
        createdAt: new Date().toISOString(),
        provenance,
        trainFraction: opt.trainFraction,
        metric: opt.metric,
        axes: opt.axes,
        singleSplit: {
          spec: single.best,
          trainYears: single.trainYears,
          testYears: single.testYears,
          trainReturnPct: single.train.returnPercent,
          testReturnPct: single.test.returnPercent,
          trainAnnualizedPct: annualize(single.train.returnPercent, single.trainYears),
          testAnnualizedPct: annualize(single.test.returnPercent, single.testYears),
          testMaxDrawdownPct: single.test.maxDrawdownPct,
        },
        folds: folds.map((f) => ({
          name: f.name,
          best: f.best,
          trainYears: f.trainYears,
          testYears: f.testYears,
          trainReturnPct: f.train.returnPercent,
          testReturnPct: f.test.returnPercent,
          trainAnnualizedPct: annualize(f.train.returnPercent, f.trainYears),
          testAnnualizedPct: annualize(f.test.returnPercent, f.testYears),
          testMaxDrawdownPct: f.test.maxDrawdownPct,
        })),
      },
      null,
      2,
    )}\n`,
  );
  logger.info("Walk-forward archived", { label: cfg.runLabel, path });
}
