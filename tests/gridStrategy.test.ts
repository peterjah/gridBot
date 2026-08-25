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

function makeStrategy(overrides: Partial<GridConfig> = {}) {
  return new GridStrategy(makeConfig(overrides), new LinearCostFillModel(0, 0));
}

const T0 = 1_700_000_000;
const H = 3600;

describe("grid basics", () => {
  it("generates multiplicative levels around the center", () => {
    const s = makeStrategy();
    const levels = s.getState().levels;
    expect(levels).toHaveLength(11);
    const l1 = levels.find((l) => l.index === 1)!;
    expect(l1.price).toBeCloseTo(4040, 6);
    expect(l1.side).toBe("SELL");
    const lm1 = levels.find((l) => l.index === -1)!;
    expect(lm1.price).toBeCloseTo(4000 / 1.01, 6);
    expect(lm1.side).toBe("BUY");
    expect(levels.find((l) => l.index === 0)!.side).toBeNull();
  });

  it("does not trade on the first observation", () => {
    const s = makeStrategy();
    expect(s.onPriceUpdate(4000, T0)).toHaveLength(0);
    expect(s.getState().usdc).toBe(10_000);
  });
});

describe("single level crossings", () => {
  it("buys when price falls one level (4000 -> 3960)", () => {
    const s = makeStrategy();
    s.onPriceUpdate(4000, T0);
    const lvl = s.getState().levels.find((l) => l.index === -1)!;
    const actions = s.onPriceUpdate(lvl.price, T0 + H);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "BUY", gridLevel: -1, price: lvl.price });
    const st = s.getState();
    expect(st.eth).toBeGreaterThan(0);
    expect(st.usdc).toBeCloseTo(10_000 - 1000, 6);
  });

  it("sells when price rises one level with inventory (4000 -> 4040)", () => {
    const s = makeStrategy({ initialEth: 2 });
    s.onPriceUpdate(4000, T0);
    const actions = s.onPriceUpdate(4040, T0 + H);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "SELL", gridLevel: 1 });
    const st = s.getState();
    expect(st.usdc).toBeGreaterThan(10_000);
  });
});

describe("multiple level crossings", () => {
  it("processes every crossed level on a large drop (4000 -> 3800)", () => {
    const s = makeStrategy();
    s.onPriceUpdate(4000, T0);
    // Crosses BUY levels -1..-5
    const actions = s.onPriceUpdate(3830, T0 + H); // 3830 < level -4? -4=3842.9 yes; -5=3802.4 no
    expect(actions.map((a) => (a.type === "BUY" ? a.gridLevel : null))).toEqual([-1, -2, -3, -4]);
    expect(s.getState().trades.filter((t) => t.side === "BUY")).toHaveLength(4);
  });

  it("processes every crossed SELL level upward when inventory allows", () => {
    const s = makeStrategy({ initialEth: 10 });
    s.onPriceUpdate(4000, T0);
    const actions = s.onPriceUpdate(4130, T0 + H); // crosses +1..+3
    expect(actions.map((a) => a.type)).toEqual(["SELL", "SELL", "SELL"]);
    expect(actions.map((a) => (a.type === "SELL" ? a.gridLevel : null))).toEqual([1, 2, 3]);
  });

  it("flips sides so a later reversal trades back", () => {
    const s = makeStrategy();
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(3960, T0 + H); // buy at -1; sell placed at 0
    const actions = s.onPriceUpdate(4000, T0 + 2 * H); // crosses sell at 0
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("SELL");
    const st = s.getState();
    expect(st.completedCycles).toBe(1);
    // Zero costs: gross profit ~= orderSize * spacing
    expect(st.realizedGrossUsd).toBeGreaterThan(9);
    expect(st.realizedGrossUsd).toBeLessThan(11);
  });
});

describe("oscillation", () => {
  it("repeatedly buys and sells as price oscillates", () => {
    const s = makeStrategy({ initialUsdc: 100_000 });
    s.onPriceUpdate(4000, T0);
    let buys = 0;
    let sells = 0;
    for (let i = 1; i <= 10; i++) {
      const price = i % 2 === 0 ? 4000 : 3960;
      for (const a of s.onPriceUpdate(price, T0 + i * H)) {
        if (a.type === "BUY") buys++;
        if (a.type === "SELL") sells++;
      }
    }
    expect(buys).toBe(5);
    expect(sells).toBe(5);
    const st = s.getState();
    expect(st.completedCycles).toBeGreaterThanOrEqual(5);
    expect(st.realizedGrossUsd).toBeGreaterThan(45); // ~$10 per cycle
    // Portfolio must not leak value with zero costs.
    const finalValue = s.getPortfolioValue(4000);
    expect(finalValue).toBeGreaterThan(100_040);
    expect(finalValue).toBeLessThan(100_060);
  });
});

describe("inventory limits and trends", () => {
  it("stops selling once ETH is exhausted in an uptrend", () => {
    const s = makeStrategy({ initialEth: 0.2 });
    s.onPriceUpdate(4000, T0);
    const actions = s.onPriceUpdate(4500, T0 + H); // crosses all 5 SELL levels
    const sells = actions.filter((a) => a.type === "SELL");
    expect(sells.length).toBeLessThan(5);
    expect(s.getState().skips.some((k) => k.reason === "no_eth")).toBe(true);
  });

  it("respects max ETH exposure on buys", () => {
    const s = makeStrategy({ maxEthUsd: 1500 });
    s.onPriceUpdate(4000, T0);
    const actions = s.onPriceUpdate(3800, T0 + H);
    // Only enough buys to reach ~$1500 exposure.
    const bought = actions.reduce((sum, a) => sum + (a.type === "BUY" ? a.quoteAmount : 0), 0);
    expect(bought).toBeLessThanOrEqual(2000);
    expect(s.getState().eth * 3800).toBeLessThanOrEqual(1600);
  });

  it("never spends more USDC than available in a crash", () => {
    const s = makeStrategy({
      initialUsdc: 5000,
      orderSizeUsd: 1000,
      resetBufferLevels: 0, // isolate the USDC constraint from reset logic
    });
    s.onPriceUpdate(4000, T0);
    let t = T0;
    for (let p = 3900; p >= 3200; p -= 100) {
      t += H;
      s.onPriceUpdate(p, t);
    }
    const st = s.getState();
    expect(st.usdc).toBeGreaterThanOrEqual(0);
    expect(st.usdc).toBeLessThan(5000); // some capital was deployed
    expect(st.eth).toBeGreaterThan(0); // inventory accumulated, never negative
  });

  it("respects min ETH exposure floor on sells", () => {
    const s = makeStrategy({
      initialEth: 1,
      minEthUsd: 3000, // ~0.75 ETH at 4000 must be kept
      orderSizeUsd: 1000,
      levelsAbove: 5,
      resetBufferLevels: 0, // isolate the floor from reset logic
    });
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(4300, T0 + H);
    const st = s.getState();
    expect(st.eth * 4300).toBeGreaterThanOrEqual(2999);
  });
});

describe("cost model accounting", () => {
  it("fees and slippage reduce realized profit below gross spread", () => {
    const s = new GridStrategy(
      makeConfig({ feeBps: 5, slippageBps: 5 }),
      new LinearCostFillModel(5, 5),
    );
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(3960, T0 + H); // buy
    s.onPriceUpdate(4000, T0 + 2 * H); // sell
    const st = s.getState();
    // Costs shrink the bought quantity, so level-price gross capture is
    // below the ideal $10 spread but still positive for 1% spacing.
    expect(st.realizedGrossUsd).toBeGreaterThan(8);
    expect(st.realizedGrossUsd).toBeLessThan(10);
    expect(st.totalFeeUsd).toBeGreaterThan(0);
    expect(st.totalSlippageUsd).toBeGreaterThan(0);
    // Net of costs the round trip should still be positive.
    const net = st.realizedGrossUsd - st.totalFeeUsd - st.totalSlippageUsd;
    expect(net).toBeGreaterThan(0);
  });
});

describe("grid reset / re-centering", () => {
  function driveIntoExit(s: GridStrategy): number {
    s.onPriceUpdate(4000, T0);
    // Ramp up until the exit band is breached.
    let t = T0;
    let price = 4000;
    while (price < 4420) {
      price *= 1.01;
      t += H;
      s.onPriceUpdate(price, t);
    }
    return t;
  }

  it("liquidates and enters cooldown when price exits the band", () => {
    const s = makeStrategy({ initialEth: 2 });
    const t = driveIntoExit(s);
    const st = s.getState();
    expect(st.phase).toBe("COOLDOWN");
    expect(st.eth).toBe(0);
    expect(st.usdc).toBeGreaterThan(0);
    expect(st.trades.some((tr) => tr.liquidation)).toBe(true);
    expect(t).toBeGreaterThan(T0); // sanity
  });

  it("does not rebuild before the minimum cooldown has elapsed", () => {
    const s = makeStrategy({ initialEth: 2, regenMinSeconds: 200 * H });
    driveIntoExit(s);
    expect(s.getState().phase).toBe("COOLDOWN");
    // Feed calm prices but less time than the cooldown requires.
    let t = T0 + 12 * H;
    for (let i = 0; i < 30; i++) {
      s.onPriceUpdate(4200, t);
      t += H;
    }
    expect(s.getState().phase).toBe("COOLDOWN");
  });

  it("stays in cooldown while volatility is high even after the delay", () => {
    const s = makeStrategy({ initialEth: 2, regenMinSeconds: H, maxVolPerStep: 0.005 });
    driveIntoExit(s);
    let t = T0 + 48 * H;
    // ±4% swings every hour => vol far above threshold.
    let price = 4300;
    for (let i = 0; i < 40; i++) {
      price *= i % 2 === 0 ? 0.96 : 1.04 / 0.96;
      s.onPriceUpdate(price, t);
      t += H;
    }
    expect(s.getState().phase).toBe("COOLDOWN");
  });

  it("rebuilds centered on the current price after cooldown with low volatility", () => {
    const s = makeStrategy({ initialEth: 2, regenMinSeconds: H });
    driveIntoExit(s);
    // Calm drift around 4300.
    let t = T0 + 48 * H;
    let price = 4300;
    for (let i = 0; i < 30; i++) {
      price *= 1.0001;
      s.onPriceUpdate(price, t);
      t += H;
    }
    const st = s.getState();
    expect(st.phase).toBe("ACTIVE");
    expect(st.resets).toBe(1);
    expect(st.centerPrice / price).toBeGreaterThan(0.99);
    expect(st.centerPrice / price).toBeLessThan(1.01);
    // Fresh grid is tradable again.
    const actions = s.onPriceUpdate(price * 0.985, t + H); // cross down into new grid
    expect(actions.some((a) => a.type === "BUY")).toBe(true);
  });

  it("reset can be disabled", () => {
    const s = makeStrategy({ initialEth: 2, resetBufferLevels: 0 });
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(6000, T0 + H);
    expect(s.getState().phase).toBe("ACTIVE");
    expect(s.getState().resets).toBe(0);
  });
});

describe("determinism", () => {
  it("produces identical results for identical input", () => {
    function run(): string {
      const s = makeStrategy({ initialEth: 1 });
      const prices = [4000, 3960, 4040, 3800, 3900, 4100, 4000, 3700];
      prices.forEach((p, i) => s.onPriceUpdate(p, T0 + i * H));
      return JSON.stringify(s.getState());
    }
    expect(run()).toBe(run());
  });
});
