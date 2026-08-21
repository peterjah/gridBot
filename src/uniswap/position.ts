import type { Address } from "viem";
import { encodeFunctionData, type ContractFunctionExecutionError } from "viem";
import type { BotClient } from "../blockchain/client.js";
import { positionManagerAbi } from "./abis.js";

export interface PositionInfo {
  tokenId: bigint;
  owner: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export interface DecreaseLiquidityParams {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  deadline: bigint;
}

export interface CollectParams {
  tokenId: bigint;
  recipient: Address;
  /** Max uint128 collects everything owed. */
  amount0Max: bigint;
  amount1Max: bigint;
}

export interface MintParams {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: Address;
  deadline: bigint;
}

export const MAX_UINT128 = (1n << 128n) - 1n;

/** Read a position. Returns null if the token id does not exist. */
export async function getPosition(
  client: BotClient,
  positionManager: Address,
  tokenId: bigint,
): Promise<PositionInfo | null> {
  let data;
  try {
    data = await client.readContract({
      address: positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [tokenId],
    });
  } catch (error) {
    if (isNonExistentTokenError(error)) return null;
    throw error;
  }
  const owner = await client.readContract({
    address: positionManager,
    abi: positionManagerAbi,
    functionName: "ownerOf",
    args: [tokenId],
  });
  return {
    tokenId,
    owner,
    token0: data[2],
    token1: data[3],
    fee: Number(data[4]),
    tickLower: Number(data[5]),
    tickUpper: Number(data[6]),
    liquidity: data[7],
    tokensOwed0: data[10],
    tokensOwed1: data[11],
  };
}

function isNonExistentTokenError(error: unknown): boolean {
  const e = error as ContractFunctionExecutionError | undefined;
  return (
    !!e &&
    typeof e === "object" &&
    "name" in e &&
    e.name === "ContractFunctionExecutionError" &&
    String((e as { shortMessage?: string }).shortMessage ?? "").includes("reverted")
  );
}

export function encodeDecreaseLiquidity(params: DecreaseLiquidityParams): `0x${string}` {
  return encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [params],
  });
}

export function encodeCollect(params: CollectParams): `0x${string}` {
  return encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "collect",
    args: [params],
  });
}

export function encodeMint(params: MintParams): `0x${string}` {
  return encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "mint",
    args: [params],
  });
}
