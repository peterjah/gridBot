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
    regenMinSeconds: 3600,
    volLookbackPoints: 4,
    maxVolPerStep: 1, // vol postpone off unless overridden
    resetSkipCooldownWhenFlat: false,
    resetBreakerK: 3,
    resetBreakerWindowSeconds: 30 * 24 * H,
    resetConfirmObservations: 0,
    resetVolPostpone: false,
    resetHardDrawdownPct: 25,
    resetHardInventoryLossPct: 0,
    ...overrides,
  };
}

/**
 * Drive price beyond the band (2 spacings past ±5 levels ≈ ±7%+) and return
 * whether a reset fired.
 */
function runExitSequence(
  s: GridStrategy,
  direction: "up" | "down",
  steps: number,
  startTs: number,
): boolean {
  let t = startTs;
  let resetsSeen = s.getState().resets;
  for (let i = 0; i < steps; i++) {
    const prev = s.getState().lastPrice ?? 4000;
    const stepPct = 0.02; // 2% per bar: crosses into the band quickly
    const next = direction === "up" ? prev * (1 + stepPct) : prev * (1 - stepPct);
    s.onPriceUpdate(next, t);
    t += H;
    if (s.getState().resets > resetsSeen) return true;
    void next;
  }
  void resetsSeen;
  resetsSeen = s.getState().resets; // silence unused warnings in some vitest configs
  return s.getState().phase === "COOLDOWN";
}

describe("reset confirmation", () => {
  it("does not reset on a single brief excursion when confirmation is required", () => {
    const s = new GridStrategy(makeConfig({ resetConfirmObservations: 3 }), new LinearCostFillModel(0, 0));
    s.onPriceUpdate(4000, T0);
    // One close far below the band...
    s.onPriceUpdate(3600, T0 + H);
    expect(s.getState().phase).toBe("ACTIVE");
    expect(s.getState().resets).toBe(0);
    // ...then back inside: a later excursion needs fresh confirmations.
    s.onPriceUpdate(4000, T0 + 2 * H);
    s.onPriceUpdate(3600, T0 + 3 * H);
    expect(s.getState().phase).toBe("ACTIVE"); // only 1 consecutive close
  });

  it("resets after enough consecutive closes outside", () => {
    const s = new GridStrategy(makeConfig({ resetConfirmObservations: 2 }), new LinearCostFillModel(0, 0));
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(3600, T0 + H); // outside #1
    expect(s.getState().resets).toBe(0);
    s.onPriceUpdate(3580, T0 + 2 * H); // outside #2
    expect(s.getState().resets).toBe(0);
    s.onPriceUpdate(3560, T0 + 3 * H); // outside #3 > confirm=2
    // Liquidation fires on the confirming close (resets counts REBUILDS,
    // which happen later, after cooldown).
    expect(s.getState().phase).toBe("COOLDOWN");
  });

  it("defaults preserve immediate triggering (confirmation 0)", () => {
    const s = new GridStrategy(makeConfig(), new LinearCostFillModel(0, 0));
    s.onPriceUpdate(4000, T0);
    const fired = runExitSequence(s, "down", 10, T0 + H);
    expect(fired).toBe(true);
  });
});

describe("volatility-postponed liquidation", () => {
  it("delays liquidation while volatility is high, executes once calm", () => {
    const s = new GridStrategy(
      makeConfig({ resetVolPostpone: true, maxVolPerStep: 0.005, resetConfirmObservations: 0 }),
      new LinearCostFillModel(0, 0),
    );
    // Establish calm history first (small moves inside the band).
    s.onPriceUpdate(4000, T0);
    for (let i = 1; i <= 6; i++) {
      s.onPriceUpdate(4000 * (1 + (i % 2 === 0 ? 0.001 : -0.001)), T0 + i * H);
    }
    // Violent crash through the band: postponed.
    s.onPriceUpdate(3500, T0 + 7 * H);
    expect(s.getState().phase).toBe("ACTIVE");
    expect(s.getState().skips.some((k) => k.reason === "reset_postponed")).toBe(true);

    // Still outside the band, now calm → the grid re-centers. Note: with
    // the vol gate active the crash bars skipped the BUYs, so there was no
    // inventory to liquidate — the reset happens with zero trades.
    let t = T0 + 8 * H;
    let price = 3500;
    for (let i = 0; i < 6; i++) {
      price *= 1.0005;
      s.onPriceUpdate(price, t);
      t += H;
    }
    const st = s.getState();
    expect(st.centerPrice).toBeLessThan(3990); // re-centered near the new price
    expect(st.usdc).toBeCloseTo(10_000, -1); // never dumped into the crash
  }, 60_000);
});

describe("hard-drawdown backstop", () => {
  it("forces full liquidation even with carry policies active", () => {
    const s = new GridStrategy(
      makeConfig({
        initialEth: 2, // pre-existing inventory gives the crash real drawdown
        resetSellFraction: 0, // would carry everything
        resetUnderwaterSkipPct: 90, // would carry everything underwater <90%
        resetHardDrawdownPct: 10,
        resetConfirmObservations: 5,
        resetVolPostpone: true,
      }),
      new LinearCostFillModel(0, 0),
    );
    s.onPriceUpdate(4000, T0); // peak = $18k
    // Crash hard: drawdown blows through 10% long before confirmations pass.
    s.onPriceUpdate(3000, T0 + H);
    // Forced: liquidated immediately despite confirmations pending...
    expect(s.getState().phase).toBe("COOLDOWN");
    // ...and everything was sold despite fraction=0.
    expect(s.getState().eth).toBe(0);
    const resetRecord = s.getState().trades.find((t) => t.liquidation);
    expect(resetRecord).toBeDefined();
  });
});

describe("hard backstops", () => {
  /** Buy inventory, then crash so it is deeply underwater. */
  function buyThenCrash(overrides: Partial<GridConfig>, crashTo: number) {
    const s = new GridStrategy(
      makeConfig({ resetBufferLevels: 0, ...overrides }),
      new LinearCostFillModel(0, 0),
    );
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(3900, T0 + H); // fills BUY levels
    s.onPriceUpdate(crashTo, T0 + 2 * H);
    return s;
  }

  it("portfolio drawdown alone cannot fire when fees dominate the book", () => {
    // The real failure mode: a position 35% underwater moves total portfolio
    // value only slightly, because most of the balance is cash. A 20%
    // PORTFOLIO threshold therefore never trips.
    const s = buyThenCrash({ resetHardDrawdownPct: 20 }, 2600);
    const st = s.getState();
    const inventoryValue = st.eth * 2600;
    const portfolio = st.usdc + inventoryValue;
    expect(st.eth).toBeGreaterThan(0);
    // Position deeply underwater...
    expect(inventoryValue / st.costBasisUsd - 1).toBeLessThan(-0.3);
    // ...yet portfolio barely moved, so no forced liquidation happened.
    expect(portfolio / 10_000 - 1).toBeGreaterThan(-0.2);
    expect(st.resetRecords).toHaveLength(0);
  });

  it("the inventory backstop fires on the same move", () => {
    const s = buyThenCrash({ resetHardInventoryLossPct: 25 }, 2600);
    const st = s.getState();
    expect(st.resetRecords).toHaveLength(1);
    expect(st.eth).toBe(0);
    // Forced liquidation is full, ignoring carry policies.
    expect(st.resetRecords[0]!.ethCarried).toBe(0);
  });

  it("does not fire on a shallow loss", () => {
    const s = buyThenCrash({ resetHardInventoryLossPct: 25 }, 3800);
    expect(s.getState().resetRecords).toHaveLength(0);
    expect(s.getState().eth).toBeGreaterThan(0);
  });

  it("overrides the underwater-carry policy", () => {
    // resetUnderwaterSkipPct would normally carry the position; the backstop
    // has to win, or "carry small losses, cut large ones" does not hold.
    const s = buyThenCrash(
      { resetUnderwaterSkipPct: 5, resetHardInventoryLossPct: 25 },
      2600,
    );
    expect(s.getState().eth).toBe(0);
  });

  it("is off by default", () => {
    const s = buyThenCrash({}, 2600);
    expect(s.getState().resetRecords).toHaveLength(0);
  });
});

describe("confirmation guard with a flat book", () => {
  it("does not delay a re-centring that has nothing to liquidate", () => {
    // Flat book: confirmation protects nothing, so the reset should fire on
    // the first observation outside the band rather than waiting.
    const s = new GridStrategy(
      makeConfig({ resetConfirmObservations: 5, resetBufferLevels: 2 }),
      new LinearCostFillModel(0, 0),
    );
    s.onPriceUpdate(4000, T0);
    s.onPriceUpdate(4600, T0 + H); // far outside the band, no inventory
    expect(s.getState().resetRecords).toHaveLength(1);
    expect(s.getState().resetRecords[0]!.ethInventoryBefore).toBe(0);
  });

  it("still waits when there IS inventory to protect", () => {
    const s = new GridStrategy(
      makeConfig({ resetConfirmObservations: 5, resetBufferLevels: 2, initialEth: 2 }),
      new LinearCostFillModel(0, 0),
    );
    s.onPriceUpdate(4000, T0);
    // Jump far above the band: SELL levels fill but inventory remains, so the
    // whipsaw guard should still hold the liquidation back.
    s.onPriceUpdate(4600, T0 + H);
    expect(s.getState().eth).toBeGreaterThan(0);
    expect(s.getState().resetRecords).toHaveLength(0);
  });
});
