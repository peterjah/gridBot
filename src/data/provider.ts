export interface PricePoint {
  /** Unix seconds. */
  timestamp: number;
  /** Human-readable price of ETH in USDC. */
  price: number;
  /**
   * Quote-asset volume traded during this observation, in USD. Optional:
   * only the LP fee model needs it, and generated data may not carry it.
   */
  volumeUsd?: number;
  /**
   * Annualized pool fee APR in effect at this observation, in percent
   * (fees earned per unit of TVL). Optional: supplied by an LP APR series.
   */
  feeAprPct?: number;
  /**
   * Pool TVL at this observation, in USD. Used to dilute fee income for a
   * position that is large relative to the pool — without it, a $10k position
   * in a $11k pool would earn the full pool-average rate, which is not
   * physical.
   */
  poolTvlUsd?: number;
}

/**
 * Historical market data source for the backtester.
 * Implementations: CSV files now; Uniswap V3 on-chain data later.
 */
export interface MarketDataProvider {
  getPrices(start: Date, end: Date): Promise<PricePoint[]>;
}
