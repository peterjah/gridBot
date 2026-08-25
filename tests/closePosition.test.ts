import { describe, expect, it, vi } from "vitest";
import { RebalanceExecutor } from "../src/bot/rebalanceExecutor.js";
import type { PositionInfo } from "../src/uniswap/position.js";
import type { LpRebalanceConfig } from "../src/config.js";
import type { PoolInfo } from "../src/uniswap/pool.js";

const baseCfg = {
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
  stateFile: "/dev/null",
  dryRun: false,
  regimeMaxMovePct: 0,
  regimeLookbackHours: 168,
  regimeSampleMinutes: 60,
  seedFile: null,
} satisfies LpRebalanceConfig;

const pool = {
  address: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  fee: 500,
  tickSpacing: 10,
  token0: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  token1: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
} as unknown as PoolInfo;

function position(over: Partial<PositionInfo>): PositionInfo {
  return {
    tokenId: 5839652n,
    owner: "0x8E272640D66FfBC657FB8c856278A4ff17B3e937",
    token0: pool.token0.address,
    token1: pool.token1.address,
    fee: 500,
    tickLower: -199690,
    tickUpper: -197280,
    liquidity: 0n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    ...over,
  } as PositionInfo;
}

/** An executor whose chain calls are recorded instead of broadcast. */
function executor(): { exec: RebalanceExecutor; calls: string[] } {
  const calls: string[] = [];
  const exec = new RebalanceExecutor(
    {} as never,
    { account: { address: baseCfg.positionManagerAddress } } as never,
    baseCfg,
    null,
    pool,
    {
      name: "test",
      shouldRebalance: () => true,
      computeRange: () => ({ lowerTick: -198670, upperTick: -197680 }),
    },
  );
  const stub = (name: "decreaseLiquidity" | "collect") =>
    vi
      .spyOn(exec as unknown as Record<string, () => unknown>, name)
      .mockImplementation(async () => {
        calls.push(name);
        return { amount0: 0n, amount1: 0n };
      });
  stub("decreaseLiquidity");
  stub("collect");
  vi.spyOn(exec as unknown as Record<string, () => void>, "reportFees").mockImplementation(
    () => {},
  );
  return { exec, calls };
}

describe("closePosition", () => {
  it("does nothing when there is neither liquidity nor owed tokens", async () => {
    const { exec, calls } = executor();
    await exec.closePosition(position({}), 1n);
    expect(calls).toEqual([]);
  });

  it("withdraws then collects when liquidity is present", async () => {
    const { exec, calls } = executor();
    await exec.closePosition(position({ liquidity: 7_098_613_474_501n }), 1n);
    expect(calls).toEqual(["decreaseLiquidity", "collect"]);
  });

  /**
   * The production failure this guards against: `decreaseLiquidity` succeeded,
   * `collect` failed, and every later cycle saw liquidity 0 and returned early
   * — stranding the principal and fees in the position permanently.
   */
  it("still collects when liquidity is zero but tokens are owed", async () => {
    const { exec, calls } = executor();
    await exec.closePosition(position({ liquidity: 0n, tokensOwed1: 25_890_352n }), 1n);
    expect(calls).toEqual(["collect"]);
  });

  it("recovers owed token0 as well as token1", async () => {
    const { exec, calls } = executor();
    await exec.closePosition(position({ tokensOwed0: 6_368_985_828_028_500n }), 1n);
    expect(calls).toEqual(["collect"]);
  });

  it("plans but does not act in dry run", async () => {
    const calls: string[] = [];
    const exec = new RebalanceExecutor(
      {} as never,
      { account: { address: baseCfg.positionManagerAddress } } as never,
      { ...baseCfg, dryRun: true },
      null,
      pool,
      {
        name: "test",
        shouldRebalance: () => true,
        computeRange: () => ({ lowerTick: 0, upperTick: 1 }),
      },
    );
    for (const name of ["decreaseLiquidity", "collect"] as const) {
      vi.spyOn(exec as unknown as Record<string, () => unknown>, name).mockImplementation(
        async () => {
          calls.push(name);
          return { amount0: 0n, amount1: 0n };
        },
      );
    }
    await exec.closePosition(position({ liquidity: 1n, tokensOwed1: 1n }), 1n);
    expect(calls).toEqual([]);
  });
});
