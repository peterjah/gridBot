import type { PricePoint } from "../data/provider.js";
import { RULE, THIN, day, mean, median, pct, price, signedUsd } from "./format.js";
import type {
  ConfigMetrics,
  EvaluationInput,
  GridCandidate,
  RankMetric,
  SweepAxes,
} from "./optimizer.js";
import { buildCandidates, describeCandidate, evaluate, feasibility } from "./optimizer.js";
import { regimeStats } from "./periods.js";

/**
 * Scenario analysis: pick every historical window that matches a market
 * profile, then judge a configuration on ALL of them at once.
 *
 * This exists because optimizing on one stretch of history is how you end up
 * with a configuration that fits one lucky uptrend. If the belief is "the
 * next year is a moderate uptrend", the useful question is not "what was best
 * in the single best moderate uptrend" but "what held up across every
 * moderate uptrend we have data for" — so candidates are ranked on their
 * MEDIAN across windows, and the spread is always reported alongside.
 */

export interface ScenarioWindow {
  name: string;
  prices: PricePoint[];
  movePct: number;
  annualizedVolPct: number;
}

export interface ScenarioFilter {
  /** Window length in months. */
  months: number;
  /** Step between window starts, in days. */
  stepDays: number;
  /** Inclusive bounds on the window's total move, in percent. */
  moveMin: number;
  moveMax: number;
  /** Optional bounds on annualized volatility, in percent. */
  volMin?: number;
  volMax?: number;
}

export interface ScenarioResult {
  candidate: GridCandidate;
  perWindow: { window: ScenarioWindow; metrics: ConfigMetrics }[];
  medianReturnPct: number;
  meanReturnPct: number;
  minReturnPct: number;
  maxReturnPct: number;
  /** Share of windows with a positive return, 0..1. */
  winRate: number;
  /** Share of windows where the grid beat ETH buy & hold, 0..1. */
  beatEthRate: number;
  medianVsEthPct: number;
  medianMaxDrawdownPct: number;
  medianGridPnL: number;
  medianResetPnL: number;
  medianTrades: number;
}

const HOUR = 3600;

/**
 * Every window of `months` length, stepped by `stepDays`, whose realized move
 * and volatility fall inside the filter.
 */
export function selectWindows(prices: PricePoint[], filter: ScenarioFilter): ScenarioWindow[] {
  if (prices.length < 2) return [];
  // Infer the sampling interval from the MEDIAN gap, not the average: real
  // exchange history has occasional outages, and averaging over them inflates
  // the step so that an "N month" window silently comes up short.
  const gaps: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    gaps.push(prices[i]!.timestamp - prices[i - 1]!.timestamp);
  }
  gaps.sort((a, b) => a - b);
  const stepSeconds = Math.max(1, gaps[Math.floor(gaps.length / 2)] ?? 1);
  const windowLen = Math.floor((filter.months * 30 * 24 * HOUR) / stepSeconds);
  const stride = Math.max(1, Math.floor((filter.stepDays * 24 * HOUR) / stepSeconds));
  if (windowLen < 2 || prices.length <= windowLen) return [];

  const windows: ScenarioWindow[] = [];
  for (let i = 0; i + windowLen <= prices.length; i += stride) {
    const slice = prices.slice(i, i + windowLen);
    const stats = regimeStats(slice);
    if (stats.movePct < filter.moveMin || stats.movePct > filter.moveMax) continue;
    if (filter.volMin !== undefined && stats.annualizedVolPct < filter.volMin) continue;
    if (filter.volMax !== undefined && stats.annualizedVolPct > filter.volMax) continue;
    windows.push({
      name: day(slice[0]!.timestamp),
      prices: slice,
      movePct: stats.movePct,
      annualizedVolPct: stats.annualizedVolPct,
    });
  }
  return windows;
}

/** Run one candidate over every scenario window and aggregate. */
export function evaluateScenario(
  candidate: GridCandidate,
  windows: ScenarioWindow[],
  input: Omit<EvaluationInput, "prices">,
): ScenarioResult {
  const perWindow = windows.map((window) => ({
    window,
    metrics: evaluate(candidate, { ...input, prices: window.prices }),
  }));

  const returns = perWindow.map((r) => r.metrics.returnPercent);
  const vsEth = perWindow.map((r) => r.metrics.benchmarks.vsEthPct);

  return {
    candidate,
    perWindow,
    medianReturnPct: median(returns),
    meanReturnPct: mean(returns),
    minReturnPct: Math.min(...returns),
    maxReturnPct: Math.max(...returns),
    winRate: returns.filter((r) => r > 0).length / Math.max(returns.length, 1),
    beatEthRate: vsEth.filter((v) => v > 0).length / Math.max(vsEth.length, 1),
    medianVsEthPct: median(vsEth),
    medianMaxDrawdownPct: median(perWindow.map((r) => r.metrics.maxDrawdownPct)),
    medianGridPnL: median(perWindow.map((r) => r.metrics.totalGridPnL)),
    medianResetPnL: median(perWindow.map((r) => r.metrics.totalResetPnL)),
    medianTrades: median(perWindow.map((r) => r.metrics.numberOfTrades)),
  };
}

export interface ScenarioSweep {
  results: ScenarioResult[];
  generated: number;
  skipped: number;
}

/** Sweep every feasible candidate across the scenario windows. */
export function sweepScenario(
  axes: SweepAxes,
  windows: ScenarioWindow[],
  input: Omit<EvaluationInput, "prices">,
): ScenarioSweep {
  if (windows.length === 0) throw new Error("No windows matched the scenario filter");
  const capital =
    input.base.initialUsdc + input.base.initialEth * windows[0]!.prices[0]!.price;
  const candidates = buildCandidates(axes, capital);
  const results: ScenarioResult[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    if (feasibility(candidate, input.base)) {
      skipped++;
      continue;
    }
    try {
      results.push(evaluateScenario(candidate, windows, input));
    } catch {
      skipped++;
    }
  }
  return { results, generated: candidates.length, skipped };
}

/**
 * Rank scenario results. The default is the MEDIAN across windows, not the
 * best window — a configuration that wins once and loses four times is not a
 * configuration worth running.
 */
export function rankScenario(results: ScenarioResult[], metric: RankMetric): ScenarioResult[] {
  const score = (r: ScenarioResult): number => {
    switch (metric) {
      case "RETURN":
        return r.medianReturnPct;
      case "RISK_ADJUSTED":
        return r.medianReturnPct / Math.max(Math.abs(r.medianMaxDrawdownPct), 1);
      case "DRAWDOWN":
        return -Math.abs(r.medianMaxDrawdownPct);
      case "GRID_PNL":
        return r.medianGridPnL;
    }
  };
  return [...results].sort(
    (a, b) => score(b) - score(a) || b.medianReturnPct - a.medianReturnPct,
  );
}

// ------------------------------------------------------------------ output

export function formatWindows(windows: ScenarioWindow[], filter: ScenarioFilter): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  line(RULE);
  line("SCENARIO WINDOWS");
  line(RULE);
  line();
  line(
    `Profile: ${filter.months}-month windows with a move of ${pct(filter.moveMin, 0)} to ` +
      `${pct(filter.moveMax, 0)}, stepped every ${filter.stepDays} days`,
  );
  line(`Matched: ${windows.length} historical windows`);
  line();
  line(`${"Start".padEnd(14)}${"End".padEnd(14)}${"Move".padStart(9)}${"Ann.vol".padStart(10)}${"Price range".padStart(24)}`);
  line(THIN);
  for (const w of windows) {
    const last = w.prices[w.prices.length - 1]!;
    line(
      w.name.padEnd(14) +
        day(last.timestamp).padEnd(14) +
        pct(w.movePct, 1).padStart(9) +
        `${w.annualizedVolPct.toFixed(0)}%`.padStart(10) +
        `${price(w.prices[0]!.price)} → ${price(last.price)}`.padStart(24),
    );
  }
  line(RULE);
  return lines.join("\n");
}

export function formatScenarioTable(
  results: ScenarioResult[],
  metric: RankMetric,
  limit: number,
  windowCount: number,
): string {
  const ranked = rankScenario(results, metric).slice(0, limit);
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line(`TOP CONFIGURATIONS ACROSS ${windowCount} WINDOWS  (ranked by median ${metric})`);
  line(RULE);
  line();
  line(
    "Rank  Spacing  Width  Reset  Order   MedRet   MeanRet    Worst     Best   MedDD   Win%  BeatETH%   vs ETH",
  );
  line(THIN);
  ranked.forEach((r, i) => {
    const c = r.candidate;
    line(
      [
        String(i + 1).padEnd(6),
        `${c.spacingPercent}%`.padEnd(9),
        `${c.widthPercent}%`.padEnd(7),
        String(c.resetBufferLevels).padEnd(7),
        `${c.orderSizePercent}%`.padEnd(8),
        pct(r.medianReturnPct).padStart(8),
        pct(r.meanReturnPct).padStart(10),
        pct(r.minReturnPct).padStart(9),
        pct(r.maxReturnPct).padStart(9),
        `${r.medianMaxDrawdownPct.toFixed(1)}%`.padStart(8),
        `${(r.winRate * 100).toFixed(0)}%`.padStart(7),
        `${(r.beatEthRate * 100).toFixed(0)}%`.padStart(10),
        pct(r.medianVsEthPct).padStart(9),
      ].join(""),
    );
  });
  line(RULE);
  return lines.join("\n");
}

/** Per-window breakdown of a single configuration. */
export function formatScenarioDetail(result: ScenarioResult): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line("BEST CONFIGURATION — PER-WINDOW BREAKDOWN");
  line(RULE);
  line();
  line(describeCandidate(result.candidate));
  line();
  line(
    `${"Window".padEnd(14)}${"Move".padStart(9)}${"Ann.vol".padStart(9)}${"Return".padStart(10)}` +
      `${"ETH hold".padStart(11)}${"vs ETH".padStart(10)}${"MaxDD".padStart(9)}` +
      `${"Grid P&L".padStart(12)}${"Reset P&L".padStart(12)}${"Trades".padStart(8)}`,
  );
  line(THIN);
  for (const { window, metrics } of result.perWindow) {
    line(
      window.name.padEnd(14) +
        pct(window.movePct, 1).padStart(9) +
        `${window.annualizedVolPct.toFixed(0)}%`.padStart(9) +
        pct(metrics.returnPercent).padStart(10) +
        pct(metrics.benchmarks.ethReturnPct).padStart(11) +
        pct(metrics.benchmarks.vsEthPct).padStart(10) +
        `${metrics.maxDrawdownPct.toFixed(1)}%`.padStart(9) +
        signedUsd(metrics.totalGridPnL).padStart(12) +
        signedUsd(metrics.totalResetPnL).padStart(12) +
        String(metrics.numberOfTrades).padStart(8),
    );
  }
  line();
  line(`Median return:       ${pct(result.medianReturnPct)}`);
  line(`Mean return:         ${pct(result.meanReturnPct)}`);
  line(`Worst / best:        ${pct(result.minReturnPct)} / ${pct(result.maxReturnPct)}`);
  line(`Profitable windows:  ${(result.winRate * 100).toFixed(0)}%`);
  line(`Beat ETH hold in:    ${(result.beatEthRate * 100).toFixed(0)}% of windows`);
  line(`Median vs ETH:       ${pct(result.medianVsEthPct)} pts`);
  line(RULE);
  return lines.join("\n");
}
