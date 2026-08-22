import type {
  CenterChange,
  FillModel,
  GridBounds,
  GridConfig,
  GridLevelState,
  GridState,
  Phase,
  ResetRecord,
  ResetReason,
  StrategyAction,
  TradeRecord,
} from "./types.js";

/**
 * An inventory lot. `costUsd` is the LEVEL-price notional of the ETH bought
 * (i.e. excluding fee/slippage), never the raw USDC spent. Keeping fees out
 * of the cost basis is what makes grid P&L, inventory P&L and trading costs
 * three mathematically distinct quantities — see docs/ACCOUNTING.md.
 */
interface Lot {
  eth: number;
  costUsd: number;
  /**
   * true for the pre-existing `initialEth` booked at the first observation.
   * Seed inventory carries a cost basis (so P&L reconciles) but is NOT a grid
   * lot: it must not influence grid sell sizing, and closing it does not
   * complete a grid cycle.
   */
  seed?: boolean;
}

const DUST_USD = 1e-9;
const SECONDS_PER_YEAR = 365 * 24 * 3600;
/** A grid cycle must clear at least this multiple of per-fill costs. */
const COST_SPACING_FACTOR = 10;

/**
 * Systematic grid market-making strategy.
 *
 * PURE: no blockchain, no IO, no randomness. Feed it prices, receive actions.
 *
 * Model
 * -----
 * Levels: level[i] = centerPrice * (1 + spacing)^i for i in
 * [-levelsBelow .. levelsAbove]. The center level (i = 0) has no resting
 * order. Initially every level above the center rests a SELL and every level
 * below rests a BUY.
 *
 * When price crosses a resting order's level (in either direction between two
 * observations — multiple crossings in one move are processed in order), the
 * order executes:
 *
 *   BUY  at level i  ->  place SELL at level i+1   (sell one spacing higher)
 *   SELL at level i  ->  place BUY  at level i-1   (buy one spacing lower)
 *
 * This gives the classic grid behavior: each buy is paired with a sell one
 * spacing above, so oscillation around any level harvests the spread, and a
 * single observation that jumps several levels executes every crossed level.
 *
 * Inventory limits (minEthUsd / maxEthUsd) stop trades that would push ETH
 * exposure past the configured bounds; skipped trades are counted and
 * reported, never silently dropped.
 *
 * Accounting
 * ----------
 * Realized P&L is split at the source and never merged:
 *   - `realizedGridGrossUsd`  profit from completed grid buy -> sell cycles
 *   - `realizedResetGrossUsd` profit/loss on inventory dumped during a reset
 *   - `totalFeeUsd` / `totalSlippageUsd`  trading costs (gas is charged by the
 *     environment, not here)
 * At any time:
 *   portfolioValue = initialCapital + gridGross + resetGross + unrealized
 *                    - fees - slippage - externalDebits(gas)
 */
export class GridStrategy {
  private readonly cfg: GridConfig;
  private readonly fills: FillModel;

  private usdc!: number;
  private eth!: number;
  private lastPrice: number | null = null;
  /** Timestamp of the previous observation, for time-weighted fee accrual. */
  private lastTimestamp = 0;
  /** Current grid center — moves on reset. */
  private center!: number;
  private levels: GridLevelState[] = [];
  private lots: Lot[] = [];

  private phase: Phase = "ACTIVE";
  private cooldownStartedAt: number | null = null;
  private resets = 0;
  /** Timestamps of past resets, used by the circuit breaker. */
  private resetTimes: number[] = [];
  /** Rolling recent prices for the volatility estimate (oldest first). */
  private priceHistory: number[] = [];
  /** Longer rolling window used by the causal regime filter. */
  private regimeHistory: number[] = [];

  private readonly trades: TradeRecord[] = [];
  private readonly skips: GridState["skips"] = [];
  private readonly resetRecords: ResetRecord[] = [];
  private readonly centerHistory: CenterChange[] = [];
  private seq = 0;
  private realizedGridGrossUsd = 0;
  private realizedResetGrossUsd = 0;
  private completedCycles = 0;
  private totalFeeUsd = 0;
  private totalSlippageUsd = 0;
  private feeIncomeUsd = 0;
  /** Cumulative fee income as of the previous reset, for interval reporting. */
  private feeIncomeAtLastReset = 0;
  private externalDebitsUsd = 0;
  /** Capital at the first observation; the reconciliation anchor. */
  private initialCapitalUsd = 0;

  constructor(config: GridConfig, fillModel: FillModel) {
    this.cfg = config;
    this.fills = fillModel;
    this.initialize();
  }

  initialize(): void {
    const { spacingPercent } = this.cfg;
    if (!(this.cfg.centerPrice > 0)) throw new Error("centerPrice must be > 0");
    if (!(spacingPercent >= 0) || spacingPercent >= 100) {
      throw new Error("spacingPercent must be in [0, 100)");
    }
    if (!(this.cfg.orderSizeUsd > 0)) throw new Error("orderSizeUsd must be > 0");

    // Cost-aware spacing: a grid cycle must be able to pay for itself.
    // Require the per-cycle spread to be at least COST_SPACING_FACTOR times
    // the total per-fill cost (fee + slippage).
    const costFrac = (this.cfg.feeBps + this.cfg.slippageBps) / 10_000;
    const minSpacingPercent = COST_SPACING_FACTOR * costFrac * 100;
    if (this.cfg.spacingPercent < minSpacingPercent) {
      throw new Error(
        `spacing ${this.cfg.spacingPercent}% is below the cost-aware minimum of ` +
          `${minSpacingPercent.toFixed(3)}% (fees ${this.cfg.feeBps}bps + slippage ` +
          `${this.cfg.slippageBps}bps x${COST_SPACING_FACTOR}); widen the grid or lower costs`,
      );
    }

    this.usdc = this.cfg.initialUsdc;
    this.eth = this.cfg.initialEth;
    this.lastPrice = null;
    this.lastTimestamp = 0;
    this.lots = [];
    this.trades.length = 0;
    this.skips.length = 0;
    this.resetRecords.length = 0;
    this.centerHistory.length = 0;
    this.seq = 0;
    this.realizedGridGrossUsd = 0;
    this.realizedResetGrossUsd = 0;
    this.completedCycles = 0;
    this.totalFeeUsd = 0;
    this.totalSlippageUsd = 0;
    this.feeIncomeUsd = 0;
    this.feeIncomeAtLastReset = 0;
    this.externalDebitsUsd = 0;
    this.initialCapitalUsd = 0;
    this.phase = "ACTIVE";
    this.cooldownStartedAt = null;
    this.resets = 0;
    this.resetTimes = [];
    this.priceHistory = [];
    this.regimeHistory = [];

    this.center = this.cfg.centerPrice;
    this.buildLevels();
  }

  /**
   * Process one price observation. Returns the executed actions in order.
   */
  onPriceUpdate(
    price: number,
    timestamp: number,
    market: { volumeUsd?: number; feeAprPct?: number; poolTvlUsd?: number } = {},
  ): StrategyAction[] {
    if (!(price > 0)) throw new Error(`Invalid price: ${price}`);
    this.pushHistory(price);

    if (this.lastPrice === null) {
      this.lastPrice = price;
      this.lastTimestamp = timestamp;
      // Pre-existing ETH is booked as a lot at the first observed price so
      // that cost basis (and therefore unrealized P&L) reconciles with the
      // initial capital from the very first sample.
      if (this.eth > 0) {
        this.lots.push({ eth: this.eth, costUsd: this.eth * price, seed: true });
      }
      this.initialCapitalUsd = this.usdc + this.eth * price;
      return [];
    }
    const prev = this.lastPrice;
    const elapsedSeconds = Math.max(0, timestamp - this.lastTimestamp);
    this.lastPrice = price;
    this.lastTimestamp = timestamp;

    const actions: StrategyAction[] = [];

    // LP fee income accrues whenever the grid is live and in range, whether
    // or not a level was crossed — that is what holding liquidity earns.
    this.accrueFees(price, market, elapsedSeconds);

    // Grid levels only trade while ACTIVE.
    if (this.phase === "ACTIVE" && price !== prev) {
      if (price < prev) {
        const crossed = this.levels
          .filter((l) => l.side === "BUY" && l.price < prev && l.price >= price)
          .sort((a, b) => b.price - a.price);
        for (const level of crossed) {
          const action = this.executeBuy(level, price, timestamp);
          if (action) actions.push(action);
        }
      } else {
        const crossed = this.levels
          .filter((l) => l.side === "SELL" && l.price > prev && l.price <= price)
          .sort((a, b) => a.price - b.price);
        for (const level of crossed) {
          const action = this.executeSell(level, price, timestamp);
          if (action) actions.push(action);
        }
      }

      // Check whether price has left the grid band, or the regime filter has
      // tripped; either flattens the book and starts a cooldown.
      if (this.checkGridExit(price)) {
        actions.push(...this.liquidate(price, timestamp, "PRICE_OUTSIDE_GRID"));
      } else if (this.regimeHostile()) {
        actions.push(...this.liquidate(price, timestamp, "REGIME_FILTER"));
      }
    } else if (this.phase === "COOLDOWN") {
      const rebuilt = this.maybeRebuild(price, timestamp);
      void rebuilt;
    }

    return actions;
  }

  getState(): GridState {
    return {
      usdc: this.usdc,
      eth: this.eth,
      lastPrice: this.lastPrice,
      centerPrice: this.center,
      phase: this.phase,
      cooldownStartedAt: this.cooldownStartedAt,
      resets: this.resets,
      levels: this.levels.map((l) => ({ ...l })),
      trades: [...this.trades],
      skips: [...this.skips],
      realizedGrossUsd: this.realizedGridGrossUsd + this.realizedResetGrossUsd,
      realizedGridGrossUsd: this.realizedGridGrossUsd,
      realizedResetGrossUsd: this.realizedResetGrossUsd,
      feeIncomeUsd: this.feeIncomeUsd,
      completedCycles: this.completedCycles,
      totalFeeUsd: this.totalFeeUsd,
      totalSlippageUsd: this.totalSlippageUsd,
      costBasisUsd: this.costBasisUsd(),
      avgCostPrice: this.avgCostPrice(),
      resetRecords: this.resetRecords.map((r) => ({ ...r })),
      centerHistory: [...this.centerHistory],
    };
  }

  getPortfolioValue(price: number): number {
    return this.usdc + this.eth * price;
  }

  /** Cheap balance accessors — `getState()` deep-copies and is not hot-loop safe. */
  get usdcBalance(): number {
    return this.usdc;
  }

  get ethBalance(): number {
    return this.eth;
  }

  get config(): GridConfig {
    return this.cfg;
  }

  /** Total cost basis (level-price notional) of the ETH currently held. */
  costBasisUsd(): number {
    return this.lots.reduce((sum, l) => sum + l.costUsd, 0);
  }

  /** Volume-weighted acquisition price of the ETH currently held. */
  avgCostPrice(): number {
    const eth = this.lots.reduce((sum, l) => sum + l.eth, 0);
    return eth > DUST_USD ? this.costBasisUsd() / eth : 0;
  }

  /** Unrealized P&L on the open inventory at `price`. */
  unrealizedPnlUsd(price: number): number {
    return this.eth * price - this.costBasisUsd();
  }

  /** Capital measured at the first observation (0 before it arrives). */
  get initialCapital(): number {
    return this.initialCapitalUsd;
  }

  /** Cumulative external debits (gas) applied via applyExternalDebit. */
  get externalDebits(): number {
    return this.externalDebitsUsd;
  }

  /** Cumulative LP fee income credited to the balance. */
  get feeIncome(): number {
    return this.feeIncomeUsd;
  }

  /** Bounds of the grid as currently centered. */
  bounds(): GridBounds {
    const step = 1 + this.cfg.spacingPercent / 100;
    return {
      center: this.center,
      lower: this.center * Math.pow(step, -this.cfg.levelsBelow),
      upper: this.center * Math.pow(step, this.cfg.levelsAbove),
    };
  }

  /** Interval index a fill belongs to: how many resets happened before it. */
  private get intervalId(): number {
    return this.resetRecords.length;
  }

  /**
   * Controlled debit from the USDC balance for environment costs (e.g. gas)
   * that the strategy itself does not model. Used by the backtester.
   */
  applyExternalDebit(amountUsd: number): void {
    this.usdc -= amountUsd;
    this.externalDebitsUsd += amountUsd;
  }

  /**
   * Force a reset from outside the strategy (reason MANUAL). Present so the
   * reset data model is genuinely extensible; nothing calls it in the default
   * strategy path.
   */
  forceReset(price: number, timestamp: number, reason: ResetReason = "MANUAL"): StrategyAction[] {
    if (this.phase !== "ACTIVE") return [];
    return this.liquidate(price, timestamp, reason);
  }

  // ------------------------------------------------------------------ buys

  private executeBuy(
    level: GridLevelState,
    currentPrice: number,
    timestamp: number,
  ): StrategyAction | null {
    // Volatility gate: stop accumulating into violent moves (the regimes
    // that tend to end in liquidations). Sells remain allowed to de-risk.
    const vol = this.realizedVolatility();
    if (vol !== null && vol > this.cfg.maxVolPerStep) {
      this.skips.push({ side: "BUY", reason: "high_vol" });
      return null;
    }

    let quote = Math.min(this.cfg.orderSizeUsd, this.usdc);

    // Respect max ETH exposure ceiling.
    const ethValue = this.eth * currentPrice;
    if (ethValue >= this.cfg.maxEthUsd) {
      this.skips.push({ side: "BUY", reason: "max_eth" });
      return null;
    }
    const headroomUsd = this.cfg.maxEthUsd - ethValue;
    quote = Math.min(quote, headroomUsd);

    if (quote < DUST_USD || this.usdc < DUST_USD) {
      this.skips.push({ side: "BUY", reason: quote < DUST_USD ? "max_eth" : "no_usdc" });
      return null;
    }
    if (quote < this.cfg.orderSizeUsd * 0.5) {
      // Fragmenting orders into tiny dust fills is not worth gas.
      this.skips.push({ side: "BUY", reason: "dust" });
      return null;
    }

    const fill = this.fills.quoteBuy(level.price, quote);
    this.usdc -= quote;
    this.eth += fill.ethOut;
    // Cost basis excludes the fee/slippage paid — those are counted once, in
    // the cost accumulators below, and never inside P&L.
    this.lots.push({ eth: fill.ethOut, costUsd: fill.ethOut * level.price });
    this.totalFeeUsd += fill.feeUsd;
    this.totalSlippageUsd += fill.slippageUsd;

    this.recordTrade({
      side: "BUY",
      levelIndex: level.index,
      levelPrice: level.price,
      fillPrice: fill.effectivePrice,
      ethAmount: fill.ethOut,
      usdAmount: quote,
      feeUsd: fill.feeUsd,
      slippageUsd: fill.slippageUsd,
      gasUsd: 0,
      intervalId: this.intervalId,
      resetId: null,
      ethBalanceAfter: this.eth,
      usdcBalanceAfter: this.usdc,
      portfolioValueAfter: this.usdc + this.eth * level.price,
      timestamp,
    });

    // Flip: bought here -> rest a sell one spacing higher.
    level.side = null;
    const up = this.levelByIndex(level.index + 1);
    if (up) up.side = "SELL";

    return { type: "BUY", price: level.price, quoteAmount: quote, gridLevel: level.index };
  }

  // ----------------------------------------------------------------- sells

  private executeSell(
    level: GridLevelState,
    currentPrice: number,
    timestamp: number,
  ): StrategyAction | null {
    if (this.eth <= 0) {
      this.skips.push({ side: "SELL", reason: "no_eth" });
      return null;
    }

    // Size the sell from the FIFO lots it will close (classic grid pairing:
    // sell roughly what an earlier buy accumulated), falling back to one
    // order-notional when inventory came from outside the grid (initialEth).
    let qtyTarget = 0;
    const gridLots = this.lots.filter((l) => !l.seed);
    if (gridLots.length > 0) {
      for (const lot of gridLots) {
        qtyTarget += lot.eth;
        if (qtyTarget * level.price >= this.cfg.orderSizeUsd) break;
      }
      // Never sell less than half an order notional if lots allow more.
      qtyTarget = Math.max(qtyTarget, (this.cfg.orderSizeUsd * 0.5) / level.price);
    } else {
      qtyTarget = this.cfg.orderSizeUsd / level.price;
    }
    let qty = Math.min(qtyTarget, this.eth);

    // Respect min ETH exposure floor: never sell below it.
    const maxSellable = this.eth - this.cfg.minEthUsd / currentPrice;
    qty = Math.min(qty, maxSellable);

    if (qty <= 0) {
      this.skips.push({ side: "SELL", reason: "min_eth" });
      return null;
    }
    // Tiny fills are not worth gas, whether caused by low inventory or by
    // the exposure floor clipping the order.
    if (qty * level.price < this.cfg.orderSizeUsd * 0.5) {
      const ethValue = this.eth * currentPrice;
      this.skips.push({
        side: "SELL",
        reason: ethValue < this.cfg.minEthUsd + this.cfg.orderSizeUsd ? "min_eth" : "no_eth",
      });
      return null;
    }

    const fill = this.fills.quoteSell(level.price, qty);
    this.eth -= qty;
    this.usdc += fill.usdcOut;
    this.totalFeeUsd += fill.feeUsd;
    this.totalSlippageUsd += fill.slippageUsd;

    const costConsumed = this.consumeLots(qty, true);
    const realizedGross = qty * level.price - costConsumed;
    this.realizedGridGrossUsd += realizedGross;

    this.recordTrade({
      side: "SELL",
      levelIndex: level.index,
      levelPrice: level.price,
      fillPrice: fill.effectivePrice,
      ethAmount: qty,
      usdAmount: fill.usdcOut,
      feeUsd: fill.feeUsd,
      slippageUsd: fill.slippageUsd,
      gasUsd: 0,
      realizedGridGrossUsd: realizedGross,
      costBasisConsumedUsd: costConsumed,
      intervalId: this.intervalId,
      resetId: null,
      ethBalanceAfter: this.eth,
      usdcBalanceAfter: this.usdc,
      portfolioValueAfter: this.usdc + this.eth * level.price,
      timestamp,
    });

    // Flip: sold here -> rest a buy one spacing lower.
    level.side = null;
    const down = this.levelByIndex(level.index - 1);
    if (down) down.side = "BUY";

    return { type: "SELL", price: level.price, baseAmount: qty, gridLevel: level.index };
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Consume FIFO lots for `qty` ETH and return the cost basis released.
   * `countCycles` is true only for grid sells — a reset liquidation closes
   * lots without completing a grid cycle.
   */
  private consumeLots(qty: number, countCycles: boolean): number {
    let remaining = qty;
    let costConsumed = 0;
    while (remaining > 0 && this.lots.length > 0) {
      const lot = this.lots[0]!;
      const take = Math.min(lot.eth, remaining);
      const frac = lot.eth > 0 ? take / lot.eth : 1;
      costConsumed += lot.costUsd * frac;
      lot.eth -= take;
      lot.costUsd -= lot.costUsd * frac;
      remaining -= take;
      if (lot.eth <= DUST_USD || lot.costUsd < DUST_USD) {
        this.lots.shift();
        if (countCycles && !lot.seed) this.completedCycles++;
      }
    }
    return costConsumed;
  }

  /** (Re)build levels around the current center with fresh order sides. */
  private buildLevels(): void {
    const step = 1 + this.cfg.spacingPercent / 100;
    this.levels = [];
    for (let i = -this.cfg.levelsBelow; i <= this.cfg.levelsAbove; i++) {
      // Fresh grid: sells above, buys below — the standard starting layout.
      const side: "BUY" | "SELL" | null = i === 0 ? null : i > 0 ? "SELL" : "BUY";
      this.levels.push({ index: i, price: this.center * Math.pow(step, i), side });
    }
  }

  private pushHistory(price: number): void {
    this.priceHistory.push(price);
    const maxLen = Math.max(this.cfg.volLookbackPoints + 1, 2);
    if (this.priceHistory.length > maxLen) {
      this.priceHistory.splice(0, this.priceHistory.length - maxLen);
    }

    if (this.cfg.regimeMaxMovePct > 0) {
      this.regimeHistory.push(price);
      const regimeLen = Math.max(this.cfg.regimeLookbackPoints + 1, 2);
      if (this.regimeHistory.length > regimeLen) {
        this.regimeHistory.splice(0, this.regimeHistory.length - regimeLen);
      }
    }
  }

  /**
   * True when the trailing move over the lookback window exceeds the
   * threshold — "the market is making a big move, stand aside".
   *
   * Uses only observations already seen. Before the window has filled it
   * returns false: with no history there is no evidence of a big move.
   */
  private regimeHostile(): boolean {
    if (this.cfg.regimeMaxMovePct <= 0) return false;
    const need = Math.max(this.cfg.regimeLookbackPoints, 1) + 1;
    if (this.regimeHistory.length < need) return false;
    const first = this.regimeHistory[0]!;
    const last = this.regimeHistory[this.regimeHistory.length - 1]!;
    if (!(first > 0)) return false;
    return Math.abs((last / first - 1) * 100) > this.cfg.regimeMaxMovePct;
  }

  /**
   * Capital actually committed as liquidity, in USD.
   *
   * Only resting orders and held inventory are in the pool earning fees:
   * a BUY level commits one order notional of USDC, a SELL level is backed by
   * inventory, and undeployed cash sits in the wallet earning nothing.
   *
   * Crediting fees on the whole portfolio instead would pay LP yield on idle
   * USDC, which makes tiny order sizes look free — the position would collect
   * the full pool rate while risking almost nothing.
   */
  private capitalAtWork(price: number): number {
    if (this.phase !== "ACTIVE") return 0;
    const { lower, upper } = this.bounds();

    let quoteCommitted = 0;
    for (const level of this.levels) {
      // Only orders inside the band are providing liquidity at this price.
      if (level.side !== "BUY") continue;
      if (level.price < lower || level.price > upper) continue;
      quoteCommitted += this.cfg.orderSizeUsd;
    }

    // Inventory is the base side of the position and is in range by
    // construction while the grid is active.
    const baseCommitted = this.eth * price;

    // Cannot commit more than we hold.
    return Math.min(quoteCommitted + baseCommitted, this.usdc + this.eth * price);
  }

  /**
   * Credit LP fee income for one observation. Liquidity only earns while it
   * is deployed AND in range, so a grid in cooldown or with price outside its
   * band earns nothing — which is the honest half of the trade-off the
   * regime filter makes.
   *
   * Income is PRO-RATA against the competing liquidity in the range, so it
   * scales with the capital actually at work and dilutes in a deep pool.
   */
  private accrueFees(
    price: number,
    market: { volumeUsd?: number; feeAprPct?: number; poolTvlUsd?: number },
    elapsedSeconds: number,
  ): void {
    if (this.phase !== "ACTIVE") return;
    const { lower, upper } = this.bounds();
    if (price < lower || price > upper) return;

    const myValue = this.capitalAtWork(price);
    if (myValue <= 0) return;

    // Preferred path: a measured pool APR, either per-observation from the
    // data or a constant from config. Time-weighted so the result does not
    // depend on the sampling interval.
    const apr = market.feeAprPct ?? this.cfg.lpFeeAprPct;
    if (apr > 0) {
      if (elapsedSeconds <= 0) return;
      let income = myValue * (apr / 100) * (elapsedSeconds / SECONDS_PER_YEAR);
      // Dilution: joining the pool adds liquidity, so the published
      // pool-average rate is shared with our own capital. Prefer the pool's
      // measured TVL at this observation; fall back to the configured depth.
      // Without this a $10k position in an $11k pool would earn the full
      // pool-average rate, which is not physical.
      const poolTvl = market.poolTvlUsd ?? this.cfg.lpPoolLiquidityUsd;
      if (poolTvl > 0) income *= poolTvl / (myValue + poolTvl);
      this.feeIncomeUsd += income;
      this.usdc += income;
      return;
    }

    // Fallback: derive income from observed volume and an assumed venue share
    // plus competing depth. Kept for datasets with volume but no APR series.
    const volumeUsd = market.volumeUsd ?? 0;
    if (this.cfg.lpPoolLiquidityUsd <= 0 || volumeUsd <= 0) return;
    if (this.cfg.lpVenueVolumeSharePct <= 0) return;

    const poolVolume = volumeUsd * (this.cfg.lpVenueVolumeSharePct / 100);
    const myShare = myValue / (myValue + this.cfg.lpPoolLiquidityUsd);
    const income = poolVolume * (this.cfg.lpFeeBps / 10_000) * myShare;

    this.feeIncomeUsd += income;
    this.usdc += income;
  }

  /**
   * True when price has moved `resetBufferLevels` spacings beyond the
   * outermost level of the current grid.
   */
  private checkGridExit(price: number): boolean {
    if (this.cfg.resetBufferLevels <= 0 || this.levels.length === 0) return false;
    const step = 1 + this.cfg.spacingPercent / 100;
    const { lower, upper } = this.bounds();
    const bandTop = upper * Math.pow(step, this.cfg.resetBufferLevels);
    const bandBottom = lower * Math.pow(step, -this.cfg.resetBufferLevels);
    return price > bandTop || price < bandBottom;
  }

  /**
   * How much inventory a reset should sell, and why it is holding any back.
   *
   * The default configuration (`resetSellFraction` 1, `resetUnderwaterSkipPct`
   * 0) returns the whole inventory, which is the original unconditional dump.
   */
  private resetSellSize(
    price: number,
    avgCostPrice: number,
  ): { sellEth: number; carryReason: ResetRecord["carryReason"] } {
    if (this.eth <= 0) return { sellEth: 0, carryReason: null };

    // Refusing to crystallize a deep loss takes priority over the fraction:
    // if we are this far underwater, carry the whole position.
    if (this.cfg.resetUnderwaterSkipPct > 0 && avgCostPrice > 0) {
      const underwaterPct = (price / avgCostPrice - 1) * 100;
      if (underwaterPct < -this.cfg.resetUnderwaterSkipPct) {
        return { sellEth: 0, carryReason: "UNDERWATER" };
      }
    }

    const fraction = Math.min(Math.max(this.cfg.resetSellFraction, 0), 1);
    const sellEth = this.eth * fraction;
    return {
      sellEth,
      carryReason: fraction >= 1 ? "NONE" : "PARTIAL_POLICY",
    };
  }

  /**
   * Sell the ETH inventory at market per the reset liquidation policy, open a
   * ResetRecord and enter
   * cooldown. The record is completed in `maybeRebuild` once the new grid
   * exists (fields the environment owns — gas, drawdown, interval costs —
   * are filled by the backtester from the trade ledger).
   */
  private liquidate(price: number, timestamp: number, reason: ResetReason): StrategyAction[] {
    const actions: StrategyAction[] = [];

    const id = this.resetRecords.length + 1;
    const ethBefore = this.eth;
    const usdcBefore = this.usdc;
    const costBasisBefore = this.costBasisUsd();
    const avgCostBefore = this.avgCostPrice();
    const portfolioBefore = this.usdc + this.eth * price;

    let usdcRecovered = 0;
    let realizedResetPnl = 0;

    const { sellEth, carryReason } = this.resetSellSize(price, avgCostBefore);

    if (sellEth > DUST_USD) {
      const fill = this.fills.quoteSell(price, sellEth);
      const soldEth = sellEth;
      const costConsumed = this.consumeLots(soldEth, false);

      this.usdc += fill.usdcOut;
      this.eth -= soldEth;
      if (this.eth < DUST_USD) this.eth = 0;
      this.totalFeeUsd += fill.feeUsd;
      this.totalSlippageUsd += fill.slippageUsd;

      usdcRecovered = fill.usdcOut;
      realizedResetPnl = soldEth * price - costConsumed;
      this.realizedResetGrossUsd += realizedResetPnl;

      this.recordTrade({
        side: "SELL",
        levelIndex: null,
        levelPrice: price,
        fillPrice: fill.effectivePrice,
        ethAmount: soldEth,
        usdAmount: fill.usdcOut,
        feeUsd: fill.feeUsd,
        slippageUsd: fill.slippageUsd,
        gasUsd: 0,
        realizedResetGrossUsd: realizedResetPnl,
        costBasisConsumedUsd: costConsumed,
        liquidation: true,
        intervalId: id - 1,
        resetId: id,
        ethBalanceAfter: this.eth,
        usdcBalanceAfter: this.usdc,
        portfolioValueAfter: this.usdc + this.eth * price,
        timestamp,
      });

      actions.push({
        type: "LIQUIDATE",
        price,
        baseAmount: soldEth,
        reason: "grid_exited",
      });
    }

    this.resetRecords.push({
      id,
      reason,
      timestamp,
      rebuiltAt: null,
      price,
      oldBounds: this.bounds(),
      newBounds: null,
      ethInventoryBefore: ethBefore,
      usdcBefore,
      ethAvgCostPrice: avgCostBefore,
      ethCostBasisUsd: costBasisBefore,
      ethLiquidated: ethBefore - this.eth,
      ethCarried: this.eth,
      carryReason,
      usdcRecovered,
      realizedResetPnlUsd: realizedResetPnl,
      gridGrossSincePrevUsd: 0,
      gridNetSincePrevUsd: 0,
      feesSincePrevUsd: 0,
      slippageSincePrevUsd: 0,
      gasSincePrevUsd: 0,
      // Fee income accrues continuously rather than on fills, so the interval
      // figure is a difference of cumulative totals, not a sum over trades.
      feeIncomeSincePrevUsd: this.feeIncomeUsd - this.feeIncomeAtLastReset,
      portfolioValueBefore: portfolioBefore,
      portfolioValueAfter: this.usdc + this.eth * price,
      drawdownBeforePct: 0,
    });

    this.feeIncomeAtLastReset = this.feeIncomeUsd;

    // Flatten all resting orders while we wait for volatility to cool down.
    for (const level of this.levels) level.side = null;
    this.phase = "COOLDOWN";
    this.cooldownStartedAt = timestamp;
    this.resetTimes.push(timestamp);

    return actions;
  }

  /**
   * Rebuild the grid once BOTH conditions hold:
   *   1. at least the (possibly escalated) cooldown has elapsed, AND
   *   2. realized volatility over the lookback window is below maxVolPerStep.
   *
   * Circuit breaker: every batch of resetBreakerK resets within
   * resetBreakerWindowSeconds doubles the required cooldown — repeated
   * liquidations mean the regime is hostile; wait progressively longer.
   */
  private maybeRebuild(price: number, timestamp: number): boolean {
    const required = this.requiredCooldownSeconds(timestamp);
    if (
      this.cooldownStartedAt !== null &&
      timestamp - this.cooldownStartedAt < required
    ) {
      return false;
    }
    const vol = this.realizedVolatility();
    if (vol === null || vol > this.cfg.maxVolPerStep) return false;
    // Do not restart into the move we just stood aside from.
    if (this.regimeHostile()) return false;

    const oldBounds = this.bounds();
    this.center = price;
    this.buildLevels();
    const newBounds = this.bounds();
    this.resets++;
    this.phase = "ACTIVE";
    this.cooldownStartedAt = null;

    const record = this.resetRecords[this.resetRecords.length - 1];
    if (record) {
      record.rebuiltAt = timestamp;
      record.newBounds = newBounds;
      this.centerHistory.push({
        timestamp,
        resetId: record.id,
        oldCenter: oldBounds.center,
        newCenter: newBounds.center,
        oldLowerBound: oldBounds.lower,
        oldUpperBound: oldBounds.upper,
        newLowerBound: newBounds.lower,
        newUpperBound: newBounds.upper,
      });
    }
    return true;
  }

  /** Cooldown seconds after breaker escalation. */
  private requiredCooldownSeconds(nowTs: number): number {
    const cutoff = nowTs - this.cfg.resetBreakerWindowSeconds;
    const recentResets = this.resetTimes.filter((t) => t >= cutoff).length;
    const k = Math.max(this.cfg.resetBreakerK, 1);
    const escalations = Math.floor(recentResets / k);
    return this.cfg.regenMinSeconds * 2 ** escalations;
  }

  /** Std-dev of per-observation log returns over the lookback window. */
  private realizedVolatility(): number | null {
    const n = this.cfg.volLookbackPoints;
    if (this.priceHistory.length < n + 1) return null;
    const recent = this.priceHistory.slice(-(n + 1));
    const rets: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      rets.push(Math.log(recent[i]! / recent[i - 1]!));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
    return Math.sqrt(variance);
  }

  private recordTrade(t: Omit<TradeRecord, "seq">): void {
    this.trades.push({ seq: this.seq++, ...t });
  }

  /** Mutable access to the ledger so the environment can stamp gas. */
  tradeLedger(): TradeRecord[] {
    return this.trades;
  }

  /** Mutable access to reset records so the environment can complete them. */
  resetLedger(): ResetRecord[] {
    return this.resetRecords;
  }

  private levelByIndex(index: number): GridLevelState | undefined {
    return this.levels.find((l) => l.index === index);
  }
}
