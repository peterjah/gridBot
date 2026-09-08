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
    const raw = await this.aave.allBalancesRaw();
    if (raw.usdcLent <= 0n && raw.ethLent <= 0n) return false;

    logger.info("Withdrawing from Aave before deploying", {
      usdcLent: raw.usdcLent.toString(),
      ethLent: raw.ethLent.toString(),
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
    if (raw.usdcLent > 0n) await this.aave.withdrawMax("USDC");
    if (raw.ethLent > 0n) await this.aave.withdrawMax("WETH");

    // Do not return until the withdrawn tokens are readable. The caller sizes
    // the new position from the wallet immediately afterwards, and a confirmed
    // receipt does not mean the next read sees the transfer. Observed live: a
    // WETH withdrawal confirmed at block 51017224, the plan read 0 WETH two
    // seconds later, and 0.0445 WETH was left out of the position entirely.
    await this.awaitWithdrawn(raw.usdcWallet + raw.usdcLent, raw.ethWallet + raw.ethLent);
    return true;
  }

  /**
   * Block until the wallet shows the withdrawn balances.
   *
   * Proceeds with whatever is visible after the timeout rather than throwing:
   * a partial view costs a smaller position, refusing to proceed leaves the
   * capital undeployed entirely.
   */
  private async awaitWithdrawn(
    expectedUsdc: bigint,
    expectedEth: bigint,
    attempts = 10,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const now = await this.aave.allBalancesRaw();
      if (now.usdcWallet >= expectedUsdc && now.ethWallet >= expectedEth) {
        if (i > 0) logger.debug("Withdrawn balances visible after retry", { attempt: i + 1 });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const now = await this.aave.allBalancesRaw();
    logger.warn("Withdrawn balances still not fully visible; deploying what is readable", {
      expectedUsdc: expectedUsdc.toString(),
      actualUsdc: now.usdcWallet.toString(),
      expectedEth: expectedEth.toString(),
      actualEth: now.ethWallet.toString(),
    });
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

  /**
   * Everything not deployed as liquidity: wallet balances plus anything
   * supplied to Aave, valued in USD.
   *
   * Both matter for the redeploy check — `parkIdle` may have banked a deposit
   * while the bot stood aside, and `releaseAll` only withdraws at the moment
   * it deploys.
   */
  async idleValueUsd(ethPrice: number): Promise<number> {
    const b = await this.aave.allBalances();
    return (
      b.usdcWallet + b.usdcLent + (b.ethWallet + b.ethLent) * ethPrice
    );
  }

  /** Current lent balances, for reporting. */
  async lentValueUsd(ethPrice: number): Promise<number> {
    const balances = await this.aave.allBalances();
    return balances.usdcLent + balances.ethLent * ethPrice;
  }
}
