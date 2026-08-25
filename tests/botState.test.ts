import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyState,
  loadPositionId,
  loadState,
  recordFees,
  recordPriceSample,
  savePositionId,
  saveState,
  seedPriceHistory,
  trailingMovePct,
} from "../src/bot/state.js";

const dirs: string[] = [];
function statePath(): string {
  const d = mkdtempSync(join(tmpdir(), "botstate-"));
  dirs.push(d);
  return join(d, "position.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("state persistence", () => {
  it("round-trips a position id", () => {
    const p = statePath();
    savePositionId(p, 12345n);
    expect(loadPositionId(p)).toBe(12345n);
  });

  it("treats a missing file as empty, not an error", () => {
    expect(loadPositionId(join(tmpdir(), "does-not-exist-xyz.json"))).toBeNull();
  });

  it("migrates a v1 file without losing the position", () => {
    const p = statePath();
    writeFileSync(p, JSON.stringify({ version: 1, positionId: "999" }));
    const s = loadState(p);
    expect(s.positionId).toBe("999");
    expect(s.version).toBe(2);
    expect(s.feesUsd).toBe(0);
  });

  it("does not lose fee totals when the position id changes", () => {
    const p = statePath();
    savePositionId(p, 1n);
    recordFees(p, 100n, 200n, 5.5);
    savePositionId(p, 2n);
    const s = loadState(p);
    expect(s.positionId).toBe("2");
    expect(s.feesToken0).toBe("100");
    expect(s.feesUsd).toBeCloseTo(5.5);
  });

  it("accumulates fees across collections", () => {
    const p = statePath();
    recordFees(p, 10n, 20n, 1);
    const s = recordFees(p, 5n, 7n, 2.5);
    expect(s.feesToken0).toBe("15");
    expect(s.feesToken1).toBe("27");
    expect(s.feesUsd).toBeCloseTo(3.5);
    expect(s.recenters).toBe(2);
  });

  it("stamps firstDeployedAt once", () => {
    const p = statePath();
    savePositionId(p, 1n);
    const first = loadState(p).firstDeployedAt;
    savePositionId(p, 2n);
    expect(loadState(p).firstDeployedAt).toBe(first);
  });
});

describe("regime price history", () => {
  it("rate-limits samples", () => {
    const s = emptyState();
    recordPriceSample(s, 1000, 100, 3600, 86_400);
    recordPriceSample(s, 1100, 101, 3600, 86_400); // too soon
    recordPriceSample(s, 4700, 102, 3600, 86_400); // 3700s later, accepted
    expect(s.priceHistory).toHaveLength(2);
  });

  it("trims history beyond the retained window", () => {
    const s = emptyState();
    for (let t = 0; t < 200; t++) recordPriceSample(s, t * 3600, 100, 3600, 24 * 3600);
    // Retains twice the window, not all 200 hours.
    expect(s.priceHistory.length).toBeLessThan(60);
    expect(s.priceHistory.length).toBeGreaterThan(2);
  });

  it("returns null until the history spans the window", () => {
    const s = emptyState();
    recordPriceSample(s, 0, 100, 3600, 86_400);
    recordPriceSample(s, 3600, 110, 3600, 86_400);
    expect(trailingMovePct(s.priceHistory, 3600, 86_400)).toBeNull();
  });

  it("measures the move against the oldest sample outside the window", () => {
    const s = emptyState();
    for (let h = 0; h <= 48; h++) {
      recordPriceSample(s, h * 3600, h === 0 ? 100 : 100 + h, 3600, 48 * 3600);
    }
    const now = 48 * 3600;
    const move = trailingMovePct(s.priceHistory, now, 24 * 3600);
    expect(move).not.toBeNull();
    // 24h ago the price was 124; now 148 => +19.35%
    expect(move!).toBeCloseTo((148 / 124 - 1) * 100, 4);
  });

  it("is causal: only samples at or before `now` are used", () => {
    const s = emptyState();
    for (let h = 0; h <= 48; h++) recordPriceSample(s, h * 3600, 100 + h, 3600, 48 * 3600);
    // Evaluating at an earlier `now` must ignore later samples entirely.
    const early = trailingMovePct(s.priceHistory, 30 * 3600, 24 * 3600);
    s.priceHistory.push({ t: 49 * 3600, p: 100_000 });
    expect(trailingMovePct(s.priceHistory, 30 * 3600, 24 * 3600)).toBe(early);
  });

  it("survives a save/load round trip", () => {
    const p = statePath();
    const s = emptyState();
    for (let h = 0; h <= 48; h++) recordPriceSample(s, h * 3600, 100 + h, 3600, 48 * 3600);
    saveState(p, s);
    const back = loadState(p);
    expect(back.priceHistory).toEqual(s.priceHistory);
    expect(trailingMovePct(back.priceHistory, 48 * 3600, 24 * 3600)).toBeCloseTo(
      trailingMovePct(s.priceHistory, 48 * 3600, 24 * 3600)!,
      9,
    );
  });
});

describe("seedPriceHistory", () => {
  it("fills the window from historical points", () => {
    const s = emptyState();
    const now = 1_000_000;
    const points = Array.from({ length: 200 }, (_, i) => ({
      t: now - (200 - i) * 3600,
      p: 100 + i,
    }));
    const n = seedPriceHistory(s, points, now, 48 * 3600, 3600);
    expect(n).toBeGreaterThan(0);
    expect(trailingMovePct(s.priceHistory, now, 24 * 3600)).not.toBeNull();
  });

  it("never seeds a sample from the future", () => {
    const s = emptyState();
    const now = 1_000_000;
    const points = [
      { t: now - 3600, p: 100 },
      { t: now + 99_999, p: 500 },
    ];
    seedPriceHistory(s, points, now, 48 * 3600, 60);
    expect(s.priceHistory.every((x) => x.t <= now)).toBe(true);
  });

  it("respects the sample interval when seeding", () => {
    const s = emptyState();
    const now = 1_000_000;
    const points = Array.from({ length: 500 }, (_, i) => ({ t: now - 500 * 60 + i * 60, p: 100 }));
    seedPriceHistory(s, points, now, 48 * 3600, 3600);
    for (let i = 1; i < s.priceHistory.length; i++) {
      expect(s.priceHistory[i]!.t - s.priceHistory[i - 1]!.t).toBeGreaterThanOrEqual(3600);
    }
  });

  it("keeps live samples newer than the seed", () => {
    const s = emptyState();
    const now = 1_000_000;
    s.priceHistory = [{ t: now - 60, p: 999 }];
    seedPriceHistory(s, [{ t: now - 7200, p: 100 }], now, 48 * 3600, 3600);
    expect(s.priceHistory.some((x) => x.p === 999)).toBe(true);
    expect(s.priceHistory.some((x) => x.p === 100)).toBe(true);
  });
});
