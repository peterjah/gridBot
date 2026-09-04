import { describe, expect, it } from "vitest";
import {
  ethHoldBenchmark,
  staticLpBenchmark,
  usdcOnlyBenchmark,
  passiveLpWithFeesBenchmark,
} from "../src/backtest/benchmarks.js";
import {
  MAX_CONCENTRATION_MULTIPLIER,
  concentrationMultiplier,
  feeShareOfPool,
  liquidityDensity,
} from "../src/lp/concentration.js";
import { runPassiveLp } from "../src/lp/passiveLp.js";

const input = { initialUsdc: 10_000, initialEth: 0 };

describe("benchmarks", () => {
  it("flat prices leave every benchmark unchanged", () => {
    const prices = [1, 2, 3].map((i) => ({ timestamp: i * 3600, price: 4000 }));
    expect(usdcOnlyBenchmark({ ...input, prices }, 4000).finalValue).toBeCloseTo(10_000);
    expect(ethHoldBenchmark({ ...input, prices }).finalValue).toBeCloseTo(10_000);
    expect(staticLpBenchmark({ ...input, prices }).finalValue).toBeCloseTo(10_000, 6);
    expect(staticLpBenchmark({ ...input, prices }).impermanentLossUsd).toBeCloseTo(0, 4);
  });

  it("ETH hold tracks price exactly", () => {
    const prices = [
      { timestamp: 0, price: 2000 },
      { timestamp: 3600, price: 3000 },
    ];
    expect(ethHoldBenchmark({ ...input, prices }).finalValue).toBeCloseTo(15_000);
  });

  it("static LP never beats HODL of the same split (IL <= 0)", () => {
    // Random-ish zigzag path.
    const prices = [4000, 4300, 3800, 4500, 3600, 4200, 3300].map((price, i) => ({
      timestamp: i * 3600,
      price,
    }));
    const lp = staticLpBenchmark({ ...input, prices });
    expect(lp.impermanentLossUsd!).toBeLessThanOrEqual(0.01);
  });

  it("static LP returns exactly its capital on a price round trip", () => {
    const prices = [
      { timestamp: 0, price: 4000 },
      { timestamp: 3600, price: 4500 },
      { timestamp: 7200, price: 3600 },
      { timestamp: 10800, price: 4000 },
    ];
    const lp = staticLpBenchmark({ ...input, prices });
    expect(lp.finalValue).toBeCloseTo(10_000, 4);
    expect(lp.impermanentLossUsd!).toBeCloseTo(0, 4);
  });
});

describe("passive LP with fees", () => {
  const flat = (steps: number, feeAprPct: number, price = 2000) =>
    Array.from({ length: steps }, (_, i) => ({
      timestamp: 1_700_000_000 + i * 3600,
      price,
      feeAprPct,
    }));

  it("earns nothing when no fee series is supplied", () => {
    const b = passiveLpWithFeesBenchmark(
      { prices: flat(100, 0), initialUsdc: 10_000, initialEth: 0 },
      30,
    );
    expect(b.feeIncomeUsd).toBe(0);
  });

  it("accrues fees on the whole position while in range", () => {
    const b = passiveLpWithFeesBenchmark(
      { prices: flat(24 * 365 + 1, 10), initialUsdc: 10_000, initialEth: 0 },
      30,
    );
    // A full year at 10% on ~$10k, compounding: above simple interest.
    expect(b.feeIncomeUsd!).toBeGreaterThan(1000);
    expect(b.feeIncomeUsd!).toBeLessThan(1100);
  });

  it("stops earning once price leaves the range", () => {
    const inRange = flat(200, 20, 2000);
    const outOfRange = flat(200, 20, 5000); // far above a ±30% band
    const a = passiveLpWithFeesBenchmark(
      { prices: inRange, initialUsdc: 10_000, initialEth: 0 },
      30,
    );
    const b = passiveLpWithFeesBenchmark(
      { prices: [inRange[0]!, ...outOfRange.slice(1)], initialUsdc: 10_000, initialEth: 0 },
      30,
    );
    expect(b.feeIncomeUsd!).toBeLessThan(a.feeIncomeUsd!);
  });

  it("dilutes against pool TVL like the strategy does", () => {
    const withTvl = passiveLpWithFeesBenchmark(
      {
        prices: flat(1000, 20).map((p) => ({ ...p, poolTvlUsd: 10_000 })),
        initialUsdc: 10_000,
        initialEth: 0,
      },
      30,
    );
    const deep = passiveLpWithFeesBenchmark(
      {
        prices: flat(1000, 20).map((p) => ({ ...p, poolTvlUsd: 100_000_000 })),
        initialUsdc: 10_000,
        initialEth: 0,
      },
      30,
    );
    expect(withTvl.feeIncomeUsd!).toBeLessThan(deep.feeIncomeUsd! * 0.6);
  });
});

describe("concentration multiplier", () => {
  it("is 1 at the reference width", () => {
    expect(concentrationMultiplier(25, 25)).toBe(1);
  });

  it("rewards narrower bands and penalizes wider ones", () => {
    // Exact V3 density, so these are close to but not exactly 1/r: halving the
    // width roughly doubles the liquidity minted for the same capital.
    expect(concentrationMultiplier(12.5, 25)).toBeGreaterThan(1.9);
    expect(concentrationMultiplier(12.5, 25)).toBeLessThan(2.0);
    expect(concentrationMultiplier(50, 25)).toBeGreaterThan(0.49);
    expect(concentrationMultiplier(50, 25)).toBeLessThan(0.52);
    expect(concentrationMultiplier(75, 25)).toBeGreaterThan(0.30);
    expect(concentrationMultiplier(75, 25)).toBeLessThan(0.35);
  });

  it("is capped so a degenerate band cannot mint unbounded income", () => {
    expect(concentrationMultiplier(0.0001, 25)).toBe(MAX_CONCENTRATION_MULTIPLIER);
    expect(concentrationMultiplier(0, 25)).toBe(MAX_CONCENTRATION_MULTIPLIER);
  });

  it("can be disabled with a non-positive reference", () => {
    expect(concentrationMultiplier(5, 0)).toBe(1);
    expect(concentrationMultiplier(75, 0)).toBe(1);
  });
});

describe("passive LP concentration", () => {
  const flat = (steps: number, feeAprPct: number, price = 2000) =>
    Array.from({ length: steps }, (_, i) => ({
      timestamp: 1_700_000_000 + i * 3600,
      price,
      feeAprPct,
    }));

  it("earns more per dollar in a narrow band than a wide one", () => {
    const income = (rangePct: number) =>
      runPassiveLp(
        {
          initialUsdc: 10_000,
          initialEth: 0,
          rangePct,
          recenterBufferPct: 0,
          feeBps: 5,
          slippageBps: 3,
          recenterMinHours: 24,
          referenceRangePct: 25,
      regimeMaxMovePct: 0,
      regimeLookbackPoints: 288,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: 3,
      hedgeWhileParkedOnly: false,
      regimeMetric: "displacement" as const,
        },
        flat(2000, 20),
      ).feeIncomeUsd;
    // Price is pinned at the centre, so both stay in range the whole time and
    // the only difference is concentration.
    expect(income(10)).toBeGreaterThan(income(50) * 2);
  });

  it("reconciles with concentration applied", () => {
    const r = runPassiveLp(
      {
        initialUsdc: 10_000,
        initialEth: 0,
        rangePct: 15,
        recenterBufferPct: 25,
        feeBps: 5,
        slippageBps: 3,
        recenterMinHours: 24,
        referenceRangePct: 25,
      regimeMaxMovePct: 0,
      regimeLookbackPoints: 288,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: 3,
      hedgeWhileParkedOnly: false,
      regimeMetric: "displacement" as const,
      },
      flat(3000, 30),
    );
    expect(Math.abs(r.residual)).toBeLessThan(1e-6);
  });
});

describe("density-based fee share", () => {
  it("matches the simple multiplier for a small position", () => {
    // $10k in a $10M pool: share x TVL should equal capital x multiplier.
    const share = feeShareOfPool(10_000, 12.5, 10_000_000, 25);
    const viaShare = 10_000_000 * share;
    const viaMultiplier = 10_000 * concentrationMultiplier(12.5, 25);
    expect(viaShare).toBeGreaterThan(viaMultiplier * 0.99);
    expect(viaShare).toBeLessThan(viaMultiplier * 1.01);
  });

  it("saturates at the pool's total fees instead of exceeding them", () => {
    // An enormous, extremely tight position cannot earn more than 100%
    // of what the pool generates — the failure the cap was papering over.
    const share = feeShareOfPool(1_000_000_000, 0.01, 10_000_000, 25);
    expect(share).toBeLessThanOrEqual(1);
    expect(share).toBeGreaterThan(0.99);
  });

  it("is monotonic in concentration and in size", () => {
    const a = feeShareOfPool(10_000, 25, 10_000_000, 25);
    const tighter = feeShareOfPool(10_000, 5, 10_000_000, 25);
    const bigger = feeShareOfPool(100_000, 25, 10_000_000, 25);
    expect(tighter).toBeGreaterThan(a);
    expect(bigger).toBeGreaterThan(a);
  });

  it("returns zero when inputs are degenerate", () => {
    expect(feeShareOfPool(0, 10, 1e6, 25)).toBe(0);
    expect(feeShareOfPool(10_000, 10, 0, 25)).toBe(0);
  });

  it("bounds passive LP income by the pool's fee revenue", () => {
    // 2000 hours at 50% APR on a $1M pool generates ~$11.4k of fees in total;
    // a huge tight position must not report more than that.
    const prices = Array.from({ length: 2001 }, (_, i) => ({
      timestamp: 1_700_000_000 + i * 3600,
      price: 2000,
      feeAprPct: 50,
      poolTvlUsd: 1_000_000,
    }));
    const r = runPassiveLp(
      {
        initialUsdc: 5_000_000,
        initialEth: 0,
        rangePct: 1,
        recenterBufferPct: 0,
        feeBps: 5,
        slippageBps: 3,
        recenterMinHours: 24,
        referenceRangePct: 25,
      regimeMaxMovePct: 0,
      regimeLookbackPoints: 288,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: 3,
      hedgeWhileParkedOnly: false,
      regimeMetric: "displacement" as const,
      },
      prices,
    );
    const poolFeesGenerated = 1_000_000 * 0.5 * (2000 / (365 * 24));
    expect(r.feeIncomeUsd).toBeLessThan(poolFeesGenerated * 1.05);
  });
});

describe("fee income does not compound into liquidity", () => {
  it("keeps collected fees out of the fee base", () => {
    // A long run at a high rate: if collected fees fed back into the fee
    // base, income would grow superlinearly and could exceed the pool's own
    // revenue. Accruing on the position alone keeps it linear in time.
    const mk = (hours: number) =>
      runPassiveLp(
        {
          initialUsdc: 10_000,
          initialEth: 0,
          rangePct: 25,
          recenterBufferPct: 0,
          feeBps: 5,
          slippageBps: 3,
          recenterMinHours: 24,
          referenceRangePct: 25,
      regimeMaxMovePct: 0,
      regimeLookbackPoints: 288,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: 3,
      hedgeWhileParkedOnly: false,
      regimeMetric: "displacement" as const,
        },
        Array.from({ length: hours + 1 }, (_, i) => ({
          timestamp: 1_700_000_000 + i * 3600,
          price: 2000,
          feeAprPct: 100,
          poolTvlUsd: 10_000_000,
        })),
      ).feeIncomeUsd;

    const oneYear = mk(24 * 365);
    const twoYears = mk(24 * 730);
    // Linear, not compounding: two years earns ~2x one year, not more.
    expect(twoYears / oneYear).toBeGreaterThan(1.95);
    expect(twoYears / oneYear).toBeLessThan(2.05);
    // And one year at 100% APR on $10k is about $10k, not a multiple of it.
    expect(oneYear).toBeGreaterThan(9_000);
    expect(oneYear).toBeLessThan(11_000);
  });
});

describe("fee compounding at re-centring", () => {
  const flat = (steps: number, aprPct: number, price = 2000) =>
    Array.from({ length: steps }, (_, i) => ({
      timestamp: 1_700_000_000 + i * 3600,
      price,
      feeAprPct: aprPct,
      poolTvlUsd: 50_000_000,
    }));

  it("a never-re-centred position does not compound its fees", () => {
    // Nothing is collected, so the earning base stays at the principal and
    // income is linear in time.
    const mk = (hours: number) =>
      runPassiveLp(
        {
          initialUsdc: 10_000, initialEth: 0, rangePct: 25, recenterBufferPct: 0,
          feeBps: 5, slippageBps: 3, recenterMinHours: 24, referenceRangePct: 25,
      regimeMaxMovePct: 0,
      regimeLookbackPoints: 288,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: 3,
      hedgeWhileParkedOnly: false,
      regimeMetric: "displacement" as const,
        },
        flat(hours + 1, 100),
      ).feeIncomeUsd;
    expect(mk(24 * 730) / mk(24 * 365)).toBeGreaterThan(1.95);
    expect(mk(24 * 730) / mk(24 * 365)).toBeLessThan(2.05);
  });

  it("a re-centring position redeploys collected fees", () => {
    // Price walks out of the band repeatedly so re-centres actually happen.
    const data = [] as ReturnType<typeof flat>;
    let price = 2000;
    for (let i = 0; i < 4000; i++) {
      price *= i % 400 < 200 ? 1.001 : 0.999;
      data.push({ timestamp: 1_700_000_000 + i * 3600, price, feeAprPct: 100, poolTvlUsd: 50_000_000 });
    }
    const r = runPassiveLp(
      {
        initialUsdc: 10_000, initialEth: 0, rangePct: 5, recenterBufferPct: 10,
        feeBps: 5, slippageBps: 3, recenterMinHours: 1, referenceRangePct: 25,
      regimeMaxMovePct: 0,
      regimeLookbackPoints: 288,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: 3,
      hedgeWhileParkedOnly: false,
      regimeMetric: "displacement" as const,
      },
      data,
    );
    expect(r.recenters.length).toBeGreaterThan(0);
    // Fees collected at a re-centre are folded into the new position, so the
    // cash balance resets rather than accumulating monotonically.
    expect(r.feeIncomeUsd).toBeGreaterThan(0);
    expect(Math.abs(r.residual)).toBeLessThan(1e-6);
  });
});

describe("fee attribution survives redeployment", () => {
  it("reports redeployed fees as income, not as position performance", () => {
    const data = [] as { timestamp: number; price: number; feeAprPct: number; poolTvlUsd: number }[];
    let price = 2000;
    for (let i = 0; i < 4000; i++) {
      price *= i % 400 < 200 ? 1.001 : 0.999;
      data.push({ timestamp: 1_700_000_000 + i * 3600, price, feeAprPct: 100, poolTvlUsd: 50_000_000 });
    }
    const r = runPassiveLp(
      {
        initialUsdc: 10_000, initialEth: 0, rangePct: 5, recenterBufferPct: 10,
        feeBps: 5, slippageBps: 3, recenterMinHours: 1, referenceRangePct: 25,
      regimeMaxMovePct: 0,
      regimeLookbackPoints: 288,
      hedgeRatioPct: 0,
      hedgeBorrowAprPct: 3,
      hedgeWhileParkedOnly: false,
      regimeMetric: "displacement" as const,
      },
      data,
    );
    expect(r.recenters.length).toBeGreaterThan(0);
    // Folding fees into the position must not relabel them as position P&L.
    // At 100% APR over ~5 months on ~$10k, income is thousands, not hundreds.
    expect(r.feeIncomeUsd).toBeGreaterThan(1_000);
    expect(Math.abs(r.residual)).toBeLessThan(1e-6);
  });
});

describe("exact V3 liquidity density", () => {
  it("matches the closed-form V3 capital constraint", () => {
    // V = L * [(sqrtP - sqrtLo) + P*(1/sqrtP - 1/sqrtHi)] at unit price.
    const r = 0.1;
    const bracket = 1 - Math.sqrt(1 - r) + (1 - 1 / Math.sqrt(1 + r));
    expect(liquidityDensity(10)).toBeCloseTo(1 / bracket, 12);
  });

  it("is monotonically decreasing in width", () => {
    const widths = [1, 5, 10, 25, 50, 90];
    const d = widths.map(liquidityDensity);
    for (let i = 1; i < d.length; i++) expect(d[i]!).toBeLessThan(d[i - 1]!);
  });

  it("tracks the 1/r approximation closely at small widths", () => {
    // The approximation is what the model used before; it is accurate near
    // the reference and drifts at the extremes.
    const ratio = liquidityDensity(5) / liquidityDensity(25);
    expect(ratio).toBeGreaterThan(4.5);
    expect(ratio).toBeLessThan(5.0);
  });

  it("is 1 at the reference width and degenerate outside (0,100)", () => {
    expect(concentrationMultiplier(25, 25)).toBeCloseTo(1, 12);
    expect(liquidityDensity(0)).toBe(0);
    expect(liquidityDensity(100)).toBe(0);
  });
});
