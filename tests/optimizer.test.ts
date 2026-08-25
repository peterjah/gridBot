import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GridConfig } from "../src/grid/types.js";
import type { PricePoint } from "../src/data/provider.js";
import {
  buildCandidates,
  candidateConfig,
  candidateSpec,
  evaluate,
  feasibility,
  levelsForWidth,
  parseRankMetric,
  rank,
  riskAdjusted,
  scoreRobustness,
  sweep,
} from "../src/backtest/optimizer.js";
import type { ConfigMetrics, EvaluationInput } from "../src/backtest/optimizer.js";
import { regimeStats, splitPeriods, trainTestSplit } from "../src/backtest/periods.js";
import { evaluateScenario, selectWindows } from "../src/backtest/scenario.js";
import { trainTest, walkForward } from "../src/backtest/walkForward.js";
import {
  candidateFromConfig,
  formatComparison,
  loadRuns,
  saveRun,
} from "../src/backtest/runStore.js";
import { applyNamedConfig } from "../src/cli.js";
import type { AppConfig } from "../src/config.js";

const T0 = Date.UTC(2025, 0, 1) / 1000;
const H = 3600;

function base(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    initialUsdc: 10_000,
    initialEth: 0,
    centerPrice: 4000,
    spacingPercent: 1,
    levelsAbove: 5,
    levelsBelow: 5,
    orderSizeUsd: 1000,
    executionMode: "taker",
    feeBps: 5,
    slippageBps: 3,
    minEthUsd: 0,
    maxEthUsd: Number.POSITIVE_INFINITY,
    resetBufferLevels: 2,
    resetSellFraction: 1,
    resetUnderwaterSkipPct: 0,
    lpFeeBps: 5,
    lpVenueVolumeSharePct: 5,
    lpPoolLiquidityUsd: 0,
    lpFeeAprPct: 0,
    lpReferenceRangePct: 0,
    regimeMaxMovePct: 0,
    regimeLookbackPoints: 336,
    regenMinSeconds: 3600,
    volLookbackPoints: 24,
    maxVolPerStep: 0.005,
    resetConfirmObservations: 0,
    resetVolPostpone: false,
    resetHardDrawdownPct: 25,
    resetHardInventoryLossPct: 0,
    resetSkipCooldownWhenFlat: false,
    resetBreakerK: 3,
    resetBreakerWindowSeconds: 30 * 24 * 3600,
    ...overrides,
  };
}

function walk(steps: number, drift = 0): PricePoint[] {
  const points: PricePoint[] = [];
  let price = 4000;
  let seed = 987654321;
  for (let i = 0; i < steps; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    price *= 1 + drift + (seed / 2147483648 - 0.5) * 0.012;
    points.push({ timestamp: T0 + i * H, price });
  }
  return points;
}

const input = (prices: PricePoint[]): EvaluationInput => ({
  prices,
  base: base(),
  estimatedGasUsd: 0.02,
});

describe("grid width -> level count", () => {
  it("derives levels from width and spacing", () => {
    // 1.01^5 ≈ 1.051, so ±5% at 1% spacing is 5 levels.
    expect(levelsForWidth(5, 1)).toBe(5);
    expect(levelsForWidth(20, 1)).toBe(18);
    expect(levelsForWidth(30, 3)).toBe(9);
  });

  it("never produces a degenerate grid", () => {
    expect(levelsForWidth(1, 3)).toBe(1);
    expect(() => levelsForWidth(10, 0)).toThrow();
  });
});

describe("candidate generation and feasibility", () => {
  it("enumerates the full cartesian product", () => {
    const candidates = buildCandidates(
      { spacings: [1, 2], widths: [10, 20], resetBuffers: [1, 2, 3], orderFractions: [5] },
      10_000,
    );
    expect(candidates).toHaveLength(2 * 2 * 3 * 1);
    expect(candidates[0]!.orderSizeUsd).toBe(500);
  });

  it("rejects configurations that need more capital than exists", () => {
    const [candidate] = buildCandidates(
      { spacings: [1], widths: [20], resetBuffers: [2], orderFractions: [10] },
      10_000,
    );
    // 18 buy levels x $1,000 = $18,000 > $10,000.
    expect(feasibility(candidate!, base())).toMatch(/needs/);
  });

  it("rejects spacings that cannot pay their own costs", () => {
    const [candidate] = buildCandidates(
      { spacings: [0.25], widths: [5], resetBuffers: [2], orderFractions: [1] },
      10_000,
    );
    expect(feasibility(candidate!, base())).toMatch(/cost-aware/);
  });

  it("accepts a configuration that fits the capital", () => {
    const [candidate] = buildCandidates(
      { spacings: [1], widths: [5], resetBuffers: [2], orderFractions: [10] },
      10_000,
    );
    expect(feasibility(candidate!, base())).toBeNull();
  });
});

describe("sweep", () => {
  const axes = { spacings: [1, 2], widths: [5, 10], resetBuffers: [2, 3], orderFractions: [2, 5] };

  it("runs every feasible candidate and records the rest", () => {
    const result = sweep(axes, input(walk(600)));
    expect(result.generated).toBe(16);
    expect(result.metrics.length + result.skipped.length).toBe(16);
    expect(result.metrics.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const prices = walk(600);
    const a = sweep(axes, input(prices)).metrics.map((m) => m.finalPortfolioValue);
    const b = sweep(axes, input(prices)).metrics.map((m) => m.finalPortfolioValue);
    expect(a).toEqual(b);
  });

  it("computes benchmarks for every configuration", () => {
    const result = sweep(axes, input(walk(600, 0.0008)));
    for (const m of result.metrics) {
      expect(m.benchmarks.usdcReturnPct).toBeCloseTo(0, 9);
      expect(m.benchmarks.vsEthPct).toBeCloseTo(m.returnPercent - m.benchmarks.ethReturnPct, 9);
    }
  });
});

describe("ranking", () => {
  const make = (over: Partial<ConfigMetrics>): ConfigMetrics =>
    ({
      returnPercent: 0,
      maxDrawdownPct: -1,
      totalGridPnL: 0,
      riskAdjustedScore: 0,
      ...over,
    }) as ConfigMetrics;

  it("ranks by return by default", () => {
    const ranked = rank(
      [make({ returnPercent: 1 }), make({ returnPercent: 5 }), make({ returnPercent: 3 })],
      "RETURN",
    );
    expect(ranked.map((m) => m.returnPercent)).toEqual([5, 3, 1]);
  });

  it("ranks by shallowest drawdown", () => {
    const ranked = rank(
      [make({ maxDrawdownPct: -9 }), make({ maxDrawdownPct: -1 }), make({ maxDrawdownPct: -4 })],
      "DRAWDOWN",
    );
    expect(ranked.map((m) => m.maxDrawdownPct)).toEqual([-1, -4, -9]);
  });

  it("ranks by grid P&L", () => {
    const ranked = rank([make({ totalGridPnL: 10 }), make({ totalGridPnL: 90 })], "GRID_PNL");
    expect(ranked[0]!.totalGridPnL).toBe(90);
  });

  it("ranks by the risk-adjusted score", () => {
    const ranked = rank(
      [make({ riskAdjustedScore: 0.5 }), make({ riskAdjustedScore: 2.5 })],
      "RISK_ADJUSTED",
    );
    expect(ranked[0]!.riskAdjustedScore).toBe(2.5);
  });

  it("handles zero drawdown without dividing by zero", () => {
    expect(riskAdjusted(5, 0)).toBe(5);
    expect(Number.isFinite(riskAdjusted(5, 0))).toBe(true);
    expect(riskAdjusted(4, -2)).toBe(2);
    expect(riskAdjusted(-4, -2)).toBe(-2);
  });

  it("parses metric names case-insensitively and rejects unknown ones", () => {
    expect(parseRankMetric("risk_adjusted")).toBe("RISK_ADJUSTED");
    expect(parseRankMetric("Risk-Adjusted")).toBe("RISK_ADJUSTED");
    expect(parseRankMetric(undefined)).toBe("RETURN");
    expect(() => parseRankMetric("sharpe")).toThrow(/Unknown optimizer metric/);
  });
});

describe("periods", () => {
  it("splits a single-year dataset into quarters", () => {
    const periods = splitPeriods(walk(400));
    expect(periods[0]!.name).toBe("Full period");
    expect(periods.map((p) => p.name)).toContain("First quarter");
    expect(periods).toHaveLength(5);
    // Quarters must tile the series without gaps or overlap.
    const covered = periods.slice(1).reduce((n, p) => n + p.prices.length, 0);
    expect(covered).toBe(400);
  });

  it("splits a multi-year dataset by calendar year", () => {
    const prices = walk(24 * 400); // spans two calendar years
    const periods = splitPeriods(prices);
    expect(periods.slice(1).map((p) => p.name)).toEqual(["2025", "2026"]);
  });

  it("splits chronologically into train and test", () => {
    const prices = walk(500);
    const { train, test } = trainTestSplit(prices, 0.6);
    expect(train).toHaveLength(300);
    expect(test).toHaveLength(200);
    // No leakage: the test window starts strictly after the train window ends.
    expect(test[0]!.timestamp).toBeGreaterThan(train[train.length - 1]!.timestamp);
  });

  it("rejects splits that leave too little data", () => {
    expect(() => trainTestSplit(walk(3), 0.9)).toThrow(/Not enough data/);
    expect(() => trainTestSplit(walk(100), 0)).toThrow(/trainFraction/);
  });

  it("describes the regime of a period", () => {
    const up = regimeStats(walk(600, 0.002));
    expect(up.movePct).toBeGreaterThan(15);
    expect(up.label).toMatch(/^bull/);
    expect(up.annualizedVolPct).toBeGreaterThan(0);
    const down = regimeStats(walk(600, -0.002));
    expect(down.label).toMatch(/^bear/);
  });
});

describe("walk-forward", () => {
  const options = {
    axes: { spacings: [1, 2], widths: [5, 10], resetBuffers: [2], orderFractions: [5] },
    metric: "RETURN" as const,
    input: { base: base(), estimatedGasUsd: 0.02 },
  };

  it("selects on train and reports on unseen test data", () => {
    const prices = walk(1200, 0.0005);
    const fold = trainTest(prices, 0.6, options);
    expect(fold.trainRange[1]).toBeLessThanOrEqual(fold.testRange[0]);
    expect(fold.best.spacingPercent).toBeGreaterThan(0);
    expect(Number.isFinite(fold.test.returnPercent)).toBe(true);
  });

  it("produces one result per fold with disjoint test windows", () => {
    const folds = walkForward(walk(1600), 3, options);
    expect(folds).toHaveLength(3);
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i]!.testRange[0]).toBeGreaterThanOrEqual(folds[i - 1]!.testRange[1]);
      // Expanding window: each fold trains on strictly more data.
      expect(folds[i]!.trainRange[1]).toBeGreaterThan(folds[i - 1]!.trainRange[1]);
    }
  });

  it("refuses to run more folds than the data supports", () => {
    expect(() => walkForward(walk(10), 20, options)).toThrow(/Not enough data/);
  });
});

describe("evaluate", () => {
  it("centers the grid on the first price of the evaluated window", () => {
    const prices = walk(400);
    const [candidate] = buildCandidates(
      { spacings: [1], widths: [5], resetBuffers: [2], orderFractions: [5] },
      10_000,
    );
    const metrics = evaluate(candidate!, input(prices));
    expect(metrics.finalPortfolioValue).toBeGreaterThan(0);
    // Auto-centering means the grid is live from the first observation
    // instead of starting far outside its own band.
    expect(metrics.numberOfTrades).toBeGreaterThan(0);
  });
});

describe("risk axes", () => {
  it("collapses to the original 4-axis product when risk axes are empty", () => {
    const axes = { spacings: [1, 2], widths: [5], resetBuffers: [2], orderFractions: [5] };
    const candidates = buildCandidates(axes, 10_000);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.maxVolPerStep).toBeUndefined();
    expect(candidates[0]!.inventoryCapPercent).toBeUndefined();
  });

  it("expands the product over the risk axes when they are set", () => {
    const candidates = buildCandidates(
      {
        spacings: [1],
        widths: [5],
        resetBuffers: [2],
        orderFractions: [5],
        maxVols: [0.005, 0.02],
        inventoryCaps: [0, 20],
        cooldownHours: [6, 72],
      },
      10_000,
    );
    expect(candidates).toHaveLength(8);
  });

  it("materializes risk axes into the runnable config", () => {
    const prices = walk(200);
    const [candidate] = buildCandidates(
      {
        spacings: [1],
        widths: [5],
        resetBuffers: [2],
        orderFractions: [5],
        maxVols: [0.03],
        inventoryCaps: [25],
        cooldownHours: [48],
      },
      10_000,
    );
    const cfg = candidateConfig(candidate!, input(prices));
    expect(cfg.maxVolPerStep).toBe(0.03);
    expect(cfg.maxEthUsd).toBeCloseTo(2500, 6);
    expect(cfg.regenMinSeconds).toBe(48 * 3600);
  });

  it("treats a zero inventory cap as uncapped", () => {
    const [candidate] = buildCandidates(
      { spacings: [1], widths: [5], resetBuffers: [2], orderFractions: [5], inventoryCaps: [0] },
      10_000,
    );
    const cfg = candidateConfig(candidate!, input(walk(200)));
    expect(cfg.maxEthUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it("rejects an inventory cap smaller than one order", () => {
    const [candidate] = buildCandidates(
      { spacings: [1], widths: [5], resetBuffers: [2], orderFractions: [10], inventoryCaps: [5] },
      10_000,
    );
    expect(feasibility(candidate!, base())).toMatch(/inventory cap/);
  });

  it("round-trips a candidate through its --config spec", () => {
    const [candidate] = buildCandidates(
      {
        spacings: [2],
        widths: [20],
        resetBuffers: [3],
        orderFractions: [5],
        maxVols: [0.02],
        cooldownHours: [72],
      },
      10_000,
    );
    const spec = candidateSpec(candidate!);
    expect(spec).toContain("spacing=2");
    expect(spec).toContain("max-vol=0.02");
    expect(spec).toContain("cooldown=72");

    const cfg = { grid: base() } as AppConfig;
    applyNamedConfig(cfg, spec);
    expect(cfg.grid.spacingPercent).toBe(2);
    expect(cfg.grid.maxVolPerStep).toBe(0.02);
    expect(cfg.grid.regenMinSeconds).toBe(72 * 3600);
    expect(cfg.grid.resetBufferLevels).toBe(3);
  });
});

describe("run store", () => {
  it("round-trips a saved run", () => {
    const dir = mkdtempSync(join(tmpdir(), "gridbot-runs-"));
    const metrics = evaluate(
      buildCandidates(
        { spacings: [1], widths: [5], resetBuffers: [2], orderFractions: [5] },
        10_000,
      )[0]!,
      input(walk(400)),
    );
    saveRun(dir, {
      label: "exp one",
      mode: "optimize",
      createdAt: new Date().toISOString(),
      dataFile: "data/sample-prices.csv",
      periodStart: T0,
      periodEnd: T0 + 400 * H,
      initialCapital: 10_000,
      spec: "spacing=1,width=5,reset=2,order=5",
      description: "test run",
      metrics,
    });
    const loaded = loadRuns(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.label).toBe("exp one");
    expect(loaded[0]!.metrics.returnPercent).toBeCloseTo(metrics.returnPercent, 9);
    // The label is sanitized into a directory name, not used verbatim.
    expect(formatComparison(loaded)).toContain("exp one");
  });

  it("reconstructs a candidate from a plain config", () => {
    const candidate = candidateFromConfig(base({ orderSizeUsd: 500 }), 10_000);
    expect(candidate.spacingPercent).toBe(1);
    expect(candidate.levelsAbove).toBe(5);
    expect(candidate.orderSizePercent).toBeCloseTo(5, 6);
    // ±5 levels at 1% spacing is a ±5.1% band.
    expect(candidate.widthPercent).toBeCloseTo(5.1, 1);
  });

  it("reports an empty store without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "gridbot-empty-"));
    expect(loadRuns(dir)).toEqual([]);
    expect(formatComparison([])).toContain("No saved runs found");
  });
});

describe("scenario windows", () => {
  /** Hourly series with a controllable drift, plus a data outage. */
  function hourly(steps: number, drift: number, gapAt?: number): PricePoint[] {
    const points: PricePoint[] = [];
    let price = 2000;
    let t = T0;
    for (let i = 0; i < steps; i++) {
      price *= 1 + drift;
      points.push({ timestamp: t, price });
      // Simulate an exchange outage: several hours with no candles.
      t += i === gapAt ? 6 * H : H;
    }
    return points;
  }

  it("selects only windows inside the move filter", () => {
    // ~+0.008%/h compounds to roughly +100% over a year: too strong to match.
    const strong = selectWindows(hourly(24 * 500, 0.00008), {
      months: 6,
      stepDays: 30,
      moveMin: 10,
      moveMax: 60,
    });
    expect(strong.every((w) => w.movePct >= 10 && w.movePct <= 60)).toBe(true);

    const flat = selectWindows(hourly(24 * 500, 0), {
      months: 6,
      stepDays: 30,
      moveMin: 10,
      moveMax: 60,
    });
    expect(flat).toHaveLength(0);
  });

  it("applies volatility bounds", () => {
    const windows = selectWindows(hourly(24 * 500, 0.00005), {
      months: 6,
      stepDays: 30,
      moveMin: -100,
      moveMax: 100,
      volMin: 1000,
    });
    expect(windows).toHaveLength(0);
  });

  it("sizes windows from the median gap, not the average", () => {
    // One long outage must not shrink every window: with a mean-based step
    // the window would come up materially short in wall-clock time.
    const withGap = selectWindows(hourly(24 * 400, 0.00002, 100), {
      months: 6,
      stepDays: 30,
      moveMin: -100,
      moveMax: 100,
    });
    expect(withGap.length).toBeGreaterThan(0);
    const w = withGap[0]!;
    const spanDays =
      (w.prices[w.prices.length - 1]!.timestamp - w.prices[0]!.timestamp) / 86_400;
    expect(spanDays).toBeGreaterThan(178);
  });

  it("returns nothing when the history is shorter than one window", () => {
    expect(
      selectWindows(hourly(100, 0), { months: 12, stepDays: 30, moveMin: -100, moveMax: 100 }),
    ).toEqual([]);
  });

  it("ranks on the median across windows, not the best one", () => {
    const windows = selectWindows(hourly(24 * 500, 0.00004), {
      months: 6,
      stepDays: 60,
      moveMin: -100,
      moveMax: 100,
    });
    expect(windows.length).toBeGreaterThan(1);
    const [candidate] = buildCandidates(
      { spacings: [2], widths: [10], resetBuffers: [2], orderFractions: [5] },
      10_000,
    );
    const result = evaluateScenario(candidate!, windows, {
      base: base(),
      estimatedGasUsd: 0.02,
    });
    expect(result.perWindow).toHaveLength(windows.length);
    expect(result.minReturnPct).toBeLessThanOrEqual(result.medianReturnPct);
    expect(result.medianReturnPct).toBeLessThanOrEqual(result.maxReturnPct);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
  });
});

describe("robustness scoring", () => {
  const mk = (
    spacingPercent: number,
    orderSizePercent: number,
    returnPercent: number,
  ): ConfigMetrics =>
    ({
      candidate: {
        spacingPercent,
        widthPercent: 10,
        levelsAbove: 5,
        levelsBelow: 5,
        resetBufferLevels: 2,
        orderSizePercent,
        orderSizeUsd: 100,
      },
      returnPercent,
      maxDrawdownPct: -1,
      totalGridPnL: 0,
      riskAdjustedScore: 0,
      robustScore: returnPercent,
      neighbourCount: 0,
    }) as ConfigMetrics;

  it("penalizes an isolated spike and rewards a plateau", () => {
    // A 3x3 grid: one lucky spike at (1,1) surrounded by zeros, and a plateau
    // of solid values around (3,5).
    const metrics = [
      mk(1, 1, 100), // the spike
      mk(1, 2, 0),
      mk(2, 1, 0),
      mk(2, 2, 0),
      mk(3, 5, 40), // plateau centre
      mk(3, 10, 40),
      mk(2, 5, 40),
      mk(3, 2, 40),
    ];
    scoreRobustness(metrics);
    const spike = metrics.find((m) => m.returnPercent === 100)!;
    const plateau = metrics.find(
      (m) => m.candidate.spacingPercent === 3 && m.candidate.orderSizePercent === 5,
    )!;
    // The spike's neighbours are all zero, so its median collapses.
    expect(spike.robustScore).toBeLessThan(spike.returnPercent);
    expect(plateau.robustScore).toBeGreaterThan(spike.robustScore);
    // Ranking by ROBUST must prefer the plateau; by RETURN, the spike.
    expect(rank(metrics, "RETURN")[0]!.returnPercent).toBe(100);
    expect(rank(metrics, "ROBUST")[0]!.robustScore).toBe(plateau.robustScore);
  });

  it("leaves a configuration with no neighbours on its own return", () => {
    const metrics = [mk(1, 1, 42)];
    scoreRobustness(metrics);
    expect(metrics[0]!.neighbourCount).toBe(0);
    expect(metrics[0]!.robustScore).toBe(42);
  });

  it("counts only adjacent values on a single axis", () => {
    // Values 1,2,3 on one axis: the middle one has two neighbours, the ends
    // one each. A diagonal move (two axes at once) is not a neighbour.
    const metrics = [mk(1, 1, 10), mk(2, 1, 20), mk(3, 1, 30), mk(2, 2, 99)];
    scoreRobustness(metrics);
    const mid = metrics.find(
      (m) => m.candidate.spacingPercent === 2 && m.candidate.orderSizePercent === 1,
    )!;
    expect(mid.neighbourCount).toBe(3); // 1, 3 on spacing; 2 on order size
    const corner = metrics.find((m) => m.returnPercent === 99)!;
    expect(corner.neighbourCount).toBe(1); // only (2,1)
  });

  it("is populated automatically by a sweep", () => {
    const result = sweep(
      { spacings: [1, 2, 3], widths: [10, 20], resetBuffers: [2], orderFractions: [5] },
      input(walk(500)),
    );
    expect(result.metrics.length).toBeGreaterThan(2);
    expect(result.metrics.some((m) => m.neighbourCount > 0)).toBe(true);
  });
});
