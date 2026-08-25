import { describe, expect, it } from "vitest";
import { GridStrategy } from "../src/grid/gridStrategy.js";
import { LinearCostFillModel } from "../src/grid/fillModel.js";
import type { GridConfig } from "../src/grid/types.js";

function makeConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    initialUsdc: 10_000,
    initialEth: 0,
    centerPrice: 4000,
    spacingPercent: 1,
    levelsAbove: 5,
    levelsBelow: 5,
    orderSizeUsd: 1000,
    executionMode: "taker",
    feeBps: 0,
    slippageBps: 0,
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

const T0 = 1_700_000_000;
const H = 3600;

describe("volatility gate on buys", () => {
  // Wide spacing (20%) so huge % swings do not cross any level:
  // levels are at 3333 / 4800 around the 4000 center.
  const cfg = () =>
    makeConfig({
      spacingPercent: 20,
      volLookbackPoints: 2, // arms after a couple of observations
      maxVolPerStep: 0.03, // separates +-12% swings (>gate) from <1.5% steps
      resetBufferLevels: 0, // keep reset logic out of this test
    });

  it("skips buys while realized volatility is above the threshold", () => {
    const s = new GridStrategy(cfg(), new LinearCostFillModel(0, 0));
    s.onPriceUpdate(4000, T0);
    // ±12% oscillation around the center: no level crossings, but high vol.
    let price = 4000;
    for (let i = 1; i <= 6; i++) {
      price = i % 2 === 1 ? 4500 : 4000;
      s.onPriceUpdate(price, T0 + i * H);
    }

    // Drop into the first BUY level (-1 = 3333): crossed but gated —
    // the gate deliberately counts the current violent move too.
    const actions = s.onPriceUpdate(3300, T0 + 7 * H);
    expect(actions).toHaveLength(0);
    expect(s.getState().eth).toBe(0);
    expect(s.getState().skips.filter((k) => k.reason === "high_vol").length).toBeGreaterThan(0);
  });

  it("allows buys again once volatility calms down", () => {
    const s = new GridStrategy(cfg(), new LinearCostFillModel(0, 0));
    s.onPriceUpdate(4000, T0);
    let price = 4000;
    for (let i = 1; i <= 6; i++) {
      price = i % 2 === 1 ? 4500 : 4000;
      s.onPriceUpdate(price, T0 + i * H);
    }
    // Crosses -1 while violent -> gated, level stays armed as BUY.
    s.onPriceUpdate(3300, T0 + 7 * H);

    // Calm flat period flushes the lookback window.
    let t = T0 + 8 * H;
    for (let i = 0; i < 3; i++) {
      s.onPriceUpdate(3300, t);
      t += H;
    }

    // Recross -1 from above with calm steps: gentle rise, gentle fall.
    s.onPriceUpdate(3340, t); // up-cross: no resting SELL below center
    t += H;
    const actions = s.onPriceUpdate(3330, t); // down-cross through 3333
    expect(actions.some((a) => a.type === "BUY")).toBe(true);
    expect(s.getState().eth).toBeGreaterThan(0);
  });
});

describe("cost-aware spacing floor", () => {
  it("rejects grids whose spread cannot pay the per-fill costs", () => {
    // 50bps fee => cost-aware minimum spacing is 10 * 0.0050 = 5%.
    expect(
      () => new GridStrategy(makeConfig({ spacingPercent: 1, feeBps: 50 }), new LinearCostFillModel(50, 0)),
    ).toThrow(/cost-aware minimum/);
  });

  it("accepts grids at or above the minimum", () => {
    expect(
      () => new GridStrategy(makeConfig({ spacingPercent: 5, feeBps: 50 }), new LinearCostFillModel(50, 0)),
    ).not.toThrow();
    // Default config: 5+3 bps costs, 1% spacing (min 0.8%) passes.
    expect(() => new GridStrategy(makeConfig(), new LinearCostFillModel(0, 0))).not.toThrow();
  });
});

describe("reset circuit breaker", () => {
  /** Ramp price upward until the grid exits its band; returns exit time. */
  function driveIntoExit(s: GridStrategy, startTime: number): number {
    let t = startTime;
    let price = s.getState().centerPrice;
    s.onPriceUpdate(price, t);
    let guard = 0;
    while (s.getState().phase === "ACTIVE" && guard++ < 300) {
      price *= 1.01;
      t += H;
      s.onPriceUpdate(price, t);
    }
    expect(s.getState().phase).toBe("COOLDOWN");
    return t;
  }

  /** Feed calm drifting prices long enough for any sane cooldown to elapse. */
  function calmRun(s: GridStrategy, startAt: number): number {
    let t = startAt;
    let price = s.getState().lastPrice ?? 4200;
    for (let i = 0; i < 40; i++) {
      price *= 1.0001;
      s.onPriceUpdate(price, t);
      t += H;
    }
    return t;
  }

  it("rebuilds normally when resets are rare", () => {
    const s = new GridStrategy(makeConfig({ initialEth: 2, regenMinSeconds: H }), new LinearCostFillModel(0, 0));
    const tExit = driveIntoExit(s, T0);
    calmRun(s, tExit + 2 * H);
    expect(s.getState().resets).toBe(1);
    expect(s.getState().phase).toBe("ACTIVE");
  });

  it("blocks rebuilding while the escalated cooldown is running", () => {
    const s = new GridStrategy(
      makeConfig({ initialEth: 2, regenMinSeconds: H, resetBreakerK: 1, volLookbackPoints: 4 }),
      new LinearCostFillModel(0, 0),
    );

    // Reset #1 -> breaker escalates immediately: required cooldown 1h*2^1 = 2h.
    let tExit = driveIntoExit(s, T0);
    // Probe at +1h: still cooling.
    s.onPriceUpdate(4250, tExit + H);
    expect(s.getState().phase).toBe("COOLDOWN");
    let t = calmRun(s, tExit + 2 * H);
    expect(s.getState().resets).toBe(1);

    // Reset #2 -> required cooldown 1h*2^2 = 4h.
    tExit = driveIntoExit(s, t);
    s.onPriceUpdate(4400, tExit + H);
    expect(s.getState().phase).toBe("COOLDOWN");
    s.onPriceUpdate(4400, tExit + 3 * H);
    expect(s.getState().phase).toBe("COOLDOWN"); // still within escalated window
    t = calmRun(s, tExit + 4 * H);
    expect(s.getState().resets).toBe(2);
    expect(s.getState().phase).toBe("ACTIVE");
  });
});
