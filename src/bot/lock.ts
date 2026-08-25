import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "../utils/logger.js";

/**
 * Single-instance lock, keyed on the state file.
 *
 * Two bots sharing one wallet allocate the same nonce and fight over the same
 * position: one broadcasts while the other is mid-sequence, producing
 * "replacement transaction underpriced" and a position neither of them
 * believes it minted. Both were observed in production.
 *
 * `wx` makes creation atomic, so the check and the claim cannot interleave.
 */
export interface Lock {
  release(): void;
}

interface LockFile {
  pid: number;
  startedAt: string;
  stateFile: string;
}

export function acquireLock(stateFile: string): Lock {
  const path = `${resolve(stateFile)}.lock`;
  mkdirSync(dirname(path), { recursive: true });

  const claim = (): number => {
    const fd = openSync(path, "wx");
    const body: LockFile = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      stateFile: resolve(stateFile),
    };
    writeSync(fd, JSON.stringify(body, null, 2) + "\n");
    return fd;
  };

  let fd: number;
  try {
    fd = claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    const holder = readHolder(path);
    if (holder !== null && isAlive(holder.pid)) {
      throw new Error(
        `Another instance is already running (pid ${holder.pid}, started ` +
          `${holder.startedAt}). Two bots on one wallet collide on nonces and ` +
          `fight over the position. Stop it first, or use a different ` +
          `STATE_FILE. Lock: ${path}`,
      );
    }
    logger.warn("Removing stale lock from a dead process", {
      lock: path,
      pid: holder?.pid ?? "unreadable",
    });
    unlinkSync(path);
    fd = claim();
  }

  closeSync(fd);
  logger.info("Acquired instance lock", { lock: path, pid: process.pid });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(path);
    } catch {
      // Already gone; nothing to do.
    }
  };

  // Release on every ordinary exit path, including Ctrl-C and SIGTERM.
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      release();
      process.exit(130);
    });
  }

  return { release };
}

function readHolder(path: string): LockFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockFile;
  } catch {
    return null;
  }
}

/** Signal 0 tests for existence without delivering anything. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
