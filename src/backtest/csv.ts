import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BacktestResult } from "./backtester.js";
import type { ResetRecord } from "../grid/types.js";
import type { ConfigMetrics } from "./optimizer.js";
import type { ScenarioResult } from "./scenario.js";

/** Write `rows` (already stringified) with `headers` to `path`. */
function writeCsv(path: string, headers: string[], rows: (string | number)[][]): string {
  const body = rows.map((r) => r.map(cell).join(",")).join("\n");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${headers.join(",")}\n${body}${body ? "\n" : ""}`);
  return path;
}

function cell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/**
 * Full trade ledger (spec section 18). Every row carries the balances and
 * the P&L split at that fill, so a backtest result can be audited line by
 * line outside the bot.
 */
export function writeTradeLedger(result: BacktestResult, path: string): string {
  const trades = result.strategy.getState().trades;
  const headers = [
    "seq",
    "timestamp",
    "datetime",
    "action",
    "price",
    "grid_level",
    "eth_amount",
    "usdc_amount",
    "fee",
    "slippage",
    "gas",
    "eth_balance",
    "usdc_balance",
    "portfolio_value",
    "realized_grid_pnl",
    "realized_reset_pnl",
    "cost_basis_consumed",
    "interval_id",
    "reset_id",
  ];
  const rows = trades.map((t) => [
    t.seq,
    t.timestamp,
    iso(t.timestamp),
    t.liquidation ? "LIQUIDATE" : t.side,
    t.fillPrice,
    t.levelIndex ?? "",
    t.ethAmount,
    t.usdAmount,
    t.feeUsd,
    t.slippageUsd,
    t.gasUsd,
    t.ethBalanceAfter,
    t.usdcBalanceAfter,
    t.portfolioValueAfter,
    t.realizedGridGrossUsd ?? 0,
    t.realizedResetGrossUsd ?? 0,
    t.costBasisConsumedUsd ?? 0,
    t.intervalId,
    t.resetId ?? "",
  ]);
  return writeCsv(path, headers, rows);
}

/** Per-reset detail, for offline analysis of the reset mechanism's cost. */
export function writeResetCsv(resets: ResetRecord[], path: string): string {
  const headers = [
    "reset_id",
    "timestamp",
    "datetime",
    "reason",
    "price",
    "old_center",
    "new_center",
    "old_lower",
    "old_upper",
    "new_lower",
    "new_upper",
    "eth_inventory_before",
    "usdc_before",
    "eth_avg_cost_price",
    "eth_cost_basis",
    "eth_liquidated",
    "eth_carried",
    "carry_reason",
    "usdc_recovered",
    "reset_pnl",
    "grid_gross_since_prev",
    "grid_net_since_prev",
    "fees_since_prev",
    "slippage_since_prev",
    "gas_since_prev",
    "portfolio_before",
    "portfolio_after",
    "drawdown_before_pct",
    "rebuilt_at",
  ];
  const rows = resets.map((r) => [
    r.id,
    r.timestamp,
    iso(r.timestamp),
    r.reason,
    r.price,
    r.oldBounds.center,
    r.newBounds?.center ?? "",
    r.oldBounds.lower,
    r.oldBounds.upper,
    r.newBounds?.lower ?? "",
    r.newBounds?.upper ?? "",
    r.ethInventoryBefore,
    r.usdcBefore,
    r.ethAvgCostPrice,
    r.ethCostBasisUsd,
    r.ethLiquidated,
    r.ethCarried,
    r.carryReason ?? "",
    r.usdcRecovered,
    r.realizedResetPnlUsd,
    r.gridGrossSincePrevUsd,
    r.gridNetSincePrevUsd,
    r.feesSincePrevUsd,
    r.slippageSincePrevUsd,
    r.gasSincePrevUsd,
    r.portfolioValueBefore,
    r.portfolioValueAfter,
    r.drawdownBeforePct,
    r.rebuiltAt ?? "",
  ]);
  return writeCsv(path, headers, rows);
}

/** Equity/inventory curve, for plotting outside the bot. */
export function writeEquityCsv(result: BacktestResult, path: string): string {
  const headers = [
    "timestamp",
    "datetime",
    "price",
    "portfolio_value",
    "usdc",
    "eth",
    "cost_basis",
    "eth_exposure_pct",
  ];
  const rows = result.samples.map((s) => [
    s.timestamp,
    iso(s.timestamp),
    s.price,
    s.portfolioValue,
    s.usdc,
    s.eth,
    s.costBasisUsd,
    s.ethExposurePct,
  ]);
  return writeCsv(path, headers, rows);
}

/**
 * Optimization sweep results (spec section 17). Columns follow the spec, with
 * the benchmark comparison appended so a configuration's return can always be
 * judged against simply holding USDC or ETH.
 */
export function writeOptimizationCsv(metrics: ConfigMetrics[], path: string): string {
  const headers = [
    "spacing",
    "grid_width",
    "levels",
    "reset_buffer",
    "order_size_pct",
    "order_size",
    "max_vol_per_step",
    "inventory_cap_pct",
    "cooldown_hours",
    "reset_sell_fraction",
    "underwater_skip_pct",
    "final_value",
    "return",
    "max_drawdown",
    "grid_pnl",
    "reset_pnl",
    "unrealized_pnl",
    "lp_fee_income",
    "fees",
    "slippage",
    "gas",
    "trades",
    "cycles",
    "resets",
    "avg_reset_loss",
    "max_reset_loss",
    "risk_adjusted",
    "max_eth_exposure_pct",
    "avg_eth_exposure_pct",
    "usdc_return",
    "eth_return",
    "lp_return",
    "vs_usdc",
    "vs_eth",
  ];
  const rows = metrics.map((m) => [
    m.candidate.spacingPercent,
    m.candidate.widthPercent,
    m.candidate.levelsBelow,
    m.candidate.resetBufferLevels,
    m.candidate.orderSizePercent,
    m.candidate.orderSizeUsd,
    m.candidate.maxVolPerStep ?? "",
    m.candidate.inventoryCapPercent ?? "",
    m.candidate.cooldownHours ?? "",
    m.candidate.resetSellFraction ?? "",
    m.candidate.underwaterSkipPct ?? "",
    m.finalPortfolioValue,
    m.returnPercent,
    m.maxDrawdownPct,
    m.totalGridPnL,
    m.totalResetPnL,
    m.unrealizedPnL,
    m.totalFeeIncome,
    m.totalFees,
    m.totalSlippage,
    m.totalGas,
    m.numberOfTrades,
    m.completedCycles,
    m.numberOfResets,
    m.averageResetLoss,
    m.maxResetLoss,
    m.riskAdjustedScore,
    m.maxEthExposurePct,
    m.avgEthExposurePct,
    m.benchmarks.usdcReturnPct,
    m.benchmarks.ethReturnPct,
    m.benchmarks.lpReturnPct,
    m.benchmarks.vsUsdcPct,
    m.benchmarks.vsEthPct,
  ]);
  return writeCsv(path, headers, rows);
}

/**
 * Scenario sweep results: one row per configuration, aggregated across every
 * matching window, plus the per-window returns so the spread can be inspected.
 */
export function writeScenarioCsv(results: ScenarioResult[], path: string): string {
  const windowNames = results[0]?.perWindow.map((w) => w.window.name) ?? [];
  const headers = [
    "spacing",
    "grid_width",
    "reset_buffer",
    "order_size_pct",
    "max_vol_per_step",
    "reset_sell_fraction",
    "windows",
    "median_return",
    "mean_return",
    "worst_return",
    "best_return",
    "median_max_drawdown",
    "win_rate",
    "beat_eth_rate",
    "median_vs_eth",
    "median_grid_pnl",
    "median_reset_pnl",
    "median_trades",
    ...windowNames.map((n) => `ret_${n}`),
  ];
  const rows = results.map((r) => [
    r.candidate.spacingPercent,
    r.candidate.widthPercent,
    r.candidate.resetBufferLevels,
    r.candidate.orderSizePercent,
    r.candidate.maxVolPerStep ?? "",
    r.candidate.resetSellFraction ?? "",
    r.perWindow.length,
    r.medianReturnPct,
    r.meanReturnPct,
    r.minReturnPct,
    r.maxReturnPct,
    r.medianMaxDrawdownPct,
    r.winRate,
    r.beatEthRate,
    r.medianVsEthPct,
    r.medianGridPnL,
    r.medianResetPnL,
    r.medianTrades,
    ...r.perWindow.map((w) => w.metrics.returnPercent),
  ]);
  return writeCsv(path, headers, rows);
}

export { writeCsv };
