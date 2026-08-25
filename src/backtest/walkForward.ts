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
  /** Window lengths in years, used to annualize the returns. */
  trainYears: number;
  testYears: number;
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

  const span = (points: PricePoint[]) =>
    (points[points.length - 1]!.timestamp - points[0]!.timestamp) / SECONDS_PER_YEAR;

  return {
    name,
    trainRange: [train[0]!.timestamp, train[train.length - 1]!.timestamp],
    testRange: [test[0]!.timestamp, test[test.length - 1]!.timestamp],
    trainYears: span(train),
    testYears: span(test),
    best: best.candidate,
    train: best,
    test: testMetrics,
  };
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/**
 * Compound annual growth rate for a return measured over `years`.
 *
 * Walk-forward uses an EXPANDING training window, so train periods are
 * several times longer than the test chunk that follows them. Comparing the
 * raw returns therefore shows a large apparent "decay" that is purely a
 * difference in elapsed time; annualizing is what makes the two comparable.
 */
export function annualize(returnPct: number, years: number): number {
  if (!(years > 0)) return 0;
  const growth = 1 + returnPct / 100;
  // A total loss (or worse) has no real annual rate; report -100%.
  if (growth <= 0) return -100;
  return (Math.pow(growth, 1 / years) - 1) * 100;
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
  line(
    `TRAIN  ${day(fold.trainRange[0])} → ${day(fold.trainRange[1])}` +
      `  (${fold.trainYears.toFixed(2)}y)`,
  );
  line(
    `  Return:            ${pct(fold.train.returnPercent)}` +
      `   [${pct(annualize(fold.train.returnPercent, fold.trainYears))} annualized]`,
  );
  line(`  Max drawdown:      ${pct(fold.train.maxDrawdownPct)}`);
  line(`  Grid / reset P&L:  ${signedUsd(fold.train.totalGridPnL)} / ${signedUsd(fold.train.totalResetPnL)}`);
  line(`  Resets:            ${fold.train.numberOfResets}`);
  line();
  line(
    `TEST   ${day(fold.testRange[0])} → ${day(fold.testRange[1])}` +
      `  (${fold.testYears.toFixed(2)}y)`,
  );
  line(
    `  Return:            ${pct(fold.test.returnPercent)}` +
      `   [${pct(annualize(fold.test.returnPercent, fold.testYears))} annualized]`,
  );
  line(`  Max drawdown:      ${pct(fold.test.maxDrawdownPct)}`);
  line(`  Grid / reset P&L:  ${signedUsd(fold.test.totalGridPnL)} / ${signedUsd(fold.test.totalResetPnL)}`);
  line(`  Resets:            ${fold.test.numberOfResets}`);
  line(`  Final value:       ${usd(fold.test.finalPortfolioValue)}`);
  line(`  vs ETH hold:       ${pct(fold.test.benchmarks.vsEthPct)} pts`);
  line(`  vs USDC:           ${pct(fold.test.benchmarks.vsUsdcPct)} pts`);
  line();
  // Compare like with like: raw returns over unequal windows are not
  // comparable, so the headline decay figure is on annualized rates.
  const decay =
    annualize(fold.test.returnPercent, fold.testYears) -
    annualize(fold.train.returnPercent, fold.trainYears);
  line(`Out-of-sample decay: ${pct(decay)} pts annualized (test − train)`);
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
  line(
    "Fold      Spacing  Width  Reset  Order   Train ret  Train/yr   Test ret   Test/yr  Test MaxDD",
  );
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
        pct(annualize(f.train.returnPercent, f.trainYears)).padStart(10),
        pct(f.test.returnPercent).padStart(11),
        pct(annualize(f.test.returnPercent, f.testYears)).padStart(10),
        `${f.test.maxDrawdownPct.toFixed(1)}%`.padStart(12),
      ].join(""),
    );
  }
  line();
  const testReturns = folds.map((f) => f.test.returnPercent);
  const testAnnual = folds.map((f) => annualize(f.test.returnPercent, f.testYears));
  const positive = testReturns.filter((r) => r > 0).length;
  const avg = testReturns.reduce((a, b) => a + b, 0) / Math.max(testReturns.length, 1);
  const avgAnnual = testAnnual.reduce((a, b) => a + b, 0) / Math.max(testAnnual.length, 1);
  line(`Profitable out-of-sample folds:  ${positive}/${folds.length}`);
  line(`Average out-of-sample return:    ${pct(avg)}  (${pct(avgAnnual)} annualized)`);
  const stable = new Set(folds.map((f) => `${f.best.spacingPercent}/${f.best.widthPercent}/${f.best.resetBufferLevels}/${f.best.orderSizePercent}`));
  line(`Distinct winning configurations: ${stable.size}/${folds.length}` +
    (stable.size === 1 ? "  (stable)" : "  (parameters drift between folds)"));
  line(RULE);
  return lines.join("\n");
}

export interface ConsensusPick {
  candidate: GridCandidate;
  /** How many folds picked this candidate as their train-best. */
  foldWins: number;
  /** Mean test return of the folds it won (percent). */
  meanOosReturnPct: number;
  /** Worst test return across the folds it won (percent). */
  worstOosReturnPct: number;
}

/**
 * Aggregate fold winners into a consensus ranking. A configuration that is
 * the train-best in MANY folds — rather than only on the full period — is
 * the one least likely to be a lucky historical artifact. Ranked by fold
 * wins, then by out-of-sample return.
 */
export function selectConsensus(folds: FoldResult[]): ConsensusPick[] {
  const byKey = new Map<string, ConsensusPick>();
  for (const f of folds) {
    const key = candidateKey(f.best);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { candidate: f.best, foldWins: 0, meanOosReturnPct: 0, worstOosReturnPct: Infinity };
      byKey.set(key, entry);
    }
    entry.foldWins++;
    entry.meanOosReturnPct += f.test.returnPercent;
    entry.worstOosReturnPct = Math.min(entry.worstOosReturnPct, f.test.returnPercent);
  }
  const picks = [...byKey.values()];
  for (const p of picks) p.meanOosReturnPct /= Math.max(p.foldWins, 1);
  picks.sort((a, b) => b.foldWins - a.foldWins || b.meanOosReturnPct - a.meanOosReturnPct);
  return picks;
}

function candidateKey(c: GridCandidate): string {
  return [
    c.spacingPercent,
    c.widthPercent,
    c.resetBufferLevels,
    c.orderSizePercent,
    c.maxVolPerStep ?? "",
    c.inventoryCapPercent ?? "",
    c.cooldownHours ?? "",
    c.resetSellFraction ?? "",
    c.underwaterSkipPct ?? "",
  ].join("|");
}
