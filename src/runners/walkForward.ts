import type { AppConfig } from "../config.js";
import { RULE, day, usd } from "../backtest/format.js";
import type { EvaluationInput } from "../backtest/optimizer.js";
import { formatFold, formatWalkForwardSummary, trainTest, walkForward } from "../backtest/walkForward.js";
import { loadPrices } from "./backtest.js";

/**
 * Train/test and walk-forward validation (spec sections 15-16).
 * Answers one question only: do the optimized parameters generalize?
 */
export async function runWalkForwardMode(cfg: AppConfig): Promise<void> {
  const prices = await loadPrices(cfg.csvFile, cfg.aprFile, cfg.minPoolTvlUsd);
  const opt = cfg.optimizer;

  const input: Omit<EvaluationInput, "prices"> = {
    base: cfg.grid,
    estimatedGasUsd: cfg.estimatedGasUsd,
    autoCenter: opt.autoCenter,
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
}
