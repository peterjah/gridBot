/**
 * Audit the bot's Uniswap V3 positions and wallet balances.
 *
 * Reads only — it never sends a transaction. Useful after an interrupted run
 * to confirm nothing is stranded: a position withdrawn but not collected holds
 * its principal and fees as `tokensOwed`.
 *
 *   npx tsx tools/checkPositions.ts
 *   npx tsx tools/checkPositions.ts --token-id 5839652 --token-id 5876912
 *   npx tsx tools/checkPositions.ts --wallet 0x... --pool 0x...
 *
 * With no --token-id, it uses the one recorded in STATE_FILE.
 */
import { formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "../src/blockchain/client.js";
import { positionManagerAbi, erc20Abi } from "../src/uniswap/abis.js";
import { getPoolInfo } from "../src/uniswap/pool.js";
import { loadState } from "../src/bot/state.js";
import { loadConfig } from "../src/config.js";

function parseArgs(argv: string[]): { flags: Record<string, string>; tokenIds: bigint[] } {
  const flags: Record<string, string> = {};
  const tokenIds: bigint[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      flags[key] = "true";
      continue;
    }
    if (key === "token-id") tokenIds.push(BigInt(value));
    else flags[key] = value;
    i++;
  }
  return { flags, tokenIds };
}

async function main(): Promise<void> {
  const { flags, tokenIds } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig("lp-live");

  const poolAddress = (flags["pool"] ?? cfg.poolAddress) as Address | null;
  if (!poolAddress) throw new Error("POOL_ADDRESS is not set (or pass --pool)");
  if (!cfg.rpcUrls.length) throw new Error("RPC_URL is not set");

  const client = createClient(cfg.rpcUrls);
  // Token addresses and decimals come from the pool, so this works on any
  // pool and chain rather than only WETH/USDC on Base.
  const pool = await getPoolInfo(client, poolAddress);

  // --wallet, then WALLET_ADDRESS, then the address PRIVATE_KEY derives to.
  const walletAddress =
    flags["wallet"] ?? cfg.walletAddress ?? walletFromKey(cfg.privateKey);

  const ids = tokenIds.length > 0 ? tokenIds : idsFromState(cfg.lpRebalance.stateFile);
  const manager = cfg.contracts.positionManager;

  if (ids.length === 0) {
    console.log("No token ids given and none recorded in the state file.");
  }

  for (const tokenId of ids) {
    try {
      const [p, owner] = await Promise.all([
        client.readContract({
          address: manager,
          abi: positionManagerAbi,
          functionName: "positions",
          args: [tokenId],
        }),
        client.readContract({
          address: manager,
          abi: positionManagerAbi,
          functionName: "ownerOf",
          args: [tokenId],
        }),
      ]);
      const owed0 = formatUnits(p[10], pool.token0.decimals);
      const owed1 = formatUnits(p[11], pool.token1.decimals);
      console.log(`\ntokenId ${tokenId}  owner ${owner}`);
      console.log(`  liquidity    ${p[7]}`);
      console.log(`  tokensOwed0  ${owed0} ${pool.token0.symbol}`);
      console.log(`  tokensOwed1  ${owed1} ${pool.token1.symbol}`);
      console.log(`  ticks        ${p[5]} .. ${p[6]}`);
      if (p[7] === 0n && (p[10] > 0n || p[11] > 0n)) {
        console.log("  NOTE: withdrawn but not collected — funds are still in the position.");
      }
    } catch (error) {
      console.log(
        `\ntokenId ${tokenId}: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
      );
    }
  }

  if (!walletAddress) {
    console.log("\nNo wallet address (set WALLET_ADDRESS or pass --wallet) — skipping balances.");
    return;
  }
  const balances = await Promise.all(
    [pool.token0, pool.token1].map((token) =>
      client.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      }),
    ),
  );
  console.log(`\nwallet ${walletAddress}`);
  for (const [i, token] of [pool.token0, pool.token1].entries()) {
    console.log(`  ${token.symbol.padEnd(6)} ${formatUnits(balances[i]!, token.decimals)}`);
  }
}

function walletFromKey(privateKey: `0x${string}` | null): Address | null {
  if (!privateKey) return null;
  return privateKeyToAccount(privateKey).address;
}

/** The position the bot is currently managing, if the state file names one. */
function idsFromState(stateFile: string): bigint[] {
  try {
    const id = BigInt(loadState(stateFile).positionId);
    return id > 0n ? [id] : [];
  } catch {
    return [];
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
