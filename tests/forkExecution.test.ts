import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createClient } from "../src/blockchain/client.js";
import type { BotClient } from "../src/blockchain/client.js";
import { createTransactor } from "../src/blockchain/wallet.js";
import type { AppConfig } from "../src/config.js";
import { BASE_CONTRACTS } from "../src/config.js";
import { UniswapV3Executor } from "../src/execution/uniswapExecutor.js";
import { AaveExecutor } from "../src/lending/aaveExecutor.js";
import { getPoolInfo, getPoolState } from "../src/uniswap/pool.js";

/**
 * Fork integration tests: exercise the REAL execution path — batched router
 * multicall fills and Aave supply/withdraw — against a forked Base node.
 *
 * Run:
 *   anvil --fork-url https://base.publicnode.com
 *   FORK_URL=http://localhost:8545 npx vitest run tests/forkExecution.test.ts
 *
 * Skipped automatically when FORK_URL is not set.
 */
const FORK_URL = process.env.FORK_URL;

const POOL_ADDRESS = "0xd0b53D9277642d899DF5C87A3966A349A798F224" as const;
const TEST_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TOKEN_SOURCE = POOL_ADDRESS; // the pool holds both tokens

describe.runIf(FORK_URL)("fork execution", () => {
  const client = createClient([FORK_URL!]);
  const rpc = client as unknown as BotClient & {
    request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  };
  const account = privateKeyToAccount(TEST_KEY);
  let pool!: Awaited<ReturnType<typeof getPoolInfo>>;
  let cfg!: AppConfig;
  let aave!: AaveExecutor;
  let executor!: UniswapV3Executor;

  async function sendTx(label: string, from: Address, to: Address, data: `0x${string}`) {
    void label;
    const hash = (await rpc.request({
      method: "eth_sendTransaction",
      params: [{ from, to, data }],
    })) as `0x${string}`;
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    return receipt;
  }

  async function balance(token: Address): Promise<number> {
    const [raw, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return Number(formatUnits(raw, decimals));
  }

  beforeAll(async () => {
    pool = await getPoolInfo(client, POOL_ADDRESS);
    cfg = {
      mode: "live",
      rpcUrls: [FORK_URL!],
      privateKey: TEST_KEY,
      walletAddress: null,
      poolAddress: POOL_ADDRESS,
      csvFile: "",
      reportFile: "",
      contracts: BASE_CONTRACTS,
      idleRedeployPct: 5,
      idleRedeployMinUsd: 50,
      maxPollIntervalSeconds: 900,
      hedgePollIntervalSeconds: 120,
      hedgeBorrowAprPct: 3,
      hedgeMinHealthFactor: 1.6,
      lpRebalance: {
        widthTicks: 488,
        thresholdTicks: 723,
        rangePct: 5,
        recenterBufferPct: 50,
        recenterMinHours: 24,
        positionManagerAddress: BASE_CONTRACTS.positionManager,
        swapRouterAddress: BASE_CONTRACTS.swapRouter,
        quoterAddress: BASE_CONTRACTS.quoter,
        slippageBps: 50,
        positionId: 0n,
        stateFile: "state/position.json",
        dryRun: true,
        regimeMaxMovePct: 0,
        regimeLookbackHours: 168,
        regimeSampleMinutes: 60,
        regimeReenterMarginPct: 25,
        seedFile: null,
      },
      resultsDir: "results",
      aprFile: null,
      aaveYieldFile: null,
      lendBufferUsdc: 0,
      minPoolTvlUsd: 0,
      runLabel: "fork-test",
      pollIntervalSeconds: 30,
      estimatedGasUsd: 0.02,
      gas: { txOverheadUsd: 0, perFillUsd: 0.02, lendingLegUsd: 0 },
      lendingGasLegs: false,
      optimizer: {
        axes: {
          spacings: [1], widths: [10], resetBuffers: [2], orderFractions: [5],
          maxVols: [], inventoryCaps: [], cooldownHours: [],
          sellFractions: [], underwaterSkips: [],
        },
        metric: "RETURN" as never,
        top: 15,
        trainFraction: 0.6,
        selection: "walk-forward" as const,
        folds: 3,
        autoCenter: true,
        scenario: { months: 12, stepDays: 30, moveMin: 10, moveMax: 60 },
      },
      grid: {
        initialUsdc: 10_000,
        initialEth: 0,
        centerPrice: 4000,
        spacingPercent: 1,
        levelsAbove: 5,
        levelsBelow: 5,
        orderSizeUsd: 1000,
        executionMode: "taker",
        feeBps: 5,
        slippageBps: 50,
        minEthUsd: 0,
        maxEthUsd: Number.POSITIVE_INFINITY,
        resetSellFraction: 1,
        resetUnderwaterSkipPct: 0,
        lpFeeBps: 5,
        lpVenueVolumeSharePct: 5,
        lpPoolLiquidityUsd: 0,
        lpFeeAprPct: 0,
        lpReferenceRangePct: 0,
        regimeMaxMovePct: 0,
        regimeLookbackPoints: 336,
        resetBufferLevels: 2,
        regenMinSeconds: 3600,
        volLookbackPoints: 24,
        maxVolPerStep: 0.005,
    resetConfirmObservations: 0,
    resetVolPostpone: false,
    resetHardDrawdownPct: 25,
    resetHardInventoryLossPct: 0,
        resetSkipCooldownWhenFlat: false,
        resetBreakerK: 3,
        resetBreakerWindowSeconds: 30 * 24 * 3600,
      },
            lendingEnabled: true,
      aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
     aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
     aWeth: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7",
     variableDebtUsdc: "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28",
     variableDebtWeth: "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E",
      lendBufferUsdcUsd: 0,
      lendBufferEth: 0,
      lendMinActionUsd: 100,
      lendIntervalSeconds: 3600,
      hedgeEnabled: false,
      hedgeRatioPct: 50,
      hedgeMaxLtvPct: 40,
      soakLogFile: "",
      soakDays: 0,
    };

    aave = new AaveExecutor(
      client,
      cfg,
      { underlying: pool.token1.address, aToken: cfg.aUsdc, debtToken: cfg.variableDebtUsdc, decimals: pool.token1.decimals, symbol: pool.token1.symbol },
      { underlying: pool.token0.address, aToken: cfg.aWeth, debtToken: cfg.variableDebtWeth, decimals: pool.token0.decimals, symbol: pool.token0.symbol },
      TEST_KEY,
    );
    executor = new UniswapV3Executor(client, cfg, pool, TEST_KEY);

    // Fund: impersonate the pool (holds both tokens) and transfer.
    await rpc.request({ method: "anvil_impersonateAccount", params: [TOKEN_SOURCE] });
    await rpc.request({
      method: "anvil_setBalance",
      params: [TOKEN_SOURCE, `0x${(10n ** 18n).toString(16)}`],
    });
    for (const token of [pool.token1.address, pool.token0.address]) {
      await sendTx(
        "fund",
        TOKEN_SOURCE,
        token,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [account.address, 5000n * 10n ** BigInt(pool.token1.decimals)],
        }),
      );
    }
  }, 240_000);

  it("supplies and withdraws USDC on Aave V3", async () => {
    const beforeWallet = await balance(pool.token1.address);
    expect(beforeWallet).toBeGreaterThan(4000);

    await aave.supply("USDC", 2000);
    const lentAfterSupply = await aave.lentBalance("USDC");
    expect(lentAfterSupply).toBeGreaterThanOrEqual(1999); // ~2000 aUSDC
    const walletAfterSupply = await balance(pool.token1.address);
    expect(walletAfterSupply).toBeLessThanOrEqual(beforeWallet - 1999);

    await aave.withdraw("USDC", 1500);
    const lentAfterWithdraw = await aave.lentBalance("USDC");
    expect(lentAfterWithdraw).toBeLessThanOrEqual(lentAfterSupply - 1499);
    const walletAfterWithdraw = await balance(pool.token1.address);
    expect(walletAfterWithdraw).toBeGreaterThan(walletAfterSupply + 1400);
  }, 120_000);

  it("executes multi-fill BUY batches in one router multicall", async () => {
    const ethBefore = await balance(pool.token0.address);
    const result = await executor.executeFills([
      { type: "BUY", amount: 300, gridLevel: -1 },
      { type: "BUY", amount: 300, gridLevel: -2 },
    ]);
    expect(result).not.toBeNull();
    expect(result!.results).toHaveLength(2);
    expect(result!.results[0]!.txHash).toBe(result!.txHash); // same tx
    const ethAfter = await balance(pool.token0.address);
    expect(ethAfter).toBeGreaterThan(ethBefore);
    for (const r of result!.results) {
      expect(r.baseAmount).toBeGreaterThan(0);
      expect(r.effectivePrice).toBeGreaterThan(0);
    }
  }, 120_000);

  it("executes SELL fills back to USDC", async () => {
    const usdcBefore = await balance(pool.token1.address);
    const ethHeld = await balance(pool.token0.address);
    expect(ethHeld).toBeGreaterThan(0.01);
    const result = await executor.executeFills([{ type: "SELL", amount: 0.05, gridLevel: 1 }]);
    expect(result).not.toBeNull();
    const usdcAfter = await balance(pool.token1.address);
    expect(usdcAfter).toBeGreaterThan(usdcBefore);
    expect(result!.results[0]!.quoteAmount).toBeGreaterThan(0);
  }, 120_000);

  it("pool state is readable for the strategy loop", async () => {
    const state = await getPoolState(client, POOL_ADDRESS);
    expect(state.sqrtPriceX96).toBeGreaterThan(0n);
    expect(Math.abs(state.currentTick)).toBeLessThan(1_000_000);
  });
});
