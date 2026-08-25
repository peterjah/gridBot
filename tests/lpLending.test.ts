import { describe, expect, it, vi } from "vitest";
import { LpLendingManager } from "../src/lp/lpLending.js";
import type { AaveExecutor } from "../src/lending/aaveExecutor.js";

interface Call {
  kind: "supply" | "withdraw" | "withdrawMax";
  asset: "USDC" | "WETH";
  amount: number | bigint;
}

const RAW = { USDC: 6, WETH: 18 } as const;
const toRaw = (v: number, decimals: number): bigint =>
  BigInt(Math.round(v * 10 ** Math.min(decimals, 6))) * 10n ** BigInt(Math.max(decimals - 6, 0));

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
    allBalancesRaw: async () => ({
      usdcWallet: toRaw(balances.usdcWallet, RAW.USDC),
      usdcLent: toRaw(balances.usdcLent, RAW.USDC),
      ethWallet: toRaw(balances.ethWallet, RAW.WETH),
      ethLent: toRaw(balances.ethLent, RAW.WETH),
    }),
    // The manager supplies raw units: converting through a JS number rounds
    // up above 2^53 and asks for more than the wallet holds.
    supplyRaw: async (asset: "USDC" | "WETH", amount: bigint) => {
      calls.push({ kind: "supply", asset, amount });
    },
    withdrawMax: async (asset: "USDC" | "WETH") => {
      calls.push({ kind: "withdrawMax", asset, amount: 0n });
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
      { kind: "withdrawMax", asset: "USDC", amount: 0n },
      { kind: "withdrawMax", asset: "WETH", amount: 0n },
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
    expect(calls.map((c) => c.kind)).toEqual(["withdrawMax", "withdrawMax"]);
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
    expect(calls).toEqual([{ kind: "withdrawMax", asset: "USDC", amount: 0n }]);
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
      { kind: "supply", asset: "USDC", amount: toRaw(5000, RAW.USDC) },
      { kind: "supply", asset: "WETH", amount: toRaw(1, RAW.WETH) },
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
    expect(above.calls).toEqual([
      { kind: "supply", asset: "WETH", amount: toRaw(0.05, RAW.WETH) },
    ]);

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
    expect(calls).toEqual([{ kind: "supply", asset: "USDC", amount: toRaw(5000, RAW.USDC) }]);
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
      allBalancesRaw: async () => ({
        usdcWallet: toRaw(state.usdcWallet, RAW.USDC),
        usdcLent: toRaw(state.usdcLent, RAW.USDC),
        ethWallet: toRaw(state.ethWallet, RAW.WETH),
        ethLent: toRaw(state.ethLent, RAW.WETH),
      }),
      supplyRaw: async (asset: "USDC" | "WETH", amount: bigint) => {
        calls.push({ kind: "supply", asset, amount });
        // Mirror the chain: the supplied raw amount becomes the lent balance.
        const human = Number(amount) / 10 ** (asset === "USDC" ? RAW.USDC : RAW.WETH);
        if (asset === "USDC") state = { ...state, usdcWallet: 0, usdcLent: human };
        else state = { ...state, ethWallet: 0, ethLent: human };
      },
      withdrawMax: async (asset: "USDC" | "WETH") => {
        calls.push({
          kind: "withdrawMax",
          asset,
          amount: asset === "USDC" ? state.usdcLent : state.ethLent,
        });
        if (asset === "USDC") state = { ...state, usdcWallet: state.usdcLent, usdcLent: 0 };
        else state = { ...state, ethWallet: state.ethLent, ethLent: 0 };
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

/**
 * The production failure: topping up to 0.14 WETH, the bot asked Aave for
 * 140000000000000016 wei — 16 more than the wallet held — and the supply
 * reverted. `Math.floor(0.14 * 1e18)` is not 1.4e17: 18-decimal amounts sit
 * sixteen times beyond Number.MAX_SAFE_INTEGER, so the raw -> number -> raw
 * round trip is lossy and can round UP past the balance.
 */
describe("precision", () => {
  it("supplies exactly the wallet balance, never a wei more", async () => {
    const walletRaw = 140_000_000_000_000_000n; // 0.14 WETH
    const calls: bigint[] = [];
    const aave = {
      allBalances: async () => ({
        usdcWallet: 0,
        usdcLent: 0,
        ethWallet: 0.14,
        ethLent: 0,
      }),
      allBalancesRaw: async () => ({
        usdcWallet: 0n,
        usdcLent: 0n,
        ethWallet: walletRaw,
        ethLent: 0n,
      }),
      supplyRaw: async (_asset: "USDC" | "WETH", amount: bigint) => {
        calls.push(amount);
      },
      withdrawMax: async () => {},
    } as unknown as AaveExecutor;

    await new LpLendingManager(aave, { minActionUsd: 1, dryRun: false }).parkIdle(2500);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(walletRaw);
    expect(calls[0]! <= walletRaw).toBe(true);
  });

  it("demonstrates why the number round trip could not be used", () => {
    // Kept as an executable note: this is the arithmetic that reverted.
    expect(Math.floor(0.14 * 1e18)).not.toBe(140_000_000_000_000_000);
    expect(BigInt(Math.floor(0.14 * 1e18)) > 140_000_000_000_000_000n).toBe(true);
  });
});
