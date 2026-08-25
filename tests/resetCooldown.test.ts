import { describe, expect, it } from "vitest";
import { GridStrategy } from "../src/grid/gridStrategy.js";
import { LinearCostFillModel } from "../src/grid/fillModel.js";
import type { GridConfig } from "../src/grid/types.js";

const T0 = 1_700_000_000;
const H = 3600;

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
    resetSellFraction: 1,
    resetUnderwaterSkipPct: 0,
    lpFeeBps: 0,
    lpVenueVolumeSharePct: 0,
    lpPoolLiquidityUsd: 0,
    lpFeeAprPct: 0,
    lpReferenceRangePct: 0,
    regimeMaxMovePct: 0,
    regimeLookbackPoints: 336,
    resetBufferLevels: 2,
    // Long cooldown so any rebuild inside it is unambiguously the new path.
    regenMinSeconds: 1000 * H,
    volLookbackPoints: 4,
    maxVolPerStep: 1,
    resetConfirmObservations: 0,
    resetVolPostpone: false,
    resetHardDrawdownPct: 0,
    resetHardInventoryLossPct: 0,
    resetSkipCooldownWhenFlat: false,
    resetBreakerK: 3,
    resetBreakerWindowSeconds: 30 * 24 * H,
    ...overrides,
  };
}

/** Ramp price UP out of the band. With no inventory nothing is sold. */
function exitUpwardFlat(s: GridStrategy): number {
  let t = T0;
  let price = 4000;
  s.onPriceUpdate(price, t);
  let guard = 0;
  while (s.getState().phase === "ACTIVE" && guard++ < 200) {
    price *= 1.01;
    t += H;
    s.onPriceUpdate(price, t);
  }
  return t;
}

describe("cooldown when the reset was flat", () => {
  it("still waits by default", () => {
    const s = new GridStrategy(makeConfig(), new LinearCostFillModel(0, 0));
    const t = exitUpwardFlat(s);
    expect(s.getState().phase).toBe("COOLDOWN");
    // Well inside the 1000h cooldown.
    s.onPriceUpdate(s.getState().lastPrice! * 1.0001, t + 5 * H);
    expect(s.getState().phase).toBe("COOLDOWN");
    expect(s.getState().resets).toBe(0);
  });

  it("rebuilds immediately when enabled and there was nothing to sell", () => {
    const s = new GridStrategy(
      makeConfig({ resetSkipCooldownWhenFlat: true }),
      new LinearCostFillModel(0, 0),
    );
    const t = exitUpwardFlat(s);
    const record = s.getState().resetRecords[0]!;
    // Precondition: the reset really was a pure re-centring.
    expect(record.ethInventoryBefore).toBe(0);
    expect(record.ethLiquidated).toBe(0);

    const price = s.getState().lastPrice! * 1.0001;
    s.onPriceUpdate(price, t + H);
    const st = s.getState();
    expect(st.phase).toBe("ACTIVE");
    expect(st.resets).toBe(1);
    // Re-centred on the current price, not the old centre.
    expect(st.centerPrice / price).toBeGreaterThan(0.99);
    expect(st.centerPrice / price).toBeLessThan(1.01);
  });

  it("still waits when the reset DID liquidate inventory", () => {
    // Seed ETH so the upward exit has something to sell: that reset carried
    // real risk, so the delay it was designed for still applies.
    const s = new GridStrategy(
      makeConfig({ initialEth: 2, resetSkipCooldownWhenFlat: true }),
      new LinearCostFillModel(0, 0),
    );
    const t = exitUpwardFlat(s);
    const record = s.getState().resetRecords[0]!;
    expect(record.ethInventoryBefore).toBeGreaterThan(0);

    s.onPriceUpdate(s.getState().lastPrice! * 1.0001, t + 5 * H);
    expect(s.getState().phase).toBe("COOLDOWN");
    expect(s.getState().resets).toBe(0);
  });

  it("completes the reset record on the fast path", () => {
    const s = new GridStrategy(
      makeConfig({ resetSkipCooldownWhenFlat: true }),
      new LinearCostFillModel(0, 0),
    );
    const t = exitUpwardFlat(s);
    s.onPriceUpdate(s.getState().lastPrice! * 1.0001, t + H);
    const st = s.getState();
    const record = st.resetRecords[0]!;
    // The bookkeeping must be identical to the slow path: a completed record
    // and one centre-history entry, or the reports lose a reset.
    expect(record.rebuiltAt).not.toBeNull();
    expect(record.newBounds).not.toBeNull();
    expect(st.centerHistory).toHaveLength(1);
    expect(st.centerHistory[0]!.resetId).toBe(record.id);
  });

  it("does not let a fast rebuild buy into a CHOPPY move", () => {
    // Volatility gate armed: after re-centring, crossing BUY levels while
    // realized volatility is high must still be skipped, which is what makes
    // skipping the cooldown safe.
    const s = new GridStrategy(
      makeConfig({ resetSkipCooldownWhenFlat: true, maxVolPerStep: 0.001, volLookbackPoints: 4 }),
      new LinearCostFillModel(0, 0),
    );
    const t = exitUpwardFlat(s);
    const base = s.getState().lastPrice!;
    let tt = t + H;
    s.onPriceUpdate(base, tt);
    expect(s.getState().phase).toBe("ACTIVE");

    // Violent chop, then down through the new grid's buy levels.
    for (const mult of [0.94, 1.07, 0.93, 1.08, 0.9, 0.92]) {
      tt += H;
      s.onPriceUpdate(s.getState().lastPrice! * mult, tt);
    }
    expect(s.getState().skips.some((k) => k.reason === "high_vol")).toBe(true);
  });

  it("does NOT protect against a smooth one-way trend (documented limit)", () => {
    // The volatility estimator is the std-dev of log returns, so a steady
    // decline registers as almost no volatility and the gate stays open.
    // Skipping the cooldown therefore removes the only brake on re-entering
    // a smooth downtrend: MAX_ETH_USD is the control for that case, not the
    // vol gate.
    const s = new GridStrategy(
      makeConfig({ resetSkipCooldownWhenFlat: true, maxVolPerStep: 0.001, volLookbackPoints: 4 }),
      new LinearCostFillModel(0, 0),
    );
    const t = exitUpwardFlat(s);
    let price = s.getState().lastPrice!;
    let tt = t + H;
    s.onPriceUpdate(price, tt);

    for (let i = 0; i < 5; i++) {
      price *= 0.97; // perfectly steady => near-zero measured volatility
      tt += H;
      s.onPriceUpdate(price, tt);
    }
    expect(s.getState().eth).toBeGreaterThan(0);
  });
});
