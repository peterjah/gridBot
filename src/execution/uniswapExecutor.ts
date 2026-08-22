import type { Address } from "viem";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import type { AppConfig } from "../config.js";
import type { BotClient } from "../blockchain/client.js";
import { createTransactor } from "../blockchain/wallet.js";
import type { PoolInfo } from "../uniswap/pool.js";
import { encodeExactInputSingle, quoteExactInputSingle } from "../uniswap/swap.js";

const MAX_UINT256 = (1n << 256n) - 1n;
// Official Uniswap V3 deployments on Base
const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address;

export interface ExecutionResult {
  /** Base asset (ETH) received/sold, human units. */
  baseAmount: number;
  /** Quote asset (USDC) spent/received, human units. */
  quoteAmount: number;
  effectivePrice: number;
  txHash: `0x${string}`;
}

/**
 * Executes grid actions as real Uniswap V3 swaps through SwapRouter02.
 *
 * This is the "Approach C" execution model (see docs/EXECUTION_APPROACH.md):
 * grid levels are virtual limit orders filled with market swaps when the
 * strategy decides a level has been crossed. Simple, faithful to the grid
 * model, and reuses the battle-tested router path.
 */
export class UniswapV3Executor {
  private readonly client: BotClient;
  private readonly wallet: Address;
  private readonly transactor: ReturnType<typeof createTransactor>;
  private readonly slippageBps: number;

  constructor(
    client: BotClient,
    cfg: AppConfig,
    private readonly pool: PoolInfo,
    privateKey: `0x${string}`,
  ) {
    this.client = client;
    this.transactor = createTransactor(privateKey, cfg.rpcUrls);
    this.wallet = cfg.walletAddress ?? this.transactor.account.address;
    this.slippageBps = Math.max(cfg.grid.slippageBps, 50); // at least 0.5% on-chain
  }

  /** Buy ETH with roughly `quoteUsd` USDC. */
  async buy(quoteUsd: number): Promise<ExecutionResult> {
    const usdc = this.pool.token1;
    const weth = this.pool.token0;
    const amountIn = BigInt(Math.round(quoteUsd * 10 ** usdc.decimals));

    const balance = await this.balanceOf(usdc.address);
    if (balance < amountIn) {
      throw new Error(
        `Insufficient ${usdc.symbol}: have ${formatUnits(balance, usdc.decimals)}, need ${formatUnits(amountIn, usdc.decimals)}`,
      );
    }

    const quotedOut = await quoteExactInputSingle(
      this.client, QUOTER, usdc.address, weth.address, this.pool.fee, amountIn,
    );
    const minOut = applySlippage(quotedOut, this.slippageBps);

    await this.ensureApproval(usdc.address, SWAP_ROUTER);
    const txHash = await this.swap(usdc.address, weth.address, amountIn, minOut);

    return {
      quoteAmount: Number(formatUnits(amountIn, usdc.decimals)),
      baseAmount: Number(formatUnits(minOut, weth.decimals)),
      effectivePrice: Number(formatUnits(amountIn, usdc.decimals)) / Number(formatUnits(minOut, weth.decimals)),
      txHash,
    };
  }

  /** Sell `baseEth` ETH for USDC. */
  async sell(baseEth: number): Promise<ExecutionResult> {
    const weth = this.pool.token0;
    const usdc = this.pool.token1;
    const amountIn = BigInt(Math.round(baseEth * 10 ** weth.decimals));

    const balance = await this.balanceOf(weth.address);
    if (balance < amountIn) {
      throw new Error(
        `Insufficient ${weth.symbol}: have ${formatUnits(balance, weth.decimals)}, need ${formatUnits(amountIn, weth.decimals)}`,
      );
    }

    const quotedOut = await quoteExactInputSingle(
      this.client, QUOTER, weth.address, usdc.address, this.pool.fee, amountIn,
    );
    const minOut = applySlippage(quotedOut, this.slippageBps);

    await this.ensureApproval(weth.address, SWAP_ROUTER);
    const txHash = await this.swap(weth.address, usdc.address, amountIn, minOut);

    return {
      quoteAmount: Number(formatUnits(minOut, usdc.decimals)),
      baseAmount: Number(formatUnits(amountIn, weth.decimals)),
      effectivePrice: Number(formatUnits(minOut, usdc.decimals)) / Number(formatUnits(amountIn, weth.decimals)),
      txHash,
    };
  }

  // ------------------------------------------------------------------ internal

  private async swap(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    amountOutMinimum: bigint,
  ): Promise<`0x${string}`> {
    const data = encodeExactInputSingle({
      tokenIn,
      tokenOut,
      fee: this.pool.fee,
      recipient: this.wallet,
      amountIn,
      amountOutMinimum,
    });
    return this.transactor.send(this.client, "exactInputSingle", SWAP_ROUTER, data);
  }

  private async ensureApproval(token: Address, spender: Address): Promise<void> {
    const allowance = await this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.wallet, spender],
    });
    if (allowance > 0n) return;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, MAX_UINT256] });
    await this.transactor.send(this.client, "approve", token, data);
  }

  private async balanceOf(token: Address): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.wallet],
    });
  }
}

function applySlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}
