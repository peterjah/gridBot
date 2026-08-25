import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GridConfig } from "../grid/types.js";
import type { ConfigMetrics, GridCandidate, RankMetric, SweepAxes } from "./optimizer.js";
import { candidateSpec, levelsForWidth } from "./optimizer.js";
import { RULE, THIN, day, pct, signedUsd, usd } from "./format.js";
import type { Provenance } from "./provenance.js";
import { logger } from "../utils/logger.js";
import { writeCsv } from "./csv.js";

/**
 * Persisted record of one experiment.
 *
 * Both a single backtest and a full sweep reduce to the same shape — one
 * headline configuration plus its metrics — so runs of either kind can be
 * lined up against each other without special cases.
 */
export interface RunSummary {
  label: string;
  mode: "backtest" | "optimize";
  createdAt: string;
  dataFile: string;
  periodStart: number;
  periodEnd: number;
  initialCapital: number;
  /** Sweep only: how the winner was chosen and how big the search was. */
  metric?: RankMetric;
  configsTested?: number;
  configsSkipped?: number;
  axes?: SweepAxes;
  /** Replayable `--config` spec of the headline configuration. */
  spec: string;
  description: string;
  metrics: ConfigMetrics;
  /**
   * Everything needed to reproduce this number. Optional only so older
   * archived runs still load; every new run records it.
   */
  provenance?: Provenance;
  /** Out-of-sample result, when the run computed one. */
  outOfSample?: {
    trainReturnPct: number;
    testReturnPct: number;
    testMaxDrawdownPct: number;
    testResets: number;
    spec: string;
  };
}

/** Where a labelled run keeps its artifacts. */
export function runDir(resultsDir: string, label: string): string {
  return join(resultsDir, sanitize(label));
}

function sanitize(label: string): string {
  const clean = label.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!clean) throw new Error(`Invalid run label: "${label}"`);
  return clean;
}

export function saveRun(resultsDir: string, summary: RunSummary): string {
  const dir = runDir(resultsDir, summary.label);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "run.json");

  // Reusing a label silently replaced the previous result, so a figure quoted
  // from an earlier run of the same name could no longer be checked against
  // anything. Supersession is now recorded rather than erased.
  if (existsSync(path)) {
    try {
      const previous = JSON.parse(readFileSync(path, "utf8")) as RunSummary;
      const archive = join(dir, `superseded-${previous.createdAt.replace(/[:.]/g, "-")}.json`);
      writeFileSync(archive, `${JSON.stringify(previous, null, 2)}\n`);
      logger.warn("Run label reused; previous result archived", {
        label: summary.label,
        previousReturn: previous.metrics.returnPercent,
        previousCode: previous.provenance?.code.srcSha256 ?? "unrecorded",
        archive,
      });
    } catch {
      // An unreadable previous record must not block the new one.
    }
  }

  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
  return path;
}

/** Load every saved run, newest first. Unreadable entries are skipped. */
export function loadRuns(resultsDir: string): RunSummary[] {
  if (!existsSync(resultsDir)) return [];
  const runs: RunSummary[] = [];
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(resultsDir, entry.name, "run.json");
    if (!existsSync(path)) continue;
    try {
      runs.push(JSON.parse(readFileSync(path, "utf8")) as RunSummary);
    } catch {
      // A corrupt run.json must not take the whole comparison down.
continue;
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Rebuild a candidate from a plain GridConfig, for single-backtest runs. */
export function candidateFromConfig(cfg: GridConfig, capitalUsd: number): GridCandidate {
  const step = 1 + cfg.spacingPercent / 100;
  // Invert levelsForWidth so the recorded width matches the actual geometry.
  const widthPercent = (Math.pow(step, cfg.levelsAbove) - 1) * 100;
  return {
    spacingPercent: cfg.spacingPercent,
    widthPercent: Number(widthPercent.toFixed(2)),
    levelsAbove: cfg.levelsAbove,
    levelsBelow: cfg.levelsBelow,
    resetBufferLevels: cfg.resetBufferLevels,
    orderSizePercent: capitalUsd > 0 ? Number(((cfg.orderSizeUsd / capitalUsd) * 100).toFixed(4)) : 0,
    orderSizeUsd: cfg.orderSizeUsd,
    maxVolPerStep: cfg.maxVolPerStep,
    inventoryCapPercent:
      Number.isFinite(cfg.maxEthUsd) && capitalUsd > 0
        ? Number(((cfg.maxEthUsd / capitalUsd) * 100).toFixed(2))
        : 0,
    cooldownHours: cfg.regenMinSeconds / 3600,
    resetSellFraction: cfg.resetSellFraction,
    underwaterSkipPct: cfg.resetUnderwaterSkipPct,
  };
}

export { candidateSpec, levelsForWidth };

// ----------------------------------------------------------------- compare

/** Side-by-side table of saved runs, best return first. */
export function formatComparison(runs: RunSummary[]): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);

  line(RULE);
  line("SAVED RUN COMPARISON");
  line(RULE);
  line();

  if (runs.length === 0) {
    line("No saved runs found. Run a backtest or optimization with --label <name> first.");
    line(RULE);
    return lines.join("\n");
  }

  const sorted = [...runs].sort((a, b) => b.metrics.returnPercent - a.metrics.returnPercent);

  const datasets = new Set(sorted.map(datasetLabel));
  if (datasets.size > 1) {
    line(
      `NOTE: these runs span ${datasets.size} different datasets/periods — returns are ` +
        `only comparable within the same one.`,
    );
    line();
  }

  // The dataset is part of the identity of a run: comparing a bear-path run
  // against a bull-path run without saying so is how false conclusions get
  // made, so the data file and period are always on screen.
  const head: [string, number][] = [
    ["Label", 22],
    ["Mode", 10],
    ["Data", 22],
    ["Configs", 9],
  ];
  const tail: [string, number][] = [
    ["Return", 9],
    ["MaxDD", 9],
    ["Grid P&L", 13],
    ["Reset P&L", 13],
    ["Costs", 11],
    ["Trades", 8],
    ["Resets", 8],
    ["MaxETH%", 9],
    ["vs ETH", 9],
  ];
  line(head.map(([h, w]) => h.padEnd(w)).join("") + tail.map(([h, w]) => h.padStart(w)).join(""));
  line(THIN);

  for (const run of sorted) {
    const m = run.metrics;
    const costs = m.totalFees + m.totalSlippage + m.totalGas;
    const left = [
      run.label.slice(0, 21),
      run.mode,
      datasetLabel(run).slice(0, 21),
      run.configsTested === undefined ? "1" : String(run.configsTested),
    ];
    const right = [
      pct(m.returnPercent),
      `${m.maxDrawdownPct.toFixed(1)}%`,
      signedUsd(m.totalGridPnL),
      signedUsd(m.totalResetPnL),
      signedUsd(-costs),
      String(m.numberOfTrades),
      String(m.numberOfResets),
      `${m.maxEthExposurePct.toFixed(0)}%`,
      pct(m.benchmarks.vsEthPct),
    ];
    line(
      left.map((v, i) => v.padEnd(head[i]![1])).join("") +
        right.map((v, i) => v.padStart(tail[i]![1])).join(""),
    );
  }

  line();
  line("Winning configuration per run:");
  for (const run of sorted) {
    line(`  ${run.label.padEnd(22)}${run.description}`);
  }

  line();
  line("Provenance (code fingerprint · income model · dataset):");
  for (const run of sorted) {
    const p = run.provenance;
    if (!p) {
      line(`  ${run.label.padEnd(22)}UNRECORDED — predates provenance capture, not auditable`);
      continue;
    }
    const income = p.income.lpFeeIncome ? `LP fees (${p.income.lpCalibration})` : "no LP fees";
    const lend = p.income.lendingYield ? " + lending yield" : "";
    const prices = p.datasets.find((d) => d.role === "prices");
    line(
      `  ${run.label.padEnd(22)}${p.code.srcSha256}${p.code.dirty ? "*" : " "}  ${income}${lend}` +
        `  ${prices ? `${prices.rows} rows @ ${prices.sha256}` : ""}`,
    );
  }
  line();
  line("  * = working tree was dirty; the src hash identifies what actually ran.");
  line("  Runs with different code fingerprints are NOT comparable.");

  const withOos = sorted.filter((r) => r.outOfSample);
  if (withOos.length > 0) {
    line();
    line("Out-of-sample (train → test):");
    line(
      `  ${"Label".padEnd(22)}${"Train".padStart(9)}${"Test".padStart(9)}${"Test MaxDD".padStart(12)}${"Decay".padStart(9)}`,
    );
    for (const run of withOos) {
      const o = run.outOfSample!;
      line(
        `  ${run.label.padEnd(22)}${pct(o.trainReturnPct).padStart(9)}${pct(o.testReturnPct).padStart(9)}` +
          `${`${o.testMaxDrawdownPct.toFixed(1)}%`.padStart(12)}${pct(o.testReturnPct - o.trainReturnPct).padStart(9)}`,
      );
    }
  }

  line();
  line("Replay any run:");
  for (const run of sorted.slice(0, 5)) {
    line(`  npm run backtest -- --config "${run.spec}" --label ${run.label}-replay`);
  }
  line(RULE);
  return lines.join("\n");
}

/** `file @ start→end`, identifying the exact data a run was measured on. */
function datasetLabel(run: RunSummary): string {
  const file = run.dataFile.split("/").pop() ?? run.dataFile;
  return `${file.replace(/\.csv$/, "")} ${day(run.periodStart)}`;
}

/** Flat CSV of every saved run, for analysis outside the bot. */
export function writeComparisonCsv(runs: RunSummary[], path: string): string {
  const headers = [
    "label",
    "mode",
    "created_at",
    "data_file",
    "period_start",
    "period_end",
    "metric",
    "configs_tested",
    "spec",
    "final_value",
    "return",
    "max_drawdown",
    "grid_pnl",
    "reset_pnl",
    "unrealized_pnl",
    "fees",
    "slippage",
    "gas",
    "trades",
    "cycles",
    "resets",
    "avg_reset_loss",
    "max_reset_loss",
    "max_eth_exposure_pct",
    "risk_adjusted",
    "usdc_return",
    "eth_return",
    "vs_eth",
    "train_return",
    "test_return",
    "test_max_drawdown",
  ];
  const rows = runs.map((r) => {
    const m = r.metrics;
    return [
      r.label,
      r.mode,
      r.createdAt,
      r.dataFile,
      day(r.periodStart),
      day(r.periodEnd),
      r.metric ?? "",
      r.configsTested ?? 1,
      r.spec,
      m.finalPortfolioValue,
      m.returnPercent,
      m.maxDrawdownPct,
      m.totalGridPnL,
      m.totalResetPnL,
      m.unrealizedPnL,
      m.totalFees,
      m.totalSlippage,
      m.totalGas,
      m.numberOfTrades,
      m.completedCycles,
      m.numberOfResets,
      m.averageResetLoss,
      m.maxResetLoss,
      m.maxEthExposurePct,
      m.riskAdjustedScore,
      m.benchmarks.usdcReturnPct,
      m.benchmarks.ethReturnPct,
      m.benchmarks.vsEthPct,
      r.outOfSample?.trainReturnPct ?? "",
      r.outOfSample?.testReturnPct ?? "",
      r.outOfSample?.testMaxDrawdownPct ?? "",
    ];
  });
  return writeCsv(path, headers, rows);
}

export { usd, RULE };
