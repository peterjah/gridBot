/** Wallet vs Aave balances for the bot's assets. Read-only. */
import { formatUnits, erc20Abi, type Address } from "viem";
import { createClient } from "../src/blockchain/client.js";
import { getPoolInfo } from "../src/uniswap/pool.js";
import { loadConfig } from "../src/config.js";

async function main(): Promise<void> {
  const cfg = loadConfig("lp-live");
  const client = createClient(cfg.rpcUrls);
  const pool = await getPoolInfo(client, cfg.poolAddress!);
  const wallet = (process.argv[2] ?? cfg.walletAddress) as Address;
  if (!wallet) throw new Error("pass a wallet address");

  const rows: [string, Address, Address, number][] = [
    [pool.token1.symbol, pool.token1.address, cfg.aUsdc, pool.token1.decimals],
    [pool.token0.symbol, pool.token0.address, cfg.aWeth, pool.token0.decimals],
  ];
  console.log(`wallet ${wallet}\n`);
  console.log(`${"asset".padEnd(8)}${"in wallet".padStart(20)}${"supplied to Aave".padStart(22)}`);
  console.log("-".repeat(50));
  for (const [symbol, token, aToken, decimals] of rows) {
    const [w, a] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
      client.readContract({ address: aToken, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    ]);
    console.log(
      symbol.padEnd(8) +
        formatUnits(w, decimals).padStart(20) +
        formatUnits(a, decimals).padStart(22),
    );
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
