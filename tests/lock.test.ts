import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireLock } from "../src/bot/lock.js";

const dirs: string[] = [];
function statePath(): string {
  const d = mkdtempSync(join(tmpdir(), "lock-"));
  dirs.push(d);
  return join(d, "position.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("single-instance lock", () => {
  it("claims and releases", () => {
    const p = statePath();
    const lock = acquireLock(p);
    expect(existsSync(`${p}.lock`)).toBe(true);
    lock.release();
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it("refuses a second instance while the first is alive", () => {
    const p = statePath();
    const lock = acquireLock(p);
    // The lock records this very process, which is by definition alive.
    expect(() => acquireLock(p)).toThrow(/Another instance is already running/);
    lock.release();
  });

  it("records the owning pid", () => {
    const p = statePath();
    const lock = acquireLock(p);
    const body = JSON.parse(readFileSync(`${p}.lock`, "utf8"));
    expect(body.pid).toBe(process.pid);
    lock.release();
  });

  it("reclaims a lock left by a dead process", () => {
    const p = statePath();
    // Use a pid that genuinely existed and has exited. Picking a large
    // constant is not portable: Linux allows pid_max up to 4194304, so a
    // "surely impossible" pid can be a live process there.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.pid).toBeGreaterThan(0);
    writeFileSync(
      `${p}.lock`,
      JSON.stringify({ pid: dead.pid, startedAt: "2020-01-01T00:00:00Z", stateFile: p }),
    );
    const lock = acquireLock(p);
    expect(JSON.parse(readFileSync(`${p}.lock`, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  /**
   * In a container the bot is pid 1. A lock left by a killed container names
   * pid 1, and the next container's pid 1 is alive — without a start-time
   * check the bot would refuse to start forever.
   */
  it("reclaims a lock whose pid was reused by a different process", () => {
    const p = statePath();
    writeFileSync(
      `${p}.lock`,
      JSON.stringify({
        pid: process.pid,
        startedAt: "2020-01-01T00:00:00Z",
        stateFile: p,
        // This process is alive, but it did not start at tick 1.
        startTime: 1,
        host: "some-dead-container",
      }),
    );
    if (process.platform === "linux") {
      const lock = acquireLock(p);
      expect(JSON.parse(readFileSync(`${p}.lock`, "utf8")).pid).toBe(process.pid);
      lock.release();
    } else {
      // No /proc: the check degrades to pid-only and correctly refuses.
      expect(() => acquireLock(p)).toThrow(/Another instance is already running/);
    }
  });

  it("records a start time on Linux so pids can be told apart", () => {
    const p = statePath();
    const lock = acquireLock(p);
    const body = JSON.parse(readFileSync(`${p}.lock`, "utf8"));
    expect(body.host).toBeTruthy();
    if (process.platform === "linux") {
      expect(typeof body.startTime).toBe("number");
    }
    lock.release();
  });

  it("rejects a nonsensical pid rather than trusting it", () => {
    const p = statePath();
    for (const pid of [0, -1, 1.5]) {
      writeFileSync(`${p}.lock`, JSON.stringify({ pid, startedAt: "x", stateFile: p }));
      const lock = acquireLock(p);
      expect(JSON.parse(readFileSync(`${p}.lock`, "utf8")).pid).toBe(process.pid);
      lock.release();
    }
  });

  it("reclaims an unreadable lock", () => {
    const p = statePath();
    writeFileSync(`${p}.lock`, "not json at all");
    const lock = acquireLock(p);
    expect(existsSync(`${p}.lock`)).toBe(true);
    lock.release();
  });

  it("release is idempotent", () => {
    const p = statePath();
    const lock = acquireLock(p);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it("separate state files do not collide", () => {
    const a = acquireLock(statePath());
    const b = acquireLock(statePath());
    a.release();
    b.release();
  });
});
