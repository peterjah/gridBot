/**
 * Concentrated-liquidity fee multiplier.
 *
 * A pool's published `apyBase` is fee income divided by total TVL — the rate
 * the AVERAGE liquidity in that pool earns. Concentrated positions do not all
 * earn that rate: for the same capital, a narrower band mints more liquidity
 * over the active tick range and therefore captures a larger share of the
 * fees, while a wider band spreads the same capital thinner and captures less.
 *
 * For a band of half-width r around the current price, liquidity per unit of
 * capital scales roughly as 1/r, so:
 *
 *   multiplier = referenceRangePct / myRangePct
 *
 * `referenceRangePct` is the band width at which the published pool APR
 * applies exactly — i.e. the pool's own effective average concentration.
 *
 * Without this, fee income is independent of range width, and any optimizer
 * will pick the widest band available: wider means more time in range at no
 * modelled cost. That is not how V3 works, and it is a large enough effect to
 * invert the ranking.
 */

/**
 * Cap used only when pool depth is unknown. When TVL IS known, prefer
 * `feeShareOfPool` below: dilution against the pool's own liquidity density
 * bounds the result physically, with no arbitrary constant.
 */
export const MAX_CONCENTRATION_MULTIPLIER = 20;

/**
 * Liquidity minted per unit of capital for a symmetric band of half-width
 * `rangePct` around the current price, in units of 1/sqrt(price).
 *
 * Exact Uniswap V3 maths rather than the 1/r approximation. For a position of
 * value V over [P(1-r), P(1+r)]:
 *
 *   V = L * [ (sqrtP - sqrtLo) + P * (1/sqrtP - 1/sqrtHi) ]
 *
 * so L/V is the reciprocal of that bracket. The price factors out of any
 * ratio of two densities, so the multiplier below is price-independent.
 *
 * The approximation L ∝ 1/r is only accurate for small r; at ±30% it
 * overstates density by several percent, and the error grows with width.
 */
export function liquidityDensity(rangePct: number): number {
  const r = rangePct / 100;
  if (!(r > 0) || r >= 1) return 0;
  // Unit price: the ratio of two densities is price-independent.
  const sqrtP = 1;
  const sqrtLo = Math.sqrt(1 - r);
  const sqrtHi = Math.sqrt(1 + r);
  const bracket = sqrtP - sqrtLo + (1 / sqrtP - 1 / sqrtHi);
  return bracket > 0 ? 1 / bracket : 0;
}

export function concentrationMultiplier(
  rangePct: number,
  referenceRangePct: number,
): number {
  // A non-positive reference disables the adjustment entirely, restoring the
  // flat "pool average for everyone" behaviour.
  if (!(referenceRangePct > 0)) return 1;
  if (!(rangePct > 0)) return MAX_CONCENTRATION_MULTIPLIER;

  const mine = liquidityDensity(rangePct);
  const ref = liquidityDensity(referenceRangePct);
  if (!(mine > 0) || !(ref > 0)) return MAX_CONCENTRATION_MULTIPLIER;
  return Math.min(mine / ref, MAX_CONCENTRATION_MULTIPLIER);
}

/**
 * Share of the pool's fees a position captures, by liquidity DENSITY.
 *
 * Concentration and dilution are the same phenomenon seen from two sides, so
 * modelling them together removes the need for an arbitrary cap:
 *
 *   myDensity   = positionValue / myRangePct
 *   poolDensity = poolTvlUsd / referenceRangePct
 *   share       = myDensity / (myDensity + poolDensity)
 *
 * For a small position this reduces to the simple multiplier
 * (`referenceRangePct / myRangePct`) — concentrating twice as tightly earns
 * twice the rate. As the position grows, or concentrates far beyond the
 * surrounding liquidity, its share saturates at 1: it cannot earn more than
 * all the fees the pool generates. A model without that ceiling will happily
 * report a position minting many times the pool's entire fee revenue.
 */
export function feeShareOfPool(
  positionValueUsd: number,
  rangePct: number,
  poolTvlUsd: number,
  referenceRangePct: number,
): number {
  if (!(positionValueUsd > 0)) return 0;
  if (!(poolTvlUsd > 0) || !(referenceRangePct > 0) || !(rangePct > 0)) return 0;

  // Same exact V3 density as above, so the two paths cannot disagree.
  const myDensity = positionValueUsd * liquidityDensity(rangePct);
  const poolDensity = poolTvlUsd * liquidityDensity(referenceRangePct);
  if (!(myDensity > 0) || !(poolDensity > 0)) return 0;
  return myDensity / (myDensity + poolDensity);
}
