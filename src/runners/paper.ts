import { erc20Abi, formatUnits } from "viem";
import { createClient } from "../blockchain/client.js";
import type { BotClient } from "../blockchain/client.js";
import { getPoolInfo, getPoolState } from "../uniswap/pool.js";
import { sqrtRatioToPrice } from "../utils/math.js";
import { LinearCostFillModel } from "../grid/fillModel.js";
import { GridStrategy } from "../grid/gridStrategy.js";
import type { AppConfig } from "../config.js";
import { planLendingActions } from "../lending/policy.js";
import { logger } from "../utils/logger.js";

/**
 * Phase 4: run the exact same grid strategy against live Base/Uniswap prices
 * WITHOUT sending any transactions. Pure observation + decision logging.
 */
export async function runPaperMode(cfg: AppConfig): Promise<void> {
  const client = createClient(cfg.rpcUrls);
  const pool = await getPoolInfo(client, cfg.poolAddress!);

  const fillModel = new LinearCostFillModel(cfg.grid.feeBps, cfg.grid.slippageBps);
  const strategy = new GridStrategy(cfg.grid, fillModel);

  // Paper mode starts from the configured capital; balances are simulated.
  logger.info("Paper trading started", {
    pool: pool.address,
    token0: `${pool.token0.symbol} (${pool.token0.decimals}d)`,
    token1: `${pool.token1.symbol} (${pool.token1.decimals}d)`,
    initialUsdc: cfg.grid.initialUsdc,
    initialEth: cfg.grid.initialEth,
    spacing: `${cfg.grid.spacingPercent}%`,
    levels: `-${cfg.grid.levelsBelow}/+${cfg.grid.levelsAbove}`,
    pollSeconds: cfg.pollIntervalSeconds,
  });

  let tick = 0;
  let lastUtcDay: string | null = null;
  for (;;) {
    try {
      const state = await getPoolState(client, pool.address);
      const price = sqrtRatioToPrice(
        state.sqrtPriceX96,
        pool.token0.decimals,
        pool.token1.decimals,
      );

      const nowSec = Math.floor(Date.now() / 1000);
      const actions = strategy.onPriceUpdate(price, nowSec);
      const s = strategy.getState();

      // Machine-parseable events for `npm run soak-report`.
      for (const a of actions) {
        logger.info("Paper fill", {
          side: a.type,
          levelPrice: a.price,
          amount: a.type === "BUY" ? a.quoteAmount : a.baseAmount,
          gridLevel: a.type === "LIQUIDATE" ? null : a.gridLevel,
          usdc: s.usdc,
          eth: s.eth,
          portfolioValue: strategy.getPortfolioValue(price),
          realizedGridGrossUsd: s.realizedGrossUsd,
          realizedResetGrossUsd: s.realizedResetGrossUsd,
        });
      }
      const utcDay = new Date(nowSec * 1000).toISOString().slice(0, 10);
      if (utcDay !== lastUtcDay) {
        if (lastUtcDay !== null) {
          logger.info("Paper day close", {
            day: lastUtcDay,
            price,
            portfolioValue: strategy.getPortfolioValue(price),
            usdc: s.usdc,
            eth: s.eth,
            cycles: s.completedCycles,
          });
        }
        lastUtcDay = utcDay;
      }

      if (actions.length > 0 || tick % 10 === 0) {
        const lendPlan = cfg.lendingEnabled
          ? planLendingActions(
              {
                bufferUsdcUsd: cfg.lendBufferUsdcUsd,
                bufferEth: cfg.lendBufferEth,
                minActionUsd: cfg.lendMinActionUsd,
              },
              // Paper balances are simulated; nothing is lent yet.
              { usdcWallet: s.usdc, usdcLent: 0, ethWallet: s.eth, ethLent: 0 },
              price,
            )
          : [];

        logger.info("Paper cycle", {
          price,
          actions: actions.map((a) =>
            a.type === "BUY"
              ? `BUY $${a.quoteAmount.toFixed(2)} @ ${a.price}`
              : `SELL ${a.baseAmount.toFixed(5)} ETH @ ${a.price}`,
          ),
          usdc: s.usdc.toFixed(2),
          eth: s.eth.toFixed(5),
          portfolioValue: strategy.getPortfolioValue(price).toFixed(2),
          cycles: s.completedCycles,
          realizedGrossUsd: s.realizedGrossUsd.toFixed(2),
          wouldLend: lendPlan.map((l) => `${l.kind} ${l.amount.toFixed(2)} ${l.asset}`),
        });
      }

      if (actions.length > 0) {
        logBalancesIfAvailable(client, cfg.walletAddress ?? null, pool.token0.symbol, pool.token1.symbol);
      }
    } catch (error) {
      logger.error("Paper cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    tick++;
    await sleep(cfg.pollIntervalSeconds * 1000);
  }
}

/** Optional sanity check against real wallet balances (informational only). */
async function logBalancesIfAvailable(
  client: BotClient,
  wallet: string | null,
  sym0: string,
  sym1: string,
): Promise<void> {
  void sym0;
  void sym1;
  if (!wallet) return;
  try {
    const ethBalance = await client.getBalance({ address: wallet as `0x${string}` });
    logger.debug("Wallet native balance (gas reference)", {
      eth: formatUnits(ethBalance, 18),
    });
    void erc20Abi; // reserved for future real-balance reconciliation
  } catch {
    // informational only
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
