import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "../src/bot/monitor.js";
import type { LpLendingManager } from "../src/lp/lpLending.js";
import type { LpRebalanceConfig } from "../src/config.js";
import type { PoolInfo } from "../src/uniswap/pool.js";

const cfg = {
  widthTicks: 488,
  thresholdTicks: 723,
  rangePct: 5,
  recenterBufferPct: 50,
  recenterMinHours: 0,
  positionManagerAddress: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  swapRouterAddress: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoterAddress: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  slippageBps: 50,
  positionId: 0n,
  stateFile: "",
  dryRun: true,
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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Records the order of lending and deployment calls. */
function harness(overrides: { hostile?: boolean } = {}) {
  const order: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "monlend-"));
  dirs.push(dir);
  const stateFile = join(dir, "position.json");

  const lending = {
    releaseAll: async () => {
      order.push("releaseAll");
      return true;
    },
    parkIdle: async () => {
      order.push("parkIdle");
      return true;
    },
    lentValueUsd: async () => 0,
  } as unknown as LpLendingManager;

  const client = {
    readContract: async () => 0n,
  } as never;

  const monitor = new Monitor(
    client,
    { account: { address: pool.address } } as never,
    { ...cfg, stateFile, regimeMaxMovePct: overrides.hostile ? 1 : 0 },
    null,
    30,
    pool,
    {
      name: "t",
      shouldRebalance: () => true,
      computeRange: () => ({ lowerTick: -198670, upperTick: -197680 }),
    },
    lending,
  );

  // Stub the chain-facing pieces.
  const exec = (monitor as unknown as { executor: Record<string, unknown> }).executor;
  exec.rebalance = async () => {
    order.push("rebalance");
  };
  exec.closePosition = async () => {
    order.push("closePosition");
  };

  return { monitor, order };
}

describe("monitor + lending ordering", () => {
  /**
   * The rebalance plan sizes the position from the wallet balance. Deploying
   * before the Aave withdrawal confirms would fund the position from the
   * un-lent remainder and silently leave the rest earning nothing.
   */
  it("withdraws from Aave before deploying", async () => {
    const { monitor, order } = harness();
    vi.spyOn(
      monitor as unknown as { managedPositionId: () => bigint | null },
      "managedPositionId",
    ).mockReturnValue(null);
    vi.spyOn(
      monitor as unknown as { walletIsEmpty: () => Promise<boolean> },
      "walletIsEmpty",
    ).mockResolvedValue(false);
    const poolMod = await import("../src/uniswap/pool.js");
    vi.spyOn(poolMod, "getPoolState").mockResolvedValue({
      sqrtPriceX96: 1n << 96n,
      currentTick: -198175,
    } as never);

    await monitor.cycle();

    expect(order).toContain("releaseAll");
    expect(order).toContain("rebalance");
    expect(order.indexOf("releaseAll")).toBeLessThan(order.indexOf("rebalance"));
  });

  it("never supplies to Aave on a cycle that deploys", async () => {
    const { monitor, order } = harness();
    vi.spyOn(
      monitor as unknown as { managedPositionId: () => bigint | null },
      "managedPositionId",
    ).mockReturnValue(null);
    vi.spyOn(
      monitor as unknown as { walletIsEmpty: () => Promise<boolean> },
      "walletIsEmpty",
    ).mockResolvedValue(false);
    const poolMod = await import("../src/uniswap/pool.js");
    vi.spyOn(poolMod, "getPoolState").mockResolvedValue({
      sqrtPriceX96: 1n << 96n,
      currentTick: -198175,
    } as never);

    await monitor.cycle();
    expect(order).not.toContain("parkIdle");
  });
});
