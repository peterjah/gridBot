import type { AaveExecutor } from "../lending/aaveExecutor.js";
import { logger } from "../utils/logger.js";

/**
 * Aave lending for the LP bot's idle capital.
 *
 * The regime filter spends most of its time standing aside — 55-69% at the
 * thresholds that help (docs/LP_REBALANCE.md). Cash sitting in the wallet
 * during those stretches earns nothing, which is the single largest cost of
 * running the filter. Supplying it to Aave while parked recovers part of that.
 *
 * The invariant that matters: **lent assets must always be available for LP**.
 * Everything is withdrawn before the bot deploys, and it deploys only after the
 * withdrawal has confirmed. A position is never funded from a partial balance.
 *
 * Supply and withdraw are separate transactions. Aave's Pool has no batch
 * entry point, and SwapRouter02's `multicall` delegatecalls into itself so it
 * cannot reach an external contract — atomically combining an Aave withdrawal
 * with a Uniswap action needs a smart account (EIP-7702). At Base gas prices
 * (~$0.006 per transaction observed live) the separate legs are not worth that
 * complexity.
 */
export interface LpLendingOptions {
  /** Skip amounts below this, so gas is never spent moving dust. */
  minActionUsd: number;
  /** Plan and log without broadcasting. */
  dryRun: boolean;
}

export class LpLendingManager {
  constructor(
    private readonly aave: AaveExecutor,
    private readonly options: LpLendingOptions,
  ) {}

  /**
   * Withdraw everything supplied, so the whole balance is available to deploy.
   *
   * Returns true if anything was withdrawn. Callers must await this BEFORE
   * reading wallet balances to size a position: otherwise the position is
   * funded from the un-lent remainder and the rest stays idle in Aave.
   */
  async releaseAll(ethPrice: number): Promise<boolean> {
    const balances = await this.aave.allBalances();
    const usdcLent = balances.usdcLent;
    const ethLent = balances.ethLent;

    if (usdcLent <= 0 && ethLent <= 0) return false;

    logger.info("Withdrawing from Aave before deploying", {
      usdcLent: usdcLent.toFixed(6),
      ethLent: ethLent.toFixed(8),
      ethPriceUsd: ethPrice.toFixed(2),
    });

    if (this.options.dryRun) {
      logger.info("[DRY RUN] Would withdraw everything from Aave");
      return true;
    }

    // No minimum here: a leftover balance would silently shrink the position.
    // Withdrawing dust costs a few cents; under-deploying costs yield. Max
    // withdraw because a computed amount can round one unit above the actual
    // balance and revert — exactly when the bot needs to deploy.
    if (usdcLent > 0) await this.aave.withdrawMax("USDC");
    if (ethLent > 0) await this.aave.withdrawMax("WETH");
    return true;
  }

  /**
   * Supply idle wallet balances while the bot is standing aside.
   *
   * Called only when nothing is deployed as liquidity, so there is no buffer
   * to preserve: the next deployment withdraws everything first anyway. Native
   * ETH for gas is untouched — Aave holds WETH, which is a separate balance.
   */
  async parkIdle(ethPrice: number): Promise<boolean> {
    const raw = await this.aave.allBalancesRaw();
    const balances = await this.aave.allBalances();
    const usdcWallet = balances.usdcWallet;
    const ethWallet = balances.ethWallet;
    const ethWalletUsd = ethWallet * ethPrice;

    const supplyUsdc = usdcWallet >= this.options.minActionUsd;
    const supplyEth = ethWalletUsd >= this.options.minActionUsd;

    if (!supplyUsdc && !supplyEth) {
      logger.debug("Nothing worth supplying to Aave", {
        usdcWallet: usdcWallet.toFixed(6),
        ethWalletUsd: ethWalletUsd.toFixed(2),
        minActionUsd: this.options.minActionUsd,
      });
      return false;
    }

    logger.info("Supplying idle balance to Aave while standing aside", {
      usdc: supplyUsdc ? usdcWallet.toFixed(6) : "0 (below minimum)",
      weth: supplyEth ? ethWallet.toFixed(8) : "0 (below minimum)",
      minActionUsd: this.options.minActionUsd,
    });

    if (this.options.dryRun) {
      logger.info("[DRY RUN] Would supply idle balance to Aave");
      return true;
    }

    // Supply the exact wallet balance in raw units. The human-number form
    // rounds up above 2^53 and asks for more than the wallet holds.
    if (supplyUsdc) await this.aave.supplyRaw("USDC", raw.usdcWallet);
    if (supplyEth) await this.aave.supplyRaw("WETH", raw.ethWallet);
    return true;
  }

  /** Current lent balances, for reporting. */
  async lentValueUsd(ethPrice: number): Promise<number> {
    const balances = await this.aave.allBalances();
    return balances.usdcLent + balances.ethLent * ethPrice;
  }
}
