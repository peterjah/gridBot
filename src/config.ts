import "dotenv/config";
import type { GridConfig } from "./grid/types.js";
import { DEFAULT_AXES, parseRankMetric } from "./backtest/optimizer.js";
import type { RankMetric, SweepAxes } from "./backtest/optimizer.js";

export type Mode =
  | "backtest"
  | "paper"
  | "live"
  | "optimize"
  | "walk-forward"
  | "compare"
  | "scenario";

export const MODES: Mode[] = [
  "backtest",
  "paper",
  "live",
  "optimize",
  "walk-forward",
  "compare",
  "scenario",
];

export type GridSettings = GridConfig;

/** Parameter-sweep settings. Only used by `optimize` / `walk-forward`. */
export interface OptimizerConfig {
  axes: SweepAxes;
  /** Ranking metric; finalPortfolioValue ordering is RETURN. */
  metric: RankMetric;
  /** Rows printed in the ranked table. */
  top: number;
  /** Share of the data used for parameter selection in train/test mode. */
  trainFraction: number;
  /** Walk-forward folds. */
  folds: number;
  /** Center each run on the first price of its own period. */
  autoCenter: boolean;
  /** Scenario mode: which historical windows to judge a configuration on. */
  scenario: {
    months: number;
    stepDays: number;
    moveMin: number;
    moveMax: number;
    volMin?: number;
    volMax?: number;
  };
}

export interface AppConfig {
  mode: Mode;
  rpcUrls: string[];
  privateKey: `0x${string}` | null;
  walletAddress: `0x${string}` | null;
  poolAddress: `0x${string}` | null;
  csvFile: string;
  reportFile: string;
  /** Directory for CSV exports (trades, resets, optimization). */
  resultsDir: string;
  /** Optional daily pool fee APR series joined onto the price data. */
  aprFile: string | null;
  /** Drop APR observations where pool TVL was below this (0 = keep all). */
  minPoolTvlUsd: number;
  /**
   * Name this run is archived under. Artifacts go to `results/<label>/` and
   * `reports/<label>.html`, so experiments never overwrite each other.
   */
  runLabel: string;
  pollIntervalSeconds: number;
  /** Estimated gas per executed trade in USD (environment cost). */
  estimatedGasUsd: number;
  grid: GridSettings;
  optimizer: OptimizerConfig;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function num(name: string, fallback?: number): number {
  const raw = env(name) ?? (fallback !== undefined ? String(fallback) : undefined);
  if (raw === undefined) throw new Error(`Missing required environment variable: ${name}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

/** Parse a comma-separated numeric list, e.g. "0.5,1,2". */
function numList(name: string, fallback: number[]): number[] {
  const raw = env(name);
  if (!raw) return fallback;
  if (raw.trim().toLowerCase() === "none") return [];
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${name} must be a comma-separated number list, got "${raw}"`);
      return n;
    });
  if (values.length === 0) throw new Error(`${name} is empty`);
  return values;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function address(name: string): `0x${string}` | null {
  const v = env(name);
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not a valid address`);
  return v.toLowerCase() as `0x${string}`;
}

function key(): `0x${string}` | null {
  const v = env("PRIVATE_KEY");
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("PRIVATE_KEY must be a 32-byte hex string");
  return v as `0x${string}`;
}

/**
 * Load configuration for the requested mode. Backtesting never requires
 * private keys or RPC endpoints.
 */
export function loadConfig(mode: Mode): AppConfig {
  const cfg: AppConfig = {
    mode,
    rpcUrls: (env("RPC_URL") ?? "https://mainnet.base.org")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    privateKey: key(),
    walletAddress: address("WALLET_ADDRESS"),
    poolAddress: address("POOL_ADDRESS"),
    csvFile: env("CSV_FILE") ?? "data/sample-prices.csv",
    reportFile: env("REPORT_FILE") ?? "reports/backtest.html",
    resultsDir: env("RESULTS_DIR") ?? "results",
    aprFile: env("LP_APR_FILE") ?? null,
    minPoolTvlUsd: num("LP_MIN_POOL_TVL_USD", 0),
    runLabel: env("RUN_LABEL") ?? mode,
    pollIntervalSeconds: num("POLL_INTERVAL_SECONDS", 30),
    estimatedGasUsd: num("ESTIMATED_GAS_USD", 0.02),
    grid: {
      // Capital
      initialUsdc: num("INITIAL_USDC", 10_000),
      initialEth: num("INITIAL_ETH", 0),
      centerPrice: num("GRID_CENTER_PRICE", 4_000),
      spacingPercent: num("GRID_SPACING_PERCENT", 1),
      levelsAbove: Math.trunc(num("GRID_LEVELS_ABOVE", 5)),
      levelsBelow: Math.trunc(num("GRID_LEVELS_BELOW", 5)),
      orderSizeUsd: num("ORDER_SIZE_USD", 0), // 0 => auto (capital / level count)
      feeBps: num("SWAP_FEE_BPS", 5),
      slippageBps: num("SLIPPAGE_BPS", 3),
      minEthUsd: num("MIN_ETH_USD", 0),
      maxEthUsd: env("MAX_ETH_USD") ? num("MAX_ETH_USD") : Number.POSITIVE_INFINITY,
      // Grid reset / re-centering
      // RESET_BUFFER_SPACINGS is an accepted alias for the same setting.
      resetBufferLevels: num(
        env("RESET_BUFFER_SPACINGS") ? "RESET_BUFFER_SPACINGS" : "GRID_RESET_BUFFER_LEVELS",
        2,
      ),
      // Defaults reproduce the original unconditional full liquidation.
      resetSellFraction: num("RESET_SELL_FRACTION", 1),
      resetUnderwaterSkipPct: num("RESET_UNDERWATER_SKIP_PCT", 0),
      // LP fee income. Disabled by default: the bot as implemented SWAPS,
      // so it pays fees rather than earning them. Enable to model the grid
      // placed as concentrated liquidity instead.
      lpFeeBps: num("LP_FEE_BPS", 5),
      lpVenueVolumeSharePct: num("LP_VENUE_VOLUME_SHARE_PCT", 5),
      lpPoolLiquidityUsd: num("LP_POOL_LIQUIDITY_USD", 0),
      lpFeeAprPct: num("LP_FEE_APR_PCT", 0),
      // Causal regime filter (0 = off).
      regimeMaxMovePct: num("REGIME_MAX_MOVE_PCT", 0),
      regimeLookbackPoints: Math.trunc(num("REGIME_LOOKBACK_POINTS", 24 * 14)),
      regenMinSeconds: num("GRID_REGEN_MIN_SECONDS", 6 * 3600),
      volLookbackPoints: Math.trunc(num("GRID_VOL_LOOKBACK", 24)),
      maxVolPerStep: num("GRID_MAX_VOL_PER_STEP", 0.005),
      // Circuit breaker on clustered resets
      resetBreakerK: Math.trunc(num("GRID_BREAKER_RESETS", 3)),
      resetBreakerWindowSeconds: num("GRID_BREAKER_WINDOW_SECONDS", 30 * 24 * 3600),
    },
    optimizer: {
      axes: {
        spacings: numList("OPTIMIZER_SPACINGS", DEFAULT_AXES.spacings),
        widths: numList("OPTIMIZER_WIDTHS", DEFAULT_AXES.widths),
        resetBuffers: numList("OPTIMIZER_RESET_BUFFERS", DEFAULT_AXES.resetBuffers),
        orderFractions: numList("OPTIMIZER_ORDER_FRACTIONS", DEFAULT_AXES.orderFractions),
        // Risk axes: empty by default, so the sweep inherits the base config.
        maxVols: numList("OPTIMIZER_MAX_VOLS", []),
        inventoryCaps: numList("OPTIMIZER_INVENTORY_CAPS", []),
        cooldownHours: numList("OPTIMIZER_COOLDOWN_HOURS", []),
        sellFractions: numList("OPTIMIZER_SELL_FRACTIONS", []),
        underwaterSkips: numList("OPTIMIZER_UNDERWATER_SKIPS", []),
      },
      metric: parseRankMetric(env("OPTIMIZER_METRIC")),
      top: Math.trunc(num("OPTIMIZER_TOP", 15)),
      trainFraction: num("OPTIMIZER_TRAIN_FRACTION", 0.6),
      folds: Math.trunc(num("OPTIMIZER_FOLDS", 3)),
      autoCenter: bool("OPTIMIZER_AUTO_CENTER", true),
      scenario: {
        months: num("SCENARIO_MONTHS", 12),
        stepDays: num("SCENARIO_STEP_DAYS", 30),
        // Default profile: a moderate uptrend.
        moveMin: num("SCENARIO_MOVE_MIN", 10),
        moveMax: num("SCENARIO_MOVE_MAX", 60),
        volMin: env("SCENARIO_VOL_MIN") ? num("SCENARIO_VOL_MIN") : undefined,
        volMax: env("SCENARIO_VOL_MAX") ? num("SCENARIO_VOL_MAX") : undefined,
      },
    },
  };

  if (mode === "paper" || mode === "live") {
    if (!cfg.poolAddress) throw new Error(`POOL_ADDRESS is required in ${mode} mode`);
    if (!cfg.rpcUrls.length) throw new Error(`RPC_URL is required in ${mode} mode`);
  }
  if (mode === "live" && !cfg.privateKey) {
    throw new Error("PRIVATE_KEY is required in live mode");
  }

  return cfg;
}
