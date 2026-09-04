import type { PricePoint } from "../data/provider.js";
import type { GasModel } from "../backtest/gasModel.js";
import { RULE, THIN, pct, signedUsd, usd } from "../backtest/format.js";
import { assertLpReconciles, runPassiveLp } from "./passiveLp.js";
import type { PassiveLpConfig, PassiveLpResult, RegimeMetric } from "./passiveLp.js";

/**
 * Parameter sweep for passive LP. It has far fewer knobs than the grid —
 * essentially band width and whether/when to re-centre — which is itself
 * informative: fewer parameters means less to overfit.
 */
export interface LpAxes {
  /** Band half-widths to try, percent. */
  rangePcts: number[];
  /** Re-centre buffers as a percent of half-width; 0 = never re-centre. */
  recenterBuffers: number[];
  /** Minimum hours between re-centres. */
  recenterMinHours: number[];
  /**
   * Trailing-move thresholds for the regime filter, percent. 0 = always on.
   * Walk-forward says directional exposure, not band width, is what loses
   * money out of sample, so this is the axis that matters most.
   */
  regimeMaxMovePcts: number[];
  /** Short ratios to try, percent of ETH exposure. 0 = unhedged. */
  hedgeRatioPcts: number[];
  /** How the regime is measured; see RegimeMetric. */
  regimeMetrics: RegimeMetric[];
}

export const DEFAULT_LP_AXES: LpAxes = {
  rangePcts: [5, 10, 15, 20, 30, 50, 75],
  recenterBuffers: [0, 10, 25, 50, 100],
  recenterMinHours: [24],
  regimeMaxMovePcts: [0],
  hedgeRatioPcts: [0],
  regimeMetrics: ["displacement"],
};

export interface LpMetrics {
  rangePct: number;
  recenterBufferPct: number;
  recenterMinHours: number;
  regimeMaxMovePct: number;
  hedgeRatioPct: number;
  regimeMetric: RegimeMetric;
  finalValue: number;
  returnPct: number;
  maxDrawdownPct: number;
  feeIncomeUsd: number;
  positionPnlUsd: number;
  swapCostUsd: number;
  gasUsd: number;
  recenters: number;
  timeInRangePct: number;
  timeParkedPct: number;
  parkEvents: number;
  hedgePnlUsd: number;
  hedgeCostUsd: number;
  impermanentLossUsd: number;
  riskAdjusted: number;
}

export interface LpSweepResult {
  metrics: LpMetrics[];
  skipped: number;
}

export interface LpEvalInput {
  prices: PricePoint[];
  base: Omit<PassiveLpConfig, "rangePct" | "recenterBufferPct" | "recenterMinHours">;
  gas: number | GasModel;
}

export function evaluateLp(
  rangePct: number,
  recenterBufferPct: number,
  recenterMinHours: number,
  input: LpEvalInput,
  regimeMaxMovePct?: number,
  hedgeRatioPct?: number,
  regimeMetric?: RegimeMetric,
): LpMetrics {
  const cfg: PassiveLpConfig = {
    ...input.base,
    rangePct,
    recenterBufferPct,
    recenterMinHours,
    ...(regimeMaxMovePct === undefined ? {} : { regimeMaxMovePct }),
    ...(hedgeRatioPct === undefined ? {} : { hedgeRatioPct }),
    ...(regimeMetric === undefined ? {} : { regimeMetric }),
  };
  const result = runPassiveLp(cfg, input.prices, input.gas);
  assertLpReconciles(result);
  return metricsOf(result);
}

export function metricsOf(r: PassiveLpResult): LpMetrics {
  return {
    rangePct: r.config.rangePct,
    recenterBufferPct: r.config.recenterBufferPct,
    recenterMinHours: r.config.recenterMinHours,
    regimeMaxMovePct: r.config.regimeMaxMovePct,
    hedgeRatioPct: r.config.hedgeRatioPct,
    regimeMetric: r.config.regimeMetric,
    finalValue: r.finalValue,
    returnPct: r.returnPct,
    maxDrawdownPct: r.maxDrawdownPct,
    feeIncomeUsd: r.feeIncomeUsd,
    positionPnlUsd: r.positionPnlUsd,
    swapCostUsd: r.swapCostUsd,
    gasUsd: r.gasUsd,
    recenters: r.recenters.length,
    timeInRangePct: r.timeInRangePct,
    timeParkedPct: r.timeParkedPct,
    parkEvents: r.parkEvents,
    hedgePnlUsd: r.hedgePnlUsd,
    hedgeCostUsd: r.hedgeCostUsd,
    impermanentLossUsd: r.impermanentLossUsd,
    riskAdjusted: r.returnPct / Math.max(Math.abs(r.maxDrawdownPct), 1),
  };
}

export function sweepLp(axes: LpAxes, input: LpEvalInput): LpSweepResult {
  const metrics: LpMetrics[] = [];
  let skipped = 0;

  const regimes = axes.regimeMaxMovePcts?.length ? axes.regimeMaxMovePcts : [0];
  const hedges = axes.hedgeRatioPcts?.length ? axes.hedgeRatioPcts : [0];
  const metrics_ = axes.regimeMetrics?.length ? axes.regimeMetrics : (["displacement"] as RegimeMetric[]);
  for (const rangePct of axes.rangePcts) {
    for (const buffer of axes.recenterBuffers) {
      for (const minHours of axes.recenterMinHours) {
        // Without re-centring the cooldown is meaningless; collapse those
        // duplicates so the table is not padded with identical rows.
        if (buffer === 0 && minHours !== axes.recenterMinHours[0]) continue;
        for (const regime of regimes) {
          for (const hedge of hedges) {
            for (const metric of metrics_) {
              // Without a regime threshold the metric is inert; collapse the
              // duplicates rather than padding the table with identical rows.
              if (regime === 0 && metric !== metrics_[0]) continue;
              try {
                metrics.push(
                  evaluateLp(rangePct, buffer, minHours, input, regime, hedge, metric),
                );
              } catch {
                skipped++;
              }
            }
          }
        }
      }
    }
  }
  return { metrics, skipped };
}

export function rankLp(metrics: LpMetrics[], metric: string): LpMetrics[] {
  const upper = metric.toUpperCase();
  const score = (m: LpMetrics): number => {
    switch (upper) {
      case "RISK_ADJUSTED":
        return m.riskAdjusted;
      case "DRAWDOWN":
        return -Math.abs(m.maxDrawdownPct);
      default:
        return m.returnPct;
    }
  };
  return [...metrics].sort((a, b) => score(b) - score(a) || b.returnPct - a.returnPct);
}

export function formatLpTable(metrics: LpMetrics[], metric: string, limit = 15): string {
  const ranked = rankLp(metrics, metric).slice(0, limit);
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line(`PASSIVE LP CONFIGURATIONS  (ranked by ${metric.toUpperCase()})`);
  line(RULE);
  line();
  line(
    "Rank  Range   Recentre  Regime  Metric        Return    MaxDD   InRange   Parked   Fee income   Position P&L  Recentres",
  );
  line(THIN);
  ranked.forEach((m, i) => {
    line(
      [
        String(i + 1).padEnd(6),
        `±${m.rangePct}%`.padEnd(8),
        (m.recenterBufferPct === 0 ? "never" : `${m.recenterBufferPct}%`).padEnd(10),
        (m.regimeMaxMovePct > 0 ? `${m.regimeMaxMovePct}%` : "off").padEnd(8),
        (m.regimeMaxMovePct > 0 ? m.regimeMetric : "—").padEnd(14),
        pct(m.returnPct).padStart(8),
        `${m.maxDrawdownPct.toFixed(1)}%`.padStart(9),
        `${m.timeInRangePct.toFixed(0)}%`.padStart(9),
        `${m.timeParkedPct.toFixed(0)}%`.padStart(8),
        signedUsd(m.feeIncomeUsd).padStart(13),
        signedUsd(m.positionPnlUsd).padStart(15),
        String(m.recenters).padStart(11),
      ].join(""),
    );
  });
  line(RULE);
  return lines.join("\n");
}

/** Detail block for one passive LP result. */
export function formatLpReport(r: PassiveLpResult): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line("PASSIVE LP STRATEGY");
  line(RULE);
  line();
  line(`Band:              ±${r.config.rangePct}% around the entry price`);
  line(
    `Re-centring:       ${
      r.config.recenterBufferPct === 0
        ? "never (fully passive)"
        : `beyond ${r.config.recenterBufferPct}% of half-width, min ${r.config.recenterMinHours}h apart`
    }`,
  );
  line(`Initial capital:   ${usd(r.initialCapital)}`);
  line();
  line("----------------------------------------");
  line("RESULT");
  line("----------------------------------------");
  line();
  line(`Final value:       ${usd(r.finalValue)}`);
  line(`Return:            ${pct(r.returnPct)}`);
  line(`Max drawdown:      ${pct(r.maxDrawdownPct)}`);
  line(`Time in range:     ${r.timeInRangePct.toFixed(1)}%`);
  line(
    `Regime filter:     ${
      r.config.regimeMaxMovePct > 0
        ? `stand aside above ${r.config.regimeMaxMovePct}% over ${r.config.regimeLookbackPoints} obs` +
          ` — parked ${r.timeParkedPct.toFixed(1)}% of the time, ${r.parkEvents} exits`
        : "off"
    }`,
  );
  line(`Re-centres:        ${r.recenters.length}`);
  line();
  line(`D. Fee income:     ${signedUsd(r.feeIncomeUsd)}`);
  line(`   Position P&L:   ${signedUsd(r.positionPnlUsd)}   (price exposure + divergence)`);
  line(`C. Swap costs:     ${signedUsd(-r.swapCostUsd)}`);
  line(`   Gas:            ${signedUsd(-r.gasUsd)}`);
  line(`                   ${"-".repeat(14)}`);
  line(`   Net profit:     ${signedUsd(r.finalValue - r.initialCapital)}`);
  line();
  line(`Divergence loss:   ${signedUsd(r.impermanentLossUsd)}  (vs holding the deposit split)`);
  line(`Accounting residual: ${r.residual.toExponential(2)} USD`);
  line(RULE);
  return lines.join("\n");
}
