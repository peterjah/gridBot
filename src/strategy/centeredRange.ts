import { alignTickDown, alignTickUp, clampTick, MAX_TICK, MIN_TICK } from "../utils/ticks.js";
import {
  distanceFromCenter,
  type PositionRange,
  type RangeContext,
  type Strategy,
} from "./rebalance.js";

export interface CenteredRangeConfig {
  /** Half-width of the new range in ticks around the current price. */
  widthTicks: number;
  /**
   * Rebalance when |currentTick - center| >= thresholdTicks.
   *
   * May be smaller than `widthTicks` (re-centre before the price leaves the
   * range) or larger (let the position go out of range by a buffer first).
   * The backtested optimum is the latter — see docs/LP_REBALANCE.md.
   */
  thresholdTicks: number;
}

/**
 * Simple centered-range strategy:
 *
 *   lower = alignDown(currentTick - width)
 *   upper = alignUp(currentTick + width)
 *
 * Rebalances when the current tick moves at least `thresholdTicks` away from
 * the center of the current position. Since new positions are centered on the
 * current tick, the distance resets to ~0 after each rebalance, so any
 * positive threshold provides hysteresis.
 */
export class CenteredRangeStrategy implements Strategy {
  readonly name = "CenteredRange";

  constructor(private readonly config: CenteredRangeConfig) {
    if (config.widthTicks <= 0) throw new Error("widthTicks must be > 0");
    if (config.thresholdTicks <= 0) throw new Error("thresholdTicks must be > 0");
  }

  shouldRebalance(currentTick: number, range: PositionRange | null): boolean {
    if (!range) return true;
    return distanceFromCenter(currentTick, range) >= this.config.thresholdTicks;
  }

  computeRange(ctx: RangeContext): PositionRange {
    const lower = clampTick(alignTickDown(ctx.currentTick - this.config.widthTicks, ctx.tickSpacing));
    const upper = clampTick(alignTickUp(ctx.currentTick + this.config.widthTicks, ctx.tickSpacing));
    if (lower <= MIN_TICK || upper >= MAX_TICK) {
      throw new Error(`Computed range out of bounds: [${lower}, ${upper}]`);
    }
    if (lower >= upper) {
      throw new Error(`Invalid computed range: [${lower}, ${upper}]`);
    }
    return { lowerTick: lower, upperTick: upper };
  }
}
