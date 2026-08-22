import { readFileSync } from "node:fs";
import type { GridConfig } from "./grid/types.js";
import type { AppConfig, GridSettings } from "./config.js";
import { levelsForWidth, parseRankMetric } from "./backtest/optimizer.js";

/**
 * Minimal CLI argument parsing. Supported flags (backtest):
 *
 *   --spacing 1          grid spacing percent
 *   --levels-above 5     levels above center
 *   --levels-below 5     levels below center
 *   --capital 10000      initial USDC
 *   --eth 0              initial ETH
 *   --center 4000        grid center price
 *   --order-size 500     notional per grid order
 *   --fee-bps 5          swap fee per fill
 *   --slippage-bps 3     slippage per fill
 *   --gas 0.02           estimated gas USD per trade
 *   --min-eth-usd 0      ETH exposure floor
 *   --max-eth-usd 1e12   ETH exposure ceiling
 *   --reset-buffer 2     spacings beyond outermost level that trigger a grid
 *                        reset (0 disables resetting)
 *   --reset-sell-fraction 1   fraction of inventory sold at a reset
 *   --reset-underwater-skip 0 carry inventory underwater by more than this %
 *   --lp-pool-liquidity 0  competing liquidity in your range, USD
 *                        (0 = no LP fee income, the default)
 *   --lp-venue-share 5   % of the data's volume that routes through your pool
 *   --lp-apr 50          measured pool fee APR (%), preferred calibration
 *   --apr-file path      daily APR series joined onto the price data
 *   --lp-fee-bps 5       pool fee tier used for LP fee income
 *   --regime-max-move 0  pause the grid when the trailing move exceeds this %
 *   --regime-lookback 336 observations in the regime lookback window
 *   --regen-min-seconds   minimum cooldown seconds before rebuilding (default 21600)
 *   --vol-lookback 24    observations used for volatility estimate
 *   --max-vol 0.005      rebuild only when per-step volatility is below this
 *   --csv path           price data file
 *   --report path        output HTML report file
 *   --results dir        directory for CSV exports (default "results")
 *   --label name         archive this run under results/<name>/ so runs can
 *                        be compared later with `npm run compare`
 *
 * Named configuration:
 *
 *   --config <spec>      either a path to a JSON file of GridConfig overrides,
 *                        or an inline spec such as
 *                        "spacing=1,width=20,reset=3,order=2"
 *                        (width is the grid half-width in percent, order is
 *                        the per-level allocation as a percent of capital)
 *
 * Optimizer (modes `optimize` / `walk-forward`):
 *
 *   --metric return|risk_adjusted|drawdown|grid_pnl
 *   --top 15             rows in the ranked table
 *   --train-fraction 0.6 share of data used for parameter selection
 *   --folds 3            walk-forward folds
 *   --spacings 0.5,1,2   sweep axis overrides (comma-separated)
 *   --widths 5,10,20
 *   --reset-buffers 1,2,3
 *   --order-fractions 1,2,5
 *   --max-vols 0.005,0.01,0.02      volatility-gate ceilings
 *   --inventory-caps 0,20,40        ETH inventory caps, % of capital (0 = none)
 *   --cooldown-hours 6,24,72        cooldown before a rebuild
 *   --sell-fractions 1,0.5,0        fraction of inventory sold at a reset
 *   --underwater-skips 0,10,20      carry inventory when underwater by more
 *                                   than this % instead of selling it
 *
 * Scenario mode (`--mode scenario`): judge configurations on every historical
 * window matching a market profile, ranked on the MEDIAN across windows.
 *
 *   --scenario-months 12     window length
 *   --scenario-step-days 30  step between window starts
 *   --move-min 10            window total move, lower bound (percent)
 *   --move-max 60            window total move, upper bound (percent)
 *   --vol-min / --vol-max    optional annualized volatility bounds
 *   --fixed-center       keep GRID_CENTER_PRICE instead of auto-centering
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      args[name] = value;
      i++;
    } else {
      args[name] = "true";
    }
  }
  return args;
}

/** Parse a comma-separated numeric list from a CLI flag. */
function argNumList(name: string, raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`--${name} must be a comma-separated number list`);
      return n;
    });
  if (values.length === 0) throw new Error(`--${name} is empty`);
  return values;
}

/**
 * Apply a named configuration passed via `--config`.
 *
 * Two accepted forms:
 *   1. a path to a JSON file whose keys are GridConfig fields;
 *   2. an inline `key=value` list using the optimizer's vocabulary
 *      (spacing / width / reset / order), so a row copied out of the
 *      optimization table can be replayed directly:
 *        npm run backtest -- --config "spacing=1,width=20,reset=3,order=2"
 */
export function applyNamedConfig(cfg: AppConfig, spec: string): void {
  const g = cfg.grid;

  if (!spec.includes("=")) {
    const raw = readFileSync(spec, "utf8");
    const parsed = JSON.parse(raw) as Partial<GridConfig> & { widthPercent?: number };
    if (parsed.widthPercent !== undefined) {
      const spacing = parsed.spacingPercent ?? g.spacingPercent;
      const levels = levelsForWidth(parsed.widthPercent, spacing);
      g.levelsAbove = levels;
      g.levelsBelow = levels;
    }
    delete parsed.widthPercent;
    Object.assign(g, parsed);
    return;
  }

  const capital = g.initialUsdc + g.initialEth * g.centerPrice;
  let width: number | undefined;
  for (const part of spec.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = Number(rawValue);
    if (!key || !Number.isFinite(value)) throw new Error(`--config: bad entry "${part}"`);
    switch (key) {
      case "spacing": g.spacingPercent = value; break;
      case "width": width = value; break;
      case "levels": g.levelsAbove = Math.trunc(value); g.levelsBelow = Math.trunc(value); break;
      case "reset": g.resetBufferLevels = value; break;
      case "order": g.orderSizeUsd = (capital * value) / 100; break;
      case "order-usd": g.orderSizeUsd = value; break;
      case "max-vol": g.maxVolPerStep = value; break;
      case "cap":
        // Percent of capital; 0 leaves the ceiling open.
        g.maxEthUsd = value <= 0 ? Number.POSITIVE_INFINITY : (capital * value) / 100;
        break;
      case "cooldown": g.regenMinSeconds = value * 3600; break;
      case "sell": g.resetSellFraction = value; break;
      case "underwater": g.resetUnderwaterSkipPct = value; break;
      case "lp-venue-share": g.lpVenueVolumeSharePct = value; break;
      case "lp-pool-liquidity": g.lpPoolLiquidityUsd = value; break;
      case "lp-apr": g.lpFeeAprPct = value; break;
      case "lp-fee-bps": g.lpFeeBps = value; break;
      case "regime-max-move": g.regimeMaxMovePct = value; break;
      case "regime-lookback": g.regimeLookbackPoints = Math.trunc(value); break;
      case "center": g.centerPrice = value; break;
      case "capital": g.initialUsdc = value; break;
      default: throw new Error(`--config: unknown key "${key}"`);
    }
  }
  // Width is resolved last so it uses the final spacing regardless of order.
  if (width !== undefined) {
    const levels = levelsForWidth(width, g.spacingPercent);
    g.levelsAbove = levels;
    g.levelsBelow = levels;
  }
}

export function applyArgOverrides(cfg: AppConfig, args: Record<string, string>): void {
  const g = cfg.grid;
  const set = (target: keyof GridSettings | keyof AppConfig, v: string | undefined) => {
    if (v === undefined) return;
    switch (target) {
      case "spacingPercent": g.spacingPercent = Number(v); break;
      case "levelsAbove": g.levelsAbove = Math.trunc(Number(v)); break;
      case "levelsBelow": g.levelsBelow = Math.trunc(Number(v)); break;
      case "initialUsdc": g.initialUsdc = Number(v); break;
      case "initialEth": g.initialEth = Number(v); break;
      case "centerPrice": g.centerPrice = Number(v); break;
      case "orderSizeUsd": g.orderSizeUsd = Number(v); break;
      case "feeBps": g.feeBps = Number(v); break;
      case "slippageBps": g.slippageBps = Number(v); break;
      case "estimatedGasUsd": cfg.estimatedGasUsd = Number(v); break;
      case "minEthUsd": g.minEthUsd = Number(v); break;
      case "maxEthUsd": g.maxEthUsd = Number(v); break;
      case "resetBufferLevels": g.resetBufferLevels = Number(v); break;
      case "resetSellFraction": g.resetSellFraction = Number(v); break;
      case "resetUnderwaterSkipPct": g.resetUnderwaterSkipPct = Number(v); break;
      case "lpFeeBps": g.lpFeeBps = Number(v); break;
      case "lpVenueVolumeSharePct": g.lpVenueVolumeSharePct = Number(v); break;
      case "lpPoolLiquidityUsd": g.lpPoolLiquidityUsd = Number(v); break;
      case "lpFeeAprPct": g.lpFeeAprPct = Number(v); break;
      case "regimeMaxMovePct": g.regimeMaxMovePct = Number(v); break;
      case "regimeLookbackPoints": g.regimeLookbackPoints = Math.trunc(Number(v)); break;
      case "regenMinSeconds": g.regenMinSeconds = Number(v); break;
      case "volLookbackPoints": g.volLookbackPoints = Math.trunc(Number(v)); break;
      case "maxVolPerStep": g.maxVolPerStep = Number(v); break;
      case "resetBreakerK": g.resetBreakerK = Math.trunc(Number(v)); break;
      case "resetBreakerWindowSeconds": g.resetBreakerWindowSeconds = Number(v); break;
      case "csvFile": cfg.csvFile = v; break;
      case "reportFile": cfg.reportFile = v; break;
      case "pollIntervalSeconds": cfg.pollIntervalSeconds = Number(v); break;
      default: break;
    }
  };

  set("initialUsdc", args["capital"]);
  set("initialEth", args["eth"]);
  set("centerPrice", args["center"]);
  set("spacingPercent", args["spacing"]);
  set("levelsAbove", args["levels-above"]);
  set("levelsBelow", args["levels-below"]);
  set("orderSizeUsd", args["order-size"]);
  set("feeBps", args["fee-bps"]);
  set("slippageBps", args["slippage-bps"]);
  set("estimatedGasUsd", args["gas"]);
  set("minEthUsd", args["min-eth-usd"]);
  set("maxEthUsd", args["max-eth-usd"]);
  set("resetBufferLevels", args["reset-buffer"]);
  set("resetSellFraction", args["reset-sell-fraction"]);
  set("resetUnderwaterSkipPct", args["reset-underwater-skip"]);
  set("lpFeeBps", args["lp-fee-bps"]);
  set("lpVenueVolumeSharePct", args["lp-venue-share"]);
  set("lpPoolLiquidityUsd", args["lp-pool-liquidity"]);
  set("lpFeeAprPct", args["lp-apr"]);
  set("regimeMaxMovePct", args["regime-max-move"]);
  set("regimeLookbackPoints", args["regime-lookback"]);
  set("regenMinSeconds", args["regen-min-seconds"]);
  set("volLookbackPoints", args["vol-lookback"]);
  set("maxVolPerStep", args["max-vol"]);
  set("resetBreakerK", args["breaker-resets"]);
  set("resetBreakerWindowSeconds", args["breaker-window"]);
  set("csvFile", args["csv"]);
  set("reportFile", args["report"]);
  set("pollIntervalSeconds", args["interval"]);
  if (args["results"] !== undefined) cfg.resultsDir = args["results"];
  if (args["label"] !== undefined) cfg.runLabel = args["label"];
  if (args["apr-file"] !== undefined) cfg.aprFile = args["apr-file"];
  if (args["min-pool-tvl"] !== undefined) cfg.minPoolTvlUsd = Number(args["min-pool-tvl"]);

  // A named configuration overrides the individual flags above.
  if (args["config"] !== undefined) applyNamedConfig(cfg, args["config"]);

  // Optimizer axes and ranking.
  const o = cfg.optimizer;
  if (args["metric"] !== undefined) o.metric = parseRankMetric(args["metric"]);
  if (args["top"] !== undefined) o.top = Math.trunc(Number(args["top"]));
  if (args["train-fraction"] !== undefined) o.trainFraction = Number(args["train-fraction"]);
  if (args["folds"] !== undefined) o.folds = Math.trunc(Number(args["folds"]));
  if (args["fixed-center"] !== undefined) o.autoCenter = false;
  const spacings = argNumList("spacings", args["spacings"]);
  if (spacings) o.axes.spacings = spacings;
  const widths = argNumList("widths", args["widths"]);
  if (widths) o.axes.widths = widths;
  const resetBuffers = argNumList("reset-buffers", args["reset-buffers"]);
  if (resetBuffers) o.axes.resetBuffers = resetBuffers;
  const orderFractions = argNumList("order-fractions", args["order-fractions"]);
  if (orderFractions) o.axes.orderFractions = orderFractions;
  const maxVols = argNumList("max-vols", args["max-vols"]);
  if (maxVols) o.axes.maxVols = maxVols;
  const inventoryCaps = argNumList("inventory-caps", args["inventory-caps"]);
  if (inventoryCaps) o.axes.inventoryCaps = inventoryCaps;
  const cooldownHours = argNumList("cooldown-hours", args["cooldown-hours"]);
  if (cooldownHours) o.axes.cooldownHours = cooldownHours;
  const sellFractions = argNumList("sell-fractions", args["sell-fractions"]);
  if (sellFractions) o.axes.sellFractions = sellFractions;
  const underwaterSkips = argNumList("underwater-skips", args["underwater-skips"]);
  if (underwaterSkips) o.axes.underwaterSkips = underwaterSkips;

  // Scenario window selection.
  const sc = o.scenario;
  if (args["scenario-months"] !== undefined) sc.months = Number(args["scenario-months"]);
  if (args["scenario-step-days"] !== undefined) sc.stepDays = Number(args["scenario-step-days"]);
  if (args["move-min"] !== undefined) sc.moveMin = Number(args["move-min"]);
  if (args["move-max"] !== undefined) sc.moveMax = Number(args["move-max"]);
  if (args["vol-min"] !== undefined) sc.volMin = Number(args["vol-min"]);
  if (args["vol-max"] !== undefined) sc.volMax = Number(args["vol-max"]);

  // Auto order sizing: deploy capital evenly across the initial grid orders.
  if (!(g.orderSizeUsd > 0)) {
    const orderCount = g.levelsAbove + g.levelsBelow;
    g.orderSizeUsd = g.initialUsdc / Math.max(orderCount, 1);
  }

  if (!(g.centerPrice > 0)) throw new Error("--center must be > 0");
  if (g.spacingPercent < 0 || g.spacingPercent >= 100) throw new Error("--spacing must be in [0,100)");
}
