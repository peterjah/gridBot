/**
 * Fetch real hourly ETH/USD price history from Binance into the CSV format
 * the backtester reads (`timestamp,price,volume` — unix seconds, close price,
 * and quote-asset volume in USD).
 *
 * Volume is what the LP fee model needs: fee income is a share of the volume
 * that trades through the range while liquidity rests there.
 *
 *   npm run fetch-data                              # ETHUSDT 1h since 2021
 *   npm run fetch-data -- --symbol BTCUSDT --from 2023-01-01 --out data/btc.csv
 *
 * Binance's public klines endpoint needs no API key and caps each response at
 * 1000 candles, so this pages forward until it reaches the present.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://api.binance.com/api/v3/klines";
const MAX_PER_REQUEST = 1000;

interface Options {
  symbol: string;
  interval: string;
  from: number;
  to: number;
  out: string;
}

function parseOptions(argv: string[]): Options {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[arg.slice(2)] = next;
      i++;
    } else {
      args[arg.slice(2)] = "true";
    }
  }

  const date = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new Error(`Invalid date: ${raw}`);
    return ms;
  };

  const symbol = (args["symbol"] ?? "ETHUSDT").toUpperCase();
  return {
    symbol,
    interval: args["interval"] ?? "1h",
    from: date(args["from"], Date.parse("2021-01-01T00:00:00Z")),
    to: date(args["to"], Date.now()),
    out: args["out"] ?? `data/${symbol.toLowerCase()}-${args["interval"] ?? "1h"}.csv`,
  };
}

/** Milliseconds per candle, for the intervals we support. */
function intervalMs(interval: string): number {
  const match = /^(\d+)([mhdw])$/.exec(interval);
  if (!match) throw new Error(`Unsupported interval: ${interval}`);
  const n = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]!]!;
  return n * unit;
}

/** [openTimeMs, closePrice, quoteVolumeUsd] */
type Candle = [number, number, number];

async function fetchPage(o: Options, startTime: number): Promise<Candle[]> {
  const url =
    `${API}?symbol=${o.symbol}&interval=${o.interval}` +
    `&startTime=${startTime}&endTime=${o.to}&limit=${MAX_PER_REQUEST}`;

  // Binance occasionally rate-limits (418/429); back off and retry rather
  // than losing a long download near the end.
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      const rows = (await response.json()) as unknown[][];
      // [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]
      // Index 7 is quote-asset volume, i.e. USD traded — what fees accrue on.
      return rows.map((r) => [Number(r[0]), Number(r[4]), Number(r[7])]);
    }
    if (response.status !== 429 && response.status !== 418) {
      throw new Error(`Binance ${response.status}: ${await response.text()}`);
    }
    const waitMs = 2000 * 2 ** attempt;
    console.error(`  rate limited, retrying in ${waitMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error("Binance rate limit: giving up after 5 attempts");
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const step = intervalMs(o.interval);

  console.error(
    `Fetching ${o.symbol} ${o.interval} from ${new Date(o.from).toISOString().slice(0, 10)} ` +
      `to ${new Date(o.to).toISOString().slice(0, 10)}`,
  );

  const points: Candle[] = [];
  let cursor = o.from;
  let pages = 0;

  while (cursor < o.to) {
    const page = await fetchPage(o, cursor);
    if (page.length === 0) break;
    points.push(...page);
    pages++;

    const last = page[page.length - 1]![0];
    // Guard against a page that cannot advance the cursor (would loop forever).
    if (last + step <= cursor) break;
    cursor = last + step;

    if (pages % 10 === 0) {
      console.error(`  ${points.length} candles… (${new Date(last).toISOString().slice(0, 10)})`);
    }
    // Stay well inside the public rate limit.
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  // Deduplicate on timestamp (pages can overlap by one candle) and sort.
  const seen = new Map<number, [number, number]>();
  for (const [ms, price, volume] of points) {
    if (Number.isFinite(price) && price > 0) {
      seen.set(ms, [price, Number.isFinite(volume) ? volume : 0]);
    }
  }
  const sorted = [...seen.entries()].sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) throw new Error("No data returned");

  const lines = ["timestamp,price,volume"];
  for (const [ms, [price, volume]] of sorted) {
    lines.push(`${Math.floor(ms / 1000)},${price},${volume}`);
  }

  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, `${lines.join("\n")}\n`);

  const first = new Date(sorted[0]![0]).toISOString().slice(0, 10);
  const last = new Date(sorted[sorted.length - 1]![0]).toISOString().slice(0, 10);
  console.error(`Wrote ${sorted.length} rows to ${o.out}  (${first} → ${last})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
