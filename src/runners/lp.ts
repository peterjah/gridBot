import type { AppConfig } from "../config.js";
import { RULE, THIN, day, pct, signedUsd, usd } from "../backtest/format.js";
import { LinearCostFillModel } from "../grid/fillModel.js";
import { GridStrategy } from "../grid/gridStrategy.js";
import { assertAccountingReconciles, runBacktest } from "../backtest/backtester.js";
import { runPassiveLp } from "../lp/passiveLp.js";
import {
  DEFAULT_LP_AXES,
  formatLpReport,
  formatLpTable,
  rankLp,
  sweepLp,
} from "../lp/lpOptimizer.js";
import type { LpEvalInput } from "../lp/lpOptimizer.js";
import {
  formatLpFold,
  formatLpWalkForwardSummary,
  lpWalkForward,
  selectLpConsensus,
  describeLpParams,
} from "../lp/lpWalkForward.js";
import type { LpFoldResult } from "../lp/lpWalkForward.js";
import { annualize } from "../backtest/walkForward.js";
import { saveRun, runDir } from "../backtest/runStore.js";
import { writeCsv } from "../backtest/csv.js";
import { logger } from "../utils/logger.js";
import { loadPrices } from "./backtest.js";
import { captureProvenance } from "../backtest/provenance.js";

/**
 * Passive LP as a first-class strategy: sweep its parameters, then put the
 * winner head to head against the configured grid over the same data.
 *
 * The grid's revenue is mostly LP fees, so this is the comparison that decides
 * whether the trading machinery earns its keep.
 */
export async function runLpMode(cfg: AppConfig): Promise<void> {
  const prices = await loadPrices(cfg.csvFile, cfg.aprFile, cfg.minPoolTvlUsd);
  const hasFees = prices.some((p) => (p.feeAprPct ?? 0) > 0);

  const input: LpEvalInput = {
    prices,
    base: {
      initialUsdc: cfg.grid.initialUsdc,
      initialEth: cfg.grid.initialEth,
      feeBps: cfg.grid.feeBps,
      slippageBps: cfg.grid.slippageBps,
      referenceRangePct: cfg.grid.lpReferenceRangePct,
      regimeMaxMovePct: cfg.grid.regimeMaxMovePct,
      regimeLookbackPoints: cfg.grid.regimeLookbackPoints,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: cfg.hedgeBorrowAprPct,
      // Model the continuous hedge by default: the shipped live hedge only
      // covers the parked leg, and the exposure that loses money is the LP
      // position's own delta while deployed.
      hedgeWhileParkedOnly: false,
    },
    gas: cfg.gas,
  };

  console.log(RULE);
  console.log("PASSIVE LP OPTIMIZATION");
  console.log(RULE);
  console.log();
  console.log(`Data file:         ${cfg.csvFile}`);
  console.log(
    `Period:            ${day(prices[0]!.timestamp)} → ${day(prices[prices.length - 1]!.timestamp)} (${prices.length} observations)`,
  );
  console.log(`Initial capital:   ${usd(cfg.grid.initialUsdc + cfg.grid.initialEth * prices[0]!.price)}`);
  if (!hasFees) {
    console.log();
    console.log("WARNING: no fee APR series loaded (--apr-file). Passive LP earns");
    console.log("         nothing without one, so these results are IL only.");
  }
  console.log();

  const sweep = sweepLp(cfg.lpAxes ?? DEFAULT_LP_AXES, input);
  console.log(`Configurations tested: ${sweep.metrics.length} (${sweep.skipped} skipped)`);
  console.log();
  console.log(formatLpTable(sweep.metrics, cfg.optimizer.metric, cfg.optimizer.top));
  console.log();

  // ------------------------------------------------- out-of-sample validation
  //
  // The full-period sweep above is fitted on the data it reports. Nothing may
  // be deployed on that alone, so the same axes are re-run walk-forward and
  // the configuration is chosen by fold consensus rather than by the
  // full-period winner.
  let folds: LpFoldResult[] = [];
  const wantFolds = cfg.optimizer.folds;
  if (wantFolds >= 1) {
    try {
      folds = lpWalkForward(prices, wantFolds, {
        axes: cfg.lpAxes ?? DEFAULT_LP_AXES,
        metric: cfg.optimizer.metric,
        input: { base: input.base, gas: input.gas },
      });
    } catch (error) {
      console.log(
        `Walk-forward skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log();
    }
  }

  for (const fold of folds) {
    console.log(formatLpFold(fold));
    console.log();
  }
  if (folds.length > 0) {
    console.log(formatLpWalkForwardSummary(folds));
    console.log();
  }

  const consensus = selectLpConsensus(folds);
  const fullPeriodBest = rankLp(sweep.metrics, cfg.optimizer.metric)[0]!;

  // Prefer the fold consensus when walk-forward ran; fall back to the
  // full-period winner only when it did not.
  const selection = consensus[0];
  const best =
    selection === undefined
      ? fullPeriodBest
      : (sweep.metrics.find(
          (m) =>
            m.rangePct === selection.params.rangePct &&
            m.recenterBufferPct === selection.params.recenterBufferPct &&
            m.recenterMinHours === selection.params.recenterMinHours &&
            m.regimeMaxMovePct === selection.params.regimeMaxMovePct &&
            m.hedgeRatioPct === selection.params.hedgeRatioPct,
        ) ?? fullPeriodBest);

  if (selection !== undefined) {
    console.log(RULE);
    console.log("SELECTION");
    console.log(RULE);
    console.log();
    console.log(`Chosen by fold consensus:  ${describeLpParams(selection.params)}`);
    console.log(
      `  Won ${selection.foldWins}/${folds.length} training windows` +
        `, mean out-of-sample ${pct(selection.meanOosReturnPct)}` +
        `, worst ${pct(selection.worstOosReturnPct)}`,
    );
    console.log(`Full-period winner:        ${describeLpParams(fullPeriodBest)}`);
    if (
      fullPeriodBest.rangePct !== selection.params.rangePct ||
      fullPeriodBest.recenterBufferPct !== selection.params.recenterBufferPct
    ) {
      console.log();
      console.log("  These disagree. The full-period winner is fitted on the data it");
      console.log("  reports; the consensus pick is not. Deploy the consensus pick.");
    }
    console.log(RULE);
    console.log();
  }

  const bestResult = runPassiveLp(
    {
      ...input.base,
      rangePct: best.rangePct,
      recenterBufferPct: best.recenterBufferPct,
      recenterMinHours: best.recenterMinHours,
      regimeMaxMovePct: best.regimeMaxMovePct,
      hedgeRatioPct: best.hedgeRatioPct,
    },
    prices,
    cfg.gas,
  );
  console.log(formatLpReport(bestResult));
  console.log();

  // ---------------------------------------------------------------- vs grid
  const strategy = new GridStrategy(
    cfg.grid,
    new LinearCostFillModel(cfg.grid.feeBps, cfg.grid.slippageBps),
  );
  const grid = runBacktest(strategy, prices, cfg.gas, cfg.lendingGasLegs);
  assertAccountingReconciles(grid);

  console.log(RULE);
  console.log("HEAD TO HEAD — same data, same capital, same fee series");
  console.log(RULE);
  console.log();
  const rows: [string, string, string][] = [
    ["Final value", usd(grid.finalPortfolioValue), usd(bestResult.finalValue)],
    ["Return", pct(grid.returnPct), pct(bestResult.returnPct)],
    ["Max drawdown", pct(grid.maxDrawdownPct), pct(bestResult.maxDrawdownPct)],
    ["Fee income", signedUsd(grid.feeIncomeUsd), signedUsd(bestResult.feeIncomeUsd)],
    [
      "Trading / position P&L",
      signedUsd(grid.gridPnlUsd + grid.resetPnlUsd),
      signedUsd(bestResult.positionPnlUsd),
    ],
    [
      "Costs (fees+slip+gas)",
      signedUsd(-(grid.totalFeeUsd + grid.totalSlippageUsd + grid.totalGasUsd)),
      signedUsd(-(bestResult.swapCostUsd + bestResult.gasUsd)),
    ],
    ["Transactions", String(grid.buysExecuted + grid.sellsExecuted), String(bestResult.recenters.length)],
    [
      "Capital deployed",
      `${grid.inventory.avgDeployedPct.toFixed(1)}%`,
      `${bestResult.timeInRangePct.toFixed(1)}% in range`,
    ],
  ];
  console.log(`${"".padEnd(26)}${"Grid".padStart(16)}${"Passive LP".padStart(18)}`);
  console.log(THIN);
  for (const [label, a, b] of rows) {
    console.log(`${label.padEnd(26)}${a.padStart(16)}${b.padStart(18)}`);
  }
  console.log();
  const diff = bestResult.returnPct - grid.returnPct;
  console.log(
    diff > 0
      ? `Passive LP wins by ${pct(diff)} pts — the grid's trading does not pay for its idle capital.`
      : `Grid wins by ${pct(-diff)} pts.`,
  );
  console.log(RULE);

  const dir = runDir(cfg.resultsDir, cfg.runLabel);
  const csvPath = writeCsv(
    `${dir}/lp-optimization.csv`,
    [
      "range_pct",
      "recenter_buffer_pct",
      "recenter_min_hours",
      "regime_max_move_pct",
      "hedge_ratio_pct",
      "final_value",
      "return",
      "max_drawdown",
      "fee_income",
      "position_pnl",
      "swap_cost",
      "gas",
      "recenters",
      "time_in_range_pct",
      "time_parked_pct",
      "park_events",
      "impermanent_loss",
      "risk_adjusted",
    ],
    rankLp(sweep.metrics, cfg.optimizer.metric).map((m) => [
      m.rangePct,
      m.recenterBufferPct,
      m.recenterMinHours,
      m.regimeMaxMovePct,
      m.hedgeRatioPct,
      m.finalValue,
      m.returnPct,
      m.maxDrawdownPct,
      m.feeIncomeUsd,
      m.positionPnlUsd,
      m.swapCostUsd,
      m.gasUsd,
      m.recenters,
      m.timeInRangePct,
      m.timeParkedPct,
      m.parkEvents,
      m.impermanentLossUsd,
      m.riskAdjusted,
    ]),
  );

  // Out-of-sample results get their own export: the full-period sweep CSV
  // above cannot distinguish a robust configuration from a fitted one.
  let wfPath: string | null = null;
  if (folds.length > 0) {
    wfPath = writeCsv(
      `${dir}/lp-walk-forward.csv`,
      [
        "fold",
        "train_start",
        "train_end",
        "train_years",
        "test_start",
        "test_end",
        "test_years",
        "range_pct",
        "recenter_buffer_pct",
        "recenter_min_hours",
        "regime_max_move_pct",
        "hedge_ratio_pct",
        "train_return",
        "train_annualized",
        "test_return",
        "test_annualized",
        "test_max_drawdown",
        "test_time_in_range_pct",
        "test_time_parked_pct",
        "train_eth_return",
        "test_eth_return",
        "test_vs_eth",
        "test_recenters",
        "test_fee_income",
        "test_position_pnl",
      ],
      folds.map((f) => [
        f.name,
        f.trainRange[0],
        f.trainRange[1],
        f.trainYears,
        f.testRange[0],
        f.testRange[1],
        f.testYears,
        f.best.rangePct,
        f.best.recenterBufferPct,
        f.best.recenterMinHours,
        f.best.regimeMaxMovePct,
        f.best.hedgeRatioPct,
        f.train.returnPct,
        annualize(f.train.returnPct, f.trainYears),
        f.test.returnPct,
        annualize(f.test.returnPct, f.testYears),
        f.test.maxDrawdownPct,
        f.test.timeInRangePct,
        f.test.timeParkedPct,
        f.trainEthReturnPct,
        f.testEthReturnPct,
        f.test.returnPct - f.testEthReturnPct,
        f.test.recenters,
        f.test.feeIncomeUsd,
        f.test.positionPnlUsd,
      ]),
    );
  }

  // Archive in the shared run store so `npm run compare` lines it up with the
  // grid runs. Fields the grid reports and LP has no analogue for are zeroed.
  const lpLpActive =
    prices.some((p) => (p.feeAprPct ?? 0) > 0) ||
    cfg.grid.lpFeeAprPct > 0 ||
    cfg.grid.lpPoolLiquidityUsd > 0;
  const lpCalibration = prices.some((p) => (p.feeAprPct ?? 0) > 0)
    ? ("measured-apr-series" as const)
    : cfg.grid.lpFeeAprPct > 0
      ? ("constant-apr" as const)
      : cfg.grid.lpPoolLiquidityUsd > 0
        ? ("volume-share" as const)
        : ("none" as const);
  const lpProvenance = captureProvenance({
    pricesFile: cfg.csvFile,
    aprFile: cfg.aprFile,
    lpFeeIncomeActive: lpLpActive,
    lpCalibration: lpCalibration,
    // The backtester does not model money-market yield; the live bot's Aave
    // lending is a separate concern and is never included in these figures.
    lendingYield: false,
  });
  const runPath = saveRun(cfg.resultsDir, {
    label: cfg.runLabel,
    mode: "backtest",
    createdAt: new Date().toISOString(),
    provenance: lpProvenance,
    dataFile: `${cfg.csvFile} [passive LP]`,
    periodStart: prices[0]!.timestamp,
    periodEnd: prices[prices.length - 1]!.timestamp,
    initialCapital: bestResult.initialCapital,
    spec: `lp-range=${best.rangePct},lp-recenter=${best.recenterBufferPct}`,
    description:
      `passive LP ±${best.rangePct}% · ` +
      (best.recenterBufferPct === 0
        ? "never re-centred"
        : `re-centre beyond ${best.recenterBufferPct}% (min ${best.recenterMinHours}h)`) +
      (selection !== undefined
        ? ` · selected by ${selection.foldWins}/${folds.length}-fold consensus` +
          `, mean OOS ${selection.meanOosReturnPct.toFixed(1)}%` +
          `, worst OOS ${selection.worstOosReturnPct.toFixed(1)}%`
        : " · FULL-PERIOD FIT, no out-of-sample validation"),
    metrics: {
      candidate: {
        spacingPercent: 0,
        widthPercent: best.rangePct,
        levelsAbove: 0,
        levelsBelow: 0,
        resetBufferLevels: best.recenterBufferPct,
        orderSizePercent: 100,
        orderSizeUsd: bestResult.initialCapital,
      },
      finalPortfolioValue: bestResult.finalValue,
      returnPercent: bestResult.returnPct,
      maxDrawdownPct: bestResult.maxDrawdownPct,
      totalGridPnL: 0,
      totalResetPnL: bestResult.positionPnlUsd,
      unrealizedPnL: 0,
      totalFeeIncome: bestResult.feeIncomeUsd,
      totalFees: bestResult.swapCostUsd,
      totalSlippage: 0,
      totalGas: bestResult.gasUsd,
      numberOfTrades: bestResult.recenters.length,
      numberOfResets: bestResult.recenters.length,
      completedCycles: 0,
      averageResetLoss: 0,
      maxResetLoss: 0,
      maxEthExposurePct: 100,
      avgEthExposurePct: 50,
      avgDeployedPct: bestResult.timeInRangePct,
      avgIdleUsd: 0,
      riskAdjustedScore: best.riskAdjusted,
      robustScore: bestResult.returnPct,
      neighbourCount: 0,
      benchmarks: {
        usdcReturnPct: 0,
        ethReturnPct:
          ((prices[prices.length - 1]!.price / prices[0]!.price) - 1) * 100,
        lpReturnPct: bestResult.returnPct,
        vsUsdcPct: bestResult.returnPct,
        vsEthPct:
          bestResult.returnPct -
          ((prices[prices.length - 1]!.price / prices[0]!.price) - 1) * 100,
        vsLpPct: 0,
      },
    },
  });

  logger.info("Passive LP results written", {
    label: cfg.runLabel,
    csvPath,
    walkForwardPath: wfPath,
    runPath,
    outOfSampleFolds: folds.length,
  });
}
