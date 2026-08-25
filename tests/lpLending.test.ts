import { describe, expect, it, vi } from "vitest";
import { LpLendingManager } from "../src/lp/lpLending.js";
import type { AaveExecutor } from "../src/lending/aaveExecutor.js";

interface Call {
  kind: "supply" | "withdraw";
  asset: "USDC" | "WETH";
  amount: number;
}

/** An AaveExecutor stand-in that records what it was asked to do. */
function fakeAave(balances: {
  usdcWallet: number;
  usdcLent: number;
  ethWallet: number;
  ethLent: number;
}): { aave: AaveExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const aave = {
    allBalances: async () => balances,
    supply: async (asset: "USDC" | "WETH", amount: number) => {
      calls.push({ kind: "supply", asset, amount });
    },
    withdraw: async (asset: "USDC" | "WETH", amount: number) => {
      calls.push({ kind: "withdraw", asset, amount });
    },
  } as unknown as AaveExecutor;
  return { aave, calls };
}

const opts = { minActionUsd: 100, dryRun: false };

describe("releaseAll", () => {
  it("withdraws both assets in full", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 0,
      usdcLent: 5000,
      ethWallet: 0,
      ethLent: 1.5,
    });
    expect(await new LpLendingManager(aave, opts).releaseAll(2500)).toBe(true);
    expect(calls).toEqual([
      { kind: "withdraw", asset: "USDC", amount: 5000 },
      { kind: "withdraw", asset: "WETH", amount: 1.5 },
    ]);
  });

  /**
   * A minimum here would leave a remainder in Aave, and the position would be
   * sized from the un-lent balance — silently under-deploying.
   */
  it("withdraws amounts below minActionUsd too", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 0,
      usdcLent: 3,
      ethWallet: 0,
      ethLent: 0.0001,
    });
    await new LpLendingManager(aave, opts).releaseAll(2500);
    expect(calls.map((c) => c.kind)).toEqual(["withdraw", "withdraw"]);
  });

  it("does nothing when nothing is lent", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 9000,
      usdcLent: 0,
      ethWallet: 2,
      ethLent: 0,
    });
    expect(await new LpLendingManager(aave, opts).releaseAll(2500)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("skips only the asset that is not lent", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 0,
      usdcLent: 1000,
      ethWallet: 0,
      ethLent: 0,
    });
    await new LpLendingManager(aave, opts).releaseAll(2500);
    expect(calls).toEqual([{ kind: "withdraw", asset: "USDC", amount: 1000 }]);
  });

  it("broadcasts nothing in dry run", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 0,
      usdcLent: 5000,
      ethWallet: 0,
      ethLent: 1,
    });
    expect(
      await new LpLendingManager(aave, { ...opts, dryRun: true }).releaseAll(2500),
    ).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("parkIdle", () => {
  it("supplies both sides when each clears the minimum", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 5000,
      usdcLent: 0,
      ethWallet: 1,
      ethLent: 0,
    });
    expect(await new LpLendingManager(aave, opts).parkIdle(2500)).toBe(true);
    expect(calls).toEqual([
      { kind: "supply", asset: "USDC", amount: 5000 },
      { kind: "supply", asset: "WETH", amount: 1 },
    ]);
  });

  it("skips dust rather than spending gas on it", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 20,
      usdcLent: 0,
      ethWallet: 0.001, // $2.50 at 2500
      ethLent: 0,
    });
    expect(await new LpLendingManager(aave, opts).parkIdle(2500)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("values ETH at the passed price when applying the minimum", async () => {
    // 0.05 ETH is $125 at 2500 (above the $100 minimum) but $50 at 1000.
    const above = fakeAave({ usdcWallet: 0, usdcLent: 0, ethWallet: 0.05, ethLent: 0 });
    await new LpLendingManager(above.aave, opts).parkIdle(2500);
    expect(above.calls).toEqual([{ kind: "supply", asset: "WETH", amount: 0.05 }]);

    const below = fakeAave({ usdcWallet: 0, usdcLent: 0, ethWallet: 0.05, ethLent: 0 });
    await new LpLendingManager(below.aave, opts).parkIdle(1000);
    expect(below.calls).toEqual([]);
  });

  it("supplies one side when only that side clears the minimum", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 5000,
      usdcLent: 0,
      ethWallet: 0.0001,
      ethLent: 0,
    });
    await new LpLendingManager(aave, opts).parkIdle(2500);
    expect(calls).toEqual([{ kind: "supply", asset: "USDC", amount: 5000 }]);
  });

  it("broadcasts nothing in dry run", async () => {
    const { aave, calls } = fakeAave({
      usdcWallet: 5000,
      usdcLent: 0,
      ethWallet: 1,
      ethLent: 0,
    });
    await new LpLendingManager(aave, { ...opts, dryRun: true }).parkIdle(2500);
    expect(calls).toEqual([]);
  });
});

describe("round trip", () => {
  it("park then release returns the whole balance to the wallet", async () => {
    let state = { usdcWallet: 5000, usdcLent: 0, ethWallet: 1, ethLent: 0 };
    const calls: Call[] = [];
    const aave = {
      allBalances: async () => state,
      supply: async (asset: "USDC" | "WETH", amount: number) => {
        calls.push({ kind: "supply", asset, amount });
        if (asset === "USDC") state = { ...state, usdcWallet: 0, usdcLent: amount };
        else state = { ...state, ethWallet: 0, ethLent: amount };
      },
      withdraw: async (asset: "USDC" | "WETH", amount: number) => {
        calls.push({ kind: "withdraw", asset, amount });
        if (asset === "USDC") state = { ...state, usdcWallet: amount, usdcLent: 0 };
        else state = { ...state, ethWallet: amount, ethLent: 0 };
      },
    } as unknown as AaveExecutor;

    const manager = new LpLendingManager(aave, opts);
    await manager.parkIdle(2500);
    expect(state.usdcLent).toBe(5000);
    await manager.releaseAll(2500);
    expect(state.usdcWallet).toBe(5000);
    expect(state.ethWallet).toBe(1);
    expect(state.usdcLent).toBe(0);
    expect(state.ethLent).toBe(0);
  });
});
