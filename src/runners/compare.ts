import type { AppConfig } from "../config.js";
import { formatComparison, loadRuns, writeComparisonCsv } from "../backtest/runStore.js";
import { logger } from "../utils/logger.js";

/**
 * Print every archived run side by side. Runs are written by `--label`, so
 * this is how a sequence of parameter experiments gets read as one picture
 * rather than as a pile of scrollback.
 */
export async function runCompareMode(cfg: AppConfig): Promise<void> {
  const runs = loadRuns(cfg.resultsDir);
  console.log(formatComparison(runs));

  if (runs.length > 0) {
    const path = writeComparisonCsv(runs, `${cfg.resultsDir}/comparison.csv`);
    logger.info("Comparison written", { path, runs: runs.length });
  }
}
