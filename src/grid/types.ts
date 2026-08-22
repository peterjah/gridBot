/**
 * Grid strategy types. Everything in src/grid is PURE: no blockchain, no IO.
 * The strategy operates on price + inventory and emits actions.
 */

export type Side = "BUY" | "SELL";

export interface GridConfig {
  /** Starting USDC balance (quote asset). */
  initialUsdc: number;
  /** Starting ETH balance (base asset). */
  initialEth: number;
  /** Anchor price of the grid (human-readable USD per ETH). */
  centerPrice: number;
  /** Multiplicative spacing between levels, e.g. 1 = 1%. */
  spacingPercent: number;
  levelsAbove: number;
  levelsBelow: number;
  /** Notional USD size of each grid order. */
  orderSizeUsd: number;
  /** Swap fee modeled on every fill (basis points). */
  feeBps: number;
  /** Slippage modeled on every fill (basis points). */
  slippageBps: number;
  /** Floor on ETH inventory value (USD) — stops sells below this. */
  minEthUsd: number;
  /** Ceiling on ETH inventory value (USD) — stops buys above this. */
  maxEthUsd: number;
  /**
   * Grid reset (re-centering): when price moves this many spacings beyond the
   * outermost level, the grid is liquidated to USDC and rebuilt after the
   * cooldown conditions pass. 0 disables resetting.
   */
  resetBufferLevels: number;
  /**
   * Fraction of the ETH inventory sold when a reset fires, in [0, 1].
   * 1 (the default) is the original behavior: dump everything. Lower values
   * carry inventory into the next grid, converting a realized reset loss into
   * an unrealized one that the new grid can sell back on a recovery.
   */
  resetSellFraction: number;
  /**
   * When > 0, a reset carries its inventory instead of selling it if the
   * position is underwater by more than this percentage against its cost
   * basis. 0 (the default) disables the check, so every reset liquidates.
   *
   * The point is to stop crystallizing the worst losses at the bottom of a
   * move; the cost is that inventory can accumulate across resets, so this is
   * only safe alongside an inventory ceiling (maxEthUsd).
   */
  resetUnderwaterSkipPct: number;
  /**
   * LP fee income model. The grid's resting orders are treated as
   * concentrated liquidity: while the grid is ACTIVE and price sits inside
   * its band, it earns a pro-rata share of the fees paid on volume routed
   * through that range.
   *
   *   poolVolume = referenceVolumeUsd * lpVenueVolumeSharePct/100
   *   myShare    = myValueInRange / (myValueInRange + lpPoolLiquidityUsd)
   *   feeIncome  = poolVolume * lpFeeBps/10000 * myShare
   *
   * The pro-rata term is what makes this physical: fee income scales with the
   * capital you actually have in range and dilutes as the pool gets deeper.
   * A model that credits volume * someRate without it pays the same fees to a
   * $1k position as to a $1M one, which is nonsense.
   *
   * `lpVenueVolumeSharePct` is the share of the reference volume in the data
   * (e.g. a CEX feed) that trades on YOUR pool. `lpPoolLiquidityUsd` is the
   * competing liquidity sitting in your range. Set lpPoolLiquidityUsd to 0 to
   * disable fee income — the default, and the behavior of the bot as actually
   * implemented, which swaps and therefore PAYS fees rather than earning them.
   */
  lpFeeBps: number;
  lpVenueVolumeSharePct: number;
  lpPoolLiquidityUsd: number;
  /**
   * Alternative, directly-observable calibration: the pool's annualized base
   * fee APR (fee income per unit of TVL). When > 0 this takes precedence over
   * the volume-share model above, and a per-observation APR supplied with the
   * price data overrides it again.
   *
   *   income = positionValue * apr/100 * elapsedSeconds/year
   *
   * This is preferred because `apyBase` is published per pool and measured,
   * whereas venue volume share and in-range depth have to be guessed
   * separately and multiply their errors together.
   */
  lpFeeAprPct: number;
  /**
   * Causal regime filter: when the trailing move over `regimeLookbackPoints`
   * observations exceeds this percentage in either direction, the grid resets
   * and stays down until the market calms. 0 (the default) disables it.
   *
   * Deliberately uses only PAST observations — selecting calm periods with
   * hindsight is lookahead bias and would invent returns that cannot be had.
   */
  regimeMaxMovePct: number;
  regimeLookbackPoints: number;
  /** Minimum seconds in cooldown before the grid may be rebuilt. */
  regenMinSeconds: number;
  /** Number of recent observations used for the volatility estimate. */
  volLookbackPoints: number;
  /** Rebuild only when per-observation realized volatility drops below this. */
  maxVolPerStep: number;
  /**
   * Circuit breaker: when this many resets happen within
   * resetBreakerWindowSeconds, the required cooldown doubles per extra batch.
   */
  resetBreakerK: number;
  resetBreakerWindowSeconds: number;
}

export interface GridLevelState {
  index: number;
  price: number;
  /** Resting order at this level; null = no active order. */
  side: Side | null;
}

export interface TradeRecord {
  seq: number;
  timestamp: number;
  side: "BUY" | "SELL";
  /** null for reset liquidations (no grid level involved). */
  levelIndex: number | null;
  levelPrice: number;
  /** Actual execution price after fees/slippage. */
  fillPrice: number;
  ethAmount: number;
  usdAmount: number;
  feeUsd: number;
  slippageUsd: number;
  /**
   * Gas charged on this fill (USD). The strategy is gas-agnostic; the
   * backtester stamps this after the fill. Always present, 0 by default.
   */
  gasUsd: number;
  /**
   * For grid SELLs: profit vs the cost basis of the consumed lots, valued at
   * LEVEL prices on both sides. Fees/slippage are NEVER folded in here —
   * they are tracked separately so the three P&L sources stay distinct.
   */
  realizedGridGrossUsd?: number;
  /** Same, but for ETH liquidated during a reset (inventory P&L). */
  realizedResetGrossUsd?: number;
  /** Cost basis consumed by this SELL (USD, at level prices). */
  costBasisConsumedUsd?: number;
  /** true when this fill is part of a reset liquidation. */
  liquidation?: boolean;
  /**
   * Which inter-reset interval this fill belongs to. 0 = before the first
   * reset. Aggregating the ledger by this key yields the "since previous
   * reset" figures without the strategy having to duplicate the accounting.
   */
  intervalId: number;
  /** Set only on liquidation fills: the 1-based reset they were part of. */
  resetId: number | null;
  /** Balances immediately after the fill (gas not yet applied). */
  ethBalanceAfter: number;
  usdcBalanceAfter: number;
  /** Portfolio value after the fill, marked at `levelPrice`. */
  portfolioValueAfter: number;
}

export interface SkipRecord {
  side: Side;
  reason: "no_usdc" | "max_eth" | "no_eth" | "min_eth" | "dust" | "high_vol";
}

/**
 * Why a reset happened. Only PRICE_OUTSIDE_GRID is produced today; the union
 * exists so new triggers can be added without changing the reporting layer.
 */
export type ResetReason =
  | "PRICE_OUTSIDE_GRID"
  | "INVENTORY_LIMIT"
  | "REGIME_FILTER"
  | "MANUAL";

/** Grid geometry at a point in time. */
export interface GridBounds {
  center: number;
  lower: number;
  upper: number;
}

/** One grid re-centering: liquidation of inventory + rebuild at a new center. */
export interface ResetRecord {
  /** 1-based reset number. */
  id: number;
  reason: ResetReason;
  /** Time the inventory was liquidated and the grid entered cooldown. */
  timestamp: number;
  /** Time the new grid was built; null while still in cooldown. */
  rebuiltAt: number | null;
  /** ETH price that triggered the reset. */
  price: number;

  oldBounds: GridBounds;
  /** null while still in cooldown (grid not rebuilt yet). */
  newBounds: GridBounds | null;

  ethInventoryBefore: number;
  usdcBefore: number;
  /** Volume-weighted acquisition price of the liquidated inventory. */
  ethAvgCostPrice: number;
  /** Total cost basis of the liquidated inventory (USD). */
  ethCostBasisUsd: number;
  /** ETH actually sold at this reset (may be less than the inventory). */
  ethLiquidated: number;
  /** ETH deliberately carried into the next grid instead of being sold. */
  ethCarried: number;
  /** Why the inventory was not fully liquidated, when it was not. */
  carryReason: "NONE" | "PARTIAL_POLICY" | "UNDERWATER" | null;
  /** USDC actually received from the liquidation, after fees/slippage. */
  usdcRecovered: number;
  /** Inventory P&L at level prices: soldEth * price - costBasis. */
  realizedResetPnlUsd: number;

  /** Grid-only P&L accrued since the previous reset (gross, at level prices). */
  gridGrossSincePrevUsd: number;
  /** Same, minus the fees/slippage/gas charged over the interval. */
  gridNetSincePrevUsd: number;
  feesSincePrevUsd: number;
  slippageSincePrevUsd: number;
  /** Filled in by the backtester (the strategy does not model gas). */
  gasSincePrevUsd: number;
  /** LP fee income earned since the previous reset. */
  feeIncomeSincePrevUsd: number;

  portfolioValueBefore: number;
  portfolioValueAfter: number;
  /** Filled in by the backtester from the equity curve. */
  drawdownBeforePct: number;
}

/** One entry in the grid-center evolution history. */
export interface CenterChange {
  timestamp: number;
  resetId: number;
  oldCenter: number;
  newCenter: number;
  oldLowerBound: number;
  oldUpperBound: number;
  newLowerBound: number;
  newUpperBound: number;
}

export type Phase = "ACTIVE" | "COOLDOWN";

export interface GridState {
  usdc: number;
  eth: number;
  lastPrice: number | null;
  /** Current grid center (moves on reset). */
  centerPrice: number;
  phase: Phase;
  cooldownStartedAt: number | null;
  /** Number of completed grid regenerations. */
  resets: number;
  levels: GridLevelState[];
  trades: TradeRecord[];
  skips: SkipRecord[];
  /**
   * Total realized gross P&L = grid + reset. Kept for convenience; the two
   * components below are the meaningful ones and must never be conflated.
   */
  realizedGrossUsd: number;
  /** Profit from completed grid buy -> sell cycles (at level prices). */
  realizedGridGrossUsd: number;
  /** Profit/loss from inventory liquidated during resets (at level prices). */
  realizedResetGrossUsd: number;
  /** LP fee income earned while the grid rested in range. A revenue source
   *  in its own right — never folded into grid P&L. */
  feeIncomeUsd: number;
  completedCycles: number;
  totalFeeUsd: number;
  totalSlippageUsd: number;
  /** Cost basis of the ETH currently held (USD, at level prices). */
  costBasisUsd: number;
  /** Volume-weighted acquisition price of the ETH currently held. */
  avgCostPrice: number;
  resetRecords: ResetRecord[];
  centerHistory: CenterChange[];
}

/** Explicit strategy output. An empty array means HOLD. */
export type StrategyAction =
  | {
      type: "BUY";
      price: number;
      quoteAmount: number;
      gridLevel: number;
    }
  | {
      type: "SELL";
      price: number;
      baseAmount: number;
      gridLevel: number;
    }
  | {
      type: "LIQUIDATE";
      price: number;
      baseAmount: number;
      reason: "grid_exited";
    };

/**
 * Cost model applied to fills. The backtest uses a deterministic linear
 * fee+slippage model; live trading replaces this with real quotes/fills.
 */
export interface FillModel {
  quoteBuy(levelPrice: number, quoteUsd: number): {
    ethOut: number;
    effectivePrice: number;
    feeUsd: number;
    slippageUsd: number;
  };
  quoteSell(levelPrice: number, ethIn: number): {
    usdcOut: number;
    effectivePrice: number;
    feeUsd: number;
    slippageUsd: number;
  };
}
