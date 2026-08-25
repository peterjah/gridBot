import type { FillModel } from "./types.js";

/**
 * Deterministic linear cost model: every fill pays the pool swap fee plus a
 * fixed slippage penalty, expressed as a multiplicative price degradation.
 *
 *   BUY  fills at levelPrice * (1 + c)
 *   SELL fills at levelPrice * (1 - c)
 *
 * where c = feeBps/10000 + slippageBps/10000.
 */
export class LinearCostFillModel implements FillModel {
  private readonly feeFrac: number;
  private readonly slipFrac: number;
  readonly costFrac: number;

  constructor(feeBps: number, slippageBps: number) {
    if (feeBps < 0 || slippageBps < 0) throw new Error("fee/slippage must be >= 0");
    this.feeFrac = feeBps / 10_000;
    this.slipFrac = slippageBps / 10_000;
    this.costFrac = this.feeFrac + this.slipFrac;
  }

  quoteBuy(levelPrice: number, quoteUsd: number) {
    const effectivePrice = levelPrice * (1 + this.costFrac);
    const ethOut = quoteUsd / effectivePrice;
    if (this.costFrac === 0) {
      // Exactly zero, not a float residue: a cost-free model must not leak
      // sub-cent noise into the fee/slippage accumulators.
      return { ethOut, effectivePrice, feeUsd: 0, slippageUsd: 0 };
    }
    const lossUsd = quoteUsd - ethOut * levelPrice; // value lost vs level price
    const f = this.feeFrac / this.costFrac;
    return {
      ethOut,
      effectivePrice,
      // Split the loss proportionally between fee and slippage for reporting.
      feeUsd: lossUsd * f,
      slippageUsd: lossUsd * (1 - f),
    };
  }

  quoteSell(levelPrice: number, ethIn: number) {
    const effectivePrice = levelPrice * (1 - this.costFrac);
    const usdcOut = ethIn * effectivePrice;
    if (this.costFrac === 0) {
      return { usdcOut, effectivePrice, feeUsd: 0, slippageUsd: 0 };
    }
    const lossUsd = ethIn * levelPrice - usdcOut;
    const f = this.feeFrac / this.costFrac;
    return {
      usdcOut,
      effectivePrice,
      feeUsd: lossUsd * f,
      slippageUsd: lossUsd * (1 - f),
    };
  }
}

/**
 * Cost-free fills, for liquidity that is already deposited in the pool.
 *
 * When price crosses a tick range the AMM converts the position at the pool
 * price; the liquidity provider pays nothing. The fee is paid by whoever
 * swapped against it, and reaches this position through the fee-income model
 * instead. Charging a swap cost here as well would bill the same dollar as
 * both the provider and the taker of the same trade.
 */
export class ZeroCostFillModel implements FillModel {
  quoteBuy(levelPrice: number, quoteUsd: number) {
    return {
      ethOut: quoteUsd / levelPrice,
      effectivePrice: levelPrice,
      feeUsd: 0,
      slippageUsd: 0,
    };
  }

  quoteSell(levelPrice: number, ethIn: number) {
    return {
      usdcOut: ethIn * levelPrice,
      effectivePrice: levelPrice,
      feeUsd: 0,
      slippageUsd: 0,
    };
  }
}
