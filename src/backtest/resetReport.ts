import type { BacktestResult } from "./backtester.js";
import type { ResetRecord } from "../grid/types.js";
import { RULE, THIN, date, eth, mean, median, price, pct, signedUsd, usd } from "./format.js";

/**
 * Reset analytics (spec sections 1-7).
 *
 * The whole point of these reports is to keep the three P&L sources apart:
 *   A. grid trading P&L   — completed buy -> sell cycles
 *   B. inventory P&L      — ETH dumped at a reset, vs its cost basis
 *   C. trading costs      — fees, slippage, gas
 * A "profitable" grid that funds its profits by quietly accumulating ETH and
 * then eating a large B at every reset is exactly what this exposes.
 */

/** One reset block, as printed after every reset. */
export function formatReset(r: ResetRecord): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  const netReset = r.gridNetSincePrevUsd + r.realizedResetPnlUsd;

  line("========================================");
  line(`RESET #${r.id}`);
  line("========================================");
  line();
  line(`Time:                  ${date(r.timestamp)}`);
  line(`Reason:                ${r.reason}`);
  line();
  line(`ETH price:             ${price(r.price)}`);
  line(`Old grid center:       ${price(r.oldBounds.center)}`);
  line(
    `New grid center:       ${r.newBounds ? price(r.newBounds.center) : "— (still in cooldown)"}`,
  );
  line(
    `Old grid band:         ${price(r.oldBounds.lower)} → ${price(r.oldBounds.upper)}`,
  );
  if (r.newBounds) {
    line(`New grid band:         ${price(r.newBounds.lower)} → ${price(r.newBounds.upper)}`);
    line(`Rebuilt at:            ${date(r.rebuiltAt!)}`);
  }
  line();
  line(`ETH inventory:         ${eth(r.ethInventoryBefore)}`);
  if (r.ethCarried > 0) {
    line(`  ... liquidated:      ${eth(r.ethLiquidated)}`);
    line(`  ... carried forward: ${eth(r.ethCarried)}  (${r.carryReason})`);
  }
  line(`ETH cost basis:        ${price(r.ethAvgCostPrice)} (${usd(r.ethCostBasisUsd)} total)`);
  line(`ETH liquidation price: ${price(r.price)}`);
  line(`USDC before:           ${usd(r.usdcBefore)}`);
  line(`USDC recovered:        ${usd(r.usdcRecovered)}`);
  line();
  line("----------------------------------------");
  line("SINCE PREVIOUS RESET");
  line("----------------------------------------");
  line();
  if (r.feeIncomeSincePrevUsd > 0) {
    line(`LP fee income:         ${signedUsd(r.feeIncomeSincePrevUsd)}`);
  }
  line(`Grid gross P&L:        ${signedUsd(r.gridGrossSincePrevUsd)}`);
  line(`Grid net P&L:          ${signedUsd(r.gridNetSincePrevUsd)}`);
  line();
  line(`Reset inventory P&L:   ${signedUsd(r.realizedResetPnlUsd)}`);
  line();
  line(`Swap fees:             ${signedUsd(-r.feesSincePrevUsd)}`);
  line(`Slippage:              ${signedUsd(-r.slippageSincePrevUsd)}`);
  line(`Gas:                   ${signedUsd(-r.gasSincePrevUsd)}`);
  line();
  line("----------------------------------------");
  line("RESET RESULT");
  line("----------------------------------------");
  line();
  line(`Reset P&L:             ${signedUsd(netReset)}`);
  line(`Portfolio before:      ${usd(r.portfolioValueBefore)}`);
  line(`Portfolio after:       ${usd(r.portfolioValueAfter)}`);
  line(`Drawdown at reset:     ${pct(r.drawdownBeforePct)}`);
  line("========================================");

  return lines.join("\n");
}

/** Every reset block, in order. */
export function formatAllResets(resets: ResetRecord[]): string {
  if (resets.length === 0) return "No resets occurred.";
  return resets.map(formatReset).join("\n\n");
}

/** End-of-backtest RESET ANALYSIS summary (spec section 4). */
export function formatResetSummary(result: BacktestResult): string {
  const resets = result.resets;
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line("RESET ANALYSIS");
  line(RULE);
  line();
  line(`Total resets:                 ${resets.length}`);

  if (resets.length > 0) {
    const pnls = resets.map((r) => r.realizedResetPnlUsd);
    // "Loss" figures are reported on the inventory P&L only: this is the
    // cost of the risk-management mechanism, separate from grid earnings.
    // Resets that fire with an empty book realize nothing and would otherwise
    // flatter the loss statistics, so they are counted separately.
    const withInventory = resets.filter((r) => r.ethInventoryBefore > 0);
    const losses = pnls.filter((p) => p < 0);
    const gains = pnls.filter((p) => p > 0);
    line(`Resets with inventory:        ${withInventory.length}`);
    line(`Resets with an empty book:    ${resets.length - withInventory.length}`);
    line(`  ... of which losses:        ${losses.length}`);
    line(`  ... of which gains:         ${gains.length}`);
    line();
    line(`Average reset P&L:            ${signedUsd(mean(pnls))}  (all resets)`);
    line(`Median reset P&L:             ${signedUsd(median(pnls))}  (all resets)`);
    if (losses.length > 0) {
      line(`Average reset loss:           ${signedUsd(mean(losses))}`);
      line(`Median reset loss:            ${signedUsd(median(losses))}`);
      line(`Largest reset loss:           ${signedUsd(Math.min(...losses))}`);
      line(`Smallest reset loss:          ${signedUsd(Math.max(...losses))}`);
    } else {
      line(`Reset losses:                 none`);
    }
    line();
    const rebuilt = resets.filter((r) => r.rebuiltAt !== null);
    if (rebuilt.length > 0) {
      const cooldowns = rebuilt.map((r) => (r.rebuiltAt! - r.timestamp) / 3600);
      line(`Average cooldown:             ${mean(cooldowns).toFixed(1)} h`);
    }
    const pending = resets.length - rebuilt.length;
    if (pending > 0) line(`Never rebuilt (final state):  ${pending}`);
    line();
  }

  line(`Total reset P&L:              ${signedUsd(result.resetPnlUsd)}`);
  line(`Total grid P&L:               ${signedUsd(result.gridPnlUsd)}`);
  if (result.feeIncomeUsd > 0) {
    line(`Total LP fee income:          ${signedUsd(result.feeIncomeUsd)}`);
  }
  line(`Unrealized P&L (open):        ${signedUsd(result.unrealizedPnlUsd)}`);
  line();
  line(`Total fees:                   ${signedUsd(-result.totalFeeUsd)}`);
  line(`Total slippage:               ${signedUsd(-result.totalSlippageUsd)}`);
  line(`Total gas:                    ${signedUsd(-result.totalGasUsd)}`);
  line();
  line("-".repeat(40));
  line();
  const costs = result.totalFeeUsd + result.totalSlippageUsd + result.totalGasUsd;
  line(`Grid P&L before resets:       ${signedUsd(result.gridPnlUsd)}`);
  line(`Reset P&L:                    ${signedUsd(result.resetPnlUsd)}`);
  line(`Unrealized P&L:               ${signedUsd(result.unrealizedPnlUsd)}`);
  if (result.feeIncomeUsd > 0) {
    line(`LP fee income:                ${signedUsd(result.feeIncomeUsd)}`);
  }
  line(`Trading costs:                ${signedUsd(-costs)}`);
  line(`${"".padEnd(30)}${"-".repeat(12)}`);
  line(`Net profit:                   ${signedUsd(result.netProfitUsd)}`);
  line();
  line(`Final portfolio value:        ${usd(result.finalPortfolioValue)}`);
  line(`Accounting residual:          ${result.breakdown.residual.toExponential(2)} USD`);
  line(RULE);

  return lines.join("\n");
}

/** Inventory analytics (spec section 5). */
export function formatInventoryReport(result: BacktestResult): string {
  const inv = result.inventory;
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line("INVENTORY ANALYSIS");
  line(RULE);
  line();
  line(`Max ETH inventory:            ${eth(inv.maxEth)}`);
  line(`Average ETH inventory:        ${eth(inv.avgEth)}`);
  line();
  line(`Max ETH exposure:             ${inv.maxEthExposurePct.toFixed(2)}% of portfolio`);
  line(`Average ETH exposure:         ${inv.avgEthExposurePct.toFixed(2)}% of portfolio`);
  line();
  line(`Max USDC balance:             ${usd(inv.maxUsdcUsd)}`);
  line(`Average USDC balance:         ${usd(inv.avgUsdcUsd)}`);
  line();
  line();
  line(`Avg capital deployed:         ${inv.avgDeployedPct.toFixed(1)}% of portfolio` +
    ` (range ${inv.minDeployedPct.toFixed(1)}%–${inv.maxDeployedPct.toFixed(1)}%)`);
  line(`Avg capital idle:             ${inv.avgIdlePct.toFixed(1)}% (${usd(inv.avgIdleUsd)})`);
  line();
  line(`Max inventory cost basis:     ${usd(inv.maxCostBasisUsd)} (at ${date(inv.maxCostBasisAt)})`);
  line(`Avg inventory cost basis:     ${usd(inv.avgCostBasisUsd)}`);
  line(RULE);

  return lines.join("\n");
}

/** Grid center evolution (spec section 7). */
export function formatCenterHistory(result: BacktestResult): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  const state = result.strategy.getState();
  const history = state.centerHistory;

  line(RULE);
  line("GRID CENTER EVOLUTION");
  line(RULE);
  line();

  if (history.length === 0) {
    line(`${price(result.strategy.config.centerPrice)}   (never re-centered)`);
    line(RULE);
    return lines.join("\n");
  }

  const first = history[0]!;
  line(
    `${"start".padEnd(12)}${price(first.oldCenter).padEnd(14)}` +
      `band ${price(first.oldLowerBound)} → ${price(first.oldUpperBound)}`,
  );
  for (const change of history) {
    const drift = ((change.newCenter - change.oldCenter) / change.oldCenter) * 100;
    line(
      `${`#${change.resetId}`.padEnd(12)}${price(change.newCenter).padEnd(14)}` +
        `band ${price(change.newLowerBound)} → ${price(change.newUpperBound)}` +
        `   ${pct(drift, 1)}   ${date(change.timestamp)}`,
    );
  }
  line();
  const totalDrift =
    ((history[history.length - 1]!.newCenter - first.oldCenter) / first.oldCenter) * 100;
  line(`Total center drift:  ${pct(totalDrift, 1)} over ${history.length} re-centerings`);
  line(RULE);

  return lines.join("\n");
}
