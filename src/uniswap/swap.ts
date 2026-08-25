import type { Address } from "viem";
import { encodeFunctionData } from "viem";
import type { BotClient } from "../blockchain/client.js";
import { quoterV2Abi, swapRouter02Abi } from "./abis.js";

/** Quote an exact-input single-hop swap via QuoterV2 (read-only). */
export interface SwapPlan {
  zeroForOne: boolean;
  amountIn: bigint;
}

/**
 * Pure calculation of which token must be swapped (if any) to approximately
 * reach the required token0/token1 ratio, given wallet balances.
 *
 * Returns null when no swap is needed.
 */
export function planBalancingSwap(
  required0: bigint,
  required1: bigint,
  balance0: bigint,
  balance1: bigint,
): SwapPlan | null {
  const excess0 = balance0 > required0 ? balance0 - required0 : 0n;
  const deficit1 = required1 > balance1 ? required1 - balance1 : 0n;
  const excess1 = balance1 > required1 ? balance1 - required1 : 0n;
  const deficit0 = required0 > balance0 ? required0 - balance0 : 0n;

  if (excess0 > 0n && deficit1 > 0n) {
    return { zeroForOne: true, amountIn: excess0 };
  }
  if (excess1 > 0n && deficit0 > 0n) {
    return { zeroForOne: false, amountIn: excess1 };
  }
  return null;
}

export async function quoteExactInputSingle(
  client: BotClient,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  amountIn: bigint,
): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: quoter,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

export function encodeExactInputSingle(params: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): `0x${string}` {
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.fee,
        recipient: params.recipient,
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

/**
 * Batch several router calls (e.g. multiple grid fills) into ONE transaction
 * via SwapRouter02's built-in multicall, with a deadline for safety.
 */
export function encodeRouterMulticall(calls: `0x${string}`[], deadlineSeconds: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: [
      {
        name: "multicall",
        type: "function",
        stateMutability: "payable",
        inputs: [
          { name: "deadline", type: "uint256" },
          { name: "data", type: "bytes[]" },
        ],
        outputs: [{ name: "results", type: "bytes[]" }],
      },
    ],
    functionName: "multicall",
    args: [deadlineSeconds, calls],
  });
}
