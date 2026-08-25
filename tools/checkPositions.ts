import { createClient } from "../src/blockchain/client.js";
import { positionManagerAbi } from "../src/uniswap/abis.js";
import { erc20Abi, formatUnits } from "viem";

const NPM = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" as const;
const WALLET = "0x8E272640D66FfBC657FB8c856278A4ff17B3e937" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

async function main() {
  const client = createClient([process.env.RPC_URL!]);
  for (const tokenId of [5839652n, 5876912n]) {
    try {
      const p = await client.readContract({
        address: NPM, abi: positionManagerAbi, functionName: "positions", args: [tokenId],
      });
      const owner = await client.readContract({
        address: NPM, abi: positionManagerAbi, functionName: "ownerOf", args: [tokenId],
      });
      console.log(`\ntokenId ${tokenId}  owner ${owner}`);
      console.log(`  liquidity   ${p[7]}`);
      console.log(`  tokensOwed0 ${formatUnits(p[10], 18)} WETH`);
      console.log(`  tokensOwed1 ${formatUnits(p[11], 6)} USDC`);
      console.log(`  ticks       ${p[5]} .. ${p[6]}`);
    } catch (e) {
      console.log(`tokenId ${tokenId}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
  const [w, u] = await Promise.all([
    client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [WALLET] }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [WALLET] }),
  ]);
  console.log(`\nwallet ${WALLET}`);
  console.log(`  WETH ${formatUnits(w, 18)}`);
  console.log(`  USDC ${formatUnits(u, 6)}`);
}
main();
