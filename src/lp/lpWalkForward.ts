import type { PricePoint } from "../data/provider.js";
import { RULE, THIN, day, pct, usd } from "../backtest/format.js";
import { trainTestSplit } from "../backtest/periods.js";
import { annualize } from "../backtest/walkForward.js";
import { evaluateLp, rankLp, sweepLp } from "./lpOptimizer.js";
import type { LpAxes, LpEvalInput, LpMetrics } from "./lpOptimizer.js";
import type { RegimeMetric } from "./passiveLp.js";

/**
 * Out-of-sample validation for passive LP.
 *
 * The grid optimizer has had walk-forward since the start; the LP sweep did
 * not, which meant every LP figure in this repository was fitted and reported
 * on the same window. This closes that gap using the same protocol, so the two
 * strategies are judged by the same standard.
 *
 * Passive LP opens its position at the first price of whatever window it is
 * given, so applying a train-selected configuration to a test window centres it
 * on the test window's own opening price. Nothing leaks backwards.
 */

export interface LpFoldResult {
  name: string;
  trainRange: [number, number];
  testRange: [number, number];
  trainYears: number;
  testYears: number;
  /** Configuration selected on the training window alone. */
  best: LpParams;
  train: LpMetrics;
  test: LpMetrics;
  /**
   * Buy-and-hold ETH over the same windows. An LP position is structurally
   * long the volatile asset, so a fold's return says little on its own: the
   * question is whether the fees paid for the exposure. Without this column a
   * bull training window reads as skill.
   */
  trainEthReturnPct: number;
  testEthReturnPct: number;
}

export interface LpParams {
  rangePct: number;
  recenterBufferPct: number;
  recenterMinHours: number;
  /** Trailing-move threshold for the regime filter; 0 = filter off. */
  regimeMaxMovePct: number;
  /** Percent of ETH exposure held short; 0 = unhedged. */
  hedgeRatioPct: number;
  /** How the regime is measured. */
  regimeMetric: RegimeMetric;
}

export interface LpWalkForwardOptions {
  axes: LpAxes;
  /** RETURN | RISK_ADJUSTED | DRAWDOWN — same vocabulary as the grid sweep. */
  metric: string;
  input: Omit<LpEvalInput, "prices">;
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** Single train/test split at `trainFraction`. */
export function lpTrainTest(
  prices: PricePoint[],
  trainFraction: number,
  options: LpWalkForwardOptions,
): LpFoldResult {
  const { train, test } = trainTestSplit(prices, trainFraction);
  return runLpFold("TRAIN / TEST", train, test, options);
}

/**
 * Expanding-window walk-forward: each fold trains on everything up to a cut
 * and tests on the next chunk. Mirrors `walkForward()` in the grid module,
 * including the half-the-data initial training window.
 */
export function lpWalkForward(
  prices: PricePoint[],
  folds: number,
  options: LpWalkForwardOptions,
): LpFoldResult[] {
  if (folds < 1) throw new Error("folds must be >= 1");
  const results: LpFoldResult[] = [];
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
    results.push(runLpFold(`Fold ${f + 1}`, train, test, options));
  }
  return results;
}

function runLpFold(
  name: string,
  train: PricePoint[],
  test: PricePoint[],
  options: LpWalkForwardOptions,
): LpFoldResult {
  const trainSweep = sweepLp(options.axes, { ...options.input, prices: train });
  if (trainSweep.metrics.length === 0) {
    throw new Error(
      `No feasible LP configuration on the training window (${trainSweep.skipped} skipped)`,
    );
  }
  const best = rankLp(trainSweep.metrics, options.metric)[0]!;
  // Applied verbatim to unseen data — no refitting.
  const test_ = evaluateLp(
    best.rangePct,
    best.recenterBufferPct,
    best.recenterMinHours,
    { ...options.input, prices: test },
    best.regimeMaxMovePct,
    best.hedgeRatioPct,
    best.regimeMetric,
  );

  const span = (points: PricePoint[]) =>
    (points[points.length - 1]!.timestamp - points[0]!.timestamp) / SECONDS_PER_YEAR;
  const ethMove = (points: PricePoint[]) =>
    (points[points.length - 1]!.price / points[0]!.price - 1) * 100;

  return {
    name,
    trainEthReturnPct: ethMove(train),
    testEthReturnPct: ethMove(test),
    trainRange: [train[0]!.timestamp, train[train.length - 1]!.timestamp],
    testRange: [test[0]!.timestamp, test[test.length - 1]!.timestamp],
    trainYears: span(train),
    testYears: span(test),
    best: {
      rangePct: best.rangePct,
      recenterBufferPct: best.recenterBufferPct,
      recenterMinHours: best.recenterMinHours,
      regimeMaxMovePct: best.regimeMaxMovePct,
      hedgeRatioPct: best.hedgeRatioPct,
      regimeMetric: best.regimeMetric,
    },
    train: best,
    test: test_,
  };
}

export function describeLpParams(p: LpParams): string {
  const base =
    p.recenterBufferPct === 0
      ? `±${p.rangePct}%, never re-centred`
      : `±${p.rangePct}%, re-centre beyond ${p.recenterBufferPct}% (min ${p.recenterMinHours}h)`;
  const regime =
    p.regimeMaxMovePct > 0
      ? `${base}, stand aside above ${p.regimeMaxMovePct}% trailing move`
      : `${base}, regime filter off`;
  const withMetric =
    p.regimeMaxMovePct > 0 ? `${regime} [${p.regimeMetric}]` : regime;
  return p.hedgeRatioPct > 0 ? `${withMetric}, ${p.hedgeRatioPct}% short hedge` : withMetric;
}

export function formatLpFold(fold: LpFoldResult): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line(`${fold.name}  —  passive LP`);
  line(RULE);
  line();
  line(`Best configuration:  ${describeLpParams(fold.best)}`);
  line();
  line(
    `TRAIN  ${day(fold.trainRange[0])} → ${day(fold.trainRange[1])}` +
      `  (${fold.trainYears.toFixed(2)}y)`,
  );
  line(
    `  Return:            ${pct(fold.train.returnPct)}` +
      `   [${pct(annualize(fold.train.returnPct, fold.trainYears))} annualized]`,
  );
  line(`  Max drawdown:      ${pct(fold.train.maxDrawdownPct)}`);
  line(`  Time in range:     ${fold.train.timeInRangePct.toFixed(1)}%`);
  line(`  Re-centres:        ${fold.train.recenters}`);
  line(
    `  ETH hold:          ${pct(fold.trainEthReturnPct)}` +
      `   [${pct(fold.train.returnPct - fold.trainEthReturnPct)} pts vs LP]`,
  );
  line();
  line(
    `TEST   ${day(fold.testRange[0])} → ${day(fold.testRange[1])}` +
      `  (${fold.testYears.toFixed(2)}y)`,
  );
  line(
    `  Return:            ${pct(fold.test.returnPct)}` +
      `   [${pct(annualize(fold.test.returnPct, fold.testYears))} annualized]`,
  );
  line(`  Max drawdown:      ${pct(fold.test.maxDrawdownPct)}`);
  line(`  Time in range:     ${fold.test.timeInRangePct.toFixed(1)}%`);
  line(`  Re-centres:        ${fold.test.recenters}`);
  line(
    `  ETH hold:          ${pct(fold.testEthReturnPct)}` +
      `   [${pct(fold.test.returnPct - fold.testEthReturnPct)} pts vs LP]`,
  );
  line(`  Final value:       ${usd(fold.test.finalValue)}`);
  line();
  const decay =
    annualize(fold.test.returnPct, fold.testYears) -
    annualize(fold.train.returnPct, fold.trainYears);
  line(`Out-of-sample decay: ${pct(decay)} pts annualized (test − train)`);
  line(RULE);
  return lines.join("\n");
}

export function formatLpWalkForwardSummary(folds: LpFoldResult[]): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line("PASSIVE LP WALK-FORWARD SUMMARY");
  line(RULE);
  line();
  line("Fold      Range   Recentre  Regime  Metric         Train/yr   Test ret   Test/yr  Test MaxDD  Parked   Test ETH   vs ETH");
  line(THIN);
  for (const f of folds) {
    line(
      [
        f.name.padEnd(10),
        `±${f.best.rangePct}%`.padEnd(8),
        (f.best.recenterBufferPct === 0 ? "never" : `${f.best.recenterBufferPct}%`).padEnd(10),
        (f.best.regimeMaxMovePct > 0 ? `${f.best.regimeMaxMovePct}%` : "off").padEnd(8),
        (f.best.regimeMaxMovePct > 0 ? f.best.regimeMetric : "—").padEnd(15),
        pct(annualize(f.train.returnPct, f.trainYears)).padStart(10),
        pct(f.test.returnPct).padStart(11),
        pct(annualize(f.test.returnPct, f.testYears)).padStart(10),
        `${f.test.maxDrawdownPct.toFixed(1)}%`.padStart(12),
        `${f.test.timeParkedPct.toFixed(0)}%`.padStart(8),
        pct(f.testEthReturnPct).padStart(11),
        pct(f.test.returnPct - f.testEthReturnPct).padStart(9),
      ].join(""),
    );
  }
  line();
  const testReturns = folds.map((f) => f.test.returnPct);
  const testAnnual = folds.map((f) => annualize(f.test.returnPct, f.testYears));
  const positive = testReturns.filter((r) => r > 0).length;
  const avg = testReturns.reduce((a, b) => a + b, 0) / Math.max(testReturns.length, 1);
  const avgAnnual = testAnnual.reduce((a, b) => a + b, 0) / Math.max(testAnnual.length, 1);
  const worst = Math.min(...testAnnual);
  line(`Profitable out-of-sample folds:  ${positive}/${folds.length}`);
  line(`Average out-of-sample return:    ${pct(avg)}  (${pct(avgAnnual)} annualized)`);
  line(`Worst out-of-sample fold:        ${pct(worst)} annualized`);
  const beatEth = folds.filter((f) => f.test.returnPct > f.testEthReturnPct).length;
  line(`Folds beating ETH hold:          ${beatEth}/${folds.length}`);
  const stable = new Set(folds.map((f) => lpKey(f.best)));
  line(
    `Distinct winning configurations: ${stable.size}/${folds.length}` +
      (stable.size === 1
        ? "  (selection is stable)"
        : "  (parameters drift between folds)"),
  );
  if (stable.size === 1 && positive < folds.length) {
    line();
    line("  A stable selection that still loses out of sample is NOT validation:");
    line("  the sweep picks the same configuration every time and it is wrong");
    line("  every time. Stability of choice is not generalization of result.");
  }
  line(RULE);
  return lines.join("\n");
}

export interface LpConsensusPick {
  params: LpParams;
  /** How many folds picked this configuration as their train-best. */
  foldWins: number;
  meanOosReturnPct: number;
  worstOosReturnPct: number;
}

/**
 * A configuration that wins the training window in MANY folds is less likely
 * to be a historical accident than one that only wins the full period. Ranked
 * by fold wins, then by out-of-sample return.
 */
export function selectLpConsensus(folds: LpFoldResult[]): LpConsensusPick[] {
  const byKey = new Map<string, LpConsensusPick>();
  for (const f of folds) {
    const key = lpKey(f.best);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { params: f.best, foldWins: 0, meanOosReturnPct: 0, worstOosReturnPct: Infinity };
      byKey.set(key, entry);
    }
    entry.foldWins++;
    entry.meanOosReturnPct += f.test.returnPct;
    entry.worstOosReturnPct = Math.min(entry.worstOosReturnPct, f.test.returnPct);
  }
  const picks = [...byKey.values()];
  for (const p of picks) p.meanOosReturnPct /= Math.max(p.foldWins, 1);
  picks.sort((a, b) => b.foldWins - a.foldWins || b.meanOosReturnPct - a.meanOosReturnPct);
  return picks;
}

function lpKey(p: LpParams): string {
  return `${p.rangePct}|${p.recenterBufferPct}|${p.recenterMinHours}|${p.regimeMaxMovePct}|${p.hedgeRatioPct}|${p.regimeMetric}`;
}
