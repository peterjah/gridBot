import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi } from "viem";
import {
  allowancesFor,
  balancesOf,
  quoteExactInputSingleBatch,
  walletAndLentBalances,
} from "../src/blockchain/multicall.js";
import type { BotClient } from "../src/blockchain/client.js";

const OWNER = "0x0000000000000000000000000000000000000001" as const;
const SPENDER = "0x0000000000000000000000000000000000000002" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const AUSDC = "0x0000000000000000000000000000000000000011" as const;
const AWETH = "0x0000000000000000000000000000000000000012" as const;
const QUOTER = "0x0000000000000000000000000000000000000099" as const;

/** One recorded `multicall` invocation: the argument object it was handed. */
interface MulticallArg {
  allowFailure: boolean;
  contracts: {
    address: string;
    functionName: string;
    args: readonly unknown[];
    abi: readonly unknown[];
  }[];
}

/** Minimal client stub that records the multicall it was handed. */
function stubClient(results: unknown[]) {
  const multicall = vi.fn((_arg: MulticallArg) => Promise.resolve(results));
  return { client: { multicall } as unknown as BotClient, multicall };
}

describe("batched reads", () => {
  it("reads many balances in a single request", async () => {
    const { client, multicall } = stubClient([100n, 200n]);
    const out = await balancesOf(client, OWNER, [USDC, WETH]);

    expect(out).toEqual([100n, 200n]);
    // The whole point: one round trip, not one per token.
    expect(multicall).toHaveBeenCalledTimes(1);
    const arg = multicall.mock.calls[0]![0];
    expect(arg.contracts).toHaveLength(2);
    expect(arg.allowFailure).toBe(false);
    expect(arg.contracts.map((c) => c.address)).toEqual([USDC, WETH]);
    expect(arg.contracts.every((c) => c.functionName === "balanceOf")).toBe(true);
  });

  it("reads allowances against one spender in a single request", async () => {
    const { client, multicall } = stubClient([7n, 8n]);
    const out = await allowancesFor(client, OWNER, SPENDER, [USDC, WETH]);

    expect(out).toEqual([7n, 8n]);
    expect(multicall).toHaveBeenCalledTimes(1);
    const arg = multicall.mock.calls[0]![0];
    expect(arg.contracts[0]!.args).toEqual([OWNER, SPENDER]);
  });

  it("pairs wallet and lent balances from one interleaved request", async () => {
    // Order matters: [usdc, aUsdc, weth, aWeth].
    const { client, multicall } = stubClient([1n, 2n, 3n, 4n]);
    const out = await walletAndLentBalances(client, OWNER, [
      { token: USDC, aToken: AUSDC },
      { token: WETH, aToken: AWETH },
    ]);

    expect(out).toEqual([
      { wallet: 1n, lent: 2n },
      { wallet: 3n, lent: 4n },
    ]);
    expect(multicall).toHaveBeenCalledTimes(1);
    const arg = multicall.mock.calls[0]![0];
    expect(arg.contracts.map((c) => c.address)).toEqual([USDC, AUSDC, WETH, AWETH]);
  });

  it("batches quotes and returns only amountOut", async () => {
    // QuoterV2 returns a 4-tuple; callers only need the first element.
    const { client, multicall } = stubClient([
      [111n, 0n, 0n, 0n],
      [222n, 0n, 0n, 0n],
    ]);
    const out = await quoteExactInputSingleBatch(client, QUOTER, [
      { tokenIn: USDC, tokenOut: WETH, fee: 500, amountIn: 1000n },
      { tokenIn: WETH, tokenOut: USDC, fee: 500, amountIn: 2000n },
    ]);

    expect(out).toEqual([111n, 222n]);
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("encodes quote calldata identically to a standalone quoter call", async () => {
    const { client, multicall } = stubClient([[1n, 0n, 0n, 0n]]);
    await quoteExactInputSingleBatch(client, QUOTER, [
      { tokenIn: USDC, tokenOut: WETH, fee: 500, amountIn: 1000n },
    ]);
    const c = multicall.mock.calls[0]![0].contracts[0]!;
    // The view-typed ABI must produce the same selector and calldata as the
    // real nonpayable quoter, or the batched quote is not the same call.
    const viaBatch = encodeFunctionData({
      abi: c.abi,
      functionName: c.functionName,
      args: c.args,
    } as Parameters<typeof encodeFunctionData>[0]);
    expect(viaBatch.slice(0, 10)).toBe("0xc6a5026a"); // quoteExactInputSingle
  });

  it("short-circuits without an RPC call when there is nothing to read", async () => {
    const { client, multicall } = stubClient([]);
    expect(await balancesOf(client, OWNER, [])).toEqual([]);
    expect(await allowancesFor(client, OWNER, SPENDER, [])).toEqual([]);
    expect(await quoteExactInputSingleBatch(client, QUOTER, [])).toEqual([]);
    expect(await walletAndLentBalances(client, OWNER, [])).toEqual([]);
    expect(multicall).not.toHaveBeenCalled();
  });
});

describe("erc20 encoding sanity", () => {
  it("uses the standard balanceOf selector", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [OWNER],
    });
    expect(data.slice(0, 10)).toBe("0x70a08231");
  });
});
