# Accounting model

Every number the backtester reports comes from one decomposition. It is
checked on every run — `assertAccountingReconciles` throws if it drifts by
more than 1e-6 relative — because an optimization built on unbalanced books
optimizes noise.

## The identity

At any point in time:

```
portfolioValue = usdcBalance + ethBalance × currentPrice
```

and that value decomposes into six mutually exclusive components:

```
portfolioValue = initialCapital
               + realizedGridPnL        (A)
               + realizedResetPnL       (B)
               + unrealizedPnL
               − swapFees               (C)
               − slippage               (C)
               − gas                    (C)
```

`initialCapital` is measured at the **first observation**, not at the
configured grid center: `initialUsdc + initialEth × firstPrice`.

## The three P&L sources

These are tracked separately at the point of the fill and are never merged.

### A. Grid trading P&L — `realizedGridGrossUsd`

Profit from completed buy → sell cycles. A grid SELL realizes

```
qty × sellLevelPrice − costBasisConsumed
```

Both sides are valued at **level prices**, so this figure is the spread the
grid captured and nothing else.

### B. Reset / inventory P&L — `realizedResetGrossUsd`

When a reset liquidates the accumulated ETH:

```
soldEth × liquidationPrice − costBasisConsumed
```

Same cost basis, same FIFO lots — only the trigger differs. This is the price
paid for the reset mechanism as a risk control, and it is what the reset
reports isolate.

### C. Trading costs

`feeUsd`, `slippageUsd` and `gasUsd` are accumulated per fill and subtracted
once. They are **never** folded into A or B.

## Why the cost basis excludes fees

An inventory lot stores `eth × levelPrice`, i.e. the notional at the grid
level, *not* the USDC actually spent. If the lot carried the raw USDC spent,
the buy-side fee would be counted twice — once inside the cost basis and once
in the fee accumulator — and grid P&L would silently absorb part of the
trading costs. Booking lots at level prices is what keeps A, B and C
independent.

`initialEth` is booked as a `seed` lot at the first observed price. It carries
a cost basis so unrealized P&L reconciles, but it is excluded from grid sell
sizing and from the completed-cycle counter: it is inventory the grid did not
buy.

## Reset records

One `ResetRecord` is created per liquidation, whether or not there was
inventory to sell. It is completed at rebuild time with the new grid bounds.
The "since previous reset" aggregates (fees, slippage, gas, grid gross/net)
are derived from the trade ledger by grouping on `intervalId` rather than
accumulated separately — the ledger is the single source of truth, so a
summary can never disagree with the rows behind it.

`resets` in `GridState` counts completed **rebuilds**; `resetRecords.length`
counts **liquidations**. They differ by one when the run ends in cooldown.

## Verifying it yourself

```bash
npm test                      # includes tests/accounting.test.ts
npm run backtest              # prints the reconciliation residual
```

`results/trades.csv` carries the balances and P&L split of every fill, so any
reported total can be re-derived from the ledger in a spreadsheet.
