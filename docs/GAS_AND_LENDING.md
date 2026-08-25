# Gas, batching and lending idle assets

Notes for the execution layer, derived from the backtest. Numbers are from
real ETH hourly prices joined to the measured Base WETH/USDC 0.05% pool APR
series, 2024-04 to 2026-08, $10k.

## The gas model

Gas shape, not just size, affects which parameters are optimal, so the
backtest models it explicitly:

```
gasPerTradingTransaction
  = GAS_TX_OVERHEAD_USD                    // once per transaction
  + fills * GAS_PER_FILL_USD               // each swap leg
  + GAS_LENDING_LEG_USD                    // money-market legs, once per tx
```

The overhead term is what makes **batching** matter. When one price
observation crosses several grid levels, every resulting fill goes into a
single multicall transaction, so the fixed cost is paid once. The old flat
model charged it per fill, which overstated the cost of fast moves and biased
the optimizer toward wider spacing than the economics justify.

The lending leg is charged **per transaction, not per fill**, for the same
reason: one withdraw covers every fill in the batch.

Defaults reproduce the flat model exactly, so enabling this changes nothing
until the new values are set.

## Does gas change the optimal parameters?

No, at realistic Base costs. Same sweep under three gas regimes:

| Regime | Best configuration | Return | Total gas |
| --- | --- | --- | --- |
| Flat $0.02/fill | 3% / ±30% / reset 1 / order 10% | +107.39% | $77 |
| Batched ($0.01 + $0.02) | *same* | +107.38% | $78 |
| Batched + Aave leg ($0.04) | *same* | +107.35% | $81 |

Gas is roughly 0.8% of profit over 2.4 years. Parameter selection and gas
optimization are effectively independent problems at this capital scale.

## Is "lent assets always available" affordable?

Yes, with a very large margin. Making every lent dollar withdrawable on demand
means every trading transaction carries a withdraw leg. That is worth it while

```
legCostPerTx  <  idleBalance * aaveApy / tradesPerYear
```

| Configuration | Trades/yr | Idle balance | Aave income | Break-even per tx |
| --- | --- | --- | --- | --- |
| Best (3% / ±30% / 10%) | 35 | $9,725 | $400/yr | **$11.51** |
| Busiest (1% / ±10% / 1%) | 490 | $9,301 | $382/yr | **$0.78** |

A batched swap+withdraw multicall on Base costs roughly **$0.02–0.06** — 13x
below break-even in the worst (busiest) case, and ~200x below it for the
configuration the optimizer actually selects.

**Implication: no liquidity buffer is needed on economic grounds.** Keeping a
buffer to avoid withdraw round-trips saves a cost that is two orders of
magnitude below the yield it forgoes. A buffer is still reasonable for
latency, failure-mode and slippage reasons — but it should be sized for those,
not for gas.

## Minimum viable capital

Gas is a fixed cost, so it bites at small size. At the busiest configuration
(490 trades/yr, $0.04 lending leg):

| Capital | Aave income | Extra leg gas | Net |
| --- | --- | --- | --- |
| $250 | $9.56/yr | $19.60/yr | **negative** |
| $500 | $19.11/yr | $19.60/yr | break-even |
| $1,000 | $38.23/yr | $19.60/yr | positive (2.0x) |
| $10,000 | $382.26/yr | $19.60/yr | positive (19.5x) |

Below roughly **$500**, a high-frequency grid should not lend at all. At the
low-frequency configuration the threshold is ~35x lower.

## Batched reads

On-chain reads go through **Multicall3** (`src/blockchain/multicall.ts`),
which viem resolves from the chain config — no address to configure. Reads are
the safe case for Multicall3: it uses a plain `CALL`, so `msg.sender` becomes
the Multicall3 contract, which is irrelevant for a `balanceOf` but would break
any state-changing call that relies on the wallet's identity or approvals.

| Site | Before | After |
| --- | --- | --- |
| `getPoolInfo` (startup) | 8 | 2 |
| `getPoolState` (per poll) | 2 | 1 |
| Quotes for a 5-fill batch | 5 | 1 |
| Batch allowances | 2 | 1 |
| `ensureLiquidity` (per asset) | 2 | 1 |
| Lending sweep balances | 4 | 1 |

A busy poll cycle with five fills goes from **17 requests to 6**; a quiet one
from 6 to 2.

Two of these are correctness fixes as much as savings. `getPoolState` read
price and liquidity separately, so they could land in different blocks and
describe states that never coexisted. The lending sweep read four balances in
four sequential requests and then made a supply/withdraw decision from that
mixed view. Batching each into one request makes them consistent by
construction.

**Batching quotes does not fix intra-batch price impact.** All quotes in a
batch still see the same pre-batch pool state; it saves round trips, nothing
more. When those swaps execute together each leg moves the price for the next,
so later legs fill worse than quoted — size the slippage floors accordingly.

## One modelling caveat

The LP fee model and money-market lending are **mutually exclusive on the same
dollar**: capital sitting in the Uniswap position cannot simultaneously be
supplied to Aave. `GridStrategy.deployedCapital()` and `idleCapital()` are the
single definition of that split — anything deciding what to lend should use
them rather than re-deriving "idle", or the same capital will be counted
twice.

Note that the definition differs by bot. The shipped executor is a **taker**:
it swaps, nothing is escrowed, so nearly the whole balance is genuinely
lendable. Only under the LP-fee model is a portion locked in the position.

## Implementation status (live path)

Batching is now implemented in the execution layer, with one documented
deviation from the model:

* **All fills from one price observation go into a single
  `SwapRouter02.multicall(deadline, bytes[])` transaction** — the router's own
  audited batcher. Per-fill `amountOutMinimum` floors are preserved inside the
  batch, so slippage protection survives batching. The batch is atomic:
  either every crossed level fills or none do.
* **Aave withdrawals are one tx per asset per cycle**, sent before the batch,
  covering the combined shortfall of all fills.

Deviation: a cycle that needs lent funds pays two transactions (withdraw +
multicall), not one as the `txOverhead + lendingLeg` shape assumes. True
single-tx withdraw+swap is impossible with public infrastructure alone:
`Pool.withdraw` burns aTokens from `msg.sender`, so a generic Multicall3 batch
cannot move Aave funds (the multicall contract holds no aTokens). Fixing that
would require deploying a personal executor contract and moving custody into
it — not worth it at current Base gas costs (see break-even table above).
