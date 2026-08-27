import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "../src/bot/monitor.js";
import { loadState, saveState, emptyState } from "../src/bot/state.js";
import type { LpLendingManager } from "../src/lp/lpLending.js";
import type { AaveShortHedge } from "../src/lp/hedge.js";
import type { LpRebalanceConfig } from "../src/config.js";
import type { PoolInfo } from "../src/uniswap/pool.js";

const PRICE = 2500;

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
  regimeReenterMarginPct: 25,
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

interface HarnessOptions {
  /** Trailing move percent the filter should observe over its lookback. */
  movePct?: number;
  regimeMaxMovePct?: number;
  recenterMinHours?: number;
  parked?: boolean;
  lastRecenterAtSecondsAgo?: number;
  hedgeOpen?: boolean;
  /** Force the liquidation guard to report an unwind. */
  hedgeUnhealthy?: boolean;
  /** Managed position id; null keeps the bootstrap-mint path. */
  positionId?: bigint | null;
}

function harness(overrides: HarnessOptions = {}) {
  const order: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "monhy-"));
  dirs.push(dir);
  const stateFile = join(dir, "position.json");

  // Seed the persisted window so the filter reads `movePct` over its lookback.
  const nowSec = Math.floor(Date.now() / 1000);
  const lookbackHours = 168;
  const state = emptyState();
  state.parked = overrides.parked ?? false;
  state.lastParkChangeAt = nowSec - 10_000_000; // dwelled
  if (overrides.lastRecenterAtSecondsAgo !== undefined) {
    state.lastRecenterAt = nowSec - overrides.lastRecenterAtSecondsAgo;
  }
  const base = PRICE / (1 + (overrides.movePct ?? 0) / 100);
  state.priceHistory = [
    { t: nowSec - lookbackHours * 3600 - 60, p: base },
    { t: nowSec - 120, p: PRICE },
  ];
  saveState(stateFile, state);

  const lending = lendingNoop(order);
  const hedge = {
    isOpen: async () => overrides.hedgeOpen ?? false,
    // The liquidation guard runs before open() on every parked cycle. Healthy
    // by default: tests that care about unwinding drive it explicitly.
    checkHealth: async () => {
      order.push("hedge.checkHealth");
      return overrides.hedgeUnhealthy ?? false;
    },
    open: async () => {
      order.push("hedge.open");
      return true;
    },
    close: async () => {
      order.push("hedge.close");
      return true;
    },
  } as unknown as AaveShortHedge;

  const client = { readContract: async () => 0n } as never;

  const monitor = new Monitor(
    client,
    { account: { address: pool.address } } as never,
    {
      ...cfg,
      stateFile,
      regimeMaxMovePct: overrides.regimeMaxMovePct ?? 3,
      recenterMinHours: overrides.recenterMinHours ?? 0,
    },
    null,
    30,
    pool,
    {
      name: "t",
      shouldRebalance: () => true,
      computeRange: () => ({ lowerTick: -198670, upperTick: -197680 }),
    },
    lending,
    hedge,
  );

  stubChain(monitor, order, overrides.positionId ?? null);
  return { monitor, order, stateFile };
}

function lendingNoop(order?: string[]): LpLendingManager {
  return {
    releaseAll: async () => {
      order?.push("releaseAll");
      return false;
    },
    parkIdle: async () => {
      order?.push("parkIdle");
      return false;
    },
    lentValueUsd: async () => 0,
  } as unknown as LpLendingManager;
}

/** Stub every chain-facing piece the cycle touches after the regime reads. */
function stubChain(monitor: Monitor, order: string[], positionId: bigint | null): void {
  const self = monitor as unknown as Record<string, unknown>;
  self.managedPositionId = () => positionId;
  self.walletIsEmpty = async () => false;
  const exec = self.executor as Record<string, unknown>;
  exec.rebalance = async () => {
    order.push("rebalance");
  };
  exec.closePosition = async () => {
    order.push("closePosition");
  };
}

async function mockPoolReads(positionId: bigint | null) {
  const poolMod = await import("../src/uniswap/pool.js");
  // Human price P corresponds to a RAW ratio of P * 10^(dec1-dec0); build the
  // mocked state so sqrtRatioToPrice returns PRICE exactly.
  const scaledSqrt = BigInt(Math.round(Math.sqrt(PRICE * 1e-12) * 1e6)); // e.g. 50 for 2500
  const sqrtPriceX96 = ((1n << 96n) * scaledSqrt) / 1_000_000n;
  const currentTick = Math.round(
    Math.log(PRICE / 1e12) / Math.log(1.0001),
  );
  vi.spyOn(poolMod, "getPoolState").mockResolvedValue({
    sqrtPriceX96,
    currentTick,
  } as never);
  const positionMod = await import("../src/uniswap/position.js");
  vi.spyOn(positionMod, "getPosition").mockResolvedValue(
    positionId === null
      ? (null as never)
      : ({
          tokenId: positionId,
          token0: pool.token0.address,
          token1: pool.token1.address,
          fee: 500,
          tickLower: -198670,
          tickUpper: -197680,
          liquidity: 10n ** 18n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
        } as never),
  );
}

describe("regime hysteresis", () => {
  it("stays in cash while the move sits inside the hysteresis band", async () => {
    // Exit above 3%, margin 25% -> re-enter only below 2.25%. 2.5% is between.
    const { monitor, order } = harness({ movePct: 2.5, parked: true });
    await mockPoolReads(null);
    await monitor.cycle();
    expect(order).not.toContain("rebalance");
    expect(order).toContain("parkIdle"); // still parked: idle capital keeps earning
  });

  it("re-enters once the move cools below the re-entry threshold", async () => {
    const { monitor, order } = harness({ movePct: 1.0, parked: true });
    await mockPoolReads(null);
    await monitor.cycle();
    expect(order).toContain("rebalance");
    expect(order.indexOf("releaseAll")).toBeLessThan(order.indexOf("rebalance"));
  });

  it("opens the hedge while hostile", async () => {
    const { monitor, order } = harness({ movePct: 5 });
    await mockPoolReads(null);
    await monitor.cycle();
    expect(order).not.toContain("rebalance"); // parked
    expect(order.indexOf("parkIdle")).toBeLessThan(order.indexOf("hedge.open")); // collateral first
  });

  it("closes an open hedge before withdrawing collateral and deploying", async () => {
    const { monitor, order } = harness({ movePct: 0.5, parked: true, hedgeOpen: true });
    await mockPoolReads(null);
    await monitor.cycle();
    expect(order.indexOf("hedge.close")).toBeGreaterThan(-1);
    expect(order.indexOf("hedge.close")).toBeLessThan(order.indexOf("releaseAll"));
    expect(order.indexOf("releaseAll")).toBeLessThan(order.indexOf("rebalance"));
  });

  it("does not close a hedge that does not exist", async () => {
    const { monitor, order } = harness({ movePct: 0.5, parked: true, hedgeOpen: false });
    await mockPoolReads(null);
    await monitor.cycle();
    expect(order).not.toContain("hedge.close");
    expect(order).toContain("rebalance");
  });
});

describe("persisted re-centre cooldown", () => {
  it("postpones a re-centre when the persisted timestamp is fresh", async () => {
    const { monitor, order } = harness({
      movePct: 0,
      recenterMinHours: 24,
      lastRecenterAtSecondsAgo: 3600,
      positionId: 42n,
    });
    await mockPoolReads(42n);
    await monitor.cycle();
    expect(order).not.toContain("rebalance");
  });

  it("persists the timestamp after a live re-centre so a restart honours it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monrc-"));
    dirs.push(dir);
    const stateFile = join(dir, "position.json");
    saveState(stateFile, emptyState());

    const { monitor, order } = harness({ movePct: 0, recenterMinHours: 24 });
    await mockPoolReads(null);
    // Live run: dry runs must not start the cooldown.
    (monitor as unknown as { config: LpRebalanceConfig }).config.dryRun = false;
    (monitor as unknown as { config: LpRebalanceConfig }).config.stateFile = stateFile;
    await monitor.cycle();
    expect(order).toContain("rebalance");
    expect(loadState(stateFile).lastRecenterAt).toBeGreaterThan(0);

    // A NEW monitor instance (restart) inherits the cooldown from disk.
    const order2: string[] = [];
    const again = new Monitor(
      { readContract: async () => 0n } as never,
      { account: { address: pool.address } } as never,
      { ...cfg, stateFile, dryRun: true, regimeMaxMovePct: 0, recenterMinHours: 24 },
      null,
      30,
      pool,
      { name: "t", shouldRebalance: () => true, computeRange: () => ({ lowerTick: 0, upperTick: 1 }) },
      lendingNoop(),
      null,
    );
    stubChain(again, order2, 42n);
    await mockPoolReads(42n);
    await again.cycle();
    expect(order2).not.toContain("rebalance");
  });

  /**
   * The liquidation guard must run before open(), and an unwind must not be
   * followed by re-opening into the very conditions that forced it: the
   * regime is still hostile, so the next attempt would rebuild the same
   * position at a worse health factor.
   */
  it("checks health before opening, and does not re-open after an unwind", async () => {
    const { monitor, order } = harness({ movePct: 5, hedgeOpen: true, hedgeUnhealthy: true });
    await mockPoolReads(null);
    await monitor.cycle();
    expect(order).toContain("hedge.checkHealth");
    expect(order).not.toContain("hedge.open");
  });

  it("opens only after a healthy check", async () => {
    const { monitor, order } = harness({ movePct: 5 });
    await mockPoolReads(null);
    await monitor.cycle();
    expect(order.indexOf("hedge.checkHealth")).toBeLessThan(order.indexOf("hedge.open"));
  });
});
