/**
 * Gas cost model for the backtest.
 *
 * Gas is environment-specific, so the strategy stays gas-agnostic and the
 * backtester charges it. The shape of the cost — not just its size — changes
 * which parameters are optimal, so it is modeled explicitly:
 *
 *   gasPerTradingObservation
 *     = txOverheadUsd                       // once per transaction
 *     + fills * perFillUsd                  // each swap leg
 *     + (lending ? lendingLegUsd : 0)       // Aave withdraw/supply legs
 *
 * The first term is what makes batching matter. When one price observation
 * crosses several grid levels, all the resulting fills are submitted in a
 * single multicall transaction, so the fixed per-transaction cost is paid
 * once rather than once per fill. Charging it per fill (the old flat model)
 * overstates the cost of fast moves and biases the optimizer toward wider
 * spacing than is actually justified.
 *
 * The lending leg is charged per transaction, not per fill, for the same
 * reason: one withdraw covers every fill in the batch.
 */
export interface GasModel {
  /** Fixed cost of submitting one transaction, USD. */
  txOverheadUsd: number;
  /** Marginal cost of each additional swap leg in the batch, USD. */
  perFillUsd: number;
  /**
   * Extra cost when the transaction must also move funds in or out of the
   * money market so lent assets are available to trade. USD per transaction.
   */
  lendingLegUsd: number;
}

/**
 * The historical flat model: every fill costs the same and nothing is
 * batched. Kept as the default so existing results are reproducible.
 */
export function flatGasModel(perTradeUsd: number): GasModel {
  return { txOverheadUsd: 0, perFillUsd: perTradeUsd, lendingLegUsd: 0 };
}

/** Total gas for one observation that produced `fills` trades. */
export function gasForObservation(model: GasModel, fills: number, lending: boolean): number {
  if (fills <= 0) return 0;
  return (
    model.txOverheadUsd + fills * model.perFillUsd + (lending ? model.lendingLegUsd : 0)
  );
}

/**
 * Per-fill attribution of a batched transaction's gas, for the trade ledger.
 * The shared costs are split evenly across the fills in the batch so the
 * ledger still sums to the total charged.
 */
export function gasPerFill(model: GasModel, fills: number, lending: boolean): number {
  if (fills <= 0) return 0;
  return gasForObservation(model, fills, lending) / fills;
}
