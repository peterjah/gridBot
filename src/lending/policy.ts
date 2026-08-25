/**
 * Aave lending: pure policy for keeping idle liquidity productive.
 *
 * The grid keeps most capital in USDC between buys and some ETH between
 * sells. This policy decides when to supply the idle part to Aave and when
 * to withdraw it back, while always leaving a liquid buffer so the grid can
 * trade without a withdraw round-trip on every fill.
 *
 * PURE: no blockchain, no IO. The executor layer applies the actions.
 */

export interface LendingConfig {
  /** USDC kept liquid in the wallet (USD) — trading + gas buffer. */
  bufferUsdcUsd: number;
  /** ETH kept liquid in the wallet (ETH) — sell-side buffer. */
  bufferEth: number;
  /** Don't act on amounts smaller than this (USD) — avoids gas churn. */
  minActionUsd: number;
}

export type LendAsset = "USDC" | "WETH";

export interface LendAction {
  asset: LendAsset;
  kind: "supply" | "withdraw";
  /** Human units of the asset. */
  amount: number;
  /** Approximate USD value (for logging/thresholds). */
  amountUsd: number;
}

export interface PortfolioBalances {
  usdcWallet: number;
  usdcLent: number;
  ethWallet: number;
  ethLent: number;
}

/**
 * Decide lending actions for the current balances and price.
 *
 * Invariants:
 *  - never leaves the wallet with less than its buffer after supplying;
 *  - never supplies below minActionUsd (gas churn protection);
 *  - proposes withdrawals whenever the wallet is under buffer and lent
 *    funds exist.
 */
export function planLendingActions(
  cfg: LendingConfig,
  balances: PortfolioBalances,
  ethPrice: number,
): LendAction[] {
  const actions: LendAction[] = [];

  // --- USDC side -----------------------------------------------------------
  const surplus = balances.usdcWallet - cfg.bufferUsdcUsd;
  if (surplus >= cfg.minActionUsd) {
    actions.push({ asset: "USDC", kind: "supply", amount: surplus, amountUsd: surplus });
  } else if (
    balances.usdcWallet < cfg.bufferUsdcUsd &&
    balances.usdcLent > 0
  ) {
    const deficit = Math.min(cfg.bufferUsdcUsd - balances.usdcWallet, balances.usdcLent);
    if (deficit >= cfg.minActionUsd) {
      actions.push({
        asset: "USDC",
        kind: "withdraw",
        amount: deficit,
        amountUsd: deficit,
      });
    }
  }

  // --- WETH side -------------------------------------------------------------
  const ethSurplus = balances.ethWallet - cfg.bufferEth;
  const ethSurplusUsd = ethSurplus * ethPrice;
  if (ethSurplus >= 0 && ethSurplusUsd >= cfg.minActionUsd) {
    actions.push({
      asset: "WETH",
      kind: "supply",
      amount: ethSurplus,
      amountUsd: ethSurplusUsd,
    });
  } else if (
    balances.ethWallet < cfg.bufferEth &&
    balances.ethLent > 0 &&
    ethPrice > 0
  ) {
    const deficit = Math.min(cfg.bufferEth - balances.ethWallet, balances.ethLent);
    const deficitUsd = deficit * ethPrice;
    if (deficitUsd >= cfg.minActionUsd) {
      actions.push({ asset: "WETH", kind: "withdraw", amount: deficit, amountUsd: deficitUsd });
    }
  }

  return actions;
}

/**
 * How much to withdraw to cover a wallet shortfall before a grid fill.
 * Returns null when no withdrawal is needed (or nothing is lent).
 */
export function withdrawShortfall(
  walletBalance: number,
  lentBalance: number,
  needed: number,
): number | null {
  const shortfall = needed - walletBalance;
  if (shortfall <= 0 || lentBalance <= 0) return null;
  return Math.min(shortfall, lentBalance);
}
