/**
 * Fetches real ETH/USDC hourly price history and writes a backtest-ready
 * CSV (`timestamp,price`). Uses Binance public klines with a Coinbase
 * Exchange fallback — both keyless.
 *
 * Usage: npx tsx scripts/fetchRealPrices.ts [outFile] [years]
 */
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "data/base-eth-usdc-real.csv";
const YEARS = Number(process.argv[3] ?? 2);
const INTERVAL = process.argv[4] ?? "1h"; // Binance-style: 5m | 10m | 1h
const STEP_SEC = INTERVAL.endsWith("m")
  ? Number(INTERVAL.slice(0, -1)) * 60
  : INTERVAL === "1h"
    ? 3600
    : (() => { throw new Error(`Unsupported interval: ${INTERVAL}`); })();
const STEP_MS = STEP_SEC * 1000;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": "gridbot-backtest/0.1" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Binance: 1000 hourly klines per request. Returns [tsSec, close][]. */
async function fetchBinance(startMs: number, endMs: number): Promise<[number, number][]> {
  const out: [number, number][] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=ETHUSDC&interval=${INTERVAL}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = (await fetchJson(url)) as unknown[][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push([Number(r[0]) / 1000, Number(r[4])]); // close time sec, close price
    }
    const lastOpen = Number(rows[rows.length - 1]![0]);
    cursor = lastOpen + STEP_MS;
    if (rows.length < 1000) break;
    await new Promise((r) => setTimeout(r, 250)); // be polite
  }
  return out;
}

/** Coinbase Exchange: 300 candles per request. */
async function fetchCoinbase(startMs: number, endMs: number): Promise<[number, number][]> {
  const out: [number, number][] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + 300 * STEP_MS, endMs);
    const url =
      `https://api.exchange.coinbase.com/products/ETH-USDC/candles?granularity=${STEP_SEC}` +
      `&start=${new Date(cursor).toISOString()}&end=${new Date(chunkEnd).toISOString()}`;
    const rows = (await fetchJson(url)) as number[][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      // [time(sec), low, high, open, close, volume]
      out.push([Number(r[0]), Number(r[4])]);
    }
    cursor = chunkEnd;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

async function main(): Promise<void> {
  const endMs = Date.now();
  const startMs = endMs - YEARS * 365 * 24 * 3600 * 1000;

  console.log("Fetching ETH/USDC hourly closes...");
  let points: [number, number][];
  try {
    points = await fetchBinance(startMs, endMs);
    console.log(`Source: binance (${points.length} points)`);
  } catch (error) {
    console.log(`Binance failed (${error instanceof Error ? error.message : error}); trying Coinbase`);
    points = await fetchCoinbase(startMs, endMs);
    console.log(`Source: coinbase (${points.length} points)`);
  }

  if (points.length < 100) throw new Error("Too few data points fetched");

  // Sort ascending + dedupe timestamps (keep last).
  points.sort((a, b) => a[0] - b[0]);
  const deduped: [number, number][] = [];
  for (const p of points) {
    if (deduped.length > 0 && deduped[deduped.length - 1]![0] === p[0]) deduped[deduped.length - 1] = p;
    else deduped.push(p);
  }

  const dir = OUT.includes("/") ? OUT.slice(0, OUT.lastIndexOf("/")) : ".";
  mkdirSync(dir, { recursive: true });
  const lines = ["timestamp,price"];
  for (const [ts, price] of deduped) {
    lines.push(`${ts},${price.toFixed(2)}`);
  }
  writeFileSync(OUT, lines.join("\n") + "\n");

  const first = deduped[0]!;
  const last = deduped[deduped.length - 1]!;
  console.log(
    `Wrote ${deduped.length} rows to ${OUT}\n` +
      `Period: ${new Date(first[0] * 1000).toISOString()} → ${new Date(last[0] * 1000).toISOString()}\n` +
      `Price: $${first[1].toFixed(2)} → $${last[1].toFixed(2)}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
