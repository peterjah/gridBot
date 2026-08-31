import type { Address } from "viem";
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
} from "viem";
import type { LpRebalanceConfig } from "../config.js";
import type { Transactor } from "../blockchain/wallet.js";
import type { BotClient } from "../blockchain/client.js";
import type { PoolInfo } from "../uniswap/pool.js";
import { getPoolState } from "../uniswap/pool.js";
import {
  encodeCollect,
  encodeDecreaseLiquidity,
  encodeMint,
  MAX_UINT128,
  type PositionInfo,
} from "../uniswap/position.js";
import {
  encodeExactInputSingle,
  planBalancingSwap,
  quoteExactInputSingle,
} from "../uniswap/swap.js";
import type { Strategy } from "../strategy/rebalance.js";
import { recordFees, savePositionId } from "./state.js";
import {
  applySlippageBps,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getLiquidityForValue,
  getSqrtRatioAtTick,
} from "../utils/math.js";
import { logger } from "../utils/logger.js";
import { sqrtRatioToPrice } from "../utils/math.js";

const TX_DEADLINE_SECONDS = 600;

/**
 * NonfungiblePositionManager events we read back from receipts.
 *
 * `collect` after `decreaseLiquidity` transfers the withdrawn principal AND
 * the accrued fees in one go, so the Collect amounts alone would report the
 * entire position as income. Fees are the difference between the two events.
 */
const npmEventsAbi = [
  {
    name: "IncreaseLiquidity",
    type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "DecreaseLiquidity",
    type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "Collect",
    type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "recipient", type: "address" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
] as const;

export interface TokenAmounts {
  amount0: bigint;
  amount1: bigint;
}
const MAX_UINT256 = (1n << 256n) - 1n;

export class RebalanceExecutor {
  constructor(
    private readonly client: BotClient,
    private readonly transactor: Transactor,
    private readonly config: LpRebalanceConfig,
    private readonly walletAddress: Address | null,
    private readonly pool: PoolInfo,
    private readonly strategy: Strategy,
  ) {}

  private get wallet(): Address {
    return this.walletAddress ?? this.transactor.account.address;
  }

  /**
   * Full rebalance lifecycle:
   * close position -> collect -> balance tokens -> open centered position.
   *
   * In dry-run mode the complete plan is computed and logged, but no
   * transaction is ever broadcast.
   */
  async rebalance(
    position: PositionInfo | null,
    sqrtPriceX96: bigint,
    currentTick: number,
  ): Promise<void> {
    // ---- Plan phase (pure reads + math) ------------------------------------
    const [balance0Before, balance1Before] = await this.getBalances();

    const range = this.strategy.computeRange({ currentTick, tickSpacing: this.pool.tickSpacing });
    const sqrtLower = getSqrtRatioAtTick(range.lowerTick);
    const sqrtUpper = getSqrtRatioAtTick(range.upperTick);

    // Sized from the wallet's VALUE, not from the amounts as they stand:
    // min-of-sides collapses to ~0 on a one-sided wallet, the required amounts
    // collapse with it, and planBalancingSwap then sees nothing to correct.
    //
    // This is the pre-close view, so it excludes whatever the position still
    // holds. It drives the log and the dry run; the live plan is recomputed
    // after closing, against balances that include it.
    const { liquidity, required0, required1, swapPlan } = this.planFor(
      balance0Before,
      balance1Before,
      sqrtPriceX96,
      sqrtLower,
      sqrtUpper,
    );
    const closingValue = position?.liquidity ?? 0n;
    if (liquidity === 0n && closingValue === 0n) {
      throw new Error("Computed zero liquidity for new position (balances too small?)");
    }

    logger.info("Rebalance plan", {
      oldPositionId: position?.tokenId.toString() ?? "none (bootstrap mint)",
      oldRange: position ? { lowerTick: position.tickLower, upperTick: position.tickUpper } : null,
      newLowerTick: range.lowerTick,
      newUpperTick: range.upperTick,
      newLiquidity: liquidity.toString(),
      required0: formatUnits(required0, this.pool.token0.decimals),
      required1: formatUnits(required1, this.pool.token1.decimals),
      balance0: formatUnits(balance0Before, this.pool.token0.decimals),
      balance1: formatUnits(balance1Before, this.pool.token1.decimals),
      swapNeeded: swapPlan !== null,
    });

    if (this.config.dryRun) {
      if (swapPlan) {
        await this.logDryRunSwap(swapPlan);
      }
      logger.info("[DRY RUN] Would perform", {
        steps: [
          ...(position && position.liquidity > 0n ? ["decreaseLiquidity"] : []),
          ...(position ? ["collect"] : []),
          ...(swapPlan ? ["exactInputSingle"] : []),
          "mint",
        ],
        mintParams: {
          lowerTick: range.lowerTick,
          upperTick: range.upperTick,
          amount0Desired: (balance0Before < required0 ? balance0Before : required0).toString(),
          amount1Desired: (balance1Before < required1 ? balance1Before : required1).toString(),
        },
      });
      return;
    }

    // ---- Execution phase (chain state is the source of truth) --------------
    let collectedTotals: TokenAmounts = { amount0: 0n, amount1: 0n };
    if (position) {
      const withdrawn =
        position.liquidity > 0n
          ? await this.decreaseLiquidity(position)
          : { amount0: 0n, amount1: 0n };
      // Always collect, even at zero liquidity: a previous cycle may have
      // withdrawn and then failed, leaving everything as tokensOwed.
      const collected = await this.collect(position);
      collectedTotals = collected;
      this.reportFees(withdrawn, collected, sqrtPriceX96);
    }

    // Wait for the collect to be visible before reading. The transport fails
    // over across endpoints, so the node answering this read is not
    // necessarily the one that confirmed the collect. Reading early returns
    // the PRE-close balances, and everything downstream is then sized against
    // capital that is already in the wallet but invisible.
    let [balance0, balance1] = await this.awaitBalancesAtLeast(
      balance0Before + collectedTotals.amount0,
      balance1Before + collectedTotals.amount1,
    );
    logger.info("Balances available to deploy", {
      token0: formatUnits(balance0, this.pool.token0.decimals),
      token1: formatUnits(balance1, this.pool.token1.decimals),
    });

    // Re-plan against what is ACTUALLY in the wallet.
    //
    // The plan above was computed before the position was closed, so it did
    // not include anything the position released — sizing the swap for the
    // wallet alone and leaving the rest to fall out of the min-of-sides at
    // mint time. Observed live: a $397 book deployed $52 and left $345 idle.
    const livePlan = this.planFor(balance0, balance1, sqrtPriceX96, sqrtLower, sqrtUpper);
    if (livePlan.liquidity === 0n) {
      throw new Error("Computed zero liquidity after closing (balances too small?)");
    }
    if (livePlan.swapPlan !== null || swapPlan !== null) {
      logger.info("Rebalance plan (after closing)", {
        liquidity: livePlan.liquidity.toString(),
        required0: formatUnits(livePlan.required0, this.pool.token0.decimals),
        required1: formatUnits(livePlan.required1, this.pool.token1.decimals),
        balance0: formatUnits(balance0, this.pool.token0.decimals),
        balance1: formatUnits(balance1, this.pool.token1.decimals),
        swapNeeded: livePlan.swapPlan !== null,
      });
    }

    // The swap moves the pool price, so the value read at the start of this
    // cycle is stale by the time we mint. Minting against it computes the
    // wrong liquidity and the wrong token ratio — re-read instead.
    let mintSqrtPriceX96 = sqrtPriceX96;
    if (livePlan.swapPlan) {
      await this.executeSwap(livePlan.swapPlan);
      [balance0, balance1] = await this.getBalances();
      const after = await getPoolState(this.client, this.pool.address);
      mintSqrtPriceX96 = after.sqrtPriceX96;
      logger.info("Pool price after rebalancing swap", {
        before: sqrtPriceX96.toString(),
        after: mintSqrtPriceX96.toString(),
        tick: after.currentTick,
      });
    }

    await this.mint(
      range.lowerTick,
      range.upperTick,
      balance0,
      balance1,
      mintSqrtPriceX96,
      sqrtLower,
      sqrtUpper,
    );
  }

  /**
   * Close the position to cash without re-opening: the regime filter's exit.
   *
   * Deliberately does NOT swap to a single asset. The position is withdrawn
   * as whatever mix the band held, which for an out-of-range position is
   * already one-sided. Converting further would pay a spread for no benefit —
   * the filter's purpose is to stop earning fees on a losing exposure, and
   * re-entry needs both tokens back anyway.
   */
  async closePosition(position: PositionInfo, sqrtPriceX96: bigint): Promise<void> {
    // Zero liquidity does NOT mean there is nothing to do: if a previous
    // attempt withdrew but failed before collecting, the principal and fees
    // are sitting in the position as tokensOwed. Returning early here strands
    // them permanently, because every later cycle sees liquidity 0 too.
    const owed = position.tokensOwed0 > 0n || position.tokensOwed1 > 0n;
    if (position.liquidity === 0n && !owed) return;

    if (this.config.dryRun) {
      logger.info("[DRY RUN] Would stand aside", {
        tokenId: position.tokenId.toString(),
        liquidity: position.liquidity.toString(),
        tokensOwed0: position.tokensOwed0.toString(),
        tokensOwed1: position.tokensOwed1.toString(),
        steps: [...(position.liquidity > 0n ? ["decreaseLiquidity"] : []), "collect"],
      });
      return;
    }

    const withdrawn =
      position.liquidity > 0n
        ? await this.decreaseLiquidity(position)
        : { amount0: 0n, amount1: 0n };
    const collected = await this.collect(position);
    this.reportFees(withdrawn, collected, sqrtPriceX96);
    logger.info("Standing aside — position closed to cash", {
      tokenId: position.tokenId.toString(),
      recoveredOwedOnly: position.liquidity === 0n,
    });
  }

  private async logDryRunSwap(plan: { zeroForOne: boolean; amountIn: bigint }): Promise<void> {
    const tokenIn = this.tokenForDirection(plan.zeroForOne);
    const tokenOut = this.tokenForDirection(!plan.zeroForOne);
    const quotedOut = await quoteExactInputSingle(
      this.client,
      this.config.quoterAddress,
      tokenIn,
      tokenOut,
      this.pool.fee,
      plan.amountIn,
    );
    logger.info("[DRY RUN] Would swap", {
      tokenIn,
      tokenOut,
      amountIn: plan.amountIn.toString(),
      expectedOut: quotedOut.toString(),
      minOut: applySlippageBps(quotedOut, this.config.slippageBps).toString(),
    });
  }

  private async decreaseLiquidity(position: PositionInfo): Promise<TokenAmounts> {
    const data = encodeDecreaseLiquidity({
      tokenId: position.tokenId,
      liquidity: position.liquidity,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + TX_DEADLINE_SECONDS),
    });
    logger.info("Removing liquidity", {
      tokenId: position.tokenId.toString(),
      liquidity: position.liquidity.toString(),
    });
    const hash = await this.send("decreaseLiquidity", this.config.positionManagerAddress, data);
    return (
      (await this.readEventAmounts(hash, "DecreaseLiquidity")) ?? { amount0: 0n, amount1: 0n }
    );
  }

  private async collect(position: PositionInfo): Promise<TokenAmounts> {
    const data = encodeCollect({
      tokenId: position.tokenId,
      recipient: this.wallet,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    });
    logger.info("Collecting fees and remaining tokens", {
      tokenId: position.tokenId.toString(),
    });
    const hash = await this.send("collect", this.config.positionManagerAddress, data);
    return (await this.readEventAmounts(hash, "Collect")) ?? { amount0: 0n, amount1: 0n };
  }

  private async executeSwap(plan: { zeroForOne: boolean; amountIn: bigint }): Promise<void> {
    const tokenIn = this.tokenForDirection(plan.zeroForOne);
    const tokenOut = this.tokenForDirection(!plan.zeroForOne);

    const quotedOut = await quoteExactInputSingle(
      this.client,
      this.config.quoterAddress,
      tokenIn,
      tokenOut,
      this.pool.fee,
      plan.amountIn,
    );
    const amountOutMinimum = applySlippageBps(quotedOut, this.config.slippageBps);

    logger.info("Swapping to rebalance", {
      tokenIn,
      tokenOut,
      amountIn: plan.amountIn.toString(),
      quotedOut: quotedOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      slippageBps: this.config.slippageBps,
    });

    await this.ensureApproval(tokenIn, this.config.swapRouterAddress, plan.amountIn);
    const data = encodeExactInputSingle({
      tokenIn,
      tokenOut,
      fee: this.pool.fee,
      recipient: this.wallet,
      amountIn: plan.amountIn,
      amountOutMinimum,
    });
    await this.send("exactInputSingle", this.config.swapRouterAddress, data);
  }

  private async mint(
    lowerTick: number,
    upperTick: number,
    balance0: bigint,
    balance1: bigint,
    sqrtPriceX96: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint,
  ): Promise<void> {
    // Recompute from live balances so a partial failure recovers safely.
    // min-of-sides here, deliberately: after the balancing swap this is the
    // most that can actually be committed from the balances in hand, and
    // asking for more than the wallet holds reverts.
    const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, balance0, balance1);
    if (liquidity === 0n) {
      throw new Error("Computed zero liquidity when minting (balances too small?)");
    }
    const { amount0: required0, amount1: required1 } = getAmountsForLiquidity(
      sqrtPriceX96,
      sqrtLower,
      sqrtUpper,
      liquidity,
    );

    // Never attempt to spend more than the wallet holds.
    const amount0Desired = balance0 < required0 ? balance0 : required0;
    const amount1Desired = balance1 < required1 ? balance1 : required1;
    const amount0Min = applySlippageBps(required0, this.config.slippageBps);
    const amount1Min = applySlippageBps(required1, this.config.slippageBps);

    logger.info("Minting new position", {
      lowerTick,
      upperTick,
      liquidity: liquidity.toString(),
      amount0Desired: amount0Desired.toString(),
      amount1Desired: amount1Desired.toString(),
      amount0Min: amount0Min.toString(),
      amount1Min: amount1Min.toString(),
    });

    await this.ensureApproval(this.pool.token0.address, this.config.positionManagerAddress, amount0Desired);
    await this.ensureApproval(this.pool.token1.address, this.config.positionManagerAddress, amount1Desired);

    const data = encodeMint({
      token0: this.pool.token0.address,
      token1: this.pool.token1.address,
      fee: this.pool.fee,
      tickLower: lowerTick,
      tickUpper: upperTick,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
      recipient: this.wallet,
      deadline: BigInt(Math.floor(Date.now() / 1000) + TX_DEADLINE_SECONDS),
    });

    const hash = await this.send("mint", this.config.positionManagerAddress, data);
    const receipt = await this.client.waitForTransactionReceipt({ hash });

    let newTokenId: bigint | undefined;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: npmEventsAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === "IncreaseLiquidity") {
          newTokenId = decoded.args.tokenId as bigint;
        }
      } catch {
        // Not an NPM event; ignore.
      }
    }
    logger.info("New position created", {
      newPositionId: newTokenId?.toString() ?? "unknown",
      txHash: hash,
    });
    if (newTokenId !== undefined) {
      savePositionId(this.config.stateFile, newTokenId);
    }
  }

  /** Pull amount0/amount1 out of the named NPM event in a receipt. */
  private async readEventAmounts(
    hash: `0x${string}`,
    eventName: "IncreaseLiquidity" | "DecreaseLiquidity" | "Collect",
  ): Promise<TokenAmounts | null> {
    // waitForTransactionReceipt polls and tolerates a lagging node.
    // getTransactionReceipt does not: behind a load balancer the follow-up
    // call can land on a node that has not seen the block yet and throw,
    // which previously aborted the cycle BETWEEN decreaseLiquidity and
    // collect and left the position withdrawn but uncollected.
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({ hash });
    } catch (error) {
      logger.warn("Could not read receipt for fee accounting; continuing", {
        eventName,
        hash,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
      return null;
    }
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: npmEventsAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === eventName) {
          const args = decoded.args as unknown as TokenAmounts;
          return { amount0: args.amount0, amount1: args.amount1 };
        }
      } catch {
        // Not an NPM event; ignore.
      }
    }
    logger.warn("Event not found in receipt", { eventName, hash });
    return null;
  }

  /**
   * Fees earned since the last re-centre: everything `collect` transferred
   * beyond the principal `decreaseLiquidity` released.
   *
   * This is the only place the live bot can measure fee income. It is the
   * number the backtest's fee model is meant to predict, so it is logged in
   * both token units and USD and accumulated in the state file.
   */
  private reportFees(
    withdrawn: TokenAmounts,
    collected: TokenAmounts,
    sqrtPriceX96: bigint,
  ): void {
    const fee0 = collected.amount0 > withdrawn.amount0 ? collected.amount0 - withdrawn.amount0 : 0n;
    const fee1 = collected.amount1 > withdrawn.amount1 ? collected.amount1 - withdrawn.amount1 : 0n;

    const price = sqrtRatioToPrice(
      sqrtPriceX96,
      this.pool.token0.decimals,
      this.pool.token1.decimals,
    );
    const feeUsd =
      Number(formatUnits(fee0, this.pool.token0.decimals)) * price +
      Number(formatUnits(fee1, this.pool.token1.decimals));

    // Accounting must never be able to break the transaction sequence.
    let state;
    try {
      state = recordFees(this.config.stateFile, fee0, fee1, feeUsd);
    } catch (error) {
      logger.warn("Could not persist fee totals; continuing", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const sinceIso = state.firstDeployedAt;
    const days =
      sinceIso === null ? 0 : (Date.now() - new Date(sinceIso).getTime()) / 86_400_000;

    logger.info("Fees collected", {
      [`${this.pool.token0.symbol}`]: formatUnits(fee0, this.pool.token0.decimals),
      [`${this.pool.token1.symbol}`]: formatUnits(fee1, this.pool.token1.decimals),
      feeUsd: feeUsd.toFixed(4),
      cumulativeFeeUsd: state.feesUsd.toFixed(4),
      recenters: state.recenters,
      daysDeployed: days.toFixed(2),
    });
  }

  private async ensureApproval(token: Address, spender: Address, amountNeeded: bigint): Promise<void> {
    const allowance = await this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.wallet, spender],
    });
    if (allowance >= amountNeeded && allowance > 0n) return;

    logger.info("Approving spender", { token, spender });
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, MAX_UINT256],
    });
    await this.send("approve", token, data);
    await this.awaitAllowance(token, spender, amountNeeded);
  }

  /**
   * Block until the approval is visible to reads.
   *
   * The transport fails over across RPC endpoints, so the node that confirms
   * the approval receipt is not necessarily the one that answers the next
   * call. Acting against a node one block behind reverts with "transfer
   * amount exceeds allowance" even though the approval landed.
   */
  private async awaitAllowance(
    token: Address,
    spender: Address,
    amountNeeded: bigint,
    attempts = 10,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const allowance = await this.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [this.wallet, spender],
      });
      if (allowance >= amountNeeded) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Approval for ${token} did not become visible after ${attempts}s; ` +
        `the RPC endpoints may be out of sync. Nothing was lost — retry.`,
    );
  }

  private tokenForDirection(zeroForOne: boolean): Address {
    return zeroForOne ? this.pool.token0.address : this.pool.token1.address;
  }

  /**
   * Size a position from the given balances and work out the swap to reach it.
   *
   * Shared by the pre-close plan (for the log and dry run) and the live one
   * computed after closing, so the two cannot drift apart.
   */
  private planFor(
    balance0: bigint,
    balance1: bigint,
    sqrtPriceX96: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint,
  ): {
    liquidity: bigint;
    required0: bigint;
    required1: bigint;
    swapPlan: ReturnType<typeof planBalancingSwap>;
  } {
    const liquidity = getLiquidityForValue(
      sqrtPriceX96,
      sqrtLower,
      sqrtUpper,
      balance0,
      balance1,
    );
    const { amount0: required0, amount1: required1 } = getAmountsForLiquidity(
      sqrtPriceX96,
      sqrtLower,
      sqrtUpper,
      liquidity,
    );
    return {
      liquidity,
      required0,
      required1,
      swapPlan: planBalancingSwap(required0, required1, balance0, balance1),
    };
  }

  /**
   * Read balances, waiting until they reflect a transfer already confirmed.
   *
   * Falls through to whatever is there after the timeout rather than throwing:
   * an under-read costs a smaller position, while refusing to proceed leaves
   * the capital undeployed entirely.
   */
  private async awaitBalancesAtLeast(
    expected0: bigint,
    expected1: bigint,
    attempts = 10,
  ): Promise<[bigint, bigint]> {
    let latest: [bigint, bigint] = await this.getBalances();
    for (let i = 0; i < attempts; i++) {
      if (latest[0] >= expected0 && latest[1] >= expected1) {
        if (i > 0) logger.debug("Balances visible after retry", { attempt: i + 1 });
        return latest;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      latest = await this.getBalances();
    }
    logger.warn("Balances still below the confirmed total; proceeding with what is visible", {
      expected0: formatUnits(expected0, this.pool.token0.decimals),
      expected1: formatUnits(expected1, this.pool.token1.decimals),
      actual0: formatUnits(latest[0], this.pool.token0.decimals),
      actual1: formatUnits(latest[1], this.pool.token1.decimals),
    });
    return latest;
  }

  private async getBalances(): Promise<[bigint, bigint]> {
    return Promise.all([
      this.client.readContract({
        address: this.pool.token0.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.wallet],
      }),
      this.client.readContract({
        address: this.pool.token1.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.wallet],
      }),
    ]) as Promise<[bigint, bigint]>;
  }

  /**
   * Delegate simulation, broadcast and receipt verification to the
   * blockchain layer.
   */
  private async send(label: string, to: Address, data: `0x${string}`): Promise<`0x${string}`> {
    logger.info("Sending transaction", { label, to });
    const hash = await this.transactor.send(this.client, label, to, data);
    logger.info("Transaction confirmed", { label, hash });
    return hash;
  }
}
