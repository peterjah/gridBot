import type { Mode } from "./config.js";
import { MODES, loadConfig } from "./config.js";
import { applyArgOverrides, parseArgs } from "./cli.js";
import { runBacktestMode } from "./runners/backtest.js";
import { runOptimizeMode } from "./runners/optimize.js";
import { runWalkForwardMode } from "./runners/walkForward.js";
import { runCompareMode } from "./runners/compare.js";
import { runScenarioMode } from "./runners/scenario.js";
import { runLpMode } from "./runners/lp.js";
import { runLpLiveMode } from "./runners/lpLive.js";
import { runPaperMode } from "./runners/paper.js";
import { runLiveMode } from "./runners/live.js";
import { runSoakReport } from "./runners/soakReport.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const modeArg = (args["mode"] ?? undefined) as Mode | undefined;
  const envMode = (process.env.MODE ?? "") as Mode;
  const mode: Mode =
    modeArg ?? ((MODES as string[]).includes(envMode) ? envMode : "backtest");
  if (!(MODES as string[]).includes(mode)) {
    throw new Error(`Unknown mode "${mode}". Expected one of: ${MODES.join(", ")}`);
  }

  const cfg = loadConfig(mode);
  applyArgOverrides(cfg, args);

  switch (mode) {
    case "backtest":
      return runBacktestMode(cfg);
    case "optimize":
      return runOptimizeMode(cfg);
    case "walk-forward":
      return runWalkForwardMode(cfg);
    case "compare":
      return runCompareMode(cfg);
    case "scenario":
      return runScenarioMode(cfg);
    case "lp":
      return runLpMode(cfg);
    case "lp-live":
      return runLpLiveMode(cfg);
    case "paper":
      return runPaperMode(cfg);
    case "live":
      return runLiveMode(cfg);
    case "soak-report":
      return Promise.resolve(runSoakReport(cfg));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
