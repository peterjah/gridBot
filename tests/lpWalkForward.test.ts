import { describe, expect, it } from "vitest";
import type { PricePoint } from "../src/data/provider.js";
import { lpTrainTest, lpWalkForward, selectLpConsensus } from "../src/lp/lpWalkForward.js";
import type { LpWalkForwardOptions } from "../src/lp/lpWalkForward.js";

/** Deterministic oscillating series with a mild drift and a fee APR. */
function series(points: number, aprPct = 40): PricePoint[] {
  const out: PricePoint[] = [];
  const start = 1_700_000_000;
  for (let i = 0; i < points; i++) {
    const drift = 1 + (0.15 * i) / points;
    const wave = 1 + 0.08 * Math.sin(i / 9);
    out.push({
      timestamp: start + i * 3600,
      price: 3000 * drift * wave,
      feeAprPct: aprPct,
    });
  }
  return out;
}

const options: LpWalkForwardOptions = {
  axes: {
    rangePcts: [5, 15],
    recenterBuffers: [0, 50],
    recenterMinHours: [24],
    regimeMaxMovePcts: [0],
    hedgeRatioPcts: [0],
    regimeMetrics: ["displacement"],
  },
  metric: "RETURN",
  input: {
    base: {
      initialUsdc: 10_000,
      initialEth: 0,
      feeBps: 5,
      slippageBps: 3,
      referenceRangePct: 25,
      regimeMaxMovePct: 0,
      regimeLookbackPoints: 288,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: 3,
      hedgeWhileParkedOnly: false,
      regimeMetric: "displacement" as const,
    },
    gas: 0.02,
  },
};

describe("lpWalkForward", () => {
  it("produces one result per fold with disjoint train/test windows", () => {
    const prices = series(2000);
    const folds = lpWalkForward(prices, 3, options);
    expect(folds).toHaveLength(3);
    for (const f of folds) {
      // Test starts after train ends — no overlap, no lookahead.
      expect(f.testRange[0]).toBeGreaterThanOrEqual(f.trainRange[1]);
      expect(f.trainYears).toBeGreaterThan(0);
      expect(f.testYears).toBeGreaterThan(0);
    }
  });

  it("expands the training window across folds", () => {
    const folds = lpWalkForward(series(2000), 3, options);
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i]!.trainRange[1]).toBeGreaterThan(folds[i - 1]!.trainRange[1]);
    }
  });

  it("applies the train-selected configuration verbatim to the test window", () => {
    const folds = lpWalkForward(series(2000), 2, options);
    for (const f of folds) {
      expect(f.test.rangePct).toBe(f.best.rangePct);
      expect(f.test.recenterBufferPct).toBe(f.best.recenterBufferPct);
      expect(f.test.recenterMinHours).toBe(f.best.recenterMinHours);
      // And it is drawn from the configured axes, not invented.
      expect(options.axes.rangePcts).toContain(f.best.rangePct);
    }
  });

  it("selects only from the axes it was given", () => {
    const folds = lpWalkForward(series(2000), 2, options);
    for (const f of folds) {
      expect(options.axes.recenterBuffers).toContain(f.best.recenterBufferPct);
    }
  });

  it("rejects a fold count the data cannot support", () => {
    expect(() => lpWalkForward(series(10), 8, options)).toThrow(/Not enough data/);
  });

  it("refuses fewer than one fold", () => {
    expect(() => lpWalkForward(series(2000), 0, options)).toThrow(/folds must be/);
  });
});

describe("lpTrainTest", () => {
  it("splits at the requested fraction", () => {
    const prices = series(1000);
    const fold = lpTrainTest(prices, 0.6, options);
    const trainSpan = fold.trainRange[1] - fold.trainRange[0];
    const total = prices[prices.length - 1]!.timestamp - prices[0]!.timestamp;
    expect(trainSpan / total).toBeCloseTo(0.6, 1);
  });
});

describe("selectLpConsensus", () => {
  it("ranks by fold wins before out-of-sample return", () => {
    const folds = lpWalkForward(series(2000), 3, options);
    const picks = selectLpConsensus(folds);
    expect(picks.length).toBeGreaterThan(0);
    for (let i = 1; i < picks.length; i++) {
      expect(picks[i - 1]!.foldWins).toBeGreaterThanOrEqual(picks[i]!.foldWins);
    }
    // Wins across all folds must sum to the fold count.
    expect(picks.reduce((a, p) => a + p.foldWins, 0)).toBe(folds.length);
  });

  it("reports the worst fold, not just the mean", () => {
    const folds = lpWalkForward(series(2000), 3, options);
    for (const p of selectLpConsensus(folds)) {
      expect(p.worstOosReturnPct).toBeLessThanOrEqual(p.meanOosReturnPct + 1e-9);
      expect(Number.isFinite(p.worstOosReturnPct)).toBe(true);
    }
  });
});
