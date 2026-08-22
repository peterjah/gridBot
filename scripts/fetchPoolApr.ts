/**
 * Fetch a pool's historical base fee APR (fees earned per unit of TVL) from
 * DefiLlama's yields API into `date,apr_pct,tvl_usd` CSV rows.
 *
 *   npm run fetch-apr                      # Base Uniswap v3 WETH-USDC
 *   npm run fetch-apr -- --chain Arbitrum --project uniswap-v3 --symbol WETH-USDC
 *   npm run fetch-apr -- --pool <defillama-pool-uuid>
 *
 * `apyBase` is fee income divided by pool TVL, which is exactly the quantity
 * the LP fee model needs: it is directly observable and avoids guessing a
 * venue volume share and an in-range liquidity depth separately.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const POOLS_URL = "https://yields.llama.fi/pools";
const CHART_URL = "https://yields.llama.fi/chart";

interface Pool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number | null;
  apyBase: number | null;
  volumeUsd1d: number | null;
}

function parseArgs(argv: string[]): Record<string, string> {
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
  return args;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chain = args["chain"] ?? "Base";
  const project = args["project"] ?? "uniswap-v3";
  const symbol = args["symbol"] ?? "WETH-USDC";
  const out = args["out"] ?? "data/pool-apr.csv";

  let poolId = args["pool"];

  if (!poolId) {
    console.error(`Finding ${chain} / ${project} / ${symbol} pools…`);
    const { data } = await getJson<{ data: Pool[] }>(POOLS_URL);
    const matches = data
      .filter((p) => p.chain === chain && p.project === project && p.symbol === symbol)
      .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
    if (matches.length === 0) throw new Error(`No pool matched ${chain}/${project}/${symbol}`);

    for (const p of matches) {
      console.error(
        `  ${p.pool}  TVL $${((p.tvlUsd ?? 0) / 1e6).toFixed(1)}M  ` +
          `apyBase ${(p.apyBase ?? 0).toFixed(1)}%  vol1d $${((p.volumeUsd1d ?? 0) / 1e6).toFixed(1)}M`,
      );
    }
    // Default to the deepest pool; `--pool` overrides when a specific fee
    // tier is wanted (the tiers are indistinguishable by symbol alone).
    poolId = matches[0]!.pool;
    console.error(`Using deepest: ${poolId}`);
  }

  const { data } = await getJson<{
    data: { timestamp: string; tvlUsd: number | null; apyBase: number | null }[];
  }>(`${CHART_URL}/${poolId}`);

  const rows = data
    .filter((d) => d.apyBase !== null && Number.isFinite(d.apyBase))
    .map((d) => [d.timestamp.slice(0, 10), d.apyBase as number, d.tvlUsd ?? 0] as const);
  if (rows.length === 0) throw new Error("No apyBase history for this pool");

  const lines = ["date,apr_pct,tvl_usd"];
  for (const [date, apr, tvl] of rows) lines.push(`${date},${apr},${tvl}`);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join("\n")}\n`);

  const aprs = rows.map((r) => r[1]).sort((a, b) => a - b);
  const pick = (q: number) => aprs[Math.floor(aprs.length * q)]!;
  console.error(
    `Wrote ${rows.length} rows to ${out}  (${rows[0]![0]} → ${rows[rows.length - 1]![0]})\n` +
      `  apyBase  p10 ${pick(0.1).toFixed(1)}%  median ${pick(0.5).toFixed(1)}%  p90 ${pick(0.9).toFixed(1)}%`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
