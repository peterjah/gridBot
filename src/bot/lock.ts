import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
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
  /**
   * Kernel start time of the owning process, in clock ticks since boot.
   *
   * A pid alone is not an identity. In a container the bot is usually pid 1,
   * so a lock left behind by a killed container names pid 1 — and the next
   * container's pid 1 is very much alive, which would make the bot refuse to
   * start forever. Comparing start times distinguishes "that same process" from
   * "something else that happens to have this number".
   */
  startTime: number | null;
  /** Container id or host name, for diagnosis. */
  host: string;
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
      startTime: processStartTime(process.pid),
      host: hostname(),
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
    if (holder !== null && isHeldBy(holder)) {
      throw new Error(
        `Another instance is already running (pid ${holder.pid} on ` +
          `${holder.host}, started ${holder.startedAt}). Two bots on one wallet ` +
          `collide on nonces and fight over the position. Stop it first, or use ` +
          `a different STATE_FILE. Lock: ${path}`,
      );
    }
    logger.warn("Removing stale lock", {
      lock: path,
      pid: holder?.pid ?? "unreadable",
      reason:
        holder === null
          ? "unreadable"
          : holder.startTime !== null && processStartTime(holder.pid) !== holder.startTime
            ? "pid reused by a different process (container restart?)"
            : "process is gone",
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

/** Is the lock still held by the very process that wrote it? */
function isHeldBy(holder: LockFile): boolean {
  if (!isAlive(holder.pid)) return false;
  // A recorded start time that no longer matches means the number was reused.
  if (holder.startTime !== null) {
    const current = processStartTime(holder.pid);
    if (current !== null && current !== holder.startTime) return false;
  }
  return true;
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

/**
 * Process start time in clock ticks since boot, from field 22 of
 * /proc/<pid>/stat. Linux only; returns null elsewhere, which degrades to the
 * pid-only check. Containers are Linux, which is where this matters.
 */
function processStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces and parentheses, so parse after the
    // final ')' rather than splitting the whole line.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Fields resume at index 0 == field 3 (state), so starttime (22) is 19.
    const value = Number(after[19]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
