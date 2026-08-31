import { MAX_TICK, MIN_TICK } from "./ticks.js";

export const Q32 = 1n << 32n;
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const Q192 = 1n << 192n;
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Port of Uniswap V3 TickMath.getSqrtRatioAtTick.
 * Returns sqrt(price) as a Q64.96 number for the given tick.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK || !Number.isInteger(tick)) {
    throw new Error(`Tick out of bounds: ${tick}`);
  }
  const absTick = Math.abs(tick);

  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Q128.128 -> Q64.96, rounding up (matches solidity)
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/**
 * Returns the largest tick whose sqrt ratio is <= the given sqrtPriceX96.
 * Binary search over the valid tick range.
 */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (getSqrtRatioAtTick(mid) <= sqrtPriceX96) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * Human readable price of token0 denominated in token1:
 * price = (sqrtPriceX96 / 2^96)^2 adjusted for token decimals.
 */
export function sqrtRatioToPrice(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  const raw = Number(sqrtPriceX96 ** 2n) / Number(Q192);
  return raw * 10 ** (token0Decimals - token1Decimals);
}

/**
 * Amounts of token0/token1 held by `liquidity` within [sqrtA, sqrtB] at the
 * current sqrtPrice. Mirrors Uniswap V3 pool math, rounding down.
 */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (sqrtA > sqrtB) throw new Error("sqrtA must be <= sqrtB");
  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtPriceX96 <= sqrtA) {
    amount0 = mulDiv(liquidity * (sqrtB - sqrtA), Q96, sqrtA * sqrtB);
  } else if (sqrtPriceX96 < sqrtB) {
    amount0 = mulDiv(liquidity * (sqrtB - sqrtPriceX96), Q96, sqrtPriceX96 * sqrtB);
    amount1 = (liquidity * (sqrtPriceX96 - sqrtA)) / Q96;
  } else {
    amount1 = (liquidity * (sqrtB - sqrtA)) / Q96;
  }
  return { amount0, amount1 };
}

/**
 * Liquidity obtainable from `amount0` when the current price is at or below
 * the lower bound of the position (price <= sqrtLower).
 */
export function getLiquidityForAmount0(sqrtLower: bigint, sqrtUpper: bigint, amount0: bigint): bigint {
  if (sqrtLower > sqrtUpper) throw new Error("sqrtLower must be <= sqrtUpper");
  const intermediate = (sqrtLower * sqrtUpper) / Q96;
  return mulDiv(amount0, intermediate, sqrtUpper - sqrtLower);
}

/** Liquidity obtainable from `amount1` when price is at or above sqrtUpper. */
export function getLiquidityForAmount1(sqrtLower: bigint, sqrtUpper: bigint, amount1: bigint): bigint {
  if (sqrtLower > sqrtUpper) throw new Error("sqrtLower must be <= sqrtUpper");
  return (amount1 * Q96) / (sqrtUpper - sqrtLower);
}

/**
 * Liquidity obtainable with the given amounts in the range [sqrtA, sqrtB]
 * at current price sqrtP. Mirrors Uniswap V3 LiquidityAmounts library.
 */
export function getLiquidityForAmounts(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtA > sqrtB) throw new Error("sqrtA must be <= sqrtB");
  if (sqrtP <= sqrtA) {
    return getLiquidityForAmount0(sqrtA, sqrtB, amount0);
  }
  if (sqrtP < sqrtB) {
    const l0 = getLiquidityForAmount0(sqrtP, sqrtB, amount0);
    const l1 = getLiquidityForAmount1(sqrtA, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(sqrtA, sqrtB, amount1);
}

/** Value of a token0/token1 pair expressed in token1, in raw units. */
export function valueInToken1(sqrtPriceX96: bigint, amount0: bigint, amount1: bigint): bigint {
  // amount0 * price, where price = (sqrtP / 2^96)^2, applied in two steps so
  // the intermediate cannot overflow the way squaring sqrtP would.
  return mulDiv(mulDiv(amount0, sqrtPriceX96, Q96), sqrtPriceX96, Q96) + amount1;
}

/**
 * Liquidity that deploys the FULL value of a holding into a range.
 *
 * `getLiquidityForAmounts` answers a different question: the most liquidity
 * mintable from the balances as they stand, which is the MINIMUM of what each
 * side supports. That is right at mint time, after balances have been swapped
 * to the target ratio, but wrong when planning — a one-sided wallet drives the
 * result to ~0, the required amounts collapse with it, and the balancing swap
 * then sees no imbalance to correct. Observed live: 0.1414 WETH and 0.000001
 * USDC planned a position of 4.1e-10 WETH with `swapNeeded: false`.
 *
 * This instead prices the whole holding and asks what liquidity that value
 * funds at the current price, so the caller can swap toward the ratio it
 * implies.
 */
export function getLiquidityForValue(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtA > sqrtB) throw new Error("sqrtA must be <= sqrtB");
  const haveValue = valueInToken1(sqrtP, amount0, amount1);
  if (haveValue <= 0n) return 0n;

  // Scale from a reference liquidity rather than deriving a closed form: the
  // amounts-for-liquidity maths is already exact and shared with minting.
  const reference = Q96;
  const { amount0: refAmount0, amount1: refAmount1 } = getAmountsForLiquidity(
    sqrtP,
    sqrtA,
    sqrtB,
    reference,
  );
  const refValue = valueInToken1(sqrtP, refAmount0, refAmount1);
  if (refValue <= 0n) return 0n;

  return mulDiv(reference, haveValue, refValue);
}

/** Floor(a * b / c) for bigints. */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("Division by zero");
  return (a * b) / c;
}

/** Scale an amount down by slippage expressed in basis points. */
export function applySlippageBps(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Format a raw token amount as a decimal string given its decimals. */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${fracStr}`;
}
