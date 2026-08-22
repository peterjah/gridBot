import { readFileSync } from "node:fs";
import type { PricePoint } from "./provider.js";

/**
 * Daily pool fee APR series (`date,apr_pct,tvl_usd`), as produced by
 * `npm run fetch-apr`. Joined onto the price series by UTC date so the
 * backtest earns the fee rate that pool actually paid on that day.
 */
export interface AprPoint {
  date: string;
  aprPct: number;
  tvlUsd: number;
}

export function loadAprSeries(path: string): Map<string, AprPoint> {
  const byDate = new Map<string, AprPoint>();
  const text = readFileSync(path, "utf8");

  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (i === 0 && /date/i.test(line)) continue;

    const [date, aprRaw, tvlRaw] = line.split(",");
    const aprPct = Number(aprRaw);
    if (!date || !Number.isFinite(aprPct)) {
      throw new Error(`${path}:${i + 1}: expected "date,apr_pct[,tvl_usd]"`);
    }
    const tvl = Number(tvlRaw);
    byDate.set(date.slice(0, 10), {
      date: date.slice(0, 10),
      aprPct,
      tvlUsd: Number.isFinite(tvl) ? tvl : 0,
    });
  }

  if (byDate.size === 0) throw new Error(`${path}: no APR rows`);
  return byDate;
}

/**
 * Attach each observation's daily APR, and drop observations the series does
 * not cover.
 *
 * Trimming rather than back-filling is deliberate: assuming a fee rate for
 * dates with no measurement would invent the exact quantity under test.
 */
export function applyAprSeries(
  prices: PricePoint[],
  byDate: Map<string, AprPoint>,
  minPoolTvlUsd = 0,
): { prices: PricePoint[]; dropped: number; droppedThinPool: number } {
  const out: PricePoint[] = [];
  let dropped = 0;
  let droppedThinPool = 0;

  for (const point of prices) {
    const date = new Date(point.timestamp * 1000).toISOString().slice(0, 10);
    const entry = byDate.get(date);
    if (!entry) {
      dropped++;
      continue;
    }
    // A pool too thin to absorb the position produces meaningless APRs (a
    // bootstrapping pool can print four-digit rates on a few thousand
    // dollars of TVL). Excluding those days is more honest than modeling
    // them, since the position could not have been deployed there at size.
    if (minPoolTvlUsd > 0 && entry.tvlUsd < minPoolTvlUsd) {
      droppedThinPool++;
      continue;
    }
    out.push({ ...point, feeAprPct: entry.aprPct, poolTvlUsd: entry.tvlUsd });
  }

  return { prices: out, dropped, droppedThinPool };
}
