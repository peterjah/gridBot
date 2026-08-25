import type { BotClient } from "../blockchain/client.js";
import type { Address } from "viem";
import { erc20Abi, poolAbi } from "./abis.js";

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface PoolInfo {
  address: Address;
  token0: TokenInfo;
  token1: TokenInfo;
  fee: number;
  tickSpacing: number;
}

export interface PoolState {
  sqrtPriceX96: bigint;
  currentTick: number;
  inRangeLiquidity: bigint;
}

/** Read immutable pool + token metadata. Token ordering is read from the contract. */
export async function getPoolInfo(client: BotClient, poolAddress: Address): Promise<PoolInfo> {
  // Two multicalls rather than eight round trips: the token addresses have to
  // come back before their metadata can be requested, so this cannot collapse
  // any further.
  const [token0, token1, fee, tickSpacing] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: poolAddress, abi: poolAbi, functionName: "token0" },
      { address: poolAddress, abi: poolAbi, functionName: "token1" },
      { address: poolAddress, abi: poolAbi, functionName: "fee" },
      { address: poolAddress, abi: poolAbi, functionName: "tickSpacing" },
    ],
  });

  const [symbol0, decimals0, symbol1, decimals1] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: token0, abi: erc20Abi, functionName: "symbol" },
      { address: token0, abi: erc20Abi, functionName: "decimals" },
      { address: token1, abi: erc20Abi, functionName: "symbol" },
      { address: token1, abi: erc20Abi, functionName: "decimals" },
    ],
  });

  return {
    address: poolAddress,
    token0: { address: token0, symbol: symbol0, decimals: Number(decimals0) },
    token1: { address: token1, symbol: symbol1, decimals: Number(decimals1) },
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
  };
}

/** Read mutable pool state. */
export async function getPoolState(client: BotClient, poolAddress: Address): Promise<PoolState> {
  // One request per poll instead of two — and, unlike Promise.all, both values
  // are guaranteed to come from the SAME block, so price and liquidity cannot
  // disagree about which state they describe.
  const [slot0, liquidity] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: poolAddress, abi: poolAbi, functionName: "slot0" },
      { address: poolAddress, abi: poolAbi, functionName: "liquidity" },
    ],
  });
  return {
    sqrtPriceX96: slot0[0],
    currentTick: Number(slot0[1]),
    inRangeLiquidity: liquidity,
  };
}
