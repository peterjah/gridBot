import { describe, expect, it } from "vitest";
import {
  ethHoldBenchmark,
  staticLpBenchmark,
  usdcOnlyBenchmark,
} from "../src/backtest/benchmarks.js";

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
