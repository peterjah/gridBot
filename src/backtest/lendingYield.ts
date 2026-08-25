/**
 * Aave lending-yield model for the backtest.
 *
 * Uses a daily supply-APR series (date, apr_pct) such as
 * `data/aave-base-usdc.csv` (fetched from Aave's Base USDC reserve).
 *
 * Model semantics — deliberately matching live behavior with buffers at 0:
 *   - ALL idle USDC (wallet balance above `bufferUsdc`) earns yield;
 *   - interest accrues pro-rata on the APR of the observation's UTC date and
 *     is credited to the wallet each step (compounding across steps);
 *   - ETH lending is NOT modeled (no historical series; most idle capital in
 *     this strategy is USDC anyway).
 *
 * Yield is an environment income stream exactly like gas is an environment
 * cost: the strategy stays agnostic; the backtester credits it.
 */

export interface AaveAprPoint {
  /** Unix seconds of the UTC midnight starting this daily rate. */
  dayStart: number;
  /** Supply APR in percent (e.g. 5.12 = 5.12%/yr). */
  aprPct: number;
}

import { readFileSync } from "node:fs";

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** Load and sort a `date,apr_pct[,...]` CSV. Header/extra columns tolerated. */
export function loadAaveAprSeries(path: string): AaveAprPoint[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const points: AaveAprPoint[] = [];
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/date/i.test(trimmed) && /apr/i.test(trimmed)) continue; // header
    const parts = trimmed.split(/[,\s;]+/);
    if (parts.length < 2) throw new Error(`${path}:${lineNo}: expected "date,apr_pct"`);
    const dayTs = Date.parse(parts[0]! + "T00:00:00Z");
    const apr = Number(parts[1]);
    if (Number.isNaN(dayTs) || !Number.isFinite(apr)) {
      throw new Error(`${path}:${lineNo}: invalid row "${trimmed}"`);
    }
    points.push({ dayStart: Math.floor(dayTs / 1000), aprPct: apr });
  }
  if (points.length === 0) throw new Error(`${path}: no data rows`);
  points.sort((a, b) => a.dayStart - b.dayStart);
  return points;
}

/** APR (percent/yr) effective on the given timestamp; forward-fills gaps. */
export function aprForTimestamp(series: AaveAprPoint[], ts: number): number | null {
  if (series.length === 0 || ts < series[0]!.dayStart) return null;
  // Binary search for the last day start <= ts.
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid]!.dayStart <= ts) lo = mid;
    else hi = mid - 1;
  }
  return series[lo]!.aprPct;
}

/** Pro-rata interest on `principal` for `dtSeconds` at `aprPct` annual rate. */
export function accrueInterest(principal: number, aprPct: number, dtSeconds: number): number {
  if (!(principal > 0) || !(aprPct > 0) || !(dtSeconds > 0)) return 0;
  return principal * (aprPct / 100) * (dtSeconds / SECONDS_PER_YEAR);
}
