import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "../blockchain/client.js";
import { getPoolInfo, getPoolState } from "../uniswap/pool.js";
import { sqrtRatioToPrice } from "../utils/math.js";
import { LinearCostFillModel } from "../grid/fillModel.js";
import { GridStrategy } from "../grid/gridStrategy.js";
import { UniswapV3Executor, type FillIntent } from "../execution/uniswapExecutor.js";
import {
  AaveExecutor,
  type AssetPair,
} from "../lending/aaveExecutor.js";
import { planLendingActions, withdrawShortfall, type LendingConfig } from "../lending/policy.js";
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Phase 5/6: execute the exact same grid strategy with real Uniswap V3
 * swaps. Requires PRIVATE_KEY and an explicit LIVE_CONFIRM=yes.
 *
 * Optionally (ENABLE_AAVE=true) lends idle USDC/WETH to Aave V3 while
 * keeping a liquid trading buffer, and automatically withdraws from Aave
 * before a fill that would exceed the wallet balance.
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

  const aave = cfg.lendingEnabled
    ? new AaveExecutor(
        client,
        cfg,
        {
          underlying: pool.token1.address,
          aToken: cfg.aUsdc,
          debtToken: cfg.variableDebtUsdc,
          decimals: pool.token1.decimals,
          symbol: pool.token1.symbol,
        },
        {
          underlying: pool.token0.address,
          aToken: cfg.aWeth,
          debtToken: cfg.variableDebtWeth,
          decimals: pool.token0.decimals,
          symbol: pool.token0.symbol,
        },
        cfg.privateKey!,
      )
    : null;

  const lendingCfg: LendingConfig = {
    bufferUsdcUsd: cfg.lendBufferUsdcUsd,
    bufferEth: cfg.lendBufferEth,
    minActionUsd: cfg.lendMinActionUsd,
  };

  // The strategy's internal inventory tracks intent; real balances are
  // enforced on-chain by the executor (it reverts on insufficient funds).
  const fillModel = new LinearCostFillModel(cfg.grid.feeBps, cfg.grid.slippageBps);
  const strategy = new GridStrategy(cfg.grid, fillModel);

  // Restart recovery: reload the last known grid/phase/inventory so a crash
  // does not silently reset the strategy mid-regime.
  const stateFile = process.env.LIVE_STATE_FILE ?? "live-state.json";
  try {
    const saved = readFileSync(stateFile, "utf8");
    strategy.restoreSerializedState(saved);
    const s = strategy.getState();
    logger.info("Live state restored", {
      stateFile,
      center: s.centerPrice,
      phase: s.phase,
      resets: s.resets,
      usdc: s.usdc.toFixed(2),
      eth: s.eth.toFixed(5),
      trades: s.trades.length,
    });
  } catch {
    logger.info("No prior live state found; starting fresh", { stateFile });
  }

  function persistState(): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, strategy.serializeState());
      renameSync(tmp, stateFile);
      logger.debug("Live state persisted", { stateFile });
    } catch (error) {
      logger.error("Failed to persist live state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Compare simulated inventory with real wallet+lent balances. */
  async function checkDrift(ethPrice: number): Promise<void> {
    if (!cfg.walletAddress && !cfg.privateKey) return;
    try {
      const wallet = (cfg.walletAddress ?? undefined) as `0x${string}` | undefined;
      void wallet;
      const owner = cfg.walletAddress ?? transactorAddress(cfg.privateKey!);
      const [usdcWallet, ethWallet] = await Promise.all([
        tokenBalance(client, pool.token1.address, owner),
        tokenBalance(client, pool.token0.address, owner),
      ]);
      let usdcLent = 0;
      let ethLent = 0;
      if (aave) {
        usdcLent = await aave.lentBalance("USDC");
        ethLent = await aave.lentBalance("WETH");
      }
      const s = strategy.getState();
      const driftUsdc = Math.abs(s.usdc - (usdcWallet + usdcLent));
      const driftEth = Math.abs(s.eth - (ethWallet + ethLent));
      const driftEthUsd = driftEth * ethPrice;
      if (driftUsdc > DRIFT_WARN_USDC || driftEthUsd > DRIFT_WARN_USDC) {
        logger.warn("Inventory drift detected — simulated vs chain", {
          simUsdc: s.usdc.toFixed(2),
          chainUsdc: (usdcWallet + usdcLent).toFixed(2),
          driftUsdc: driftUsdc.toFixed(2),
          simEth: s.eth.toFixed(5),
          chainEth: (ethWallet + ethLent).toFixed(5),
          driftEthUsd: driftEthUsd.toFixed(2),
        });
      } else {
        logger.debug("Drift check passed", { driftUsdc: driftUsdc.toFixed(4), driftEth: driftEth.toFixed(6) });
      }
    } catch (error) {
      logger.error("Drift check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("LIVE grid trading started — real transactions will be sent", {
    pool: pool.address,
    token0: pool.token0.symbol,
    token1: pool.token1.symbol,
    spacing: `${cfg.grid.spacingPercent}%`,
    levels: `-${cfg.grid.levelsBelow}/+${cfg.grid.levelsAbove}`,
    orderSizeUsd: cfg.grid.orderSizeUsd,
    pollSeconds: cfg.pollIntervalSeconds,
    aaveLending: cfg.lendingEnabled,
  });

  let nextLendCheck = 0; // unix seconds of the next allowed lend sweep
  let cycleCount = 0;
  const DRIFT_CHECK_CYCLES = 20;
  const DRIFT_WARN_USDC = 10;

  for (;;) {
    try {
      logger.debug("Cycle: fetching pool state", { pool: pool.address });
      const state = await getPoolState(client, pool.address);
      const price = sqrtRatioToPrice(state.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
      const nowSec = Math.floor(Date.now() / 1000);
      logger.debug("Cycle: pool state fetched", {
        price,
        tick: state.currentTick,
        sqrtPriceX96: state.sqrtPriceX96.toString(),
        nextLendCheck: nextLendCheck === 0 ? "not scheduled" : new Date(nextLendCheck * 1000).toISOString(),
      });

      const actions = strategy.onPriceUpdate(price, nowSec);
      logger.debug("Cycle: strategy returned", {
        actionCount: actions.length,
        actions: actions.map((a) => a.type),
      });

      if (actions.length > 0) {
        // The strategy applies fills optimistically; snapshot first so a
        // reverted/failed transaction can roll the internal state back and
        // simulated inventory never desyncs from the chain.
        const snapshot = strategy.serializeState();
        try {
        // Batched execution: one Aave withdrawal per asset (only if the
        // wallet is short), then ALL fills in a single router multicall.
        const fills: FillIntent[] = actions.map((a) => {
          if (a.type === "BUY") return { type: "BUY", amount: a.quoteAmount, gridLevel: a.gridLevel };
          // LIQUIDATE is a market sell of the whole inventory — batch it too.
          const level = a.type === "SELL" ? a.gridLevel : -1;
          if (a.type === "LIQUIDATE") logger.info("Reset liquidation included in batch", { eth: a.baseAmount });
          return { type: "SELL", amount: a.baseAmount, gridLevel: level };
        });
        const usdcNeeded = fills.filter((f) => f.type === "BUY").reduce((s, f) => s + f.amount, 0);
        const wethNeeded = fills.filter((f) => f.type === "SELL").reduce((s, f) => s + f.amount, 0);
        logger.debug("Batch plan", { buys: usdcNeeded, sellsEth: wethNeeded, legs: fills.length });

        if (aave && usdcNeeded > 0) await ensureLiquidity(aave, "USDC", usdcNeeded);
        if (aave && wethNeeded > 0) await ensureLiquidity(aave, "WETH", wethNeeded);

        const batch = await executor.executeFills(fills);
        if (batch) {
          logger.info("Batched grid fills executed", {
            txHash: batch.txHash,
            legs: batch.results.length,
            results: batch.results.map((r, i) => ({
              gridLevel: fills[i]!.gridLevel,
              side: fills[i]!.type,
              ...r,
            })),
          });
        }
        } catch (error) {
          strategy.restoreSerializedState(snapshot);
          logger.error("Fill execution failed — strategy state rolled back", {
            error: error instanceof Error ? error.message : String(error),
            restoredTrades: strategy.getState().trades.length,
          });
        }
      }

      // Periodic idle-liquidity sweep.
      if (aave && nowSec >= nextLendCheck) {
        nextLendCheck = nowSec + cfg.lendIntervalSeconds;
        await lendIdleSweep(aave, lendingCfg, price);
      }

      persistState();

      cycleCount++;
      if (cycleCount % DRIFT_CHECK_CYCLES === 0) {
        await checkDrift(price);
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

/**
 * Withdraw from Aave when a grid fill needs more than the wallet holds.
 * Failures are logged but do not abort the trade — the swap itself will
 * revert cleanly if funds are truly missing.
 */
async function ensureLiquidity(
  aave: AaveExecutor | null,
  asset: "USDC" | "WETH",
  neededHuman: number,
): Promise<void> {
  if (!aave) {
    logger.debug("Liquidity check skipped (Aave lending disabled)", { asset, needed: neededHuman });
    return;
  }
  logger.debug("Liquidity check for fill", { asset, needed: neededHuman });
  try {
    // One request for both sides, same block.
    const { wallet, lent } = await aave.balancesFor(asset);
    const shortfall = withdrawShortfall(wallet, lent, neededHuman);
    if (shortfall !== null && shortfall > 0) {
      logger.info("Auto-withdrawing from Aave for grid fill", {
        asset,
        needed: neededHuman,
        wallet,
        lent,
        withdrawing: shortfall,
      });
      await aave.withdraw(asset, shortfall);
    } else {
      logger.debug("No withdrawal needed", { asset, needed: neededHuman, wallet, lent });
    }
  } catch (error) {
    logger.error("Aave auto-withdraw failed (continuing)", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Lend whatever sits idle above the configured buffers. */
async function lendIdleSweep(
  aave: AaveExecutor,
  lendingCfg: LendingConfig,
  ethPrice: number,
): Promise<void> {
  try {
    logger.debug("Idle-liquidity sweep: reading balances", {});
    // Four balances, one request, one block.
    const balances = await aave.allBalances();
    const actions = planLendingActions(lendingCfg, balances, ethPrice);
    logger.debug("Idle-liquidity sweep: policy decision", {
      balances,
      ethPrice,
      planned: actions.map((a) => `${a.kind} ${a.amount} ${a.asset} ($${a.amountUsd.toFixed(2)})`),
    });
    if (actions.length === 0) {
      logger.debug("Idle-liquidity sweep: nothing to do");
    }
    for (const action of actions) {
      if (action.kind === "supply") {
        await aave.supply(action.asset, action.amount);
      } else {
        await aave.withdraw(action.asset, action.amount);
      }
    }
    logger.debug("Idle-liquidity sweep complete", {
      ...balances,
      actions: actions.length,
    });
  } catch (error) {
    logger.error("Idle-liquidity sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function transactorAddress(privateKey: `0x${string}`): `0x${string}` {
  return privateKeyToAccount(privateKey).address;
}

async function tokenBalance(
  client: ReturnType<typeof createClient>,
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<number> {
  const raw = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  // Both pool tokens are known (USDC 6 / WETH 18) via pool metadata; use
  // formatUnits with the right decimals by reading them cheaply.
  const decimals = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  });
  return Number(formatUnits(raw, decimals));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
