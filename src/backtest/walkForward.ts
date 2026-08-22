import type { PricePoint } from "../data/provider.js";
import { RULE, THIN, day, pct, signedUsd, usd } from "./format.js";
import type {
  ConfigMetrics,
  EvaluationInput,
  GridCandidate,
  RankMetric,
  SweepAxes,
} from "./optimizer.js";
import { describeCandidate, evaluate, rank, sweep } from "./optimizer.js";
import { trainTestSplit } from "./periods.js";

/**
 * Out-of-sample validation (spec sections 15 and 16).
 *
 * The best configuration on a historical dataset is almost always partly
 * luck. These helpers answer the only question that matters before risking
 * money: does the parameter set chosen on data A still work on unseen data B?
 */

export interface FoldResult {
  name: string;
  trainRange: [number, number];
  testRange: [number, number];
  best: GridCandidate;
  train: ConfigMetrics;
  test: ConfigMetrics;
}

export interface WalkForwardOptions {
  axes: SweepAxes;
  metric: RankMetric;
  input: Omit<EvaluationInput, "prices">;
}

/** Single 60/40-style train/test run. */
export function trainTest(
  prices: PricePoint[],
  trainFraction: number,
  options: WalkForwardOptions,
): FoldResult {
  const { train, test } = trainTestSplit(prices, trainFraction);
  return runFold("TRAIN / TEST", train, test, options);
}

/**
 * Expanding-window walk-forward: each fold trains on everything up to a cut
 * and tests on the next chunk. Deliberately simple — the goal is a
 * generalization signal, not a research framework.
 */
export function walkForward(
  prices: PricePoint[],
  folds: number,
  options: WalkForwardOptions,
): FoldResult[] {
  if (folds < 1) throw new Error("folds must be >= 1");
  const results: FoldResult[] = [];
  // Reserve the first half for the initial training window, then split the
  // remainder into `folds` test chunks.
  const initialTrain = Math.floor(prices.length / 2);
  const testChunk = Math.floor((prices.length - initialTrain) / folds);
  if (initialTrain < 2 || testChunk < 2) {
    throw new Error(`Not enough data for ${folds} walk-forward folds`);
  }

  for (let f = 0; f < folds; f++) {
    const trainEnd = initialTrain + f * testChunk;
    const testEnd = f === folds - 1 ? prices.length : trainEnd + testChunk;
    const train = prices.slice(0, trainEnd);
    const test = prices.slice(trainEnd, testEnd);
    if (train.length < 2 || test.length < 2) continue;
    results.push(runFold(`Fold ${f + 1}`, train, test, options));
  }
  return results;
}

function runFold(
  name: string,
  train: PricePoint[],
  test: PricePoint[],
  options: WalkForwardOptions,
): FoldResult {
  const trainResult = sweep(options.axes, { ...options.input, prices: train });
  if (trainResult.metrics.length === 0) {
    throw new Error(
      `No feasible configuration on the training window (${trainResult.skipped.length} skipped)`,
    );
  }
  const best = rank(trainResult.metrics, options.metric)[0]!;
  // The winning candidate is applied verbatim to unseen data — no refitting,
  // no re-centering choice that could leak information from the test window
  // beyond its own first price.
  const testMetrics = evaluate(best.candidate, { ...options.input, prices: test });

  return {
    name,
    trainRange: [train[0]!.timestamp, train[train.length - 1]!.timestamp],
    testRange: [test[0]!.timestamp, test[test.length - 1]!.timestamp],
    best: best.candidate,
    train: best,
    test: testMetrics,
  };
}

export function formatFold(fold: FoldResult): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line(fold.name);
  line(RULE);
  line();
  line(`Best configuration:  ${describeCandidate(fold.best)}`);
  line();
  line(`TRAIN  ${day(fold.trainRange[0])} → ${day(fold.trainRange[1])}`);
  line(`  Return:            ${pct(fold.train.returnPercent)}`);
  line(`  Max drawdown:      ${pct(fold.train.maxDrawdownPct)}`);
  line(`  Grid / reset P&L:  ${signedUsd(fold.train.totalGridPnL)} / ${signedUsd(fold.train.totalResetPnL)}`);
  line(`  Resets:            ${fold.train.numberOfResets}`);
  line();
  line(`TEST   ${day(fold.testRange[0])} → ${day(fold.testRange[1])}`);
  line(`  Return:            ${pct(fold.test.returnPercent)}`);
  line(`  Max drawdown:      ${pct(fold.test.maxDrawdownPct)}`);
  line(`  Grid / reset P&L:  ${signedUsd(fold.test.totalGridPnL)} / ${signedUsd(fold.test.totalResetPnL)}`);
  line(`  Resets:            ${fold.test.numberOfResets}`);
  line(`  Final value:       ${usd(fold.test.finalPortfolioValue)}`);
  line(`  vs ETH hold:       ${pct(fold.test.benchmarks.vsEthPct)} pts`);
  line(`  vs USDC:           ${pct(fold.test.benchmarks.vsUsdcPct)} pts`);
  line();
  const decay = fold.test.returnPercent - fold.train.returnPercent;
  line(`Out-of-sample decay: ${pct(decay)} pts (test − train)`);
  line(RULE);
  return lines.join("\n");
}

/** Summary across folds: does the parameter choice generalize at all? */
export function formatWalkForwardSummary(folds: FoldResult[]): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line("WALK-FORWARD SUMMARY");
  line(RULE);
  line();
  line("Fold      Spacing  Width  Reset  Order   Train ret  Test ret   Test MaxDD  Test resets");
  line(THIN);
  for (const f of folds) {
    line(
      [
        f.name.padEnd(10),
        `${f.best.spacingPercent}%`.padEnd(9),
        `${f.best.widthPercent}%`.padEnd(7),
        String(f.best.resetBufferLevels).padEnd(7),
        `${f.best.orderSizePercent}%`.padEnd(8),
        pct(f.train.returnPercent).padStart(10),
        pct(f.test.returnPercent).padStart(10),
        `${f.test.maxDrawdownPct.toFixed(1)}%`.padStart(12),
        String(f.test.numberOfResets).padStart(13),
      ].join(""),
    );
  }
  line();
  const testReturns = folds.map((f) => f.test.returnPercent);
  const positive = testReturns.filter((r) => r > 0).length;
  const avg = testReturns.reduce((a, b) => a + b, 0) / Math.max(testReturns.length, 1);
  line(`Profitable out-of-sample folds:  ${positive}/${folds.length}`);
  line(`Average out-of-sample return:    ${pct(avg)}`);
  const stable = new Set(folds.map((f) => `${f.best.spacingPercent}/${f.best.widthPercent}/${f.best.resetBufferLevels}/${f.best.orderSizePercent}`));
  line(`Distinct winning configurations: ${stable.size}/${folds.length}` +
    (stable.size === 1 ? "  (stable)" : "  (parameters drift between folds)"));
  line(RULE);
  return lines.join("\n");
}
