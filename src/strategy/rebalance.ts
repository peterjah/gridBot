export interface PositionRange {
  lowerTick: number;
  upperTick: number;
}

export interface RangeContext {
  currentTick: number;
  tickSpacing: number;
}

/**
 * Strategy interface. Implementations must be pure: no RPC calls, no
 * blockchain-specific code. Replace this to change bot behavior.
 */
export interface Strategy {
  readonly name: string;
  /** Decide whether the position needs rebalancing right now. */
  shouldRebalance(currentTick: number, range: PositionRange | null): boolean;
  /** Compute the desired range for a new position. */
  computeRange(ctx: RangeContext): PositionRange;
}

/** Center tick of a range (rounded down). */
export function centerTick(range: PositionRange): number {
  return Math.floor((range.lowerTick + range.upperTick) / 2);
}

/** Distance in ticks between the current tick and the range center. */
export function distanceFromCenter(currentTick: number, range: PositionRange): number {
  return Math.abs(currentTick - centerTick(range));
}
