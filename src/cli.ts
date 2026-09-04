import { readFileSync } from "node:fs";
import type { GridConfig } from "./grid/types.js";
import type { AppConfig, GridSettings } from "./config.js";
import { pctToTicks } from "./config.js";
import type { RegimeMetric } from "./lp/passiveLp.js";
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
 *   --gas 0.02           estimated gas USD per fill (flat model)
 *   --gas-tx-overhead 0  fixed cost per batched transaction (multicall)
 *   --gas-per-fill 0.02  marginal cost of each extra swap leg in a batch
 *   --gas-lending-leg 0  extra cost when a tx also moves money-market funds
 *   --min-eth-usd 0      ETH exposure floor
 *   --max-eth-usd 1e12   ETH exposure ceiling
 *   --reset-buffer 2     spacings beyond outermost level that trigger a grid
 *                        reset (0 disables resetting)
 *   --reset-sell-fraction 1   fraction of inventory sold at a reset
 *   --reset-underwater-skip 0 carry inventory underwater by more than this %
 *   --reset-skip-cooldown-when-flat  rebuild immediately when a reset had no
 *                        inventory to sell (default off)
 *   --lp-pool-liquidity 0  competing liquidity in your range, USD
 *                        (0 = no LP fee income, the default)
 *   --lp-venue-share 5   % of the data's volume that routes through your pool
 *   --lp-apr 50          measured pool fee APR (%), preferred calibration
 *   --apr-file path      daily APR series joined onto the price data
 *   --aave-yield-file p  daily Aave supply-APR CSV; enables lending yield
 *                        on idle USDC in backtests
 *   --lp-fee-bps 5       pool fee tier used for LP fee income
 *   --regime-max-move 0  pause the grid when the trailing move exceeds this %
 *   --lp-regime-moves 0,10,20  LP sweep axis: stand aside above these trailing
 *                        moves (0 = filter off)
 *   --lp-hedge-ratios 0,50,100  LP sweep axis: percent of the position's ETH
 *                        exposure held short (0 = unhedged)
 *   --lp-regime-metrics displacement,signed,drawdown,volatility
 *                        how "hostile" is measured over the lookback window
 *   --regime-lookback 336 observations in the regime lookback window
 *   --regen-min-seconds   minimum cooldown seconds before rebuilding (default 21600)
 *   --vol-lookback 24    observations used for volatility estimate
 *   --max-vol 0.005      rebuild only when per-step volatility is below this
 *
 * Live LP re-centring (MODE=lp-live):
 *   --lp-range 5            half-width of the managed range, percent
 *   --lp-recenter-buffer 50 re-centre once price is this % of the half-width
 *                           beyond the range edge (matches the sweep column
 *                           recenter_buffer_pct)
 *   --lp-width-ticks N      explicit tick half-width, overrides --lp-range
 *   --lp-threshold-ticks N  explicit tick trigger, overrides the buffer
 *   --lp-recenter-hours 24  minimum hours between re-centres
 *   --lp-slippage-bps 50    slippage tolerance on the rebalancing swap and mint
 *   --lp-regime-move 0      stand aside above this trailing move % (0 = off)
 *   --lp-regime-reenter-margin 25  hysteresis: re-enter only below
 *                           (1 - margin/100) x the exit threshold
 *   --lp-regime-hours 168   lookback window for the regime filter, hours
 *   --lp-seed-file path     price CSV used to pre-fill the regime window
 *                        (omit to start blind; never defaults to CSV_FILE)
 *   --position-id 0         position NFT to manage (0 = mint a fresh one)
 *   --hedge false           short ETH with borrowed Aave WETH while parked
 *                           (needs ENABLE_AAVE=true)
 *   --hedge-ratio 50        percent of ETH exposure to short while parked
 *   --hedge-max-ltv 40      safety cap on borrowed value vs collateral, %
 *   --state-file path       where the managed token id is persisted
 *   --dry-run false         actually broadcast (also needs LIVE_CONFIRM=yes)
 *   --log path           paper log file for soak-report
 *   --days N             soak report window (0 = all)
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
 *   --skip-flat-cooldowns 0,1       rebuild immediately when a reset was flat
 *   --confirm-observations 0,2,4    confirmations before a band exit liquidates
 *   --vol-postpones 0,1             postpone liquidation while volatile
 *   --hard-drawdowns 0,15,25        drawdown backstop forcing a liquidation
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
      case "skip-flat-cooldown": g.resetSkipCooldownWhenFlat = value !== 0; break;
      case "hard-inv-loss": g.resetHardInventoryLossPct = value; break;
      case "hard-dd": g.resetHardDrawdownPct = value; break;
      case "confirm": g.resetConfirmObservations = Math.trunc(value); break;
      case "vol-postpone": g.resetVolPostpone = value !== 0; break;
      case "lp-venue-share": g.lpVenueVolumeSharePct = value; break;
      case "lp-pool-liquidity": g.lpPoolLiquidityUsd = value; break;
      case "lp-apr": g.lpFeeAprPct = value; break;
      case "lp-mode": g.executionMode = value !== 0 ? "lp" : "taker"; break;
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
      case "executionMode": g.executionMode = v === "lp" ? "lp" : "taker"; break;
      case "slippageBps": g.slippageBps = Number(v); break;
      case "estimatedGasUsd":
        cfg.estimatedGasUsd = Number(v);
        // Keep the structured model in step when only the flat knob is set.
        cfg.gas.perFillUsd = Number(v);
        break;
      case "minEthUsd": g.minEthUsd = Number(v); break;
      case "maxEthUsd": g.maxEthUsd = Number(v); break;
      case "resetBufferLevels": g.resetBufferLevels = Number(v); break;
      case "resetSellFraction": g.resetSellFraction = Number(v); break;
      case "resetUnderwaterSkipPct": g.resetUnderwaterSkipPct = Number(v); break;
      case "resetSkipCooldownWhenFlat": g.resetSkipCooldownWhenFlat = v !== "false"; break;
      case "resetHardInventoryLossPct": g.resetHardInventoryLossPct = Number(v); break;
      case "lpFeeBps": g.lpFeeBps = Number(v); break;
      case "lpVenueVolumeSharePct": g.lpVenueVolumeSharePct = Number(v); break;
      case "lpPoolLiquidityUsd": g.lpPoolLiquidityUsd = Number(v); break;
      case "lpFeeAprPct": g.lpFeeAprPct = Number(v); break;
      case "lpReferenceRangePct": g.lpReferenceRangePct = Number(v); break;
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
  set("executionMode", args["execution-mode"]);
  set("slippageBps", args["slippage-bps"]);
  set("estimatedGasUsd", args["gas"]);
  set("minEthUsd", args["min-eth-usd"]);
  set("maxEthUsd", args["max-eth-usd"]);
  set("resetBufferLevels", args["reset-buffer"]);
  set("resetSellFraction", args["reset-sell-fraction"]);
  set("resetUnderwaterSkipPct", args["reset-underwater-skip"]);
  set("resetSkipCooldownWhenFlat", args["reset-skip-cooldown-when-flat"]);
  set("resetHardInventoryLossPct", args["reset-hard-inventory-loss"]);
  set("lpFeeBps", args["lp-fee-bps"]);
  set("lpVenueVolumeSharePct", args["lp-venue-share"]);
  set("lpPoolLiquidityUsd", args["lp-pool-liquidity"]);
  set("lpFeeAprPct", args["lp-apr"]);
  set("lpReferenceRangePct", args["lp-reference-range"]);
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
  if (args["aave-yield-file"] !== undefined) cfg.aaveYieldFile = args["aave-yield-file"];
  if (args["log"] !== undefined) cfg.soakLogFile = args["log"];
  if (args["min-pool-tvl"] !== undefined) cfg.minPoolTvlUsd = Number(args["min-pool-tvl"]);
  const lpRanges = argNumList("lp-ranges", args["lp-ranges"]);
  const lpBuffers = argNumList("lp-recenter-buffers", args["lp-recenter-buffers"]);
  const lpHours = argNumList("lp-recenter-hours", args["lp-recenter-hours"]);
  const lpRegimes = argNumList("lp-regime-moves", args["lp-regime-moves"]);
  const lpHedges = argNumList("lp-hedge-ratios", args["lp-hedge-ratios"]);
  const lpMetrics = args["lp-regime-metrics"]
    ?.split(",")
    .map((m) => m.trim())
    .filter(Boolean) as RegimeMetric[] | undefined;
  if (lpRanges || lpBuffers || lpHours || lpRegimes || lpHedges || lpMetrics) {
    cfg.lpAxes = {
      rangePcts: lpRanges ?? [5, 10, 15, 20, 30, 50, 75],
      recenterBuffers: lpBuffers ?? [0, 10, 25, 50, 100],
      recenterMinHours: lpHours ?? [24],
      regimeMaxMovePcts: lpRegimes ?? [0],
      hedgeRatioPcts: lpHedges ?? [0],
      regimeMetrics: lpMetrics ?? ["displacement"],
    };
  }
  if (args["gas-tx-overhead"] !== undefined) cfg.gas.txOverheadUsd = Number(args["gas-tx-overhead"]);
  if (args["gas-per-fill"] !== undefined) cfg.gas.perFillUsd = Number(args["gas-per-fill"]);
  if (args["gas-lending-leg"] !== undefined) {
    cfg.gas.lendingLegUsd = Number(args["gas-lending-leg"]);
    // Naming the cost is enough to opt in; no separate flag needed.
    cfg.lendingGasLegs = true;
  }

  // Live LP re-centring (mode lp-live). Percent flags are re-derived into
  // ticks so --lp-range / --lp-recenter-buffer accept the same numbers the
  // passive-LP sweep reports.
  const lpr = cfg.lpRebalance;
  if (args["lp-range"] !== undefined) lpr.rangePct = Number(args["lp-range"]);
  if (args["lp-recenter-buffer"] !== undefined) {
    lpr.recenterBufferPct = Number(args["lp-recenter-buffer"]);
  }
  if (args["lp-range"] !== undefined || args["lp-recenter-buffer"] !== undefined) {
    lpr.widthTicks = pctToTicks(lpr.rangePct);
    lpr.thresholdTicks = pctToTicks(lpr.rangePct * (1 + lpr.recenterBufferPct / 100));
  }
  if (args["lp-width-ticks"] !== undefined) lpr.widthTicks = Math.trunc(Number(args["lp-width-ticks"]));
  if (args["lp-threshold-ticks"] !== undefined) {
    lpr.thresholdTicks = Math.trunc(Number(args["lp-threshold-ticks"]));
  }
  if (args["lp-recenter-hours"] !== undefined && cfg.mode === "lp-live") {
    lpr.recenterMinHours = Number(args["lp-recenter-hours"]);
  }
  if (args["lp-slippage-bps"] !== undefined) lpr.slippageBps = Number(args["lp-slippage-bps"]);
  if (args["lp-regime-move"] !== undefined) lpr.regimeMaxMovePct = Number(args["lp-regime-move"]);
  if (args["lp-regime-reenter-margin"] !== undefined) {
    const margin = Number(args["lp-regime-reenter-margin"]);
    if (!Number.isFinite(margin) || margin < 0 || margin >= 100) {
      throw new Error("--lp-regime-reenter-margin must be a percent in [0,100)");
    }
    lpr.regimeReenterMarginPct = margin;
  }
  if (args["lp-regime-hours"] !== undefined) {
    lpr.regimeLookbackHours = Number(args["lp-regime-hours"]);
  }
  if (args["lp-seed-file"] !== undefined) {
    lpr.seedFile = args["lp-seed-file"] === "" ? null : args["lp-seed-file"];
  }
  if (args["position-id"] !== undefined) lpr.positionId = BigInt(args["position-id"]);
  if (args["state-file"] !== undefined) lpr.stateFile = args["state-file"];
  if (args["dry-run"] !== undefined) lpr.dryRun = args["dry-run"] !== "false";

  // Short hedge while parked (requires ENABLE_AAVE=true).
  if (args["hedge"] !== undefined) cfg.hedgeEnabled = args["hedge"] !== "false";
  if (args["hedge-ratio"] !== undefined) {
    const ratio = Number(args["hedge-ratio"]);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100) {
      throw new Error("--hedge-ratio must be a percent in (0,100]");
    }
    cfg.hedgeRatioPct = ratio;
  }
  if (args["hedge-max-ltv"] !== undefined) {
    const ltv = Number(args["hedge-max-ltv"]);
    if (!Number.isFinite(ltv) || ltv <= 0 || ltv >= 100) {
      throw new Error("--hedge-max-ltv must be a percent in (0,100)");
    }
    cfg.hedgeMaxLtvPct = ltv;
  }

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
  const skipFlats = argNumList("skip-flat-cooldowns", args["skip-flat-cooldowns"]);
  if (skipFlats) o.axes.skipFlatCooldowns = skipFlats;
  const confirms = argNumList("confirm-observations", args["confirm-observations"]);
  if (confirms) o.axes.confirmObservations = confirms;
  const postpones = argNumList("vol-postpones", args["vol-postpones"]);
  if (postpones) o.axes.volPostpones = postpones;
  const hardDds = argNumList("hard-drawdowns", args["hard-drawdowns"]);
  if (hardDds) o.axes.hardDrawdowns = hardDds;

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
