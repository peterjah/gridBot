import type { PricePoint } from "../data/provider.js";
import { RULE, THIN, day, pct, price, signedUsd } from "./format.js";
import type { ConfigMetrics, EvaluationInput, GridCandidate } from "./optimizer.js";
import { evaluate } from "./optimizer.js";

/** A named contiguous slice of the price series. */
export interface Period {
  name: string;
  prices: PricePoint[];
}

/** Descriptive statistics of a period, independent of any strategy. */
export interface RegimeStats {
  startPrice: number;
  endPrice: number;
  movePct: number;
  minPrice: number;
  maxPrice: number;
  /** Std-dev of per-observation log returns. */
  volPerStep: number;
  /** Annualized from the observed sampling interval, in percent. */
  annualizedVolPct: number;
  /** Rough regime label derived from move and volatility. */
  label: string;
  days: number;
  observations: number;
}

export interface PeriodResult {
  period: Period;
  stats: RegimeStats;
  metrics: ConfigMetrics;
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/**
 * Split a series into the periods to analyze (spec section 14):
 * the full period, then calendar years when the data spans more than one,
 * otherwise four equal quarters.
 */
export function splitPeriods(prices: PricePoint[]): Period[] {
  if (prices.length < 2) return [{ name: "Full period", prices }];

  const periods: Period[] = [{ name: "Full period", prices }];
  const years = new Map<number, PricePoint[]>();
  for (const p of prices) {
    const year = new Date(p.timestamp * 1000).getUTCFullYear();
    const bucket = years.get(year);
    if (bucket) bucket.push(p);
    else years.set(year, [p]);
  }

  if (years.size > 1) {
    for (const [year, points] of [...years.entries()].sort((a, b) => a[0] - b[0])) {
      if (points.length >= 2) periods.push({ name: String(year), prices: points });
    }
    return periods;
  }

  // Single year (or less): four equal quarters of the available observations.
  const quarterNames = ["First quarter", "Second quarter", "Third quarter", "Fourth quarter"];
  const size = Math.floor(prices.length / 4);
  if (size >= 2) {
    for (let q = 0; q < 4; q++) {
      const from = q * size;
      const to = q === 3 ? prices.length : (q + 1) * size;
      periods.push({ name: quarterNames[q]!, prices: prices.slice(from, to) });
    }
  }
  return periods;
}

/** Chronological train/test split at `trainFraction` of the observations. */
export function trainTestSplit(
  prices: PricePoint[],
  trainFraction: number,
): { train: PricePoint[]; test: PricePoint[] } {
  if (!(trainFraction > 0 && trainFraction < 1)) {
    throw new Error(`trainFraction must be in (0,1), got ${trainFraction}`);
  }
  const cut = Math.floor(prices.length * trainFraction);
  if (cut < 2 || prices.length - cut < 2) {
    throw new Error("Not enough data to split into train and test");
  }
  return { train: prices.slice(0, cut), test: prices.slice(cut) };
}

export function regimeStats(prices: PricePoint[]): RegimeStats {
  const startPrice = prices[0]!.price;
  const endPrice = prices[prices.length - 1]!.price;
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  const rets: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i]!.price;
    if (p < minPrice) minPrice = p;
    if (p > maxPrice) maxPrice = p;
    if (i > 0) rets.push(Math.log(p / prices[i - 1]!.price));
  }
  const m = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length
    ? rets.reduce((a, r) => a + (r - m) ** 2, 0) / rets.length
    : 0;
  const volPerStep = Math.sqrt(variance);

  const spanSeconds = prices[prices.length - 1]!.timestamp - prices[0]!.timestamp;
  const stepSeconds = rets.length > 0 ? spanSeconds / rets.length : 0;
  const stepsPerYear = stepSeconds > 0 ? SECONDS_PER_YEAR / stepSeconds : 0;
  const annualizedVolPct = volPerStep * Math.sqrt(stepsPerYear) * 100;

  const movePct = ((endPrice - startPrice) / startPrice) * 100;

  return {
    startPrice,
    endPrice,
    movePct,
    minPrice,
    maxPrice,
    volPerStep,
    annualizedVolPct,
    label: regimeLabel(movePct, annualizedVolPct),
    days: spanSeconds / 86_400,
    observations: prices.length,
  };
}

/**
 * Coarse regime label. Thresholds are deliberately blunt — the point is to
 * group periods for reading the table, not to classify markets precisely.
 */
function regimeLabel(movePct: number, annualizedVolPct: number): string {
  const trend = movePct > 15 ? "bull" : movePct < -15 ? "bear" : "sideways";
  const vol = annualizedVolPct > 80 ? "high-vol" : annualizedVolPct < 40 ? "low-vol" : "mid-vol";
  return `${trend}/${vol}`;
}

/** Run one candidate over every period of the dataset. */
export function evaluateAcrossPeriods(
  candidate: GridCandidate,
  periods: Period[],
  input: Omit<EvaluationInput, "prices">,
): PeriodResult[] {
  const results: PeriodResult[] = [];
  for (const period of periods) {
    if (period.prices.length < 2) continue;
    const periodInput: EvaluationInput = { ...input, prices: period.prices };
    // Order size is a fraction of capital, which is the same in every period,
    // so the candidate can be reused verbatim.
    results.push({
      period,
      stats: regimeStats(period.prices),
      metrics: evaluate(candidate, periodInput),
    });
  }
  return results;
}

/** Market-regime table (spec section 14). */
export function formatPeriodTable(results: PeriodResult[]): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line("MARKET REGIME ANALYSIS");
  line(RULE);
  line();
  line(
    "Period            Dates                    Move     Ann.vol  Regime            Return    MaxDD    Grid P&L     Reset P&L    Resets",
  );
  line(THIN);
  for (const r of results) {
    const s = r.stats;
    const m = r.metrics;
    const from = day(r.period.prices[0]!.timestamp);
    const to = day(r.period.prices[r.period.prices.length - 1]!.timestamp);
    line(
      [
        r.period.name.padEnd(18),
        `${from}→${to}`.padEnd(25),
        pct(s.movePct, 1).padStart(8),
        `${s.annualizedVolPct.toFixed(0)}%`.padStart(9),
        `  ${s.label}`.padEnd(20),
        pct(m.returnPercent).padStart(8),
        `${m.maxDrawdownPct.toFixed(1)}%`.padStart(9),
        signedUsd(m.totalGridPnL).padStart(13),
        signedUsd(m.totalResetPnL).padStart(13),
        String(m.numberOfResets).padStart(7),
      ].join(""),
    );
  }
  line();
  line("Price range per period:");
  for (const r of results) {
    line(
      `  ${r.period.name.padEnd(18)}${price(r.stats.minPrice)} → ${price(r.stats.maxPrice)}` +
        `   (start ${price(r.stats.startPrice)}, end ${price(r.stats.endPrice)})`,
    );
  }
  line(RULE);
  return lines.join("\n");
}
