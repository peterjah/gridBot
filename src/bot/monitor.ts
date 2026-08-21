import type { BotClient } from "../blockchain/client.js";
import { erc20Abi } from "viem";
import type { Config } from "../config.js";
import type { Transactor } from "../blockchain/wallet.js";
import type { PoolInfo } from "../uniswap/pool.js";
import { getPoolState } from "../uniswap/pool.js";
import { getPosition } from "../uniswap/position.js";
import type { Strategy } from "../strategy/rebalance.js";
import { RebalanceExecutor } from "./rebalanceExecutor.js";
import { sqrtRatioToPrice } from "../utils/math.js";
import { logger } from "../utils/logger.js";

const MAX_BACKOFF_SECONDS = 900;

export class Monitor {
  private readonly executor: RebalanceExecutor;
  private consecutiveFailures = 0;

  constructor(
    private readonly client: BotClient,
    private readonly transactor: Transactor,
    private readonly config: Config,
    private readonly pool: PoolInfo,
    private readonly strategy: Strategy,
  ) {
    this.executor = new RebalanceExecutor(client, transactor, config, pool, strategy);
  }

  async run(): Promise<void> {
    logger.info("Bot started", {
      mode: this.config.dryRun ? "DRY_RUN" : "LIVE",
      pool: this.pool.address,
      token0: this.pool.token0.symbol,
      token1: this.pool.token1.symbol,
      strategy: this.strategy.name,
      positionId: this.config.positionId.toString(),
      wallet: this.config.walletAddress ?? this.transactor.account.address,
    });

    for (;;) {
      try {
        await this.cycle();
        this.consecutiveFailures = 0;
      } catch (error) {
        this.consecutiveFailures++;
        // Exponential backoff so a persistent failure (e.g. reverting mint)
        // does not burn gas on every poll interval.
        const backoffSeconds = Math.min(
          this.config.pollIntervalSeconds * 2 ** Math.min(this.consecutiveFailures - 1, 10),
          MAX_BACKOFF_SECONDS,
        );
        logger.error("Cycle failed", {
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures: this.consecutiveFailures,
          retryingInSeconds: backoffSeconds,
        });
        await sleep(backoffSeconds * 1000);
        continue;
      }
      await sleep(this.config.pollIntervalSeconds * 1000);
    }
  }

  async cycle(): Promise<void> {
    const state = await getPoolState(this.client, this.pool.address);
    const position = await getPosition(
      this.client,
      this.config.positionManagerAddress,
      this.config.positionId,
    );

    if (!position) {
      logger.error("Position does not exist", { positionId: this.config.positionId.toString() });
      return;
    }

    const price = sqrtRatioToPrice(
      state.sqrtPriceX96,
      this.pool.token0.decimals,
      this.pool.token1.decimals,
    );
    const center = Math.floor((position.tickLower + position.tickUpper) / 2);
    const distance = Math.abs(state.currentTick - center);

    // An empty position (liquidity == 0) always needs rebuilding; this is the
    // recovery path if a previous rebalance failed midway.
    const decision =
      position.liquidity === 0n ||
      this.strategy.shouldRebalance(state.currentTick, {
        lowerTick: position.tickLower,
        upperTick: position.tickUpper,
      });

    logger.info("Monitor cycle", {
      price,
      currentTick: state.currentTick,
      positionLowerTick: position.tickLower,
      positionUpperTick: position.tickUpper,
      positionCenterTick: center,
      distanceFromCenter: distance,
      liquidity: position.liquidity.toString(),
      rebalanceDecision: decision ? "REBALANCE" : "HOLD",
      dryRun: this.config.dryRun,
    });

    if (!decision) return;

    if (position.liquidity === 0n && (await this.walletIsEmpty())) {
      logger.warn("Position is closed and wallet holds no funds; nothing to do");
      return;
    }

    await this.executor.rebalance(position, state.sqrtPriceX96, state.currentTick);
  }

  private async walletIsEmpty(): Promise<boolean> {
    const wallet = this.config.walletAddress ?? this.transactor.account.address;
    const [b0, b1] = await Promise.all([
      this.client.readContract({
        address: this.pool.token0.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
      }),
      this.client.readContract({
        address: this.pool.token1.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
      }),
    ]);
    return b0 === 0n && b1 === 0n;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
