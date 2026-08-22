import type { GridStrategy } from "../grid/gridStrategy.js";
import type { PricePoint } from "../data/provider.js";
import type { ResetRecord, TradeRecord } from "../grid/types.js";

export interface EquitySample {
  timestamp: number;
  price: number;
  portfolioValue: number;
  usdc: number;
  eth: number;
  /** Cost basis of the ETH held at this sample (USD, level prices). */
  costBasisUsd: number;
  /** ETH value as a share of portfolio value, in percent. */
  ethExposurePct: number;
}

/** Inventory statistics over the whole run (section 5 of the spec). */
export interface InventoryStats {
  maxEth: number;
  avgEth: number;
  avgEthExposurePct: number;
  maxEthExposurePct: number;
  maxUsdcUsd: number;
  avgUsdcUsd: number;
  /** Largest cost basis ever carried in open inventory. */
  maxCostBasisUsd: number;
  avgCostBasisUsd: number;
  /** Price and time at which the largest cost basis was carried. */
  maxCostBasisAt: number;
}

/**
 * Decomposition of the final portfolio value. These six components are
 * mathematically distinct and must sum back to the portfolio value:
 *
 *   portfolio = initialCapital + gridPnl + resetPnl + unrealizedPnl
 *               + lpFeeIncome - fees - slippage - gas
 */
export interface PnlBreakdown {
  initialCapital: number;
  gridPnlUsd: number;
  resetPnlUsd: number;
  unrealizedPnlUsd: number;
  feeIncomeUsd: number;
  feesUsd: number;
  slippageUsd: number;
  gasUsd: number;
  /** Reconstructed portfolio value; equals `finalPortfolioValue` to 1e-6. */
  reconstructed: number;
  /** reconstructed - actual. Non-zero means the accounting is broken. */
  residual: number;
}

export interface BacktestResult {
  strategy: GridStrategy;
  samples: EquitySample[];
  /** Gas deducted per executed trade (USD). */
  gasPerTradeUsd: number;
  totalGasUsd: number;
  start: PricePoint;
  end: PricePoint;
  buysExecuted: number;
  sellsExecuted: number;
  completedCycles: number;
  /** Grid + reset realized gross. Prefer the two components below. */
  realizedGrossUsd: number;
  /** A. Profit from completed grid buy -> sell cycles. */
  gridPnlUsd: number;
  /** B. Profit/loss realized on inventory liquidated during resets. */
  resetPnlUsd: number;
  /** Unrealized P&L on inventory still open at the end. */
  unrealizedPnlUsd: number;
  /** D. LP fee income earned while resting in range (0 unless modeled). */
  feeIncomeUsd: number;
  /** C. Trading costs, never folded into A, B or D. */
  totalFeeUsd: number;
  totalSlippageUsd: number;
  netProfitUsd: number;
  finalPortfolioValue: number;
  initialCapital: number;
  returnPct: number;
  maxDrawdownPct: number;
  avgEthExposure: number;
  inventory: InventoryStats;
  resets: ResetRecord[];
  breakdown: PnlBreakdown;
  skips: Record<string, number>;
}

/** Tolerance for the accounting reconciliation, in USD. */
export const RECONCILE_TOLERANCE_USD = 1e-6;

/**
 * Deterministic backtest engine: same data + config => same result.
 * No randomness, no async, no blockchain.
 */
export function runBacktest(
  strategy: GridStrategy,
  data: PricePoint[],
  estimatedGasUsd: number,
): BacktestResult {
  if (data.length < 2) throw new Error("Need at least 2 price points");

  const samples: EquitySample[] = [];
  let totalGasUsd = 0;

  const first = data[0]!;
  strategy.onPriceUpdate(first.price, first.timestamp, {
    volumeUsd: first.volumeUsd,
    feeAprPct: first.feeAprPct,
    poolTvlUsd: first.poolTvlUsd,
  });
  const initialCapital = strategy.initialCapital;
  samples.push(sample(strategy, first));

  const ledger = strategy.tradeLedger();
  const resets = strategy.resetLedger();
  let peak = samples[0]!.portfolioValue;
  let stampedResets = 0;

  for (let i = 1; i < data.length; i++) {
    const point = data[i]!;
    const tradesBefore = ledger.length;
    const actions = strategy.onPriceUpdate(point.price, point.timestamp, {
      volumeUsd: point.volumeUsd,
      feeAprPct: point.feeAprPct,
      poolTvlUsd: point.poolTvlUsd,
    });

    // Gas is charged per executed trade and deducted from USDC. The strategy
    // itself stays gas-agnostic (gas is environment-specific), so the fills
    // are stamped here — one gas charge per trade appended this step.
    const newTrades = ledger.length - tradesBefore;
    if (newTrades > 0) {
      const gas = newTrades * estimatedGasUsd;
      totalGasUsd += gas;
      for (let k = tradesBefore; k < ledger.length; k++) {
        const trade = ledger[k]!;
        trade.gasUsd = estimatedGasUsd;
        trade.usdcBalanceAfter -= estimatedGasUsd;
        trade.portfolioValueAfter -= estimatedGasUsd;
      }
      strategy.applyExternalDebit(gas);
    }
    void actions;

    // Stamp environment-owned fields on any reset opened this step, using the
    // equity peak established BEFORE this observation.
    while (stampedResets < resets.length) {
      const record = resets[stampedResets]!;
      record.drawdownBeforePct =
        peak > 0 ? Math.min(0, ((record.portfolioValueBefore - peak) / peak) * 100) : 0;
      stampedResets++;
    }

    const s = sample(strategy, point);
    samples.push(s);
    if (s.portfolioValue > peak) peak = s.portfolioValue;
  }

  finalizeResetRecords(resets, ledger);

  const state = strategy.getState();
  const lastPrice = data[data.length - 1]!.price;
  const finalPortfolioValue = strategy.getPortfolioValue(lastPrice);
  const unrealizedPnlUsd = strategy.unrealizedPnlUsd(lastPrice);

  let maxDrawdownPct = 0;
  let runningPeak = -Infinity;
  for (const s of samples) {
    if (s.portfolioValue > runningPeak) runningPeak = s.portfolioValue;
    if (runningPeak > 0) {
      const dd = ((s.portfolioValue - runningPeak) / runningPeak) * 100;
      if (dd < maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  const inventory = inventoryStats(samples);

  const skips: Record<string, number> = {};
  for (const s of state.skips) {
    const key = `${s.side.toLowerCase()}_${s.reason}`;
    skips[key] = (skips[key] ?? 0) + 1;
  }

  const reconstructed =
    initialCapital +
    state.realizedGridGrossUsd +
    state.realizedResetGrossUsd +
    unrealizedPnlUsd +
    state.feeIncomeUsd -
    state.totalFeeUsd -
    state.totalSlippageUsd -
    totalGasUsd;

  const breakdown: PnlBreakdown = {
    initialCapital,
    gridPnlUsd: state.realizedGridGrossUsd,
    resetPnlUsd: state.realizedResetGrossUsd,
    unrealizedPnlUsd,
    feeIncomeUsd: state.feeIncomeUsd,
    feesUsd: state.totalFeeUsd,
    slippageUsd: state.totalSlippageUsd,
    gasUsd: totalGasUsd,
    reconstructed,
    residual: reconstructed - finalPortfolioValue,
  };

  return {
    strategy,
    samples,
    gasPerTradeUsd: estimatedGasUsd,
    totalGasUsd,
    start: first,
    end: data[data.length - 1]!,
    buysExecuted: state.trades.filter((t) => t.side === "BUY").length,
    sellsExecuted: state.trades.filter((t) => t.side === "SELL").length,
    completedCycles: state.completedCycles,
    realizedGrossUsd: state.realizedGrossUsd,
    gridPnlUsd: state.realizedGridGrossUsd,
    resetPnlUsd: state.realizedResetGrossUsd,
    unrealizedPnlUsd,
    feeIncomeUsd: state.feeIncomeUsd,
    totalFeeUsd: state.totalFeeUsd,
    totalSlippageUsd: state.totalSlippageUsd,
    netProfitUsd: finalPortfolioValue - initialCapital,
    finalPortfolioValue,
    initialCapital,
    returnPct: initialCapital > 0 ? ((finalPortfolioValue - initialCapital) / initialCapital) * 100 : 0,
    maxDrawdownPct,
    avgEthExposure: inventory.avgEth,
    inventory,
    resets: state.resetRecords,
    breakdown,
    skips,
  };
}

/**
 * Throws when the six P&L components do not add back up to the portfolio
 * value. Called by the runners and by the tests: a silent accounting drift
 * would invalidate every optimization result downstream.
 */
export function assertAccountingReconciles(
  result: BacktestResult,
  tolerance = RECONCILE_TOLERANCE_USD,
): void {
  const { breakdown: b } = result;
  const scale = Math.max(1, Math.abs(result.finalPortfolioValue));
  if (Math.abs(b.residual) > tolerance * scale) {
    throw new Error(
      `Accounting reconciliation failed: residual ${b.residual.toExponential(3)} USD.\n` +
        `  initial ${b.initialCapital} + grid ${b.gridPnlUsd} + reset ${b.resetPnlUsd} ` +
        `+ unrealized ${b.unrealizedPnlUsd} + lpFees ${b.feeIncomeUsd} ` +
        `- fees ${b.feesUsd} - slippage ${b.slippageUsd} ` +
        `- gas ${b.gasUsd} = ${b.reconstructed}, but portfolio = ${result.finalPortfolioValue}`,
    );
  }
}

/**
 * Fill in the "since previous reset" aggregates by grouping the trade ledger
 * on `intervalId`. Deriving them from the ledger (rather than accumulating
 * them inside the strategy) keeps a single source of truth: if the ledger and
 * the summary ever disagree, the ledger is right.
 */
function finalizeResetRecords(resets: ResetRecord[], ledger: TradeRecord[]): void {
  const byInterval = new Map<number, TradeRecord[]>();
  for (const t of ledger) {
    const bucket = byInterval.get(t.intervalId);
    if (bucket) bucket.push(t);
    else byInterval.set(t.intervalId, [t]);
  }

  for (const record of resets) {
    const trades = byInterval.get(record.id - 1) ?? [];
    const gridTrades = trades.filter((t) => !t.liquidation);
    const liquidations = trades.filter((t) => t.liquidation);

    const gridGross = sum(gridTrades, (t) => t.realizedGridGrossUsd ?? 0);
    const gridCosts = sum(gridTrades, (t) => t.feeUsd + t.slippageUsd + t.gasUsd);

    record.gridGrossSincePrevUsd = gridGross;
    record.gridNetSincePrevUsd = gridGross - gridCosts;
    // Interval costs include the liquidation's own fill costs.
    record.feesSincePrevUsd = sum(trades, (t) => t.feeUsd);
    record.slippageSincePrevUsd = sum(trades, (t) => t.slippageUsd);
    record.gasSincePrevUsd = sum(trades, (t) => t.gasUsd);
    // Fee income is not attached to fills (it accrues continuously), so it is
    // carried on the record by the caller rather than derived here.
    // portfolioValueAfter was captured before gas was stamped on the fill.
    record.portfolioValueAfter -= sum(liquidations, (t) => t.gasUsd);
  }
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

function inventoryStats(samples: EquitySample[]): InventoryStats {
  let maxEth = 0;
  let ethSum = 0;
  let expSum = 0;
  let maxExp = 0;
  let maxUsdc = 0;
  let usdcSum = 0;
  let maxCost = 0;
  let costSum = 0;
  let maxCostAt = samples[0]?.timestamp ?? 0;

  for (const s of samples) {
    if (s.eth > maxEth) maxEth = s.eth;
    ethSum += s.eth;
    expSum += s.ethExposurePct;
    if (s.ethExposurePct > maxExp) maxExp = s.ethExposurePct;
    if (s.usdc > maxUsdc) maxUsdc = s.usdc;
    usdcSum += s.usdc;
    costSum += s.costBasisUsd;
    if (s.costBasisUsd > maxCost) {
      maxCost = s.costBasisUsd;
      maxCostAt = s.timestamp;
    }
  }

  const n = Math.max(samples.length, 1);
  return {
    maxEth,
    avgEth: ethSum / n,
    avgEthExposurePct: expSum / n,
    maxEthExposurePct: maxExp,
    maxUsdcUsd: maxUsdc,
    avgUsdcUsd: usdcSum / n,
    maxCostBasisUsd: maxCost,
    avgCostBasisUsd: costSum / n,
    maxCostBasisAt: maxCostAt,
  };
}

function sample(strategy: GridStrategy, point: PricePoint): EquitySample {
  // Deliberately avoids getState(): it deep-copies the whole ledger, which
  // would make sampling O(n^2) over a long run and cripple the optimizer.
  const portfolioValue = strategy.getPortfolioValue(point.price);
  const eth = strategy.ethBalance;
  const ethValue = eth * point.price;
  return {
    timestamp: point.timestamp,
    price: point.price,
    portfolioValue,
    usdc: strategy.usdcBalance,
    eth,
    costBasisUsd: strategy.costBasisUsd(),
    ethExposurePct: portfolioValue > 0 ? (ethValue / portfolioValue) * 100 : 0,
  };
}
