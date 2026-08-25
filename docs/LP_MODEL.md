# LP fee income model

## What it models — and what it does not

The bot in this repository **swaps** through `SwapRouter02`. It is a taker: it
*pays* the pool fee on every fill, which the backtest already charges as
`SWAP_FEE_BPS`.

Enabling `LP_POOL_LIQUIDITY_USD` models something different: the same grid
expressed as **concentrated liquidity**, earning a share of the fees other
traders pay. That is a different bot from the one in `src/execution/`. The
numbers below describe that hypothetical, not the shipped executor.

## The formula

```
poolVolume = referenceVolumeUsd × LP_VENUE_VOLUME_SHARE_PCT/100
myShare    = myValueInRange / (myValueInRange + LP_POOL_LIQUIDITY_USD)
income     = poolVolume × LP_FEE_BPS/10000 × myShare
```

Income accrues per observation, only while the grid is `ACTIVE` **and** price
is inside its band — liquidity out of range earns nothing.

The `myShare` term is the part that makes this physical. An earlier draft used
`volume × captureRate`, which paid a $1k position exactly what it paid a $1M
one. Fee income must scale with capital deployed and dilute as the pool
deepens; three tests in `tests/accounting.test.ts` pin that behavior.

Fee income is a **fourth, separate** term in the reconciliation identity:

```
portfolio = initialCapital + gridPnL + resetPnL + unrealized
            + lpFeeIncome − fees − slippage − gas
```

It is never folded into grid P&L, so "did the grid trade well?" and "did the
liquidity earn well?" stay independently answerable.

## Preferred calibration: measured pool APR

Guessing a venue volume share and an in-range depth separately multiplies two
errors together. `apyBase` — fee income per unit of pool TVL — is published
per pool and directly measured, so it is the better input:

```bash
npm run fetch-apr -- --pool <defillama-uuid> --out data/pool-apr.csv
npm run backtest -- --csv data/eth-1h.csv --apr-file data/pool-apr.csv \
  --min-pool-tvl 5000000
```

The series carries daily TVL as well, which is used to dilute income for a
position that is large relative to the pool. `--min-pool-tvl` drops days when
the pool was too thin to deploy into at size.

### Three corrections this model needed

Each of these produced a spuriously high result before being fixed, and each
is pinned by tests:

1. **Fees must scale with capital.** The first version credited
   `volume × rate`, paying a $1k position what it paid a $1M one.
2. **Dilution must use the pool's actual TVL.** The Base WETH/USDC 0.05% pool
   launched at $11,598 of TVL; 187 of its 936 days sat below $1M. Applying
   pool-average APR to a $10k position on those days is not physical — the
   position would *be* the pool.
3. **Fees accrue only on deployed capital.** Crediting the whole portfolio
   paid LP yield on idle wallet cash, which made tiny order sizes look free:
   the optimizer collected the full pool rate while risking almost nothing.
   Only resting orders inside the band and held inventory earn.

Correction 3 reversed the optimizer's preferred order size from 1% (the
smallest tested) to 10% (the largest), which is the physically sensible
direction: capital that is not in the pool cannot earn pool fees.

## Calibrating it

Two inputs must come from the real pool you intend to use, not from the price
CSV:

| Input | Meaning | Where to get it |
| --- | --- | --- |
| `LP_VENUE_VOLUME_SHARE_PCT` | share of the reference feed's volume that routes through your pool | pool volume ÷ CEX volume |
| `LP_POOL_LIQUIDITY_USD` | competing liquidity sitting in your range | pool TVL (concentrated near spot) |

For the Base WETH/USDC 0.05% pool against a Binance ETHUSDT reference feed
(median $905M/day), roughly 0.5–2% venue share and $5–30M competing TVL are
plausible. **Verify these against live pool data before relying on them.**

## Sensitivity — read this before quoting any number

Real ETH, 2021-01 → 2026-08, $10k, best configuration
(spacing 3%, ±30%, reset buffer 2, 1% orders). ETH buy-and-hold over the same
period returned **+238.6%**.

| Competing TVL ↓ / venue share → | 0.25% | 0.5% | 1% | 2% |
| --- | --- | --- | --- | --- |
| $5M | +83.8% | +247.8% | +1,123.4% | +12,318.6% |
| $15M | +19.9% | +48.6% | **+127.9%** | +433.5% |
| $30M | +7.7% | +19.9% | +48.6% | +128.0% |
| $60M | +2.0% | +7.7% | +19.9% | +48.6% |

The answer spans four orders of magnitude across defensible inputs. Only the
$5M/2% corner beats ETH buy-and-hold, and that corner assumes a thin pool
capturing a large volume share — the least likely combination, since a pool
that profitable attracts liquidity until it is not.

**The strategy's profitability is dominated by pool economics, not by grid
parameters.** Any conclusion drawn from a single cell of this table is a
conclusion about the assumption, not about the strategy.

## Which grid parameters still matter

With fee income switched on, a 1,056-configuration sweep over real ETH
(2021-2026) — spacing × width × reset buffer × order size × volatility gate —
gives the following medians. Peak return is a poor guide here; the median
across the axis is what indicates whether a setting is robust.

**Volatility gate** (`GRID_MAX_VOL_PER_STEP`), 176 configs per row:

| Gate | Median return | Best | Median trades | Median LP fees |
| --- | --- | --- | --- | --- |
| 0.002 | +17.2% | +37.2% | 19 | $1,774 |
| 0.005 | +60.7% | +103.7% | 206 | $6,342 |
| **0.01** | **+65.8%** | +124.0% | 657 | $8,697 |
| 0.02 | +51.8% | +128.0% | 968 | $8,360 |
| 0.05 | +47.9% | **+129.1%** | 1,019 | $8,447 |
| off | +47.9% | +129.1% | 1,017 | $8,312 |

A very tight gate is clearly harmful — it holds the grid out of the market
(19 trades in 5.6 years) and forfeits the fee income that supplies the return.
Past 0.01 the peak keeps creeping up while the median falls: looser gates buy
a slightly better best case at the cost of consistency. The spread between the
best gate and the worst sensible one is ~18 points of median.

**Order size** is the one clean monotonic axis — smaller is better, because
inventory is what resets destroy:

| Order (% of capital) | Median return | Max ETH exposure |
| --- | --- | --- |
| 1% | +77.8% | 4.8% |
| 2% | +59.1% | 9.6% |
| 5% | +33.9% | 23.7% |
| 10% | +12.7% | 43.3% |

**Level count** is strongly non-monotonic (13 levels: +95.1% median; 10
levels: +16.4%) because it is not an independent axis — it is derived from
width ÷ spacing, and the good cells are wide grids (±20-30%) at 3% spacing.
Read the width and spacing columns, not the level count alone.

## The benchmark that matters: passive LP

Once fee income is the dominant revenue source, "does it beat ETH?" is the
wrong question — the strategy is competing with simply providing liquidity.
`passiveLpWithFeesBenchmark` models that: one deposit into a fixed band,
collecting the same measured pool APR while in range, never trading.

At matched band width the grid loses to it in every configuration tested, by
34 to 65 percentage points. The cause is structural rather than a tuning
problem:

* a passive position keeps 100% of its capital in range earning fees;
* the grid deploys only 38–48% on average, the rest sitting idle;
* resets take the grid out of the market entirely during cooldown, and fee
  income is rent for presence.

The trading overlay contributes a few hundred dollars of grid P&L against a
multi-thousand-dollar shortfall in fee capture. Any future work on this
strategy should be measured against this benchmark first.

## Interaction with the regime filter

Fee income is rent paid for *presence*. Standing aside during large moves
removes that presence, so the causal regime filter reduces returns
monotonically:

| `REGIME_MAX_MOVE_PCT` | Return | Max DD | LP fee income |
| --- | --- | --- | --- |
| off | +127.9% | −1.10% | $13,125 |
| 50% | +124.6% | −1.12% | $12,790 |
| 30% | +105.6% | −0.98% | $11,071 |
| 20% | +73.6% | −0.95% | $8,169 |
| 10% | +34.3% | −0.35% | $3,869 |

Drawdown improves, but from an already negligible base. Under this model,
staying in the market is what pays.
