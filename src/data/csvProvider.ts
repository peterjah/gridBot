import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { MarketDataProvider, PricePoint } from "./provider.js";

/**
 * Reads `timestamp,price[,volume]` CSV rows (header optional).
 * Timestamps may be ISO-8601 strings or unix seconds/milliseconds.
 * Rows are sorted ascending by timestamp and deduplicated.
 */
export class CsvMarketDataProvider implements MarketDataProvider {
  constructor(private readonly path: string) {}

  async getPrices(start: Date, end: Date): Promise<PricePoint[]> {
    const rl = createInterface({
      input: createReadStream(this.path),
      crlfDelay: Infinity,
    });

    const points: PricePoint[] = [];
    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (lineNo === 1 && /timestamp/i.test(trimmed) && /price/i.test(trimmed)) continue;

      const parts = trimmed.split(/[,\s;]+/);
      if (parts.length < 2) throw new Error(`${this.path}:${lineNo}: expected "timestamp,price"`);
      const ts = parseTimestamp(parts[0]!);
      const price = Number(parts[1]);
      if (ts === null || !Number.isFinite(price) || price <= 0) {
        throw new Error(`${this.path}:${lineNo}: invalid row "${trimmed}"`);
      }
      // Third column is optional volume; a malformed one is treated as absent
      // rather than failing the load, since most callers never read it.
      const volume = parts.length > 2 ? Number(parts[2]) : NaN;
      points.push(
        Number.isFinite(volume) && volume >= 0
          ? { timestamp: ts, price, volumeUsd: volume }
          : { timestamp: ts, price },
      );
    }

    if (points.length === 0) throw new Error(`${this.path}: no data rows`);

    points.sort((a, b) => a.timestamp - b.timestamp);

    // Deduplicate identical timestamps (keep last).
    const deduped: PricePoint[] = [];
    for (const p of points) {
      if (deduped.length > 0 && deduped[deduped.length - 1]!.timestamp === p.timestamp) {
        deduped[deduped.length - 1] = p;
      } else {
        deduped.push(p);
      }
    }

    return deduped.filter(
      (p) => p.timestamp >= Math.floor(start.getTime() / 1000) && p.timestamp <= Math.ceil(end.getTime() / 1000),
    );
  }
}

function parseTimestamp(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    // Heuristic: values below ~10^12 are unix seconds, above are milliseconds.
    return n > 10_000_000_000 ? Math.floor(n / 1000) : n;
  }
  const d = Date.parse(raw);
  return Number.isNaN(d) ? null : Math.floor(d / 1000);
}
