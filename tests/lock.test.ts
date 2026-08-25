import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // PID 2^22 is above the default Linux/macOS pid_max, so it cannot exist.
    writeFileSync(
      `${p}.lock`,
      JSON.stringify({ pid: 4_194_303, startedAt: "2020-01-01T00:00:00Z", stateFile: p }),
    );
    const lock = acquireLock(p);
    expect(JSON.parse(readFileSync(`${p}.lock`, "utf8")).pid).toBe(process.pid);
    lock.release();
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
