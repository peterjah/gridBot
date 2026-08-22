/**
 * Generates deterministic synthetic ETH/USDC price data for backtesting.
 *
 * Seeded PRNG (no Math.random) so the output is reproducible. The series is
 * a geometric random walk with regime shifts (trend + mean reversion) to
 * exercise grid behavior across oscillations, trends and crashes.
 *
 * Usage: npx tsx scripts/generateSampleData.ts [rows] [outFile]
 */
import { mkdirSync, writeFileSync } from "node:fs";

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

// Box-Muller for normal draws.
function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const ROWS = Number(process.argv[2] ?? 17_520); // hourly, ~2 years
const OUT = process.argv[3] ?? "data/sample-prices.csv";

const START_TS = Date.parse("2025-01-01T00:00:00Z") / 1000;
const STEP = 3600;

let price = 3200;
let drift = 0; // per-step log drift of the current regime
const vol = 0.008; // per-step volatility

const rand = lcg(42);
const rows: string[] = ["timestamp,price"];

for (let i = 0; i < ROWS; i++) {
  // Regime shifts every ~2-6 weeks: trending up/down or ranging.
  if (i % Math.floor(24 * (14 + Math.floor(rand() * 28))) === 0) {
    const roll = rand();
    if (roll < 0.35) drift = -0.00015 - rand() * 0.0002; // downtrend
    else if (roll < 0.7) drift = 0.00015 + rand() * 0.0002; // uptrend
    else drift = 0; // range
  }

  price *= Math.exp(drift + vol * gaussian(rand));
  // Keep the series in a plausible band.
  price = Math.min(Math.max(price, 800), 12000);

  rows.push(`${START_TS + i * STEP},${price.toFixed(2)}`);
}

mkdirSync(OUT.includes("/") ? OUT.slice(0, OUT.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(OUT, rows.join("\n") + "\n");
console.log(`Wrote ${ROWS} rows to ${OUT} (start ${rows[1]}, end ${rows[rows.length - 1]})`);
