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

    // Amounts needed to deploy the wallet into the new range.
    const liquidity = getLiquidityForAmounts(
      sqrtPriceX96,
      sqrtLower,
      sqrtUpper,
      balance0Before,
      balance1Before,
    );
    if (liquidity === 0n) {
      throw new Error("Computed zero liquidity for new position (balances too small?)");
    }
    const { amount0: required0, amount1: required1 } = getAmountsForLiquidity(
      sqrtPriceX96,
      sqrtLower,
      sqrtUpper,
      liquidity,
    );

    const swapPlan = planBalancingSwap(required0, required1, balance0Before, balance1Before);

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
    if (position) {
      const withdrawn =
        position.liquidity > 0n
          ? await this.decreaseLiquidity(position)
          : { amount0: 0n, amount1: 0n };
      const collected = await this.collect(position);
      this.reportFees(withdrawn, collected, sqrtPriceX96);
    }

    let [balance0, balance1] = await this.getBalances();
    logger.info("Balances available to deploy", {
      token0: formatUnits(balance0, this.pool.token0.decimals),
      token1: formatUnits(balance1, this.pool.token1.decimals),
    });

    // The swap moves the pool price, so the value read at the start of this
    // cycle is stale by the time we mint. Minting against it computes the
    // wrong liquidity and the wrong token ratio — re-read instead.
    let mintSqrtPriceX96 = sqrtPriceX96;
    if (swapPlan) {
      await this.executeSwap(swapPlan);
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
    if (position.liquidity === 0n) return;

    if (this.config.dryRun) {
      logger.info("[DRY RUN] Would stand aside", {
        tokenId: position.tokenId.toString(),
        liquidity: position.liquidity.toString(),
        steps: ["decreaseLiquidity", "collect"],
      });
      return;
    }

    const withdrawn = await this.decreaseLiquidity(position);
    const collected = await this.collect(position);
    this.reportFees(withdrawn, collected, sqrtPriceX96);
    logger.info("Standing aside — position closed to cash", {
      tokenId: position.tokenId.toString(),
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
    const receipt = await this.client.getTransactionReceipt({ hash });

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
    const receipt = await this.client.getTransactionReceipt({ hash });
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

    const state = recordFees(this.config.stateFile, fee0, fee1, feeUsd);
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
  }

  private tokenForDirection(zeroForOne: boolean): Address {
    return zeroForOne ? this.pool.token0.address : this.pool.token1.address;
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
