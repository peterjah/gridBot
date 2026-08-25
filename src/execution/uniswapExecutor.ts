import type { Address } from "viem";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import type { AppConfig } from "../config.js";
import type { BotClient } from "../blockchain/client.js";
import { createTransactor } from "../blockchain/wallet.js";
import type { PoolInfo } from "../uniswap/pool.js";
import { encodeExactInputSingle, encodeRouterMulticall, quoteExactInputSingle } from "../uniswap/swap.js";
import { allowancesFor, quoteExactInputSingleBatch } from "../blockchain/multicall.js";
import { logger } from "../utils/logger.js";

const MAX_UINT256 = (1n << 256n) - 1n;
// Official Uniswap V3 deployments on Base
const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address;
const BATCH_DEADLINE_SECONDS = 120n;

export interface FillIntent {
  type: "BUY" | "SELL";
  /** BUY: quote (USDC) to spend. SELL: base (ETH) to sell. Human units. */
  amount: number;
  gridLevel: number;
}

export interface ExecutionResult {
  /** Base asset (ETH) received/sold, human units. */
  baseAmount: number;
  /** Quote asset (USDC) spent/received, human units. */
  quoteAmount: number;
  effectivePrice: number;
  txHash: `0x${string}`;
}

/**
 * Executes grid actions as real Uniswap V3 swaps through SwapRouter02.
 *
 * This is the "Approach C" execution model (see docs/EXECUTION_APPROACH.md):
 * grid levels are virtual limit orders filled with market swaps when the
 * strategy decides a level has been crossed. Simple, faithful to the grid
 * model, and reuses the battle-tested router path.
 */
export class UniswapV3Executor {
  private readonly client: BotClient;
  private readonly wallet: Address;
  private readonly transactor: ReturnType<typeof createTransactor>;
  private readonly slippageBps: number;

  constructor(
    client: BotClient,
    cfg: AppConfig,
    private readonly pool: PoolInfo,
    privateKey: `0x${string}`,
  ) {
    this.client = client;
    this.transactor = createTransactor(privateKey, cfg.rpcUrls);
    this.wallet = cfg.walletAddress ?? this.transactor.account.address;
    this.slippageBps = Math.max(cfg.grid.slippageBps, 50); // at least 0.5% on-chain
  }

  /** Buy ETH with roughly `quoteUsd` USDC. */
  async buy(quoteUsd: number): Promise<ExecutionResult> {
    const usdc = this.pool.token1;
    const weth = this.pool.token0;
    const amountIn = BigInt(Math.round(quoteUsd * 10 ** usdc.decimals));

    const balance = await this.balanceOf(usdc.address);
    logger.debug("BUY: wallet check", {
      token: usdc.symbol,
      needed: formatUnits(amountIn, usdc.decimals),
      have: formatUnits(balance, usdc.decimals),
    });
    if (balance < amountIn) {
      throw new Error(
        `Insufficient ${usdc.symbol}: have ${formatUnits(balance, usdc.decimals)}, need ${formatUnits(amountIn, usdc.decimals)}`,
      );
    }

    const quotedOut = await quoteExactInputSingle(
      this.client, QUOTER, usdc.address, weth.address, this.pool.fee, amountIn,
    );
    const minOut = applySlippage(quotedOut, this.slippageBps);
    logger.debug("BUY: quote", {
      amountIn: formatUnits(amountIn, usdc.decimals),
      quotedOut: formatUnits(quotedOut, weth.decimals),
      minOut: formatUnits(minOut, weth.decimals),
      slippageBps: this.slippageBps,
      impliedPrice: Number(formatUnits(amountIn, usdc.decimals)) / Number(formatUnits(quotedOut, weth.decimals)),
    });

    await this.ensureApproval(usdc.address, SWAP_ROUTER, amountIn);
    const txHash = await this.swap(usdc.address, weth.address, amountIn, minOut);

    return {
      quoteAmount: Number(formatUnits(amountIn, usdc.decimals)),
      baseAmount: Number(formatUnits(minOut, weth.decimals)),
      effectivePrice: Number(formatUnits(amountIn, usdc.decimals)) / Number(formatUnits(minOut, weth.decimals)),
      txHash,
    };
  }

  /** Sell `baseEth` ETH for USDC. */
  async sell(baseEth: number): Promise<ExecutionResult> {
    const weth = this.pool.token0;
    const usdc = this.pool.token1;
    const amountIn = BigInt(Math.round(baseEth * 10 ** weth.decimals));

    const balance = await this.balanceOf(weth.address);
    logger.debug("SELL: wallet check", {
      token: weth.symbol,
      needed: formatUnits(amountIn, weth.decimals),
      have: formatUnits(balance, weth.decimals),
    });
    if (balance < amountIn) {
      throw new Error(
        `Insufficient ${weth.symbol}: have ${formatUnits(balance, weth.decimals)}, need ${formatUnits(amountIn, weth.decimals)}`,
      );
    }

    const quotedOut = await quoteExactInputSingle(
      this.client, QUOTER, weth.address, usdc.address, this.pool.fee, amountIn,
    );
    const minOut = applySlippage(quotedOut, this.slippageBps);
    logger.debug("SELL: quote", {
      amountIn: formatUnits(amountIn, weth.decimals),
      quotedOut: formatUnits(quotedOut, usdc.decimals),
      minOut: formatUnits(minOut, usdc.decimals),
      slippageBps: this.slippageBps,
      impliedPrice: Number(formatUnits(quotedOut, usdc.decimals)) / Number(formatUnits(amountIn, weth.decimals)),
    });

    await this.ensureApproval(weth.address, SWAP_ROUTER, amountIn);
    const txHash = await this.swap(weth.address, usdc.address, amountIn, minOut);

    return {
      quoteAmount: Number(formatUnits(minOut, usdc.decimals)),
      baseAmount: Number(formatUnits(amountIn, weth.decimals)),
      effectivePrice: Number(formatUnits(minOut, usdc.decimals)) / Number(formatUnits(amountIn, weth.decimals)),
      txHash,
    };
  }

  // ------------------------------------------------------------------ internal

  /**
   * Execute several grid fills in ONE router-multicall transaction.
   *
   * All fills come from the same price observation, so batching them:
   *  - pays the fixed tx overhead once instead of once per fill;
   *  - keeps the whole observation atomic: either every crossed level fills
   *    or none do (all-or-nothing on revert).
   *
   * Each fill is quoted individually first; per-fill min-out floors are kept
   * inside the batch so slippage protection survives batching.
   */
  async executeFills(fills: FillIntent[]): Promise<{ results: ExecutionResult[]; txHash: `0x${string}` } | null> {
    if (fills.length === 0) return null;
    logger.debug("Batched fills: preparing", { count: fills.length });

    const usdc = this.pool.token1;
    const weth = this.pool.token0;
    const calls: `0x${string}`[] = [];
    const results: Omit<ExecutionResult, "txHash">[] = [];
    let totalUsdcNeeded = 0n;
    let totalWethNeeded = 0n;

    // Amounts first, then ONE batched quote request. Quoting inside the loop
    // costs a round trip per fill, and a batch is largest exactly when price
    // has jumped several levels — the moment latency matters most.
    const amountsIn = fills.map((fill) =>
      fill.type === "BUY"
        ? BigInt(Math.round(fill.amount * 10 ** usdc.decimals))
        : BigInt(Math.round(fill.amount * 10 ** weth.decimals)),
    );
    const quotedOuts = await quoteExactInputSingleBatch(
      this.client,
      QUOTER,
      fills.map((fill, i) => ({
        tokenIn: fill.type === "BUY" ? usdc.address : weth.address,
        tokenOut: fill.type === "BUY" ? weth.address : usdc.address,
        fee: this.pool.fee,
        amountIn: amountsIn[i]!,
      })),
    );

    for (const [i, fill] of fills.entries()) {
      if (fill.type === "BUY") {
        const amountIn = amountsIn[i]!;
        const quotedOut = quotedOuts[i]!;
        const minOut = applySlippage(quotedOut, this.slippageBps);
        logger.debug("Batched fill quote (BUY)", {
          gridLevel: fill.gridLevel,
          amountIn: formatUnits(amountIn, usdc.decimals),
          quotedOut: formatUnits(quotedOut, weth.decimals),
          minOut: formatUnits(minOut, weth.decimals),
        });
        calls.push(encodeExactInputSingle({
          tokenIn: usdc.address,
          tokenOut: weth.address,
          fee: this.pool.fee,
          recipient: this.wallet,
          amountIn,
          amountOutMinimum: minOut,
        }));
        totalUsdcNeeded += amountIn;
        results.push({
          baseAmount: Number(formatUnits(minOut, weth.decimals)),
          quoteAmount: Number(formatUnits(amountIn, usdc.decimals)),
          effectivePrice: Number(formatUnits(amountIn, usdc.decimals)) / Number(formatUnits(minOut, weth.decimals)),
        });
      } else {
        const amountIn = amountsIn[i]!;
        const quotedOut = quotedOuts[i]!;
        const minOut = applySlippage(quotedOut, this.slippageBps);
        logger.debug("Batched fill quote (SELL)", {
          gridLevel: fill.gridLevel,
          amountIn: formatUnits(amountIn, weth.decimals),
          quotedOut: formatUnits(quotedOut, usdc.decimals),
          minOut: formatUnits(minOut, usdc.decimals),
        });
        calls.push(encodeExactInputSingle({
          tokenIn: weth.address,
          tokenOut: usdc.address,
          fee: this.pool.fee,
          recipient: this.wallet,
          amountIn,
          amountOutMinimum: minOut,
        }));
        totalWethNeeded += amountIn;
        results.push({
          baseAmount: Number(formatUnits(amountIn, weth.decimals)),
          quoteAmount: Number(formatUnits(minOut, usdc.decimals)),
          effectivePrice: Number(formatUnits(minOut, usdc.decimals)) / Number(formatUnits(amountIn, weth.decimals)),
        });
      }
    }

    // One allowance check per token against the batch total, both read in a
    // single request rather than one round trip each.
    const needed: { token: Address; amount: bigint }[] = [];
    if (totalUsdcNeeded > 0n) needed.push({ token: usdc.address, amount: totalUsdcNeeded });
    if (totalWethNeeded > 0n) needed.push({ token: weth.address, amount: totalWethNeeded });
    if (needed.length > 0) {
      const allowances = await allowancesFor(
        this.client,
        this.wallet,
        SWAP_ROUTER,
        needed.map((n) => n.token),
      );
      for (const [i, n] of needed.entries()) {
        if (allowances[i]! < n.amount) await this.approveMax(n.token, SWAP_ROUTER);
      }
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000)) + BATCH_DEADLINE_SECONDS;
    const data = encodeRouterMulticall(calls, deadline);
    logger.debug("Batched fills: submitting multicall", {
      legs: calls.length,
      totalUsdc: formatUnits(totalUsdcNeeded, usdc.decimals),
      totalWeth: formatUnits(totalWethNeeded, weth.decimals),
      deadlineSeconds: BATCH_DEADLINE_SECONDS.toString(),
    });
    const txHash = await this.transactor.send(this.client, "router-multicall", SWAP_ROUTER, data);

    return {
      results: results.map((r) => ({ ...r, txHash })),
      txHash,
    };
  }

  private async swap(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    amountOutMinimum: bigint,
  ): Promise<`0x${string}`> {
    const data = encodeExactInputSingle({
      tokenIn,
      tokenOut,
      fee: this.pool.fee,
      recipient: this.wallet,
      amountIn,
      amountOutMinimum,
    });
    return this.transactor.send(this.client, "exactInputSingle", SWAP_ROUTER, data);
  }

  private async ensureApproval(token: Address, spender: Address, amountNeeded: bigint): Promise<void> {
    const allowance = await this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.wallet, spender],
    });
    logger.debug("Swap approval check", {
      token,
      spender,
      allowance: allowance.toString(),
      needed: amountNeeded.toString(),
    });
    if (allowance >= amountNeeded && allowance > 0n) return;
    await this.approveMax(token, spender);
  }

  /** Send an unlimited approval. Split out so a batched allowance read can
   *  decide whether it is needed without re-reading one token at a time. */
  private async approveMax(token: Address, spender: Address): Promise<void> {
    logger.info("Approving router to spend token", { token, spender });
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, MAX_UINT256] });
    await this.transactor.send(this.client, "approve", token, data);
  }

  private async balanceOf(token: Address): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.wallet],
    });
  }
}

function applySlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}
