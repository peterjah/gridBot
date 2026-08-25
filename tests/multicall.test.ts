import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import {
  encodeExactInputSingle,
  encodeRouterMulticall,
} from "../src/uniswap/swap.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const RECIPIENT = "0x0000000000000000000000000000000000000001";

describe("router multicall encoding", () => {
  it("batches swap legs with a deadline and decodes back identically", () => {
    const leg = encodeExactInputSingle({
      tokenIn: USDC,
      tokenOut: WETH,
      fee: 500,
      recipient: RECIPIENT,
      amountIn: 1000n * 10n ** 6n,
      amountOutMinimum: 2n * 10n ** 17n,
    });

    const outer = encodeRouterMulticall([leg, leg, leg], 1234567890n);
    const decoded = decodeFunctionData({
      abi: [
        {
          name: "multicall",
          type: "function",
          stateMutability: "payable",
          inputs: [
            { name: "deadline", type: "uint256" },
            { name: "data", type: "bytes[]" },
          ],
          outputs: [],
        },
      ],
      data: outer,
    });

    expect(decoded.functionName).toBe("multicall");
    expect(decoded.args[0]).toBe(1234567890n);
    const legs = decoded.args[1] as `0x${string}`[];
    expect(legs).toHaveLength(3);
    // Each inner call must be byte-identical to a standalone swap.
    for (const l of legs) expect(l).toBe(leg);
  });
});
