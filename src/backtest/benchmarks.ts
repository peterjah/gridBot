/**
 * Passive benchmarks for the same period and starting capital.
 *
 * All benchmarks start from the SAME total capital as the strategy
 * (initialUsdc + initialEth valued at the first observed price).
 *
 * The static LP benchmark models a Uniswap V3 concentrated position with a
 * fixed range covering the whole period, using standard V3 liquidity math in
 * float form (sqrt units where sqrtP = sqrt(price)). No fees are collected —
 * a documented simplification that isolates divergence loss (IL).
 */

export interface Benchmark {
  name: string;
  finalValue: number;
  finalUsdc: number;
  finalEth: number;
  /** For LP: value lost vs HODL of the same deposit split (divergence/IL). */
  impermanentLossUsd?: number;
  /** For LP: fee income earned over the period, when modeled. */
  feeIncomeUsd?: number;
}

interface BenchInput {
  prices: { timestamp: number; price: number; feeAprPct?: number; poolTvlUsd?: number }[];
  initialUsdc: number;
  initialEth: number;
}

export function usdcOnlyBenchmark(
  { initialUsdc, initialEth }: BenchInput,
  firstPrice: number,
): Benchmark {
  const capital = initialUsdc + initialEth * firstPrice;
  return { name: "USDC only", finalValue: capital, finalUsdc: capital, finalEth: 0 };
}

export function ethHoldBenchmark({ prices, initialUsdc, initialEth }: BenchInput): Benchmark {
  const firstPrice = prices[0]!.price;
  const capital = initialUsdc + initialEth * firstPrice;
  const eth = capital / firstPrice;
  const lastPrice = prices[prices.length - 1]!.price;
  return {
    name: "ETH buy & hold",
    finalValue: eth * lastPrice,
    finalUsdc: 0,
    finalEth: eth,
  };
}

/**
 * Static V3 LP over [lo, hi] covering the entire price path.
 *
 * V3 amount formulas in sqrt units:
 *   amountEth  = L * (1/sqrtP - 1/sqrtHi)   for sqrtLo <= sqrtP <= sqrtHi
 *   amountUsdc = L * (sqrtP - sqrtLo)
 */
export function staticLpBenchmark({ prices, initialUsdc, initialEth }: BenchInput): Benchmark {
  const firstPrice = prices[0]!.price;
  const lastPrice = prices[prices.length - 1]!.price;
  const capital = initialUsdc + initialEth * firstPrice;

  let pMin = Infinity;
  let pMax = -Infinity;
  for (const p of prices) {
    if (p.price < pMin) pMin = p.price;
    if (p.price > pMax) pMax = p.price;
  }
  const lo = pMin * 0.95; // buffer so the range always covers the path
  const hi = pMax * 1.05;

  const sqrtLo = Math.sqrt(lo);
  const sqrtHi = Math.sqrt(hi);

  function holdings(price: number): { eth: number; usdc: number } {
    const sqrtP = Math.sqrt(price);
    if (sqrtP <= sqrtLo) {
      return { eth: L * (1 / sqrtP - 1 / sqrtHi), usdc: 0 };
    }
    if (sqrtP >= sqrtHi) {
      return { eth: 0, usdc: L * (sqrtP - sqrtLo) };
    }
    return { eth: L * (1 / sqrtP - 1 / sqrtHi), usdc: L * (sqrtP - sqrtLo) };
  }

  // Deposit all capital at the first price. Both sides share one liquidity L,
  // so the capital constraint is a single equation:
  //   L * [(sqrtP0 - sqrtLo) + p0 * (1/sqrtP0 - 1/sqrtHi)] = capital
  const sqrtP0 = Math.sqrt(firstPrice);
  const denom = sqrtP0 - sqrtLo + firstPrice * (1 / sqrtP0 - 1 / sqrtHi);
  if (!(denom > 0)) throw new Error("invalid LP range");
  const L = capital / denom;

  const startHoldings = holdings(firstPrice);
  const endHoldings = holdings(lastPrice);
  const lpFinal = endHoldings.eth * lastPrice + endHoldings.usdc;

  // HODL of the exact deposit split quantifies divergence loss.
  const hodlExact =
    startHoldings.eth * lastPrice + startHoldings.usdc;

  return {
    name: "Static V3 LP (no fees)",
    finalValue: lpFinal,
    finalUsdc: endHoldings.usdc,
    finalEth: endHoldings.eth,
    impermanentLossUsd: lpFinal - hodlExact,
  };
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/**
 * Passive V3 LP earning fees: the same capital deposited once into a range
 * and left alone, collecting the pool's measured fee APR whenever price is
 * inside that range.
 *
 * This is the benchmark that matters once fee income is modeled. If a
 * do-nothing position in the same pool earns the same fees, the grid's
 * trading, resets and inventory risk are pure overhead — so the strategy has
 * to beat THIS, not just beat holding ETH.
 *
 * `rangePct` is the half-width of the position around the starting price.
 * Fees compound into the position, matching the strategy's treatment.
 *
 * CAVEAT on range width: the pool's published APR is a pool average, and this
 * applies it per dollar regardless of how wide the position is. Real V3
 * concentration means a narrow position earns more per dollar than a wide one
 * while in range, and less once out. Comparisons at MATCHED range width (say,
 * against a grid using the same band) are therefore sound; comparing two
 * different widths to each other overstates the wider one.
 */
export function passiveLpWithFeesBenchmark(
  { prices, initialUsdc, initialEth }: BenchInput,
  rangePct: number,
): Benchmark {
  const firstPrice = prices[0]!.price;
  const capital = initialUsdc + initialEth * firstPrice;

  const lo = firstPrice * (1 - rangePct / 100);
  const hi = firstPrice * (1 + rangePct / 100);
  const sqrtLo = Math.sqrt(lo);
  const sqrtHi = Math.sqrt(hi);
  const sqrtP0 = Math.sqrt(firstPrice);

  const denom = sqrtP0 - sqrtLo + firstPrice * (1 / sqrtP0 - 1 / sqrtHi);
  if (!(denom > 0)) throw new Error("invalid LP range");
  const L = capital / denom;

  function holdings(price: number): { eth: number; usdc: number } {
    const sqrtP = Math.sqrt(Math.min(Math.max(price, lo), hi));
    return {
      eth: L * (1 / sqrtP - 1 / sqrtHi),
      usdc: L * (sqrtP - sqrtLo),
    };
  }

  // Fees accrue on the position's value while price is in range, at the
  // pool's measured rate, and are held as cash alongside the position.
  let feeIncome = 0;
  for (let i = 1; i < prices.length; i++) {
    const point = prices[i]!;
    const apr = point.feeAprPct ?? 0;
    if (apr <= 0) continue;
    if (point.price < lo || point.price > hi) continue;

    const elapsed = point.timestamp - prices[i - 1]!.timestamp;
    if (elapsed <= 0) continue;

    const h = holdings(point.price);
    const positionValue = h.eth * point.price + h.usdc;
    // Accrues on the position only: collected fees are loose tokens and
    // provide no liquidity until re-deposited.
    let income = positionValue * (apr / 100) * (elapsed / SECONDS_PER_YEAR);
    // Same pro-rata dilution the strategy applies.
    const tvl = point.poolTvlUsd ?? 0;
    if (tvl > 0) income *= tvl / (positionValue + tvl);
    feeIncome += income;
  }

  const lastPrice = prices[prices.length - 1]!.price;
  const end = holdings(lastPrice);
  const positionValue = end.eth * lastPrice + end.usdc;

  const start = holdings(firstPrice);
  const hodlExact = start.eth * lastPrice + start.usdc;

  return {
    name: `Passive V3 LP ±${rangePct.toFixed(0)}% (with fees)`,
    finalValue: positionValue + feeIncome,
    finalUsdc: end.usdc + feeIncome,
    finalEth: end.eth,
    impermanentLossUsd: positionValue - hodlExact,
    feeIncomeUsd: feeIncome,
  };
}
