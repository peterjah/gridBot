import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../src/blockchain/client.js";
import { createTransactor } from "../src/blockchain/wallet.js";
import type { Config } from "../src/config.js";
import { RebalanceExecutor } from "../src/bot/rebalanceExecutor.js";
import { getPoolInfo, getPoolState } from "../src/uniswap/pool.js";
import {
  encodeMint,
  getPosition,
} from "../src/uniswap/position.js";
import { decodeEventLog } from "viem";
import { CenteredRangeStrategy } from "../src/strategy/centeredRange.js";
import { getSqrtRatioAtTick } from "../src/utils/math.js";

/** Loosely-typed JSON-RPC access for anvil-specific methods. */
interface RawRpcClient {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

/**
 * Integration tests against a forked Base node (anvil).
 *
 * Run:
 *   anvil --fork-url https://base.publicnode.com
 *   FORK_URL=http://localhost:8545 npx vitest run tests/integration.fork.test.ts
 *
 * Skipped automatically when FORK_URL is not set.
 */
const FORK_URL = process.env.FORK_URL;

// WETH/USDC 0.05% pool on Base
const POOL_ADDRESS = "0xd0b53D9277642d899DF5C87A3966A349A798F224" as const;
// Anvil's pre-funded account #0
const TEST_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
// Token source for funding: the pool itself holds both tokens and its
// reserves are large enough that a small test transfer does not disturb
// pricing. (Known external whales change over time; the pool is stable.)
const TOKEN_SOURCE = POOL_ADDRESS;

const POSITION_MANAGER = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" as Address;
const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;

describe.runIf(FORK_URL)("fork integration", () => {
  const client = createClient([FORK_URL!]);
  const transactor = createTransactor(TEST_KEY, [FORK_URL!]);
  const account = privateKeyToAccount(TEST_KEY);
  let pool: Awaited<ReturnType<typeof getPoolInfo>>;
  let config: Config;
  let strategy: CenteredRangeStrategy;
  let executor: RebalanceExecutor;
  let initialPositionId!: bigint;
  const stateFile = join(mkdtempSync(join(tmpdir(), "gridbot-test-")), "state.json");

  const rpc = client as unknown as RawRpcClient;

  async function sendTx(label: string, to: Address, data: `0x${string}`, value?: bigint) {
    void label;
    const hash = (await rpc.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: account.address,
          to,
          data,
          ...(value !== undefined ? { value: `0x${value.toString(16)}` } : {}),
        },
      ],
    })) as `0x${string}`;
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    return receipt;
  }

  async function fundTokens() {
    // WETH: deposit native ETH
    await sendTx(
      "weth-deposit",
      pool.token0.address === "0x4200000000000000000000000000000000000006"
        ? pool.token0.address
        : pool.token1.address,
      encodeFunctionData({ abi: [{ name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] }], functionName: "deposit" }),
      10n ** 18n, // 1 WETH
    );
    // USDC: impersonate the pool (a large token holder) and transfer.
    await rpc.request({ method: "anvil_impersonateAccount", params: [TOKEN_SOURCE] });
    // The source may hold no native ETH; give it gas money.
    await rpc.request({
      method: "anvil_setBalance",
      params: [TOKEN_SOURCE, `0x${(10n ** 18n).toString(16)}`],
    });
    const usdc = pool.token0.address.toLowerCase() === "0x4200000000000000000000000000000000000006"
      ? pool.token1.address
      : pool.token0.address;
    const hash = (await rpc.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: TOKEN_SOURCE,
          to: usdc,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [account.address, 5000n * 10n ** 6n],
          }),
        },
      ],
    })) as `0x${string}`;
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  }

  async function balance(token: Address): Promise<bigint> {
    return client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
  }

  beforeAll(async () => {
    pool = await getPoolInfo(client, POOL_ADDRESS);
    config = {
      rpcUrls: [FORK_URL!],
      privateKey: TEST_KEY,
      walletAddress: undefined,
      poolAddress: POOL_ADDRESS,
      positionId: 0n,
      rangeWidthTicks: 600,
      rebalanceThresholdTicks: 300,
      slippageBps: 300,
      pollIntervalSeconds: 30,
      dryRun: false,
      stateFile,
      positionManagerAddress: POSITION_MANAGER,
      swapRouterAddress: SWAP_ROUTER,
      quoterAddress: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    };
    strategy = new CenteredRangeStrategy({
      widthTicks: config.rangeWidthTicks,
      thresholdTicks: config.rebalanceThresholdTicks,
    });
    executor = new RebalanceExecutor(client, transactor, config, pool, strategy);

    await fundTokens();

    // Approve the position manager and router for both tokens.
    for (const token of [pool.token0.address, pool.token1.address]) {
      for (const spender of [POSITION_MANAGER, SWAP_ROUTER]) {
        await sendTx(
          "approve",
          token,
          encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, (1n << 256n) - 1n] }),
        );
      }
    }

    // Mint an initial off-center position directly through the NPM.
    const state = await getPoolState(client, POOL_ADDRESS);
    const range = strategy.computeRange({
      currentTick: state.currentTick - 2000, // deliberately off-center
      tickSpacing: pool.tickSpacing,
    });
    const b0 = await balance(pool.token0.address);
    const b1 = await balance(pool.token1.address);
    const receipt = await sendTx(
      "mint-initial",
      POSITION_MANAGER,
      encodeMint({
        token0: pool.token0.address,
        token1: pool.token1.address,
        fee: pool.fee,
        tickLower: range.lowerTick,
        tickUpper: range.upperTick,
        amount0Desired: b0 / 2n,
        amount1Desired: b1 / 2n,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: account.address,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      }),
    );
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: [{
            name: "IncreaseLiquidity",
            type: "event",
            inputs: [
              { name: "tokenId", type: "uint256", indexed: true },
              { name: "liquidity", type: "uint128" },
              { name: "amount0", type: "uint256" },
              { name: "amount1", type: "uint256" },
            ],
          }],
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "IncreaseLiquidity") {
          initialPositionId = decoded.args.tokenId as bigint;
        }
      } catch {
        // unrelated log
      }
    }
    expect(initialPositionId).toBeDefined();
  }, 240_000);

  afterAll(async () => {
    await rpc.request({ method: "anvil_stopImpersonatingAccount", params: [TOKEN_SOURCE] }).catch(() => {});
  });

  it("manages the configured position end-to-end", async () => {
    const state = await getPoolState(client, POOL_ADDRESS);
    const position = await getPosition(client, POSITION_MANAGER, initialPositionId);
    expect(position).not.toBeNull();
    expect(position!.liquidity).toBeGreaterThan(0n);

    await executor.rebalance(position!, state.sqrtPriceX96, state.currentTick);

    // Old position must be fully closed.
    const oldPosition = await getPosition(client, POSITION_MANAGER, initialPositionId);
    expect(oldPosition!.liquidity).toBe(0n);

    // State file must point at a NEW position id.
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { positionId: string };
    const newPositionId = BigInt(saved.positionId);
    expect(newPositionId).not.toBe(initialPositionId);

    // New position must be open, centered near the current tick, and owned by us.
    const newPosition = await getPosition(client, POSITION_MANAGER, newPositionId);
    expect(newPosition).not.toBeNull();
    expect(newPosition!.liquidity).toBeGreaterThan(0n);
    expect(newPosition!.owner.toLowerCase()).toBe(account.address.toLowerCase());
    const center = Math.floor((newPosition!.tickLower + newPosition!.tickUpper) / 2);
    expect(Math.abs(state.currentTick - center)).toBeLessThan(config.rangeWidthTicks);
  }, 240_000);

  it("wallet client can sign for the test account", () => {
    expect(transactor.walletClient.account?.address.toLowerCase()).toBe(
      account.address.toLowerCase(),
    );
  });
});
