import type { BotClient } from "../blockchain/client.js";
import { erc20Abi, type Address } from "viem";
import type { LpRebalanceConfig } from "../config.js";
import type { Transactor } from "../blockchain/wallet.js";
import type { PoolInfo } from "../uniswap/pool.js";
import { getPoolState } from "../uniswap/pool.js";
import { getPosition } from "../uniswap/position.js";
import {
  loadPositionId,
  loadState,
  markRecentred,
  recordPriceSample,
  saveState,
  trailingMovePct,
} from "./state.js";
import type { Strategy } from "../strategy/rebalance.js";
import { RebalanceExecutor } from "./rebalanceExecutor.js";
import type { LpLendingManager } from "../lp/lpLending.js";
import type { AaveShortHedge } from "../lp/hedge.js";
import { sqrtRatioToPrice } from "../utils/math.js";
import { logger } from "../utils/logger.js";

const MAX_BACKOFF_SECONDS = 900;

export class Monitor {
  private readonly executor: RebalanceExecutor;
  private consecutiveFailures = 0;
  private lastRecenterAt: number;

  constructor(
    private readonly client: BotClient,
    private readonly transactor: Transactor,
    private readonly config: LpRebalanceConfig,
    private readonly walletAddress: Address | null,
    private readonly pollIntervalSeconds: number,
    private readonly pool: PoolInfo,
    private readonly strategy: Strategy,
    /** Optional: lends idle capital while the bot stands aside. */
    private readonly lending: LpLendingManager | null = null,
    /** Optional: shorts ETH with borrowed Aave WETH while parked. */
    private readonly hedge: AaveShortHedge | null = null,
  ) {
    this.executor = new RebalanceExecutor(
      client,
      transactor,
      config,
      walletAddress,
      pool,
      strategy,
    );
    // The cooldown survives restarts: seeding from the persisted timestamp
    // stops a crash/restart loop from re-centring on every cycle.
    this.lastRecenterAt = loadState(config.stateFile).lastRecenterAt * 1000;
  }

  private get wallet(): Address {
    return this.walletAddress ?? this.transactor.account.address;
  }

  /**
   * Token id to manage: the state file wins over the configured id, so a
   * bootstrap mint is followed across restarts. Returns null when neither is
   * set, which means "mint a fresh position from wallet balances".
   */
  private managedPositionId(): bigint | null {
    const saved = loadPositionId(this.config.stateFile);
    if (saved !== null) return saved;
    return this.config.positionId > 0n ? this.config.positionId : null;
  }

  async run(): Promise<void> {
    logger.info("Bot started", {
      mode: this.config.dryRun ? "DRY_RUN" : "LIVE",
      pool: this.pool.address,
      token0: this.pool.token0.symbol,
      token1: this.pool.token1.symbol,
      strategy: this.strategy.name,
      rangePct: this.config.rangePct,
      recenterBufferPct: this.config.recenterBufferPct,
      widthTicks: this.config.widthTicks,
      thresholdTicks: this.config.thresholdTicks,
      positionId: this.managedPositionId()?.toString() ?? "none (will mint)",
      wallet: this.wallet,
      regimeFilter:
        this.config.regimeMaxMovePct > 0
          ? `stand aside above ${this.config.regimeMaxMovePct}% over ${this.config.regimeLookbackHours}h` +
            (this.config.regimeReenterMarginPct > 0
              ? `, re-enter below ${(
                  this.config.regimeMaxMovePct *
                  (1 - this.config.regimeReenterMarginPct / 100)
                ).toFixed(2)}%`
              : "")
          : "off",
      lending: this.lending !== null ? "Aave V3 while standing aside" : "off",
      hedge: this.hedge !== null ? "borrowed-WETH short while parked" : "off",
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
          this.pollIntervalSeconds * 2 ** Math.min(this.consecutiveFailures - 1, 10),
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
      await sleep(this.pollIntervalSeconds * 1000);
    }
  }

  async cycle(): Promise<void> {
    const state = await getPoolState(this.client, this.pool.address);
    const tokenId = this.managedPositionId();
    const position =
      tokenId === null
        ? null
        : await getPosition(this.client, this.config.positionManagerAddress, tokenId);

    if (tokenId !== null && !position) {
      logger.error("Configured position does not exist", { positionId: tokenId.toString() });
      return;
    }

    const price = sqrtRatioToPrice(
      state.sqrtPriceX96,
      this.pool.token0.decimals,
      this.pool.token1.decimals,
    );
    const center = position ? Math.floor((position.tickLower + position.tickUpper) / 2) : null;
    const distance = center === null ? null : Math.abs(state.currentTick - center);

    // ---- regime filter -----------------------------------------------------
    //
    // Record the observation first, then judge on history that includes it.
    // The window is persisted, so a restart does not blind the filter.
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSeconds = this.config.regimeLookbackHours * 3600;
    const persisted = loadState(this.config.stateFile);
    recordPriceSample(
      persisted,
      nowSec,
      price,
      this.config.regimeSampleMinutes * 60,
      windowSeconds,
    );
    // Pass the live price so the filter reacts at the poll interval, not at
    // the (much coarser) sampling interval.
    const move = trailingMovePct(persisted.priceHistory, nowSec, windowSeconds, price);
    const filterOn = this.config.regimeMaxMovePct > 0;
    // Not enough history is not evidence of a big move — same convention as
    // the backtest, which stays invested until the window fills.
    const hostile = filterOn && move !== null && Math.abs(move) > this.config.regimeMaxMovePct;
    saveState(this.config.stateFile, persisted);

    if (filterOn && move === null) {
      logger.warn("Regime filter has insufficient history — staying invested", {
        samples: persisted.priceHistory.length,
        needHours: this.config.regimeLookbackHours,
        haveHours:
          persisted.priceHistory.length > 1
            ? (
                (nowSec - persisted.priceHistory[0]!.t) /
                3600
              ).toFixed(1)
            : "0",
      });
    }

    // No position yet, or an empty one (liquidity == 0), always needs
    // rebuilding; the latter is the recovery path if a rebalance failed midway.
    const decision =
      !position ||
      position.liquidity === 0n ||
      this.strategy.shouldRebalance(state.currentTick, {
        lowerTick: position.tickLower,
        upperTick: position.tickUpper,
      });

    logger.info("Monitor cycle", {
      price,
      currentTick: state.currentTick,
      positionLowerTick: position?.tickLower ?? null,
      positionUpperTick: position?.tickUpper ?? null,
      positionCenterTick: center,
      distanceFromCenter: distance,
      thresholdTicks: this.config.thresholdTicks,
      liquidity: position?.liquidity.toString() ?? "0",
      regime: filterOn
        ? {
            trailingMovePct: move === null ? null : Number(move.toFixed(2)),
            maxMovePct: this.config.regimeMaxMovePct,
            lookbackHours: this.config.regimeLookbackHours,
            verdict: hostile ? "HOSTILE" : move === null ? "UNKNOWN" : "CALM",
          }
        : "off",
      rebalanceDecision: decision ? "REBALANCE" : "HOLD",
      dryRun: this.config.dryRun,
    });

    // A hostile regime overrides everything: close to cash and stay there.
    // The dwell time is the same one that rate-limits re-centring, so the
    // filter cannot thrash the position in and out on every poll.
    const dwelled =
      nowSec - persisted.lastParkChangeAt >= this.config.recenterMinHours * 3600;

    if (hostile) {
      if (position && position.liquidity > 0n && dwelled) {
        await this.executor.closePosition(position, state.sqrtPriceX96);
        if (!this.config.dryRun) {
          const after = loadState(this.config.stateFile);
          after.parked = true;
          after.lastParkChangeAt = nowSec;
          saveState(this.config.stateFile, after);
        }
      } else {
        logger.info("Hostile regime — standing aside", {
          trailingMovePct: move === null ? null : Number(move.toFixed(2)),
          deployed: position ? position.liquidity > 0n : false,
          dwelled,
        });
      }

      // Idle capital earns nothing, and the filter is deliberately idle most
      // of the time. Run this on every hostile cycle, not just the one that
      // closes the position, so a deposit arriving mid-park is picked up too.
      // This also supplies the COLLATERAL the hedge borrows against.
      if (this.lending !== null) {
        try {
          await this.lending.parkIdle(price);
        } catch (error) {
          // Yield is an optimisation; never let it break the risk control.
          logger.warn("Could not supply idle balance to Aave", {
            error: error instanceof Error ? error.message.split("\n")[0] : String(error),
          });
        }
      }

      // Parked cash tracks ETH down instead of merely missing it. Like the
      // lending above this is an optimisation on top of the risk control: a
      // failed hedge logs and retries next cycle, it never blocks parking.
      if (this.hedge !== null) {
        try {
          await this.hedge.open(price);
        } catch (error) {
          logger.warn("Could not open short hedge", {
            error: error instanceof Error ? error.message.split("\n")[0] : String(error),
          });
        }
      }
      return;
    }

    // Calm again: clear the parked flag so re-entry can proceed below.
    if (persisted.parked && filterOn) {
      // Hysteresis: re-entry requires a SMALLER move than exit. Re-entering
      // the instant |move| dips under the exit threshold flips park/deploy on
      // every oscillation around it, paying a full sell + buy-back each time.
      const reenterMaxPct =
        this.config.regimeMaxMovePct * (1 - this.config.regimeReenterMarginPct / 100);
      // Insufficient history is not evidence of a big move — same convention
      // as the exit path, which stays invested until the window fills.
      const calmEnough = move === null || Math.abs(move) <= reenterMaxPct;
      if (!dwelled) {
        logger.info("Regime calm but dwell time not elapsed — staying in cash", {
          recenterMinHours: this.config.recenterMinHours,
        });
        await this.stayParked(price);
        return;
      }
      if (!calmEnough) {
        logger.info("Regime cooling but move still above re-entry threshold — staying in cash", {
          trailingMovePct: move === null ? null : Number(move.toFixed(2)),
          reenterBelowPct: Number(reenterMaxPct.toFixed(2)),
        });
        await this.stayParked(price);
        return;
      }
      logger.info("Regime calm — re-entering", {
        trailingMovePct: move === null ? null : Number(move.toFixed(2)),
      });
      if (!this.config.dryRun) {
        const after = loadState(this.config.stateFile);
        after.parked = false;
        after.lastParkChangeAt = nowSec;
        saveState(this.config.stateFile, after);
      }
    }

    if (!decision) return;

    // The cooldown rate-limits re-centring, not the initial deployment: with
    // nothing in the pool there is no position to protect and every cycle
    // spent waiting is fee income forgone.
    const deploying = !position || position.liquidity === 0n;
    if (!deploying && !this.cooledDown()) {
      logger.info("Re-centre postponed by cooldown", {
        recenterMinHours: this.config.recenterMinHours,
        nextEligibleAt: new Date(
          this.lastRecenterAt + this.config.recenterMinHours * 3600_000,
        ).toISOString(),
      });
      return;
    }

    // Unwind BEFORE anything else touches balances. The buy-back needs free
    // wallet USDC and deployment must never be funded from a wallet that also
    // owes WETH. Errors propagate: deploying long while still short is worse
    // than a delayed entry.
    if (this.hedge !== null && (await this.hedge.isOpen())) {
      await this.hedge.close();
    }

    // Withdraw before anything reads a balance. The rebalance plan sizes the
    // position from the wallet, so deploying first would fund it from the
    // un-lent remainder and quietly leave the rest in Aave.
    if (this.lending !== null) {
      await this.lending.releaseAll(price);
    }

    if ((!position || position.liquidity === 0n) && (await this.walletIsEmpty())) {
      logger.warn("No liquidity deployed and wallet holds no funds; nothing to do");
      return;
    }

    await this.executor.rebalance(position, state.sqrtPriceX96, state.currentTick);
    // A dry run changes nothing on-chain, so it must not start the cooldown —
    // otherwise the planner goes quiet for `recenterMinHours` after one cycle.
    if (!this.config.dryRun) {
      this.lastRecenterAt = Date.now();
      markRecentred(this.config.stateFile);
    }
  }

  /**
   * Lend whatever is idle while staying parked for another cycle (dwell or
   * hysteresis hold). Same non-fatal treatment as the hostile branch: yield
   * must never break the risk control.
   */
  private async stayParked(price: number): Promise<void> {
    if (this.lending === null) return;
    try {
      await this.lending.parkIdle(price);
    } catch (error) {
      logger.warn("Could not supply idle balance to Aave", {
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
    }
  }

  /**
   * Rate-limit re-centres the same way the backtest does
   * (`recenterMinHours` in src/lp/passiveLp.ts), so a choppy market cannot
   * burn the position down in gas and swap costs.
   */
  private cooledDown(): boolean {
    if (this.config.recenterMinHours <= 0) return true;
    return Date.now() - this.lastRecenterAt >= this.config.recenterMinHours * 3600_000;
  }

  private async walletIsEmpty(): Promise<boolean> {
    const wallet = this.wallet;
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
