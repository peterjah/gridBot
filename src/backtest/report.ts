import type { BacktestResult } from "./backtester.js";
import type { Benchmark } from "./benchmarks.js";
import type { GridConfig } from "../grid/types.js";
import { date as fmtDateTime, pct, signedUsd, usd } from "./format.js";

function ethFmt(n: number): string {
  return n.toFixed(4);
}

export function formatReport(
  result: BacktestResult,
  benchmarks: Benchmark[],
  cfg: GridConfig,
): string {
  const r = result;
  const returnPct = r.returnPct;
  const fmtDate = fmtDateTime;
  const state = r.strategy.getState();

  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line("========================================");
  line("GRID BACKTEST");
  line("========================================");
  line();
  line(`Pair:              ETH/USDC`);
  line(`Initial capital:   ${usd(r.initialCapital)}`);
  line(`Period:            ${fmtDate(r.start.timestamp)} → ${fmtDate(r.end.timestamp)}`);
  line(`Data points:       ${r.samples.length}`);
  line();
  line(`Grid center:       $${cfg.centerPrice.toLocaleString("en-US")}${state.resets > 0 ? ` (final: $${state.centerPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })} after ${state.resets} resets)` : ""}`);
  line(`Grid spacing:      ${cfg.spacingPercent}%`);
  line(`Grid levels:       ±${Math.max(cfg.levelsAbove, cfg.levelsBelow)} (-${cfg.levelsBelow}/+${cfg.levelsAbove})`);
  line(`Order size:        ${usd(cfg.orderSizeUsd)}`);
  line(`Fee/slippage:      ${cfg.feeBps} bps / ${cfg.slippageBps} bps`);
  line(`Gas per trade:     ${usd(r.gasPerTradeUsd)}`);
  if (cfg.resetBufferLevels > 0) {
    line(`Grid resets:       ${r.resets.length} liquidations / ${state.resets} rebuilds (buffer ${cfg.resetBufferLevels} spacings)`);
    line(`Final phase:       ${state.phase}`);
  }
  line();
  line("----------------------------------------");
  line("RESULT");
  line("----------------------------------------");
  line();
  line(`Final portfolio:   ${usd(r.finalPortfolioValue)}`);
  line(`Net profit:        ${usd(r.netProfitUsd)}`);
  line(`Return:            ${pct(returnPct)}`);
  line();
  line(`Max drawdown:      ${r.maxDrawdownPct.toFixed(2)}%`);
  line();
  line(`USDC:              ${usd(state.usdc)}`);
  line(`ETH:               ${ethFmt(state.eth)}`);
  line(`Avg ETH exposure:  ${ethFmt(r.avgEthExposure)} ETH (${r.inventory.avgEthExposurePct.toFixed(1)}% of portfolio)`);
  line();
  line(`Grid trades:       ${r.buysExecuted + r.sellsExecuted} (${r.buysExecuted} buys / ${r.sellsExecuted} sells)`);
  line(`Completed cycles:  ${r.completedCycles}`);
  line();
  line("----------------------------------------");
  line("P&L DECOMPOSITION");
  line("----------------------------------------");
  line();
  line(`A. Grid trading:   ${signedUsd(r.gridPnlUsd)}   (completed buy → sell cycles)`);
  line(`B. Reset/inventory:${signedUsd(r.resetPnlUsd).padStart(12)}   (ETH liquidated at resets)`);
  line(`   Unrealized:     ${signedUsd(r.unrealizedPnlUsd)}   (inventory still open)`);
  if (r.feeIncomeUsd > 0) {
    line(`D. LP fee income:  ${signedUsd(r.feeIncomeUsd)}   (earned resting in range)`);
  }
  line();
  line(`C. Swap fees:      ${signedUsd(-r.totalFeeUsd)}`);
  line(`   Slippage:       ${signedUsd(-r.totalSlippageUsd)}`);
  line(`   Gas:            ${signedUsd(-r.totalGasUsd)}`);
  line(`                   ${"-".repeat(14)}`);
  line(`   Net profit:     ${signedUsd(r.netProfitUsd)}`);

  if (Object.keys(r.skips).length > 0) {
    line();
    line(`Skipped orders:`);
    for (const [key, count] of Object.entries(r.skips)) {
      line(`  ${key.padEnd(20)} ${count}`);
    }
  }

  line();
  line("----------------------------------------");
  line("BENCHMARKS");
  line("----------------------------------------");
  line();
  const rows = [
    ...benchmarks.map((b) => ({ name: b.name, value: b.finalValue })),
    { name: "Grid strategy", value: r.finalPortfolioValue },
  ];
  for (const row of rows) {
    const ret = ((row.value - r.initialCapital) / r.initialCapital) * 100;
    line(`${row.name.padEnd(24)} ${usd(row.value).padStart(14)}  (${pct(ret)})`);
  }
  for (const b of benchmarks) {
    if (b.impermanentLossUsd !== undefined) {
      line(`${b.name} IL:       ${b.impermanentLossUsd >= 0 ? "+" : "-"}${usd(Math.abs(b.impermanentLossUsd)).slice(1)}`);
    }
  }
  line();
  line("========================================");

  return lines.join("\n");
}
