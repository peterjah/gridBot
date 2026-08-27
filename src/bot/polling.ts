/**
 * Adaptive poll interval.
 *
 * The bot's decisions are bounded by slow-moving thresholds: a re-centre needs
 * price to travel hundreds of ticks, a re-entry needs a 168-hour trailing move
 * to decay, and a cooldown can block action for a full day. Polling every 30
 * seconds through all of that spends RPC quota to re-read a state that cannot
 * have changed — which is how a paid endpoint's monthly allowance disappears.
 *
 * The interval is driven by the closest actionable boundary: far away, poll
 * slowly; approaching one, poll quickly. Nothing here shortens a cooldown or
 * moves a threshold, so an over-long interval costs only latency at the moment
 * of action, never a missed action.
 *
 * PURE: no clock, no IO. The caller passes what it already read.
 */

export interface PollInputs {
  /** Floor and ceiling in seconds; the result is always inside them. */
  minSeconds: number;
  maxSeconds: number;
  /**
   * Ticks from the position centre, and the threshold that triggers a
   * re-centre. Null when nothing is deployed.
   */
  distanceTicks: number | null;
  thresholdTicks: number;
  /** Seconds left on the re-centre cooldown; 0 when it is not blocking. */
  cooldownRemainingSeconds: number;
  /** Trailing move percent, or null when the window has not filled. */
  trailingMovePct: number | null;
  /** Regime exit threshold; 0 when the filter is off. */
  regimeMaxMovePct: number;
  /** Re-entry threshold, below the exit one by the hysteresis margin. */
  regimeReenterMaxPct: number;
  /** Whether the bot is currently standing aside. */
  parked: boolean;
  /** A short with a health factor to watch caps how long we may sleep. */
  hedgeOpen: boolean;
  /** Ceiling applied while a hedge is open. */
  hedgeMaxSeconds: number;
}

export interface PollDecision {
  seconds: number;
  /** Why this interval, for the log. */
  reason: string;
  /** Closest boundary as a fraction in [0,1]; 1 means "at it". */
  urgency: number;
}

/** Fraction of the way from "just acted" to "acts now", clamped to [0,1]. */
function progress(current: number, threshold: number): number {
  if (!(threshold > 0)) return 0;
  return Math.min(Math.max(current / threshold, 0), 1);
}

export function nextPollSeconds(input: PollInputs): PollDecision {
  const { minSeconds, maxSeconds } = input;
  const clamp = (s: number): number =>
    Math.min(Math.max(Math.round(s), minSeconds), Math.max(maxSeconds, minSeconds));

  // How close is the nearest thing that could make the bot act?
  let urgency = 0;
  let driver = "idle";

  // 1. Re-centre: price approaching the trigger distance from centre.
  if (input.distanceTicks !== null) {
    const p = progress(Math.abs(input.distanceTicks), input.thresholdTicks);
    if (p > urgency) {
      urgency = p;
      driver = "re-centre distance";
    }
  }

  // 2. Regime boundary. Deployed, the risk is crossing INTO hostile, so
  //    urgency rises as the move grows. Parked, it is crossing back OUT, so
  //    urgency rises as the move shrinks toward the re-entry threshold.
  if (input.regimeMaxMovePct > 0 && input.trailingMovePct !== null) {
    const move = Math.abs(input.trailingMovePct);
    const p = input.parked
      ? progress(input.regimeReenterMaxPct, move) // move falling toward re-entry
      : progress(move, input.regimeMaxMovePct); // move rising toward exit
    if (p > urgency) {
      urgency = p;
      driver = input.parked ? "regime re-entry" : "regime exit";
    }
  }

  // Interpolate: no urgency polls at the ceiling, full urgency at the floor.
  let seconds = maxSeconds - urgency * (maxSeconds - minSeconds);
  let reason = `${driver} ${(urgency * 100).toFixed(0)}%`;

  // A blocking cooldown outranks urgency: no amount of price movement can
  // trigger anything until it expires, so sleep toward the expiry.
  if (input.cooldownRemainingSeconds > seconds) {
    seconds = input.cooldownRemainingSeconds;
    reason = "waiting out the re-centre cooldown";
  }

  // An open short is a liquidation risk that does not care about any of the
  // above, so it caps the interval however quiet things look.
  if (input.hedgeOpen && seconds > input.hedgeMaxSeconds) {
    seconds = input.hedgeMaxSeconds;
    reason = "hedge open — watching the health factor";
  }

  return { seconds: clamp(seconds), reason, urgency };
}
