# Post-reset cooldown: skipping it when the book is flat

## What the reset actually costs

Diagnostic on the best configuration (real ETH + measured Base WETH/USDC
0.05% APR, 873 days, 12 resets):

| | |
| --- | --- |
| Realized liquidation loss | −$418 |
| Time out of market during cooldown | 60.5 days (**6.9%** of the period) |
| Resets that held *any* inventory | **3 of 12** |

Nine of twelve resets fired with a flat book. They sold nothing, realized
nothing and de-risked nothing — pure re-centrings — yet each then sat out a
cooldown averaging over four days. Under the LP fee model that time earns
nothing, because fee income is rent for presence.

`RESET_SKIP_COOLDOWN_WHEN_FLAT=true` rebuilds immediately in exactly that
case. A reset that *did* liquidate inventory still waits: that one fired in a
move which put capital at risk, which is the situation the cooldown was
designed for.

## Measured effect

Out-of-market time falls as intended — cooldown after flat resets goes from
1,164h to 8h, and total time out of market from **6.9% to 2.1%** of the
period.

The return effect is real but far smaller than that suggests:

| Configuration (spacing/width/reset/order) | Return off | Return on | Risk-adj off | Risk-adj on |
| --- | --- | --- | --- | --- |
| 3% / ±30% / 1 / 10% | +100.1% | +98.8% | 69.5 | **97.8** |
| 3% / ±30% / 3 / 10% | +89.0% | **+94.0%** | 34.5 | 28.9 |
| 2% / ±20% / 2 / 10% | +113.8% | **+134.8%** | 41.8 | 47.6 |
| 2% / ±20% / 1 / 5% | +38.9% | +38.6% | 9.5 | **13.5** |
| 1% / ±10% / 2 / 5% | +54.6% | **+58.4%** | 10.1 | 10.6 |
| 3% / ±20% / 5 / 2% | +7.6% | +7.7% | 3.5 | 3.6 |

Return improved in **4 of 6** configurations (median **+1.9** points, best
+21.0, worst −1.3). Risk-adjusted return improved in **5 of 6** (median
**+2.3**).

## Why the gain is smaller than the forgone-fee estimate

A naive reading of the diagnostic values 60 days out of market at roughly
$1,161 of fee income. The realised gain is nowhere near that, for two reasons:

1. **The grid is usually out of range during a cooldown anyway.** The reset
   fires *because* price left the band, so much of that time would have earned
   nothing even with a live grid.
2. **Re-entering earlier re-exposes the grid to inventory.** In the headline
   configuration the number of resets carrying inventory rose from 3 to 4 and
   realized reset losses grew from −$418 to −$532. Some of the recovered fee
   income is handed straight back.

The drawdown improvement is the more consistent effect, which is why the
risk-adjusted picture is stronger than the raw-return one.

## Safety and its limit

Skipping the cooldown removes a brake on re-entering a falling market. The
volatility gate on BUY fills still blocks accumulation into **choppy**
markets — but that gate measures the std-dev of log returns, so a *smooth*
one-way decline registers as near-zero volatility and passes straight through
it. Both behaviours are pinned by tests in `tests/resetCooldown.test.ts`.

For a steady trend the relevant control is the inventory ceiling
(`MAX_ETH_USD`), not the volatility gate. Enable this setting alongside an
inventory cap, not instead of one.

## Scope

Measured under the LP fee model, where cooldown forfeits income. In the plain
taker bot there is no fee income to lose, so the cooldown is nearly free and
this setting has little to recommend it.
