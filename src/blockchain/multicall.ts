import type { Address } from "viem";
import type { BotClient } from "./client.js";
import { erc20Abi } from "../uniswap/abis.js";
import { logger } from "../utils/logger.js";

/**
 * Batched on-chain reads via Multicall3.
 *
 * Every read here would otherwise be its own JSON-RPC round trip. The live
 * loop polls continuously and quotes once per grid fill, so the call count
 * grows with both poll frequency and how many levels a move crosses — which
 * is exactly when latency matters most. Aggregating them into one `eth_call`
 * keeps a poll cycle at a small constant number of requests.
 *
 * Multicall3 is deployed at the same address on every major chain (Base
 * included) and viem resolves it from the chain config, so no address needs
 * configuring here.
 *
 * Reads only. Batching STATE-CHANGING calls through Multicall3 does not work
 * for this bot: it uses a plain CALL, so `msg.sender` becomes the Multicall3
 * contract rather than the wallet, and token approvals would not apply.
 */

/** Fee tier + amount for one quote in a batch. */
export interface QuoteRequest {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
}

/**
 * QuoterV2's quote functions are declared `nonpayable` because they revert
 * internally to return their result, so viem's `multicall` typing rejects
 * them. They are safe to `eth_call`, which is all Multicall3 does, so the
 * same signature is redeclared here as `view` purely for batching.
 *
 * Kept byte-identical to `quoterV2Abi` apart from the mutability, so the
 * encoded calldata is the same.
 */
const quoterViewAbi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/**
 * Quote several swaps in ONE request instead of one round trip each.
 *
 * IMPORTANT: every quote still sees the SAME pre-batch pool state. Batching
 * saves RPC calls; it does not make the quotes aware of each other. If these
 * swaps are then submitted together, each leg moves the price for the next,
 * so the later legs will fill worse than quoted here. Size the slippage
 * floors accordingly.
 */
export async function quoteExactInputSingleBatch(
  client: BotClient,
  quoter: Address,
  requests: QuoteRequest[],
): Promise<bigint[]> {
  if (requests.length === 0) return [];

  const results = await client.multicall({
    allowFailure: false,
    contracts: requests.map((r) => ({
      address: quoter,
      abi: quoterViewAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: r.tokenIn,
          tokenOut: r.tokenOut,
          amountIn: r.amountIn,
          fee: r.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })),
  });

  logger.debug("Batched quotes", { count: requests.length, rpcCalls: 1 });
  // quoteExactInputSingle returns (amountOut, sqrtPriceX96After, ticks, gas).
  return (results as unknown as readonly (readonly bigint[])[]).map((r) => r[0]!);
}

/** ERC-20 balances for several tokens in one request. */
export async function balancesOf(
  client: BotClient,
  owner: Address,
  tokens: Address[],
): Promise<bigint[]> {
  if (tokens.length === 0) return [];
  const results = await client.multicall({
    allowFailure: false,
    contracts: tokens.map((token) => ({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })),
  });
  logger.debug("Batched balances", { count: tokens.length, rpcCalls: 1 });
  return results as unknown as bigint[];
}

/** ERC-20 allowances for several tokens against one spender, in one request. */
export async function allowancesFor(
  client: BotClient,
  owner: Address,
  spender: Address,
  tokens: Address[],
): Promise<bigint[]> {
  if (tokens.length === 0) return [];
  const results = await client.multicall({
    allowFailure: false,
    contracts: tokens.map((token) => ({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    })),
  });
  logger.debug("Batched allowances", { count: tokens.length, rpcCalls: 1 });
  return results as unknown as bigint[];
}

/**
 * Wallet and money-market balances for a set of tokens in ONE request.
 *
 * The lending sweep needs both sides for every asset it manages; read
 * separately that is four round trips per sweep, and the balances are not
 * even read at the same block, so the policy can act on an inconsistent view.
 * One multicall fixes both problems.
 */
export async function walletAndLentBalances(
  client: BotClient,
  owner: Address,
  pairs: { token: Address; aToken: Address }[],
): Promise<{ wallet: bigint; lent: bigint }[]> {
  if (pairs.length === 0) return [];
  const flat = pairs.flatMap((p) => [p.token, p.aToken]);
  const balances = await balancesOf(client, owner, flat);
  return pairs.map((_, i) => ({ wallet: balances[i * 2]!, lent: balances[i * 2 + 1]! }));
}
