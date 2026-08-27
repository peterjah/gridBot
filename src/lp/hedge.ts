import type { Address } from "viem";
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits } from "viem";
import type { AaveExecutor } from "../lending/aaveExecutor.js";
import type { BotClient } from "../blockchain/client.js";
import type { Transactor } from "../blockchain/wallet.js";
import type { LpRebalanceConfig } from "../config.js";
import type { PoolInfo } from "../uniswap/pool.js";
import { getPoolState } from "../uniswap/pool.js";
import { encodeExactInputSingle, quoteExactInputSingle } from "../uniswap/swap.js";
import { applySlippageBps, sqrtRatioToPrice } from "../utils/math.js";
import { saveHedgedFlag } from "../bot/state.js";
import { logger } from "../utils/logger.js";

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Debt below this many wei counts as no debt.
 *
 * Interest accrues every block, so a repaid position never reads exactly zero
 * and the hedge state must not depend on hitting an exact number. 1e12 wei of
 * WETH is ~0.000001 ETH — far below any action threshold.
 */
const DEBT_DUST_WEI = 10n ** 12n;

export interface HedgeOptions {
  /**
   * Percent of the ETH-side exposure to short when the bot parks. 100 makes
   * the parked book fully delta-neutral; lower keeps some long exposure.
   */
  ratioPct: number;
  /**
   * Hard cap on borrowed value vs collateral value, in percent. This is a
   * SAFETY cap well below Aave's own liquidation LTV: at the default 40, an
   * oracle dislocation still leaves a health factor above 2. The borrow is
   * min(ratio target, this capacity).
   */
  maxLtvPct: number;
  /** Skip the whole hedge when the notional is below this; gas is not worth it. */
  minActionUsd: number;
  /**
   * Unwind the hedge when Aave's health factor falls to this.
   *
   * Liquidation happens at 1.0. The regime filter keeps the bot parked
   * precisely while a large move is running, and a short loses as ETH rises,
   * so "parked" and "approaching liquidation" are correlated states rather
   * than independent ones. Nothing else closes the hedge until the market
   * calms, so without this check a sustained rally can run it into
   * liquidation while the bot sits and watches.
   */
  minHealthFactor: number;
  /** Plan and log without broadcasting. */
  dryRun: boolean;
}

/**
 * Short hedge for the regime filter's park, built from the same Aave position
 * that lends the idle capital.
 *
 * The filter's documented failure mode is directional: out-of-sample losses
 * track ETH (docs/LP_REBALANCE.md), and going to cash merely stops paying for
 * the move. While parked, this borrows WETH against the supplied collateral,
 * sells it for USDC, and so holds the parked book flat against ETH instead of
 * merely uninvested. Re-entry buys the WETH back and repays.
 *
 * Invariants:
 *  - The chain decides, not a flag. "Is the hedge open" is read from the
 *    variableDebtToken balance, so a crash mid-unwind recovers by simply
 *    running the next cycle.
 *  - Opening happens only while parked, after `parkIdle` supplied the
 *    collateral; closing happens BEFORE releaseAll/deploy, so a live LP is
 *    never funded from a wallet that also owes WETH.
 *  - Every leg is a plain single call (borrow / swap / repay); a failure in
 *    one leaves a state the next cycle can finish.
 */
export class AaveShortHedge {
  constructor(
    private readonly aave: AaveExecutor,
    private readonly client: BotClient,
    private readonly transactor: Transactor,
    private readonly config: LpRebalanceConfig,
    private readonly pool: PoolInfo,
    private readonly options: HedgeOptions,
    private readonly walletAddress: Address | null,
  ) {}

  private get wallet(): Address {
    return this.walletAddress ?? this.transactor.account.address;
  }

  /** True when the wallet carries non-dust variable WETH debt. */
  async isOpen(): Promise<boolean> {
    const debtRaw = await this.aave.debtBalanceRaw("WETH");
    return debtRaw > DEBT_DUST_WEI;
  }

  /**
   * Open the short: borrow WETH sized to the ETH exposure, sell it for USDC.
   *
   * Callers must have run `parkIdle` first — the borrow draws on collateral
   * that has to already be supplied. Returns true if a hedge stands after the
   * call (opened now or already open); false means nothing was worth hedging.
   */
  async open(ethPrice: number): Promise<boolean> {
    const balances = await this.aave.allBalances();
    // The exposure being hedged is everything ETH-denominated the bot held
    // when it parked: wallet plus what it just lent.
    const ethExposureEth = balances.ethWallet + balances.ethLent;
    let notionalEth = ethExposureEth * (this.options.ratioPct / 100);

    if (await this.isOpen()) {
      logger.info("Short hedge already open — not doubling", { ethExposureEth });
      return true;
    }

    const notionalUsd = notionalEth * ethPrice;
    if (notionalUsd < this.options.minActionUsd) {
      logger.info("Hedge skipped: notional below minimum", {
        ethExposureEth,
        notionalUsd: notionalUsd.toFixed(2),
        minActionUsd: this.options.minActionUsd,
      });
      return false;
    }

    // Safety cap: borrowed value must stay well inside the collateral. Only
    // SUPPLIED assets count as collateral — idle wallet balances do not.
    const collateralUsd = balances.usdcLent + balances.ethLent * ethPrice;
    const maxBorrowUsd = Math.max(collateralUsd * (this.options.maxLtvPct / 100), 0);
    let cappedByLtv = false;
    if (notionalUsd > maxBorrowUsd) {
      logger.warn("Hedge notional capped by max LTV", {
        wantedUsd: notionalUsd.toFixed(2),
        cappedUsd: maxBorrowUsd.toFixed(2),
        maxLtvPct: this.options.maxLtvPct,
      });
      notionalEth = maxBorrowUsd / ethPrice;
      cappedByLtv = maxBorrowUsd > 0;
    }
    if (notionalEth <= 0) {
      logger.warn("Hedge skipped: no supplied collateral to borrow against");
      return false;
    }

    logger.info("Opening short hedge", {
      ethExposureEth,
      borrowWeth: notionalEth.toFixed(8),
      notionalUsd: (notionalEth * ethPrice).toFixed(2),
      cappedByLtv,
      dryRun: this.options.dryRun,
    });

    if (this.options.dryRun) {
      logger.info("[DRY RUN] Would borrow WETH and sell it for USDC");
      return true;
    }

    // The supply that funds this borrow may have been confirmed by a node
    // this transport does not talk to. Simulating the borrow against a node
    // one block behind computes a health factor with ZERO collateral and
    // reverts — observed live immediately after a confirmed supply. Wait
    // until the collateral is readable before borrowing.
    await this.awaitCollateralVisible();

    // Borrow a raw amount and sell exactly that. Recomputing the raw figure
    // from the same float independently could ask the swap for more WETH than
    // the borrow actually delivered.
    const borrowedRaw = parseUnits(
      notionalEth.toFixed(this.pool.token0.decimals),
      this.pool.token0.decimals,
    );
    await this.aave.borrowRaw("WETH", borrowedRaw);
    // Sell everything just borrowed. The quote-based slippage floor protects
    // execution; there is no hard out-amount to preserve here.
    await this.swap(
      this.pool.token0.address,
      this.pool.token1.address,
      borrowedRaw,
      0n,
      "hedge-open-sell",
    );
    this.markHedged(true);
    return true;
  }

  /**
   * Close the short: buy back enough WETH to cover the debt and repay exactly.
   *
   * Must complete before deployment; callers let errors propagate so the
   * cycle retries rather than deploy long while still short.
   */
  async close(): Promise<boolean> {
    const debtRaw = await this.aave.debtBalanceRaw("WETH");
    if (debtRaw <= DEBT_DUST_WEI) return false;

    const debtEth = Number(formatUnits(debtRaw, this.pool.token0.decimals));
    const price = await this.currentPrice();

    logger.info("Closing short hedge", {
      debtWeth: debtEth.toFixed(8),
      debtUsd: (debtEth * price).toFixed(2),
      dryRun: this.options.dryRun,
    });

    if (this.options.dryRun) {
      logger.info("[DRY RUN] Would buy back the WETH and repay the debt");
      return true;
    }

    // Buy slightly MORE than the debt: interest accrues between here and the
    // repay, and repaying more than owed reverts. Any small surplus stays in
    // the wallet and rejoins the next deployment.
    const surplusFactor = 1.01;
    const usdcIn = BigInt(Math.ceil(debtEth * price * surplusFactor * 10 ** this.pool.token1.decimals));

    // The USDC this hedge raised when it opened does not stay in the wallet:
    // `parkIdle` runs on every hostile cycle and supplies the whole wallet
    // balance to Aave, proceeds included. Without this the buy-back swaps
    // USDC the wallet no longer holds, reverts, and — because close() errors
    // propagate to block deployment — the bot can never re-enter while the
    // debt sits open accruing interest.
    await this.ensureBuybackFunds(usdcIn);

    // Hard floor: never accept fewer WETH back than the debt itself.
    await this.swap(
      this.pool.token1.address,
      this.pool.token0.address,
      usdcIn,
      debtRaw,
      "hedge-close-buyback",
    );

    const remaining = await this.aave.debtBalanceRaw("WETH");
    await this.aave.repayExact("WETH", remaining > debtRaw ? debtRaw : remaining);
    this.markHedged(false);
    return true;
  }

  /**
   * Make sure the wallet holds `usdcNeeded` before the buy-back, withdrawing
   * the shortfall from Aave collateral.
   *
   * Withdrawing collateral while debt is open RAISES the LTV, so this is
   * deliberately the minimum needed rather than everything: the full
   * `releaseAll` only runs after the debt is repaid.
   */
  private async ensureBuybackFunds(usdcNeeded: bigint): Promise<void> {
    const raw = await this.aave.allBalancesRaw();
    if (raw.usdcWallet >= usdcNeeded) return;

    const shortfall = usdcNeeded - raw.usdcWallet;
    if (raw.usdcLent <= 0n) {
      throw new Error(
        `Hedge buy-back needs ${formatUnits(usdcNeeded, this.pool.token1.decimals)} USDC, ` +
          `wallet holds ${formatUnits(raw.usdcWallet, this.pool.token1.decimals)} and no USDC ` +
          `is supplied to withdraw. Repay the WETH debt manually before restarting.`,
      );
    }

    const toWithdraw = shortfall > raw.usdcLent ? raw.usdcLent : shortfall;
    logger.info("Withdrawing collateral to fund the hedge buy-back", {
      needed: formatUnits(usdcNeeded, this.pool.token1.decimals),
      inWallet: formatUnits(raw.usdcWallet, this.pool.token1.decimals),
      withdrawing: formatUnits(toWithdraw, this.pool.token1.decimals),
    });
    await this.aave.withdrawRaw("USDC", toWithdraw);

    // Withdrawing against open debt moves the health factor the wrong way.
    // Surface where it landed rather than discovering it at liquidation.
    const after = await this.aave.accountData();
    logger.info("Health factor after funding withdrawal", {
      healthFactor: Number.isFinite(after.healthFactor) ? after.healthFactor.toFixed(3) : "no debt",
      collateralUsd: after.collateralUsd.toFixed(2),
      debtUsd: after.debtUsd.toFixed(2),
    });
    if (after.healthFactor < 1.05) {
      logger.error("Health factor critical after funding the buy-back", {
        healthFactor: after.healthFactor.toFixed(3),
      });
    }
  }

  /**
   * Liquidation guard, run every cycle while the hedge is open.
   *
   * A short loses as ETH rises, and the regime filter keeps the bot parked
   * exactly while a large move runs — so "still parked" and "health factor
   * degrading" are the same market, not independent events. Nothing else
   * unwinds the hedge until the market calms, which may be never.
   *
   * Returns true if it unwound.
   */
  async checkHealth(): Promise<boolean> {
    if (!(await this.isOpen())) return false;

    const data = await this.aave.accountData();
    const healthy = data.healthFactor >= this.options.minHealthFactor;

    logger.info("Hedge health", {
      healthFactor: Number.isFinite(data.healthFactor) ? data.healthFactor.toFixed(3) : "no debt",
      minHealthFactor: this.options.minHealthFactor,
      collateralUsd: data.collateralUsd.toFixed(2),
      debtUsd: data.debtUsd.toFixed(2),
      liquidationThresholdPct: data.liquidationThresholdPct,
      verdict: healthy ? "OK" : "UNWIND",
    });

    if (healthy) return false;

    logger.warn("Health factor below floor — unwinding the hedge early", {
      healthFactor: data.healthFactor.toFixed(3),
      minHealthFactor: this.options.minHealthFactor,
    });
    if (this.options.dryRun) {
      logger.info("[DRY RUN] Would unwind the hedge on health");
      return true;
    }
    await this.close();
    return true;
  }

  /** Exact-input swap through SwapRouter02 with a quote-based minimum output. */
  private async swap(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    hardMinOut: bigint,
    label: string,
  ): Promise<void> {
    const quotedOut = await quoteExactInputSingle(
      this.client,
      this.config.quoterAddress,
      tokenIn,
      tokenOut,
      this.pool.fee,
      amountIn,
    );
    const slippageFloor = applySlippageBps(quotedOut, this.config.slippageBps);
    const amountOutMinimum = slippageFloor > hardMinOut ? slippageFloor : hardMinOut;

    logger.info("Hedge swap", {
      label,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      quotedOut: quotedOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      slippageBps: this.config.slippageBps,
    });

    await this.ensureApproval(tokenIn, this.config.swapRouterAddress, amountIn);
    const data = encodeExactInputSingle({
      tokenIn,
      tokenOut,
      fee: this.pool.fee,
      recipient: this.wallet,
      amountIn,
      amountOutMinimum,
    });
    await this.transactor.send(this.client, label, this.config.swapRouterAddress, data);
  }

  private async currentPrice(): Promise<number> {
    const state = await getPoolState(this.client, this.pool.address);
    return sqrtRatioToPrice(state.sqrtPriceX96, this.pool.token0.decimals, this.pool.token1.decimals);
  }

  /**
   * Block until some supplied balance is visible to reads.
   *
   * The transport fails over across RPC endpoints, so the node that confirms
   * the supply receipt is not necessarily the node that answers the next
   * call. A borrow simulated against a stale node reverts with no error
   * message worth acting on, so the wait lives here rather than letting the
   * revert happen on-chain.
   */
  private async awaitCollateralVisible(attempts = 10): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const balances = await this.aave.allBalances();
      if (balances.usdcLent > 0 || balances.ethLent > 0) {
        if (i > 0) logger.debug("Hedge: collateral visible after retry", { attempt: i + 1 });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Supplied collateral did not become visible after ${attempts}s; ` +
        `the RPC endpoints may be out of sync. Nothing was lost — the hedge is retried next cycle.`,
    );
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
    await this.transactor.send(this.client, "approve", token, data);
  }

  private markHedged(hedged: boolean): void {
    try {
      saveHedgedFlag(this.config.stateFile, hedged);
    } catch (error) {
      // Observability only; the chain decides whether a hedge exists.
      logger.warn("Could not persist hedge flag", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
