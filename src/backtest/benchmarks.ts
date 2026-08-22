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
}

interface BenchInput {
  prices: { timestamp: number; price: number }[];
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
