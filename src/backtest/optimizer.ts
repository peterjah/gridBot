import type { PricePoint } from "../data/provider.js";
import type { GridConfig } from "../grid/types.js";
import { GridStrategy } from "../grid/gridStrategy.js";
import { LinearCostFillModel } from "../grid/fillModel.js";
import { assertAccountingReconciles, runBacktest } from "./backtester.js";
import type { GasModel } from "./gasModel.js";
import type { BacktestResult } from "./backtester.js";
import type { AaveAprPoint } from "./lendingYield.js";
import { ethHoldBenchmark, staticLpBenchmark, usdcOnlyBenchmark } from "./benchmarks.js";
import { RULE, THIN, pct, signedUsd, usd } from "./format.js";

/** One point in the search space. */
export interface GridCandidate {
  /** Spacing between levels, in percent. */
  spacingPercent: number;
  /** Half-width of the grid, in percent (levels are derived from it). */
  widthPercent: number;
  levelsAbove: number;
  levelsBelow: number;
  /** Spacings beyond the outermost level that trigger a reset. */
  resetBufferLevels: number;
  /** Order notional as a fraction of initial capital, in percent. */
  orderSizePercent: number;
  orderSizeUsd: number;
  /**
   * Risk axes. `undefined` means "inherit the base config" so that a default
   * sweep behaves exactly as before this was added.
   */
  maxVolPerStep?: number;
  /** ETH inventory ceiling as a percent of capital; 0 = uncapped. */
  inventoryCapPercent?: number;
  /** Cooldown hours required before the grid may be rebuilt. */
  cooldownHours?: number;
  /** Fraction of inventory sold at a reset, in [0,1]. */
  resetSellFraction?: number;
  /** Carry inventory instead of selling when underwater by more than this %. */
  underwaterSkipPct?: number;
  /** Rebuild immediately when a reset had no inventory to sell. */
  skipCooldownWhenFlat?: boolean;
  /** Observations a band exit must persist before it liquidates. */
  confirmObservations?: number;
  /** Postpone the liquidation while realized volatility is elevated. */
  volPostpone?: boolean;
  /** Drawdown-from-peak that forces a full liquidation regardless. */
  hardDrawdownPct?: number;
}

/**
 * The axes swept by the optimizer.
 *
 * The first four follow spec section 9. The last three exist because the
 * binding constraint on this strategy is not the grid geometry but how much
 * inventory it accumulates before a reset dumps it: the grid itself earns
 * money, and the resets are what give it back. Leave them empty to inherit
 * the base configuration and reproduce the original 4-axis sweep exactly.
 */
export interface SweepAxes {
  spacings: number[];
  widths: number[];
  resetBuffers: number[];
  orderFractions: number[];
  /** Volatility-gate ceilings (per-observation realized vol). */
  maxVols?: number[];
  /** ETH inventory caps as a percent of capital; 0 = uncapped. */
  inventoryCaps?: number[];
  /** Cooldown hours before a rebuild is allowed. */
  cooldownHours?: number[];
  /** Reset liquidation fractions: 1 = dump everything (the original policy). */
  sellFractions?: number[];
  /** Underwater thresholds (%) beyond which a reset carries its inventory. */
  underwaterSkips?: number[];
  /** Skip the post-reset cooldown when flat: [0], [1] or both. */
  skipFlatCooldowns?: number[];
  /** Confirmation observations before a band exit liquidates. */
  confirmObservations?: number[];
  /** Postpone liquidation while volatile: [0], [1] or both. */
  volPostpones?: number[];
  /** Hard drawdown backstops (%); 0 disables. */
  hardDrawdowns?: number[];
}

export const DEFAULT_AXES: SweepAxes = {
  spacings: [0.25, 0.5, 0.75, 1, 1.5, 2, 3],
  widths: [3, 5, 10, 15, 20, 30],
  resetBuffers: [1, 2, 3, 4, 5],
  orderFractions: [1, 2, 5, 10],
};

/** Which optional axes actually vary — used to keep the output table narrow. */
export function activeAxes(axes: SweepAxes): {
  vol: boolean;
  cap: boolean;
  cooldown: boolean;
  sell: boolean;
  underwater: boolean;
  skipFlat: boolean;
  confirm: boolean;
  postpone: boolean;
  hardDd: boolean;
} {
  return {
    vol: (axes.maxVols?.length ?? 0) > 0,
    cap: (axes.inventoryCaps?.length ?? 0) > 0,
    cooldown: (axes.cooldownHours?.length ?? 0) > 0,
    sell: (axes.sellFractions?.length ?? 0) > 0,
    underwater: (axes.underwaterSkips?.length ?? 0) > 0,
    skipFlat: (axes.skipFlatCooldowns?.length ?? 0) > 0,
    confirm: (axes.confirmObservations?.length ?? 0) > 0,
    postpone: (axes.volPostpones?.length ?? 0) > 0,
    hardDd: (axes.hardDrawdowns?.length ?? 0) > 0,
  };
}

export type RankMetric =
  | "RETURN"
  | "RISK_ADJUSTED"
  | "DRAWDOWN"
  | "GRID_PNL"
  | "ROBUST";

export const RANK_METRICS: RankMetric[] = [
  "RETURN",
  "RISK_ADJUSTED",
  "DRAWDOWN",
  "GRID_PNL",
  "ROBUST",
];

/** Passive comparisons computed for every configuration (spec section 13). */
export interface BenchmarkComparison {
  usdcReturnPct: number;
  ethReturnPct: number;
  lpReturnPct: number;
  /** Grid return minus the benchmark return, in percentage points. */
  vsUsdcPct: number;
  vsEthPct: number;
  vsLpPct: number;
}

/** Full metric set for one evaluated configuration (spec section 11). */
export interface ConfigMetrics {
  candidate: GridCandidate;
  finalPortfolioValue: number;
  returnPercent: number;
  maxDrawdownPct: number;
  totalGridPnL: number;
  totalResetPnL: number;
  unrealizedPnL: number;
  totalFeeIncome: number;
  totalFees: number;
  totalSlippage: number;
  totalGas: number;
  numberOfTrades: number;
  numberOfResets: number;
  completedCycles: number;
  averageResetLoss: number;
  maxResetLoss: number;
  maxEthExposurePct: number;
  avgEthExposurePct: number;
  /** Time-averaged share of the portfolio working as liquidity, percent. */
  avgDeployedPct: number;
  /** Time-averaged idle balance, USD — the money-market opportunity. */
  avgIdleUsd: number;
  /** returnPercent / |maxDrawdownPct|, drawdown-free runs handled safely. */
  riskAdjustedScore: number;
  /**
   * Median return of this configuration together with its immediate
   * neighbours in parameter space. Populated by `scoreRobustness`.
   *
   * A configuration that only wins because one lucky cell spiked is
   * surrounded by mediocre neighbours and scores badly here; one sitting on a
   * plateau scores close to its own return. Selecting on this prefers regions
   * that are stable under small parameter changes — which is what "these
   * parameters will still work next month" actually requires.
   */
  robustScore: number;
  /** Number of neighbours found; 0 means the score is just the own return. */
  neighbourCount: number;
  benchmarks: BenchmarkComparison;
}

export interface EvaluationInput {
  prices: PricePoint[];
  /** Base config; capital, costs and vol controls are taken from here. */
  base: GridConfig;
  estimatedGasUsd: number;
  /** Structured gas model; falls back to the flat per-fill cost above. */
  gas?: GasModel;
  /** Charge money-market legs on trading transactions. */
  lendingGasLegs?: boolean;
  /** Daily Aave supply-APR series; enables lending income on idle USDC. */
  aaveYield?: { series: AaveAprPoint[]; bufferUsdc: number };
  /** Center the grid on the first price of the series (default true). */
  autoCenter?: boolean;
}

/** A configuration rejected before it ran, with the reason why. */
export interface SkippedConfig {
  candidate: GridCandidate;
  reason: string;
}

export interface SweepResult {
  metrics: ConfigMetrics[];
  skipped: SkippedConfig[];
  /** Number of candidates generated before feasibility filtering. */
  generated: number;
}

/**
 * Number of levels that spans `widthPercent` at `spacingPercent`.
 * Grid width is expressed through the EXISTING level count rather than a new
 * concept: levels = round(ln(1 + width) / ln(1 + spacing)).
 */
export function levelsForWidth(widthPercent: number, spacingPercent: number): number {
  if (spacingPercent <= 0) throw new Error("spacingPercent must be > 0");
  const levels = Math.round(
    Math.log1p(widthPercent / 100) / Math.log1p(spacingPercent / 100),
  );
  return Math.max(levels, 1);
}

/** Cartesian product of the axes, with derived level counts and order sizes. */
export function buildCandidates(axes: SweepAxes, capitalUsd: number): GridCandidate[] {
  const candidates: GridCandidate[] = [];
  // `[undefined]` keeps an unswept axis as a single "inherit the base" value,
  // so the product collapses to the original four dimensions.
  const vols: (number | undefined)[] = axes.maxVols?.length ? axes.maxVols : [undefined];
  const caps: (number | undefined)[] = axes.inventoryCaps?.length
    ? axes.inventoryCaps
    : [undefined];
  const cooldowns: (number | undefined)[] = axes.cooldownHours?.length
    ? axes.cooldownHours
    : [undefined];
  const sells: (number | undefined)[] = axes.sellFractions?.length
    ? axes.sellFractions
    : [undefined];
  const underwaters: (number | undefined)[] = axes.underwaterSkips?.length
    ? axes.underwaterSkips
    : [undefined];
  const skipFlats: (number | undefined)[] = axes.skipFlatCooldowns?.length
    ? axes.skipFlatCooldowns
    : [undefined];
  const confirms: (number | undefined)[] = axes.confirmObservations?.length
    ? axes.confirmObservations
    : [undefined];
  const postpones: (number | undefined)[] = axes.volPostpones?.length
    ? axes.volPostpones
    : [undefined];
  const hardDds: (number | undefined)[] = axes.hardDrawdowns?.length
    ? axes.hardDrawdowns
    : [undefined];

  for (const spacingPercent of axes.spacings) {
    for (const widthPercent of axes.widths) {
      const levels = levelsForWidth(widthPercent, spacingPercent);
      for (const resetBufferLevels of axes.resetBuffers) {
        for (const orderSizePercent of axes.orderFractions) {
          for (const maxVolPerStep of vols) {
            for (const inventoryCapPercent of caps) {
              for (const cooldown of cooldowns) {
                for (const resetSellFraction of sells) {
                  for (const underwaterSkipPct of underwaters) {
                    for (const skipFlat of skipFlats) {
                      for (const confirm of confirms) {
                        for (const postpone of postpones) {
                          for (const hardDrawdownPct of hardDds) {
                            candidates.push({
                              spacingPercent,
                              widthPercent,
                              levelsAbove: levels,
                              levelsBelow: levels,
                              resetBufferLevels,
                              orderSizePercent,
                              orderSizeUsd: (capitalUsd * orderSizePercent) / 100,
                              maxVolPerStep,
                              inventoryCapPercent,
                              cooldownHours: cooldown,
                              resetSellFraction,
                              underwaterSkipPct,
                              skipCooldownWhenFlat:
                                skipFlat === undefined ? undefined : skipFlat !== 0,
                              confirmObservations: confirm,
                              volPostpone:
                                postpone === undefined ? undefined : postpone !== 0,
                              hardDrawdownPct,
                            });
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return candidates;
}

/**
 * Reject configurations that cannot work before spending time on them:
 *  - the buy side of the grid would need more capital than we have;
 *  - the order is too small to be worth a fill;
 *  - the spacing cannot pay its own fees (the strategy would throw).
 */
export function feasibility(
  candidate: GridCandidate,
  base: GridConfig,
): string | null {
  const capitalNeeded = candidate.orderSizeUsd * candidate.levelsBelow;
  if (capitalNeeded > base.initialUsdc) {
    return `needs ${usd(capitalNeeded)} to fill ${candidate.levelsBelow} buy levels, have ${usd(base.initialUsdc)}`;
  }
  if (candidate.orderSizeUsd < 1) return "order size below $1";
  const minSpacing = (10 * (base.feeBps + base.slippageBps)) / 100;
  if (candidate.spacingPercent < minSpacing) {
    return `spacing ${candidate.spacingPercent}% below the cost-aware minimum ${minSpacing.toFixed(3)}%`;
  }
  const cap = candidate.inventoryCapPercent;
  if (cap !== undefined && cap > 0) {
    // A cap below one order notional blocks the very first buy: the grid
    // would never hold inventory, which is not a configuration worth ranking.
    const capUsd = (base.initialUsdc * cap) / 100;
    if (capUsd < candidate.orderSizeUsd) {
      return `inventory cap ${usd(capUsd)} is below one order of ${usd(candidate.orderSizeUsd)}`;
    }
  }
  return null;
}

/** Materialize a candidate into a runnable GridConfig. */
export function candidateConfig(
  candidate: GridCandidate,
  input: EvaluationInput,
): GridConfig {
  const autoCenter = input.autoCenter !== false;
  const capital = input.base.initialUsdc + input.base.initialEth * input.prices[0]!.price;
  const cap = candidate.inventoryCapPercent;
  return {
    ...input.base,
    centerPrice: autoCenter ? input.prices[0]!.price : input.base.centerPrice,
    spacingPercent: candidate.spacingPercent,
    levelsAbove: candidate.levelsAbove,
    levelsBelow: candidate.levelsBelow,
    orderSizeUsd: candidate.orderSizeUsd,
    resetBufferLevels: candidate.resetBufferLevels,
    maxVolPerStep: candidate.maxVolPerStep ?? input.base.maxVolPerStep,
    // 0 (or unset) means uncapped, matching MAX_ETH_USD's open default.
    maxEthUsd:
      cap === undefined || cap <= 0
        ? input.base.maxEthUsd
        : (capital * cap) / 100,
    regenMinSeconds:
      candidate.cooldownHours === undefined
        ? input.base.regenMinSeconds
        : candidate.cooldownHours * 3600,
    resetSellFraction: candidate.resetSellFraction ?? input.base.resetSellFraction,
    resetUnderwaterSkipPct: candidate.underwaterSkipPct ?? input.base.resetUnderwaterSkipPct,
    resetSkipCooldownWhenFlat:
      candidate.skipCooldownWhenFlat ?? input.base.resetSkipCooldownWhenFlat,
    resetConfirmObservations:
      candidate.confirmObservations ?? input.base.resetConfirmObservations,
    resetVolPostpone: candidate.volPostpone ?? input.base.resetVolPostpone,
    resetHardDrawdownPct: candidate.hardDrawdownPct ?? input.base.resetHardDrawdownPct,
  };
}

/** Run one configuration end to end and collect its metrics. */
export function evaluate(candidate: GridCandidate, input: EvaluationInput): ConfigMetrics {
  const cfg = candidateConfig(candidate, input);
  const strategy = new GridStrategy(cfg, new LinearCostFillModel(cfg.feeBps, cfg.slippageBps));
  const result = runBacktest(
    strategy,
    input.prices,
    input.gas ?? input.estimatedGasUsd,
    input.lendingGasLegs ?? false,
    input.aaveYield,
  );
  // A configuration whose books do not balance must never be ranked.
  assertAccountingReconciles(result);
  return metricsFor(candidate, result, input);
}

export function metricsFor(
  candidate: GridCandidate,
  result: BacktestResult,
  input: EvaluationInput,
): ConfigMetrics {
  const resetPnls = result.resets.map((r) => r.realizedResetPnlUsd);
  const losses = resetPnls.filter((p) => p < 0);

  return {
    candidate,
    finalPortfolioValue: result.finalPortfolioValue,
    returnPercent: result.returnPct,
    maxDrawdownPct: result.maxDrawdownPct,
    totalGridPnL: result.gridPnlUsd,
    totalResetPnL: result.resetPnlUsd,
    unrealizedPnL: result.unrealizedPnlUsd,
    totalFeeIncome: result.feeIncomeUsd,
    totalFees: result.totalFeeUsd,
    totalSlippage: result.totalSlippageUsd,
    totalGas: result.totalGasUsd,
    numberOfTrades: result.buysExecuted + result.sellsExecuted,
    numberOfResets: result.resets.length,
    completedCycles: result.completedCycles,
    averageResetLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
    maxResetLoss: resetPnls.length ? Math.min(...resetPnls, 0) : 0,
    maxEthExposurePct: result.inventory.maxEthExposurePct,
    avgEthExposurePct: result.inventory.avgEthExposurePct,
    avgDeployedPct: result.inventory.avgDeployedPct,
    avgIdleUsd: result.inventory.avgIdleUsd,
    riskAdjustedScore: riskAdjusted(result.returnPct, result.maxDrawdownPct),
    // Filled in by scoreRobustness once the whole sweep is known.
    robustScore: result.returnPct,
    neighbourCount: 0,
    benchmarks: benchmarkComparison(result, input),
  };
}

/**
 * Simple risk-adjusted score: return per unit of drawdown.
 * A run with no drawdown is not infinitely good — it is scored on return
 * alone (equivalently, a floor of 1 percentage point of drawdown).
 */
export function riskAdjusted(returnPct: number, maxDrawdownPct: number): number {
  const dd = Math.abs(maxDrawdownPct);
  return returnPct / Math.max(dd, 1);
}

export function benchmarkComparison(
  result: BacktestResult,
  input: EvaluationInput,
): BenchmarkComparison {
  const bench = {
    prices: input.prices,
    initialUsdc: input.base.initialUsdc,
    initialEth: input.base.initialEth,
  };
  const capital = result.initialCapital;
  const ret = (value: number) => (capital > 0 ? ((value - capital) / capital) * 100 : 0);

  const usdcReturnPct = ret(usdcOnlyBenchmark(bench, input.prices[0]!.price).finalValue);
  const ethReturnPct = ret(ethHoldBenchmark(bench).finalValue);
  const lpReturnPct = ret(staticLpBenchmark(bench).finalValue);

  return {
    usdcReturnPct,
    ethReturnPct,
    lpReturnPct,
    vsUsdcPct: result.returnPct - usdcReturnPct,
    vsEthPct: result.returnPct - ethReturnPct,
    vsLpPct: result.returnPct - lpReturnPct,
  };
}

/** Run the whole sweep. Infeasible candidates are recorded, never silently dropped. */
export function sweep(axes: SweepAxes, input: EvaluationInput): SweepResult {
  const candidates = buildCandidates(axes, input.base.initialUsdc + input.base.initialEth * input.prices[0]!.price);
  const metrics: ConfigMetrics[] = [];
  const skipped: SkippedConfig[] = [];

  for (const candidate of candidates) {
    const reason = feasibility(candidate, input.base);
    if (reason) {
      skipped.push({ candidate, reason });
      continue;
    }
    try {
      metrics.push(evaluate(candidate, input));
    } catch (error) {
      skipped.push({ candidate, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // Robustness is a property of the sweep, not of one run, so it can only be
  // scored once every candidate has been evaluated.
  scoreRobustness(metrics);

  return { metrics, skipped, generated: candidates.length };
}

/**
 * Two candidates are neighbours when they differ on exactly one axis, and on
 * that axis their values are adjacent in the swept list. Mutates `metrics` to
 * fill in `robustScore` / `neighbourCount`.
 */
export function scoreRobustness(metrics: ConfigMetrics[]): ConfigMetrics[] {
  const axisOf = (m: ConfigMetrics): number[] => [
    m.candidate.spacingPercent,
    m.candidate.widthPercent,
    m.candidate.resetBufferLevels,
    m.candidate.orderSizePercent,
    m.candidate.maxVolPerStep ?? 0,
    m.candidate.inventoryCapPercent ?? 0,
    m.candidate.cooldownHours ?? 0,
    m.candidate.resetSellFraction ?? 1,
    m.candidate.underwaterSkipPct ?? 0,
  ];

  const vectors = metrics.map(axisOf);
  const axisCount = vectors[0]?.length ?? 0;
  // Sorted unique values per axis, so "adjacent" means one step on the grid
  // the sweep actually explored rather than an arbitrary numeric distance.
  const levels: number[][] = [];
  for (let a = 0; a < axisCount; a++) {
    levels.push([...new Set(vectors.map((v) => v[a]!))].sort((x, y) => x - y));
  }
  const indexOf = levels.map((vals) => new Map(vals.map((v, i) => [v, i])));

  const coords = vectors.map((v) => v.map((val, a) => indexOf[a]!.get(val)!));
  const byKey = new Map<string, number>();
  coords.forEach((c, i) => byKey.set(c.join(","), i));

  metrics.forEach((m, i) => {
    const c = coords[i]!;
    const returns: number[] = [m.returnPercent];
    let found = 0;
    for (let a = 0; a < axisCount; a++) {
      for (const delta of [-1, 1]) {
        const probe = [...c];
        probe[a] = probe[a]! + delta;
        if (probe[a]! < 0 || probe[a]! >= levels[a]!.length) continue;
        const j = byKey.get(probe.join(","));
        if (j === undefined) continue;
        returns.push(metrics[j]!.returnPercent);
        found++;
      }
    }
    m.robustScore = median(returns);
    m.neighbourCount = found;
  });

  return metrics;
}

/** Median of a numeric list. Local copy to keep this module self-contained. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** Sort a copy of `metrics` best-first under the chosen ranking metric. */
export function rank(metrics: ConfigMetrics[], metric: RankMetric): ConfigMetrics[] {
  const score = (m: ConfigMetrics): number => {
    switch (metric) {
      // Same ordering as finalPortfolioValue (capital is constant across
      // configurations), expressed in percent so periods stay comparable.
      case "RETURN":
        return m.returnPercent;
      case "RISK_ADJUSTED":
        return m.riskAdjustedScore;
      // Least-bad drawdown first; ties broken on return by the fallback below.
      case "DRAWDOWN":
        return -Math.abs(m.maxDrawdownPct);
      case "GRID_PNL":
        return m.totalGridPnL;
      case "ROBUST":
        return m.robustScore;
    }
  };
  return [...metrics].sort((a, b) => score(b) - score(a) || b.returnPercent - a.returnPercent);
}

export function parseRankMetric(raw: string | undefined, fallback: RankMetric = "RETURN"): RankMetric {
  if (!raw) return fallback;
  const upper = raw.trim().toUpperCase().replace(/[-\s]/g, "_");
  if ((RANK_METRICS as string[]).includes(upper)) return upper as RankMetric;
  throw new Error(`Unknown optimizer metric "${raw}". Expected one of: ${RANK_METRICS.join(", ")}`);
}

// ------------------------------------------------------------------ output

/** One-line description of a candidate, used in headers and logs. */
export function describeCandidate(c: GridCandidate): string {
  const parts = [
    `spacing ${c.spacingPercent}%`,
    `width ±${c.widthPercent}% (${c.levelsBelow} levels)`,
    `reset ${c.resetBufferLevels}`,
    `order ${c.orderSizePercent}% (${usd(c.orderSizeUsd)})`,
  ];
  if (c.maxVolPerStep !== undefined) parts.push(`vol gate ${c.maxVolPerStep}`);
  if (c.inventoryCapPercent !== undefined) {
    parts.push(`inventory cap ${c.inventoryCapPercent <= 0 ? "none" : `${c.inventoryCapPercent}%`}`);
  }
  if (c.cooldownHours !== undefined) parts.push(`cooldown ${c.cooldownHours}h`);
  if (c.resetSellFraction !== undefined) {
    parts.push(`reset sells ${(c.resetSellFraction * 100).toFixed(0)}%`);
  }
  if (c.underwaterSkipPct !== undefined) {
    parts.push(
      c.underwaterSkipPct > 0 ? `carry below -${c.underwaterSkipPct}%` : "no underwater carry",
    );
  }
  if (c.skipCooldownWhenFlat !== undefined) {
    parts.push(c.skipCooldownWhenFlat ? "fast rebuild when flat" : "always cool down");
  }
  if (c.confirmObservations !== undefined) parts.push(`confirm ${c.confirmObservations}`);
  if (c.volPostpone !== undefined) parts.push(c.volPostpone ? "vol-postpone" : "no vol-postpone");
  if (c.hardDrawdownPct !== undefined) {
    parts.push(c.hardDrawdownPct > 0 ? `hard DD ${c.hardDrawdownPct}%` : "no hard DD");
  }
  return parts.join(" · ");
}

/** Compact `key=value` form of a candidate, replayable via `--config`. */
export function candidateSpec(c: GridCandidate): string {
  const parts = [
    `spacing=${c.spacingPercent}`,
    `width=${c.widthPercent}`,
    `reset=${c.resetBufferLevels}`,
    `order=${c.orderSizePercent}`,
  ];
  if (c.maxVolPerStep !== undefined) parts.push(`max-vol=${c.maxVolPerStep}`);
  if (c.inventoryCapPercent !== undefined) parts.push(`cap=${c.inventoryCapPercent}`);
  if (c.cooldownHours !== undefined) parts.push(`cooldown=${c.cooldownHours}`);
  if (c.resetSellFraction !== undefined) parts.push(`sell=${c.resetSellFraction}`);
  if (c.underwaterSkipPct !== undefined) parts.push(`underwater=${c.underwaterSkipPct}`);
  if (c.skipCooldownWhenFlat !== undefined) {
    parts.push(`skip-flat-cooldown=${c.skipCooldownWhenFlat ? 1 : 0}`);
  }
  if (c.confirmObservations !== undefined) parts.push(`confirm=${c.confirmObservations}`);
  if (c.volPostpone !== undefined) parts.push(`vol-postpone=${c.volPostpone ? 1 : 0}`);
  if (c.hardDrawdownPct !== undefined) parts.push(`hard-dd=${c.hardDrawdownPct}`);
  return parts.join(",");
}

/** Ranked table (spec sections 10 and 22). */
export function formatRankedTable(
  metrics: ConfigMetrics[],
  metric: RankMetric,
  limit = 15,
  axes?: SweepAxes,
): string {
  const ranked = rank(metrics, metric).slice(0, limit);
  // Only render the risk axes that are actually being swept, so a default
  // 4-axis run keeps the narrow table it had before.
  const show = axes
    ? activeAxes(axes)
    : {
        vol: ranked.some((m) => m.candidate.maxVolPerStep !== undefined),
        cap: ranked.some((m) => m.candidate.inventoryCapPercent !== undefined),
        cooldown: ranked.some((m) => m.candidate.cooldownHours !== undefined),
        sell: ranked.some((m) => m.candidate.resetSellFraction !== undefined),
        underwater: ranked.some((m) => m.candidate.underwaterSkipPct !== undefined),
        skipFlat: ranked.some((m) => m.candidate.skipCooldownWhenFlat !== undefined),
        confirm: ranked.some((m) => m.candidate.confirmObservations !== undefined),
        postpone: ranked.some((m) => m.candidate.volPostpone !== undefined),
        hardDd: ranked.some((m) => m.candidate.hardDrawdownPct !== undefined),
      };

  const head: [string, number][] = [
    ["Rank", 6],
    ["Spacing", 9],
    ["Width", 7],
    ["Reset", 7],
    ["Order", 8],
  ];
  if (show.vol) head.push(["VolGate", 9]);
  if (show.cap) head.push(["Cap", 7]);
  if (show.cooldown) head.push(["Cool", 7]);
  if (show.sell) head.push(["Sell", 7]);
  if (show.underwater) head.push(["Carry", 8]);
  if (show.skipFlat) head.push(["FastRb", 8]);
  if (show.confirm) head.push(["Confirm", 9]);
  if (show.postpone) head.push(["Postpn", 8]);
  if (show.hardDd) head.push(["HardDD", 8]);

  const tail: [string, number][] = [
    ["Return", 9],
    ["MaxDD", 9],
    ["Grid P&L", 13],
    ["Reset P&L", 13],
    ["Costs", 11],
    ["Resets", 7],
    ["Trades", 8],
    ["vs ETH", 9],
  ];

  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line(`TOP CONFIGURATIONS  (ranked by ${metric})`);
  line(RULE);
  line();
  line(
    head.map(([h, w]) => h.padEnd(w)).join("") +
      tail.map(([h, w]) => h.padStart(w)).join(""),
  );
  line(THIN);
  ranked.forEach((m, i) => {
    const c = m.candidate;
    const costs = m.totalFees + m.totalSlippage + m.totalGas;
    const left = [
      String(i + 1),
      `${c.spacingPercent}%`,
      `${c.widthPercent}%`,
      String(c.resetBufferLevels),
      `${c.orderSizePercent}%`,
    ];
    if (show.vol) left.push(String(c.maxVolPerStep ?? "—"));
    if (show.cap) {
      const cap = c.inventoryCapPercent;
      left.push(cap === undefined ? "—" : cap <= 0 ? "none" : `${cap}%`);
    }
    if (show.cooldown) left.push(c.cooldownHours === undefined ? "—" : `${c.cooldownHours}h`);
    if (show.sell) {
      left.push(c.resetSellFraction === undefined ? "—" : `${(c.resetSellFraction * 100).toFixed(0)}%`);
    }
    if (show.underwater) {
      const u = c.underwaterSkipPct;
      left.push(u === undefined ? "—" : u > 0 ? `-${u}%` : "off");
    }
    if (show.skipFlat) left.push(c.skipCooldownWhenFlat === undefined ? "—" : c.skipCooldownWhenFlat ? "yes" : "no");
    if (show.confirm) left.push(c.confirmObservations === undefined ? "—" : String(c.confirmObservations));
    if (show.postpone) left.push(c.volPostpone === undefined ? "—" : c.volPostpone ? "yes" : "no");
    if (show.hardDd) {
      const h = c.hardDrawdownPct;
      left.push(h === undefined ? "—" : h > 0 ? `${h}%` : "off");
    }

    const right = [
      pct(m.returnPercent),
      `${m.maxDrawdownPct.toFixed(1)}%`,
      signedUsd(m.totalGridPnL),
      signedUsd(m.totalResetPnL),
      signedUsd(-costs),
      String(m.numberOfResets),
      String(m.numberOfTrades),
      pct(m.benchmarks.vsEthPct),
    ];
    line(
      left.map((v, k) => v.padEnd(head[k]![1])).join("") +
        right.map((v, k) => v.padStart(tail[k]![1])).join(""),
    );
  });
  line(RULE);
  return lines.join("\n");
}

/** Benchmark block for a single configuration (spec section 13). */
export function formatBenchmarkComparison(m: ConfigMetrics): string {
  const b = m.benchmarks;
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  line("Benchmarks");
  line(`  Grid return:       ${pct(m.returnPercent)}`);
  line(`  USDC return:       ${pct(b.usdcReturnPct)}`);
  line(`  ETH return:        ${pct(b.ethReturnPct)}`);
  line(`  Static V3 LP:      ${pct(b.lpReturnPct)}`);
  line(`  Grid vs USDC:      ${pct(b.vsUsdcPct)} pts`);
  line(`  Grid vs ETH:       ${pct(b.vsEthPct)} pts`);
  line(`  Grid vs LP:        ${pct(b.vsLpPct)} pts`);
  return lines.join("\n");
}
