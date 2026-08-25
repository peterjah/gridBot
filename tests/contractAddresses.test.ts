import { afterEach, describe, expect, it } from "vitest";
import { BASE_CONTRACTS, loadConfig } from "../src/config.js";

const KEYS = [
  "AAVE_POOL",
  "SWAP_ROUTER_ADDRESS",
  "QUOTER_ADDRESS",
  "POSITION_MANAGER_ADDRESS",
] as const;
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

function setEnv(key: string, value: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}

describe("contract addresses", () => {
  it("defaults to the Base deployments", () => {
    for (const k of KEYS) setEnv(k, "");
    const cfg = loadConfig("backtest");
    expect(cfg.contracts).toEqual(BASE_CONTRACTS);
  });

  /**
   * AaveExecutor used to read the Pool from a module constant, so AAVE_POOL
   * appeared configurable and silently was not.
   */
  it("honours AAVE_POOL", () => {
    setEnv("AAVE_POOL", "0x1111111111111111111111111111111111111111");
    const cfg = loadConfig("backtest");
    expect(cfg.contracts.aavePool).toBe("0x1111111111111111111111111111111111111111");
    // The legacy top-level field must agree, or the two disagree at runtime.
    expect(cfg.aavePool).toBe(cfg.contracts.aavePool);
  });

  it("honours the Uniswap overrides everywhere they are consumed", () => {
    setEnv("SWAP_ROUTER_ADDRESS", "0x2222222222222222222222222222222222222222");
    setEnv("QUOTER_ADDRESS", "0x3333333333333333333333333333333333333333");
    setEnv("POSITION_MANAGER_ADDRESS", "0x4444444444444444444444444444444444444444");
    const cfg = loadConfig("backtest");

    expect(cfg.contracts.swapRouter).toBe("0x2222222222222222222222222222222222222222");
    expect(cfg.contracts.quoter).toBe("0x3333333333333333333333333333333333333333");
    expect(cfg.contracts.positionManager).toBe("0x4444444444444444444444444444444444444444");

    // The LP path reads its own copies; they must come from the same source.
    expect(cfg.lpRebalance.swapRouterAddress).toBe(cfg.contracts.swapRouter);
    expect(cfg.lpRebalance.quoterAddress).toBe(cfg.contracts.quoter);
    expect(cfg.lpRebalance.positionManagerAddress).toBe(cfg.contracts.positionManager);
  });
});
