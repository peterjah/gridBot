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
  const [token0, token1, fee, tickSpacing] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "token1" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "fee" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "tickSpacing" }),
  ]);

  const [symbol0, decimals0, symbol1, decimals1] = await Promise.all([
    client.readContract({ address: token0, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token0, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token1, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token1, abi: erc20Abi, functionName: "decimals" }),
  ]);

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
  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "liquidity" }),
  ]);
  return {
    sqrtPriceX96: slot0[0],
    currentTick: Number(slot0[1]),
    inRangeLiquidity: liquidity,
  };
}
