import type { Address } from "viem";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import type { AppConfig } from "../config.js";
import type { BotClient } from "../blockchain/client.js";
import { createTransactor } from "../blockchain/wallet.js";
import { logger } from "../utils/logger.js";
import { walletAndLentBalances } from "../blockchain/multicall.js";

const MAX_UINT256 = (1n << 256n) - 1n;

/** Official Aave V3 Base deployments (aave-dao/aave-address-book v4.66.0). */
/**
 * Base mainnet aToken deployments, used as defaults by the config loader.
 *
 * The Pool address is NOT read from here at runtime: it comes from
 * `cfg.contracts.aavePool`, so AAVE_POOL is actually honoured. It used to be
 * taken from this constant, which meant setting the env var appeared to work
 * and silently did nothing.
 */
export const AAVE_V3_BASE = {
  pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as const,
  aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB" as const,
  aWeth: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7" as const,
  variableDebtUsdc: "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28" as const,
  variableDebtWeth: "0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E" as const,
};

/** Aave interest rate mode for variable-rate borrows (stable is deprecated). */
const INTEREST_RATE_MODE_VARIABLE = 2n;

export interface AssetPair {
  /** Underlying token (e.g. USDC, WETH). */
  underlying: Address;
  /** Corresponding aToken (interest-bearing). */
  aToken: Address;
  /**
   * Corresponding variable-rate debt token.
   *
   * Optional while the short-hedge work that needs it is in progress: supply
   * and withdraw do not touch debt, so requiring it here breaks every existing
   * caller for a field none of them use. Tighten to required once the borrow
   * path and its config land.
   */
  debtToken?: Address;
  decimals: number;
  symbol: string;
}

const poolAbi = [
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "borrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "repay",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "rateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Executes lending actions on the Aave V3 Pool.
 *
 * Safety notes:
 *  - supply/withdraw are plain single calls (no borrowing, no collateral
 *    mode changes beyond defaults);
 *  - every tx is simulated before signing by the transactor layer.
 */
export class AaveExecutor {
  private readonly client: BotClient;
  private readonly wallet: Address;
  private readonly poolAddress: Address;
  private readonly transactor: ReturnType<typeof createTransactor>;

  /**
   * `transactor` should be the caller's existing one whenever it has it.
   *
   * Each transactor tracks nonces locally, so two of them signing for the same
   * wallet allocate the same nonce and the node rejects the second as
   * "replacement transaction underpriced". Sharing one keeps the sequence
   * consistent across Uniswap and Aave calls.
   */
  constructor(
    client: BotClient,
    cfg: AppConfig,
    private readonly usdc: AssetPair,
    private readonly weth: AssetPair,
    privateKey: `0x${string}`,
    transactor?: ReturnType<typeof createTransactor>,
  ) {
    this.client = client;
    this.transactor = transactor ?? createTransactor(privateKey, cfg.rpcUrls);
    this.wallet = cfg.walletAddress ?? this.transactor.account.address;
    this.poolAddress = cfg.contracts.aavePool;
  }

  get pool(): Address {
    return this.poolAddress;
  }

  asset(asset: "USDC" | "WETH"): AssetPair {
    return asset === "USDC" ? this.usdc : this.weth;
  }

  async walletBalance(asset: "USDC" | "WETH"): Promise<number> {
    const a = this.asset(asset);
    const raw = await this.client.readContract({
      address: a.underlying,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.wallet],
    });
    const human = Number(formatUnits(raw, a.decimals));
    logger.debug("Aave: wallet balance", { asset, wallet: this.wallet, raw: raw.toString(), human });
    return human;
  }

  /** Lent balance = aToken balance (rebases upward with accrued interest). */
  async lentBalance(asset: "USDC" | "WETH"): Promise<number> {
    const a = this.asset(asset);
    const raw = await this.client.readContract({
      address: a.aToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.wallet],
    });
    const human = Number(formatUnits(raw, a.decimals));
    logger.debug("Aave: lent balance (aToken)", { asset, aToken: a.aToken, raw: raw.toString(), human });
    return human;
  }

  /**
   * Wallet and lent balances for every managed asset in ONE request.
   *
   * Read individually this is four round trips per sweep, and — worse — the
   * four values can land in different blocks, so the lending policy would be
   * deciding from a view that never existed. A single multicall is both
   * cheaper and internally consistent.
   */
  async allBalances(): Promise<{
    usdcWallet: number;
    usdcLent: number;
    ethWallet: number;
    ethLent: number;
  }> {
    const [usdc, weth] = await walletAndLentBalances(this.client, this.wallet, [
      { token: this.usdc.underlying, aToken: this.usdc.aToken },
      { token: this.weth.underlying, aToken: this.weth.aToken },
    ]);
    const out = {
      usdcWallet: Number(formatUnits(usdc!.wallet, this.usdc.decimals)),
      usdcLent: Number(formatUnits(usdc!.lent, this.usdc.decimals)),
      ethWallet: Number(formatUnits(weth!.wallet, this.weth.decimals)),
      ethLent: Number(formatUnits(weth!.lent, this.weth.decimals)),
    };
    logger.debug("Aave: batched balances", out);
    return out;
  }

  /** Wallet + lent balance for one asset, in a single request. */
  async balancesFor(asset: "USDC" | "WETH"): Promise<{ wallet: number; lent: number }> {
    const a = this.asset(asset);
    const [pair] = await walletAndLentBalances(this.client, this.wallet, [
      { token: a.underlying, aToken: a.aToken },
    ]);
    return {
      wallet: Number(formatUnits(pair!.wallet, a.decimals)),
      lent: Number(formatUnits(pair!.lent, a.decimals)),
    };
  }

  async supply(assetName: "USDC" | "WETH", amountHuman: number): Promise<void> {
    const a = this.asset(assetName);
    const amountRaw = BigInt(Math.floor(amountHuman * 10 ** a.decimals));
    if (amountRaw <= 0n) {
      logger.debug("Aave: supply skipped (zero amount)", { asset: assetName, amountHuman });
      return;
    }

    await this.ensureApproval(a.underlying, this.pool, amountRaw);
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: "supply",
      args: [a.underlying, amountRaw, this.wallet, 0],
    });
    logger.info("Aave: supplying", { asset: assetName, amount: amountHuman.toString() });
    const hash = await this.transactor.send(this.client, "aave-supply", this.pool, data);
    logger.debug("Aave: supply confirmed", { asset: assetName, txHash: hash });
  }

  async withdraw(assetName: "USDC" | "WETH", amountHuman: number): Promise<void> {
    const a = this.asset(assetName);
    const amountRaw = BigInt(Math.ceil(amountHuman * 10 ** a.decimals));
    if (amountRaw <= 0n) {
      logger.debug("Aave: withdraw skipped (zero amount)", { asset: assetName, amountHuman });
      return;
    }

    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: "withdraw",
      args: [a.underlying, amountRaw, this.wallet],
    });
    logger.info("Aave: withdrawing", { asset: assetName, amount: amountHuman.toString() });
    const hash = await this.transactor.send(this.client, "aave-withdraw", this.pool, data);
    logger.debug("Aave: withdraw confirmed", { asset: assetName, txHash: hash });
  }

  /**
   * Withdraw the ENTIRE balance of an asset.
   *
   * Withdrawing a computed amount risks reverting by one unit when the float
   * round-trip rounds above the actual balance ("not enough available user
   * balance") — exactly at the moment the bot needs to deploy. Aave caps
   * `type(uint256).max` at the user balance and the pool's available
   * liquidity, so max-withdraw cannot overdraw.
   */
  async withdrawMax(assetName: "USDC" | "WETH"): Promise<void> {
    const a = this.asset(assetName);
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: "withdraw",
      args: [a.underlying, MAX_UINT256, this.wallet],
    });
    logger.info("Aave: withdrawing full balance", { asset: assetName });
    const hash = await this.transactor.send(this.client, "aave-withdraw-max", this.pool, data);
    logger.debug("Aave: withdraw confirmed", { asset: assetName, txHash: hash });
  }

  /** Borrow `amountHuman` of an asset at variable rate against collateral. */
  async borrow(assetName: "USDC" | "WETH", amountHuman: number): Promise<void> {
    const a = this.asset(assetName);
    const amountRaw = BigInt(Math.floor(amountHuman * 10 ** a.decimals));
    if (amountRaw <= 0n) {
      logger.debug("Aave: borrow skipped (zero amount)", { asset: assetName, amountHuman });
      return;
    }
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: "borrow",
      args: [a.underlying, amountRaw, INTEREST_RATE_MODE_VARIABLE, 0, this.wallet],
    });
    logger.info("Aave: borrowing", {
      asset: assetName,
      amount: amountHuman.toString(),
      rateMode: "variable",
    });
    const hash = await this.transactor.send(this.client, "aave-borrow", this.pool, data);
    logger.debug("Aave: borrow confirmed", { asset: assetName, txHash: hash });
  }

  /**
   * Repay an EXACT raw amount of variable-rate debt.
   *
   * Raw because the caller reads the debt straight from the variableDebtToken
   * balance: rounding through a human float could exceed the actual debt and
   * revert, or fall short and strand dust.
   */
  async repayExact(assetName: "USDC" | "WETH", amountRaw: bigint): Promise<void> {
    if (amountRaw <= 0n) return;
    const a = this.asset(assetName);
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: "repay",
      args: [a.underlying, amountRaw, INTEREST_RATE_MODE_VARIABLE, this.wallet],
    });
    logger.info("Aave: repaying", {
      asset: assetName,
      amountRaw: amountRaw.toString(),
      amountHuman: formatUnits(amountRaw, a.decimals),
    });
    const hash = await this.transactor.send(this.client, "aave-repay", this.pool, data);
    logger.debug("Aave: repay confirmed", { asset: assetName, txHash: hash });
  }

  /** Variable-rate debt for one asset, raw units (rebases upward with interest). */
  async debtBalanceRaw(assetName: "USDC" | "WETH"): Promise<bigint> {
    const a = this.asset(assetName);
    return this.client.readContract({
      address: a.debtToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.wallet],
    });
  }

  private async ensureApproval(
    token: Address,
    spender: Address,
    amountNeeded: bigint,
  ): Promise<void> {
    const allowance = await this.readAllowance(token, spender);
    logger.debug("Aave: allowance check", {
      token,
      spender,
      allowance: allowance.toString(),
      amountNeeded: amountNeeded.toString(),
    });
    // Compare against what this call actually needs. A previously partial or
    // partly-spent allowance is positive but can still be too small, and the
    // supply would revert with "transfer amount exceeds allowance".
    if (allowance >= amountNeeded) return;

    logger.info("Aave: approving pool to spend token", { token, spender });
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, MAX_UINT256],
    });
    await this.transactor.send(this.client, "approve", token, data);
    await this.awaitAllowance(token, spender, amountNeeded);
  }

  private async readAllowance(token: Address, spender: Address): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.wallet, spender],
    });
  }

  /**
   * Block until the approval is visible to reads.
   *
   * The transport fails over across RPC endpoints, so the node that confirms
   * the approval receipt is not necessarily the node that answers the next
   * call. Simulating the supply against a node one block behind reverts with
   * "transfer amount exceeds allowance" even though the approval landed —
   * observed in production immediately after a confirmed approve.
   */
  private async awaitAllowance(
    token: Address,
    spender: Address,
    amountNeeded: bigint,
    attempts = 10,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const allowance = await this.readAllowance(token, spender);
      if (allowance >= amountNeeded) {
        if (i > 0) logger.debug("Aave: allowance visible after retry", { token, attempt: i + 1 });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Approval for ${token} did not become visible after ${attempts}s; ` +
        `the RPC endpoints may be out of sync. Nothing was lost — retry.`,
    );
  }
}
