import type { PricePoint } from "../data/provider.js";
import type { GasModel } from "../backtest/gasModel.js";
import { flatGasModel } from "../backtest/gasModel.js";
import { concentrationMultiplier, feeShareOfPool } from "./concentration.js";

/**
 * Passive Uniswap V3 liquidity provision, as a strategy in its own right.
 *
 * One deposit into a price band, collecting fees while price is inside it.
 * Optionally re-centred when price leaves the band — the direct analogue of
 * the grid's reset, minus the grid.
 *
 * This exists because once fee income is modelled it becomes the benchmark
 * that matters: a strategy whose revenue is mostly LP fees has to beat simply
 * providing that liquidity, not just beat holding the asset.
 *
 * PURE: no blockchain, no IO. Same float sqrt-price maths as the benchmarks
 * module, in sqrt units where sqrtP = sqrt(price).
 */

export type RegimeMetric = "displacement" | "signed" | "drawdown" | "volatility";

export interface PassiveLpConfig {
  initialUsdc: number;
  initialEth: number;
  /** Half-width of the position around its centre, in percent. */
  rangePct: number;
  /**
   * Re-centre the position when price moves this far beyond the band edge,
   * as a percentage of the band half-width. 0 disables re-centring, giving a
   * genuinely passive position that is left alone forever.
   */
  recenterBufferPct: number;
  /** Swap cost paid when re-centring rebalances the position, basis points. */
  feeBps: number;
  slippageBps: number;
  /** Minimum hours between re-centres, so chop does not churn the position. */
  recenterMinHours: number;
  /**
   * Band width at which the pool's published APR applies exactly. Narrower
   * bands earn proportionally more per dollar, wider ones less. 0 disables
   * the adjustment.
   */
  referenceRangePct: number;
  /**
   * Stand aside when the trailing move over `regimeLookbackPoints`
   * observations exceeds this percentage: close the position to cash and stop
   * earning fees until the market calms down. 0 disables the filter.
   *
   * A concentrated LP position is structurally long the volatile asset, and
   * walk-forward shows that exposure — not the band width — is what loses
   * money out of sample. This is the direct test of "run it while the market
   * is sideways, stop on big moves".
   */
  regimeMaxMovePct: number;
  /** Observations in the trailing-move window. */
  regimeLookbackPoints: number;
  /**
   * How "the market is hostile" is measured over the lookback window.
   *
   * `displacement` is net |end/start - 1|: two points out of the whole window,
   * blind to the path between them. It is what shipped, and it is not a
   * volatility measure.
   *
   * `signed` parks only on a FALL. An LP is structurally long, so a week that
   * rose and a week that fell are not the same event, and taking the absolute
   * value conflates them.
   *
   * `drawdown` is the worst peak-to-trough inside the window.
   *
   * `volatility` is realized volatility of log returns over the window — the
   * conventional answer, included so the comparison is decided by measurement
   * rather than by which one sounds most rigorous.
   */
  regimeMetric: RegimeMetric;
  /**
   * Percent of the position's ETH exposure held short, 0 = unhedged.
   *
   * A concentrated LP position is structurally long the volatile asset, and
   * that exposure — not the band width — is what loses money out of sample:
   * across the walk-forward folds, position P&L of -$15,637 was -$13,763 of
   * plain price exposure and only -$1,874 of divergence loss.
   */
  hedgeRatioPct: number;
  /** Annualised cost of borrowing the shorted asset, percent. */
  hedgeBorrowAprPct: number;
  /**
   * Only hedge while standing aside, matching the shipped live bot.
   *
   * The live hedge opens when parking and closes before deploying, so it
   * covers the cash ETH held while out of the market but not the LP
   * position's own delta. Setting this false hedges continuously, which is
   * what the exposure numbers above actually argue for.
   */
  hedgeWhileParkedOnly: boolean;
}

export interface LpSample {
  timestamp: number;
  price: number;
  portfolioValue: number;
  eth: number;
  usdc: number;
  /** Cumulative fee income held as cash. */
  feeCash: number;
  inRange: boolean;
  /** Standing aside: the position is closed and held as cash. */
  parked: boolean;
}

export interface RecenterRecord {
  timestamp: number;
  price: number;
  oldCenter: number;
  newCenter: number;
  /** Cost of the rebalancing swap plus its gas, USD. */
  costUsd: number;
  portfolioValue: number;
}

export interface PassiveLpResult {
  config: PassiveLpConfig;
  samples: LpSample[];
  recenters: RecenterRecord[];
  start: PricePoint;
  end: PricePoint;
  initialCapital: number;
  finalValue: number;
  returnPct: number;
  maxDrawdownPct: number;
  /** Fee income earned while in range. */
  feeIncomeUsd: number;
  /** Change in position value vs initial capital, excluding fees and costs. */
  positionPnlUsd: number;
  /** Swap fees + slippage paid on re-centring. */
  swapCostUsd: number;
  gasUsd: number;
  /** Share of observations with price inside the band. */
  timeInRangePct: number;
  /** Share of observations spent standing aside in cash. */
  timeParkedPct: number;
  /** Times the regime filter closed the position. */
  parkEvents: number;
  /** Mark-to-market P&L of the short leg. */
  hedgePnlUsd: number;
  /** Borrow interest plus the swap cost of resizing the short. */
  hedgeCostUsd: number;
  /** Times the short was opened, closed or resized. */
  hedgeRebalances: number;
  /** Value vs holding the initial deposit split unchanged (divergence loss). */
  impermanentLossUsd: number;
  residual: number;
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

interface Position {
  center: number;
  lo: number;
  hi: number;
  liquidity: number;
}

/** Amounts a position of liquidity L holds at `price`, clamped to its band. */
function holdingsOf(pos: Position, price: number): { eth: number; usdc: number } {
  const sqrtLo = Math.sqrt(pos.lo);
  const sqrtHi = Math.sqrt(pos.hi);
  const sqrtP = Math.sqrt(Math.min(Math.max(price, pos.lo), pos.hi));
  return {
    eth: pos.liquidity * (1 / sqrtP - 1 / sqrtHi),
    usdc: pos.liquidity * (sqrtP - sqrtLo),
  };
}

/** Build the deepest position `capital` can fund at `price` over the band. */
function openPosition(capital: number, price: number, rangePct: number): Position {
  const lo = price * (1 - rangePct / 100);
  const hi = price * (1 + rangePct / 100);
  if (!(lo > 0 && hi > lo)) throw new Error(`invalid LP range at price ${price}`);

  const sqrtLo = Math.sqrt(lo);
  const sqrtHi = Math.sqrt(hi);
  const sqrtP = Math.sqrt(price);
  // Both sides share one liquidity L, so the capital constraint is a single
  // equation: L * [(sqrtP - sqrtLo) + price * (1/sqrtP - 1/sqrtHi)] = capital
  const denom = sqrtP - sqrtLo + price * (1 / sqrtP - 1 / sqrtHi);
  if (!(denom > 0)) throw new Error("invalid LP range");
  return { center: price, lo, hi, liquidity: capital / denom };
}

/**
 * Simulate a passive LP position over the price series.
 *
 * Accounting identity, checked by `residual`:
 *   finalValue = initialCapital + positionPnl + feeIncome - swapCosts - gas
 *                + hedgePnl - hedgeCost
 */
export function runPassiveLp(
  cfg: PassiveLpConfig,
  data: PricePoint[],
  gas: number | GasModel = 0,
): PassiveLpResult {
  if (data.length < 2) throw new Error("Need at least 2 price points");
  const gasModel: GasModel = typeof gas === "number" ? flatGasModel(gas) : gas;

  const first = data[0]!;
  const initialCapital = cfg.initialUsdc + cfg.initialEth * first.price;
  if (!(initialCapital > 0)) throw new Error("initial capital must be > 0");
  if (!(cfg.rangePct > 0 && cfg.rangePct < 100)) {
    throw new Error(`rangePct must be in (0,100), got ${cfg.rangePct}`);
  }

  let position = openPosition(initialCapital, first.price, cfg.rangePct);
  // Fees earned in total (for attribution) vs fees still sitting as cash.
  // Redeploying at a re-centre moves cash into the position, so the two must
  // be tracked apart or the income shows up as position P&L instead.
  let feeIncomeTotal = 0;
  let feeCash = 0;
  let redeployedFees = 0;
  let swapCostUsd = 0;
  let gasUsd = 0;
  let lastRecenterAt = first.timestamp;
  // Regime filter state. `parkedCash` holds the position's value while it is
  // closed; fees do not accrue on it, which is exactly the cost of standing
  // aside.
  // Short leg. `shortEth` is the ETH-denominated size currently borrowed and
  // sold; it is resized only at transaction points (re-centre, park, unpark),
  // so delta drifts between them exactly as it would on-chain.
  let shortEth = 0;
  let hedgePnlUsd = 0;
  let hedgeCostUsd = 0;
  let hedgeRebalances = 0;

  let parked = false;
  let parkedCash = 0;
  let parkEvents = 0;
  let parkedCount = 0;
  let lastParkChangeAt = first.timestamp;

  const costFrac = (cfg.feeBps + cfg.slippageBps) / 10_000;
  const samples: LpSample[] = [];
  const recenters: RecenterRecord[] = [];

  /** ETH the book is long right now, whether deployed or parked in cash. */
  const ethExposure = (price: number): number => {
    if (parked) return 0; // parked cash is USDC in this model
    return holdingsOf(position, price).eth;
  };

  /**
   * Resize the short toward its target, paying the swap cost on the traded
   * ETH. Called only at points where the live bot would already be sending a
   * transaction, so the hedge adds cost but not extra round trips.
   */
  const resizeHedge = (price: number): void => {
    if (!(cfg.hedgeRatioPct > 0)) return;
    const active = !cfg.hedgeWhileParkedOnly || parked;
    const target = active ? ethExposure(price) * (cfg.hedgeRatioPct / 100) : 0;
    const delta = Math.abs(target - shortEth);
    if (delta * price < 1) return; // not worth a transaction
    hedgeCostUsd += delta * price * costFrac;
    hedgeRebalances++;
    shortEth = target;
  };

  const sampleAt = (point: PricePoint): LpSample => {
    if (parked) {
      return {
        timestamp: point.timestamp,
        price: point.price,
        portfolioValue: parkedCash + feeCash + hedgePnlUsd - hedgeCostUsd,
        eth: 0,
        usdc: parkedCash,
        feeCash,
        inRange: false,
        parked: true,
      };
    }
    const h = holdingsOf(position, point.price);
    return {
      timestamp: point.timestamp,
      price: point.price,
      portfolioValue: h.eth * point.price + h.usdc + feeCash + hedgePnlUsd - hedgeCostUsd,
      eth: h.eth,
      usdc: h.usdc,
      feeCash,
      inRange: point.price >= position.lo && point.price <= position.hi,
      parked: false,
    };
  };

  /**
   * True when the trailing move over the lookback window exceeds the
   * threshold. Uses only observations already seen — index `i` looks back to
   * `i - lookback`, never forward. Before the window has filled it returns
   * false: no history is not evidence of a big move.
   */
  const regimeHostile = (i: number): boolean => {
    if (!(cfg.regimeMaxMovePct > 0)) return false;
    const lookback = Math.max(Math.trunc(cfg.regimeLookbackPoints), 1);
    if (i < lookback) return false;
    const firstPrice = data[i - lookback]!.price;
    if (!(firstPrice > 0)) return false;
    const nowPrice = data[i]!.price;

    switch (cfg.regimeMetric) {
      case "signed": {
        // Only a FALL is hostile. A rally moves the position out of range too,
        // but into the side that is followed by the best outcomes in-sample.
        return (nowPrice / firstPrice - 1) * 100 < -cfg.regimeMaxMovePct;
      }
      case "drawdown": {
        let peak = 0;
        let worst = 0;
        for (let j = i - lookback; j <= i; j++) {
          const p = data[j]!.price;
          if (p > peak) peak = p;
          if (peak > 0) worst = Math.min(worst, (p - peak) / peak);
        }
        return Math.abs(worst) * 100 > cfg.regimeMaxMovePct;
      }
      case "volatility": {
        // Standard deviation of log returns across the window, scaled to the
        // window so the threshold is comparable to a percentage move.
        let sum = 0;
        let count = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
          const prev = data[j - 1]!.price;
          if (prev > 0) {
            sum += Math.log(data[j]!.price / prev);
            count++;
          }
        }
        if (count < 2) return false;
        const mean = sum / count;
        let variance = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
          const prev = data[j - 1]!.price;
          if (prev > 0) variance += (Math.log(data[j]!.price / prev) - mean) ** 2;
        }
        return Math.sqrt(variance / count) * Math.sqrt(count) * 100 > cfg.regimeMaxMovePct;
      }
      default:
        return Math.abs((nowPrice / firstPrice - 1) * 100) > cfg.regimeMaxMovePct;
    }
  };

  resizeHedge(first.price);
  samples.push(sampleAt(first));
  let inRangeCount = samples[0]!.inRange ? 1 : 0;

  for (let i = 1; i < data.length; i++) {
    const point = data[i]!;
    const prev = data[i - 1]!;
    const elapsed = Math.max(0, point.timestamp - prev.timestamp);
    const inRange = !parked && point.price >= position.lo && point.price <= position.hi;

    // Fees accrue on the position's value while in range, at the pool's
    // measured rate. Out of range the position is entirely one asset and
    // earns nothing — the central trade-off of concentrated liquidity.
    // Short leg marked to market: it gains when price falls, which is exactly
    // the offset to the LP's long exposure.
    if (shortEth !== 0) {
      hedgePnlUsd += shortEth * (prev.price - point.price);
      if (elapsed > 0 && cfg.hedgeBorrowAprPct > 0) {
        hedgeCostUsd +=
          shortEth * point.price * (cfg.hedgeBorrowAprPct / 100) * (elapsed / SECONDS_PER_YEAR);
      }
    }

    const apr = point.feeAprPct ?? 0;
    if (inRange && apr > 0 && elapsed > 0) {
      const h = holdingsOf(position, point.price);
      const positionValue = h.eth * point.price + h.usdc;
      // Fees accrue on the POSITION's liquidity only. Collected fees sit as
      // loose tokens: they provide no liquidity and earn nothing until they
      // are re-deposited, which a passive position by definition never does.
      // Including them here let the cash pile compound into the fee base and
      // produced returns larger than the pool's entire revenue.
      const stake = positionValue;
      const tvl = point.poolTvlUsd ?? 0;
      const yearFrac = elapsed / SECONDS_PER_YEAR;
      // With pool depth known, take a density-weighted share of the pool's
      // fee revenue — concentration and dilution in one step, bounded by the
      // pool's total fees. Otherwise fall back to the capped multiplier.
      let income: number;
      if (tvl > 0 && cfg.referenceRangePct > 0) {
        income =
          tvl *
          (apr / 100) *
          yearFrac *
          feeShareOfPool(stake, cfg.rangePct, tvl, cfg.referenceRangePct);
      } else {
        income =
          stake *
          (apr / 100) *
          yearFrac *
          concentrationMultiplier(cfg.rangePct, cfg.referenceRangePct);
        // Concentration disabled: still dilute by pool depth.
        if (tvl > 0) income *= tvl / (stake + tvl);
      }
      feeCash += income;
      feeIncomeTotal += income;
    }

    // Regime filter. Standing aside is not free: closing sells the whole ETH
    // side and re-entering buys it back, both at full cost, and no fees accrue
    // in between. The same dwell time as re-centring keeps it from churning.
    if (cfg.regimeMaxMovePct > 0) {
      const hostile = regimeHostile(i);
      const dwelled = point.timestamp - lastParkChangeAt >= cfg.recenterMinHours * 3600;
      if (hostile && !parked && dwelled) {
        const h = holdingsOf(position, point.price);
        const value = h.eth * point.price + h.usdc;
        const cost = h.eth * point.price * costFrac;
        const txGas = gasModel.txOverheadUsd + gasModel.perFillUsd;
        swapCostUsd += cost;
        gasUsd += txGas;
        parkedCash = Math.max(value - cost - txGas, 0);
        parked = true;
        parkEvents++;
        lastParkChangeAt = point.timestamp;
        resizeHedge(point.price);
      } else if (!hostile && parked && dwelled) {
        // Re-enter with everything, including fees collected before parking.
        const capital = parkedCash + feeCash;
        const fresh = openPosition(Math.max(capital, 0), point.price, cfg.rangePct);
        const target = holdingsOf(fresh, point.price);
        const cost = target.eth * point.price * costFrac;
        const txGas = gasModel.txOverheadUsd + gasModel.perFillUsd;
        swapCostUsd += cost;
        gasUsd += txGas;
        redeployedFees += feeCash;
        feeCash = 0;
        position = openPosition(Math.max(capital - cost - txGas, 0), point.price, cfg.rangePct);
        parked = false;
        lastParkChangeAt = point.timestamp;
        lastRecenterAt = point.timestamp;
        resizeHedge(point.price);
      }
    }

    // Re-centre once price is far enough beyond the band and the cooldown
    // has elapsed. Rebalancing into a fresh band means swapping the position
    // back toward balance, which costs fees and slippage on the traded side.
    if (cfg.recenterBufferPct > 0 && !parked) {
      const halfWidth = position.center * (cfg.rangePct / 100);
      const buffer = halfWidth * (cfg.recenterBufferPct / 100);
      const beyond = point.price > position.hi + buffer || point.price < position.lo - buffer;
      const cooledDown = point.timestamp - lastRecenterAt >= cfg.recenterMinHours * 3600;

      if (beyond && cooledDown) {
        const h = holdingsOf(position, point.price);
        const value = h.eth * point.price + h.usdc;

        const fresh = openPosition(value, point.price, cfg.rangePct);
        const target = holdingsOf(fresh, point.price);
        // Only the asset that has to change hands pays the swap cost.
        const ethDelta = Math.abs(target.eth - h.eth);
        const cost = ethDelta * point.price * costFrac;
        const txGas = gasModel.txOverheadUsd + gasModel.perFillUsd;

        swapCostUsd += cost;
        gasUsd += txGas;

        const oldCenter = position.center;
        // Re-centring burns and re-mints, so accrued fees are collected at the
        // same time and can be redeposited with the principal. Leaving them
        // out would understate a re-centring position's earning base against
        // any strategy that does redeploy them — which is most of the gap
        // between this and the grid.
        const redeployed = Math.max(value + feeCash - cost - txGas, 0);
        redeployedFees += feeCash;
        feeCash = 0;
        position = openPosition(redeployed, point.price, cfg.rangePct);
        lastRecenterAt = point.timestamp;

        resizeHedge(point.price);

        const after = holdingsOf(position, point.price);
        recenters.push({
          timestamp: point.timestamp,
          price: point.price,
          oldCenter,
          newCenter: position.center,
          costUsd: cost + txGas,
          portfolioValue: after.eth * point.price + after.usdc + feeCash,
        });
      }
    }

    const s = sampleAt(point);
    samples.push(s);
    if (s.inRange) inRangeCount++;
    if (s.parked) parkedCount++;
  }

  const last = data[data.length - 1]!;
  const finalHoldings = holdingsOf(position, last.price);
  const positionValue = parked
    ? parkedCash
    : finalHoldings.eth * last.price + finalHoldings.usdc;
  // Close the short at the last price, so the result is a realised number.
  if (shortEth !== 0) {
    hedgeCostUsd += Math.abs(shortEth) * last.price * costFrac;
    hedgeRebalances++;
    shortEth = 0;
  }
  const finalValue = positionValue + feeCash + hedgePnlUsd - hedgeCostUsd;

  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const s of samples) {
    if (s.portfolioValue > peak) peak = s.portfolioValue;
    if (peak > 0) {
      const dd = ((s.portfolioValue - peak) / peak) * 100;
      if (dd < maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  // Divergence loss: the deposit split held unchanged instead of provided.
  const startHoldings = holdingsOf(
    openPosition(initialCapital, first.price, cfg.rangePct),
    first.price,
  );
  const hodlExact = startHoldings.eth * last.price + startHoldings.usdc;

  // Fees folded into the position are income, not position performance, so
  // they are removed here and reported under feeIncomeUsd instead.
  const positionPnlUsd =
    positionValue - initialCapital - redeployedFees + swapCostUsd + gasUsd;
  const reconstructed =
    initialCapital +
    positionPnlUsd +
    feeIncomeTotal -
    swapCostUsd -
    gasUsd +
    hedgePnlUsd -
    hedgeCostUsd;

  return {
    config: cfg,
    samples,
    recenters,
    start: first,
    end: last,
    initialCapital,
    finalValue,
    returnPct: ((finalValue - initialCapital) / initialCapital) * 100,
    maxDrawdownPct,
    feeIncomeUsd: feeIncomeTotal,
    positionPnlUsd,
    swapCostUsd,
    gasUsd,
    timeInRangePct: (inRangeCount / samples.length) * 100,
    timeParkedPct: (parkedCount / samples.length) * 100,
    parkEvents,
    hedgePnlUsd,
    hedgeCostUsd,
    hedgeRebalances,
    impermanentLossUsd: positionValue - hodlExact,
    residual: reconstructed - finalValue,
  };
}

/** Throws when the passive LP components do not sum to its final value. */
export function assertLpReconciles(result: PassiveLpResult, tolerance = 1e-6): void {
  const scale = Math.max(1, Math.abs(result.finalValue));
  if (Math.abs(result.residual) > tolerance * scale) {
    throw new Error(
      `Passive LP reconciliation failed: residual ${result.residual.toExponential(3)} USD`,
    );
  }
}
