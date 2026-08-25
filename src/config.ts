import "dotenv/config";
import type { GridConfig } from "./grid/types.js";
import { DEFAULT_AXES, parseRankMetric } from "./backtest/optimizer.js";
import type { RankMetric, SweepAxes } from "./backtest/optimizer.js";
import type { GasModel } from "./backtest/gasModel.js";
import type { LpAxes } from "./lp/lpOptimizer.js";

export type Mode =
  | "backtest"
  | "paper"
  | "live"
  | "soak-report"
  | "optimize"
  | "walk-forward"
  | "compare"
  | "scenario"
  | "lp"
  | "lp-live";

export const MODES: Mode[] = [
  "backtest",
  "paper",
  "live",
  "soak-report",
  "optimize",
  "walk-forward",
  "compare",
  "scenario",
  "lp",
  "lp-live",
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
  /**
   * How the winning configuration is chosen:
   *   "walk-forward" — most fold-wins across expanding-window folds
   *                    (default; resists full-period overfitting)
   *   "full"         — legacy: best on the entire dataset (reference only)
   */
  selection: "walk-forward" | "full";
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

/**
 * Live Uniswap V3 LP re-centring — the strategy the passive-LP backtest
 * (`src/lp/passiveLp.ts`) models. One concentrated position is held around the
 * current price; when price drifts `thresholdTicks` from the position centre,
 * the position is closed, fees collected, tokens rebalanced and a fresh
 * position minted at the new centre.
 *
 * Range and trigger are configured in percent so the numbers carry straight
 * over from `results/<label>/lp-optimization.csv` (`range_pct`,
 * `recenter_buffer_pct`); they are converted to ticks at load time.
 */
export interface ContractAddresses {
  /** Uniswap V3 NonfungiblePositionManager. */
  positionManager: `0x${string}`;
  /** SwapRouter02. */
  swapRouter: `0x${string}`;
  /** QuoterV2. */
  quoter: `0x${string}`;
  /** Aave V3 Pool. */
  aavePool: `0x${string}`;
}

/** Base mainnet deployments. */
export const BASE_CONTRACTS: ContractAddresses = {
  positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
};

export interface LpRebalanceConfig {
  /** Half-width of the managed range, in ticks. */
  widthTicks: number;
  /** Re-centre once |tick - centre| reaches this many ticks. */
  thresholdTicks: number;
  /** Half-width in percent, as configured. Kept for logging/provenance. */
  rangePct: number;
  /**
   * Trigger buffer in percent, as configured: the position is allowed to sit
   * out of range by `rangePct * recenterBufferPct / 100` before re-centring.
   */
  recenterBufferPct: number;
  /** Minimum hours between re-centres. Mirrors the backtest cooldown. */
  recenterMinHours: number;
  positionManagerAddress: `0x${string}`;
  swapRouterAddress: `0x${string}`;
  quoterAddress: `0x${string}`;
  slippageBps: number;
  /** Position NFT to manage. 0 = mint a fresh one from wallet balances. */
  positionId: bigint;
  /** Where the managed token id is persisted across restarts. */
  stateFile: string;
  /** Plan and log every step without broadcasting a transaction. */
  dryRun: boolean;
  /**
   * Stand aside in cash while the trailing move over `regimeLookbackHours`
   * exceeds this percent. 0 disables the filter.
   *
   * Walk-forward on 5-minute data says this is the only intervention that
   * reliably cuts tail risk (worst fold -29.7% -> ~-10%), at the cost of
   * being out of the market most of the time. See docs/LP_REBALANCE.md.
   */
  regimeMaxMovePct: number;
  /**
   * Hysteresis on re-entry, percent of `regimeMaxMovePct`.
   *
   * The filter EXITS when |move| > regimeMaxMovePct but only RE-ENTERS when
   * |move| < regimeMaxMovePct * (1 - margin/100). Without the gap the bot
   * flips park/deploy on every oscillation around the threshold, paying a
   * full sell + buy-back spread each flip. 0 restores symmetric behaviour.
   */
  regimeReenterMarginPct: number;
  /**
   * Lookback window in HOURS. The backtest expresses this in observations,
   * which depends on the data resolution: 2016 observations of 5-minute data
   * is 168 hours.
   */
  regimeLookbackHours: number;
  /** How often the price history is sampled, minutes. */
  regimeSampleMinutes: number;
  /**
   * Price CSV used to pre-fill the regime window at startup, or null to start
   * blind.
   *
   * Deliberately NOT `CSV_FILE`: that defaults to generated sample data for
   * backtesting, and seeding a live risk filter from synthetic prices would
   * produce a confident, meaningless verdict.
   */
  seedFile: string | null;
}

export interface AppConfig {
  mode: Mode;
  /**
   * Contract addresses, resolved once here so every executor honours the same
   * overrides. Defaults are the Base mainnet deployments; set the matching
   * env var to point at another chain or a fork.
   */
  contracts: ContractAddresses;
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
  /**
   * Daily Aave supply-APR series (`date,apr_pct`). When set, idle USDC above
   * LEND_BUFFER_USDC earns lending yield in backtests. Empty = disabled.
   */
  aaveYieldFile: string | null;
  /** USDC kept out of the yield-bearing pool in backtests (USD). */
  lendBufferUsdc: number;
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
  /**
   * Structured gas model. Defaults reproduce the flat per-fill behaviour
   * (overhead 0, lending leg 0) so existing results are unchanged.
   */
  gas: GasModel;
  /** Charge money-market legs on trading transactions. */
  lendingGasLegs: boolean;
  grid: GridSettings;
  optimizer: OptimizerConfig;
  /** Passive LP sweep axes; undefined uses the defaults. */
  lpAxes?: LpAxes;
  /** Live LP re-centring settings. Only used by `lp-live`. */
  lpRebalance: LpRebalanceConfig;

  // --- Aave lending of idle liquidity ---
  lendingEnabled: boolean;
  aavePool: `0x${string}`;
  aUsdc: `0x${string}`;
  aWeth: `0x${string}`;
  variableDebtUsdc: `0x${string}`;
  variableDebtWeth: `0x${string}`;
  lendBufferUsdcUsd: number;
  lendBufferEth: number;
  lendMinActionUsd: number;
  lendIntervalSeconds: number;

  // --- Short hedge while parked (requires lendingEnabled) ---
  /**
   * When the regime filter parks, borrow WETH against the supplied collateral
   * and sell it, so parked capital is flat against ETH instead of merely
   * uninvested. Off by default: it adds borrow-rate carry and two swap legs
   * per park/unpark cycle.
   */
  hedgeEnabled: boolean;
  /** Percent of the ETH-side exposure to short. */
  hedgeRatioPct: number;
  /** Hard safety cap on borrowed value vs supplied collateral, percent. */
  hedgeMaxLtvPct: number;

  // --- soak reporting ---
  soakLogFile: string;
  /** Show only the last N days in the report; 0 = all. */
  soakDays: number;
}

/** Convert a +/-pct half-width into ticks (1.0001^tick = price ratio). */
export function pctToTicks(pct: number): number {
  return Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
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
  const contracts: ContractAddresses = {
    positionManager: (env("POSITION_MANAGER_ADDRESS") ??
      BASE_CONTRACTS.positionManager) as `0x${string}`,
    swapRouter: (env("SWAP_ROUTER_ADDRESS") ?? BASE_CONTRACTS.swapRouter) as `0x${string}`,
    quoter: (env("QUOTER_ADDRESS") ?? BASE_CONTRACTS.quoter) as `0x${string}`,
    aavePool: (env("AAVE_POOL") ?? BASE_CONTRACTS.aavePool) as `0x${string}`,
  };

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
    aaveYieldFile: env("AAVE_YIELD_FILE") ?? null,
    lendBufferUsdc: num("LEND_BUFFER_USDC", 0),
    minPoolTvlUsd: num("LP_MIN_POOL_TVL_USD", 0),
    runLabel: env("RUN_LABEL") ?? mode,
    contracts,
    pollIntervalSeconds: num("POLL_INTERVAL_SECONDS", 30),
    estimatedGasUsd: num("ESTIMATED_GAS_USD", 0.02),
    gas: {
      txOverheadUsd: num("GAS_TX_OVERHEAD_USD", 0),
      perFillUsd: num("GAS_PER_FILL_USD", num("ESTIMATED_GAS_USD", 0.02)),
      lendingLegUsd: num("GAS_LENDING_LEG_USD", 0),
    },
    lendingGasLegs: bool("GAS_LENDING_LEGS", false),
    // Aave lending of idle liquidity (defaults = official Base deployments)
    lendingEnabled: (env("ENABLE_AAVE") ?? "false").toLowerCase() === "true",
    aavePool: contracts.aavePool,
    aUsdc: (env("A_USDC") ?? "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB") as `0x${string}`,
    aWeth: (env("A_WETH") ?? "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7") as `0x${string}`,
    variableDebtUsdc: (env("VARIABLE_DEBT_USDC") ??
      "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28") as `0x${string}`,
    variableDebtWeth: (env("VARIABLE_DEBT_WETH") ??
      "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E") as `0x${string}`,
    // Buffers default to ZERO: all idle assets are lent. Grid fills
    // auto-withdraw any shortfall from Aave just-in-time instead.
    lendBufferUsdcUsd: num("LEND_BUFFER_USDC", 0),
    lendBufferEth: num("LEND_BUFFER_ETH", 0),
    lendMinActionUsd: num("LEND_MIN_ACTION_USD", 100),
    lendIntervalSeconds: num("LEND_INTERVAL_SECONDS", 3600),
    hedgeEnabled: bool("HEDGE_ENABLED", false),
    hedgeRatioPct: num("HEDGE_RATIO_PCT", 50),
    hedgeMaxLtvPct: num("HEDGE_MAX_LTV_PCT", 40),
    soakLogFile: env("SOAK_LOG_FILE") ?? "paper.log",
    soakDays: Math.trunc(num("SOAK_DAYS", 0)),
    grid: {
      // Capital
      initialUsdc: num("INITIAL_USDC", 10_000),
      initialEth: num("INITIAL_ETH", 0),
      centerPrice: num("GRID_CENTER_PRICE", 4_000),
      spacingPercent: num("GRID_SPACING_PERCENT", 1),
      levelsAbove: Math.trunc(num("GRID_LEVELS_ABOVE", 5)),
      levelsBelow: Math.trunc(num("GRID_LEVELS_BELOW", 5)),
      orderSizeUsd: num("ORDER_SIZE_USD", 0), // 0 => auto (capital / level count)
      // Default "taker" preserves the shipped executor's economics.
      executionMode: (env("EXECUTION_MODE") ?? "taker") === "lp" ? "lp" : "taker",
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
      lpReferenceRangePct: num("LP_REFERENCE_RANGE_PCT", 25),
      // Causal regime filter (0 = off).
      regimeMaxMovePct: num("REGIME_MAX_MOVE_PCT", 0),
      regimeLookbackPoints: Math.trunc(num("REGIME_LOOKBACK_POINTS", 24 * 14)),
      regenMinSeconds: num("GRID_REGEN_MIN_SECONDS", 6 * 3600),
      volLookbackPoints: Math.trunc(num("GRID_VOL_LOOKBACK", 24)),
      maxVolPerStep: num("GRID_MAX_VOL_PER_STEP", 0.005),
      // Smart-reset guards (defaults preserve legacy behavior)
      resetConfirmObservations: Math.trunc(num("RESET_CONFIRM_OBSERVATIONS", 0)),
      resetVolPostpone: bool("RESET_VOL_POSTPONE", false),
      resetHardDrawdownPct: num("RESET_HARD_DRAWDOWN_PCT", 25),
      // Circuit breaker on clustered resets
      resetSkipCooldownWhenFlat: bool("RESET_SKIP_COOLDOWN_WHEN_FLAT", false),
      resetHardInventoryLossPct: num("RESET_HARD_INVENTORY_LOSS_PCT", 0),
      resetBreakerK: Math.trunc(num("GRID_BREAKER_RESETS", 3)),
      resetBreakerWindowSeconds: num("GRID_BREAKER_WINDOW_SECONDS", 30 * 24 * 3600),
    },
    lpRebalance: (() => {
      const rangePct = num("LP_RANGE_PCT", 5);
      const bufferPct = num("LP_RECENTER_BUFFER_PCT", 50);
      const widthTicks = Math.trunc(num("LP_WIDTH_TICKS", pctToTicks(rangePct)));
      // Backtest convention (src/lp/passiveLp.ts): the trigger sits at the
      // range edge plus `bufferPct` of the half-width, so the same numbers
      // that win the sweep drive the live bot unchanged.
      const thresholdTicks = Math.trunc(
        num("LP_THRESHOLD_TICKS", pctToTicks(rangePct * (1 + bufferPct / 100))),
      );
      return {
        widthTicks,
        thresholdTicks,
        rangePct,
        recenterBufferPct: bufferPct,
        recenterMinHours: num("LP_RECENTER_MIN_HOURS", 24),
        positionManagerAddress: contracts.positionManager,
        swapRouterAddress: contracts.swapRouter,
        quoterAddress: contracts.quoter,
        slippageBps: num("LP_SLIPPAGE_BPS", 50),
        positionId: BigInt(Math.trunc(num("POSITION_ID", 0))),
        stateFile: env("STATE_FILE") ?? "state/position.json",
        dryRun: bool("DRY_RUN", true),
        regimeMaxMovePct: num("REGIME_MAX_MOVE_PCT", 0),
        regimeReenterMarginPct: num("LP_REGIME_REENTER_MARGIN_PCT", 25),
        regimeLookbackHours: num("LP_REGIME_LOOKBACK_HOURS", 168),
        regimeSampleMinutes: num("LP_REGIME_SAMPLE_MINUTES", 60),
        seedFile: env("LP_SEED_FILE") ?? null,
      };
    })(),
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
        skipFlatCooldowns: numList("OPTIMIZER_SKIP_FLAT_COOLDOWNS", []),
        confirmObservations: numList("OPTIMIZER_CONFIRM_OBSERVATIONS", []),
        volPostpones: numList("OPTIMIZER_VOL_POSTPONES", []),
        hardDrawdowns: numList("OPTIMIZER_HARD_DRAWDOWNS", []),
      },
      metric: parseRankMetric(env("OPTIMIZER_METRIC")),
      top: Math.trunc(num("OPTIMIZER_TOP", 15)),
      trainFraction: num("OPTIMIZER_TRAIN_FRACTION", 0.6),
      selection:
        (env("OPTIMIZER_SELECTION") ?? "walk-forward").toLowerCase() === "full"
          ? ("full" as const)
          : ("walk-forward" as const),
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
  if (mode === "lp-live") {
    if (!cfg.poolAddress) throw new Error("POOL_ADDRESS is required in lp-live mode");
    if (!cfg.rpcUrls.length) throw new Error("RPC_URL is required in lp-live mode");
    if (!cfg.privateKey && !cfg.lpRebalance.dryRun) {
      throw new Error("PRIVATE_KEY is required in lp-live mode unless DRY_RUN=true");
    }
  }
  if (mode === "live" && !cfg.privateKey) {
    throw new Error("PRIVATE_KEY is required in live mode");
  }

  return cfg;
}
