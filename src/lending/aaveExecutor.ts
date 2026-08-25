import type { Address } from "viem";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import type { AppConfig } from "../config.js";
import type { BotClient } from "../blockchain/client.js";
import { createTransactor } from "../blockchain/wallet.js";
import { logger } from "../utils/logger.js";
import { walletAndLentBalances } from "../blockchain/multicall.js";

const MAX_UINT256 = (1n << 256n) - 1n;

/** Official Aave V3 Base deployments (aave-dao/aave-address-book v4.66.0). */
export const AAVE_V3_BASE = {
  pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as const,
  aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB" as const,
  aWeth: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7" as const,
};

export interface AssetPair {
  /** Underlying token (e.g. USDC, WETH). */
  underlying: Address;
  /** Corresponding aToken (interest-bearing). */
  aToken: Address;
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
  }

  get pool(): Address {
    return AAVE_V3_BASE.pool;
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

    await this.ensureApproval(a.underlying, this.pool);
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

  private async ensureApproval(token: Address, spender: Address): Promise<void> {
    const allowance = await this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.wallet, spender],
    });
    logger.debug("Aave: allowance check", { token, spender, allowance: allowance.toString() });
    if (allowance > 0n) return;
    logger.info("Aave: approving pool to spend token", { token, spender });
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, MAX_UINT256] });
    await this.transactor.send(this.client, "approve", token, data);
  }
}
