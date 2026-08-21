import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../utils/logger.js";

const STATE_VERSION = 1;

interface BotState {
  version: number;
  positionId: string;
}

/**
 * Local state file tracking which position NFT the bot currently manages.
 *
 * The chain remains the source of truth for all on-chain state; this file
 * only remembers the token id of the most recently minted position so the
 * bot can follow it across restarts and rebalances.
 */
export function loadPositionId(stateFile: string): bigint | null {
  const path = resolve(stateFile);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const state = JSON.parse(raw) as BotState;
    if (state.version !== STATE_VERSION || typeof state.positionId !== "string") {
      throw new Error("unsupported state format");
    }
    return BigInt(state.positionId);
  } catch (error) {
    logger.warn("Ignoring unreadable state file", {
      stateFile: path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Atomically persist the managed position id (write temp file + rename). */
export function savePositionId(stateFile: string, positionId: bigint): void {
  const path = resolve(stateFile);
  const tmp = `${path}.tmp`;
  const state: BotState = { version: STATE_VERSION, positionId: positionId.toString() };
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
  logger.info("State updated", { stateFile: path, positionId: positionId.toString() });
}

/** Ensure the directory of the state file exists. */
export function ensureStateDir(stateFile: string): void {
  const dir = dirname(resolve(stateFile));
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory already exists or creation failed; savePositionId will surface errors.
  }
}
