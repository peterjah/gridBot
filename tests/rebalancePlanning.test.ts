import { describe, expect, it, vi } from "vitest";
import { RebalanceExecutor } from "../src/bot/rebalanceExecutor.js";
import type { PositionInfo } from "../src/uniswap/position.js";
import type { LpRebalanceConfig } from "../src/config.js";
import type { PoolInfo } from "../src/uniswap/pool.js";
import { getSqrtRatioAtTick } from "../src/utils/math.js";

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
  stateFile: "/tmp/never-written.json",
  dryRun: false,
  regimeMaxMovePct: 0,
  regimeReenterMarginPct: 25,
  regimeLookbackHours: 168,
  regimeSampleMinutes: 60,
  seedFile: null,
} as unknown as LpRebalanceConfig;

const pool = {
  address: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  fee: 500,
  tickSpacing: 10,
  token0: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  token1: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
} as unknown as PoolInfo;

const sqrtPriceX96 = getSqrtRatioAtTick(-198270);

/**
 * The live sequence: the wallet holds only WETH (just withdrawn from Aave)
 * while the position still holds the USDC side. The pre-close plan sees a
 * one-sided wallet; the post-close balances are what must actually be sized.
 */
function harness(opts: { walletBefore: [bigint, bigint]; afterClose: [bigint, bigint] }) {
  const calls: string[] = [];
  let closed = false;

  const exec = new RebalanceExecutor(
    { readContract: async () => 0n } as never,
    { account: { address: pool.address } } as never,
    cfg,
    "0x8E272640D66FfBC657FB8c856278A4ff17B3e937",
    pool,
    {
      name: "t",
      shouldRebalance: () => true,
      computeRange: () => ({ lowerTick: -198750, upperTick: -197770 }),
    },
  );
  const self = exec as unknown as Record<string, unknown>;

  self.getBalances = async () => (closed ? opts.afterClose : opts.walletBefore);
  self.decreaseLiquidity = async () => {
    calls.push("decreaseLiquidity");
    return { amount0: 0n, amount1: 0n };
  };
  self.collect = async () => {
    calls.push("collect");
    closed = true;
    return { amount0: 0n, amount1: 0n };
  };
  self.reportFees = () => {};
  self.executeSwap = async (plan: { zeroForOne: boolean; amountIn: bigint }) => {
    calls.push(`swap:${plan.zeroForOne ? "WETH->USDC" : "USDC->WETH"}:${plan.amountIn}`);
    // The executor waits for this much output to become readable.
    return { minOut: 0n };
  };
  self.mint = async (_l: number, _u: number, b0: bigint, b1: bigint) => {
    calls.push(`mint:${b0}:${b1}`);
  };
  return { exec, calls };
}

function position(): PositionInfo {
  return {
    tokenId: 5899167n,
    tickLower: -198770,
    tickUpper: -197790,
    liquidity: 20_836_908_608_751n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
  } as PositionInfo;
}

describe("rebalance planning", () => {
  it("re-plans against balances that include what the position released", async () => {
    // Wallet: 0.1414 WETH, ~0 USDC. Position releases 0.00998 WETH + 25.48 USDC.
    const { exec, calls } = harness({
      walletBefore: [141_396_878_202_825_451n, 1n],
      afterClose: [151_373_538_202_825_451n, 25_478_356n],
    });
    // getPoolState is read again only when a swap happens; stub it.
    const poolMod = await import("../src/uniswap/pool.js");
    vi.spyOn(poolMod, "getPoolState").mockResolvedValue({ sqrtPriceX96, currentTick: -198270 } as never);

    await exec.rebalance(position(), sqrtPriceX96, -198270);

    // It must mint from the POST-close balances, not the pre-close ones.
    const mint = calls.find((c) => c.startsWith("mint:"))!;
    expect(mint).toContain("151373538202825451");
  });

  it("swaps toward the target ratio for a one-sided wallet", async () => {
    const { exec, calls } = harness({
      walletBefore: [141_396_878_202_825_451n, 1n],
      afterClose: [141_396_878_202_825_451n, 1n],
    });
    const poolMod = await import("../src/uniswap/pool.js");
    vi.spyOn(poolMod, "getPoolState").mockResolvedValue({ sqrtPriceX96, currentTick: -198270 } as never);

    await exec.rebalance(null, sqrtPriceX96, -198270);

    const swap = calls.find((c) => c.startsWith("swap:"));
    expect(swap).toBeDefined();
    expect(swap).toContain("WETH->USDC");
  });

  it("does not swap when the wallet already matches the target ratio", async () => {
    // Balanced enough that neither side has both an excess and a deficit.
    const { exec, calls } = harness({
      walletBefore: [72_123_670_167_573_196n, 169_917_894n],
      afterClose: [72_123_670_167_573_196n, 169_917_894n],
    });
    await exec.rebalance(null, sqrtPriceX96, -198270);
    expect(calls.some((c) => c.startsWith("swap:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("mint:"))).toBe(true);
  });

  /**
   * The production failure. A swap of 0.0702 WETH -> 172.26 USDC confirmed in
   * the same block as the mint; the balance read still showed the pre-swap
   * 26.21 USDC, so min-of-sides deployed $52 of a $397 book and left ~$172 in
   * the wallet. The executor must wait for the swap output to be readable.
   */
  it("waits for the swap output before minting", async () => {
    const calls: string[] = [];
    let closed = false;
    let swapped = false;

    const exec = new RebalanceExecutor(
      { readContract: async () => 0n } as never,
      { account: { address: pool.address } } as never,
      cfg,
      "0x8E272640D66FfBC657FB8c856278A4ff17B3e937",
      pool,
      {
        name: "t",
        shouldRebalance: () => true,
        computeRange: () => ({ lowerTick: -198750, upperTick: -197770 }),
      },
    );
    const self = exec as unknown as Record<string, unknown>;

    // The node lags by one read after the swap, exactly as it did live.
    let readsSinceSwap = 0;
    self.getBalances = async () => {
      if (!closed) return [141_396_878_202_825_451n, 1n];
      if (!swapped) return [151_197_784_493_936_270n, 26_210_425n];
      readsSinceSwap++;
      return readsSinceSwap === 1
        ? [151_197_784_493_936_270n, 26_210_425n] // stale: pre-swap
        : [81_000_207_087_101_295n, 198_474_476n]; // post-swap
    };
    self.decreaseLiquidity = async () => ({ amount0: 0n, amount1: 0n });
    self.collect = async () => {
      closed = true;
      return { amount0: 0n, amount1: 0n };
    };
    self.reportFees = () => {};
    self.executeSwap = async () => {
      swapped = true;
      return { minOut: 171_402_730n };
    };
    self.mint = async (_l: number, _u: number, b0: bigint, b1: bigint) => {
      calls.push(`mint:${b0}:${b1}`);
    };

    const poolMod = await import("../src/uniswap/pool.js");
    vi.spyOn(poolMod, "getPoolState").mockResolvedValue({ sqrtPriceX96, currentTick: -198270 } as never);

    await exec.rebalance(position(), sqrtPriceX96, -198270);

    // It must mint from the POST-swap balances, not the stale 26.21 USDC.
    expect(calls[0]).toBe("mint:81000207087101295:198474476");
  });
});
