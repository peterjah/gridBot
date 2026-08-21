export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/**
 * Round a tick to the nearest valid tick below (inclusive) that is a multiple
 * of the pool's tickSpacing.
 */
export function alignTickDown(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

/**
 * Round a tick to the nearest valid tick above (inclusive) that is a multiple
 * of the pool's tickSpacing.
 */
export function alignTickUp(tick: number, tickSpacing: number): number {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

/** Clamp a tick to the valid Uniswap V3 tick range. */
export function clampTick(tick: number): number {
  return Math.min(MAX_TICK, Math.max(MIN_TICK, tick));
}
