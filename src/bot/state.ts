import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../utils/logger.js";

const STATE_VERSION = 2;

/**
 * Local state for the LP re-centring bot.
 *
 * The chain remains the source of truth for all on-chain state; this file
 * remembers the token id of the position being managed, and the running fee
 * total — which cannot be recovered from the chain after the fact, because
 * collecting merges fees with withdrawn principal in the same transfer.
 */
export interface BotState {
  version: number;
  positionId: string;
  /** Cumulative fees collected, in raw token units. */
  feesToken0: string;
  feesToken1: string;
  /** Cumulative fee value at collection time, USD. */
  feesUsd: number;
  /** Re-centres performed. */
  recenters: number;
  /** ISO timestamp of the first deployment, for annualizing the fee yield. */
  firstDeployedAt: string | null;
  /**
   * Downsampled price history backing the regime filter, oldest first.
   *
   * Persisted because the filter needs a multi-day lookback: rebuilding it
   * from scratch on every restart would leave the bot blind for days, and
   * "blind" resolves to "stay invested".
   */
  priceHistory: PriceSample[];
  /** Whether the bot is currently standing aside in cash. */
  parked: boolean;
  /** Unix seconds of the last park/unpark transition. */
  lastParkChangeAt: number;
}

export interface PriceSample {
  /** Unix seconds. */
  t: number;
  p: number;
}

export function emptyState(): BotState {
  return {
    version: STATE_VERSION,
    positionId: "0",
    feesToken0: "0",
    feesToken1: "0",
    feesUsd: 0,
    recenters: 0,
    firstDeployedAt: null,
    priceHistory: [],
    parked: false,
    lastParkChangeAt: 0,
  };
}

/** Read the full state. Returns a fresh one when absent or unreadable. */
export function loadState(stateFile: string): BotState {
  const path = resolve(stateFile);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BotState> & { version?: number };
    if (typeof parsed.positionId !== "string") throw new Error("unsupported state format");
    // v1 held only positionId; carry it forward rather than losing the position.
    return {
      ...emptyState(),
      ...parsed,
      version: STATE_VERSION,
      positionId: parsed.positionId,
    };
  } catch (error) {
    logger.warn("Ignoring unreadable state file", {
      stateFile: path,
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyState();
  }
}

/** Atomically persist state (write temp file + rename). */
export function saveState(stateFile: string, state: BotState): void {
  const path = resolve(stateFile);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, version: STATE_VERSION }, null, 2) + "\n");
  renameSync(tmp, path);
}

export function loadPositionId(stateFile: string): bigint | null {
  const id = loadState(stateFile).positionId;
  try {
    const parsed = BigInt(id);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the managed position id, preserving the fee accounting. */
export function savePositionId(stateFile: string, positionId: bigint): void {
  const state = loadState(stateFile);
  state.positionId = positionId.toString();
  if (state.firstDeployedAt === null) state.firstDeployedAt = new Date().toISOString();
  saveState(stateFile, state);
  logger.info("State updated", { stateFile: resolve(stateFile), positionId: positionId.toString() });
}

/**
 * Add one collection to the running fee total.
 *
 * Fees must already be separated from withdrawn principal by the caller: a
 * `collect` after `decreaseLiquidity` transfers both, so the Collect event
 * alone would overstate income by the entire position.
 */
export function recordFees(
  stateFile: string,
  fee0: bigint,
  fee1: bigint,
  feeUsd: number,
): BotState {
  const state = loadState(stateFile);
  state.feesToken0 = (BigInt(state.feesToken0) + fee0).toString();
  state.feesToken1 = (BigInt(state.feesToken1) + fee1).toString();
  state.feesUsd += feeUsd;
  state.recenters += 1;
  saveState(stateFile, state);
  return state;
}

/**
 * Append a price sample, rate-limited to one per `minIntervalSeconds` and
 * trimmed to `windowSeconds`. Returns the updated history.
 */
export function recordPriceSample(
  state: BotState,
  timestamp: number,
  price: number,
  minIntervalSeconds: number,
  windowSeconds: number,
): PriceSample[] {
  const history = state.priceHistory;
  const last = history[history.length - 1];
  if (last === undefined || timestamp - last.t >= minIntervalSeconds) {
    history.push({ t: timestamp, p: price });
  }
  // Keep one sample beyond the window so the lookback can always be evaluated
  // at the window's far edge.
  const cutoff = timestamp - windowSeconds * 2;
  while (history.length > 2 && history[0]!.t < cutoff) history.shift();
  return history;
}

/**
 * Trailing move over the lookback window, percent, or null when the history
 * does not yet span it.
 *
 * Causal by construction: it compares the newest sample against the oldest
 * one that is at least `windowSeconds` old.
 */
export function trailingMovePct(
  history: PriceSample[],
  now: number,
  windowSeconds: number,
  currentPrice?: number,
): number | null {
  if (history.length < 2) return null;
  // Never look past `now`: the caller may evaluate a historical instant, and
  // a sample from the future would make the filter clairvoyant.
  let latest: PriceSample | null = null;
  let reference: PriceSample | null = null;
  for (const sample of history) {
    if (sample.t > now) break;
    latest = sample;
    if (now - sample.t >= windowSeconds) reference = sample;
  }
  if (latest === null || reference === null || !(reference.p > 0)) return null;
  // The far end of the window has to come from the stored samples, but the
  // near end should not: history is sampled at `regimeSampleMinutes`, so using
  // it would judge a move that ended up to that long ago. A risk control must
  // see the price it can actually act on.
  const near = currentPrice !== undefined && currentPrice > 0 ? currentPrice : latest.p;
  return (near / reference.p - 1) * 100;
}

/**
 * Pre-fill the regime window from a historical price series so the filter is
 * live from the first cycle instead of blind for its whole lookback.
 *
 * Without this the bot spends `regimeLookbackHours` fully exposed — which is
 * precisely the risk the filter exists to avoid. Existing samples are kept and
 * anything newer than the seed is preserved.
 */
export function seedPriceHistory(
  state: BotState,
  points: PriceSample[],
  now: number,
  windowSeconds: number,
  minIntervalSeconds: number,
): number {
  const cutoff = now - windowSeconds * 2;
  const seeded: PriceSample[] = [];
  for (const point of points) {
    if (point.t < cutoff || point.t > now) continue;
    const last = seeded[seeded.length - 1];
    if (last === undefined || point.t - last.t >= minIntervalSeconds) seeded.push(point);
  }
  const existing = state.priceHistory.filter(
    (sample) => seeded.length === 0 || sample.t > seeded[seeded.length - 1]!.t,
  );
  state.priceHistory = [...seeded, ...existing];
  return seeded.length;
}

/** Ensure the directory of the state file exists. */
export function ensureStateDir(stateFile: string): void {
  const dir = dirname(resolve(stateFile));
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory already exists or creation failed; saveState will surface errors.
  }
}
