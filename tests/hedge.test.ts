import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AaveShortHedge, type HedgeOptions } from "../src/lp/hedge.js";
import type { AaveExecutor } from "../src/lending/aaveExecutor.js";
import type { LpRebalanceConfig } from "../src/config.js";
import type { PoolInfo } from "../src/uniswap/pool.js";

const WETH = 18;
const USDC = 6;

const cfg = {
  widthTicks: 488,
  thresholdTicks: 723,
  rangePct: 5,
  recenterBufferPct: 50,
  recenterMinHours: 24,
  positionManagerAddress: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  swapRouterAddress: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoterAddress: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  slippageBps: 50,
  positionId: 0n,
  stateFile: "",
  dryRun: false,
  regimeMaxMovePct: 3,
  regimeReenterMarginPct: 25,
  regimeLookbackHours: 168,
  regimeSampleMinutes: 60,
  seedFile: null,
} satisfies LpRebalanceConfig;

const pool = {
  address: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  fee: 500,
  tickSpacing: 10,
  token0: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: WETH },
  token1: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: USDC },
} as unknown as PoolInfo;

const opts: HedgeOptions = {
  ratioPct: 50,
  maxLtvPct: 40,
  minActionUsd: 100,
  dryRun: false,
};

interface Fixture {
  hedge: AaveShortHedge;
  calls: string[];
  aave: {
    allBalances: ReturnType<typeof vi.fn>;
    borrow: ReturnType<typeof vi.fn>;
    repayExact: ReturnType<typeof vi.fn>;
    debtBalanceRaw: ReturnType<typeof vi.fn>;
  };
}

function harness(
  overrides: Partial<HedgeOptions> = {},
  balances: Record<string, number> = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "hedge-"));
  const stateFile = join(dir, "position.json");
  const calls: string[] = [];

  const aave = {
    allBalances: vi.fn(async () => ({
      usdcWallet: balances.usdcWallet ?? 0,
      usdcLent: balances.usdcLent ?? 0,
      ethWallet: balances.ethWallet ?? 0,
      ethLent: balances.ethLent ?? 0,
    })),
    borrow: vi.fn(async (asset: string, amount: number) => {
      calls.push(`borrow:${asset}:${amount.toFixed(4)}`);
    }),
    repayExact: vi.fn(async (_asset: string, raw: bigint) => {
      calls.push(`repay:${raw.toString()}`);
    }),
    debtBalanceRaw: vi.fn(async () => BigInt(balances.debtRaw ?? 0)),
  };
  const client = {
    // quoteExactInputSingle: sell borrowed WETH at ~1:2500
    simulateContract: async () => ({ result: [BigInt(Math.round(2500 * 1e6))] }),
    readContract: async () => BigInt(2) ** BigInt(256) - BigInt(1),
    // getPoolState multicall (results unwrapped): slot0 at PRICE=2500 raw ratio
    multicall: async () => [[((1n << 96n) * 50n) / 1_000_000n, 0n], 0n],
  } as never;

  const hedge = new AaveShortHedge(
    aave as unknown as AaveExecutor,
    client,
    { account: { address: pool.address }, send: async (_c: unknown, label: string) => {
        calls.push(label);
        return "0xhash";
      },
    } as never,
    { ...cfg, stateFile },
    pool,
    { ...opts, ...overrides },
    null,
  );
  return { hedge, calls, aave: aave as Fixture["aave"] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AaveShortHedge.open", () => {
  it("borrows the configured share of ETH exposure and sells it", async () => {
    const h = harness({}, { ethLent: 2, usdcLent: 5000 });
    const opened = await h.hedge.open(2500);
    expect(opened).toBe(true);
    expect(h.calls[0]).toBe("borrow:WETH:1.0000");
    expect(h.calls).toContain("hedge-open-sell");
  });

  it("skips below the action minimum", async () => {
    const h = harness({}, { ethLent: 0.01, usdcLent: 10 }); // $25 of ETH < $100
    await expect(h.hedge.open(2500)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("caps the notional by max LTV against supplied collateral", async () => {
    // Collateral = 2000 USDC + 4 WETH x 2500 = 12000 USD. Cap 40% -> 4800 USD.
    // Exposure 4 WETH, ratio 50% wants 2 WETH ($5000) -> capped at 1.92.
    const h = harness({}, { ethLent: 4, usdcLent: 2000 });
    await h.hedge.open(2500);
    const borrowed = Number(h.calls[0]!.split(":")[2]);
    expect(borrowed).toBeCloseTo(4800 / 2500, 3);
  });

  it("does nothing with no supplied collateral", async () => {
    const h = harness({}, { ethWallet: 2 });
    await expect(h.hedge.open(2500)).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("broadcasts nothing in dry run but reports the plan", async () => {
    const h = harness({ dryRun: true }, { ethLent: 2, usdcLent: 5000 });
    await expect(h.hedge.open(2500)).resolves.toBe(true);
    expect(h.aave.borrow).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });
});

describe("AaveShortHedge.close", () => {
  it("is a no-op without debt", async () => {
    const h = harness();
    await expect(h.hedge.close()).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("buys back and repays the exact debt", async () => {
    const debt = BigInt("500000000000000000"); // 0.5 WETH
    const h = harness({}, { debtRaw: Number(debt) });
    await h.hedge.close();
    expect(h.calls).toContain("hedge-close-buyback");
    expect(h.calls.some((c) => c.startsWith(`repay:${debt}`))).toBe(true);
  });
});
