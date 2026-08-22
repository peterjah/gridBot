import { createClient } from "../blockchain/client.js";
import { getPoolInfo, getPoolState } from "../uniswap/pool.js";
import { sqrtRatioToPrice } from "../utils/math.js";
import { LinearCostFillModel } from "../grid/fillModel.js";
import { GridStrategy } from "../grid/gridStrategy.js";
import { UniswapV3Executor } from "../execution/uniswapExecutor.js";
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Phase 5/6: execute the exact same grid strategy with real Uniswap V3
 * swaps. Requires PRIVATE_KEY and an explicit LIVE_CONFIRM=yes.
 */
export async function runLiveMode(cfg: AppConfig): Promise<void> {
  if (process.env.LIVE_CONFIRM !== "yes") {
    throw new Error(
      "Refusing to start: live mode requires LIVE_CONFIRM=yes in the environment",
    );
  }

  const client = createClient(cfg.rpcUrls);
  const pool = await getPoolInfo(client, cfg.poolAddress!);
  const executor = new UniswapV3Executor(client, cfg, pool, cfg.privateKey!);

  // The strategy's internal inventory tracks intent; real balances are
  // enforced on-chain by the executor (it reverts on insufficient funds).
  const fillModel = new LinearCostFillModel(cfg.grid.feeBps, cfg.grid.slippageBps);
  const strategy = new GridStrategy(cfg.grid, fillModel);

  logger.info("LIVE grid trading started — real transactions will be sent", {
    pool: pool.address,
    token0: pool.token0.symbol,
    token1: pool.token1.symbol,
    spacing: `${cfg.grid.spacingPercent}%`,
    levels: `-${cfg.grid.levelsBelow}/+${cfg.grid.levelsAbove}`,
    orderSizeUsd: cfg.grid.orderSizeUsd,
    pollSeconds: cfg.pollIntervalSeconds,
  });

  for (;;) {
    try {
      const state = await getPoolState(client, pool.address);
      const price = sqrtRatioToPrice(state.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);

      const actions = strategy.onPriceUpdate(price, Math.floor(Date.now() / 1000));
      for (const action of actions) {
        if (action.type === "BUY") {
          logger.info("Executing grid BUY", { price: action.price, quoteUsd: action.quoteAmount });
          const res = await executor.buy(action.quoteAmount);
          logger.info("Grid BUY filled", { ...res });
        } else {
          logger.info("Executing grid SELL", { price: action.price, eth: action.baseAmount });
          const res = await executor.sell(action.baseAmount);
          logger.info("Grid SELL filled", { ...res });
        }
      }

      const s = strategy.getState();
      if (actions.length > 0) {
        logger.info("Inventory after trades", {
          price,
          usdc: s.usdc.toFixed(2),
          eth: s.eth.toFixed(5),
          cycles: s.completedCycles,
        });
      }
    } catch (error) {
      logger.error("Live cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(Math.max(cfg.pollIntervalSeconds, 60) * 1000); // back off
      continue;
    }
    await sleep(cfg.pollIntervalSeconds * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
